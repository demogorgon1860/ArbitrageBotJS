#!/usr/bin/env node

/**
 * Optimized Polygon Arbitrage Bot
 * 
 * Features:
 * - Real-time DEX price monitoring
 * - Advanced profit calculations with realistic costs
 * - MEV protection analysis
 * - Liquidity validation
 * - Multiple RPC provider support with failover
 * - Intelligent notification system
 * - Comprehensive error handling
 * 
 * Usage: npm start
 */

const path = require('path');
const fs = require('fs-extra');
require('dotenv').config();

// Проверка Node.js версии
const nodeVersion = process.version;
const requiredVersion = '16.0.0';
if (parseInt(nodeVersion.slice(1)) < parseInt(requiredVersion)) {
    console.error(`❌ Node.js version ${requiredVersion} or higher required. Current: ${nodeVersion}`);
    process.exit(1);
}

// Импорты
const ArbitrageBot = require('./scripts/arbitrageBot');
const logger = require('./scripts/logger');
const telegramNotifier = require('./scripts/telegram');
const { loadStats, saveStats } = require('./scripts/utils');

class BotManager {
    constructor() {
        this.bot = null;
        this.isShuttingDown = false;
        this.startTime = Date.now();
        this.restartCount = 0;
        this.maxRestarts = 5;
        this.restartCooldown = 30000; // 30 секунд
        this.lastRestart = 0;
        
        this.setupErrorHandlers();
        this.setupGracefulShutdown();
    }
    
    /**
     * Запуск бота с проверками
     */
    async start() {
        try {
            logger.logInfo('🚀 Starting Optimized Polygon Arbitrage Bot Manager...');
            
            // Предварительные проверки
            await this.performPreStartChecks();
            
            // Загрузка статистики
            const stats = await loadStats();
            stats.totalRuns = (stats.totalRuns || 0) + 1;
            stats.lastRun = new Date().toISOString();
            await saveStats(stats);
            
            // Создание и запуск бота
            this.bot = new ArbitrageBot();
            await this.bot.start();
            
            // Периодические отчеты
            this.startPeriodicReporting();
            
            logger.logSuccess('✅ Bot started successfully');
            
        } catch (error) {
            logger.logError('❌ Failed to start bot', error);
            await this.handleStartupError(error);
        }
    }
    
    /**
     * Предварительные проверки перед запуском
     */
    async performPreStartChecks() {
        logger.logInfo('🔍 Performing pre-start checks...');
        
        // 1. Проверка директорий
        await this.ensureDirectories();
        
        // 2. Проверка конфигурации
        await this.validateConfiguration();
        
        // 3. Проверка переменных окружения
        this.validateEnvironmentVariables();
        
        // 4. Проверка зависимостей
        this.validateDependencies();
        
        // 5. Тест Telegram
        await this.testTelegramConnection();
        
        logger.logSuccess('✅ All pre-start checks passed');
    }
    
    /**
     * Обеспечение наличия необходимых директорий
     */
    async ensureDirectories() {
        const directories = [
            './data',
            './logs',
            './cache'
        ];
        
        for (const dir of directories) {
            await fs.ensureDir(dir);
        }
        
        logger.logInfo('📁 Directories created/verified');
    }
    
    /**
     * Валидация конфигурации
     */
    async validateConfiguration() {
        const configPath = path.join(__dirname, 'config/polygon.json');
        
        if (!await fs.pathExists(configPath)) {
            throw new Error('Configuration file not found: config/polygon.json');
        }
        
        const config = await fs.readJson(configPath);
        
        // Проверка основных секций
        const requiredSections = ['tokens', 'dexes', 'tradingPaths', 'settings'];
        for (const section of requiredSections) {
            if (!config[section]) {
                throw new Error(`Missing configuration section: ${section}`);
            }
        }
        
        // Проверка токенов
        const requiredTokens = ['WMATIC', 'USDC', 'WETH'];
        for (const token of requiredTokens) {
            if (!config.tokens[token]) {
                throw new Error(`Missing required token: ${token}`);
            }
        }
        
        // Проверка DEX
        const requiredDEXes = ['sushiswap', 'quickswap'];
        for (const dex of requiredDEXes) {
            if (!config.dexes[dex]) {
                throw new Error(`Missing required DEX: ${dex}`);
            }
        }
        
        logger.logInfo('⚙️ Configuration validated');
    }
    
    /**
     * Валидация переменных окружения
     */
    validateEnvironmentVariables() {
        const warnings = [];
        const errors = [];
        
        // Обязательные переменные - хотя бы один RPC
        const hasRPC = this.hasAnyRPCProvider();
        if (!hasRPC) {
            errors.push('No RPC providers configured. Please set POLYGON_RPC_1, ALCHEMY_API_KEY, or INFURA_API_KEY');
        }
        
        // Опциональные, но рекомендуемые
        if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN === 'undefined') {
            warnings.push('TELEGRAM_BOT_TOKEN not set - notifications disabled');
        }
        
        if (!process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID === 'undefined') {
            warnings.push('TELEGRAM_CHAT_ID not set - notifications disabled');
        }
        
        // Выводим предупреждения
        for (const warning of warnings) {
            logger.logWarning(`⚠️ ${warning}`);
        }
        
        // Останавливаемся при ошибках
        if (errors.length > 0) {
            for (const error of errors) {
                logger.logError(`❌ ${error}`);
            }
            throw new Error('Environment validation failed');
        }
        
        logger.logInfo('🌍 Environment variables validated');
    }
    
    /**
     * Проверка наличия RPC провайдеров
     */
    hasAnyRPCProvider() {
        // Проверяем прямые RPC endpoints
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                return true;
            }
        }
        
        // Проверяем API ключи
        if ((process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') ||
            (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined')) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Валидация зависимостей
     */
    validateDependencies() {
        const requiredModules = [
            'ethers',
            'node-telegram-bot-api',
            'fs-extra',
            'dotenv'
        ];
        
        for (const module of requiredModules) {
            try {
                require(module);
            } catch (error) {
                throw new Error(`Missing required module: ${module}. Run: npm install`);
            }
        }
        
        logger.logInfo('📦 Dependencies validated');
    }
    
    /**
     * Тест подключения Telegram
     */
    async testTelegramConnection() {
        if (telegramNotifier.getStatus().configured) {
            try {
                // Отправляем тестовое сообщение при первом запуске
                if (this.restartCount === 0) {
                    await telegramNotifier.sendTestMessage();
                    logger.logInfo('📱 Telegram connection tested');
                }
            } catch (error) {
                logger.logWarning('⚠️ Telegram test failed, but bot will continue', error.message);
            }
        } else {
            logger.logInfo('📱 Telegram not configured - skipping test');
        }
    }
    
    /**
     * Запуск периодической отчетности
     */
    startPeriodicReporting() {
        // Отчет каждые 30 минут
        setInterval(async () => {
            if (this.bot && !this.isShuttingDown) {
                try {
                    const stats = this.bot.getStats();
                    await telegramNotifier.sendPeriodicReport(stats);
                    logger.logInfo('📊 Periodic report sent');
                } catch (error) {
                    logger.logError('Failed to send periodic report', error);
                }
            }
        }, 30 * 60 * 1000); // 30 минут
        
        // Краткая статистика каждые 5 минут в консоль
        setInterval(() => {
            if (this.bot && !this.isShuttingDown) {
                this.bot.printStats();
            }
        }, 5 * 60 * 1000); // 5 минут
    }
    
    /**
     * Обработка ошибки запуска
     */
    async handleStartupError(error) {
        const now = Date.now();
        
        // Проверяем cooldown перед рестартом
        if (now - this.lastRestart < this.restartCooldown) {
            logger.logError('❌ Restart cooldown active, exiting');
            process.exit(1);
        }
        
        // Проверяем лимит рестартов
        if (this.restartCount >= this.maxRestarts) {
            logger.logError(`❌ Maximum restart attempts (${this.maxRestarts}) exceeded`);
            await telegramNotifier.sendErrorAlert(error, 'Startup failure - max restarts exceeded');
            process.exit(1);
        }
        
        this.restartCount++;
        this.lastRestart = now;
        
        logger.logWarning(`⚠️ Startup failed (attempt ${this.restartCount}/${this.maxRestarts}), restarting in ${this.restartCooldown/1000}s...`);
        
        // Отправляем уведомление об ошибке
        try {
            await telegramNotifier.sendErrorAlert(error, `Startup failure - restart attempt ${this.restartCount}`);
        } catch (telegramError) {
            logger.logError('Failed to send error notification', telegramError);
        }
        
        // Ждем и перезапускаем
        setTimeout(() => {
            this.start();
        }, this.restartCooldown);
    }
    
    /**
     * Настройка обработчиков ошибок
     */
    setupErrorHandlers() {
        // Unhandled Promise Rejections
        process.on('unhandledRejection', async (reason, promise) => {
            logger.logError('🚨 Unhandled Promise Rejection', reason);
            
            try {
                await telegramNotifier.sendErrorAlert(
                    new Error(reason), 
                    'Unhandled Promise Rejection'
                );
            } catch (error) {
                logger.logError('Failed to send unhandled rejection notification', error);
            }
            
            // Не выходим сразу, даем боту возможность продолжить
        });
        
        // Uncaught Exceptions
        process.on('uncaughtException', async (error) => {
            logger.logError('🚨 Uncaught Exception', error);
            
            try {
                await telegramNotifier.sendErrorAlert(error, 'Uncaught Exception - CRITICAL');
                
                // Даем время на отправку уведомления
                setTimeout(() => {
                    process.exit(1);
                }, 2000);
            } catch (telegramError) {
                logger.logError('Failed to send critical error notification', telegramError);
                process.exit(1);
            }
        });
        
        // Warning events
        process.on('warning', (warning) => {
            logger.logWarning('⚠️ Process Warning', warning.message);
        });
    }
    
    /**
     * Настройка graceful shutdown
     */
    setupGracefulShutdown() {
        const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
        
        signals.forEach(signal => {
            process.on(signal, async () => {
                if (this.isShuttingDown) {
                    logger.logWarning('⚠️ Force shutdown - terminating immediately');
                    process.exit(1);
                }
                
                logger.logInfo(`📤 Received ${signal}, starting graceful shutdown...`);
                await this.shutdown();
            });
        });
    }
    
    /**
     * Graceful shutdown
     */
    async shutdown() {
        this.isShuttingDown = true;
        
        try {
            // Остановка бота
            if (this.bot) {
                await this.bot.stop();
            }
            
            // Сохранение финальной статистики
            const finalStats = this.bot ? this.bot.getStats() : {};
            await saveStats(finalStats);
            
            // Финальное уведомление
            await telegramNotifier.sendShutdownNotification(finalStats);
            
            logger.logSuccess('✅ Graceful shutdown completed');
            process.exit(0);
            
        } catch (error) {
            logger.logError('❌ Error during shutdown', error);
            process.exit(1);
        }
    }
    
    /**
     * Получение статистики менеджера
     */
    getManagerStats() {
        const uptime = Date.now() - this.startTime;
        
        return {
            managerUptime: Math.floor(uptime / 1000),
            restartCount: this.restartCount,
            lastRestart: this.lastRestart,
            isShuttingDown: this.isShuttingDown,
            botRunning: this.bot ? !this.bot.isRunning : false
        };
    }
}

// Главная функция
async function main() {
    console.log('🤖 Optimized Polygon Arbitrage Bot v2.0');
    console.log('═'.repeat(50));
    
    const manager = new BotManager();
    await manager.start();
}

// Запуск только если файл вызывается напрямую
if (require.main === module) {
    main().catch(error => {
        console.error('💥 Fatal startup error:', error);
        process.exit(1);
    });
}

module.exports = BotManager;