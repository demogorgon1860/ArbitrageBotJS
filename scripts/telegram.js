const TelegramBot = require('node-telegram-bot-api');
const logger = require('./logger');
const { formatPrice, getCurrentTimestamp } = require('./utils');

class TelegramNotifier {
    constructor() {
        this.bot = null;
        this.chatId = null;
        this.enabled = false;
        
        this.init();
    }
    
    init() {
        try {
            const token = process.env.TELEGRAM_BOT_TOKEN;
            const chatId = process.env.TELEGRAM_CHAT_ID;
            
            if (!token || !chatId) {
                logger.logWarning('Telegram credentials not found - notifications disabled');
                return;
            }
            
            this.bot = new TelegramBot(token, { polling: false });
            this.chatId = chatId;
            this.enabled = true;
            
            logger.logSuccess('Telegram notifier initialized');
        } catch (error) {
            logger.logError('Failed to initialize Telegram bot', error);
        }
    }
    
    /**
     * Send message to Telegram
     */
    async sendMessage(message, options = {}) {
        if (!this.enabled) {
            logger.logDebug('Telegram not enabled, skipping message');
            return false;
        }
        
        try {
            const defaultOptions = {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            };
            
            const finalOptions = { ...defaultOptions, ...options };
            
            await this.bot.sendMessage(this.chatId, message, finalOptions);
            logger.logDebug('Telegram message sent successfully');
            return true;
            
        } catch (error) {
            logger.logError('Failed to send Telegram message', error);
            return false;
        }
    }
    
    /**
     * Send arbitrage opportunity alert
     */
    async sendArbitrageAlert(opportunity) {
        const message = this.formatArbitrageMessage(opportunity);
        return await this.sendMessage(message);
    }
    
    /**
     * Format arbitrage opportunity message
     */
    formatArbitrageMessage(opportunity) {
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
            deadline,
            timing,
            buyPath,
            sellPath,
            timestamp
        } = opportunity;
        
        const profitEmoji = this.getProfitEmoji(basisPoints);
        const riskLevel = this.getRiskLevel(basisPoints);
        const urgencyEmoji = this.getUrgencyEmoji(timing?.recommendation?.urgency || 'low');
        const timeRemaining = deadline ? Math.max(0, deadline - Date.now()) : 0;
        
        return `
${profitEmoji} <b>Arbitrage Opportunity Found!</b> ${urgencyEmoji}

💰 <b>Token:</b> ${token}
📈 <b>Spread:</b> ${basisPoints} bps (${formatPrice(percentage, 2)}%)

🏪 <b>Buy:</b> ${buyDex}
💵 <b>Price:</b> $${formatPrice(buyPrice)}

🏦 <b>Sell:</b> ${sellDex}
💵 <b>Price:</b> $${formatPrice(sellPrice)}

💸 <b>Input Amount:</b> $${inputAmount}
🎯 <b>Theoretical Profit:</b> $${formatPrice(potentialProfit, 2)}
💎 <b>Adjusted Profit:</b> $${formatPrice(adjustedProfit, 2)}

⚡ <b>Risk Level:</b> ${riskLevel}
🎲 <b>Success Probability:</b> ${confidence ? (confidence * 100).toFixed(1) : 'N/A'}%
⏱️ <b>Execution Time:</b> ${executionWindow ? (executionWindow / 1000).toFixed(1) : 'N/A'}s
⏰ <b>Window Remaining:</b> ${timeRemaining ? (timeRemaining / 1000).toFixed(1) : 'N/A'}s

${timing?.adjustedProfit ? `
💰 <b>Profit Breakdown:</b>
• Original: $${formatPrice(timing.adjustedProfit.originalProfit, 2)}
• Slippage Cost: $${formatPrice(timing.adjustedProfit.slippageCost, 2)}
• Gas Cost: $${formatPrice(timing.adjustedProfit.gasCost, 2)}
• Final: $${formatPrice(timing.adjustedProfit.adjustedProfit, 2)}
` : ''}

${timing?.priceDecay ? `
📉 <b>Time Decay:</b>
• Original Spread: ${timing.priceDecay.originalSpread} bps
• Expected Remaining: ${timing.priceDecay.remainingSpread} bps
• Decay Rate: ${timing.priceDecay.decayPercentage.toFixed(1)}%
` : ''}

🤖 <b>Recommendation:</b> ${timing?.recommendation?.action || 'MONITOR'}
${timing?.recommendation?.reason ? `<i>${timing.recommendation.reason}</i>` : ''}

${buyPath ? `🛣️ <b>Buy Path:</b> ${buyPath.join(' → ')}` : ''}
${sellPath ? `🛣️ <b>Sell Path:</b> ${sellPath.join(' → ')}` : ''}

⏰ <b>Discovered:</b> ${new Date(timestamp).toLocaleString()}

<i>⚠️ This is for monitoring only - no trades executed
💡 Profits are estimated and include time decay analysis</i>
        `.trim();
    }
    
    /**
     * Send status update
     */
    async sendStatusUpdate(status) {
        const {
            running,
            uptime,
            opportunitiesFound,
            lastCheck,
            activeTokens,
            activeDexes,
            rpcProviders,
            totalChecks,
            errors
        } = status;
        
        const statusIcon = running ? '🟢' : '🔴';
        const message = `
${statusIcon} <b>Arbitrage Bot Status Update</b>

📊 <b>Status:</b> ${running ? 'Running' : 'Stopped'}
⏰ <b>Uptime:</b> ${uptime}
🎯 <b>Opportunities Found:</b> ${opportunitiesFound}
🔍 <b>Total Checks:</b> ${totalChecks || 0}
❌ <b>Errors:</b> ${errors || 0}
📈 <b>Last Check:</b> ${lastCheck}

⚙️ <b>Configuration:</b>
• Active Tokens: ${activeTokens}
• Active DEXes: ${activeDexes}
• RPC Providers: ${rpcProviders || 'N/A'}

⏰ <b>Update Time:</b> ${new Date().toLocaleString()}
        `.trim();
        
        return await this.sendMessage(message);
    }
    
    /**
     * Send error alert
     */
    async sendErrorAlert(title, errorInfo = {}) {
        const message = `
🚨 <b>Bot Error Alert</b>

❌ <b>Error:</b> ${title}
${errorInfo.details ? `📝 <b>Details:</b> ${errorInfo.details}` : ''}
${errorInfo.token ? `🪙 <b>Token:</b> ${errorInfo.token}` : ''}
${errorInfo.dex ? `🏪 <b>DEX:</b> ${errorInfo.dex}` : ''}

⏰ <b>Time:</b> ${new Date().toLocaleString()}

<i>Bot will attempt automatic recovery...</i>
        `.trim();
        
        return await this.sendMessage(message);
    }
    
    /**
     * Send daily summary
     */
    async sendDailySummary(summary) {
        const {
            totalOpportunities,
            topToken,
            topDex,
            averageSpread,
            totalProfit,
            uptime,
            checksPerformed
        } = summary;
        
        const message = `
📊 <b>Daily Arbitrage Summary</b>

🎯 <b>Opportunities Found:</b> ${totalOpportunities}
🥇 <b>Top Token:</b> ${topToken || 'N/A'}
🏆 <b>Top DEX:</b> ${topDex || 'N/A'}
📈 <b>Average Spread:</b> ${averageSpread ? averageSpread.toFixed(1) : 'N/A'} bps
💰 <b>Total Potential Profit:</b> $${formatPrice(totalProfit, 2)}
⏰ <b>Bot Uptime:</b> ${uptime}
🔍 <b>Checks Performed:</b> ${checksPerformed}

📅 <b>Date:</b> ${new Date().toLocaleDateString()}
        `.trim();
        
        return await this.sendMessage(message);
    }
    
    /**
     * Get profit emoji based on basis points
     */
    getProfitEmoji(basisPoints) {
        if (basisPoints >= 500) return '🚀';
        if (basisPoints >= 300) return '💰';
        if (basisPoints >= 150) return '💵';
        if (basisPoints >= 100) return '💸';
        return '🪙';
    }
    
    /**
     * Get risk level based on spread
     */
    getRiskLevel(basisPoints) {
        if (basisPoints >= 500) return '🟢 Low (High Spread)';
        if (basisPoints >= 300) return '🟡 Medium';
        if (basisPoints >= 150) return '🟠 Medium-High';
        return '🔴 High (Low Spread)';
    }
    
    /**
     * Get urgency emoji based on timing
     */
    getUrgencyEmoji(urgency) {
        const urgencyMap = {
            'high': '🔥',
            'medium': '⚡',
            'low': '📊',
            'none': ''
        };
        
        return urgencyMap[urgency] || '';
    }
    
    /**
     * Send startup notification
     */
    async sendStartupNotification() {
        const message = `
🚀 <b>Polygon Arbitrage Bot Started</b>

✅ Bot has been successfully initialized and is now monitoring arbitrage opportunities.

⚙️ <b>Configuration:</b>
• Network: Polygon (MATIC)
• Monitoring: Uniswap V3, SushiSwap, QuickSwap
• Tokens: WETH, WBTC, USDC, USDT, LINK, AAVE, CRV, WMATIC

🔍 <b>Check Interval:</b> ${process.env.CHECK_INTERVAL_MS ? process.env.CHECK_INTERVAL_MS / 1000 : 30}s
💰 <b>Min Profit:</b> ${process.env.MIN_BASIS_POINTS_PER_TRADE || 50} bps

⏰ <b>Started:</b> ${new Date().toLocaleString()}
        `.trim();
        
        return await this.sendMessage(message);
    }
    
    /**
     * Send shutdown notification
     */
    async sendShutdownNotification(stats = {}) {
        const message = `
🛑 <b>Polygon Arbitrage Bot Stopped</b>

Bot has been gracefully shut down.

📊 <b>Session Statistics:</b>
• Uptime: ${stats.uptime || 'Unknown'}
• Opportunities Found: ${stats.opportunitiesFound || 0}
• Total Checks: ${stats.totalChecks || 0}
• Errors: ${stats.errors || 0}

⏰ <b>Stopped:</b> ${new Date().toLocaleString()}
        `.trim();
        
        return await this.sendMessage(message);
    }
    
    /**
     * Test Telegram connection
     */
    async testConnection() {
        const testMessage = `
🧪 <b>Telegram Connection Test</b>

✅ If you can see this message, Telegram notifications are working correctly!

⏰ <b>Test Time:</b> ${new Date().toLocaleString()}
        `.trim();
        
        return await this.sendMessage(testMessage);
    }
    
    /**
     * Get bot information
     */
    async getBotInfo() {
        if (!this.enabled || !this.bot) {
            return null;
        }
        
        try {
            return await this.bot.getMe();
        } catch (error) {
            logger.logError('Failed to get Telegram bot info', error);
            return null;
        }
    }
    
    /**
     * Send market update
     */
    async sendMarketUpdate(marketData) {
        const {
            totalVolume,
            topGainers,
            topLosers,
            marketTrend
        } = marketData;
        
        const trendEmoji = marketTrend === 'up' ? '📈' : marketTrend === 'down' ? '📉' : '➡️';
        
        const message = `
${trendEmoji} <b>Market Update</b>

📊 <b>24h Volume:</b> ${formatPrice(totalVolume, 0)}
📈 <b>Market Trend:</b> ${marketTrend?.toUpperCase() || 'NEUTRAL'}

${topGainers?.length ? `
🚀 <b>Top Gainers:</b>
${topGainers.map(token => `• ${token.symbol}: +${token.change.toFixed(2)}%`).join('\n')}
` : ''}

${topLosers?.length ? `
📉 <b>Top Losers:</b>
${topLosers.map(token => `• ${token.symbol}: ${token.change.toFixed(2)}%`).join('\n')}
` : ''}

⏰ <b>Update:</b> ${new Date().toLocaleString()}
        `.trim();
        
        return await this.sendMessage(message);
    }
    
    /**
     * Send performance metrics
     */
    async sendPerformanceMetrics(metrics) {
        const {
            avgResponseTime,
            successRate,
            rpcFailures,
            memoryUsage,
            cpuUsage
        } = metrics;
        
        const message = `
⚡ <b>Performance Metrics</b>

🚀 <b>Response Time:</b> ${avgResponseTime}ms avg
✅ <b>Success Rate:</b> ${successRate}%
🔄 <b>RPC Failures:</b> ${rpcFailures}
💾 <b>Memory Usage:</b> ${memoryUsage}
⚙️ <b>CPU Usage:</b> ${cpuUsage}%

⏰ <b>Measured:</b> ${new Date().toLocaleString()}
        `.trim();
        
        return await this.sendMessage(message);
    }
    
    /**
     * Send configuration update notification
     */
    async sendConfigUpdate(changes) {
        const message = `
⚙️ <b>Configuration Updated</b>

📝 <b>Changes:</b>
${Object.entries(changes).map(([key, value]) => `• ${key}: ${value}`).join('\n')}

⏰ <b>Updated:</b> ${new Date().toLocaleString()}
        `.trim();
        
        return await this.sendMessage(message);
    }
    
    /**
     * Check if Telegram is properly configured
     */
    isConfigured() {
        return this.enabled && this.bot && this.chatId;
    }
    
    /**
     * Get configuration status
     */
    getStatus() {
        return {
            enabled: this.enabled,
            configured: this.isConfigured(),
            chatId: this.chatId ? '***' + this.chatId.slice(-4) : null
        };
    }
}

// Create singleton instance
const telegramNotifier = new TelegramNotifier();

module.exports = telegramNotifier;