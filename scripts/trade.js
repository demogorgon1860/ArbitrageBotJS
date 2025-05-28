const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

const config = require('../config/polygon.json');
const logger = require('./logger');
const telegramNotifier = require('./telegram');
const PriceFetcher = require('./priceFetcher');
const ArbitrageTimeCalculator = require('./timeCalculator');
const {
    calculateBasisPoints,
    createNotificationId,
    isDuplicateNotification,
    saveNotificationsCache,
    loadNotificationsCache,
    getCurrentTimestamp,
    sleep
} = require('./utils');

class ArbitrageBot {
    constructor() {
        this.providers = [];
        this.currentProviderIndex = 0;
        this.recentNotifications = new Map();
        this.isRunning = false;
        this.startTime = Date.now();
        this.priceFetcher = null;
        this.timeCalculator = new ArbitrageTimeCalculator();
        this.lastSuccessfulCheck = null;
        this.stats = {
            totalChecks: 0,
            opportunitiesFound: 0,
            viableOpportunities: 0,
            skippedByTime: 0,
            errors: 0,
            rpcFailovers: 0,
            lastCheck: null,
            successfulPriceFetches: 0,
            failedPriceFetches: 0
        };
        
        this.init();
    }
    
    async init() {
        try {
            logger.logInfo('🚀 Initializing Polygon Arbitrage Bot...');
            
            await this.setupProviders();
            this.priceFetcher = new PriceFetcher(this.getProvider());
            await this.loadNotificationsCache();
            await this.validateConfiguration();
            await this.testConnections();
            
            logger.logSuccess('✅ Arbitrage bot initialized successfully');
        } catch (error) {
            logger.logError('❌ Failed to initialize bot', error);
            process.exit(1);
        }
    }
    
    /**
     * Setup multiple RPC providers from environment variables
     */
    async setupProviders() {
        logger.logInfo('Setting up RPC providers...');
        
        const rpcEndpoints = [];
        
        // Collect RPC endpoints from environment
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                rpcEndpoints.push(rpc);
            }
        }
        
        // Add API key based endpoints
        if (process.env.ALCHEMY_API_KEY) {
            rpcEndpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY) {
            rpcEndpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        // Add public fallback endpoints
        const publicEndpoints = [
            "https://rpc.ankr.com/polygon",
            "https://polygon-rpc.com", 
            "https://rpc-mainnet.matic.network",
            "https://matic-mainnet.chainstacklabs.com"
        ];
        rpcEndpoints.push(...publicEndpoints);
        
        // Remove duplicates
        const uniqueEndpoints = [...new Set(rpcEndpoints)];
        
        // Test each endpoint and add working ones
        for (const endpoint of uniqueEndpoints) {
            try {
                const provider = new ethers.providers.JsonRpcProvider({
                    url: endpoint,
                    timeout: config.settings.rpcTimeoutMs || 10000
                });
                
                // Test connection
                await Promise.race([
                    provider.getNetwork(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Connection timeout')), 5000)
                    )
                ]);
                
                this.providers.push(provider);
                logger.logInfo(`✅ Connected to RPC: ${endpoint.split('/')[2]}`);
                
            } catch (error) {
                logger.logWarning(`❌ Failed to connect to RPC: ${endpoint} - ${error.message}`);
            }
        }
        
        if (this.providers.length === 0) {
            throw new Error('No working RPC providers found. Please check your .env configuration.');
        }
        
        logger.logSuccess(`Connected to ${this.providers.length} RPC providers`);
    }
    
    /**
     * Get current provider
     */
    getProvider() {
        if (this.providers.length === 0) {
            throw new Error('No providers available');
        }
        return this.providers[this.currentProviderIndex];
    }
    
    /**
     * Switch to next provider on failure
     */
    async switchProvider() {
        const oldIndex = this.currentProviderIndex;
        this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
        this.stats.rpcFailovers++;
        
        logger.logWarning(`🔄 RPC failover: ${oldIndex + 1} → ${this.currentProviderIndex + 1}/${this.providers.length}`);
        
        // Update price fetcher with new provider
        if (this.priceFetcher) {
            this.priceFetcher.updateProvider(this.getProvider());
        }
        
        // Test new provider
        try {
            const provider = this.getProvider();
            await provider.getBlockNumber();
            logger.logInfo('✅ New provider is working');
        } catch (error) {
            logger.logError('❌ New provider also failed', error);
            // Try next provider if available
            if (this.providers.length > 1) {
                await this.switchProvider();
            }
        }
    }
    
    /**
     * Validate configuration
     */
    async validateConfiguration() {
        logger.logInfo('Validating configuration...');
        
        // Check required environment variables
        const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
        const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
        
        if (missingVars.length > 0) {
            throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
        }
        
        // Validate token addresses
        for (const [symbol, token] of Object.entries(config.tokens)) {
            if (!token.address || !ethers.utils.isAddress(token.address)) {
                throw new Error(`Invalid address for token ${symbol}: ${token.address}`);
            }
        }
        
        // Validate DEX addresses
        for (const [dexName, dex] of Object.entries(config.dexes)) {
            if (!dex.router || !ethers.utils.isAddress(dex.router)) {
                throw new Error(`Invalid router address for ${dexName}: ${dex.router}`);
            }
        }
        
        logger.logSuccess('✅ Configuration validated');
    }
    
    /**
     * Test all connections
     */
    async testConnections() {
        logger.logInfo('Testing connections...');
        
        // Test RPC connection
        try {
            const provider = this.getProvider();
            const [blockNumber, network] = await Promise.all([
                provider.getBlockNumber(),
                provider.getNetwork()
            ]);
            
            if (network.chainId !== 137) {
                throw new Error(`Wrong network: expected Polygon (137), got ${network.chainId}`);
            }
            
            logger.logSuccess(`✅ RPC connected - Block: ${blockNumber}, Chain: ${network.chainId}`);
        } catch (error) {
            logger.logError('❌ RPC connection test failed', error);
            throw error;
        }
        
        // Test Telegram
        try {
            const botInfo = await telegramNotifier.getBotInfo();
            if (botInfo) {
                logger.logSuccess(`✅ Telegram connected - Bot: @${botInfo.username}`);
            }
        } catch (error) {
            logger.logWarning('⚠️ Telegram test failed - notifications disabled', error.message);
        }
        
        // Test price fetching with real data
        try {
            logger.logInfo('Testing real price fetching...');
            const testResult = await this.priceFetcher.getTokenPrice('USDC', 'sushiswap', 1000);
            if (testResult.success && testResult.price > 0) {
                logger.logSuccess(`✅ Price fetching test passed - USDC price: ${testResult.price.toFixed(6)}`);
            } else {
                logger.logWarning('⚠️ Price fetching test failed, but bot can continue');
            }
        } catch (error) {
            logger.logWarning('⚠️ Price fetching test error', error.message);
        }
    }
    
    /**
     * Load notifications cache
     */
    async loadNotificationsCache() {
        this.recentNotifications = await loadNotificationsCache();
        logger.logInfo(`Loaded ${this.recentNotifications.size} cached notifications`);
    }
    
    /**
     * Find real arbitrage opportunities using on-chain data
     */
    async findArbitrageOpportunity(tokenSymbol) {
        try {
            const inputAmountUSD = config.settings.inputAmountUSD;
            const dexNames = Object.keys(config.dexes);
            
            logger.logDebug(`🔍 Checking real prices for ${tokenSymbol}`, { 
                inputAmountUSD, 
                dexes: dexNames 
            });
            
            // Get real prices from all DEXes using on-chain data
            const priceResults = await this.priceFetcher.getMultiplePrices(
                tokenSymbol, 
                dexNames, 
                inputAmountUSD
            );
            
            // Update stats
            this.stats.successfulPriceFetches += priceResults.filter(r => r.success).length;
            this.stats.failedPriceFetches += priceResults.filter(r => !r.success).length;
            
            // Filter valid prices
            const validPrices = priceResults.filter(result => 
                result.success && 
                result.price > 0 && 
                typeof result.price === 'number' && 
                !isNaN(result.price)
            );
            
            if (validPrices.length < 2) {
                logger.logDebug(`❌ Insufficient valid prices for ${tokenSymbol}`, {
                    total: priceResults.length,
                    valid: validPrices.length,
                    errors: priceResults.filter(r => !r.success).map(r => ({ 
                        dex: r.dex, 
                        error: r.error 
                    }))
                });
                return null;
            }
            
            // Sort by price to find arbitrage opportunity
            validPrices.sort((a, b) => a.price - b.price);
            
            const buyPrice = validPrices[0]; // Lowest price (best for buying)
            const sellPrice = validPrices[validPrices.length - 1]; // Highest price (best for selling)
            
            if (buyPrice.dex === sellPrice.dex) {
                logger.logDebug(`❌ Same DEX for buy/sell ${tokenSymbol}: ${buyPrice.dex}`);
                return null; // Same DEX, no arbitrage possible
            }
            
            // Calculate spread
            const basisPoints = calculateBasisPoints(sellPrice.price, buyPrice.price);
            const minBasisPoints = config.settings.minBasisPointsPerTrade;
            
            if (basisPoints < minBasisPoints) {
                logger.logDebug(`❌ Spread too low for ${tokenSymbol}`, {
                    basisPoints,
                    minRequired: minBasisPoints,
                    buyDex: buyPrice.dex,
                    sellDex: sellPrice.dex,
                    buyPrice: buyPrice.price,
                    sellPrice: sellPrice.price
                });
                return null;
            }
            
            const percentage = basisPoints / 100;
            const potentialProfit = inputAmountUSD * (percentage / 100);
            
            const opportunity = {
                token: tokenSymbol,
                buyDex: buyPrice.dex,
                sellDex: sellPrice.dex,
                buyPrice: buyPrice.price,
                sellPrice: sellPrice.price,
                basisPoints,
                percentage,
                inputAmount: inputAmountUSD,
                potentialProfit,
                buyPath: buyPrice.path,
                sellPath: sellPrice.path,
                buyMethod: buyPrice.method,
                sellMethod: sellPrice.method,
                timestamp: getCurrentTimestamp(),
                allPrices: validPrices.map(p => ({
                    dex: p.dex,
                    price: p.price,
                    path: p.path,
                    method: p.method
                }))
            };
            
            // Calculate timing and viability
            const timingData = this.timeCalculator.calculateArbitrageTimings(opportunity);
            
            if (!timingData || !timingData.isViable) {
                this.stats.skippedByTime++;
                logger.logDebug(`❌ Opportunity not viable due to timing for ${tokenSymbol}`, {
                    confidence: timingData?.confidence || 0,
                    adjustedProfit: timingData?.adjustedProfit?.adjustedProfit || 0,
                    recommendation: timingData?.recommendation?.action || 'UNKNOWN'
                });
                return null;
            }
            
            // Add timing data to opportunity
            opportunity.timing = timingData;
            opportunity.adjustedProfit = timingData.adjustedProfit.adjustedProfit;
            opportunity.confidence = timingData.confidence;
            opportunity.executionWindow = timingData.executionTime;
            opportunity.deadline = timingData.deadline;
            
            this.stats.viableOpportunities++;
            
            logger.logSuccess(`✅ VIABLE ARBITRAGE FOUND: ${tokenSymbol}`, {
                spread: `${basisPoints} bps`,
                originalProfit: `$${potentialProfit.toFixed(2)}`,
                adjustedProfit: `$${timingData.adjustedProfit.adjustedProfit.toFixed(2)}`,
                confidence: `${(timingData.confidence * 100).toFixed(1)}%`,
                executionTime: `${timingData.executionTime}ms`,
                buyDex: buyPrice.dex,
                sellDex: sellPrice.dex,
                buyPath: buyPrice.path?.join('→'),
                sellPath: sellPrice.path?.join('→')
            });
            
            return opportunity;
            
        } catch (error) {
            logger.logError(`❌ Error finding arbitrage for ${tokenSymbol}`, error);
            this.stats.errors++;
            
            // Try switching provider on critical errors
            if (error.message.includes('timeout') || error.message.includes('network')) {
                await this.switchProvider();
            }
            
            return null;
        }
    }
    
    /**
     * Process and notify about arbitrage opportunity
     */
    async processOpportunity(opportunity) {
        try {
            const notificationId = createNotificationId(
                opportunity.token,
                opportunity.buyDex,
                opportunity.sellDex,
                opportunity.basisPoints
            );
            
            // Check for duplicates
            const cooldownMs = config.settings.notificationCooldownMs;
            if (isDuplicateNotification(notificationId, this.recentNotifications, cooldownMs)) {
                logger.logDebug(`🔄 Skipping duplicate notification: ${notificationId}`);
                return;
            }
            
            // Log to file
            await logger.logArbitrage(opportunity);
            
            // Send Telegram notification
            await telegramNotifier.sendArbitrageAlert(opportunity);
            
            this.stats.opportunitiesFound++;
            
            logger.logSuccess(`📱 Arbitrage opportunity processed and notified: ${opportunity.token}`);
            
        } catch (error) {
            logger.logError('❌ Failed to process opportunity', error);
        }
    }
    
    /**
     * Check all tokens for real arbitrage opportunities
     */
    async checkAllTokens() {
        try {
            this.stats.totalChecks++;
            this.stats.lastCheck = getCurrentTimestamp();
            
            logger.logInfo('🔍 CHECKING FOR REAL ARBITRAGE OPPORTUNITIES...');
            
            const tokens = Object.keys(config.tokens);
            const opportunities = [];
            let checksCompleted = 0;
            
            for (const tokenSymbol of tokens) {
                try {
                    logger.logInfo(`📊 Checking ${tokenSymbol} (${checksCompleted + 1}/${tokens.length})...`);
                    
                    const opportunity = await this.findArbitrageOpportunity(tokenSymbol);
                    if (opportunity) {
                        opportunities.push(opportunity);
                    }
                    
                    checksCompleted++;
                    
                    // Small delay between token checks to avoid overwhelming RPCs
                    await sleep(1000);
                    
                } catch (error) {
                    logger.logError(`❌ Error checking ${tokenSymbol}`, error);
                    
                    // Try switching provider on repeated errors
                    if (error.message.includes('timeout') || error.message.includes('network')) {
                        await this.switchProvider();
                    }
                }
            }
            
            this.lastSuccessfulCheck = Date.now();
            
            logger.logInfo(`📈 Check completed: Found ${opportunities.length} arbitrage opportunities`);
            
            // Process all opportunities
            for (const opportunity of opportunities) {
                await this.processOpportunity(opportunity);
            }
            
            // Save notifications cache
            await saveNotificationsCache(this.recentNotifications);
            
            // Log comprehensive stats
            logger.logInfo('📊 Check Statistics', {
                opportunities: opportunities.length,
                totalChecks: this.stats.totalChecks,
                viableOpportunities: this.stats.viableOpportunities,
                skippedByTime: this.stats.skippedByTime,
                successfulPrices: this.stats.successfulPriceFetches,
                failedPrices: this.stats.failedPriceFetches,
                rpcFailovers: this.stats.rpcFailovers,
                errors: this.stats.errors,
                currentProvider: `${this.currentProviderIndex + 1}/${this.providers.length}`
            });
            
        } catch (error) {
            logger.logError('❌ Critical error in checkAllTokens', error);
            this.stats.errors++;
            
            // Try provider failover on critical errors
            await this.switchProvider();
        }
    }
    
    /**
     * Start the arbitrage monitoring bot
     */
    async start() {
        if (this.isRunning) {
            logger.logWarning('⚠️ Bot is already running');
            return;
        }
        
        this.isRunning = true;
        logger.logSuccess('🚀 STARTING POLYGON ARBITRAGE BOT...');
        
        // Send startup notification
        await telegramNotifier.sendStatusUpdate({
            running: true,
            uptime: '0s',
            opportunitiesFound: 0,
            lastCheck: 'Starting...',
            activeTokens: Object.keys(config.tokens).length,
            activeDexes: Object.keys(config.dexes).length,
            rpcProviders: this.providers.length
        });
        
        const checkInterval = config.settings.checkIntervalMs || 30000;
        
        while (this.isRunning) {
            try {
                await this.checkAllTokens();
                
                logger.logInfo(`⏰ Next check in ${checkInterval / 1000}s...`);
                await sleep(checkInterval);
                
            } catch (error) {
                logger.logError('❌ CRITICAL ERROR in main loop', error);
                
                // Send error alert
                await telegramNotifier.sendErrorAlert('Critical bot error in main loop', {
                    details: error.message,
                    stack: error.stack
                });
                
                // Wait before retrying
                logger.logInfo('⏳ Waiting 10s before retry...');
                await sleep(10000);
            }
        }
    }
    
    /**
     * Stop the bot gracefully
     */
    async stop() {
        logger.logInfo('🛑 STOPPING ARBITRAGE BOT...');
        this.isRunning = false;
        
        // Save final state
        await saveNotificationsCache(this.recentNotifications);
        
        // Send shutdown notification
        await telegramNotifier.sendStatusUpdate({
            running: false,
            uptime: this.getStats().uptime,
            opportunitiesFound: this.stats.opportunitiesFound,
            lastCheck: this.stats.lastCheck,
            totalChecks: this.stats.totalChecks
        });
        
        logger.logSuccess('✅ Bot stopped gracefully');
    }
    
    /**
     * Get comprehensive bot statistics
     */
    getStats() {
        const uptime = Date.now() - this.startTime;
        const uptimeStr = new Date(uptime).toISOString().substr(11, 8);
        
        const successRate = this.stats.successfulPriceFetches / 
            Math.max(1, this.stats.successfulPriceFetches + this.stats.failedPriceFetches);
        
        return {
            ...this.stats,
            uptime: uptimeStr,
            isRunning: this.isRunning,
            providers: this.providers.length,
            currentProvider: this.currentProviderIndex + 1,
            notifications: this.recentNotifications.size,
            successRate: (successRate * 100).toFixed(1) + '%',
            lastSuccessfulCheck: this.lastSuccessfulCheck ? 
                new Date(this.lastSuccessfulCheck).toISOString() : 'Never'
        };
    }
}

// Enhanced error handling
process.on('uncaughtException', async (error) => {
    logger.logError('🚨 UNCAUGHT EXCEPTION', error);
    
    // Try to send emergency notification
    try {
        await telegramNotifier.sendErrorAlert('Bot crashed - Uncaught Exception', {
            details: error.message,
            stack: error.stack
        });
    } catch (notificationError) {
        console.error('Failed to send crash notification:', notificationError);
    }
    
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    logger.logError('🚨 UNHANDLED REJECTION', reason);
    
    // Try to send emergency notification
    try {
        await telegramNotifier.sendErrorAlert('Bot error - Unhandled Rejection', {
            details: reason?.message || String(reason)
        });
    } catch (notificationError) {
        console.error('Failed to send error notification:', notificationError);
    }
});

// Graceful shutdown handlers
const gracefulShutdown = async (signal) => {
    logger.logInfo(`📡 Received ${signal}, shutting down gracefully...`);
    
    if (global.arbitrageBot) {
        await global.arbitrageBot.stop();
    }
    
    process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Main execution
if (require.main === module) {
    const bot = new ArbitrageBot();
    global.arbitrageBot = bot; // For graceful shutdown
    
    bot.start().catch(async (error) => {
        logger.logError('❌ FAILED TO START BOT', error);
        
        try {
            await telegramNotifier.sendErrorAlert('Bot failed to start', {
                details: error.message,
                stack: error.stack
            });
        } catch (notificationError) {
            console.error('Failed to send startup error notification:', notificationError);
        }
        
        process.exit(1);
    });
}

module.exports = ArbitrageBot;