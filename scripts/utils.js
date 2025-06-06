/**
 * Utility functions with all critical fixes
 */

const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const logger = require('./logger');

/**
 * Validate and sanitize numeric value
 */
function validateNumeric(value, defaultValue, min = 0, max = Infinity) {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    
    if (typeof num !== 'number' || !isFinite(num) || isNaN(num)) {
        return defaultValue;
    }
    
    if (num < min) return min;
    if (num > max) return max;
    
    return num;
}

/**
 * Calculate basis points with validation
 */
function calculateBasisPoints(sellPrice, buyPrice) {
    // Validate inputs
    const validSellPrice = validateNumeric(sellPrice, 0);
    const validBuyPrice = validateNumeric(buyPrice, 0);
    
    if (validSellPrice <= 0 || validBuyPrice <= 0) {
        return 0;
    }
    
    // Check for negative spread
    if (validSellPrice <= validBuyPrice) {
        return 0;
    }
    
    // Calculate basis points
    const spread = validSellPrice - validBuyPrice;
    const basisPoints = (spread / validBuyPrice) * 10000;
    
    // Validate result
    if (!isFinite(basisPoints) || basisPoints < 0 || basisPoints > 100000) {
        logger.logWarning(`Invalid basis points: ${basisPoints}`);
        return 0;
    }
    
    return Math.round(basisPoints * 100) / 100;
}

/**
 * Sleep utility
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format number with proper handling
 */
function formatNumber(num, decimals = 2) {
    const validated = validateNumeric(num, 0);
    return validated.toFixed(decimals);
}

/**
 * Format currency
 */
function formatCurrency(amount, currency = 'USD') {
    const validated = validateNumeric(amount, 0);
    return `$${formatNumber(validated, 2)}`;
}

/**
 * Safe promise wrapper
 */
async function safePromise(promise, context = 'Unknown') {
    try {
        return await promise;
    } catch (error) {
        logger.logError(`Promise rejected in ${context}`, error);
        return { success: false, error: error.message, context };
    }
}

/**
 * Create notification ID
 */
function createNotificationId(token, buyDex, sellDex, basisPoints) {
    const roundedBps = Math.round(basisPoints / 10) * 10;
    return `${token}_${buyDex}_${sellDex}_${roundedBps}`;
}

/**
 * Check if notification is duplicate
 */
function isDuplicateNotification(notificationId, recentNotifications, cooldownMs = 300000) {
    const now = Date.now();
    const lastNotification = recentNotifications.get(notificationId);
    
    if (!lastNotification) {
        return false;
    }
    
    return (now - lastNotification) < cooldownMs;
}

/**
 * Get current timestamp
 */
function getCurrentTimestamp() {
    return new Date().toISOString();
}

/**
 * Validate Ethereum address
 */
function isValidAddress(address) {
    try {
        return ethers.isAddress(address);
    } catch {
        return false;
    }
}

/**
 * Simple mutex implementation
 */
class SimpleMutex {
    constructor() {
        this.locked = false;
        this.queue = [];
    }
    
    async acquire() {
        return new Promise((resolve) => {
            if (!this.locked) {
                this.locked = true;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }
    
    release() {
        if (this.queue.length > 0) {
            const resolve = this.queue.shift();
            resolve();
        } else {
            this.locked = false;
        }
    }
}

module.exports = {
    validateNumeric,
    calculateBasisPoints,
    sleep,
    formatNumber,
    formatCurrency,
    safePromise,
    createNotificationId,
    isDuplicateNotification,
    getCurrentTimestamp,
    isValidAddress,
    SimpleMutex
};