/**
 * Telegram Notifier - Fixed implementation
 */

const TelegramBot = require('node-telegram-bot-api');
const logger = require('./logger');
const { formatCurrency, getCurrentTimestamp, SimpleMutex } = require('./utils');

class TelegramNotifier {
    constructor() {
        this.bot = null;
        this.chatId = null;
        this.isConfigured = false;
        this.messageQueue = [];
        this.queueMutex = new SimpleMutex();
        this.isProcessing = false;
        
        this.stats = {
            sent: 0,
            failed: 0,
            queued: 0
        };
        
        this.init();
    }
    
    init() {
        try {
            const botToken = process.env.TELEGRAM_BOT_TOKEN;
            const chatId = process.env.TELEGRAM_CHAT_ID;
            
            if (!botToken || !chatId) {
                logger.logWarning('Telegram not configured');
                return;
            }
            
            this.bot = new TelegramBot(botToken, { polling: false });
            this.chatId = chatId;
            this.isConfigured = true;
            
            logger.logSuccess('Telegram notifier initialized');
            
            // Start queue processor
            this.startQueueProcessor();
            
        } catch (error) {
            logger.logError('Failed to initialize Telegram', error);
            this.isConfigured = false;
        }
    }
    
    async sendMessage(text, options = {}) {
        if (!this.isConfigured) return false;
        
        await this.queueMutex.acquire();
        try {
            this.messageQueue.push({
                text,
                options: {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true,
                    ...options
                },
                timestamp: Date.now(),
                retries: 0
            });
            
            this.stats.queued++;
            return true;
            
        } finally {
            this.queueMutex.release();
        }
    }
    
    async sendArbitrageAlert(opportunity) {
        const { token, buyDex, sellDex, spread, analysis } = opportunity;
        
        const message = `
🚨 *ARBITRAGE OPPORTUNITY* 🚨

*Token:* \`${token}\`
*Route:* ${buyDex} → ${sellDex}
*Spread:* ${spread.toFixed(2)}%

💰 *Profit Analysis:*
- Input: ${formatCurrency(analysis.inputAmount)}
- Gross Profit: ${formatCurrency(analysis.grossProfit)}
- Gas Cost: ${formatCurrency(analysis.gasCost)}
- Swap Fees: ${formatCurrency(analysis.swapFees)}
- Slippage: ${formatCurrency(analysis.slippage)}
- *NET PROFIT:* ${formatCurrency(analysis.netProfit)}
- *ROI:* ${analysis.roi.toFixed(2)}%

💧 *Liquidity:*
- Buy: ${formatCurrency(opportunity.buyLiquidity)}
- Sell: ${formatCurrency(opportunity.sellLiquidity)}

⏰ *Time:* ${getCurrentTimestamp()}
        `;
        
        return this.sendMessage(message);
    }
    
    async sendStartupNotification(info) {
        const features = info.features.map(f => `• ${f}`).join('\n');
        
        const message = `
🚀 *BOT STARTED* 🚀

*Version:* ${info.version}
*Features:*
${features}

*Configuration:*
- Min Net Profit: ${formatCurrency(parseFloat(process.env.MIN_NET_PROFIT_USD) || 0.20)}
- Trade Size: ${formatCurrency(parseFloat(process.env.INPUT_AMOUNT_USD) || 1000)}
- Scan Interval: ${(parseInt(process.env.CHECK_INTERVAL_MS) || 30000) / 1000}s

⏰ *Started:* ${getCurrentTimestamp()}
        `;
        
        return this.sendMessage(message);
    }
    
    async sendShutdownNotification(stats) {
        const message = `
🛑 *BOT STOPPED* 🛑

*Statistics:*
- Runtime: ${Math.floor(stats.runtime / 60)} minutes
- Total Scans: ${stats.totalScans}
- Opportunities Found: ${stats.opportunitiesFound}
- Profitable: ${stats.profitableOpportunities}
- Total Net Profit: ${formatCurrency(stats.totalNetProfit)}
- Success Rate: ${stats.successRate}%

⏰ *Stopped:* ${getCurrentTimestamp()}
        `;
        
        return this.sendMessage(message);
    }
    
    async sendErrorAlert(error, context) {
        const message = `
⚠️ *ERROR ALERT* ⚠️

*Context:* ${context}
*Error:* \`${error.message}\`

⏰ *Time:* ${getCurrentTimestamp()}
        `;
        
        return this.sendMessage(message);
    }
    
    async startQueueProcessor() {
        if (this.isProcessing) return;
        
        this.isProcessing = true;
        
        while (true) {
            try {
                await this.queueMutex.acquire();
                const message = this.messageQueue.shift();
                this.queueMutex.release();
                
                if (!message) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                
                try {
                    await this.bot.sendMessage(this.chatId, message.text, message.options);
                    this.stats.sent++;
                    
                    // Rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                } catch (error) {
                    this.stats.failed++;
                    
                    if (message.retries < 3) {
                        message.retries++;
                        
                        await this.queueMutex.acquire();
                        this.messageQueue.unshift(message);
                        this.queueMutex.release();
                    }
                    
                    logger.logError('Failed to send Telegram message', error);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
                
            } catch (error) {
                logger.logError('Queue processor error', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
    
    getStatus() {
        return {
            configured: this.isConfigured,
            queueLength: this.messageQueue.length,
            stats: this.stats
        };
    }
}

// Singleton
module.exports = new TelegramNotifier();