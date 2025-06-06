/**
 * Arbitrage Engine - Core logic with all fixes implemented
 */

const { ethers } = require('ethers');
const EventEmitter = require('events');
const pLimit = require('p-limit');


const config = require('../config/polygon.json');
const logger = require('./logger');
const PriceFetcher = require('./priceFetcher');
const GasCalculator = require('./gasCalculator');
const SlippageCalculator = require('./slippageCalculator');
const OpportunityAnalyzer = require('./opportunityAnalyzer');
const telegramNotifier = require('./telegram');
const { sleep, validateNumeric } = require('./utils');

class ArbitrageBot extends EventEmitter {
    constructor() {
        super();
        
        this.providers = [];
        this.currentProviderIndex = 0;
        this.isRunning = false;
        this.isInitialized = false;
        this.limit = pLimit(4);
        // Core components
        this.priceFetcher = null;
        this.gasCalculator = null;
        this.slippageCalculator = null;
        this.opportunityAnalyzer = null;
        
        // Processing queue
        this.processQueue = new PQueue({ 
            concurrency: 2,
            interval: 1000,
            intervalCap: 5
        });
        
        // Statistics
        this.stats = {
            startTime: Date.now(),
            totalScans: 0,
            opportunitiesFound: 0,
            profitableOpportunities: 0,
            totalNetProfit: 0,
            bestOpportunity: null,
            errors: 0,
            lastScan: null
        };
        
        // Configuration
        this.scanInterval = parseInt(process.env.CHECK_INTERVAL_MS) || 30000;
        this.minNetProfit = parseFloat(process.env.MIN_NET_PROFIT_USD) || 0.20;
    }
    
    async initialize() {
        try {
            logger.logInfo('Initializing Arbitrage Engine...');
            
            // Setup providers with validation
            await this.setupProviders();
            
            if (this.providers.length === 0) {
                throw new Error('No working RPC providers available');
            }
            
            // Initialize components
            const provider = this.getProvider();
            
            this.priceFetcher = new PriceFetcher(provider);
            await this.priceFetcher.initialize();
            
            this.gasCalculator = new GasCalculator(provider);
            await this.gasCalculator.initialize();
            
            this.slippageCalculator = new SlippageCalculator(provider);
            this.opportunityAnalyzer = new OpportunityAnalyzer(this.minNetProfit);
            
            this.isInitialized = true;
            logger.logSuccess('✅ Arbitrage Engine initialized');
            
        } catch (error) {
            logger.logError('Failed to initialize engine', error);
            throw error;
        }
    }
    
    async setupProviders() {
        const endpoints = this.collectRPCEndpoints();
        
        if (endpoints.length === 0) {
            throw new Error('No RPC endpoints configured');
        }
        
        // Test and create providers
        const providerPromises = endpoints.map(async (endpoint) => {
            try {
                const provider = new ethers.JsonRpcProvider(endpoint, 137, {
                    staticNetwork: true,
                    batchMaxCount: 1
                });
                
                // Test connection
                const [blockNumber, network] = await Promise.all([
                    provider.getBlockNumber(),
                    provider.getNetwork()
                ]);
                
                if (Number(network.chainId) !== 137) {
                    throw new Error(`Wrong network: ${network.chainId}`);
                }
                
                logger.logInfo(`✅ Connected to RPC (block: ${blockNumber})`);
                return provider;
                
            } catch (error) {
                logger.logWarning(`Failed to connect to RPC: ${error.message}`);
                return null;
            }
        });
        
        const results = await Promise.all(providerPromises);
        this.providers = results.filter(p => p !== null);
    }
    
    collectRPCEndpoints() {
        const endpoints = [];
        
        // API-based endpoints
        if (process.env.ALCHEMY_API_KEY) {
            endpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY) {
            endpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        // Custom endpoints
        for (let i = 1; i <= 5; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc.startsWith('http')) {
                endpoints.push(rpc);
            }
        }
        
        // Public endpoints (fallback)
        endpoints.push(
            'https://polygon-rpc.com',
            'https://rpc.ankr.com/polygon'
        );
        
        return [...new Set(endpoints)]; // Remove duplicates
    }
    
    getProvider() {
        if (this.providers.length === 0) {
            throw new Error('No providers available');
        }
        
        return this.providers[this.currentProviderIndex % this.providers.length];
    }
    
    async rotateProvider() {
        if (this.providers.length <= 1) {
            return false;
        }
        
        this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
        const newProvider = this.getProvider();
        
        // Update components
        if (this.priceFetcher) {
            this.priceFetcher.updateProvider(newProvider);
        }
        
        if (this.gasCalculator) {
            this.gasCalculator.updateProvider(newProvider);
        }
        
        if (this.slippageCalculator) {
            this.slippageCalculator.updateProvider(newProvider);
        }
        
        logger.logInfo(`Rotated to provider ${this.currentProviderIndex + 1}/${this.providers.length}`);
        return true;
    }
    
    async start() {
        if (this.isRunning) {
            logger.logWarning('Engine already running');
            return;
        }
        
        if (!this.isInitialized) {
            throw new Error('Engine not initialized');
        }
        
        this.isRunning = true;
        logger.logInfo('🚀 Starting arbitrage monitoring...');
        
        // Start scanning loop
        this.scanLoop().catch(error => {
            logger.logError('Scan loop crashed', error);
            this.handleCriticalError(error);
        });
    }
    
    async scanLoop() {
        while (this.isRunning) {
            try {
                const scanStart = Date.now();
                
                // Update gas prices before scan
                await this.gasCalculator.updateGasPrice();
                
                // Scan for opportunities
                const opportunities = await this.scanForOpportunities();
                
                // Analyze and filter
                const profitable = await this.analyzeOpportunities(opportunities);
                
                // Process profitable opportunities
                if (profitable.length > 0) {
                    await this.processProfitableOpportunities(profitable);
                }
                
                // Update statistics
                this.updateStats(opportunities, profitable);
                
                const scanDuration = Date.now() - scanStart;
                logger.logInfo(`Scan completed in ${scanDuration}ms - Found ${profitable.length} profitable opportunities`);
                
                // Wait for next scan
                await sleep(this.scanInterval);
                
            } catch (error) {
                logger.logError('Error in scan loop', error);
                this.stats.errors++;
                
                // Try to recover
                if (error.message.includes('provider') || error.message.includes('network')) {
                    await this.rotateProvider();
                }
                
                await sleep(5000); // Brief pause before retry
            }
        }
    }
    
async scanForOpportunities() {
const scanPromises = tradingPairs.map(([baseToken, quoteToken]) =>
    this.limit(async () => {
        try {
            const pairOpportunities = await this.scanPair(baseToken, quoteToken);
            return pairOpportunities;
        } catch (error) {
            logger.logError(`Failed to scan pair ${baseToken}/${quoteToken}`, error);
            return [];
        }
    })
);

    const results = await Promise.all(scanPromises);
    results.forEach(pairOps => opportunities.push(...pairOps));
    
    return opportunities;
}

    
    async scanToken(tokenSymbol) {
        const opportunities = [];
        const token = config.tokens[tokenSymbol];
        
        if (!token) {
            return opportunities;
        }
        
        // Get prices from all DEXes
        const dexNames = Object.keys(config.dexes);
        const pricePromises = dexNames.map(dex => 
            this.priceFetcher.getTokenPrice(tokenSymbol, dex).catch(error => ({
                success: false,
                dex,
                error: error.message
            }))
        );
        
        const prices = await Promise.all(pricePromises);
        
        // Find valid prices
        const validPrices = prices.filter(p => 
            p.success && 
            p.price > 0 && 
            p.liquidity > 100
        );
        
        if (validPrices.length < 2) {
            return opportunities;
        }
        
        // Check all price pairs for arbitrage
        for (let i = 0; i < validPrices.length; i++) {
            for (let j = i + 1; j < validPrices.length; j++) {
                const buyPrice = validPrices[i].price < validPrices[j].price ? validPrices[i] : validPrices[j];
                const sellPrice = validPrices[i].price > validPrices[j].price ? validPrices[i] : validPrices[j];
                
                // Calculate spread
                const spread = ((sellPrice.price - buyPrice.price) / buyPrice.price) * 100;
                
                if (spread > 0.1) { // At least 0.1% spread
                    opportunities.push({
                        token: tokenSymbol,
                        buyDex: buyPrice.dex,
                        sellDex: sellPrice.dex,
                        buyPrice: buyPrice.price,
                        sellPrice: sellPrice.price,
                        spread: spread,
                        buyLiquidity: buyPrice.liquidity,
                        sellLiquidity: sellPrice.liquidity,
                        buyPool: buyPrice.poolInfo,
                        sellPool: sellPrice.poolInfo,
                        timestamp: Date.now()
                    });
                }
            }
        }
        
        return opportunities;
    }
    
    async analyzeOpportunities(opportunities) {
        const profitable = [];
        
        for (const opportunity of opportunities) {
            try {
                // Calculate real costs
                const analysis = await this.calculateRealProfit(opportunity);
                
                if (analysis.netProfit > this.minNetProfit) {
                    profitable.push({
                        ...opportunity,
                        analysis
                    });
                }
                
            } catch (error) {
                logger.logError('Failed to analyze opportunity', error);
            }
        }
        
        // Sort by net profit
        profitable.sort((a, b) => b.analysis.netProfit - a.analysis.netProfit);
        
        return profitable;
    }
    
    async calculateRealProfit(opportunity) {
        const inputAmount = parseFloat(process.env.INPUT_AMOUNT_USD) || 1000;
        
        // Calculate gross profit
        const grossProfit = inputAmount * (opportunity.spread / 100);
        
        // Get real-time gas cost
        const gasCost = await this.gasCalculator.calculateTotalGasCost(
            opportunity.token,
            opportunity.buyDex,
            opportunity.sellDex
        );
        
        // Calculate swap fees
        const swapFees = this.calculateSwapFees(
            inputAmount,
            opportunity.buyPool,
            opportunity.sellPool
        );
        
        // Calculate slippage
        const slippage = await this.slippageCalculator.calculateTotalSlippage(
            inputAmount,
            opportunity.buyLiquidity,
            opportunity.sellLiquidity,
            opportunity.buyPool,
            opportunity.sellPool
        );
        
        // Calculate net profit
        const totalCosts = gasCost + swapFees + slippage;
        const netProfit = grossProfit - totalCosts;
        
        return {
            inputAmount,
            grossProfit,
            gasCost,
            swapFees,
            slippage,
            totalCosts,
            netProfit,
            roi: (netProfit / inputAmount) * 100
        };
    }
    
    calculateSwapFees(inputAmount, buyPool, sellPool) {
        let totalFees = 0;
        
        // Buy side fees
        if (buyPool?.feeTier) {
            // V3 pool
            totalFees += inputAmount * (buyPool.feeTier / 1000000);
        } else {
            // V2 pool - 0.3%
            totalFees += inputAmount * 0.003;
        }
        
        // Sell side fees
        if (sellPool?.feeTier) {
            totalFees += inputAmount * (sellPool.feeTier / 1000000);
        } else {
            totalFees += inputAmount * 0.003;
        }
        
        return totalFees;
    }
    
    async processProfitableOpportunities(opportunities) {
        // Process top opportunities
        const topOpportunities = opportunities.slice(0, 3);
        
        for (const opportunity of topOpportunities) {
            try {
                // Log opportunity
                this.logOpportunity(opportunity);
                
                // Send notification
                await telegramNotifier.sendArbitrageAlert(opportunity);
                
                // Update best opportunity
                if (!this.stats.bestOpportunity || 
                    opportunity.analysis.netProfit > this.stats.bestOpportunity.analysis.netProfit) {
                    this.stats.bestOpportunity = opportunity;
                }
                
            } catch (error) {
                logger.logError('Failed to process opportunity', error);
            }
        }
    }
    
    logOpportunity(opportunity) {
        const { token, buyDex, sellDex, spread, analysis } = opportunity;
        
        logger.logSuccess(`
💎 ARBITRAGE OPPORTUNITY FOUND!
Token: ${token}
Route: ${buyDex} → ${sellDex}
Spread: ${spread.toFixed(2)}%
Input: $${analysis.inputAmount}
Gross Profit: $${analysis.grossProfit.toFixed(2)}
Gas Cost: $${analysis.gasCost.toFixed(2)}
Swap Fees: $${analysis.swapFees.toFixed(2)}
Slippage: $${analysis.slippage.toFixed(2)}
NET PROFIT: $${analysis.netProfit.toFixed(2)} (${analysis.roi.toFixed(2)}% ROI)
        `);
    }
    
    updateStats(opportunities, profitable) {
        this.stats.totalScans++;
        this.stats.opportunitiesFound += opportunities.length;
        this.stats.profitableOpportunities += profitable.length;
        this.stats.lastScan = Date.now();
        
        // Calculate total net profit
        const scanNetProfit = profitable.reduce((sum, opp) => sum + opp.analysis.netProfit, 0);
        this.stats.totalNetProfit += scanNetProfit;
    }
    
    async stop() {
        if (!this.isRunning) {
            return;
        }
        
        logger.logInfo('Stopping Arbitrage Engine...');
        this.isRunning = false;
        
        // Clear queue
        this.processQueue.clear();
        await this.processQueue.onIdle();
        
        // Cleanup components
        if (this.priceFetcher) {
            await this.priceFetcher.cleanup();
        }
        
        if (this.gasCalculator) {
            await this.gasCalculator.cleanup();
        }
        
        logger.logSuccess('✅ Engine stopped');
    }
    
    getStats() {
        const runtime = Date.now() - this.stats.startTime;
        const hours = runtime / 3600000;
        
        return {
            ...this.stats,
            runtime: Math.floor(runtime / 1000),
            scansPerHour: hours > 0 ? (this.stats.totalScans / hours).toFixed(1) : 0,
            profitPerHour: hours > 0 ? (this.stats.totalNetProfit / hours).toFixed(2) : 0,
            successRate: this.stats.opportunitiesFound > 0 
                ? ((this.stats.profitableOpportunities / this.stats.opportunitiesFound) * 100).toFixed(1)
                : 0
        };
    }
    
    async handleCriticalError(error) {
        logger.logError('Critical error in engine', error);
        
        try {
            await telegramNotifier.sendErrorAlert(error, 'Critical engine error');
        } catch (notifyError) {
            logger.logError('Failed to send error notification', notifyError);
        }
        
        // Attempt restart
        this.isRunning = false;
        setTimeout(() => {
            this.start().catch(err => {
                logger.logError('Failed to restart after critical error', err);
            });
        }, 30000);
    }
}

module.exports = ArbitrageBot;