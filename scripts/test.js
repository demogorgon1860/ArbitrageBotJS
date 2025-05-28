const { ethers } = require('ethers');
require('dotenv').config();

const config = require('../config/polygon.json');
const logger = require('./logger');
const telegramNotifier = require('./telegram');
const PriceFetcher = require('./priceFetcher');

class TestSuite {
    constructor() {
        this.tests = [];
        this.results = [];
        this.provider = null;
        this.priceFetcher = null;
    }
    
    addTest(name, testFunction) {
        this.tests.push({ name, testFunction });
    }
    
    async run() {
        console.log('🧪 Starting Polygon Arbitrage Bot Test Suite...\n');
        
    async run() {
        console.log('🧪 Starting Polygon Arbitrage Bot Test Suite...\n');
        
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
        
        console.log(`\n🎯 Overall Result: ${failed === 0 ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
    }
}

// Initialize test suite
const tester = new TestSuite();

// Test 1: Environment variables
tester.addTest('Environment Variables', async () => {
    // Check for Telegram credentials (required for notifications)
    const telegram = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    const hasTelegram = telegram.filter(key => process.env[key]);
    
    // Check for API keys (recommended but not required)
    const apiKeys = ['ALCHEMY_API_KEY', 'INFURA_API_KEY'];
    const hasApiKeys = apiKeys.filter(key => process.env[key]);
    
    if (hasTelegram.length === 0) {
        console.log('⚠️  No Telegram credentials - notifications will be disabled');
    }
    
    if (hasApiKeys.length === 0) {
        console.log('⚠️  No API keys provided - will use public RPCs (may have rate limits)');
    }
    
    return {
        telegram: hasTelegram.length,
        apiKeys: hasApiKeys.length,
        telegramConfigured: hasTelegram.length === 2,
        apiKeysConfigured: hasApiKeys.length > 0,
        recommendations: {
            telegram: hasTelegram.length < 2 ? 'Configure Telegram for notifications' : 'OK',
            apiKeys: hasApiKeys.length === 0 ? 'Add API keys for better reliability' : 'OK'
        }
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
            if (!ethers.utils.isAddress(token.address)) {
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
            if (!ethers.utils.isAddress(dex.router)) {
                errors.push(`Invalid router for ${dexName}: ${dex.router}`);
            }
        }
    }
    
    // Check trading paths
    for (const [token, paths] of Object.entries(config.tradingPaths)) {
        if (!Array.isArray(paths) || paths.length === 0) {
            errors.push(`No trading paths for ${token}`);
        }
    }
    
    if (errors.length > 0) {
        throw new Error(`Configuration errors: ${errors.join(', ')}`);
    }
    
    return {
        tokens: Object.keys(config.tokens).length,
        dexes: Object.keys(config.dexes).length,
        tradingPaths: Object.keys(config.tradingPaths).length,
        valid: true
    };
});

// Test 3: RPC Connection
tester.addTest('RPC Connection', async () => {
    const rpcEndpoints = [];
    
    // Collect RPC endpoints
    for (let i = 1; i <= 5; i++) {
        const rpc = process.env[`POLYGON_RPC_${i}`];
        if (rpc) rpcEndpoints.push(rpc);
    }
    
    // Add API-based endpoints
    if (process.env.ALCHEMY_API_KEY) {
        rpcEndpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
    }
    if (process.env.INFURA_API_KEY) {
        rpcEndpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
    }
    
    // Add public fallbacks
    rpcEndpoints.push('https://polygon-rpc.com', 'https://rpc.ankr.com/polygon');
    
    let workingEndpoints = 0;
    const results = [];
    
    for (const endpoint of rpcEndpoints) {
        try {
            const provider = new ethers.providers.JsonRpcProvider(endpoint);
            const [network, blockNumber] = await Promise.all([
                provider.getNetwork(),
                provider.getBlockNumber()
            ]);
            
            if (network.chainId === 137) {
                workingEndpoints++;
                results.push({
                    endpoint: endpoint.split('/')[2],
                    status: 'working',
                    blockNumber,
                    chainId: network.chainId
                });
                tester.provider = provider; // Store working provider for other tests
            } else {
                results.push({
                    endpoint: endpoint.split('/')[2],
                    status: 'wrong_network',
                    chainId: network.chainId
                });
            }
        } catch (error) {
            results.push({
                endpoint: endpoint.split('/')[2],
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
        recommendation: workingEndpoints < 2 ? 'Add more RPC endpoints for better reliability' : 'Good'
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
        testMessageSent: testSent
    };
});

// Test 5: Price Fetching
tester.addTest('Real Price Fetching', async () => {
    if (!tester.provider) {
        throw new Error('No working RPC provider available');
    }
    
    tester.priceFetcher = new PriceFetcher(tester.provider);
    
    const testResults = [];
    const testTokens = ['USDC', 'WETH', 'LINK'];
    const testDexes = ['sushiswap', 'quickswap'];
    
    for (const token of testTokens) {
        for (const dex of testDexes) {
            try {
                const result = await tester.priceFetcher.getTokenPrice(token, dex, 1000);
                testResults.push({
                    token,
                    dex,
                    success: result.success,
                    price: result.price,
                    method: result.method,
                    path: result.path
                });
            } catch (error) {
                testResults.push({
                    token,
                    dex,
                    success: false,
                    error: error.message
                });
            }
        }
    }
    
    const successful = testResults.filter(r => r.success && r.price > 0);
    const failed = testResults.filter(r => !r.success);
    
    if (successful.length === 0) {
        throw new Error('No successful price fetches - check RPC connections and DEX configurations');
    }
    
    return {
        total: testResults.length,
        successful: successful.length,
        failed: failed.length,
        results: testResults,
        successRate: ((successful.length / testResults.length) * 100).toFixed(1) + '%'
    };
});

// Test 6: Contract Address Validation
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
        console.log('⚠️  Invalid contracts found:', invalid.map(r => `${r.symbol || r.name}: ${r.address}`));
    }
    
    return {
        total: validationResults.length,
        valid: valid.length,
        invalid: invalid.length,
        results: validationResults
    };
});

// Test 7: Arbitrage Detection Logic
tester.addTest('Arbitrage Detection Logic', async () => {
    // Test the arbitrage detection with mock data
    const mockPrices = [
        { dex: 'sushiswap', price: 1.000, success: true },
        { dex: 'quickswap', price: 1.005, success: true },
        { dex: 'uniswap', price: 1.002, success: true }
    ];
    
    // Sort prices
    mockPrices.sort((a, b) => a.price - b.price);
    
    const buyPrice = mockPrices[0];
    const sellPrice = mockPrices[mockPrices.length - 1];
    
    // Calculate basis points (should be 50 bps for 0.5% difference)
    const basisPoints = ((sellPrice.price - buyPrice.price) / buyPrice.price) * 10000;
    
    const expectedBasisPoints = 50; // 0.5% = 50 bps
    
    if (Math.abs(basisPoints - expectedBasisPoints) > 1) {
        throw new Error(`Basis points calculation error: expected ~${expectedBasisPoints}, got ${basisPoints.toFixed(0)}`);
    }
    
    return {
        mockPrices,
        buyPrice: buyPrice.price,
        sellPrice: sellPrice.price,
        basisPoints: Math.round(basisPoints),
        buyDex: buyPrice.dex,
        sellDex: sellPrice.dex,
        calculationCorrect: true
    };
});

// Test 8: File System Permissions
tester.addTest('File System Permissions', async () => {
    const fs = require('fs-extra');
    const path = require('path');
    
    const testDirectories = ['logs', 'cache'];
    const results = [];
    
    for (const dir of testDirectories) {
        try {
            const dirPath = path.join(__dirname, '..', dir);
            await fs.ensureDir(dirPath);
            
            // Test write permission
            const testFile = path.join(dirPath, 'test.txt');
            await fs.writeFile(testFile, 'test');
            await fs.remove(testFile);
            
            results.push({
                directory: dir,
                exists: true,
                writable: true,
                status: 'ok'
            });
        } catch (error) {
            results.push({
                directory: dir,
                exists: false,
                writable: false,
                status: 'error',
                error: error.message
            });
        }
    }
    
    const errors = results.filter(r => r.status === 'error');
    if (errors.length > 0) {
        throw new Error(`Directory permission errors: ${errors.map(e => e.directory).join(', ')}`);
    }
    
    return {
        directories: results,
        allAccessible: errors.length === 0
    };
});

// Test 9: Memory and Performance
tester.addTest('Memory and Performance', async () => {
    const memBefore = process.memoryUsage();
    
    // Simulate some work
    const testData = [];
    for (let i = 0; i < 1000; i++) {
        testData.push({
            id: i,
            data: Math.random().toString(36).repeat(10)
        });
    }
    
    const memAfter = process.memoryUsage();
    const memDiff = memAfter.heapUsed - memBefore.heapUsed;
    
    return {
        memoryBefore: Math.round(memBefore.heapUsed / 1024 / 1024) + ' MB',
        memoryAfter: Math.round(memAfter.heapUsed / 1024 / 1024) + ' MB',
        memoryIncrease: Math.round(memDiff / 1024 / 1024) + ' MB',
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime() + ' seconds'
    };
});

// Test 10: Complete Bot Workflow
tester.addTest('Complete Bot Workflow Simulation', async () => {
    if (!tester.provider || !tester.priceFetcher) {
        throw new Error('Prerequisites not met - need working RPC and price fetcher');
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
    
    const basisPoints = ((sellPrice.price - buyPrice.price) / buyPrice.price) * 10000;
    const hasArbitrage = basisPoints >= config.settings.minBasisPointsPerTrade;
    
    return {
        token: testToken,
        pricesChecked: priceResults.length,
        validPrices: validPrices.length,
        buyDex: buyPrice.dex,
        sellDex: sellPrice.dex,
        basisPoints: Math.round(basisPoints),
        hasArbitrage,
        wouldTriggerAlert: hasArbitrage && buyPrice.dex !== sellPrice.dex,
        workflow: 'completed'
    };
});

// Run all tests
if (require.main === module) {
    tester.run().then(() => {
        const failed = tester.results.filter(r => !r.success).length;
        process.exit(failed > 0 ? 1 : 0);
    }).catch(error => {
        console.error('Test suite failed to run:', error);
        process.exit(1);
    });
}

module.exports = TestSuite;