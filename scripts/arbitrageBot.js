/**
 * ENHANCED arbitrageBot.js - Direct replacement with real profit calculation
 * 
 * ✅ Real net profit calculation (gas + fees + slippage)
 * ✅ Enhanced V3 support via updated PriceFetcher
 * ✅ Detailed cost breakdown and logging
 * ✅ Improved opportunity filtering based on actual costs
 * ✅ Maintains all existing functionality and structure
 */

const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

const config = require('../config/polygon.json');
const logger = require('./logger');
const telegramNotifier = require('./telegram');
const EnhancedPriceFetcher = require('./priceFetcher'); // Your enhanced priceFetcher
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
        this.isInitialized = false;
        this.startTime = Date.now();
        this.priceFetcher = null;
        this.timeCalculator = null;
        this.lastSuccessfulCheck = null;
        this.initializationPromise = null;
        // Enhanced statistics with profit tracking
        this.stats = {
            totalChecks: 0,
            opportunitiesFound: 0,
            viableOpportunities: 0,
            profitableOpportunities: 0,
            enhancedOpportunities: 0, // New: opportunities with real profit calc
            v3OpportunitiesFound: 0,  // New: V3 specific opportunities
            errors: 0,
            rpcFailovers: 0,
            lastCheck: null,
            successfulPriceFetches: 0,
            failedPriceFetches: 0,
            
            // NEW: Real profit tracking
            totalGrossProfit: 0,
            totalNetProfit: 0,
            totalCosts: {
                gas: 0,
                swapFees: 0,
                slippage: 0,
                network: 0
            },
            averageNetProfitMargin: 0,
            bestNetProfitOpportunity: null,
            
            // Enhanced rejection tracking
            rejectionStats: {
                lowSpread: 0,
                highGasCost: 0,
                highSlippage: 0,
                lowLiquidity: 0,
                negativeNetProfit: 0,
                fetchError: 0,
                noValidPools: 0
            },
        };
        
        // Gas price cache for real-time cost calculation
        this.gasCache = {
            gasPrice: { value: null, timestamp: 0 },
            maticPrice: { value: 0.9, timestamp: 0 }, // Default MATIC price
            blockUtilization: { value: 0.7, timestamp: 0 }
        };
        
        // Performance settings
        this.performanceSettings = {
            batchSize: config.settings?.performanceOptimizations?.batchSize || 2,
            maxConcurrentDEX: config.settings?.performanceOptimizations?.maxConcurrentDEX || 2,
            priceTimeout: config.settings?.priceTimeoutMs || 15000,
            retryAttempts: config.settings?.maxRetries || 3,
            cooldownBetweenBatches: config.settings?.performanceOptimizations?.cooldownBetweenBatches || 2000
        };
        
        logger.logInfo('💎 Enhanced Arbitrage Bot with Real Profit Calculation initialized');
    }
    
    // === INITIALIZATION (Enhanced) ===
    
    async init() {
        if (this.initializationPromise) {
            return this.initializationPromise;
        }
        
        this.initializationPromise = this._performInitialization();
        return this.initializationPromise;
    }
    
    async _performInitialization() {
        try {
            logger.logInfo('🚀 Initializing Enhanced Arbitrage Bot with Real Profit Analysis...');
            
            await this.setupProviders();
            
            if (this.providers.length === 0) {
                throw new Error('No working RPC providers found');
            }
            
            // Initialize Enhanced PriceFetcher with V3 support
            try {
                this.priceFetcher = new EnhancedPriceFetcher(this.getProvider());
                logger.logInfo('✅ Enhanced PriceFetcher with V3 support initialized');
            } catch (error) {
                logger.logError('Failed to initialize Enhanced PriceFetcher', error);
                throw new Error(`PriceFetcher initialization failed: ${error.message}`);
            }
            
            // Initialize TimeCalculator
            try {
                this.timeCalculator = new ArbitrageTimeCalculator();
                logger.logInfo('✅ TimeCalculator initialized');
            } catch (error) {
                logger.logWarning('⚠️ TimeCalculator initialization failed, using simplified calculations', error.message);
                this.timeCalculator = null;
            }
            
            // Initialize gas price monitoring
            await this.updateGasData();
            
            await Promise.all([
                this.loadNotificationsCache(),
                this.validateConfiguration(),
                this.testConnections()
            ]);
            
            this.isInitialized = true;
            logger.logSuccess('✅ Enhanced arbitrage bot with real profit calculation initialized successfully');
            
        } catch (error) {
            logger.logError('❌ Failed to initialize enhanced bot', error);
            this.isInitialized = false;
            throw error;
        }
    }
    
    // === MAIN CHECKING METHOD (Enhanced with Real Profit Calculation) ===
    
    async checkAllTokens() {
        if (!this.priceFetcher) {
            logger.logError('❌ Enhanced PriceFetcher not available, skipping check');
            return;
        }
        
        const tokens = Object.keys(config.tokens);
        const startTime = Date.now();
        
        this.stats.totalChecks++;
        this.stats.lastCheck = getCurrentTimestamp();
        
        logger.logInfo(`🔍 ENHANCED CHECK: ${tokens.length} tokens with V3 + real profit calculation...`);
        
        // Update gas data for accurate cost calculation
        await this.updateGasData();
        
        const opportunities = [];
        const rejectedOpportunities = [];
        
        // Process tokens in batches
        for (let i = 0; i < tokens.length; i += this.performanceSettings.batchSize) {
            const batch = tokens.slice(i, i + this.performanceSettings.batchSize);
            
            const batchPromises = batch.map(async (token) => {
                try {
                    return await this.findEnhancedArbitrageOpportunity(token);
                } catch (error) {
                    logger.logError(`Error checking ${token}`, error);
                    this.stats.errors++;
                    return { 
                        success: false, 
                        rejectionReason: 'analysis_error', 
                        error: error.message, 
                        token 
                    };
                }
            });
            
            const batchResults = await Promise.allSettled(batchPromises);
            
            // Process results
            for (const result of batchResults) {
                if (result.status === 'fulfilled' && result.value) {
                    if (result.value.success && result.value.opportunity) {
                        opportunities.push(result.value.opportunity);
                        this.stats.opportunitiesFound++;
                        this.updateEnhancedStats(result.value.opportunity);
                    } else {
                        rejectedOpportunities.push(result.value);
                        this.updateRejectionStats(result.value.rejectionReason || 'unknown');
                    }
                }
            }
            
            // Cooldown between batches
            if (i + this.performanceSettings.batchSize < tokens.length) {
                await sleep(this.performanceSettings.cooldownBetweenBatches);
            }
        }
        
        const checkDuration = Date.now() - startTime;
        
        if (opportunities.length > 0) {
            // Sort by NET profit (not gross)
            opportunities.sort((a, b) => (b.realProfitAnalysis?.netProfit || 0) - (a.realProfitAnalysis?.netProfit || 0));
            
            logger.logSuccess(`✅ Found ${opportunities.length} PROFITABLE opportunities (real net profit) in ${checkDuration}ms`);
            
            // Process top opportunities
            for (const opportunity of opportunities.slice(0, 3)) {
                await this.processEnhancedOpportunity(opportunity);
            }
            
        } else {
            logger.logInfo(`🔍 No profitable opportunities found (after real cost analysis) in ${checkDuration}ms`);
            this.logDetailedRejectionSummary(rejectedOpportunities);
        }
        
        this.lastSuccessfulCheck = Date.now();
    }
    
    /**
     * CORE METHOD: Find arbitrage with real profit calculation
     */
    async findEnhancedArbitrageOpportunity(tokenSymbol) {
        try {
            this.stats.enhancedOpportunities++;
            
            const inputAmountUSD = config.settings.inputAmountUSD || 1000;
            const dexNames = Object.keys(config.dexes);
            
            logger.logDebug(`💎 Enhanced analysis: ${tokenSymbol} with real profit calculation`);
            
            // Step 1: Get enhanced prices from all DEXes (including V3)
            const priceResults = await this.getEnhancedPricesFromAllDEXes(tokenSymbol, dexNames, inputAmountUSD);
            
            this.stats.successfulPriceFetches += priceResults.filter(r => r.success).length;
            this.stats.failedPriceFetches += priceResults.filter(r => !r.success).length;
            
            // Step 2: Filter valid prices with sufficient liquidity
            const validPrices = priceResults.filter(result => 
                result.success && 
                result.price > 0 && 
                typeof result.price === 'number' && 
                !isNaN(result.price) &&
                isFinite(result.price) &&
                result.liquidity > 50 // Minimum $50 liquidity
            );
            
            if (validPrices.length < 2) {
                return {
                    success: false,
                    rejectionReason: 'insufficient_prices',
                    details: `Only ${validPrices.length}/2 valid prices`,
                    token: tokenSymbol
                };
            }
            
            // Track V3 usage
            const v3Prices = validPrices.filter(p => p.method && p.method.includes('V3'));
            if (v3Prices.length > 0) {
                this.stats.v3OpportunitiesFound++;
            }
            
            // Step 3: Find best buy/sell combination
            validPrices.sort((a, b) => a.price - b.price);
            
            const buyPrice = validPrices[0]; // Cheapest
            const sellPrice = validPrices[validPrices.length - 1]; // Most expensive
            
            if (buyPrice.dex === sellPrice.dex) {
                return {
                    success: false,
                    rejectionReason: 'same_dex',
                    details: `Best prices on same DEX: ${buyPrice.dex}`,
                    token: tokenSymbol
                };
            }
            
            // Step 4: Calculate spread
            const basisPoints = calculateBasisPoints(sellPrice.price, buyPrice.price);
            const minBasisPoints = config.settings?.minBasisPointsPerTrade || 30;
            
            if (basisPoints < minBasisPoints) {
                return {
                    success: false,
                    rejectionReason: 'lowSpread',
                    details: `Spread ${basisPoints.toFixed(1)} < ${minBasisPoints} bps`,
                    token: tokenSymbol,
                    actualSpread: basisPoints
                };
            }
            
            // Step 5: REAL PROFIT CALCULATION with all costs
            const grossProfit = inputAmountUSD * (basisPoints / 10000);
            const realProfitAnalysis = await this.calculateRealNetProfit(
                tokenSymbol, inputAmountUSD, grossProfit, buyPrice, sellPrice
            );
            
            // Step 6: Viability check based on NET profit
            if (realProfitAnalysis.netProfit <= 0) {
                return {
                    success: false,
                    rejectionReason: 'negativeNetProfit',
                    details: `Net profit: ${realProfitAnalysis.netProfit.toFixed(2)} (costs: ${realProfitAnalysis.totalCosts.toFixed(2)})`,
                    token: tokenSymbol,
                    grossProfit,
                    costs: realProfitAnalysis
                };
            }
            
            // Minimum viable net profit threshold
            const minNetProfit = config.settings?.profitThresholds?.minimum || 2.0;
            if (realProfitAnalysis.netProfit < minNetProfit) {
                return {
                    success: false,
                    rejectionReason: 'lowNetProfit',
                    details: `Net profit ${realProfitAnalysis.netProfit.toFixed(2)} < ${minNetProfit}`,
                    token: tokenSymbol
                };
            }
            
            // Step 7: Create enhanced opportunity object
            const opportunity = {
                token: tokenSymbol,
                buyDex: buyPrice.dex,
                sellDex: sellPrice.dex,
                buyPrice: buyPrice.price,
                sellPrice: sellPrice.price,
                basisPoints,
                percentage: basisPoints / 100,
                inputAmount: inputAmountUSD,
                
                // Enhanced fields
                grossProfit,
                realProfitAnalysis,
                netProfit: realProfitAnalysis.netProfit,
                roi: realProfitAnalysis.roi,
                
                // Detailed pool information
                buyPool: {
                    dex: buyPrice.dex,
                    method: buyPrice.method,
                    liquidity: buyPrice.liquidity,
                    slippage: buyPrice.estimatedSlippage,
                    gasEstimate: buyPrice.gasEstimate,
                    path: buyPrice.path,
                    poolAddress: buyPrice.poolAddress,
                    feeTier: buyPrice.feeTier
                },
                sellPool: {
                    dex: sellPrice.dex,
                    method: sellPrice.method,
                    liquidity: sellPrice.liquidity,
                    slippage: sellPrice.estimatedSlippage,
                    gasEstimate: sellPrice.gasEstimate,
                    path: sellPrice.path,
                    poolAddress: sellPrice.poolAddress,
                    feeTier: sellPrice.feeTier
                },
                
                timestamp: getCurrentTimestamp()
            };
            
            // Step 8: Add timing analysis if available
            if (this.timeCalculator) {
                try {
                    const timingData = await this.timeCalculator.calculateArbitrageTimings(opportunity, this.getProvider());
                    opportunity.timing = timingData;
                    opportunity.confidence = timingData.confidence || 0.7;
                } catch (timingError) {
                    logger.logDebug(`Timing calculation failed for ${tokenSymbol}: ${timingError.message}`);
                    opportunity.confidence = 0.6; // Default confidence
                }
            }
            
            this.stats.viableOpportunities++;
            this.stats.profitableOpportunities++;
            
            // Log detailed opportunity
            this.logEnhancedOpportunity(opportunity);
            
            return {
                success: true,
                opportunity: opportunity
            };
            
        } catch (error) {
            logger.logError(`❌ Enhanced analysis failed for ${tokenSymbol}`, error);
            
            // Switch provider on network errors
            if (error.message.includes('timeout') || error.message.includes('network')) {
                await this.switchProvider();
            }
            
            return {
                success: false,
                rejectionReason: 'analysis_error',
                details: error.message,
                token: tokenSymbol
            };
        }
    }
    
    /**
     * CORE: Real net profit calculation with all costs
     */
    async calculateRealNetProfit(tokenSymbol, inputAmountUSD, grossProfit, buyPool, sellPool) {
        try {
            // 1. Gas Cost Calculation (real-time)
            const gasCost = await this.calculateRealGasCost(buyPool, sellPool);
            
            // 2. Swap Fees Calculation (protocol-specific)
            const swapFees = this.calculateRealSwapFees(inputAmountUSD, buyPool, sellPool);
            
            // 3. Slippage Impact Calculation (liquidity-based)
            const slippageCost = this.calculateRealSlippageCost(inputAmountUSD, buyPool, sellPool);
            
            // 4. Network/MEV costs
            const networkCosts = this.calculateNetworkCosts(inputAmountUSD);
            
            const totalCosts = gasCost + swapFees + slippageCost + networkCosts;
            const netProfit = grossProfit - totalCosts;
            const roi = (netProfit / inputAmountUSD) * 100;
            
            return {
                grossProfit,
                netProfit,
                roi,
                totalCosts,
                costBreakdown: {
                    gas: gasCost,
                    swapFees,
                    slippage: slippageCost,
                    network: networkCosts
                },
                costPercentages: {
                    gasPercent: (gasCost / grossProfit) * 100,
                    feesPercent: (swapFees / grossProfit) * 100,
                    slippagePercent: (slippageCost / grossProfit) * 100,
                    networkPercent: (networkCosts / grossProfit) * 100
                }
            };
            
        } catch (error) {
            logger.logError('Real profit calculation failed', error);
            
            // Fallback calculation
            const fallbackCosts = grossProfit * 0.4; // 40% of gross profit as costs
            return {
                grossProfit,
                netProfit: grossProfit - fallbackCosts,
                roi: ((grossProfit - fallbackCosts) / inputAmountUSD) * 100,
                totalCosts: fallbackCosts,
                costBreakdown: {
                    gas: fallbackCosts * 0.3,
                    swapFees: fallbackCosts * 0.4,
                    slippage: fallbackCosts * 0.2,
                    network: fallbackCosts * 0.1
                },
                fallback: true
            };
        }
    }
    
    /**
     * Calculate real gas costs using current network data
     */
    async calculateRealGasCost(buyPool, sellPool) {
        try {
            const gasPrice = this.gasCache.gasPrice.value || 30; // Gwei
            const maticPrice = this.gasCache.maticPrice.value || 0.9; // USD
            const congestionMultiplier = this.getNetworkCongestionMultiplier();
            
            // Gas estimates based on actual pool types
            let totalGas = 0;
            
            // Buy transaction gas
            if (buyPool.method && buyPool.method.includes('V3')) {
                totalGas += buyPool.gasEstimate || 160000; // V3 is more expensive
            } else {
                totalGas += buyPool.gasEstimate || 130000; // V2 standard
            }
            
            // Sell transaction gas
            if (sellPool.method && sellPool.method.includes('V3')) {
                totalGas += sellPool.gasEstimate || 160000;
            } else {
                totalGas += sellPool.gasEstimate || 130000;
            }
            
            // Additional overheads
            totalGas += 50000; // Approvals and transfers
            
            // Apply congestion multiplier
            totalGas = Math.floor(totalGas * congestionMultiplier);
            
            // Convert to USD
            const gasCostMatic = (gasPrice * totalGas) / 1e9;
            const gasCostUSD = gasCostMatic * maticPrice;
            
            logger.logDebug(`⛽ Gas calculation: ${totalGas.toLocaleString()} gas @ ${gasPrice} Gwei = ${gasCostUSD.toFixed(2)}`);
            
            return Math.max(0.2, gasCostUSD); // Minimum $0.20
            
        } catch (error) {
            logger.logWarning('Gas calculation failed, using estimate', error.message);
            return 1.5; // Conservative fallback
        }
    }
    
    /**
     * Calculate protocol-specific swap fees
     */
    calculateRealSwapFees(inputAmountUSD, buyPool, sellPool) {
        let totalFees = 0;
        
        // Buy pool fees
        if (buyPool.feeTier) {
            // V3 pool - use actual fee tier
            totalFees += inputAmountUSD * (buyPool.feeTier / 1000000);
        } else {
            // V2 pool - standard 0.3%
            totalFees += inputAmountUSD * 0.003;
        }
        
        // Sell pool fees
        if (sellPool.feeTier) {
            totalFees += inputAmountUSD * (sellPool.feeTier / 1000000);
        } else {
            totalFees += inputAmountUSD * 0.003;
        }
        
        // Multi-hop additional fees
        if (buyPool.path && buyPool.path.length > 2) {
            totalFees += inputAmountUSD * 0.003 * (buyPool.path.length - 2);
        }
        if (sellPool.path && sellPool.path.length > 2) {
            totalFees += inputAmountUSD * 0.003 * (sellPool.path.length - 2);
        }
        
        logger.logDebug(`💸 Swap fees: Buy ${buyPool.method} + Sell ${sellPool.method} = ${totalFees.toFixed(2)}`);
        
        return totalFees;
    }
    
    /**
     * Calculate real slippage cost based on liquidity
     */
calculateRealSlippageCost(inputAmountUSD, buyPool, sellPool) {
    // ✅ FIXED: Safe property access and calculation
    const buySlippage = buyPool.estimatedSlippage || 
                       (buyPool.slippage !== undefined ? buyPool.slippage : 
                        this.calculatePoolSlippage(inputAmountUSD, buyPool.liquidity || 1000));
    
    const sellSlippage = sellPool.estimatedSlippage || 
                        (sellPool.slippage !== undefined ? sellPool.slippage : 
                         this.calculatePoolSlippage(inputAmountUSD, sellPool.liquidity || 1000));
    
    const totalSlippageCost = inputAmountUSD * ((buySlippage + sellSlippage) / 100);
    
    logger.logDebug(`📉 Slippage: Buy ${buySlippage.toFixed(2)}% + Sell ${sellSlippage.toFixed(2)}% = $${totalSlippageCost.toFixed(2)}`);
    
    return Math.max(0, totalSlippageCost); // Ensure non-negative
}
    
    calculatePoolSlippage(tradeAmountUSD, liquidity) {
        if (!liquidity || liquidity <= 0) return 5.0; // High slippage for unknown liquidity
        
        const tradeRatio = tradeAmountUSD / liquidity;
        
        if (tradeRatio > 0.1) return 10.0;
        if (tradeRatio > 0.05) return 5.0;
        if (tradeRatio > 0.02) return 2.0;
        if (tradeRatio > 0.01) return 1.0;
        if (tradeRatio > 0.005) return 0.5;
        return 0.2;
    }
    
    /**
     * Calculate network costs (MEV protection, congestion)
     */
    calculateNetworkCosts(inputAmountUSD) {
        const mevProtectionCost = inputAmountUSD * 0.0005; // 0.05%
        const congestionCost = inputAmountUSD * 0.0002; // 0.02%
        
        return mevProtectionCost + congestionCost;
    }
    
    /**
     * Get enhanced prices from all DEXes
     */
    async getEnhancedPricesFromAllDEXes(tokenSymbol, dexNames, inputAmountUSD) {
        const pricePromises = dexNames.slice(0, this.performanceSettings.maxConcurrentDEX).map(dexName =>
            Promise.race([
                this.priceFetcher.getTokenPrice(tokenSymbol, dexName, inputAmountUSD),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Price fetch timeout')), this.performanceSettings.priceTimeout)
                )
            ]).catch(error => ({
                price: 0,
                liquidity: 0,
                path: null,
                method: null,
                dex: dexName,
                success: false,
                error: error.message
            }))
        );
        
        try {
            const results = await Promise.allSettled(pricePromises);
            
            return results.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return {
                        price: 0,
                        liquidity: 0,
                        path: null,
                        method: null,
                        dex: dexNames[index],
                        success: false,
                        error: result.reason?.message || 'Unknown error'
                    };
                }
            });
            
        } catch (error) {
            logger.logError('Failed to get enhanced prices', error);
            return dexNames.map(dexName => ({
                price: 0,
                liquidity: 0,
                path: null,
                method: null,
                dex: dexName,
                success: false,
                error: error.message
            }));
        }
    }
    
    /**
     * Update gas and network data
     */
async updateGasData() {
    const now = Date.now();
    
    if (now - this.gasCache.gasPrice.timestamp < 120000 && this.gasCache.gasPrice.value) {
        return;
    }
    
    try {
        // ✅ FIXED: Proper provider reference
        const provider = this.getProvider();
        const [feeData, currentBlock] = await Promise.all([
            provider.getFeeData(),
            provider.getBlockNumber()
        ]);
        
        const gasPriceGwei = parseFloat(ethers.formatUnits(feeData.gasPrice || '30000000000', 'gwei'));
        
        this.gasCache.gasPrice = {
            value: gasPriceGwei,
            timestamp: now
        };
        
        // Update block utilization for congestion analysis
        try {
            const block = await provider.getBlock(currentBlock);
            if (block) {
                const utilization = Number(block.gasUsed) / Number(block.gasLimit);
                this.gasCache.blockUtilization = {
                    value: utilization,
                    timestamp: now
                };
            }
        } catch (blockError) {
            // Ignore block fetch errors
        }
        
        logger.logDebug(`🔄 Gas data updated: ${gasPriceGwei.toFixed(1)} Gwei`);
        
    } catch (error) {
        logger.logWarning('Failed to update gas data', error.message);
        
        if (!this.gasCache.gasPrice.value) {
            this.gasCache.gasPrice = {
                value: 30, // 30 Gwei fallback
                timestamp: now
            };
        }
    }
}

    
    getNetworkCongestionMultiplier() {
        const utilization = this.gasCache.blockUtilization.value || 0.7;
        
        if (utilization > 0.95) return 2.0;      // Very congested
        if (utilization > 0.85) return 1.5;      // Congested
        if (utilization > 0.70) return 1.2;      // Moderate
        return 1.0;                               // Normal
    }
    
    /**
     * Log enhanced opportunity with detailed breakdown
     */
    logEnhancedOpportunity(opportunity) {
        const { token, realProfitAnalysis, buyPool, sellPool, basisPoints } = opportunity;
        
        logger.logSuccess(`💎 ENHANCED ARBITRAGE: ${token}`);
        logger.logInfo(`   📊 SPREAD: ${basisPoints.toFixed(1)} bps`);
        logger.logInfo(`   💰 BUY:  ${buyPool.dex} @ ${opportunity.buyPrice.toFixed(4)} (${buyPool.method})`);
        logger.logInfo(`   💰 SELL: ${sellPool.dex} @ ${opportunity.sellPrice.toFixed(4)} (${sellPool.method})`);
        logger.logInfo(`   💧 LIQUIDITY: Buy ${(buyPool.liquidity/1000).toFixed(0)}K | Sell ${(sellPool.liquidity/1000).toFixed(0)}K`);
        
        logger.logInfo(`   💵 REAL PROFIT ANALYSIS:`);
        logger.logInfo(`     Gross Profit: ${realProfitAnalysis.grossProfit.toFixed(2)}`);
        logger.logInfo(`     Gas Cost: ${realProfitAnalysis.costBreakdown.gas.toFixed(2)} (${realProfitAnalysis.costPercentages.gasPercent.toFixed(1)}%)`);
        logger.logInfo(`     Swap Fees: ${realProfitAnalysis.costBreakdown.swapFees.toFixed(2)} (${realProfitAnalysis.costPercentages.feesPercent.toFixed(1)}%)`);
        logger.logInfo(`     Slippage: ${realProfitAnalysis.costBreakdown.slippage.toFixed(2)} (${realProfitAnalysis.costPercentages.slippagePercent.toFixed(1)}%)`);
        logger.logInfo(`     Network: ${realProfitAnalysis.costBreakdown.network.toFixed(2)} (${realProfitAnalysis.costPercentages.networkPercent.toFixed(1)}%)`);
        logger.logInfo(`     ✨ NET PROFIT: ${realProfitAnalysis.netProfit.toFixed(2)} (${realProfitAnalysis.roi.toFixed(2)}% ROI)`);
        
        if (buyPool.feeTier || sellPool.feeTier) {
            logger.logInfo(`   🦄 V3 DETAILS:`);
            if (buyPool.feeTier) logger.logInfo(`     Buy: ${buyPool.feeTier/10000}% fee tier`);
            if (sellPool.feeTier) logger.logInfo(`     Sell: ${sellPool.feeTier/10000}% fee tier`);
        }
    }
    
    /**
     * Update enhanced statistics
     */
    updateEnhancedStats(opportunity) {
        const { realProfitAnalysis } = opportunity;
        
        this.stats.totalGrossProfit += realProfitAnalysis.grossProfit;
        this.stats.totalNetProfit += realProfitAnalysis.netProfit;
        
        // Update cost tracking
        this.stats.totalCosts.gas += realProfitAnalysis.costBreakdown.gas;
        this.stats.totalCosts.swapFees += realProfitAnalysis.costBreakdown.swapFees;
        this.stats.totalCosts.slippage += realProfitAnalysis.costBreakdown.slippage;
        this.stats.totalCosts.network += realProfitAnalysis.costBreakdown.network;
        
        // Update average net profit margin
        if (this.stats.totalGrossProfit > 0) {
            this.stats.averageNetProfitMargin = (this.stats.totalNetProfit / this.stats.totalGrossProfit) * 100;
        }
        
        // Update best opportunity
        if (!this.stats.bestNetProfitOpportunity || 
            realProfitAnalysis.netProfit > this.stats.bestNetProfitOpportunity.netProfit) {
            this.stats.bestNetProfitOpportunity = {
                token: opportunity.token,
                netProfit: realProfitAnalysis.netProfit,
                roi: realProfitAnalysis.roi,
                basisPoints: opportunity.basisPoints,
                buyDex: opportunity.buyDex,
                sellDex: opportunity.sellDex,
                timestamp: opportunity.timestamp
            };
        }
    }
    
    /**
     * Process enhanced opportunity with detailed notifications
     */
    async processEnhancedOpportunity(opportunity) {
        try {
            const notificationId = createNotificationId(
                opportunity.token,
                opportunity.buyDex,
                opportunity.sellDex,
                opportunity.basisPoints
            );
            
            // Check for duplicates
            if (isDuplicateNotification(
                notificationId, 
                this.recentNotifications, 
                config.settings.notificationCooldownMs
            )) {
                logger.logDebug(`🔇 Skipping duplicate notification for ${opportunity.token}`);
                return;
            }
            
            // Send enhanced notification with real profit breakdown
            const alertSent = await this.sendEnhancedTelegramAlert(opportunity);
            
            if (alertSent) {
                logger.logSuccess(`📱 Enhanced alert sent for ${opportunity.token} (Net: ${opportunity.netProfit.toFixed(2)})`);
            } else {
                logger.logWarning(`📱 Failed to send enhanced alert for ${opportunity.token}`);
            }
            
        } catch (error) {
            logger.logError('Error processing enhanced opportunity', error);
        }
    }
    
    /**
     * Send enhanced Telegram alert with real profit breakdown
     */
async sendEnhancedTelegramAlert(opportunity) {
    try {
        const { token, realProfitAnalysis, buyPool, sellPool, basisPoints, inputAmount } = opportunity;
        
        // Determine urgency based on net profit and ROI
        let alertEmoji = '💰';
        let urgencyText = 'MODERATE';
        
        if (realProfitAnalysis.netProfit > 20 && realProfitAnalysis.roi > 2) {
            alertEmoji = '🚨💎';
            urgencyText = 'EXCELLENT';
        } else if (realProfitAnalysis.netProfit > 10 && realProfitAnalysis.roi > 1) {
            alertEmoji = '⚡💰';
            urgencyText = 'GOOD';
        }
        
        // Create enhanced message with real profit breakdown
        const message = `${alertEmoji} *ENHANCED ARBITRAGE ALERT* ${alertEmoji}

*Token:* \`${token}\`
*Quality:* ${urgencyText} (${(opportunity.confidence * 100).toFixed(1)}% confidence)

📊 *SPREAD ANALYSIS*
• Spread: *${basisPoints.toFixed(1)}* basis points (${(basisPoints/100).toFixed(2)}%)
• Buy: \`${buyPool.dex}\` @ $${opportunity.buyPrice.toFixed(4)} (${buyPool.method})
• Sell: \`${sellPool.dex}\` @ $${opportunity.sellPrice.toFixed(4)} (${sellPool.method})

💵 *REAL PROFIT CALCULATION*
• Input Amount: $${inputAmount.toLocaleString()}
• Gross Profit: $${realProfitAnalysis.grossProfit.toFixed(2)}

💸 *DETAILED COST BREAKDOWN*
• Gas Cost: $${realProfitAnalysis.costBreakdown.gas.toFixed(2)} (${realProfitAnalysis.costPercentages.gasPercent.toFixed(1)}%)
• Swap Fees: $${realProfitAnalysis.costBreakdown.swapFees.toFixed(2)} (${realProfitAnalysis.costPercentages.feesPercent.toFixed(1)}%)
• Slippage: $${realProfitAnalysis.costBreakdown.slippage.toFixed(2)} (${realProfitAnalysis.costPercentages.slippagePercent.toFixed(1)}%)
• Network: $${realProfitAnalysis.costBreakdown.network.toFixed(2)} (${realProfitAnalysis.costPercentages.networkPercent.toFixed(1)}%)
• *Total Costs: $${realProfitAnalysis.totalCosts.toFixed(2)}*

✨ *NET PROFIT: $${realProfitAnalysis.netProfit.toFixed(2)}* (${realProfitAnalysis.roi.toFixed(2)}% ROI)

💧 *LIQUIDITY ANALYSIS*
• Buy Liquidity: $${(buyPool.liquidity/1000).toFixed(0)}K (${buyPool.method})
• Sell Liquidity: $${(sellPool.liquidity/1000).toFixed(0)}K (${sellPool.method})

🔍 *PROTOCOL DETAILS*
• Buy Path: ${buyPool.path ? buyPool.path.join(' → ') : 'Direct'}
• Sell Path: ${sellPool.path ? sellPool.path.join(' → ') : 'Direct'}`;

        // Add V3 fee tier information if applicable
        if (buyPool.feeTier || sellPool.feeTier) {
            message += '\n\n🦄 *V3 FEE TIERS*\n';
            if (buyPool.feeTier) message += `• Buy: ${buyPool.feeTier/10000}% fee tier\n`;
            if (sellPool.feeTier) message += `• Sell: ${sellPool.feeTier/10000}% fee tier\n`;
        }

        message += `\n⏰ *Discovered:* ${getCurrentTimestamp()}

_Enhanced Analysis with Real Profit Calculation & V3 Support_`;
        
        // ✅ FIXED: Proper telegram method call
        return await telegramNotifier.sendMessage ? 
            telegramNotifier.sendMessage(message, { parse_mode: 'Markdown' }) :
            telegramNotifier.sendArbitrageAlert({ ...opportunity, enhancedMessage: message });
        
    } catch (error) {
        logger.logError('Failed to send enhanced Telegram alert', error);
        return false;
    }
}
    
    /**
     * Log detailed rejection summary
     */
    logDetailedRejectionSummary(rejectedOpportunities) {
        if (rejectedOpportunities.length === 0) return;
        
        const rejectionCounts = {};
        rejectedOpportunities.forEach(rejection => {
            const reason = rejection.rejectionReason || 'unknown';
            rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
        });
        
        logger.logInfo('📊 Enhanced Rejection Analysis (Real Profit Based):');
        Object.entries(rejectionCounts).forEach(([reason, count]) => {
            logger.logInfo(`   ${reason}: ${count} tokens`);
        });
        
        // Show sample rejections with details
        const detailedRejections = rejectedOpportunities
            .filter(r => r.details && r.token)
            .slice(0, 3);
        
        if (detailedRejections.length > 0) {
            logger.logInfo('🔍 Sample rejection details:');
            detailedRejections.forEach(rejection => {
                logger.logInfo(`   ${rejection.token}: ${rejection.details}`);
            });
        }
        
        // Analyze cost-related rejections
        const costRejections = rejectedOpportunities.filter(r => 
            r.rejectionReason === 'negativeNetProfit' || r.rejectionReason === 'lowNetProfit'
        );
        
        if (costRejections.length > 0) {
            logger.logInfo(`💸 Cost Analysis: ${costRejections.length} opportunities rejected due to high costs`);
            
            const avgCostRatio = costRejections
                .filter(r => r.costs && r.grossProfit)
                .reduce((sum, r) => sum + (r.costs.totalCosts / r.grossProfit), 0) / costRejections.length;
            
            if (avgCostRatio > 0) {
                logger.logInfo(`   Average cost ratio: ${(avgCostRatio * 100).toFixed(1)}% of gross profit`);
            }
        }
    }
    
    /**
     * Enhanced statistics display
     */
    async printEnhancedStats() {
        const uptime = Date.now() - this.startTime;
        const uptimeMinutes = Math.floor(uptime / 60000);
        
        logger.logInfo('📊 ENHANCED BOT STATISTICS (Real Profit Analysis):');
        logger.logInfo(`   ⏱️ Uptime: ${uptimeMinutes} minutes`);
        logger.logInfo(`   🔍 Total checks: ${this.stats.totalChecks}`);
        logger.logInfo(`   💎 Enhanced analyses: ${this.stats.enhancedOpportunities}`);
        logger.logInfo(`   🦄 V3 opportunities: ${this.stats.v3OpportunitiesFound}`);
        logger.logInfo(`   💰 Opportunities found: ${this.stats.opportunitiesFound}`);
        logger.logInfo(`   ✅ Viable opportunities: ${this.stats.viableOpportunities}`);
        logger.logInfo(`   💸 Profitable (net): ${this.stats.profitableOpportunities}`);
        
        logger.logInfo(`   💵 REAL PROFIT TRACKING:`);
        logger.logInfo(`     Total Gross Profit: ${this.stats.totalGrossProfit.toFixed(2)}`);
        logger.logInfo(`     Total Net Profit: ${this.stats.totalNetProfit.toFixed(2)}`);
        logger.logInfo(`     Average Profit Margin: ${this.stats.averageNetProfitMargin.toFixed(1)}%`);
        
        logger.logInfo(`   💸 COST BREAKDOWN:`);
        logger.logInfo(`     Total Gas Costs: ${this.stats.totalCosts.gas.toFixed(2)}`);
        logger.logInfo(`     Total Swap Fees: ${this.stats.totalCosts.swapFees.toFixed(2)}`);
        logger.logInfo(`     Total Slippage: ${this.stats.totalCosts.slippage.toFixed(2)}`);
        logger.logInfo(`     Total Network: ${this.stats.totalCosts.network.toFixed(2)}`);
        
        if (this.stats.totalGrossProfit > 0) {
            const gasImpact = (this.stats.totalCosts.gas / this.stats.totalGrossProfit) * 100;
            const slippageImpact = (this.stats.totalCosts.slippage / this.stats.totalGrossProfit) * 100;
            logger.logInfo(`     Gas Impact: ${gasImpact.toFixed(1)}% of gross profit`);
            logger.logInfo(`     Slippage Impact: ${slippageImpact.toFixed(1)}% of gross profit`);
        }
        
        if (this.stats.bestNetProfitOpportunity) {
            const best = this.stats.bestNetProfitOpportunity;
            logger.logInfo(`   🏆 Best Net Profit Opportunity:`);
            logger.logInfo(`     Token: ${best.token}`);
            logger.logInfo(`     Net Profit: ${best.netProfit.toFixed(2)} (${best.roi.toFixed(2)}% ROI)`);
            logger.logInfo(`     Spread: ${best.basisPoints.toFixed(1)} bps`);
            logger.logInfo(`     Route: ${best.buyDex} → ${best.sellDex}`);
        }
        
        // Current gas status
        const currentGas = this.gasCache.gasPrice.value || 0;
        const congestion = this.gasCache.blockUtilization.value || 0;
        logger.logInfo(`   ⛽ Current Gas: ${currentGas.toFixed(1)} Gwei (${(congestion*100).toFixed(1)}% network utilization)`);
        
        const successRate = this.stats.totalChecks > 0 ? 
            ((this.stats.totalChecks - this.stats.errors) / this.stats.totalChecks * 100).toFixed(1) : 'N/A';
        const profitabilityRate = this.stats.opportunitiesFound > 0 ?
            ((this.stats.profitableOpportunities / this.stats.opportunitiesFound) * 100).toFixed(1) : 'N/A';
        
        logger.logInfo(`   📈 Success Rate: ${successRate}%`);
        logger.logInfo(`   💹 Real Profitability Rate: ${profitabilityRate}%`);
        logger.logInfo(`   🌐 Active Providers: ${this.providers.length}`);
        logger.logInfo(`   🔄 RPC Failovers: ${this.stats.rpcFailovers}`);
    }
    
    updateRejectionStats(reason) {
        if (this.stats.rejectionStats[reason]) {
            this.stats.rejectionStats[reason]++;
        } else {
            this.stats.rejectionStats[reason] = 1;
        }
    }
    
    // === PROVIDER MANAGEMENT (Same as before) ===
    
    async setupProviders() {
        logger.logInfo('🌐 Setting up RPC providers...');
        
        const rpcEndpoints = this.collectRPCEndpoints();
        logger.logInfo(`Found ${rpcEndpoints.length} potential RPC endpoints`);
        
        if (rpcEndpoints.length === 0) {
            throw new Error('No RPC endpoints configured. Please check your .env file.');
        }
        
        const providerPromises = rpcEndpoints.slice(0, 8).map(endpoint => 
            this.testAndCreateProvider(endpoint)
        );
        
        const results = await Promise.allSettled(providerPromises);
        
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                this.providers.push(result.value);
                if (this.providers.length >= 5) break;
            }
        }
        
        if (this.providers.length === 0) {
            throw new Error('No working RPC providers found');
        }
        
        logger.logSuccess(`✅ Connected to ${this.providers.length} RPC providers`);
    }
    
    collectRPCEndpoints() {
        const endpoints = [];
        
        if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
            endpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
            endpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                endpoints.push(rpc);
            }
        }
        
        const publicEndpoints = [
            "https://polygon-rpc.com",
            "https://rpc.ankr.com/polygon",
            "https://rpc-mainnet.matic.network",
            "https://matic-mainnet.chainstacklabs.com"
        ];
        
        endpoints.push(...publicEndpoints);
        return [...new Set(endpoints)];
    }
    
    async testAndCreateProvider(endpoint) {
        try {
            const provider = new ethers.JsonRpcProvider(endpoint, 137, {
                staticNetwork: true,
                batchMaxCount: 1
            });
            
            const blockNumber = await Promise.race([
                provider.getBlockNumber(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Connection timeout')), 5000)
                )
            ]);
            
            const network = await provider.getNetwork();
            if (Number(network.chainId) !== 137) {
                throw new Error(`Wrong network: expected 137, got ${network.chainId}`);
            }
            
            logger.logInfo(`✅ Connected to RPC: ${endpoint.split('/')[2]} (block ${blockNumber})`);
            return provider;
            
        } catch (error) {
            logger.logWarning(`❌ Failed to connect to RPC: ${endpoint.split('/')[2]} - ${error.message}`);
            return null;
        }
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
            return false;
        }
        
        const oldIndex = this.currentProviderIndex;
        this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
        this.stats.rpcFailovers++;
        
        const newProvider = this.getProvider();
        
        if (this.priceFetcher && typeof this.priceFetcher.updateProvider === 'function') {
            try {
                this.priceFetcher.updateProvider(newProvider);
                await this.updateGasData(); // Update gas data with new provider
                logger.logInfo(`🔄 Switched to RPC provider ${this.currentProviderIndex + 1}/${this.providers.length}`);
                return true;
            } catch (error) {
                logger.logError('Failed to update PriceFetcher provider', error);
                this.currentProviderIndex = oldIndex;
                return false;
            }
        }
        
        return false;
    }
    
    // === LIFECYCLE METHODS ===
    
    async start() {
        if (this.isRunning) {
            logger.logWarning('⚠️ Bot is already running');
            return;
        }
        
        if (!this.isInitialized) {
            logger.logInfo('⏳ Waiting for initialization to complete...');
            await this.init();
        }
        
        this.isRunning = true;
        this.startTime = Date.now();
        
        logger.logSuccess('🚀 Starting ENHANCED arbitrage bot with real profit calculation...');
        logger.logInfo(`📊 Features: V3 support, real gas costs, accurate slippage, detailed profit breakdown`);
        logger.logInfo(`💰 Input amount: ${config.settings.inputAmountUSD.toLocaleString()}`);
        logger.logInfo(`⏱️ Check interval: ${config.settings.checkIntervalMs / 1000}s`);
        
        try {
            await telegramNotifier.sendStartupNotification();
        } catch (error) {
            logger.logWarning('Failed to send startup notification', error.message);
        }
        
        this.runLoop().catch(error => {
            logger.logError('Main loop crashed', error);
            this.handleCriticalError(error);
        });
        
        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());
    }
    
    async runLoop() {
        while (this.isRunning) {
            try {
                if (!this.isInitialized || !this.priceFetcher) {
                    logger.logWarning('⚠️ Bot not properly initialized, attempting re-initialization...');
                    await this.init();
                }
                
                await this.checkAllTokens();
                await this.saveStats();
                
                await sleep(config.settings.checkIntervalMs);
                
            } catch (error) {
                logger.logError('❌ Error in main loop', error);
                this.stats.errors++;
                
                const recovered = await this.attemptRecovery(error);
                if (!recovered) {
                    logger.logError('Failed to recover from error, stopping bot');
                    break;
                }
                
                await sleep(5000);
            }
        }
    }
    
    async attemptRecovery(error) {
        logger.logInfo('🔄 Attempting recovery...');
        
        try {
            const providerSwitched = await this.switchProvider();
            
            if (!this.priceFetcher || error.message.includes('PriceFetcher')) {
                try {
                    this.priceFetcher = new EnhancedPriceFetcher(this.getProvider());
                    logger.logInfo('✅ Enhanced PriceFetcher recreated');
                } catch (pfError) {
                    logger.logError('Failed to recreate Enhanced PriceFetcher', pfError);
                    return false;
                }
            }
            
            // Test the provider
            const provider = this.getProvider();
            await provider.getBlockNumber();
            
            // Update gas data with new provider
            await this.updateGasData();
            
            logger.logSuccess('✅ Recovery successful');
            return true;
            
        } catch (recoveryError) {
            logger.logError('❌ Recovery failed', recoveryError);
            return false;
        }
    }
    
    async stop() {
        if (!this.isRunning) {
            logger.logWarning('⚠️ Enhanced bot is not running');
            return;
        }
        
        logger.logInfo('🛑 Stopping enhanced arbitrage bot...');
        this.isRunning = false;
        
        try {
            await this.saveStats();
            await this.printEnhancedStats();
            
            try {
                const finalStats = this.getEnhancedStats();
                await telegramNotifier.sendShutdownNotification(finalStats);
            } catch (error) {
                logger.logWarning('Failed to send shutdown notification', error.message);
            }
            
            logger.logSuccess('✅ Enhanced bot with real profit calculation stopped gracefully');
        } catch (error) {
            logger.logError('Error during enhanced bot shutdown', error);
        }
    }
    
    getEnhancedStats() {
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
                ((this.stats.totalChecks - this.stats.errors) / this.stats.totalChecks * 100).toFixed(1) + '%' : 'N/A',
            realProfitabilityRate: this.stats.opportunitiesFound > 0 ?
                ((this.stats.profitableOpportunities / this.stats.opportunitiesFound) * 100).toFixed(1) + '%' : 'N/A',
            averageNetProfitMargin: this.stats.averageNetProfitMargin.toFixed(1) + '%'
        };
    }
    
    async saveStats() {
        try {
            await saveNotificationsCache(this.recentNotifications);
            
            const enhancedStats = {
                ...this.stats,
                timestamp: getCurrentTimestamp(),
                version: '2.1-enhanced-real-profit'
            };
            
            await fs.writeJson('./data/enhanced_real_profit_stats.json', enhancedStats, { spaces: 2 });
        } catch (error) {
            logger.logError('Failed to save enhanced stats', error);
        }
    }
    
    // Validation and loading methods (same as before)
    async validateConfiguration() {
        logger.logInfo('⚙️ Validating configuration for enhanced bot...');
        
        const requiredTokens = ['WMATIC', 'USDC', 'WETH'];
        for (const tokenSymbol of requiredTokens) {
            if (!config.tokens[tokenSymbol]) {
                throw new Error(`Missing required token: ${tokenSymbol}`);
            }
        }
        
        const requiredDEXes = ['sushiswap', 'quickswap'];
        for (const dexName of requiredDEXes) {
            if (!config.dexes[dexName]) {
                throw new Error(`Missing required DEX: ${dexName}`);
            }
        }
        
        logger.logSuccess('✅ Configuration validated for enhanced analysis');
    }
    
    async testConnections() {
        logger.logInfo('🔍 Testing connections...');
        
        const telegramStatus = telegramNotifier.getStatus();
        if (telegramStatus.configured) {
            logger.logSuccess('✅ Telegram connection working');
        } else {
            logger.logWarning('⚠️ Telegram not configured - notifications disabled');
        }
        
        try {
            const provider = this.getProvider();
            const [blockNumber, network] = await Promise.all([
                provider.getBlockNumber(),
                provider.getNetwork()
            ]);
            
            if (Number(network.chainId) !== 137) {
                throw new Error(`Wrong network: expected 137, got ${network.chainId}`);
            }
            
            logger.logSuccess(`✅ RPC working - Block: ${blockNumber}, Chain: ${network.chainId}`);
        } catch (error) {
            throw new Error(`RPC connection test failed: ${error.message}`);
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
    
    async handleCriticalError(error) {
        logger.logError('🚨 Critical error occurred in enhanced bot', error);
        
        try {
            await telegramNotifier.sendErrorAlert(error, 'Critical enhanced bot error - stopping');
        } catch (notificationError) {
            logger.logError('Failed to send critical error notification', notificationError);
        }
        
        await this.stop();
    }
}

module.exports = ArbitrageBot;