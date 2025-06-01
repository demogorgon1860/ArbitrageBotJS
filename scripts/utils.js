const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');

/**
 * Format token amount from wei to readable format
 */
function formatTokenAmount(amount, decimals) {
    try {
        return ethers.formatUnits(amount, decimals);
    } catch (error) {
        return '0';
    }
}

/**
 * Convert USD amount to token amount in wei
 */
function usdToTokenAmount(usdAmount, tokenPriceUSD, decimals) {
    try {
        const tokenAmount = usdAmount / tokenPriceUSD;
        return ethers.parseUnits(tokenAmount.toString(), decimals);
    } catch (error) {
        return ethers.getBigInt('0');
    }
}

/**
 * Calculate basis points between two prices
 */
function calculateBasisPoints(sellPrice, buyPrice) {
    if (buyPrice === 0) return 0;
    const spread = sellPrice - buyPrice;
    const basisPoints = (spread / buyPrice) * 10000;
    return Math.round(basisPoints);
}

/**
 * Format price for display
 */
function formatPrice(price, decimals = 6) {
    if (!price || isNaN(price)) return '0';
    return parseFloat(price).toFixed(decimals);
}

/**
 * Get current timestamp in ISO format
 */
function getCurrentTimestamp() {
    return new Date().toISOString();
}

/**
 * Sleep function for delays
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            if (attempt === maxRetries) {
                throw error;
            }
            
            const delay = baseDelay * Math.pow(2, attempt - 1);
            await sleep(delay);
        }
    }
    
    throw lastError;
}

/**
 * Create unique notification ID
 */
function createNotificationId(token, buyDex, sellDex, basisPoints) {
    return `${token}-${buyDex}-${sellDex}-${Math.floor(basisPoints / 10) * 10}`;
}

/**
 * Check if notification is duplicate
 */
function isDuplicateNotification(notificationId, recentNotifications, cooldownMs) {
    const now = Date.now();
    const lastNotified = recentNotifications.get(notificationId);
    
    if (!lastNotified) {
        recentNotifications.set(notificationId, now);
        return false;
    }
    
    const timeSinceLastNotification = now - lastNotified;
    
    if (timeSinceLastNotification < cooldownMs) {
        return true; // Duplicate
    }
    
    // Update timestamp
    recentNotifications.set(notificationId, now);
    return false;
}

/**
 * Save notifications cache to file
 */
async function saveNotificationsCache(notifications) {
    try {
        const cacheDir = path.join(__dirname, '..', 'cache');
        await ensureDirectory(cacheDir);
        
        const cacheFile = path.join(cacheDir, 'notifications.json');
        const cacheData = Array.from(notifications.entries());
        await fs.writeJson(cacheFile, cacheData);
    } catch (error) {
        console.error('Failed to save notifications cache:', error);
    }
}

/**
 * Load notifications cache from file
 */
async function loadNotificationsCache() {
    try {
        const cacheFile = path.join(__dirname, '..', 'cache', 'notifications.json');
        
        if (await fs.pathExists(cacheFile)) {
            const cacheData = await fs.readJson(cacheFile);
            return new Map(cacheData);
        }
    } catch (error) {
        console.error('Failed to load notifications cache:', error);
    }
    
    return new Map();
}

/**
 * Ensure directory exists
 */
async function ensureDirectory(dirPath) {
    try {
        await fs.ensureDir(dirPath);
    } catch (error) {
        throw new Error(`Failed to create directory ${dirPath}: ${error.message}`);
    }
}

/**
 * Get real-time token price from CoinGecko (improved price oracle)
 */
async function getTokenPriceUSD(tokenSymbol) {
    const coinGeckoIds = {
        'WETH': 'ethereum',
        'WBTC': 'bitcoin',
        'WMATIC': 'matic-network',
        'LINK': 'chainlink',
        'AAVE': 'aave',
        'CRV': 'curve-dao-token',
        'USDC': 'usd-coin',
        'USDT': 'tether'
    };
    
    const coinId = coinGeckoIds[tokenSymbol];
    if (!coinId) {
        // Fallback to static prices for unknown tokens
        const fallbackPrices = {
            'WETH': 2000,
            'WBTC': 35000,
            'WMATIC': 1,
            'LINK': 15,
            'AAVE': 80,
            'CRV': 0.5,
            'USDC': 1,
            'USDT': 1
        };
        return fallbackPrices[tokenSymbol] || 1;
    }
    
    try {
        const axios = require('axios');
        const response = await axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
            { timeout: 5000 }
        );
        
        return response.data[coinId]?.usd || 1;
    } catch (error) {
        console.warn(`Failed to fetch price for ${tokenSymbol}, using fallback`);
        // Fallback prices
        const fallbackPrices = {
            'WETH': 2000,
            'WBTC': 35000,
            'WMATIC': 1,
            'LINK': 15,
            'AAVE': 80,
            'CRV': 0.5,
            'USDC': 1,
            'USDT': 1
        };
        return fallbackPrices[tokenSymbol] || 1;
    }
}

/**
 * Get current gas price for Polygon network
 */
async function getCurrentGasPrice(provider) {
    try {
        const feeData = await provider.getFeeData();
        return parseFloat(ethers.formatUnits(feeData.gasPrice, 'gwei'));
    } catch (error) {
        console.warn('Failed to fetch gas price, using default');
        return 30; // Default 30 Gwei for Polygon
    }
}

/**
 * Calculate real slippage for a trading path
 */
async function calculateRealSlippage(router, path, amountIn, provider) {
    try {
        // Get amounts for different trade sizes to estimate slippage
        const baseAmount = ethers.getBigInt(amountIn);
        const largerAmount = (baseAmount * ethers.getBigInt(105)) / ethers.getBigInt(100); // 5% larger trade
        
        const [baseAmounts, largerAmounts] = await Promise.all([
            router.getAmountsOut(baseAmount, path),
            router.getAmountsOut(largerAmount, path)
        ]);
        
        const baseOutputAmount = baseAmounts[baseAmounts.length - 1];
        const largerOutputAmount = largerAmounts[largerAmounts.length - 1];
        
        // Calculate price impact
        const expectedLargerOutput = (baseOutputAmount * ethers.getBigInt(105)) / ethers.getBigInt(100);
        const actualSlippage = expectedLargerOutput - largerOutputAmount;
        const slippagePercentage = (actualSlippage * ethers.getBigInt(10000)) / expectedLargerOutput;
        
        return Number(slippagePercentage) / 100; // Return as percentage
        
    } catch (error) {
        console.warn('Failed to calculate real slippage, using default');
        return 0.3; // Default 0.3% slippage
    }
}

/**
 * Validate Ethereum address
 */
function isValidAddress(address) {
    return ethers.isAddress(address);
}

/**
 * Convert token amount to human readable format with symbol
 */
function formatTokenDisplay(amount, decimals, symbol) {
    const formatted = formatTokenAmount(amount, decimals);
    return `${formatted} ${symbol}`;
}

/**
 * Calculate percentage change between two values
 */
function calculatePercentageChange(newValue, oldValue) {
    if (oldValue === 0) return 0;
    return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Clean old cache files (older than specified days)
 */
async function cleanOldCacheFiles(cacheDir, maxAgeDays = 7) {
    try {
        const files = await fs.readdir(cacheDir);
        const now = Date.now();
        const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
        
        for (const file of files) {
            const filePath = path.join(cacheDir, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                await fs.remove(filePath);
                console.log(`Removed old cache file: ${file}`);
            }
        }
    } catch (error) {
        console.error('Failed to clean old cache files:', error);
    }
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Generate random ID
 */
function generateRandomId(length = 8) {
    return Math.random().toString(36).substring(2, 2 + length);
}

/**
 * Validate environment variables
 */
function validateEnvVars(requiredVars) {
    const missing = requiredVars.filter(varName => !process.env[varName]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    return true;
}

module.exports = {
    formatTokenAmount,
    usdToTokenAmount,
    calculateBasisPoints,
    formatPrice,
    getCurrentTimestamp,
    sleep,
    retryWithBackoff,
    createNotificationId,
    isDuplicateNotification,
    saveNotificationsCache,
    loadNotificationsCache,
    ensureDirectory,
    getTokenPriceUSD,
    getCurrentGasPrice,
    calculateRealSlippage,
    isValidAddress,
    formatTokenDisplay,
    calculatePercentageChange,
    cleanOldCacheFiles,
    formatBytes,
    generateRandomId,
    validateEnvVars
};