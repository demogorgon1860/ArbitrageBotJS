#!/usr/bin/env node

/**
 * Health Check - Verify bot is working correctly
 */

require('dotenv').config();
const ArbitrageBot = require('./arbitrageBot');
const logger = require('./logger');

async function runHealthCheck() {
    try {
        logger.logInfo('Running health check...');
        
        // Test engine initialization
        const engine = new ArbitrageBot();
        await engine.initialize();
        
        // Test price fetching
        const testPrice = await engine.priceFetcher.getTokenPrice('WETH', 'quickswap');
        if (!testPrice.success) {
            throw new Error('Price fetching failed');
        }
        
        // Test gas calculation
        const gasCost = await engine.gasCalculator.calculateTotalGasCost('WETH', 'quickswap', 'sushiswap');
        if (gasCost <= 0) {
            throw new Error('Gas calculation failed');
        }
        
        logger.logSuccess('✅ Health check passed');
        logger.logInfo(`Test price: $${testPrice.price.toFixed(2)}`);
        logger.logInfo(`Test gas cost: $${gasCost.toFixed(2)}`);
        
        await engine.stop();
        process.exit(0);
        
    } catch (error) {
        logger.logError('❌ Health check failed', error);
        process.exit(1);
    }
}

if (require.main === module) {
    runHealthCheck();
}