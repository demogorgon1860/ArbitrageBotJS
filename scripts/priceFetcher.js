const { ethers } = require('ethers');
const config = require('../config/polygon.json');
const logger = require('./logger');
const { formatTokenAmount, retryWithBackoff } = require('./utils');

class PriceFetcher {
    constructor(provider) {
        this.provider = provider;
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
     * Get real V2 price using router.getAmountsOut
     */
    async getV2RealPrice(token, dex, paths, inputAmountUSD) {
        try {
            const router = new ethers.Contract(dex.router, this.v2RouterABI, this.provider);
            
            let bestPrice = 0;
            let bestPath = null;
            let bestAmounts = null;
            
            for (const path of paths) {
                try {
                    // Convert symbols to addresses
                    const tokenAddresses = this.pathToAddresses(path);
                    if (!tokenAddresses) continue;
                    
                    // Calculate real input amount in token units
                    const inputAmount = this.calculateRealInputAmount(path[0], inputAmountUSD);
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
                    
                    // Convert to USD price
                    const outputValueUSD = this.tokenAmountToUSD(outputAmount, outputToken, path[path.length - 1]);
                    const price = outputValueUSD / inputAmountUSD;
                    
                    if (price > bestPrice && price > 0) {
                        bestPrice = price;
                        bestPath = path;
                        bestAmounts = amounts;
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
                rawAmounts: bestAmounts
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
            
            // Focus on direct pairs for V3 (more reliable)
            const directPaths = paths.filter(path => path.length === 2);
            
            for (const path of directPaths) {
                try {
                    const tokenIn = config.tokens[path[0]];
                    const tokenOut = config.tokens[path[1]];
                    
                    const inputAmount = this.calculateRealInputAmount(path[0], inputAmountUSD);
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
                            
                            // Calculate real price
                            const outputValueUSD = this.tokenAmountToUSD(amountOut, tokenOut, path[1]);
                            const price = outputValueUSD / inputAmountUSD;
                            
                            if (price > bestPrice && price > 0) {
                                bestPrice = price;
                                bestPath = path;
                                bestFee = fee;
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
                fee: bestFee
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
     * Calculate real input amount in token units (not simulated)
     */
    calculateRealInputAmount(tokenSymbol, inputAmountUSD) {
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
                // For other tokens, use a reasonable amount that provides good liquidity sampling
                // These amounts are chosen to be large enough to get meaningful quotes
                // but not so large as to cause excessive slippage
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
            
            // Convert to wei/token units
            const tokenAmountWei = ethers.utils.parseUnits(
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
     * Convert token amount to USD (simplified but reasonable conversion)
     */
    tokenAmountToUSD(tokenAmount, tokenConfig, tokenSymbol) {
        try {
            // Convert from wei to token units
            const tokenValue = parseFloat(formatTokenAmount(tokenAmount, tokenConfig.decimals));
            
            // Simple USD conversion based on reasonable market prices
            // In production, you might want to use a price oracle here
            const usdPrices = {
                'USDC': 1,
                'USDT': 1,
                'WETH': 2000,   // Approximate ETH price
                'WBTC': 35000,  // Approximate BTC price
                'WMATIC': 1,    // Approximate MATIC price
                'LINK': 15,     // Approximate LINK price
                'AAVE': 80,     // Approximate AAVE price
                'CRV': 0.5      // Approximate CRV price
            };
            
            const usdPrice = usdPrices[tokenSymbol] || 1;
            return tokenValue * usdPrice;
            
        } catch (error) {
            logger.logError(`Failed to convert token amount to USD for ${tokenSymbol}`, error);
            return 0;
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
}

module.exports = PriceFetcher;