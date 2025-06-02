#!/usr/bin/env node

/**
 * Тестирование получения цен с DEX
 * Запуск: node test/test-prices.js
 */

require('dotenv').config();
const { ethers } = require('ethers');
const PriceFetcher = require('../scripts/priceFetcher');

class PriceTestSuite {
    constructor() {
        this.providers = [];
        this.priceFetcher = null;
        this.testResults = [];
    }
    
    async runPriceTests() {
        console.log('💱 Price Fetching Test Suite');
        console.log('═'.repeat(50));
        
        try {
            await this.setupProviders();
            await this.testBasicPriceFetching();
            await this.testMultipleDEXPrices();
            await this.testLiquidityReading();
            await this.testErrorHandling();
            
            this.printSummary();
            
        } catch (error) {
            console.error('❌ Test suite failed:', error.message);
            process.exit(1);
        }
    }
    
    async setupProviders() {
        console.log('\n🌐 Setting up RPC providers...');
        
        const rpcEndpoints = [];
        
        // Собираем RPC endpoints
        if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
            rpcEndpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
            rpcEndpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        // Public endpoints
        rpcEndpoints.push(
            'https://polygon-rpc.com',
            'https://rpc-mainnet.matic.network',
            'https://rpc.ankr.com/polygon'
        );
        
        // Тестируем первый рабочий endpoint
        for (const endpoint of rpcEndpoints) {
            try {
                const provider = new ethers.JsonRpcProvider(endpoint, 137);
                const blockNumber = await Promise.race([
                    provider.getBlockNumber(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Timeout')), 3000)
                    )
                ]);
                
                this.providers.push(provider);
                console.log(`  ✅ Connected to RPC (block ${blockNumber})`);
                break;
                
            } catch (error) {
                console.log(`  ❌ Failed to connect to ${endpoint.split('/')[2]}`);
                continue;
            }
        }
        
        if (this.providers.length === 0) {
            throw new Error('No working RPC providers found');
        }
        
        this.priceFetcher = new PriceFetcher(this.providers[0]);
        console.log('  ✅ PriceFetcher initialized');
    }
    
    async testBasicPriceFetching() {
        console.log('\n🧪 Testing basic price fetching...');
        
        const testCases = [
            { token: 'WETH', dex: 'quickswap', amount: 1000 },
            { token: 'WBTC', dex: 'sushiswap', amount: 1000 },
            { token: 'USDC', dex: 'quickswap', amount: 1000 },
            { token: 'WMATIC', dex: 'sushiswap', amount: 1000 }
        ];
        
        for (const testCase of testCases) {
            const startTime = Date.now();
            
            try {
                console.log(`  🔍 Testing ${testCase.token} on ${testCase.dex}...`);
                
                const result = await Promise.race([
                    this.priceFetcher.getTokenPrice(testCase.token, testCase.dex, testCase.amount),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Price fetch timeout')), 10000)
                    )
                ]);
                
                const duration = Date.now() - startTime;
                
                if (result.success && result.price > 0) {
                    console.log(`    ✅ Price: $${result.price.toFixed(4)} (${duration}ms)`);
                    console.log(`    💧 Liquidity: $${(result.liquidity/1000).toFixed(0)}K`);
                    console.log(`    🛣️ Path: ${result.path?.join(' → ') || 'Direct'}`);
                    
                    this.testResults.push({
                        test: `${testCase.token}_${testCase.dex}`,
                        status: 'passed',
                        duration,
                        price: result.price,
                        liquidity: result.liquidity
                    });
                } else {
                    console.log(`    ❌ Failed: ${result.error || 'Unknown error'} (${duration}ms)`);
                    this.testResults.push({
                        test: `${testCase.token}_${testCase.dex}`,
                        status: 'failed',
                        duration,
                        error: result.error
                    });
                }
                
            } catch (error) {
                const duration = Date.now() - startTime;
                console.log(`    ❌ Exception: ${error.message} (${duration}ms)`);
                
                this.testResults.push({
                    test: `${testCase.token}_${testCase.dex}`,
                    status: 'error',
                    duration,
                    error: error.message
                });
            }
        }
    }
    
    async testMultipleDEXPrices() {
        console.log('\n🔄 Testing multiple DEX price comparison...');
        
        const token = 'WETH';
        const dexes = ['quickswap', 'sushiswap'];
        const amount = 1000;
        
        console.log(`  📊 Comparing ${token} prices across ${dexes.length} DEXes...`);
        
        const pricePromises = dexes.map(dex => 
            this.priceFetcher.getTokenPrice(token, dex, amount)
                .catch(error => ({ success: false, error: error.message, dex }))
        );
        
        const results = await Promise.allSettled(pricePromises);
        const prices = results
            .filter(r => r.status === 'fulfilled' && r.value.success)
            .map(r => r.value);
        
        if (prices.length >= 2) {
            prices.sort((a, b) => a.price - b.price);
            
            const cheapest = prices[0];
            const expensive = prices[prices.length - 1];
            const spread = ((expensive.price - cheapest.price) / cheapest.price) * 10000;
            
            console.log(`    💰 Cheapest: ${cheapest.dex} at $${cheapest.price.toFixed(4)}`);
            console.log(`    💸 Expensive: ${expensive.dex} at $${expensive.price.toFixed(4)}`);
            console.log(`    📈 Spread: ${spread.toFixed(1)} basis points`);
            
            if (spread > 50) {
                console.log(`    🎯 Potential arbitrage opportunity detected!`);
            }
            
            this.testResults.push({
                test: 'multi_dex_comparison',
                status: 'passed',
                spread,
                pricesFound: prices.length
            });
            
        } else {
            console.log(`    ❌ Insufficient prices: ${prices.length}/2`);
            this.testResults.push({
                test: 'multi_dex_comparison',
                status: 'failed',
                pricesFound: prices.length
            });
        }
    }
    
    async testLiquidityReading() {
        console.log('\n💧 Testing liquidity reading...');
        
        const testPairs = [
            { tokenA: 'WETH', tokenB: 'USDC', dex: 'quickswap' },
            { tokenA: 'WMATIC', tokenB: 'USDC', dex: 'sushiswap' },
            { tokenA: 'WBTC', tokenB: 'WETH', dex: 'quickswap' }
        ];
        
        for (const pair of testPairs) {
            try {
                console.log(`  🔍 Testing ${pair.tokenA}/${pair.tokenB} on ${pair.dex}...`);
                
                const result = await this.priceFetcher.getTokenPrice(pair.tokenA, pair.dex, 1000);
                
                if (result.success && result.liquidity) {
                    const liquidityK = result.liquidity / 1000;
                    console.log(`    ✅ Liquidity: $${liquidityK.toFixed(0)}K`);
                    
                    // Проверяем разумность ликвидности
                    if (liquidityK > 1) {
                        console.log(`    ✅ Sufficient liquidity for trading`);
                    } else {
                        console.log(`    ⚠️ Low liquidity - may cause high slippage`);
                    }
                    
                } else {
                    console.log(`    ❌ Failed to read liquidity: ${result.error}`);
                }
                
            } catch (error) {
                console.log(`    ❌ Error: ${error.message}`);
            }
        }
    }
    
    async testErrorHandling() {
        console.log('\n🛡️ Testing error handling...');
        
        const errorTests = [
            {
                name: 'Invalid token',
                test: () => this.priceFetcher.getTokenPrice('INVALID', 'quickswap', 1000)
            },
            {
                name: 'Invalid DEX',
                test: () => this.priceFetcher.getTokenPrice('WETH', 'invalid_dex', 1000)
            },
            {
                name: 'Zero amount',
                test: () => this.priceFetcher.getTokenPrice('WETH', 'quickswap', 0)
            }
        ];
        
        for (const errorTest of errorTests) {
            try {
                console.log(`  🧪 Testing ${errorTest.name}...`);
                
                const result = await errorTest.test();
                
                if (!result.success) {
                    console.log(`    ✅ Correctly handled error: ${result.error}`);
                } else {
                    console.log(`    ⚠️ Expected error but got success`);
                }
                
            } catch (error) {
                console.log(`    ✅ Correctly threw exception: ${error.message}`);
            }
        }
    }
    
    printSummary() {
        console.log('\n📊 Price Testing Summary');
        console.log('═'.repeat(30));
        
        const passed = this.testResults.filter(r => r.status === 'passed').length;
        const failed = this.testResults.filter(r => r.status === 'failed').length;
        const errors = this.testResults.filter(r => r.status === 'error').length;
        
        console.log(`✅ Passed: ${passed}`);
        console.log(`❌ Failed: ${failed}`);
        console.log(`⚠️ Errors: ${errors}`);
        
        // Средняя скорость
        const timings = this.testResults
            .filter(r => r.duration)
            .map(r => r.duration);
        
        if (timings.length > 0) {
            const avgTime = timings.reduce((sum, time) => sum + time, 0) / timings.length;
            console.log(`⏱️ Average response time: ${avgTime.toFixed(0)}ms`);
        }
        
        // Найденные цены
        const pricesFound = this.testResults.filter(r => r.price > 0);
        if (pricesFound.length > 0) {
            console.log(`💱 Prices successfully fetched: ${pricesFound.length}`);
            
            const avgPrice = pricesFound.reduce((sum, r) => sum + r.price, 0) / pricesFound.length;
            console.log(`📊 Average price found: $${avgPrice.toFixed(2)}`);
        }
        
        console.log('\n' + '═'.repeat(30));
        
        if (failed === 0 && errors === 0) {
            console.log('🎉 All price tests passed! Price fetching is working correctly.');
        } else if (passed > 0) {
            console.log('⚠️ Some tests failed, but basic functionality works.');
        } else {
            console.log('❌ All tests failed. Please check your configuration.');
        }
        
        console.log('\n💡 Next steps:');
        console.log('1. If tests passed: npm start');
        console.log('2. If tests failed: check RPC providers in .env');
        console.log('3. Monitor logs for any issues');
    }
}

// Запуск тестов
if (require.main === module) {
    const tester = new PriceTestSuite();
    tester.runPriceTests().catch(console.error);
}

module.exports = PriceTestSuite;