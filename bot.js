#!/usr/bin/env node

/**
 * Production-Ready Polygon Arbitrage Bot v3.0
 * Complete rewrite with all critical fixes
 */

require('dotenv').config();
const ArbitrageBot = require('./scripts/arbitrageBot');
const logger = require('./scripts/logger');
const telegramNotifier = require('./scripts/telegram');
const ConfigValidator = require('./scripts/configValidator');

class BotManager {
    constructor() {
        this.engine = null;
        this.isShuttingDown = false;
        this.startTime = Date.now();
        this.restartAttempts = 0;
        this.maxRestarts = 5;
        
        this.setupProcessHandlers();
    }
    
    async start() {
        try {
            logger.logInfo('🚀 Starting Polygon Arbitrage Bot v3.0...');
            
            // Validate environment and configuration
            const validation = await ConfigValidator.validateAll();
            if (!validation.valid) {
                throw new Error(`Configuration invalid: ${validation.errors.join(', ')}`);
            }
            
            // Initialize engine
            this.engine = new ArbitrageEngine();
            await this.engine.initialize();
            
            // Send startup notification
            await telegramNotifier.sendStartupNotification({
                version: '3.0',
                features: [
                    'Real-time gas calculation',
                    'Dynamic slippage analysis',
                    'V3 liquidity optimization',
                    'Net profit filtering',
                    'Production-grade stability'
                ]
            });
            
            // Start monitoring
            await this.engine.start();
            
            logger.logSuccess('✅ Bot started successfully');
            
        } catch (error) {
            logger.logError('Failed to start bot', error);
            await this.handleStartupError(error);
        }
    }
    
    async handleStartupError(error) {
        this.restartAttempts++;
        
        if (this.restartAttempts > this.maxRestarts) {
            logger.logError('Max restart attempts exceeded, exiting');
            await telegramNotifier.sendErrorAlert(error, 'Bot failed to start - max retries exceeded');
            process.exit(1);
        }
        
        logger.logWarning(`Restart attempt ${this.restartAttempts}/${this.maxRestarts} in 30s...`);
        
        setTimeout(() => {
            this.start();
        }, 30000);
    }
    
    setupProcessHandlers() {
        // Graceful shutdown
        const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
        signals.forEach(signal => {
            process.on(signal, async () => {
                if (this.isShuttingDown) {
                    process.exit(1);
                }
                
                this.isShuttingDown = true;
                logger.logInfo(`Received ${signal}, shutting down gracefully...`);
                
                try {
                    if (this.engine) {
                        await this.engine.stop();
                    }
                    
                    const stats = this.engine ? this.engine.getStats() : {};
                    await telegramNotifier.sendShutdownNotification(stats);
                    
                    logger.logSuccess('Graceful shutdown completed');
                    process.exit(0);
                    
                } catch (error) {
                    logger.logError('Error during shutdown', error);
                    process.exit(1);
                }
            });
        });
        
        // Handle uncaught errors
        process.on('unhandledRejection', async (reason, promise) => {
            logger.logError('Unhandled Promise Rejection', reason);
            
            if (!this.isShuttingDown) {
                await telegramNotifier.sendErrorAlert(
                    new Error(String(reason)), 
                    'Unhandled Promise Rejection'
                );
            }
        });
        
        process.on('uncaughtException', async (error) => {
            logger.logError('Uncaught Exception', error);
            
            try {
                await telegramNotifier.sendErrorAlert(error, 'Uncaught Exception - Bot stopping');
                
                setTimeout(() => {
                    process.exit(1);
                }, 2000);
                
            } catch (notifyError) {
                logger.logError('Failed to send error notification', notifyError);
                process.exit(1);
            }
        });
    }
}

// Start bot
if (require.main === module) {
    const manager = new BotManager();
    manager.start().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = BotManager;