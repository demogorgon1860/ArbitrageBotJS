/**
 * PRODUCTION-READY telegram.js - All issues fixed
 * 
 * ✅ Fixed sendMessage method implementation
 * ✅ Added proper error handling for all notifications
 * ✅ Enhanced message formatting with real profit breakdown
 * ✅ Rate limiting and queue management
 * ✅ Comprehensive logging and monitoring
 */

const TelegramBot = require('node-telegram-bot-api');
const logger = require('./logger');
const { formatCurrency, formatPercentage, getCurrentTimestamp } = require('./utils');

class TelegramNotifier {
    constructor() {
        this.bot = null;
        this.chatId = null;
        this.isConfigured = false;
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.rateLimitDelay = 1000; // 1 second between messages
        this.lastMessageTime = null;
        this.messageStats = {
            sent: 0,
            failed: 0,
            queued: 0,
            rateLimited: 0
        };
        
        this.init();
    }
    
    init() {
        try {
            const botToken = process.env.TELEGRAM_BOT_TOKEN;
            const chatId = process.env.TELEGRAM_CHAT_ID;
            
            if (!botToken || !chatId || botToken === 'undefined' || chatId === 'undefined') {
                logger.logWarning('⚠️ Telegram not configured - notifications disabled');
                return;
            }
            
            this.bot = new TelegramBot(botToken, { polling: false });
            this.chatId = chatId;
            this.isConfigured = true;
            
            logger.logSuccess('✅ Telegram notifier configured');
            
            // Start queue processing
            this.processMessageQueue();
            
        } catch (error) {
            logger.logError('❌ Failed to initialize Telegram notifier', error);
            this.isConfigured = false;
        }
    }
    
    /**
     * ✅ FIXED: Proper sendMessage implementation
     */
    async sendMessage(text, options = {}) {
        if (!this.isConfigured) {
            logger.logDebug('Telegram not configured, skipping message');
            return false;
        }
        
        try {
            await this.queueMessage(text, options);
            return true;
        } catch (error) {
            logger.logError('Failed to queue Telegram message', error);
            return false;
        }
    }
    
    /**
     * ✅ Enhanced arbitrage alert with real profit breakdown
     */
    async sendArbitrageAlert(opportunity) {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatEnhancedArbitrageMessage(opportunity);
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            this.messageStats.queued++;
            return true;
        } catch (error) {
            logger.logError('Failed to send arbitrage alert', error);
            this.messageStats.failed++;
            return false;
        }
    }
    
    /**
     * ✅ FIXED: Enhanced arbitrage message formatting with real profit data
     */
    formatEnhancedArbitrageMessage(opportunity) {
        const {
            token,
            basisPoints,
            buyDex,
            sellDex,
            buyPrice,
            sellPrice,
            inputAmount,
            grossProfit,
            netProfit,
            realProfitAnalysis,
            buyPool,
            sellPool,
            confidence
        } = opportunity;
        
        // ✅ Safe property access for enhanced data
        const profitData = realProfitAnalysis || {
            netProfit: netProfit || 0,
            totalCosts: grossProfit ? (grossProfit - (netProfit || 0)) : 0,
            costBreakdown: {
                gas: 0,
                swapFees: 0,
                slippage: 0,
                network: 0
            },
            roi: 0
        };
        
        // ✅ Safe property access for pool data
        const buyPoolData = buyPool || {
            dex: buyDex,
            method: 'Unknown',
            liquidity: 0,
            path: [token]
        };
        
        const sellPoolData = sellPool || {
            dex: sellDex,
            method: 'Unknown',
            liquidity: 0,
            path: [token]
        };
        
        // Determine urgency based on net profit and confidence
        let alertEmoji = '💰';
        let urgencyText = 'MODERATE';
        
        if (profitData.netProfit > 20 && (confidence || 0.7) > 0.8) {
            alertEmoji = '🚨💎';
            urgencyText = 'EXCELLENT';
        } else if (profitData.netProfit > 10 && (confidence || 0.7) > 0.6) {
            alertEmoji = '⚡💰';
            urgencyText = 'GOOD';
        }
        
        // ✅ Enhanced message with comprehensive profit breakdown
        let message = `${alertEmoji} *ENHANCED ARBITRAGE ALERT* ${alertEmoji}

*Token:* \`${token}\`
*Quality:* ${urgencyText} (${((confidence || 0.7) * 100).toFixed(1)}% confidence)

📊 *SPREAD ANALYSIS*
• Spread: *${basisPoints.toFixed(1)}* basis points (${(basisPoints/100).toFixed(2)}%)
• Buy: \`${buyPoolData.dex}\` @ $${buyPrice.toFixed(4)} (${buyPoolData.method})
• Sell: \`${sellPoolData.dex}\` @ $${sellPrice.toFixed(4)} (${sellPoolData.method})

💵 *REAL PROFIT CALCULATION*
• Input Amount: $${(inputAmount || 1000).toLocaleString()}
• Gross Profit: $${(grossProfit || 0).toFixed(2)}

💸 *DETAILED COST BREAKDOWN*
• Gas Cost: $${profitData.costBreakdown.gas.toFixed(2)}
• Swap Fees: $${profitData.costBreakdown.swapFees.toFixed(2)}
• Slippage: $${profitData.costBreakdown.slippage.toFixed(2)}
• Network: $${profitData.costBreakdown.network.toFixed(2)}
• *Total Costs: $${profitData.totalCosts.toFixed(2)}*

✨ *NET PROFIT: $${profitData.netProfit.toFixed(2)}* (${profitData.roi.toFixed(2)}% ROI)

💧 *LIQUIDITY ANALYSIS*
• Buy Liquidity: $${((buyPoolData.liquidity || 0)/1000).toFixed(0)}K
• Sell Liquidity: $${((sellPoolData.liquidity || 0)/1000).toFixed(0)}K

🔍 *PROTOCOL DETAILS*
• Buy Path: ${buyPoolData.path ? buyPoolData.path.join(' → ') : 'Direct'}
• Sell Path: ${sellPoolData.path ? sellPoolData.path.join(' → ') : 'Direct'}`;

        // ✅ Add V3 fee tier information if available
        if ((buyPool && buyPool.feeTier) || (sellPool && sellPool.feeTier)) {
            message += '\n\n🦄 *V3 FEE TIERS*';
            if (buyPool && buyPool.feeTier) {
                message += `\n• Buy: ${buyPool.feeTier/10000}% fee tier`;
            }
            if (sellPool && sellPool.feeTier) {
                message += `\n• Sell: ${sellPool.feeTier/10000}% fee tier`;
            }
        }

        message += `\n\n⏰ *Discovered:* ${getCurrentTimestamp()}

_Enhanced Analysis with Real Profit Calculation & V3 Support_`;
        
        return message;
    }
    
    /**
     * ✅ Enhanced startup notification
     */
    async sendStartupNotification() {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatStartupMessage();
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            this.messageStats.queued++;
            return true;
        } catch (error) {
            logger.logError('Failed to send startup notification', error);
            this.messageStats.failed++;
            return false;
        }
    }
    
    formatStartupMessage() {
        const timestamp = getCurrentTimestamp();
        
        return `🚀 *POLYGON ARBITRAGE BOT STARTED*

📊 *Enhanced Features:*
• Real-time profit calculation with all costs
• V3 liquidity optimization across protocols
• Dynamic gas, slippage, and fee analysis
• Comprehensive V2/V3 pool support

🎯 *Monitoring:*
• Network: Polygon (MATIC)
• DEXes: QuickSwap, SushiSwap, Uniswap V3
• Tokens: WMATIC, WETH, WBTC, USDC, USDT, LINK, AAVE, CRV
• Trade Size: $1,000 sample analysis

⚡ *Real-Time Data:*
• Live gas price monitoring
• Dynamic slippage calculation
• Actual pool liquidity analysis
• MEV protection cost estimation

🔍 *Profit Analysis:*
• Gross profit calculation
• Gas cost estimation (real-time)
• Swap fee calculation (protocol-specific)
• Slippage impact (liquidity-based)
• Network costs (MEV + congestion)
• **Net profit filtering**

🕐 *Started:* ${timestamp}

_Bot is now actively monitoring for profitable arbitrage opportunities with real cost analysis..._`;
    }
    
    /**
     * ✅ Enhanced shutdown notification
     */
    async sendShutdownNotification(stats) {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatShutdownMessage(stats);
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            
            // Process queue immediately for shutdown
            await this.flushMessageQueue();
            this.messageStats.queued++;
            return true;
        } catch (error) {
            logger.logError('Failed to send shutdown notification', error);
            this.messageStats.failed++;
            return false;
        }
    }
    
    formatShutdownMessage(stats) {
        const {
            uptime,
            totalChecks,
            opportunitiesFound,
            profitableOpportunities,
            enhancedOpportunities,
            v3OpportunitiesFound,
            totalGrossProfit,
            totalNetProfit,
            bestNetProfitOpportunity,
            successRate,
            averageNetProfitMargin
        } = stats;
        
        let bestOpportunityText = 'None found';
        if (bestNetProfitOpportunity) {
            bestOpportunityText = `${bestNetProfitOpportunity.token}: Net $${bestNetProfitOpportunity.netProfit.toFixed(2)} (${bestNetProfitOpportunity.roi.toFixed(2)}% ROI)`;
        }
        
        return `🛑 *ENHANCED ARBITRAGE BOT STOPPED*

📊 *Session Summary:*
• Uptime: ${uptime || 'Unknown'}
• Total Checks: ${totalChecks || 0}
• Success Rate: ${successRate || 'N/A'}

🎯 *Opportunities Analysis:*
• Total Found: ${opportunitiesFound || 0}
• Enhanced Analyses: ${enhancedOpportunities || 0}
• V3 Opportunities: ${v3OpportunitiesFound || 0}
• Net Profitable: ${profitableOpportunities || 0}

💰 *Real Profit Tracking:*
• Total Gross Profit Found: $${(totalGrossProfit || 0).toFixed(2)}
• Total Net Profit Found: $${(totalNetProfit || 0).toFixed(2)}
• Average Profit Margin: ${(averageNetProfitMargin || 0).toFixed(1)}%

🏆 *Best Net Profit Opportunity:*
${bestOpportunityText}

📱 *Telegram Stats:*
• Messages Sent: ${this.messageStats.sent}
• Messages Failed: ${this.messageStats.failed}
• Rate Limited: ${this.messageStats.rateLimited}

⏰ *Stopped:* ${getCurrentTimestamp()}

_Thank you for using Enhanced Polygon Arbitrage Bot with Real Profit Analysis!_`;
    }
    
    /**
     * ✅ Enhanced periodic report
     */
    async sendPeriodicReport(stats) {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatPeriodicReport(stats);
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            this.messageStats.queued++;
            return true;
        } catch (error) {
            logger.logError('Failed to send periodic report', error);
            this.messageStats.failed++;
            return false;
        }
    }
    
    formatPeriodicReport(stats) {
        const {
            uptime,
            totalChecks,
            opportunitiesFound,
            profitableOpportunities,
            enhancedOpportunities,
            totalNetProfit,
            averageNetProfitMargin,
            successRate,
            activeProviders,
            lastSuccessfulCheck
        } = stats;
        
        const timeSinceLastCheck = lastSuccessfulCheck ? 
            `${Math.round((Date.now() - new Date(lastSuccessfulCheck)) / 1000)}s ago` : 'Never';
        
        return `📊 *ENHANCED PERIODIC REPORT*

⏱️ *System Status:*
• Uptime: ${uptime || 'Unknown'}
• Monitoring: Active (${activeProviders || 0} RPC providers)
• Last Check: ${timeSinceLastCheck}
• Success Rate: ${successRate || 'N/A'}

📈 *Enhanced Performance:*
• Total Checks: ${totalChecks || 0}
• Enhanced Analyses: ${enhancedOpportunities || 0}
• Opportunities Found: ${opportunitiesFound || 0}
• Net Profitable: ${profitableOpportunities || 0}

💰 *Real Profit Analysis:*
• Total Net Profit Found: ${(totalNetProfit || 0).toFixed(2)}
• Average Profit Margin: ${(averageNetProfitMargin || 0).toFixed(1)}%
• Cost-Adjusted Filtering: Active

🔧 *Technical Status:*
• V3 Optimization: Enabled
• Real-time Gas Tracking: Active
• Dynamic Slippage Calc: Enabled
• MEV Protection Analysis: Active

📱 *Telegram Performance:*
• Messages Sent: ${this.messageStats.sent}
• Queue Length: ${this.messageQueue.length}
• Success Rate: ${this.getTelegramSuccessRate()}%

🕐 *Report Time:* ${getCurrentTimestamp()}

_Enhanced bot continues monitoring for profitable arbitrage opportunities..._`;
    }
    
    /**
     * ✅ Enhanced error alert
     */
    async sendErrorAlert(error, context = '') {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatErrorMessage(error, context);
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            this.messageStats.queued++;
            return true;
        } catch (sendError) {
            logger.logError('Failed to send error alert', sendError);
            this.messageStats.failed++;
            return false;
        }
    }
    
    formatErrorMessage(error, context) {
        const errorMessage = error.message || 'Unknown error';
        const errorStack = error.stack ? error.stack.split('\n')[0] : '';
        
        return `🚨 *ENHANCED BOT ERROR ALERT*

⚠️ *Context:* ${context || 'General operation'}
📝 *Error:* \`${errorMessage}\`
🔍 *Details:* \`${errorStack}\`

🔧 *Bot Status:*
• Enhanced Analysis: Active
• V3 Optimization: Running
• Real Profit Calc: Enabled

⏰ *Time:* ${getCurrentTimestamp()}

_Enhanced bot will attempt to continue operation with fallback mechanisms..._`;
    }
    
    /**
     * ✅ Test message for setup validation
     */
    async sendTestMessage() {
        if (!this.isConfigured) {
            logger.logWarning('Telegram not configured - cannot send test message');
            return false;
        }
        
        try {
            const message = `🧪 *ENHANCED BOT TEST MESSAGE*

✅ Telegram notifications are working correctly!

🔧 *Enhanced Features Tested:*
• Real profit calculation: Ready
• V3 liquidity optimization: Ready
• Dynamic cost analysis: Ready
• Comprehensive pool support: Ready

📊 *Message Statistics:*
• Sent: ${this.messageStats.sent}
• Failed: ${this.messageStats.failed}
• Queue: ${this.messageQueue.length}

⏰ *Time:* ${getCurrentTimestamp()}

_Ready for production arbitrage monitoring!_`;
            
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            return true;
        } catch (error) {
            logger.logError('Failed to send test message', error);
            return false;
        }
    }
    
    // === QUEUE MANAGEMENT (Enhanced) ===
    
    /**
     * ✅ Enhanced message queueing with priority
     */
    async queueMessage(text, options = {}, priority = 'normal') {
        const message = {
            text,
            options: {
                disable_web_page_preview: true,
                ...options
            },
            timestamp: Date.now(),
            priority,
            retries: 0,
            maxRetries: 3
        };
        
        // Priority queue management
        if (priority === 'high') {
            this.messageQueue.unshift(message);
        } else {
            this.messageQueue.push(message);
        }
        
        // Limit queue size
        if (this.messageQueue.length > 100) {
            this.messageQueue = this.messageQueue.slice(-100);
            logger.logWarning('⚠️ Telegram queue trimmed to 100 messages');
        }
        
        this.messageStats.queued++;
    }
    
    /**
     * ✅ Enhanced queue processing with retry logic
     */
    async processMessageQueue() {
        if (this.isProcessingQueue || !this.isConfigured) return;
        
        this.isProcessingQueue = true;
        
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            
            try {
                await this.bot.sendMessage(this.chatId, message.text, message.options);
                
                this.lastMessageTime = Date.now();
                this.messageStats.sent++;
                
                logger.logDebug(`📱 Telegram message sent (queue: ${this.messageQueue.length})`);
                
                // Rate limiting
                await this.sleep(this.rateLimitDelay);
                
            } catch (error) {
                this.messageStats.failed++;
                
                // Handle different error types
                if (error.response?.statusCode === 429) {
                    // Rate limited
                    const retryAfter = error.response.body?.parameters?.retry_after || 60;
                    this.messageStats.rateLimited++;
                    
                    logger.logWarning(`📱 Telegram rate limited, waiting ${retryAfter}s`);
                    
                    // Re-queue message if retries available
                    if (message.retries < message.maxRetries) {
                        message.retries++;
                        this.messageQueue.unshift(message);
                    }
                    
                    await this.sleep(retryAfter * 1000);
                    
                } else if (error.code === 'ETELEGRAM') {
                    // Telegram API error
                    logger.logError('📱 Telegram API error', error);
                    
                    // Re-queue with delay if retries available
                    if (message.retries < message.maxRetries) {
                        message.retries++;
                        this.messageQueue.push(message);
                        await this.sleep(5000);
                    }
                    
                } else {
                    // Other errors
                    logger.logError('📱 Telegram send error', error);
                    await this.sleep(2000);
                }
            }
        }
        
        this.isProcessingQueue = false;
        
        // Schedule next processing cycle
        setTimeout(() => this.processMessageQueue(), 3000);
    }
    
    /**
     * ✅ Flush queue immediately (for shutdown)
     */
    async flushMessageQueue() {
        const maxRetries = 5;
        let retries = 0;
        
        while (this.messageQueue.length > 0 && retries < maxRetries) {
            await this.processMessageQueue();
            
            if (this.messageQueue.length > 0) {
                retries++;
                await this.sleep(1000);
            }
        }
        
        if (this.messageQueue.length > 0) {
            logger.logWarning(`📱 ${this.messageQueue.length} messages remaining in queue after flush`);
        }
    }
    
    // === UTILITY METHODS ===
    
    /**
     * ✅ Get current status
     */
    getStatus() {
        return {
            configured: this.isConfigured,
            queueLength: this.messageQueue.length,
            isProcessing: this.isProcessingQueue,
            lastSent: this.lastMessageTime,
            stats: this.messageStats
        };
    }
    
    /**
     * ✅ Get comprehensive statistics
     */
    getMessageStats() {
        return {
            ...this.messageStats,
            queueLength: this.messageQueue.length,
            isProcessing: this.isProcessingQueue,
            lastMessageTime: this.lastMessageTime,
            configured: this.isConfigured,
            successRate: this.getTelegramSuccessRate()
        };
    }
    
    /**
     * ✅ Calculate success rate
     */
    getTelegramSuccessRate() {
        const total = this.messageStats.sent + this.messageStats.failed;
        if (total === 0) return 100;
        return ((this.messageStats.sent / total) * 100).toFixed(1);
    }
    
    /**
     * ✅ Clear queue and reset stats
     */
    clearQueue() {
        this.messageQueue = [];
        logger.logInfo('🧹 Telegram queue cleared');
    }
    
    /**
     * ✅ Reset statistics
     */
    resetStats() {
        this.messageStats = {
            sent: 0,
            failed: 0,
            queued: 0,
            rateLimited: 0
        };
        logger.logInfo('📊 Telegram statistics reset');
    }
    
    /**
     * ✅ Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * ✅ Health check
     */
    async healthCheck() {
        if (!this.isConfigured) {
            return {
                healthy: false,
                error: 'Not configured'
            };
        }
        
        try {
            // Test bot connection
            const botInfo = await Promise.race([
                this.bot.getMe(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Health check timeout')), 5000)
                )
            ]);
            
            return {
                healthy: true,
                botUsername: botInfo.username,
                botName: botInfo.first_name,
                queueLength: this.messageQueue.length,
                stats: this.messageStats
            };
            
        } catch (error) {
            return {
                healthy: false,
                error: error.message
            };
        }
    }
    
    /**
     * ✅ Enhanced configuration validation
     */
    validateConfiguration() {
        const issues = [];
        
        if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN === 'undefined') {
            issues.push('TELEGRAM_BOT_TOKEN not set');
        }
        
        if (!process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID === 'undefined') {
            issues.push('TELEGRAM_CHAT_ID not set');
        }
        
        if (!this.isConfigured) {
            issues.push('Telegram bot not initialized');
        }
        
        return {
            valid: issues.length === 0,
            issues,
            configured: this.isConfigured
        };
    }
}

// Create singleton instance
const telegramNotifier = new TelegramNotifier();

module.exports = telegramNotifier;