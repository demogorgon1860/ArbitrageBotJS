const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');

/**
 * Format token amount from wei to readable format
 */
function formatTokenAmount(amount, decimals) {
    try {
        return ethers.utils.formatUnits(amount, decimals);
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
        return ethers.utils.parseUnits(tokenAmount.toString(), decimals);
    } catch (error) {
        return ethers.BigNumber.from('0');
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
    return