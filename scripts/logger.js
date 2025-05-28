const fs = require('fs-extra');
const path = require('path');
const { getCurrentTimestamp, ensureDirectory } = require('./utils');

class Logger {
    constructor() {
        this.logsDir = path.join(__dirname, '..', 'logs');
        this.arbitrageLogFile = path.join(this.logsDir, 'arbitrage_log.txt');
        this.errorLogFile = path.join(this.logsDir, 'error_log.txt');
        this.debugLogFile = path.join(this.logsDir, 'debug_log.txt');
        
        this.init();
    }
    
    async init() {
        try {
            await ensureDirectory(this.logsDir);
        } catch (error) {
            console.error('Failed to create logs directory:', error);
        }
    }
    
    /**
     * Format log message with timestamp
     */
    formatMessage(level, message, data = null) {
        const timestamp = getCurrentTimestamp();
        let logMessage = `[${timestamp}] [${level}] ${message}`;
        
        if (data) {
            if (typeof data === 'object') {
                logMessage += '\n' + JSON.stringify(data, null, 2);
            } else {
                logMessage += ` | ${data}`;
            }
        }
        
        return logMessage + '\n';
    }
    
    /**
     * Write to log file
     */
    async writeToFile(filePath, message) {
        try {
            await fs.appendFile(filePath, message);
        } catch (error) {
            console.error(`Failed to write to log file ${filePath}:`, error);
        }
    }
    
    /**
     * Log info message
     */
    logInfo(message, data = null) {
        const formattedMessage = this.formatMessage('INFO', message, data);
        console.log(`ℹ️  ${message}`, data ? data : '');
        this.writeToFile(this.debugLogFile, formattedMessage);
    }
    
    /**
     * Log success message
     */
    logSuccess(message, data = null) {
        const formattedMessage = this.formatMessage('SUCCESS', message, data);
        console.log(`✅ ${message}`, data ? data : '');
        this.writeToFile(this.debugLogFile, formattedMessage);
    }
    
    /**
     * Log warning message
     */
    logWarning(message, data = null) {
        const formattedMessage = this.formatMessage('WARNING', message, data);
        console.warn(`⚠️  ${message}`, data ? data : '');
        this.writeToFile(this.errorLogFile, formattedMessage);
    }
    
    /**
     * Log error message
     */
    logError(message, error = null) {
        const errorData = error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
        } : null;
        
        const formattedMessage = this.formatMessage('ERROR', message, errorData);
        console.error(`❌ ${message}`, error ? error : '');
        this.writeToFile(this.errorLogFile, formattedMessage);
    }
    
    /**
     * Log debug message (only in development)
     */
    logDebug(message, data = null) {
        if (process.env.NODE_ENV === 'development') {
            const formattedMessage = this.formatMessage('DEBUG', message, data);
            console.debug(`🔍 ${message}`, data ? data : '');
            this.writeToFile(this.debugLogFile, formattedMessage);
        }
    }
    
    /**
     * Log arbitrage opportunity (special formatting)
     */
    async logArbitrage(opportunity) {
        const {
            token,
            buyDex,
            sellDex,
            buyPrice,
            sellPrice,
            basisPoints,
            percentage,
            inputAmount,
            potentialProfit,
            adjustedProfit,
            confidence,
            executionWindow,
            buyPath,
            sellPath,
            timestamp
        } = opportunity;
        
        const arbitrageMessage = `
========================================
🚀 ARBITRAGE OPPORTUNITY FOUND
========================================
Token: ${token}
Buy DEX: ${buyDex} | Price: $${buyPrice?.toFixed(6)}
Sell DEX: ${sellDex} | Price: $${sellPrice?.toFixed(6)}
Spread: ${basisPoints} bps (${percentage?.toFixed(2)}%)
Input Amount: $${inputAmount}
Theoretical Profit: $${potentialProfit?.toFixed(2)}
Adjusted Profit: $${adjustedProfit?.toFixed(2)}
Confidence: ${confidence ? (confidence * 100).toFixed(1) : 'N/A'}%
Execution Window: ${executionWindow ? (executionWindow / 1000).toFixed(1) : 'N/A'}s
Buy Path: ${buyPath ? buyPath.join(' → ') : 'Direct'}
Sell Path: ${sellPath ? sellPath.join(' → ') : 'Direct'}
Timestamp: ${timestamp}
========================================
`;
        
        console.log('🎯 ' + arbitrageMessage);
        await this.writeToFile(this.arbitrageLogFile, arbitrageMessage);
    }
    
    /**
     * Log bot statistics
     */
    async logStats(stats) {
        const statsMessage = `
========================================
📊 BOT STATISTICS
========================================
Total Checks: ${stats.totalChecks}
Opportunities Found: ${stats.opportunitiesFound}
Viable Opportunities: ${stats.viableOpportunities || 0}
Errors: ${stats.errors}
Uptime: ${stats.uptime}
Success Rate: ${stats.successRate || 'N/A'}
RPC Failovers: ${stats.rpcFailovers || 0}
Last Check: ${stats.lastCheck}
Current Provider: ${stats.currentProvider || 'N/A'}
Timestamp: ${getCurrentTimestamp()}
========================================
`;
        
        console.log('📊 Bot Statistics:', stats);
        await this.writeToFile(this.debugLogFile, statsMessage);
    }
    
    /**
     * Log system information
     */
    async logSystemInfo() {
        const memoryUsage = process.memoryUsage();
        const systemInfo = {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            memory: {
                rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
                external: Math.round(memoryUsage.external / 1024 / 1024) + ' MB'
            },
            uptime: Math.round(process.uptime()) + ' seconds'
        };
        
        const systemMessage = `
========================================
🖥️  SYSTEM INFORMATION
========================================
Node Version: ${systemInfo.nodeVersion}
Platform: ${systemInfo.platform}
Architecture: ${systemInfo.arch}
Memory Usage:
  RSS: ${systemInfo.memory.rss}
  Heap Total: ${systemInfo.memory.heapTotal}
  Heap Used: ${systemInfo.memory.heapUsed}
  External: ${systemInfo.memory.external}
Process Uptime: ${systemInfo.uptime}
Timestamp: ${getCurrentTimestamp()}
========================================
`;
        
        console.log('🖥️  System Info:', systemInfo);
        await this.writeToFile(this.debugLogFile, systemMessage);
    }
    
    /**
     * Log network information
     */
    async logNetworkInfo(networkInfo) {
        const networkMessage = `
========================================
🌐 NETWORK INFORMATION
========================================
Chain ID: ${networkInfo.chainId}
Network: ${networkInfo.name}
Block Number: ${networkInfo.blockNumber}
Gas Price: ${networkInfo.gasPrice} Gwei
RPC Provider: ${networkInfo.rpcProvider}
Connected: ${networkInfo.connected ? 'Yes' : 'No'}
Timestamp: ${getCurrentTimestamp()}
========================================
`;
        
        console.log('🌐 Network Info:', networkInfo);
        await this.writeToFile(this.debugLogFile, networkMessage);
    }
    
    /**
     * Clear old log files (keep last 7 days)
     */
    async clearOldLogs() {
        try {
            const files = await fs.readdir(this.logsDir);
            const now = Date.now();
            const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
            
            for (const file of files) {
                const filePath = path.join(this.logsDir, file);
                const stats = await fs.stat(filePath);
                
                if (stats.mtime.getTime() < sevenDaysAgo) {
                    await fs.remove(filePath);
                    console.log(`🗑️  Removed old log file: ${file}`);
                }
            }
        } catch (error) {
            this.logError('Failed to clear old logs', error);
        }
    }
    
    /**
     * Get log file sizes
     */
    async getLogFileSizes() {
        try {
            const sizes = {};
            const logFiles = [
                { name: 'arbitrage', path: this.arbitrageLogFile },
                { name: 'error', path: this.errorLogFile },
                { name: 'debug', path: this.debugLogFile }
            ];
            
            for (const logFile of logFiles) {
                try {
                    const stats = await fs.stat(logFile.path);
                    sizes[logFile.name] = this.formatBytes(stats.size);
                } catch (error) {
                    sizes[logFile.name] = '0 B';
                }
            }
            
            return sizes;
        } catch (error) {
            this.logError('Failed to get log file sizes', error);
            return {};
        }
    }
    
    /**
     * Format bytes to human readable format
     */
    formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
    
    /**
     * Rotate log files if they get too large
     */
    async rotateLogs() {
        const maxSize = 10 * 1024 * 1024; // 10MB
        const logFiles = [this.arbitrageLogFile, this.errorLogFile, this.debugLogFile];
        
        for (const logFile of logFiles) {
            try {
                const stats = await fs.stat(logFile);
                
                if (stats.size > maxSize) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const backupFile = logFile.replace('.txt', `_${timestamp}.txt`);
                    
                    await fs.move(logFile, backupFile);
                    await fs.writeFile(logFile, ''); // Create new empty file
                    
                    this.logInfo(`Rotated log file: ${path.basename(logFile)} -> ${path.basename(backupFile)}`);
                }
            } catch (error) {
                // File might not exist yet, that's ok
            }
        }
    }
}

// Create singleton instance
const logger = new Logger();

module.exports = logger;