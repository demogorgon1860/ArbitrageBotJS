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
        this.timeCalculator = null;
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
            
            // Safe TimeCalculator initialization
            try {
                this.timeCalculator = new ArbitrageTimeCalculator();
                logger.logInfo('✅ TimeCalculator initialized');
            } catch (error) {
                logger.logWarning('⚠️ TimeCalculator initialization failed, using fallback', error.message);
                this.timeCalculator = null;
            }
            
            await this.loadNotificationsCache();
            await this.validateConfiguration();
            await this.testConnections();
            
            logger.logSuccess('✅ Arbitrage bot initialized successfully');
        } catch (error) {
            logger.logError('❌ Failed to initialize bot', error);
            process.exit(1);
        }
    }
    
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
        if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
            rpcEndpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
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
                const provider = new ethers.JsonRpcProvider(
                    endpoint,
                    137, // Polygon chainId
                    {
                        staticNetwork: true,
                        batchMaxCount: 1
                    }
                );
                
                // Test connection with timeout
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
    
    getProvider() {
        if (this.providers.length === 0) {
            throw new Error('No RPC providers available');
        }
        return this.providers[this.currentProviderIndex];
    }
    
    async switchProvider() {
        if (this.providers.length <= 1) {
            logger.logWarning('⚠️ Cannot switch provider - only one available');
            return;
        }
        
        this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
        this.stats.rpcFailovers++;
        
        const newProvider = this.getProvider();
        this.priceFetcher.updateProvider(newProvider);
        
        logger.logInfo(`🔄 Switched to RPC provider ${this.currentProviderIndex + 1}/${this.providers.length}`);
        
        // Test new provider
        try {
            await newProvider.getBlockNumber();
            logger.logSuccess('✅ New provider is working');
        } catch (error) {
            logger.logWarning('⚠️ New provider also has issues, will retry later');
        }
    }
    
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
            if (!token.address || !ethers.isAddress(token.address)) {
                throw new Error(`Invalid address for token ${symbol}: ${token.address}`);
            }
        }
        
        // Validate DEX addresses
        for (const [dexName, dex] of Object.entries(config.dexes)) {
            if (!dex.router || !ethers.isAddress(dex.router)) {
                throw new Error(`Invalid router address for ${dexName}: ${dex.router}`);
            }
        }
        
        logger.logSuccess('✅ Configuration validated');
    }
    
    async testConnections() {
        logger.logInfo('Testing connections...');
        
        // Test Telegram
        const telegramStatus = telegramNotifier.getStatus();
        if (telegramStatus.configured) {
            const testSent = await telegramNotifier.testConnection();
            if (testSent) {
                logger.logSuccess('✅ Telegram connection working');
            } else {
                logger.logWarning('⚠️ Telegram test failed - check credentials');
            }
        } else {
            logger.logWarning('⚠️ Telegram not configured - notifications disabled');
        }
        
        // Test RPC
        try {
            const provider = this.getProvider();
            const blockNumber = await provider.getBlockNumber();
            const network = await provider.getNetwork();
            
            if (Number(network.chainId) !== 137) {
                throw new Error(`Wrong network: expected 137, got ${network.chainId}`);
            }
            
            logger.logSuccess(`✅ RPC working - Block: ${blockNumber}, Chain: ${network.chainId}`);
        } catch (error) {
            throw new Error(`RPC connection failed: ${error.message}`);
        }
    }
    
    async loadNotificationsCache() {
        try {
            this.recentNotifications = await loadNotificationsCache();
            logger.logInfo(`📋 Loaded ${this.recentNotifications.size} cached notifications`);
        } catch (error) {
            logger.logWarning('⚠️ Failed to load notifications cache, starting fresh');
            this.recentNotifications = new Map();
        }
    }
    
    async start() {
        if (this.isRunning) {
            logger.logWarning('⚠️ Bot is already running');
            return;
        }
        
        this.isRunning = true;
        this.startTime = Date.now();
        
        logger.logSuccess('🚀 Starting arbitrage monitoring...');
        logger.logInfo(`📊 Checking ${Object.keys(config.tokens).length} tokens across ${Object.keys(config.dexes).length} DEXes`);
        logger.logInfo(`⏱️ Check interval: ${config.settings.checkIntervalMs / 1000}s`);
        logger.logInfo(`💰 Input amount: $${config.settings.inputAmountUSD}`);
        logger.logInfo(`📈 Min spread: ${config.settings.minBasisPointsPerTrade} bps`);
        
        // Send startup notification
        await telegramNotifier.sendArbitrageAlert({
            type: 'info',
            message: '🚀 Polygon Arbitrage Bot Started',
            details: `Monitoring ${Object.keys(config.tokens).length} tokens across ${Object.keys(config.dexes).length} DEXes`
        });
        
        // Start main loop
        this.runLoop();
        
        // Setup graceful shutdown
        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());
    }
    
    async runLoop() {
        while (this.isRunning) {
            try {
                await this.checkAllTokens();
                await this.saveStats();
                
                // Wait for next check
                await sleep(config.settings.checkIntervalMs);
                
            } catch (error) {
                logger.logError('❌ Error in main loop', error);
                this.stats.errors++;
                
                // Try to recover
                await this.switchProvider();
                await sleep(5000); // Short pause before retry
            }
        }
    }
    
    async checkAllTokens() {
        const tokens = Object.keys(config.tokens);
        const startTime = Date.now();
        
        this.stats.totalChecks++;
        this.stats.lastCheck = getCurrentTimestamp();
        
        logger.logInfo(`🔍 Checking ${tokens.length} tokens for arbitrage opportunities...`);
        
        const opportunities = [];
        
        // Check tokens in batches to avoid overwhelming RPC
        const batchSize = 3;
        for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (token) => {
                try {
                    const opportunity = await this.findArbitrageOpportunity(token);
                    if (opportunity) {
                        opportunities.push(opportunity);
                        this.stats.opportunitiesFound++;
                    }
                    return opportunity;
                } catch (error) {
                    logger.logError(`Error checking ${token}`, error);
                    return null;
                }
            });
            
            const batchResults = await Promise.allSettled(batchPromises);
            
            // Small delay between batches
            if (i + batchSize < tokens.length) {
                await sleep(1000);
            }
        }
        
        const checkDuration = Date.now() - startTime;
        
        if (opportunities.length > 0) {
            logger.logSuccess(`✅ Found ${opportunities.length} viable opportunities in ${checkDuration}ms`);
            
            // Sort by adjusted profit and confidence
            opportunities.sort((a, b) => {
                const scoreA = a.adjustedProfit * a.confidence;
                const scoreB = b.adjustedProfit * b.confidence;
                return scoreB - scoreA;
            });
            
            // Process opportunities
            for (const opportunity of opportunities) {
                await this.processOpportunity(opportunity);
            }
        } else {
            logger.logInfo(`🔍 No viable opportunities found in ${checkDuration}ms`);
        }
        
        this.lastSuccessfulCheck = Date.now();
    }
    
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
                estimatedSlippage: {
                    buy: buyPrice.estimatedSlippage || 0.3,
                    sell: sellPrice.estimatedSlippage || 0.3
                },
                timestamp: getCurrentTimestamp(),
                allPrices: validPrices.map(p => ({
                    dex: p.dex,
                    price: p.price,
                    path: p.path,
                    method: p.method,
                    slippage: p.estimatedSlippage
                }))
            };
            
            // Calculate timing and viability
            let timingData = null;
            try {
                if (this.timeCalculator && typeof this.timeCalculator.calculateArbitrageTimings === 'function') {
                    timingData = await this.timeCalculator.calculateArbitrageTimings(opportunity, this.getProvider());
                } else {
                    logger.logWarning('TimeCalculator not available, using fallback');
                    // Create basic timing data for continuation
                    timingData = {
                        isViable: basisPoints >= minBasisPoints && potentialProfit > 5,
                        confidence: basisPoints > 100 ? 0.7 : 0.5,
                        adjustedProfit: {
                            adjustedProfit: Math.max(0, potentialProfit - 2) // Simple $2 cost adjustment
                        },
                        recommendation: {
                            action: basisPoints > 100 ? 'EXECUTE' : 'MONITOR',
                            reason: 'Basic analysis (TimeCalculator unavailable)',
                            priority: basisPoints > 150 ? 6 : 3
                        },
                        executionTime: 10000, // 10 seconds default
                        deadline: Date.now() + 20000, // 20 seconds window
                        networkMetrics: { networkLoad: 1.0 }
                    };
                }
            } catch (timingError) {
                logger.logError(`TimeCalculator error for ${tokenSymbol}`, timingError);
                // Fallback timing data
                timingData = {
                    isViable: basisPoints >= minBasisPoints && potentialProfit > 5,
                    confidence: 0.6,
                    adjustedProfit: {
                        adjustedProfit: Math.max(0, potentialProfit - 2)
                    },
                    recommendation: {
                        action: 'MONITOR',
                        reason: 'TimeCalculator error - using fallback',
                        priority: 2
                    },
                    executionTime: 12000,
                    deadline: Date.now() + 15000,
                    networkMetrics: { networkLoad: 1.0 }
                };
            }
            
            if (!timingData || !timingData.isViable) {
                this.stats.skippedByTime++;
                logger.logDebug(`❌ Opportunity not viable due to timing for ${tokenSymbol}`, {
                    confidence: timingData?.confidence || 0,
                    adjustedProfit: timingData?.adjustedProfit?.adjustedProfit || 0,
                    recommendation: timingData?.recommendation?.action || 'UNKNOWN',
                    reason: timingData?.recommendation?.reason || 'No timing data'
                });
                return null;
            }
            
            // Add timing data to opportunity
            opportunity.timing = timingData;
            opportunity.adjustedProfit = timingData.adjustedProfit.adjustedProfit;
            opportunity.confidence = timingData.confidence;
            opportunity.executionWindow = timingData.executionTime;
            opportunity.deadline = timingData.deadline;
            opportunity.networkMetrics = timingData.networkMetrics;
            
            this.stats.viableOpportunities++;
            
            logger.logSuccess(`✅ VIABLE ARBITRAGE FOUND: ${tokenSymbol}`, {
                spread: `${basisPoints} bps`,
                originalProfit: `$${potentialProfit.toFixed(2)}`,
                adjustedProfit: `$${timingData.adjustedProfit.adjustedProfit.toFixed(2)}`,
                confidence: `${(timingData.confidence * 100).toFixed(1)}%`,
                recommendation: timingData.recommendation.action,
                priority: timingData.recommendation.priority || 'N/A',
                executionTime: `${(timingData.executionTime/1000).toFixed(1)}s`,
                buyDex: buyPrice.dex,
                sellDex: sellPrice.dex,
                buyPath: buyPrice.path?.join('→') || 'Direct',
                sellPath: sellPrice.path?.join('→') || 'Direct',
                networkLoad: timingData.networkMetrics?.networkLoad?.toFixed(1) || 'N/A'
            });
            
            return opportunity;
            
        } catch (error) {
            logger.logError(`❌ Error finding arbitrage for ${tokenSymbol}`, error);
            this.stats.errors++;
            
            // Try switching provider on critical errors
            if (error.message.includes('timeout') || error.message.includes('network')) {
                try {
                    await this.switchProvider();
                } catch (switchError) {
                    logger.logError('Failed to switch provider', switchError);
                }
            }
            
            return null;
        }
    }
    
    async processOpportunity(opportunity) {
        try {
            const notificationId = createNotificationId(
                opportunity.token,
                opportunity.buyDex,
                opportunity.sellDex,
                opportunity.basisPoints
            );
            
            // Check for duplicate notifications
            if (isDuplicateNotification(
                notificationId, 
                this.recentNotifications, 
                config.settings.notificationCooldownMs
            )) {
                logger.logDebug(`🔇 Skipping duplicate notification for ${opportunity.token}`);
                return;
            }
            
            // Send notification
            const alertSent = await telegramNotifier.sendArbitrageAlert({
                type: 'arbitrage',
                opportunity,
                botStats: this.getStats()
            });
            
            if (alertSent) {
                logger.logSuccess(`📱 Alert sent for ${opportunity.token} arbitrage`);
            } else {
                logger.logWarning(`📱 Failed to send alert for ${opportunity.token}`);
            }
            
        } catch (error) {
            logger.logError('Error processing opportunity', error);
        }
    }
    
    async saveStats() {
        try {
            await saveNotificationsCache(this.recentNotifications);
        } catch (error) {
            logger.logError('Failed to save stats', error);
        }
    }
    
    getStats() {
        const uptime = Date.now() - this.startTime;
        const uptimeMinutes = Math.floor(uptime / 60000);
        
        return {
            ...this.stats,
            uptime: `${uptimeMinutes} minutes`,
            uptimeMs: uptime,
            activeProviders: this.providers.length,
            currentProvider: this.currentProviderIndex + 1,
            lastSuccessfulCheck: this.lastSuccessfulCheck ? 
                new Date(this.lastSuccessfulCheck).toISOString() : null,
            successRate: this.stats.totalChecks > 0 ? 
                ((this.stats.totalChecks - this.stats.errors) / this.stats.totalChecks * 100).toFixed(1) + '%' : 'N/A'
        };
    }
    
    async printStats() {
        const stats = this.getStats();
        
        logger.logInfo('📊 Bot Statistics:');
        logger.logInfo(`   ⏱️ Uptime: ${stats.uptime}`);
        logger.logInfo(`   🔍 Total checks: ${stats.totalChecks}`);
        logger.logInfo(`   💎 Opportunities found: ${stats.opportunitiesFound}`);
        logger.logInfo(`   ✅ Viable opportunities: ${stats.viableOpportunities}`);
        logger.logInfo(`   ⏰ Skipped by timing: ${stats.skippedByTime}`);
        logger.logInfo(`   ❌ Errors: ${stats.errors}`);
        logger.logInfo(`   🔄 RPC failovers: ${stats.rpcFailovers}`);
        logger.logInfo(`   📡 Success rate: ${stats.successRate}`);
        logger.logInfo(`   🌐 Active providers: ${stats.activeProviders}`);
        
        if (this.timeCalculator) {
            const calibrationStats = this.timeCalculator.getCalibrationStats();
            logger.logInfo(`   🎯 TimeCalculator accuracy: ${calibrationStats.accuracy}`);
        }
    }
    
    async stop() {
        if (!this.isRunning) {
            logger.logWarning('⚠️ Bot is not running');
            return;
        }
        
        logger.logInfo('🛑 Stopping arbitrage bot...');
        this.isRunning = false;
        
        try {
            await this.saveStats();
            await this.printStats();
            
            // Send shutdown notification
            await telegramNotifier.sendArbitrageAlert({
                type: 'info',
                message: '🛑 Polygon Arbitrage Bot Stopped',
                details: `Final stats: ${this.stats.opportunitiesFound} opportunities found, ${this.stats.viableOpportunities} viable`
            });
            
            logger.logSuccess('✅ Bot stopped gracefully');
        } catch (error) {
            logger.logError('Error during shutdown', error);
        }
        
        process.exit(0);
    }
}

// Create and start bot if this file is run directly
if (require.main === module) {
    const bot = new ArbitrageBot();
    
    // Start the bot
    bot.start().catch(error => {
        logger.logError('Failed to start bot', error);
        process.exit(1);
    });
    
    // Setup periodic stats reporting
    setInterval(() => {
        bot.printStats();
    }, 300000); // Every 5 minutes
}

module.exports = ArbitrageBot;