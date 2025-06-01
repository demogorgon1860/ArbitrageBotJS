const { ethers } = require('ethers');
const config = require('../config/polygon.json');
const logger = require('./logger');
const { formatTokenAmount, retryWithBackoff } = require('./utils');

class PriceFetcher {
    constructor(provider) {
        this.provider = provider;
        this.priceCache = new Map(); // Cache for USD prices
        this.cacheExpiry = 60000; // 1 minute cache
        this.initializeContracts();
    }
    
    initializeContracts() {
        // V2 Router ABI - only essential functions
        this.v2RouterABI = [
            "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
        ];
        
        // V3 Quoter ABI - only essential functions  
        this.v3QuoterABI = [
            "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)"
        ];
    }
    
    /**
     * Get cached USD price for token (internal method to avoid circular dependencies)
     */
    async getCachedTokenPriceUSD(tokenSymbol) {
        const cacheKey = `${tokenSymbol}_usd`;
        const cached = this.priceCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
            return cached.price;
        }
        
        try {
            // Try to get from utils if available, but don't fail if not
            let price;
            try {
                const { getTokenPriceUSD } = require('./utils');
                price = await getTokenPriceUSD(tokenSymbol);
            } catch (error) {
                // Fallback to internal price estimation
                price = this.getFallbackPrice(tokenSymbol);
            }
            
            this.priceCache.set(cacheKey, {
                price,
                timestamp: Date.now()
            });
            return price;
        } catch (error) {
            logger.logError(`Failed to get USD price for ${tokenSymbol}`, error);
            // Return cached price if available, even if expired
            return cached ? cached.price : this.getFallbackPrice(tokenSymbol);
        }
    }
    
    /**
     * Get fallback price if all else fails
     */
    getFallbackPrice(tokenSymbol) {
        const fallbackPrices = {
            'USDC': 1,
            'USDT': 1,
            'WETH': 2000,
            'WBTC': 35000,
            'WMATIC': 1,
            'LINK': 15,
            'AAVE': 80,
            'CRV': 0.5
        };
        return fallbackPrices[tokenSymbol] || 1;
    }
    
    /**
     * Get real on-chain price from specific DEX using getAmountsOut
     */
    async getTokenPrice(tokenSymbol, dexName, inputAmountUSD = 1000) {
        try {
            const token = config.tokens[tokenSymbol];
            const dex = config.dexes[dexName];
            
            if (!token || !dex) {
                throw new Error(`Missing configuration for ${tokenSymbol} on ${dexName}`);
            }
            
            const paths = config.tradingPaths[tokenSymbol] || [];
            if (paths.length === 0) {
                throw new Error(`No trading paths configured for ${tokenSymbol}`);
            }
            
            let bestPriceData = null;
            
            if (dex.type === 'v2') {
                bestPriceData = await this.getV2RealPrice(token, dex, paths, inputAmountUSD);
            } else if (dex.type === 'v3') {
                bestPriceData = await this.getV3RealPrice(token, dex, paths, inputAmountUSD);
            }
            
            if (!bestPriceData || bestPriceData.price <= 0) {
                return {
                    price: 0,
                    path: null,
                    method: null,
                    dex: dexName,
                    success: false,
                    error: 'No valid price found'
                };
            }
            
            // Add enhanced slippage estimation
            if (bestPriceData.router && bestPriceData.pathAddresses) {
                try {
                    const slippage = await this.calculateRealSlippage(
                        bestPriceData.router,
                        bestPriceData.pathAddresses,
                        bestPriceData.inputAmount
                    );
                    bestPriceData.estimatedSlippage = slippage;
                } catch (error) {
                    logger.logDebug('Failed to calculate slippage', error.message);
                    bestPriceData.estimatedSlippage = this.getDefaultSlippage(tokenSymbol, dexName);
                }
            }
            
            return {
                ...bestPriceData,
                dex: dexName,
                success: true
            };
            
        } catch (error) {
            logger.logError(`Failed to get real price for ${tokenSymbol} on ${dexName}`, error);
            return {
                price: 0,
                path: null,
                method: null,
                dex: dexName,
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Enhanced slippage calculation
     */
    async calculateRealSlippage(router, path, amountIn) {
        try {
            // Get amounts for different trade sizes to estimate slippage
            const baseAmount = ethers.BigNumber.from(amountIn);
            const largerAmount = baseAmount.mul(105).div(100); // 5% larger trade
            
            const [baseAmounts, largerAmounts] = await Promise.allSettled([
                router.getAmountsOut(baseAmount, path),
                router.getAmountsOut(largerAmount, path)
            ]);
            
            if (baseAmounts.status !== 'fulfilled' || largerAmounts.status !== 'fulfilled') {
                throw new Error('Failed to get amounts for slippage calculation');
            }
            
            const baseOutputAmount = baseAmounts.value[baseAmounts.value.length - 1];
            const largerOutputAmount = largerAmounts.value[largerAmounts.value.length - 1];
            
            // Calculate price impact
            const expectedLargerOutput = baseOutputAmount.mul(105).div(100);
            const actualSlippage = expectedLargerOutput.sub(largerOutputAmount);
            const slippagePercentage = actualSlippage.mul(10000).div(expectedLargerOutput);
            
            return Math.max(0.1, parseInt(slippagePercentage.toString()) / 100); // Minimum 0.1%
            
        } catch (error) {
            logger.logDebug('Slippage calculation failed, using default', error.message);
            return 0.3; // Default 0.3% slippage
        }
    }
    
    /**
     * Get default slippage for token/dex combination
     */
    getDefaultSlippage(tokenSymbol, dexName) {
        const tokenSlippage = {
            'USDC': 0.1,
            'USDT': 0.1,
            'WETH': 0.2,
            'WBTC': 0.25,
            'WMATIC': 0.15,
            'LINK': 0.3,
            'AAVE': 0.4,
            'CRV': 0.5
        };
        
        const dexMultiplier = {
            'uniswap': 0.9,
            'sushiswap': 1.0,
            'quickswap': 1.1
        };
        
        const baseSlippage = tokenSlippage[tokenSymbol] || 0.3;
        const multiplier = dexMultiplier[dexName] || 1.0;
        
        return baseSlippage * multiplier;
    }
    
    /**
     * Get real V2 price using router.getAmountsOut
     */
    async getV2RealPrice(token, dex, paths, inputAmountUSD) {
        try {
            const router = new ethers.Contract(dex.router, this.v2RouterABI, this.provider);
            
            let bestPrice = 0;
            let bestPath = null;
            let bestAmounts = null;
            let bestInputAmount = null;
            let bestPathAddresses = null;
            
            for (const path of paths) {
                try {
                    // Convert symbols to addresses
                    const tokenAddresses = this.pathToAddresses(path);
                    if (!tokenAddresses) continue;
                    
                    // Calculate real input amount in token units using oracle prices
                    const inputAmount = await this.calculateRealInputAmount(path[0], inputAmountUSD);
                    if (inputAmount === '0') continue;
                    
                    // Get real amounts from router with timeout
                    const amounts = await Promise.race([
                        router.getAmountsOut(inputAmount, tokenAddresses),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('RPC timeout')), config.settings.priceTimeoutMs)
                        )
                    ]);
                    
                    if (!amounts || amounts.length === 0) continue;
                    
                    // Calculate real price based on actual output
                    const outputAmount = amounts[amounts.length - 1];
                    const outputToken = config.tokens[path[path.length - 1]];
                    
                    // Convert to USD price using oracle
                    const outputValueUSD = await this.tokenAmountToUSD(outputAmount, outputToken, path[path.length - 1]);
                    const price = outputValueUSD / inputAmountUSD;
                    
                    if (price > bestPrice && price > 0) {
                        bestPrice = price;
                        bestPath = path;
                        bestAmounts = amounts;
                        bestInputAmount = inputAmount;
                        bestPathAddresses = tokenAddresses;
                    }
                    
                    logger.logDebug(`V2 price for ${path.join('->')} on ${dex.name}`, {
                        inputAmount: inputAmount.toString(),
                        outputAmount: outputAmount.toString(),
                        price: price.toFixed(6)
                    });
                    
                } catch (pathError) {
                    logger.logDebug(`V2 path ${path.join('->')} failed on ${dex.name}`, pathError.message);
                    continue;
                }
            }
            
            return bestPrice > 0 ? {
                price: bestPrice,
                path: bestPath,
                method: 'v2_getAmountsOut',
                rawAmounts: bestAmounts,
                inputAmount: bestInputAmount,
                pathAddresses: bestPathAddresses,
                router: router
            } : null;
            
        } catch (error) {
            logger.logError(`V2 price fetching failed for ${dex.name}`, error);
            return null;
        }
    }
    
    /**
     * Get real V3 price using quoter
     */
    async getV3RealPrice(token, dex, paths, inputAmountUSD) {
        try {
            const quoterAddress = dex.quoter;
            const quoter = new ethers.Contract(quoterAddress, this.v3QuoterABI, this.provider);
            
            let bestPrice = 0;
            let bestPath = null;
            let bestFee = null;
            let bestInputAmount = null;
            let bestPathAddresses = null;
            
            // Focus on direct pairs for V3 (more reliable)
            const directPaths = paths.filter(path => path.length === 2);
            
            for (const path of directPaths) {
                try {
                    const tokenIn = config.tokens[path[0]];
                    const tokenOut = config.tokens[path[1]];
                    
                    const inputAmount = await this.calculateRealInputAmount(path[0], inputAmountUSD);
                    if (inputAmount === '0') continue;
                    
                    // Try different fee tiers
                    const feeTiers = dex.fees || [500, 3000, 10000];
                    
                    for (const fee of feeTiers) {
                        try {
                            // Get real quote from V3 quoter
                            const amountOut = await Promise.race([
                                quoter.callStatic.quoteExactInputSingle(
                                    tokenIn.address,
                                    tokenOut.address,
                                    fee,
                                    inputAmount,
                                    0
                                ),
                                new Promise((_, reject) => 
                                    setTimeout(() => reject(new Error('V3 timeout')), config.settings.priceTimeoutMs)
                                )
                            ]);
                            
                            // Calculate real price using oracle
                            const outputValueUSD = await this.tokenAmountToUSD(amountOut, tokenOut, path[1]);
                            const price = outputValueUSD / inputAmountUSD;
                            
                            if (price > bestPrice && price > 0) {
                                bestPrice = price;
                                bestPath = path;
                                bestFee = fee;
                                bestInputAmount = inputAmount;
                                bestPathAddresses = [tokenIn.address, tokenOut.address];
                            }
                            
                            logger.logDebug(`V3 price for ${path.join('->')} fee ${fee} on ${dex.name}`, {
                                inputAmount: inputAmount.toString(),
                                outputAmount: amountOut.toString(),
                                price: price.toFixed(6)
                            });
                            
                            break; // If successful, don't try other fees
                            
                        } catch (feeError) {
                            continue; // Try next fee tier
                        }
                    }
                    
                } catch (pathError) {
                    logger.logDebug(`V3 path ${path.join('->')} failed on ${dex.name}`, pathError.message);
                    continue;
                }
            }
            
            return bestPrice > 0 ? {
                price: bestPrice,
                path: bestPath,
                method: 'v3_quoter',
                fee: bestFee,
                inputAmount: bestInputAmount,
                pathAddresses: bestPathAddresses
            } : null;
            
        } catch (error) {
            logger.logError(`V3 price fetching failed for ${dex.name}`, error);
            return null;
        }
    }
    
    /**
     * Convert path symbols to contract addresses
     */
    pathToAddresses(path) {
        try {
            return path.map(symbol => {
                const token = config.tokens[symbol];
                if (!token || !token.address) {
                    throw new Error(`Token ${symbol} not found or missing address`);
                }
                return token.address;
            });
        } catch (error) {
            logger.logError(`Failed to convert path to addresses: ${path.join('→')}`, error);
            return null;
        }
    }
    
    /**
     * Calculate real input amount in token units with fallback
     */
    async calculateRealInputAmount(tokenSymbol, inputAmountUSD) {
        try {
            const token = config.tokens[tokenSymbol];
            if (!token) {
                throw new Error(`Token ${tokenSymbol} not found`);
            }
            
            let tokenAmount;
            
            // For stablecoins, use direct USD conversion
            if (['USDC', 'USDT'].includes(tokenSymbol)) {
                tokenAmount = inputAmountUSD;
            } else {
                // Try to get real USD price, fallback to static amounts
                try {
                    const tokenPriceUSD = await this.getCachedTokenPriceUSD(tokenSymbol);
                    tokenAmount = inputAmountUSD / tokenPriceUSD;
                } catch (error) {
                    logger.logDebug(`Failed to get USD price for ${tokenSymbol}, using static amount`);
                    // Fallback to static amounts as originally designed
                    const inputAmounts = {
                        'WETH': 0.5,    // 0.5 ETH ≈ $1000-2000
                        'WBTC': 0.03,   // 0.03 BTC ≈ $1000-2000  
                        'WMATIC': 1000, // 1000 MATIC ≈ $1000
                        'LINK': 70,     // 70 LINK ≈ $1000
                        'AAVE': 12,     // 12 AAVE ≈ $1000
                        'CRV': 2000     // 2000 CRV ≈ $1000
                    };
                    tokenAmount = inputAmounts[tokenSymbol] || 1;
                }
            }
            
            // Convert to wei/token units
            const tokenAmountWei = ethers.parseUnits(
                tokenAmount.toString(), 
                token.decimals
            );
            
            return tokenAmountWei.toString();
            
        } catch (error) {
            logger.logError(`Failed to calculate input amount for ${tokenSymbol}`, error);
            return '0';
        }
    }
    
    /**
     * Convert token amount to USD using oracle prices with fallback
     */
    async tokenAmountToUSD(tokenAmount, tokenConfig, tokenSymbol) {
        try {
            // Convert from wei to token units
            const tokenValue = parseFloat(formatTokenAmount(tokenAmount, tokenConfig.decimals));
            
            // Try to get real USD price, fallback to static
            try {
                const usdPrice = await this.getCachedTokenPriceUSD(tokenSymbol);
                return tokenValue * usdPrice;
            } catch (error) {
                logger.logDebug(`Failed to get USD price for ${tokenSymbol}, using fallback`);
                // Fallback to static prices
                const tokenValue = parseFloat(formatTokenAmount(tokenAmount, tokenConfig.decimals));
                const fallbackPrice = this.getFallbackPrice(tokenSymbol);
                return tokenValue * fallbackPrice;
            }
            
        } catch (error) {
            logger.logError(`Failed to convert token amount to USD for ${tokenSymbol}`, error);
            
            // Emergency fallback
            const tokenValue = parseFloat(formatTokenAmount(tokenAmount, tokenConfig.decimals));
            const fallbackPrice = this.getFallbackPrice(tokenSymbol);
            return tokenValue * fallbackPrice;
        }
    }
    
    /**
     * Get multiple real prices concurrently
     */
    async getMultiplePrices(tokenSymbol, dexNames, inputAmountUSD) {
        const pricePromises = dexNames.map(dexName =>
            retryWithBackoff(
                () => this.getTokenPrice(tokenSymbol, dexName, inputAmountUSD),
                config.settings.maxRetries,
                config.settings.retryDelayMs
            ).catch(error => ({
                price: 0,
                path: null,
                method: null,
                dex: dexName,
                success: false,
                error: error.message
            }))
        );
        
        try {
            // Limit concurrent requests to avoid overwhelming RPCs
            const batchSize = config.settings.maxConcurrentRequests || 3;
            const results = [];
            
            for (let i = 0; i < pricePromises.length; i += batchSize) {
                const batch = pricePromises.slice(i, i + batchSize);
                const batchResults = await Promise.allSettled(batch);
                
                batchResults.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        results.push(result.value);
                    } else {
                        results.push({
                            price: 0,
                            path: null,
                            method: null,
                            dex: dexNames[i + index],
                            success: false,
                            error: result.reason?.message || 'Unknown error'
                        });
                    }
                });
                
                // Small delay between batches
                if (i + batchSize < pricePromises.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
            return results;
            
        } catch (error) {
            logger.logError('Failed to get multiple prices', error);
            return dexNames.map(dexName => ({
                price: 0,
                path: null,
                method: null,
                dex: dexName,
                success: false,
                error: error.message
            }));
        }
    }
    
    /**
     * Update provider for failover
     */
    updateProvider(newProvider) {
        this.provider = newProvider;
        logger.logInfo('PriceFetcher provider updated');
    }
    
    /**
     * Clear price cache
     */
    clearCache() {
        this.priceCache.clear();
        logger.logInfo('Price cache cleared');
    }
    
    /**
     * Get cache statistics
     */
    getCacheStats() {
        const now = Date.now();
        let validEntries = 0;
        let expiredEntries = 0;
        
        for (const [key, value] of this.priceCache.entries()) {
            if (now - value.timestamp < this.cacheExpiry) {
                validEntries++;
            } else {
                expiredEntries++;
            }
        }
        
        return {
            totalEntries: this.priceCache.size,
            validEntries,
            expiredEntries,
            cacheHitRate: validEntries / Math.max(1, this.priceCache.size)
        };
    }
    
    /**
     * Clean expired cache entries
     */
    cleanExpiredCache() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [key, value] of this.priceCache.entries()) {
            if (now - value.timestamp >= this.cacheExpiry) {
                this.priceCache.delete(key);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            logger.logDebug(`Cleaned ${cleaned} expired cache entries`);
        }
        
        return cleaned;
    }
    
    /**
     * Get performance metrics
     */
    getPerformanceMetrics() {
        const cacheStats = this.getCacheStats();
        
        return {
            cacheStats,
            provider: this.provider ? 'Connected' : 'Disconnected',
            lastUpdate: new Date().toISOString()
        };
    }
}

module.exports = PriceFetcher;