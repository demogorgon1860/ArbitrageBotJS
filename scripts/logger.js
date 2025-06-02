const fs = require('fs-extra');
const path = require('path');

class Logger {
    constructor() {
        this.logsDir = path.join(__dirname, '../logs');
        this.logFile = path.join(this.logsDir, 'bot.log');
        this.errorFile = path.join(this.logsDir, 'error.log');
        this.maxLogSize = 10 * 1024 * 1024; // 10MB
        this.maxLogFiles = 5;
        
        this.init();
    }
    
    async init() {
        try {
            // ИСПРАВЛЕНО: используем fs.ensureDir вместо ensureDirectory
            await fs.ensureDir(this.logsDir);
            console.log('✅ Logs directory created/verified');
        } catch (error) {
            console.error('Failed to create logs directory:', error);
            // Продолжаем работу без файлового логирования
        }
    }
    
    /**
     * Логирование информации
     */
    logInfo(message, data = null) {
        const logEntry = this.formatLogEntry('INFO', message, data);
        console.log(logEntry.console);
        this.writeToFile(this.logFile, logEntry.file);
    }
    
    /**
     * Логирование успеха
     */
    logSuccess(message, data = null) {
        const logEntry = this.formatLogEntry('SUCCESS', message, data);
        console.log(`\x1b[32m${logEntry.console}\x1b[0m`); // Зеленый цвет
        this.writeToFile(this.logFile, logEntry.file);
    }
    
    /**
     * Логирование предупреждений
     */
    logWarning(message, data = null) {
        const logEntry = this.formatLogEntry('WARNING', message, data);
        console.warn(`\x1b[33m${logEntry.console}\x1b[0m`); // Желтый цвет
        this.writeToFile(this.logFile, logEntry.file);
    }
    
    /**
     * Логирование ошибок
     */
    logError(message, error = null) {
        const logEntry = this.formatLogEntry('ERROR', message, error);
        console.error(`\x1b[31m${logEntry.console}\x1b[0m`); // Красный цвет
        this.writeToFile(this.errorFile, logEntry.file);
        this.writeToFile(this.logFile, logEntry.file);
    }
    
    /**
     * Логирование отладки (только в файл)
     */
    logDebug(message, data = null) {
        const logEntry = this.formatLogEntry('DEBUG', message, data);
        
        // В консоль только если DEBUG режим
        if (process.env.DEBUG_MODE === 'true') {
            console.log(`\x1b[36m${logEntry.console}\x1b[0m`); // Синий цвет
        }
        
        this.writeToFile(this.logFile, logEntry.file);
    }
    
    /**
     * Форматирование записи лога
     */
    formatLogEntry(level, message, data) {
        const timestamp = new Date().toISOString();
        const pid = process.pid;
        
        let consoleMessage = `[${timestamp}] [${level}] ${message}`;
        let fileMessage = `[${timestamp}] [${level}] [PID:${pid}] ${message}`;
        
        if (data) {
            const dataStr = this.formatData(data);
            consoleMessage += ` ${dataStr}`;
            fileMessage += ` ${dataStr}`;
        }
        
        return {
            console: consoleMessage,
            file: fileMessage
        };
    }
    
    /**
     * Форматирование дополнительных данных
     */
    formatData(data) {
        if (data instanceof Error) {
            return `\n  Error: ${data.message}\n  Stack: ${data.stack}`;
        } else if (typeof data === 'object') {
            try {
                return `\n  Data: ${JSON.stringify(data, null, 2)}`;
            } catch (error) {
                return `\n  Data: [Object could not be serialized]`;
            }
        } else {
            return `\n  Data: ${data}`;
        }
    }
    
    /**
     * Запись в файл
     */
    async writeToFile(filePath, message) {
        try {
            // Проверяем размер файла перед записью
            await this.rotateLogIfNeeded(filePath);
            
            // Добавляем запись в файл
            await fs.appendFile(filePath, message + '\n');
            
        } catch (error) {
            // Не логируем эту ошибку в файл, чтобы избежать рекурсии
            console.error('Failed to write to log file:', error.message);
        }
    }
    
    /**
     * Ротация логов при превышении размера
     */
    async rotateLogIfNeeded(filePath) {
        try {
            const stats = await fs.stat(filePath);
            
            if (stats.size > this.maxLogSize) {
                const dir = path.dirname(filePath);
                const fileName = path.basename(filePath, '.log');
                const ext = '.log';
                
                // Сдвигаем старые файлы
                for (let i = this.maxLogFiles - 1; i >= 1; i--) {
                    const oldFile = path.join(dir, `${fileName}.${i}${ext}`);
                    const newFile = path.join(dir, `${fileName}.${i + 1}${ext}`);
                    
                    if (await fs.pathExists(oldFile)) {
                        if (i === this.maxLogFiles - 1) {
                            await fs.remove(newFile); // Удаляем самый старый
                        }
                        await fs.move(oldFile, newFile);
                    }
                }
                
                // Переименовываем текущий файл
                const backupFile = path.join(dir, `${fileName}.1${ext}`);
                await fs.move(filePath, backupFile);
            }
            
        } catch (error) {
            // Игнорируем ошибки ротации
        }
    }
    
    /**
     * Очистка старых логов
     */
    async cleanOldLogs(daysToKeep = 7) {
        try {
            const files = await fs.readdir(this.logsDir);
            const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
            
            for (const file of files) {
                const filePath = path.join(this.logsDir, file);
                const stats = await fs.stat(filePath);
                
                if (stats.mtime.getTime() < cutoffTime) {
                    await fs.remove(filePath);
                    this.logInfo(`Cleaned old log file: ${file}`);
                }
            }
            
        } catch (error) {
            this.logError('Failed to clean old logs', error);
        }
    }
    
    /**
     * Получение статистики логов
     */
    async getLogStats() {
        try {
            const files = await fs.readdir(this.logsDir);
            const stats = {
                totalFiles: files.length,
                totalSize: 0,
                files: []
            };
            
            for (const file of files) {
                const filePath = path.join(this.logsDir, file);
                const fileStats = await fs.stat(filePath);
                
                stats.totalSize += fileStats.size;
                stats.files.push({
                    name: file,
                    size: fileStats.size,
                    modified: fileStats.mtime
                });
            }
            
            return stats;
            
        } catch (error) {
            this.logError('Failed to get log stats', error);
            return null;
        }
    }
    
    /**
     * Логирование запуска бота
     */
    logStartup(botInfo) {
        this.logInfo('🚀 Bot starting up', botInfo);
        this.logInfo(`Node.js version: ${process.version}`);
        this.logInfo(`Platform: ${process.platform}`);
        this.logInfo(`Working directory: ${process.cwd()}`);
    }
    
    /**
     * Логирование остановки бота
     */
    logShutdown(stats) {
        this.logInfo('🛑 Bot shutting down', stats);
    }
    
    /**
     * Логирование найденного арбитража
     */
    logArbitrage(opportunity) {
        const message = `💰 ARBITRAGE FOUND: ${opportunity.token} | ${opportunity.basisPoints} bps | $${opportunity.adjustedProfit?.toFixed(2) || 'N/A'} profit`;
        this.logSuccess(message, {
            token: opportunity.token,
            buyDex: opportunity.buyDex,
            sellDex: opportunity.sellDex,
            basisPoints: opportunity.basisPoints,
            grossProfit: opportunity.potentialProfit,
            netProfit: opportunity.adjustedProfit,
            confidence: opportunity.confidence
        });
    }
    
    /**
     * Логирование производительности
     */
    logPerformance(operation, duration, details = null) {
        const message = `⏱️ ${operation} completed in ${duration}ms`;
        
        if (duration > 5000) {
            this.logWarning(message, details);
        } else {
            this.logDebug(message, details);
        }
    }
    
    /**
     * Логирование сетевых проблем
     */
    logNetworkIssue(provider, error) {
        this.logWarning(`🌐 Network issue with ${provider}`, {
            error: error.message,
            code: error.code
        });
    }
}

// Создаем единственный экземпляр логгера
const logger = new Logger();

// Запускаем очистку старых логов при запуске
logger.cleanOldLogs().catch(error => {
    console.error('Failed to clean old logs on startup:', error);
});

module.exports = logger;