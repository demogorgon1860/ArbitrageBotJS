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
        this.rateLimitDelay = 1000; // 1 секунда между сообщениями
        
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
            
            // Запуск обработки очереди
            this.processMessageQueue();
            
        } catch (error) {
            logger.logError('❌ Failed to initialize Telegram notifier', error);
            this.isConfigured = false;
        }
    }
    
    /**
     * Получение статуса конфигурации
     */
    getStatus() {
        return {
            configured: this.isConfigured,
            queueLength: this.messageQueue.length,
            lastSent: this.lastMessageTime || null
        };
    }
    
    /**
     * Отправка уведомления о найденном арбитраже
     */
    async sendArbitrageAlert(opportunity) {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatArbitrageMessage(opportunity);
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            return true;
        } catch (error) {
            logger.logError('Failed to send arbitrage alert', error);
            return false;
        }
    }
    
    /**
     * Отправка уведомления о запуске бота
     */
    async sendStartupNotification() {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatStartupMessage();
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            return true;
        } catch (error) {
            logger.logError('Failed to send startup notification', error);
            return false;
        }
    }
    
    /**
     * Отправка уведомления об остановке бота
     */
    async sendShutdownNotification(stats) {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatShutdownMessage(stats);
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            
            // Обрабатываем очередь немедленно при shutdown
            await this.flushMessageQueue();
            return true;
        } catch (error) {
            logger.logError('Failed to send shutdown notification', error);
            return false;
        }
    }
    
    /**
     * Отправка периодического отчета
     */
    async sendPeriodicReport(stats) {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatPeriodicReport(stats);
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            return true;
        } catch (error) {
            logger.logError('Failed to send periodic report', error);
            return false;
        }
    }
    
    /**
     * Отправка уведомления об ошибке
     */
    async sendErrorAlert(error, context = '') {
        if (!this.isConfigured) return false;
        
        try {
            const message = this.formatErrorMessage(error, context);
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            return true;
        } catch (sendError) {
            logger.logError('Failed to send error alert', sendError);
            return false;
        }
    }
    
    /**
     * Форматирование сообщения об арбитраже
     */
    formatArbitrageMessage(opportunity) {
        const {
            token,
            basisPoints,
            buyDex,
            sellDex,
            buyPrice,
            sellPrice,
            potentialProfit,
            adjustedProfit,
            confidence,
            inputAmount,
            buyLiquidity,
            sellLiquidity,
            estimatedSlippage,
            timing
        } = opportunity;
        
        // Эмодзи для уровня возможности
        let alertEmoji = '💰';
        let urgencyText = 'MODERATE';
        
        if (adjustedProfit > 20 && confidence > 0.8) {
            alertEmoji = '🚨💎';
            urgencyText = 'EXCELLENT';
        } else if (adjustedProfit > 10 && confidence > 0.6) {
            alertEmoji = '⚡💰';
            urgencyText = 'GOOD';
        }
        
        // Форматирование цен
        const buyPriceFormatted = this.formatPrice(buyPrice);
        const sellPriceFormatted = this.formatPrice(sellPrice);
        
        // Расчет ROI
        const roi = (adjustedProfit / inputAmount) * 100;
        
        // Время выполнения
        const executionTime = timing?.executionTime ? 
            `${(timing.executionTime / 1000).toFixed(1)}s` : 'Unknown';
        
        // Рекомендация
        const recommendation = timing?.recommendation?.action || 'MONITOR';
        const recommendationEmoji = this.getRecommendationEmoji(recommendation);
        
        return `${alertEmoji} *ARBITRAGE OPPORTUNITY* ${alertEmoji}

*Token:* \`${token}\`
*Quality:* ${urgencyText} (${formatPercentage(confidence * 100, 1)})

📊 *SPREAD ANALYSIS*
• Spread: *${basisPoints}* basis points (${formatPercentage(basisPoints / 100, 2)})
• Buy DEX: \`${buyDex}\` at ${buyPriceFormatted}
• Sell DEX: \`${sellDex}\` at ${sellPriceFormatted}

💵 *PROFIT ANALYSIS*
• Gross Profit: ${formatCurrency(potentialProfit)}
• Net Profit: *${formatCurrency(adjustedProfit)}*
• ROI: *${formatPercentage(roi, 2)}*
• Trade Size: ${formatCurrency(inputAmount)}

🔄 *EXECUTION DETAILS*
• Estimated Time: ${executionTime}
• Buy Slippage: ${formatPercentage(estimatedSlippage?.buy || 0.3, 1)}
• Sell Slippage: ${formatPercentage(estimatedSlippage?.sell || 0.3, 1)}

💧 *LIQUIDITY*
• Buy Liquidity: ${formatCurrency(buyLiquidity)}
• Sell Liquidity: ${formatCurrency(sellLiquidity)}

${recommendationEmoji} *RECOMMENDATION: ${recommendation}*

⏰ *Time:* ${getCurrentTimestamp()}

${this.generatePolygonscanLinks(token)}`;
    }
    
    /**
     * Форматирование стартового сообщения
     */
    formatStartupMessage() {
        const timestamp = getCurrentTimestamp();
        
        return `🚀 *POLYGON ARBITRAGE BOT STARTED*

📊 *Configuration:*
• Network: Polygon (MATIC)
• DEXes: QuickSwap, SushiSwap, Uniswap V3
• Trade Size: $1,000
• Min Spread: 50 basis points

🎯 *Monitoring:*
• WMATIC, WETH, WBTC, USDC, USDT
• LINK, AAVE, CRV

⚡ *Features:*
• Real-time price monitoring
• Advanced profit calculations
• MEV protection analysis
• Liquidity validation

🕐 *Started:* ${timestamp}

_Bot is now actively searching for profitable arbitrage opportunities..._`;
    }
    
    /**
     * Форматирование сообщения об остановке
     */
    formatShutdownMessage(stats) {
        const {
            uptime,
            totalChecks,
            opportunitiesFound,
            profitableOpportunities,
            totalPotentialProfit,
            bestOpportunity,
            successRate,
            profitabilityRate
        } = stats;
        
        let bestOpportunityText = 'None found';
        if (bestOpportunity) {
            bestOpportunityText = `${bestOpportunity.token}: ${bestOpportunity.basisPoints} bps (${formatCurrency(bestOpportunity.adjustedProfit)})`;
        }
        
        return `🛑 *ARBITRAGE BOT STOPPED*

📊 *Session Summary:*
• Uptime: ${uptime}
• Total Checks: ${totalChecks}
• Success Rate: ${successRate}

🎯 *Opportunities:*
• Found: ${opportunitiesFound}
• Profitable: ${profitableOpportunities}
• Profitability Rate: ${profitabilityRate}
• Total Potential: ${formatCurrency(totalPotentialProfit)}

🏆 *Best Opportunity:*
${bestOpportunityText}

⏰ *Stopped:* ${getCurrentTimestamp()}

_Thank you for using Polygon Arbitrage Bot!_`;
    }
    
    /**
     * Форматирование периодического отчета
     */
    formatPeriodicReport(stats) {
        const {
            uptime,
            totalChecks,
            opportunitiesFound,
            profitableOpportunities,
            totalPotentialProfit,
            averageSpread,
            successRate,
            activeProviders,
            lastSuccessfulCheck
        } = stats;
        
        const timeSinceLastCheck = lastSuccessfulCheck ? 
            `${Math.round((Date.now() - new Date(lastSuccessfulCheck)) / 1000)}s ago` : 'Never';
        
        return `📊 *PERIODIC REPORT*

⏱️ *Uptime:* ${uptime}
🔍 *Monitoring:* Active (${activeProviders} RPC providers)
📡 *Last Check:* ${timeSinceLastCheck}

📈 *Performance:*
• Total Checks: ${totalChecks}
• Success Rate: ${successRate}
• Opportunities Found: ${opportunitiesFound}
• Profitable Ops: ${profitableOpportunities}

💰 *Profit Analysis:*
• Total Potential: ${formatCurrency(totalPotentialProfit)}
• Average Spread: ${averageSpread.toFixed(1)} bps

🕐 *Report Time:* ${getCurrentTimestamp()}

_Bot continues monitoring for arbitrage opportunities..._`;
    }
    
    /**
     * Форматирование сообщения об ошибке
     */
    formatErrorMessage(error, context) {
        const errorMessage = error.message || 'Unknown error';
        const errorStack = error.stack ? error.stack.split('\n')[0] : '';
        
        return `🚨 *ERROR ALERT*

⚠️ *Context:* ${context || 'General operation'}
📝 *Error:* \`${errorMessage}\`
🔍 *Details:* \`${errorStack}\`

⏰ *Time:* ${getCurrentTimestamp()}

_Bot will attempt to continue operation..._`;
    }
    
    /**
     * Форматирование цены с учетом величины
     */
    formatPrice(price) {
        if (!price || price <= 0) return '$0.00';
        
        if (price < 0.000001) return `${price.toExponential(2)}`;
        if (price < 0.001) return `${price.toFixed(8)}`;
        if (price < 1) return `${price.toFixed(6)}`;
        if (price < 1000) return `${price.toFixed(4)}`;
        return `${price.toFixed(2)}`;
    }
    
    /**
     * Получение эмодзи для рекомендации
     */
    getRecommendationEmoji(recommendation) {
        const emojiMap = {
            'EXECUTE_IMMEDIATELY': '🚨',
            'EXECUTE': '⚡',
            'MONITOR': '👀',
            'SKIP': '❌'
        };
        return emojiMap[recommendation] || '🤔';
    }
    
    /**
     * Генерация ссылок на Polygonscan
     */
    generatePolygonscanLinks(tokenSymbol) {
        const tokenAddresses = {
            'WMATIC': '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
            'WETH': '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
            'WBTC': '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
            'USDC': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            'USDT': '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
        };
        
        const address = tokenAddresses[tokenSymbol];
        if (!address) return '';
        
        return `\n🔗 [View ${tokenSymbol} on Polygonscan](https://polygonscan.com/token/${address})`;
    }
    
    /**
     * Добавление сообщения в очередь
     */
    async queueMessage(text, options = {}) {
        this.messageQueue.push({ text, options, timestamp: Date.now() });
        
        // Ограничиваем размер очереди
        if (this.messageQueue.length > 50) {
            this.messageQueue = this.messageQueue.slice(-50);
        }
    }
    
    /**
     * Обработка очереди сообщений
     */
    async processMessageQueue() {
        if (this.isProcessingQueue || !this.isConfigured) return;
        
        this.isProcessingQueue = true;
        
        while (this.messageQueue.length > 0) {
            try {
                const { text, options } = this.messageQueue.shift();
                
                await this.bot.sendMessage(this.chatId, text, {
                    disable_web_page_preview: true,
                    ...options
                });
                
                this.lastMessageTime = Date.now();
                
                // Rate limiting
                await this.sleep(this.rateLimitDelay);
                
            } catch (error) {
                logger.logError('Failed to send Telegram message', error);
                
                // Если ошибка API, увеличиваем задержку
                if (error.response?.statusCode === 429) {
                    const retryAfter = error.response.body?.parameters?.retry_after || 60;
                    logger.logWarning(`Rate limited, waiting ${retryAfter}s`);
                    await this.sleep(retryAfter * 1000);
                } else {
                    // Для других ошибок просто ждем
                    await this.sleep(5000);
                }
            }
        }
        
        this.isProcessingQueue = false;
        
        // Запланировать следующую обработку
        setTimeout(() => this.processMessageQueue(), 2000);
    }
    
    /**
     * Немедленная отправка всех сообщений в очереди
     */
    async flushMessageQueue() {
        const maxRetries = 3;
        let retries = 0;
        
        while (this.messageQueue.length > 0 && retries < maxRetries) {
            await this.processMessageQueue();
            
            if (this.messageQueue.length > 0) {
                retries++;
                await this.sleep(1000);
            }
        }
    }
    
    /**
     * Тестовое сообщение
     */
    async sendTestMessage() {
        if (!this.isConfigured) {
            logger.logWarning('Telegram not configured - cannot send test message');
            return false;
        }
        
        try {
            const message = `🧪 *TEST MESSAGE*

Telegram notifications are working correctly!

⏰ *Time:* ${getCurrentTimestamp()}`;
            
            await this.queueMessage(message, { parse_mode: 'Markdown' });
            return true;
        } catch (error) {
            logger.logError('Failed to send test message', error);
            return false;
        }
    }
    
    /**
     * Простая задержка
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Очистка очереди сообщений
     */
    clearQueue() {
        this.messageQueue = [];
        logger.logInfo('Telegram message queue cleared');
    }
    
    /**
     * Получение статистики сообщений
     */
    getMessageStats() {
        return {
            queueLength: this.messageQueue.length,
            isProcessing: this.isProcessingQueue,
            lastMessageTime: this.lastMessageTime,
            configured: this.isConfigured
        };
    }
}

// Создаем единственный экземпляр
const telegramNotifier = new TelegramNotifier();

module.exports = telegramNotifier;