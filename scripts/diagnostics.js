const { ethers } = require('ethers');
require('dotenv').config();

const config = require('../config/polygon.json');
const logger = require('./logger');
const PriceFetcher = require('./priceFetcher');

class OnChainDiagnostics {
    constructor() {
        this.provider = null;
        this.priceFetcher = null;
        this.results = {
            rpcConnections: [],
            tokenValidation: [],
            dexValidation: [],
            priceTests: [],
            liquidityTests: []
        };
    }
    
    async run() {
        console.log('🔍 Starting On-Chain Diagnostics...\n');
        
        await this.testRPCConnections();
        await this.validateTokenContracts();
        await this.validateDEXRouters();
        await this.testRealPriceFetching();
        await this.testLiquidity();
        
        this.printReport();
    }
    
    async testRPCConnections() {
        console.log('🌐 Testing RPC Connections...');
        
        const rpcEndpoints = [];
        
        // Collect all RPC endpoints
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                rpcEndpoints.push(rpc);
            }
        }
        
        if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
            rpcEndpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
            rpcEndpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        // Test each RPC with detailed metrics
        for (const endpoint of rpcEndpoints) {
            try {
                const startTime = Date.now();
                const provider = new ethers.JsonRpcProvider(endpoint);
                
                const [network, blockNumber, gasPrice] = await Promise.race([
                    Promise.all([
                        provider.getNetwork(),
                        provider.getBlockNumber(),
                        provider.getFeeData()
                    ]),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Timeout after 10s')), 10000)
                    )
                ]);
                
                const responseTime = Date.now() - startTime;
                const endpointName = endpoint.split('/')[2];
                
                if (Number(network.chainId) === 137) {
                    this.results.rpcConnections.push({
                        endpoint: endpointName,
                        status: 'working',
                        responseTime,
                        blockNumber,
                        gasPrice: ethers.formatUnits(gasPrice.gasPrice, 'gwei'),
                        error: null
                    });
                    
                    // Use first working provider
                    if (!this.provider) {
                        this.provider = provider;
                        this.priceFetcher = new PriceFetcher(provider);
                    }
                    
                    console.log(`   ✅ ${endpointName}: ${responseTime}ms, block ${blockNumber}`);
                } else {
                    this.results.rpcConnections.push({
                        endpoint: endpointName,
                        status: 'wrong_network',
                        chainId: Number(network.chainId),
                        error: `Expected chain 137, got ${network.chainId}`
                    });
                    console.log(`   ❌ ${endpointName}: Wrong network (${network.chainId})`);
                }
                
            } catch (error) {
                const endpointName = endpoint.split('/')[2];
                this.results.rpcConnections.push({
                    endpoint: endpointName,
                    status: 'failed',
                    error: error.message
                });
                console.log(`   ❌ ${endpointName}: ${error.message}`);
            }
        }
        
        console.log('');
    }
    
    async validateTokenContracts() {
        console.log('🪙 Validating Token Contracts...');
        
        if (!this.provider) {
            console.log('   ❌ No working RPC provider available\n');
            return;
        }
        
        for (const [symbol, token] of Object.entries(config.tokens)) {
            try {
                const [code, balance] = await Promise.all([
                    this.provider.getCode(token.address),
                    this.provider.getBalance(token.address)
                ]);
                
                const isContract = code !== '0x';
                const hasBalance = balance > 0;
                
                // Try to get token info (if ERC20)
                let tokenInfo = null;
                if (isContract) {
                    try {
                        const tokenContract = new ethers.Contract(
                            token.address,
                            ['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
                            this.provider
                        );
                        
                        const [name, contractSymbol, decimals] = await Promise.allSettled([
                            tokenContract.name(),
                            tokenContract.symbol(),
                            tokenContract.decimals()
                        ]);
                        
                        tokenInfo = {
                            name: name.status === 'fulfilled' ? name.value : 'Unknown',
                            symbol: contractSymbol.status === 'fulfilled' ? contractSymbol.value : 'Unknown',
                            decimals: decimals.status === 'fulfilled' ? Number(decimals.value) : null
                        };
                    } catch (err) {
                        tokenInfo = { error: 'Not ERC20 or contract error' };
                    }
                }
                
                this.results.tokenValidation.push({
                    symbol,
                    address: token.address,
                    isContract,
                    hasBalance,
                    tokenInfo,
                    configDecimals: token.decimals
                });
                
                const statusIcon = isContract ? '✅' : '❌';
                const infoStr = tokenInfo ? `(${tokenInfo.symbol || 'Unknown'}, ${tokenInfo.decimals || '?'} decimals)` : '';
                console.log(`   ${statusIcon} ${symbol}: ${isContract ? 'Valid contract' : 'Not a contract'} ${infoStr}`);
                
            } catch (error) {
                this.results.tokenValidation.push({
                    symbol,
                    address: token.address,
                    error: error.message
                });
                console.log(`   ❌ ${symbol}: Error - ${error.message}`);
            }
        }
        
        console.log('');
    }
    
    async validateDEXRouters() {
        console.log('🏪 Validating DEX Routers...');
        
        if (!this.provider) {
            console.log('   ❌ No working RPC provider available\n');
            return;
        }
        
        for (const [dexName, dex] of Object.entries(config.dexes)) {
            try {
                const code = await this.provider.getCode(dex.router);
                const isContract = code !== '0x';
                
                // Try to call a simple function to verify it's a router
                let routerInfo = null;
                if (isContract) {
                    try {
                        const routerContract = new ethers.Contract(
                            dex.router,
                            ['function WETH() view returns (address)', 'function factory() view returns (address)'],
                            this.provider
                        );
                        
                        const [weth, factory] = await Promise.allSettled([
                            routerContract.WETH(),
                            routerContract.factory()
                        ]);
                        
                        routerInfo = {
                            weth: weth.status === 'fulfilled' ? weth.value : null,
                            factory: factory.status === 'fulfilled' ? factory.value : null
                        };
                    } catch (err) {
                        routerInfo = { error: 'Router function calls failed' };
                    }
                }
                
                this.results.dexValidation.push({
                    dexName,
                    router: dex.router,
                    type: dex.type,
                    isContract,
                    routerInfo
                });
                
                const statusIcon = isContract ? '✅' : '❌';
                const typeInfo = dex.type ? `(${dex.type})` : '';
                console.log(`   ${statusIcon} ${dexName}: ${isContract ? 'Valid router' : 'Not a contract'} ${typeInfo}`);
                
            } catch (error) {
                this.results.dexValidation.push({
                    dexName,
                    router: dex.router,
                    error: error.message
                });
                console.log(`   ❌ ${dexName}: Error - ${error.message}`);
            }
        }
        
        console.log('');
    }
    
    async testRealPriceFetching() {
        console.log('💰 Testing Real Price Fetching...');
        
        if (!this.priceFetcher) {
            console.log('   ❌ Price fetcher not available\n');
            return;
        }
        
        // Test a few key tokens on different DEXes
        const testCases = [
            { token: 'USDC', dex: 'sushiswap' },
            { token: 'WETH', dex: 'uniswap' },
            { token: 'LINK', dex: 'quickswap' },
            { token: 'WMATIC', dex: 'sushiswap' }
        ];
        
        for (const testCase of testCases) {
            try {
                console.log(`   🔍 Testing ${testCase.token} on ${testCase.dex}...`);
                
                const startTime = Date.now();
                const result = await this.priceFetcher.getTokenPrice(
                    testCase.token, 
                    testCase.dex, 
                    1000
                );
                const responseTime = Date.now() - startTime;
                
                this.results.priceTests.push({
                    ...testCase,
                    success: result.success,
                    price: result.price,
                    path: result.path,
                    method: result.method,
                    responseTime,
                    error: result.error
                });
                
                if (result.success && result.price > 0) {
                    console.log(`      ✅ Price: ${result.price} (${result.method}, ${responseTime}ms)`);
                    console.log(`      📍 Path: ${result.path ? result.path.join(' → ') : 'Direct'}`);
                } else {
                    console.log(`      ❌ Failed: ${result.error || 'Unknown error'}`);
                }
                
            } catch (error) {
                this.results.priceTests.push({
                    ...testCase,
                    success: false,
                    error: error.message
                });
                console.log(`      ❌ Error: ${error.message}`);
            }
        }
        
        console.log('');
    }
    
    async testLiquidity() {
        console.log('💧 Testing Liquidity...');
        
        if (!this.provider) {
            console.log('   ❌ No working RPC provider available\n');
            return;
        }
        
        // Test if major trading pairs have liquidity
        const testPairs = [
            { tokenA: 'USDC', tokenB: 'WETH', dex: 'uniswap' },
            { tokenA: 'WMATIC', tokenB: 'USDC', dex: 'sushiswap' },
            { tokenA: 'LINK', tokenB: 'WETH', dex: 'quickswap' }
        ];
        
        for (const pair of testPairs) {
            try {
                const tokenA = config.tokens[pair.tokenA];
                const tokenB = config.tokens[pair.tokenB];
                const dex = config.dexes[pair.dex];
                
                if (!tokenA || !tokenB || !dex) {
                    console.log(`   ❌ ${pair.tokenA}/${pair.tokenB} on ${pair.dex}: Missing configuration`);
                    continue;
                }
                
                // For V2 DEXes, try to check pair contract
                if (dex.type === 'v2') {
                    try {
                        const routerContract = new ethers.Contract(
                            dex.router,
                            ['function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'],
                            this.provider
                        );
                        
                        const amountIn = ethers.parseUnits('1', tokenA.decimals);
                        const path = [tokenA.address, tokenB.address];
                        
                        const amounts = await routerContract.getAmountsOut(amountIn, path);
                        const amountOut = amounts[amounts.length - 1];
                        
                        this.results.liquidityTests.push({
                            pair: `${pair.tokenA}/${pair.tokenB}`,
                            dex: pair.dex,
                            hasLiquidity: amountOut > 0,
                            amountOut: ethers.formatUnits(amountOut, tokenB.decimals)
                        });
                        
                        if (amountOut > 0) {
                            console.log(`   ✅ ${pair.tokenA}/${pair.tokenB} on ${pair.dex}: Has liquidity`);
                        } else {
                            console.log(`   ❌ ${pair.tokenA}/${pair.tokenB} on ${pair.dex}: No liquidity`);
                        }
                        
                    } catch (error) {
                        console.log(`   ❌ ${pair.tokenA}/${pair.tokenB} on ${pair.dex}: ${error.message}`);
                    }
                }
                
            } catch (error) {
                console.log(`   ❌ ${pair.tokenA}/${pair.tokenB} on ${pair.dex}: ${error.message}`);
            }
        }
        
        console.log('');
    }
    
    printReport() {
        console.log('📊 DIAGNOSTIC REPORT');
        console.log('='.repeat(60));
        
        // RPC Summary
        const workingRPCs = this.results.rpcConnections.filter(r => r.status === 'working');
        console.log(`\n🌐 RPC Connections: ${workingRPCs.length}/${this.results.rpcConnections.length} working`);
        
        // Token Summary
        const validTokens = this.results.tokenValidation.filter(t => t.isContract);
        console.log(`🪙 Token Contracts: ${validTokens.length}/${this.results.tokenValidation.length} valid`);
        
        // DEX Summary
        const validDEXes = this.results.dexValidation.filter(d => d.isContract);
        console.log(`🏪 DEX Routers: ${validDEXes.length}/${this.results.dexValidation.length} valid`);
        
        // Price Fetching Summary
        const successfulPrices = this.results.priceTests.filter(p => p.success);
        console.log(`💰 Price Fetching: ${successfulPrices.length}/${this.results.priceTests.length} successful`);
        
        // Liquidity Summary
        const liquidPairs = this.results.liquidityTests.filter(l => l.hasLiquidity);
        console.log(`💧 Liquidity Tests: ${liquidPairs.length}/${this.results.liquidityTests.length} have liquidity`);
        
        // Issues
        console.log('\n⚠️  POTENTIAL ISSUES:');
        
        // Failed price fetches
        const failedPrices = this.results.priceTests.filter(p => !p.success);
        if (failedPrices.length > 0) {
            console.log('\n   Failed Price Fetches:');
            failedPrices.forEach(p => {
                console.log(`   • ${p.token} on ${p.dex}: ${p.error}`);
            });
        }
        
        // Invalid tokens
        const invalidTokens = this.results.tokenValidation.filter(t => !t.isContract);
        if (invalidTokens.length > 0) {
            console.log('\n   Invalid Token Contracts:');
            invalidTokens.forEach(t => {
                console.log(`   • ${t.symbol}: ${t.error || 'Not a contract'}`);
            });
        }
        
        // Recommendations
        console.log('\n💡 RECOMMENDATIONS:');
        
        if (workingRPCs.length < 3) {
            console.log('   • Add more RPC endpoints for better reliability');
        }
        
        if (successfulPrices.length < this.results.priceTests.length * 0.8) {
            console.log('   • Check trading paths configuration');
            console.log('   • Increase RPC timeouts');
            console.log('   • Add more DEX endpoints');
        }
        
        if (liquidPairs.length < this.results.liquidityTests.length * 0.7) {
            console.log('   • Some trading pairs have low liquidity');
            console.log('   • Consider focusing on major pairs only');
        }
        
        console.log('\n✅ Diagnostics complete!');
        
        // Save report to file
        this.saveReport();
    }
    
    async saveReport() {
        try {
            const fs = require('fs-extra');
            const path = require('path');
            
            const reportDir = path.join(__dirname, '..', 'logs');
            await fs.ensureDir(reportDir);
            
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const reportFile = path.join(reportDir, `diagnostics-${timestamp}.json`);
            
            await fs.writeJson(reportFile, {
                timestamp: new Date().toISOString(),
                summary: {
                    rpcConnections: this.results.rpcConnections.length,
                    workingRPCs: this.results.rpcConnections.filter(r => r.status === 'working').length,
                    validTokens: this.results.tokenValidation.filter(t => t.isContract).length,
                    validDEXes: this.results.dexValidation.filter(d => d.isContract).length,
                    successfulPrices: this.results.priceTests.filter(p => p.success).length,
                    liquidPairs: this.results.liquidityTests.filter(l => l.hasLiquidity).length
                },
                details: this.results
            }, { spaces: 2 });
            
            console.log(`📄 Report saved to: ${reportFile}`);
            
        } catch (error) {
            console.error('Failed to save report:', error.message);
        }
    }
}

// Run diagnostics if this file is executed directly
if (require.main === module) {
    const diagnostics = new OnChainDiagnostics();
    diagnostics.run().catch(error => {
        console.error('Diagnostics failed:', error);
        process.exit(1);
    });
}

module.exports = OnChainDiagnostics;