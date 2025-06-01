const { ethers } = require('ethers');
require('dotenv').config();

const config = require('../config/polygon.json');
const logger = require('./logger');
const telegramNotifier = require('./telegram');
const PriceFetcher = require('./priceFetcher');
const ArbitrageTimeCalculator = require('./timeCalculator');

class TestSuite {
    constructor() {
        this.tests = [];
        this.results = [];
        this.provider = null;
        this.priceFetcher = null;
        this.timeCalculator = null;
    }
    
    addTest(name, testFunction) {
        this.tests.push({ name, testFunction });
    }
    
    async run() {
        console.log('🧪 Starting Enhanced Polygon Arbitrage Bot Test Suite...\n');
        
        for (const test of this.tests) {
            try {
                console.log(`🔍 Running test: ${test.name}`);
                const result = await test.testFunction();
                this.results.push({ name: test.name, success: true, result });
                console.log(`✅ Test passed: ${test.name}\n`);
            } catch (error) {
                this.results.push({ name: test.name, success: false, error: error.message });
                console.log(`❌ Test failed: ${test.name} - ${error.message}\n`);
            }
        }
        
        this.printSummary();
    }
    
    printSummary() {
        const passed = this.results.filter(r => r.success).length;
        const failed = this.results.filter(r => !r.success).length;
        const total = this.results.length;
        
        console.log('='.repeat(60));
        console.log('📊 TEST RESULTS SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total Tests: ${total}`);
        console.log(`✅ Passed: ${passed}`);
        console.log(`❌ Failed: ${failed}`);
        console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%`);
        console.log('='.repeat(60));
        
        if (failed > 0) {
            console.log('\n❌ FAILED TESTS:');
            this.results.filter(r => !r.success).forEach(result => {
                console.log(`   • ${result.name}: ${result.error}`);
            });
        }
        
        if (passed > 0) {
            console.log('\n✅ PASSED TESTS:');
            this.results.filter(r => r.success).forEach(result => {
                const summary = typeof result.result === 'object' && result.result.summary 
                    ? ` - ${result.result.summary}` 
                    : '';
                console.log(`   • ${result.name}${summary}`);
            });
        }
        
        console.log(`\n🎯 Overall Result: ${failed === 0 ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
        
        if (failed === 0) {
            console.log('\n🚀 Bot is ready for production deployment!');
        } else {
            console.log('\n⚠️  Please fix failed tests before production deployment.');
        }
    }
}

// Initialize test suite
const tester = new TestSuite();

// Test 1: Environment variables
tester.addTest('Environment Variables', async () => {
    const telegram = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    const hasTelegram = telegram.filter(key => process.env[key] && process.env[key] !== 'undefined');
    
    const apiKeys = ['ALCHEMY_API_KEY', 'INFURA_API_KEY'];
    const hasApiKeys = apiKeys.filter(key => process.env[key] && process.env[key] !== 'undefined');
    
    const rpcCount = Array.from({length: 10}, (_, i) => process.env[`POLYGON_RPC_${i+1}`])
        .filter(rpc => rpc && rpc !== 'undefined').length;
    
    if (hasTelegram.length < 2) {
        console.log('⚠️  No Telegram credentials - notifications will be disabled');
    }
    
    if (hasApiKeys.length === 0 && rpcCount === 0) {
        throw new Error('No RPC endpoints configured - need at least API keys or RPC URLs');
    }
    
    return {
        telegram: hasTelegram.length,
        apiKeys: hasApiKeys.length,
        rpcEndpoints: rpcCount,
        telegramConfigured: hasTelegram.length === 2,
        hasRpcAccess: hasApiKeys.length > 0 || rpcCount > 0,
        summary: `${hasTelegram.length}/2 Telegram, ${hasApiKeys.length}/2 API keys, ${rpcCount} RPC endpoints`
    };
});

// Test 2: Configuration validation
tester.addTest('Configuration Validation', async () => {
    const errors = [];
    
    // Check tokens
    const requiredTokens = ['WMATIC', 'WETH', 'WBTC', 'USDC', 'USDT', 'LINK', 'AAVE', 'CRV'];
    for (const symbol of requiredTokens) {
        const token = config.tokens[symbol];
        if (!token) {
            errors.push(`Missing token: ${symbol}`);
        } else {
            if (!ethers.isAddress(token.address)) {
                errors.push(`Invalid address for ${symbol}: ${token.address}`);
            }
            if (typeof token.decimals !== 'number' || token.decimals < 0) {
                errors.push(`Invalid decimals for ${symbol}: ${token.decimals}`);
            }
        }
    }
    
    // Check DEXes
    const requiredDexes = ['uniswap', 'sushiswap', 'quickswap'];
    for (const dexName of requiredDexes) {
        const dex = config.dexes[dexName];
        if (!dex) {
            errors.push(`Missing DEX: ${dexName}`);
        } else {
            if (!ethers.isAddress(dex.router)) {
                errors.push(`Invalid router for ${dexName}: ${dex.router}`);
            }
        }
    }
    
    // Check trading paths
    let totalPaths = 0;
    for (const [token, paths] of Object.entries(config.tradingPaths)) {
        if (!Array.isArray(paths) || paths.length === 0) {
            errors.push(`No trading paths for ${token}`);
        } else {
            totalPaths += paths.length;
        }
    }
    
    if (errors.length > 0) {
        throw new Error(`Configuration errors: ${errors.join(', ')}`);
    }
    
    return {
        tokens: Object.keys(config.tokens).length,
        dexes: Object.keys(config.dexes).length,
        tradingPaths: totalPaths,
        valid: true,
        summary: `${Object.keys(config.tokens).length} tokens, ${Object.keys(config.dexes).length} DEXes, ${totalPaths} paths`
    };
});

// Test 3: RPC Connection with enhanced testing
tester.addTest('RPC Connection', async () => {
    const rpcEndpoints = [];
    
    // Collect RPC endpoints
    for (let i = 1; i <= 10; i++) {
        const rpc = process.env[`POLYGON_RPC_${i}`];
        if (rpc && rpc !== 'undefined') rpcEndpoints.push(rpc);
    }
    
    // Add API-based endpoints
    if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
        rpcEndpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
    }
    if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
        rpcEndpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
    }
    
    // Add public fallbacks
    rpcEndpoints.push('https://polygon-rpc.com', 'https://rpc.ankr.com/polygon');
    
    let workingEndpoints = 0;
    const results = [];
    let fastestResponseTime = Infinity;
    let slowestResponseTime = 0;
    
    for (const endpoint of rpcEndpoints) {
        try {
            const startTime = Date.now();
            const provider = new ethers.JsonRpcProvider(
                endpoint,
                137, // Polygon chainId
                {
                    staticNetwork: true,
                    batchMaxCount: 1
                }
            );
            
            const [network, blockNumber] = await Promise.race([
                Promise.all([
                    provider.getNetwork(),
                    provider.getBlockNumber()
                ]),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Connection timeout')), 8000)
                )
            ]);
            
            const responseTime = Date.now() - startTime;
            fastestResponseTime = Math.min(fastestResponseTime, responseTime);
            slowestResponseTime = Math.max(slowestResponseTime, responseTime);
            
            if (Number(network.chainId) === 137) {
                workingEndpoints++;
                results.push({
                    endpoint: endpoint.split('/')[2] || 'unknown',
                    status: 'working',
                    blockNumber,
                    chainId: Number(network.chainId),
                    responseTime: responseTime + 'ms'
                });
                
                // Store first working provider for other tests
                if (!tester.provider) {
                    tester.provider = provider;
                }
            } else {
                results.push({
                    endpoint: endpoint.split('/')[2] || 'unknown',
                    status: 'wrong_network',
                    chainId: Number(network.chainId)
                });
            }
        } catch (error) {
            results.push({
                endpoint: endpoint.split('/')[2] || 'unknown',
                status: 'failed',
                error: error.message
            });
        }
    }
    
    if (workingEndpoints === 0) {
        throw new Error('No working RPC endpoints found');
    }
    
    return {
        total: rpcEndpoints.length,
        working: workingEndpoints,
        results,
        fastestResponseTime: fastestResponseTime === Infinity ? 'N/A' : fastestResponseTime + 'ms',
        slowestResponseTime: slowestResponseTime + 'ms',
        recommendation: workingEndpoints < 2 ? 'Add more RPC endpoints for better reliability' : 'Good',
        summary: `${workingEndpoints}/${rpcEndpoints.length} working, fastest: ${fastestResponseTime === Infinity ? 'N/A' : fastestResponseTime + 'ms'}`
    };
});

// Test 4: Telegram Connection
tester.addTest('Telegram Connection', async () => {
    const status = telegramNotifier.getStatus();
    
    if (!status.configured) {
        throw new Error('Telegram not configured - check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    }
    
    // Test bot info
    const botInfo = await telegramNotifier.getBotInfo();
    if (!botInfo) {
        throw new Error('Failed to get Telegram bot info - check token validity');
    }
    
    // Test message sending
    const testSent = await telegramNotifier.testConnection();
    if (!testSent) {
        throw new Error('Failed to send test message - check chat ID and bot permissions');
    }
    
    return {
        configured: status.configured,
        botUsername: botInfo.username,
        botName: botInfo.first_name,
        chatId: status.chatId,
        testMessageSent: testSent,
        summary: `Bot: @${botInfo.username}, test message sent`
    };
});

// Test 5: Enhanced Price Fetching
tester.addTest('Enhanced Price Fetching', async () => {
    if (!tester.provider) {
        throw new Error('No working RPC provider available');
    }
    
    tester.priceFetcher = new PriceFetcher(tester.provider);
    
    const testResults = [];
    const testTokens = ['USDC', 'WETH', 'LINK'];
    const testDexes = ['sushiswap', 'quickswap'];
    
    let totalResponseTime = 0;
    let successfulCalls = 0;
    
    for (const token of testTokens) {
        for (const dex of testDexes) {
            try {
                const startTime = Date.now();
                const result = await tester.priceFetcher.getTokenPrice(token, dex, 1000);
                const responseTime = Date.now() - startTime;
                
                totalResponseTime += responseTime;
                
                testResults.push({
                    token,
                    dex,
                    success: result.success,
                    price: result.price,
                    method: result.method,
                    path: result.path,
                    slippage: result.estimatedSlippage || 'N/A',
                    responseTime: responseTime + 'ms'
                });
                
                if (result.success && result.price > 0) {
                    successfulCalls++;
                }
                
            } catch (error) {
                testResults.push({
                    token,
                    dex,
                    success: false,
                    error: error.message,
                    responseTime: 'timeout'
                });
            }
        }
    }
    
    const successful = testResults.filter(r => r.success && r.price > 0);
    const failed = testResults.filter(r => !r.success);
    const avgResponseTime = successfulCalls > 0 ? Math.round(totalResponseTime / successfulCalls) : 0;
    
    if (successful.length === 0) {
        throw new Error('No successful price fetches - check RPC connections and DEX configurations');
    }
    
    // Test cache functionality
    const cacheStats = tester.priceFetcher.getCacheStats();
    
    return {
        total: testResults.length,
        successful: successful.length,
        failed: failed.length,
        results: testResults,
        avgResponseTime: avgResponseTime + 'ms',
        successRate: ((successful.length / testResults.length) * 100).toFixed(1) + '%',
        cacheStats,
        summary: `${successful.length}/${testResults.length} successful, avg: ${avgResponseTime}ms`
    };
});

// Test 6: Time Calculator Testing
tester.addTest('Time Calculator', async () => {
    if (!tester.provider) {
        throw new Error('No working RPC provider available');
    }
    
    tester.timeCalculator = new ArbitrageTimeCalculator();
    
    // Test with mock opportunity
    const mockOpportunity = {
        token: 'LINK',
        buyDex: 'sushiswap',
        sellDex: 'uniswap',
        buyPrice: 14.50,
        sellPrice: 14.73,
        basisPoints: 158,
        percentage: 1.58,
        inputAmount: 1000,
        potentialProfit: 15.80,
        buyPath: ['LINK', 'WETH'],
        sellPath: ['LINK', 'USDC']
    };
    
    const timingData = await tester.timeCalculator.calculateArbitrageTimings(mockOpportunity, tester.provider);
    
    if (!timingData) {
        throw new Error('Time calculator returned null');
    }
    
    // Validate timing data structure
    const requiredFields = [
        'executionTime', 'viabilityWindow', 'priceDecay', 
        'adjustedProfit', 'confidence', 'recommendation'
    ];
    
    for (const field of requiredFields) {
        if (timingData[field] === undefined) {
            throw new Error(`Missing required field: ${field}`);
        }
    }
    
    // Test network metrics update
    const networkMetrics = tester.timeCalculator.getNetworkMetrics();
    const calibrationStats = tester.timeCalculator.getCalibrationStats();
    
    return {
        timingCalculated: true,
        executionTime: Math.round(timingData.executionTime) + 'ms',
        confidence: Math.round(timingData.confidence * 100) + '%',
        recommendation: timingData.recommendation.action,
        isViable: timingData.isViable,
        adjustedProfit: '$' + timingData.adjustedProfit.adjustedProfit.toFixed(2),
        networkMetrics,
        calibrationStats,
        summary: `${timingData.recommendation.action}, ${Math.round(timingData.confidence * 100)}% confidence, $${timingData.adjustedProfit.adjustedProfit.toFixed(2)} profit`
    };
});

// Test 7: Contract Address Validation
tester.addTest('Contract Address Validation', async () => {
    if (!tester.provider) {
        throw new Error('No working RPC provider available');
    }
    
    const validationResults = [];
    
    // Test token contracts
    for (const [symbol, token] of Object.entries(config.tokens)) {
        try {
            const code = await tester.provider.getCode(token.address);
            const isContract = code !== '0x';
            
            validationResults.push({
                type: 'token',
                symbol,
                address: token.address,
                isContract,
                status: isContract ? 'valid' : 'invalid'
            });
        } catch (error) {
            validationResults.push({
                type: 'token',
                symbol,
                address: token.address,
                isContract: false,
                status: 'error',
                error: error.message
            });
        }
    }
    
    // Test DEX router contracts
    for (const [dexName, dex] of Object.entries(config.dexes)) {
        try {
            const code = await tester.provider.getCode(dex.router);
            const isContract = code !== '0x';
            
            validationResults.push({
                type: 'dex',
                name: dexName,
                address: dex.router,
                isContract,
                status: isContract ? 'valid' : 'invalid'
            });
        } catch (error) {
            validationResults.push({
                type: 'dex',
                name: dexName,
                address: dex.router,
                isContract: false,
                status: 'error',
                error: error.message
            });
        }
    }
    
    const valid = validationResults.filter(r => r.status === 'valid');
    const invalid = validationResults.filter(r => r.status !== 'valid');
    
    if (invalid.length > 0) {
        console.log('⚠️  Invalid contracts found:', invalid.map(r => `${r.symbol || r.name}: ${r.address.slice(0, 10)}...`));
    }
    
    return {
        total: validationResults.length,
        valid: valid.length,
        invalid: invalid.length,
        results: validationResults,
        summary: `${valid.length}/${validationResults.length} valid contracts`
    };
});

// Test 8: Complete Bot Workflow Simulation
tester.addTest('Complete Bot Workflow Simulation', async () => {
    if (!tester.provider || !tester.priceFetcher || !tester.timeCalculator) {
        throw new Error('Prerequisites not met - need working RPC, price fetcher, and time calculator');
    }
    
    // Simulate a complete bot workflow
    const testToken = 'USDC';
    const dexes = Object.keys(config.dexes);
    
    // Get prices from all DEXes
    const priceResults = await tester.priceFetcher.getMultiplePrices(testToken, dexes, 1000);
    
    // Filter valid prices
    const validPrices = priceResults.filter(r => r.success && r.price > 0);
    
    if (validPrices.length < 2) {
        throw new Error('Not enough valid prices for arbitrage simulation');
    }
    
    // Simulate arbitrage detection
    validPrices.sort((a, b) => a.price - b.price);
    const buyPrice = validPrices[0];
    const sellPrice = validPrices[validPrices.length - 1];
    
    const basisPoints = Math.round(((sellPrice.price - buyPrice.price) / buyPrice.price) * 10000);
    const hasArbitrage = basisPoints >= config.settings.minBasisPointsPerTrade;
    
    let timingAnalysis = null;
    if (hasArbitrage) {
        const mockOpportunity = {
            token: testToken,
            buyDex: buyPrice.dex,
            sellDex: sellPrice.dex,
            buyPrice: buyPrice.price,
            sellPrice: sellPrice.price,
            basisPoints,
            percentage: basisPoints / 100,
            inputAmount: 1000,
            potentialProfit: 1000 * (basisPoints / 10000),
            buyPath: buyPrice.path,
            sellPath: sellPrice.path
        };
        
        timingAnalysis = await tester.timeCalculator.calculateArbitrageTimings(mockOpportunity, tester.provider);
    }
    
    return {
        token: testToken,
        pricesChecked: priceResults.length,
        validPrices: validPrices.length,
        buyDex: buyPrice.dex,
        sellDex: sellPrice.dex,
        basisPoints,
        hasArbitrage,
        isViable: timingAnalysis ? timingAnalysis.isViable : false,
        recommendation: timingAnalysis ? timingAnalysis.recommendation.action : 'N/A',
        wouldTriggerAlert: hasArbitrage && buyPrice.dex !== sellPrice.dex && timingAnalysis?.isViable,
        workflow: 'completed',
        summary: `${basisPoints} bps spread, ${timingAnalysis ? timingAnalysis.recommendation.action : 'no analysis'}`
    };
});

// Test 9: Error Handling and Recovery
tester.addTest('Error Handling and Recovery', async () => {
    if (!tester.priceFetcher) {
        throw new Error('Price fetcher not available');
    }
    
    const errorTests = [];
    
    // Test invalid token
    try {
        const result = await tester.priceFetcher.getTokenPrice('INVALID_TOKEN', 'sushiswap', 1000);
        errorTests.push({
            test: 'invalid_token',
            handled: !result.success,
            error: result.error || 'none'
        });
    } catch (error) {
        errorTests.push({
            test: 'invalid_token',
            handled: false,
            error: error.message
        });
    }
    
    // Test invalid DEX
    try {
        const result = await tester.priceFetcher.getTokenPrice('USDC', 'invalid_dex', 1000);
        errorTests.push({
            test: 'invalid_dex',
            handled: !result.success,
            error: result.error || 'none'
        });
    } catch (error) {
        errorTests.push({
            test: 'invalid_dex',
            handled: false,
            error: error.message
        });
    }
    
    // Test cache clearing
    tester.priceFetcher.clearCache();
    const cacheStats = tester.priceFetcher.getCacheStats();
    
    const allHandled = errorTests.every(test => test.handled);
    
    return {
        errorTests,
        allErrorsHandled: allHandled,
        cacheCleared: cacheStats.totalEntries === 0,
        summary: `${errorTests.filter(t => t.handled).length}/${errorTests.length} errors handled gracefully`
    };
});

// Test 10: Performance and Memory
tester.addTest('Performance and Memory', async () => {
    const memBefore = process.memoryUsage();
    const startTime = Date.now();
    
    // Simulate some work
    if (tester.priceFetcher) {
        // Clean expired cache entries
        const cleaned = tester.priceFetcher.cleanExpiredCache();
        
        // Get performance metrics
        const metrics = tester.priceFetcher.getPerformanceMetrics();
        
        // Test multiple rapid calls
        const rapidTests = [];
        for (let i = 0; i < 5; i++) {
            try {
                const result = await tester.priceFetcher.getTokenPrice('USDC', 'sushiswap', 1000);
                rapidTests.push(result.success);
            } catch (error) {
                rapidTests.push(false);
            }
        }
        
        const memAfter = process.memoryUsage();
        const endTime = Date.now();
        const memDiff = memAfter.heapUsed - memBefore.heapUsed;
        
        return {
            memoryBefore: Math.round(memBefore.heapUsed / 1024 / 1024) + ' MB',
            memoryAfter: Math.round(memAfter.heapUsed / 1024 / 1024) + ' MB',
            memoryIncrease: Math.round(memDiff / 1024 / 1024) + ' MB',
            executionTime: (endTime - startTime) + 'ms',
            cacheEntriesCleaned: cleaned,
            rapidTestsSuccessRate: Math.round((rapidTests.filter(Boolean).length / rapidTests.length) * 100) + '%',
            nodeVersion: process.version,
            platform: process.platform,
            uptime: Math.round(process.uptime()) + ' seconds',
            performanceMetrics: metrics,
            summary: `${Math.round(memDiff / 1024 / 1024)}MB used, ${endTime - startTime}ms execution time`
        };
    } else {
        return {
            skipped: true,
            reason: 'Price fetcher not available',
            summary: 'Test skipped - no price fetcher'
        };
    }
});

// Run all tests
if (require.main === module) {
    console.log('🚀 Starting Enhanced Test Suite for Polygon Arbitrage Bot');
    console.log('=' + '='.repeat(65));
    
    tester.run().then(() => {
        const failed = tester.results.filter(r => !r.success).length;
        const passed = tester.results.filter(r => r.success).length;
        
        console.log('\n' + '='.repeat(66));
        if (failed === 0) {
            console.log('🎉 ALL TESTS PASSED! Bot is ready for production deployment.');
            console.log('🚀 You can now run: npm start');
        } else {
            console.log(`⚠️  ${failed} test(s) failed. Please fix before production deployment.`);
            console.log('🔧 Run: npm run validate for more details');
        }
        console.log('=' + '='.repeat(65));
        
        process.exit(failed > 0 ? 1 : 0);
    }).catch(error => {
        console.error('❌ Test suite failed to run:', error);
        process.exit(1);
    });
}

module.exports = TestSuite;