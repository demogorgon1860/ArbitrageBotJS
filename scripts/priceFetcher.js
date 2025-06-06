/**
 * Price Fetcher - Complete implementation with V3 support
 */

const { ethers } = require('ethers');
const NodeCache = require('node-cache');
const logger = require('./logger');
const config = require('../config/polygon.json');
const CHAINLINK_FEEDS = {
    'WETH': '0xF9680D99D6C9589e2a93a78A04A279e509205945',    // ETH/USD
    'WBTC': '0xDE31F8bFBD8c84b5360CFACCa3539B938dd78ae6',    // BTC/USD
    'WMATIC': '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',  // MATIC/USD
    'LINK': '0xd9FFdb71EbE7496cC440152d43986Aae0AB76665',    // LINK/USD
    'AAVE': '0x72484B12719E23115761D5DA1646945632979bB6',    // AAVE/USD
    'CRV': '0x336584C8E6Dc19637A5b36206B1c79923111b405',     // CRV/USD
    'USDC': null,  // Stablecoin - return 1.0
    'USDT': null   // Stablecoin - return 1.0
};

// CoinGecko token IDs
const COINGECKO_IDS = {
    'WETH': 'ethereum',
    'WBTC': 'wrapped-bitcoin',
    'WMATIC': 'matic-network',
    'LINK': 'chainlink',
    'AAVE': 'aave',
    'CRV': 'curve-dao-token',
    'USDC': 'usd-coin',
    'USDT': 'tether'
};

// Add this ABI constant (Chainlink AggregatorV3Interface)
const CHAINLINK_AGGREGATOR_ABI = [
    'function decimals() view returns (uint8)',
    'function description() view returns (string)',
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
];

class PriceFetcher {
    constructor(provider) {
        this.provider = provider;
        this.cache = new NodeCache({ 
            stdTTL: 30,
            checkperiod: 60,
            deleteOnExpire: true
        });
        
        // Contract ABIs
        this.abis = {
            v2Router: [
                'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
                'function factory() view returns (address)'
            ],
            v2Factory: [
                'function getPair(address tokenA, address tokenB) view returns (address)'
            ],
            v2Pair: [
                'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)',
                'function token0() view returns (address)',
                'function token1() view returns (address)'
            ],
            v3Factory: [
                'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'
            ],
            v3Pool: [
                'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
                'function liquidity() view returns (uint128)',
                'function token0() view returns (address)',
                'function token1() view returns (address)',
                'function fee() view returns (uint24)'
            ],
            v3Quoter: [
                'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)'
            ]
        };
        
        // V3 fee tiers
        this.v3FeeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%
        
        // Token prices cache for USD conversion
        this.tokenPrices = new Map();
    }
    
    async initialize() {
        logger.logInfo('Initializing PriceFetcher...');
        
        // Pre-fetch stable token prices
        await this.updateTokenPrices();
        
        logger.logSuccess('PriceFetcher initialized');
    }
    
    updateProvider(newProvider) {
        this.provider = newProvider;
        logger.logInfo('PriceFetcher provider updated');
    }

async getTokenPriceUSD(symbol) {
    try {
        // Check cache first (using existing this.tokenPrices Map)
        const cacheKey = `${symbol}_USD`;
        const cached = this.tokenPrices.get(cacheKey);
        
        // Cache valid for 60 seconds
        if (cached && (Date.now() - cached.timestamp < 60000)) {
            logger.logDebug(`Price from cache: ${symbol} = $${cached.price}`);
            return cached.price;
        }
        
        // Handle stablecoins
        if (symbol === 'USDC' || symbol === 'USDT') {
            const price = 1.0;
            this.tokenPrices.set(cacheKey, {
                price,
                timestamp: Date.now(),
                source: 'stablecoin'
            });
            return price;
        }
        
        let price = null;
        let source = null;
        
        // Try Chainlink first
        try {
            price = await this.getChainlinkPrice(symbol);
            source = 'chainlink';
            logger.logDebug(`Chainlink price: ${symbol} = $${price}`);
        } catch (chainlinkError) {
            logger.logWarning(`Chainlink failed for ${symbol}: ${chainlinkError.message}`);
            
            // Fallback to CoinGecko
            try {
                price = await this.getCoinGeckoPrice(symbol);
                source = 'coingecko';
                logger.logDebug(`CoinGecko price: ${symbol} = $${price}`);
            } catch (geckoError) {
                logger.logError(`CoinGecko also failed for ${symbol}`, geckoError);
                throw new Error(`Failed to get price for ${symbol} from all sources`);
            }
        }
        
        // Validate price
        if (!price || price <= 0 || !isFinite(price)) {
            throw new Error(`Invalid price received for ${symbol}: ${price}`);
        }
        
        // Cache the successful result
        this.tokenPrices.set(cacheKey, {
            price,
            timestamp: Date.now(),
            source
        });
        
        return price;
        
    } catch (error) {
        logger.logError(`Failed to get USD price for ${symbol}`, error);
        
        // Last resort fallback prices
        const fallbackPrices = {
            'WETH': 2400,
            'WBTC': 68000,
            'WMATIC': 0.90,
            'LINK': 15,
            'AAVE': 100,
            'CRV': 0.5
        };
        
        if (fallbackPrices[symbol]) {
            logger.logWarning(`Using hardcoded fallback price for ${symbol}: $${fallbackPrices[symbol]}`);
            return fallbackPrices[symbol];
        }
        
        throw error;
    }
}

// Add these helper methods to your PriceFetcher class:

async getChainlinkPrice(symbol) {
    const feedAddress = CHAINLINK_FEEDS[symbol];
    
    if (!feedAddress) {
        throw new Error(`No Chainlink feed address for ${symbol}`);
    }
    
    try {
        // Create contract instance
        const priceFeed = new ethers.Contract(
            feedAddress,
            CHAINLINK_AGGREGATOR_ABI,
            this.provider
        );
        
        // Get latest price data
        const [roundId, answer, startedAt, updatedAt, answeredInRound] = 
            await priceFeed.latestRoundData();
        
        // Check if price is stale (more than 1 hour old)
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime - Number(updatedAt) > 3600) {
            throw new Error(`Chainlink price is stale (last update: ${new Date(Number(updatedAt) * 1000).toISOString()})`);
        }
        
        // Get decimals
        const decimals = await priceFeed.decimals();
        
        // Convert price to number
        const price = parseFloat(ethers.formatUnits(answer, decimals));
        
        if (price <= 0) {
            throw new Error(`Invalid Chainlink price: ${price}`);
        }
        
        return price;
        
    } catch (error) {
        throw new Error(`Chainlink query failed: ${error.message}`);
    }
}

async getCoinGeckoPrice(symbol) {
    const tokenId = COINGECKO_IDS[symbol];
    
    if (!tokenId) {
        throw new Error(`No CoinGecko ID for ${symbol}`);
    }
    
    try {
        // CoinGecko API endpoint
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenId}&vs_currencies=usd`;
        
        // Fetch with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json'
            }
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        
        // Extract price
        const price = data[tokenId]?.usd;
        
        if (!price || price <= 0) {
            throw new Error(`Invalid CoinGecko price: ${price}`);
        }
        
        return price;
        
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('CoinGecko request timeout');
        }
        throw error;
    }
}

// Optional: Add method to refresh all token prices
async updateTokenPrices() {
    logger.logInfo('Updating all token prices...');
    
    const tokens = Object.keys(CHAINLINK_FEEDS);
    const results = await Promise.allSettled(
        tokens.map(symbol => this.getTokenPriceUSD(symbol))
    );
    
    let successCount = 0;
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            successCount++;
            logger.logDebug(`${tokens[index]}: $${result.value}`);
        } else {
            logger.logWarning(`Failed to update ${tokens[index]}: ${result.reason.message}`);
        }
    });
    
    logger.logInfo(`Updated ${successCount}/${tokens.length} token prices`);
}

// Optional: Add method to get price source info
getPriceSourceInfo(symbol) {
    const cacheKey = `${symbol}_USD`;
    const cached = this.tokenPrices.get(cacheKey);
    
    if (!cached) {
        return { cached: false };
    }
    
    return {
        cached: true,
        price: cached.price,
        source: cached.source,
        age: Date.now() - cached.timestamp,
        timestamp: new Date(cached.timestamp).toISOString()
    };
}
    async getTokenPrice(tokenSymbol, dexName) {
        const cacheKey = `${tokenSymbol}_${dexName}`;
        const cached = this.cache.get(cacheKey);
        
        if (cached) {
            return cached;
        }
        
        try {
            const token = config.tokens[tokenSymbol];
            if (!token) {
                throw new Error(`Unknown token: ${tokenSymbol}`);
            }
            
            const dex = config.dexes[dexName];
            if (!dex) {
                throw new Error(`Unknown DEX: ${dexName}`);
            }
            
            let result;
            
            if (dex.type === 'v3') {
                result = await this.getV3Price(token, dex);
            } else {
                result = await this.getV2Price(token, dex);
            }
            
            // Cache successful result
            if (result.success) {
                this.cache.set(cacheKey, result);
            }
            
            return result;
            
        } catch (error) {
            logger.logError(`Price fetch failed for ${tokenSymbol} on ${dexName}`, error);
            return {
                success: false,
                error: error.message,
                dex: dexName
            };
        }
    }
    
    async getV2Price(token, dex) {
        try {
            const router = new ethers.Contract(dex.router, this.abis.v2Router, this.provider);
            const factory = new ethers.Contract(dex.factory, this.abis.v2Factory, this.provider);
            
            // Try multiple quote tokens
            const quoteTokens = ['USDC', 'USDT', 'WETH', 'WMATIC'];
            
            for (const quoteSymbol of quoteTokens) {
                if (quoteSymbol === token.symbol) continue;
                
                const quoteToken = config.tokens[quoteSymbol];
                if (!quoteToken) continue;
                
                try {
                    // Check if pair exists
                    const pairAddress = await factory.getPair(token.address, quoteToken.address);
                    if (pairAddress === ethers.ZeroAddress) continue;
                    
                    // Get price quote
                    const amountIn = ethers.parseUnits('1', token.decimals);
                    const amounts = await router.getAmountsOut(amountIn, [token.address, quoteToken.address]);
                    
                    const amountOut = amounts[1];
                    const price = await this.convertToUSD(amountOut, quoteToken);
                    
                    // Get liquidity
                    const liquidity = await this.getV2Liquidity(pairAddress, token, quoteToken);
                    
                    return {
                        success: true,
                        price,
                        liquidity,
                        dex: dex.name,
                        poolInfo: {
                            type: 'v2',
                            pair: pairAddress,
                            quoteToken: quoteSymbol
                        }
                    };
                    
                } catch (error) {
                    continue;
                }
            }
            
            throw new Error('No valid V2 pairs found');
            
        } catch (error) {
            throw new Error(`V2 price fetch failed: ${error.message}`);
        }
    }
    
    async getV3Price(token, dex) {
        try {
            const factory = new ethers.Contract(dex.factory, this.abis.v3Factory, this.provider);
            const quoter = new ethers.Contract(dex.quoter, this.abis.v3Quoter, this.provider);
            
            // Try multiple quote tokens
            // Try multiple quote tokens
            const quoteTokens = ['USDC', 'USDT', 'WETH', 'WMATIC'];
            
            for (const quoteSymbol of quoteTokens) {
                if (quoteSymbol === token.symbol) continue;
                
                const quoteToken = config.tokens[quoteSymbol];
                if (!quoteToken) continue;
                
                // Try all fee tiers
                for (const feeTier of this.v3FeeTiers) {
                    try {
                        // Check if pool exists
                        const poolAddress = await factory.getPool(token.address, quoteToken.address, feeTier);
                        if (poolAddress === ethers.ZeroAddress) continue;
                        
                        // Get pool info
                        const pool = new ethers.Contract(poolAddress, this.abis.v3Pool, this.provider);
                        const [slot0, liquidity] = await Promise.all([
                            pool.slot0(),
                            pool.liquidity()
                        ]);
                        
                        // Skip if no liquidity
                        if (liquidity === 0n) continue;
                        
                        // Get price quote
                        const amountIn = ethers.parseUnits('1', token.decimals);
                        const amountOut = await quoter.quoteExactInputSingle.staticCall(
                            token.address,
                            quoteToken.address,
                            feeTier,
                            amountIn,
                            0
                        );
                        
                        const price = await this.convertToUSD(amountOut, quoteToken);
                        const liquidityUSD = await this.calculateV3Liquidity(pool, slot0, token, quoteToken);
                        
                        return {
                            success: true,
                            price,
                            liquidity: liquidityUSD,
                            dex: dex.name,
                            poolInfo: {
                                type: 'v3',
                                pool: poolAddress,
                                feeTier,
                                quoteToken: quoteSymbol
                            }
                        };
                        
                    } catch (error) {
                        continue;
                    }
                }
            }
            
            throw new Error('No valid V3 pools found');
            
        } catch (error) {
            throw new Error(`V3 price fetch failed: ${error.message}`);
        }
    }
    
    async getV2Liquidity(pairAddress, token, quoteToken) {
        try {
            const pair = new ethers.Contract(pairAddress, this.abis.v2Pair, this.provider);
            const [reserves, token0] = await Promise.all([
                pair.getReserves(),
                pair.token0()
            ]);
            
            const isToken0 = token.address.toLowerCase() === token0.toLowerCase();
            const tokenReserve = isToken0 ? reserves[0] : reserves[1];
            const quoteReserve = isToken0 ? reserves[1] : reserves[0];
            
            // Convert reserves to USD
            const tokenAmount = parseFloat(ethers.formatUnits(tokenReserve, token.decimals));
            const quoteAmount = parseFloat(ethers.formatUnits(quoteReserve, quoteToken.decimals));
            
            const tokenPrice = await this.getTokenPriceUSD(token.symbol);
            const quotePrice = await this.getTokenPriceUSD(quoteToken.symbol);
            
            const liquidityUSD = (tokenAmount * tokenPrice) + (quoteAmount * quotePrice);
            
            return liquidityUSD;
            
        } catch (error) {
            logger.logError('Failed to get V2 liquidity', error);
            return 0;
        }
    }
    
    async calculateV3Liquidity(pool, slot0, token, quoteToken) {
        try {
            const liquidity = await pool.liquidity();
            const sqrtPriceX96 = slot0[0];
            
            // Calculate price
            const price = Math.pow(Number(sqrtPriceX96) / Math.pow(2, 96), 2);
            
            // Simplified liquidity calculation
            // In production, this would need to account for tick ranges
            const liquidityNumber = Number(liquidity);
            const estimatedValue = liquidityNumber * Math.sqrt(price) / 1e12;
            
            const quotePrice = await this.getTokenPriceUSD(quoteToken.symbol);
            const liquidityUSD = estimatedValue * quotePrice * 0.1; // Conservative estimate
            
            return Math.max(100, liquidityUSD);
            
        } catch (error) {
            logger.logError('Failed to calculate V3 liquidity', error);
            return 1000; // Fallback
        }
    }
    
    async convertToUSD(amount, token) {
        if (token.symbol === 'USDC' || token.symbol === 'USDT') {
            return parseFloat(ethers.formatUnits(amount, token.decimals));
        }
        
        const tokenPrice = await this.getTokenPriceUSD(token.symbol);
        const tokenAmount = parseFloat(ethers.formatUnits(amount, token.decimals));
        
        return tokenAmount * tokenPrice;
    }
    
    async cleanup() {
        this.cache.flushAll();
        this.cache.close();
        logger.logInfo('PriceFetcher cleaned up');
    }
}

module.exports = PriceFetcher;