#!/usr/bin/env node

/**
 * Быстрый тест для проверки V3 ликвидности
 * Запуск: node v3_liquidity_test.js
 */

require('dotenv').config();
const { ethers } = require('ethers');

class V3LiquidityTest {
    constructor() {
        this.provider = new ethers.JsonRpcProvider('https://polygon-rpc.com', 137);
        
        // Uniswap V3 на Polygon
        this.uniswapV3 = {
            factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
        };
        
        this.tokens = {
            WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
            USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'
        };
        
        this.factoryABI = [
            "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
        ];
        
        this.poolABI = [
            "function liquidity() external view returns (uint128)",
            "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
        ];
        
        this.quoterABI = [
            "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)"
        ];
    }
    
    async run() {
        console.log('🧪 V3 Liquidity Test - Polygon');
        console.log('═'.repeat(40));
        
        const testPairs = [
            { tokenA: 'WETH', tokenB: 'USDC', fees: [500, 3000, 10000] },
            { tokenA: 'WMATIC', tokenB: 'USDC', fees: [500, 3000, 10000] }
        ];
        
        for (const pair of testPairs) {
            console.log(`\n💎 Testing ${pair.tokenA}/${pair.tokenB} on Uniswap V3:`);
            await this.testPairAllFees(pair.tokenA, pair.tokenB, pair.fees);
        }
        
        console.log('\n📊 Summary:');
        console.log('If you see liquidity > $100K, V3 is working correctly!');
        console.log('If all pools show 0 or very low liquidity, there might be an issue.');
    }
    
    async testPairAllFees(tokenASymbol, tokenBSymbol, fees) {
        const tokenA = this.tokens[tokenASymbol];
        const tokenB = this.tokens[tokenBSymbol];
        
        const factory = new ethers.Contract(this.uniswapV3.factory, this.factoryABI, this.provider);
        
        for (const fee of fees) {
            try {
                console.log(`  🔍 Fee tier: ${fee/10000}%`);
                
                // Получаем адрес пула
                const poolAddress = await factory.getPool(tokenA, tokenB, fee);
                
                if (poolAddress === '0x0000000000000000000000000000000000000000') {
                    console.log(`    ❌ Pool doesn't exist`);
                    continue;
                }
                
                console.log(`    📍 Pool: ${poolAddress.slice(0,10)}...`);
                
                // Получаем данные пула
                const pool = new ethers.Contract(poolAddress, this.poolABI, this.provider);
                const [liquidity, slot0] = await Promise.all([
                    pool.liquidity(),
                    pool.slot0()
                ]);
                
                const liquidityFloat = Number(liquidity);
                const sqrtPriceX96 = slot0[0];
                
                // Простая оценка TVL
                let estimatedTVL = 0;
                if (tokenBSymbol === 'USDC') {
                    // Для пар с USDC
                    estimatedTVL = liquidityFloat / 1e15; // Приблизительная формула
                } else {
                    estimatedTVL = liquidityFloat / 1e16;
                }
                
                // Цветовая индикация
                let status = '🔴';
                if (estimatedTVL > 100000) status = '🟢';
                else if (estimatedTVL > 10000) status = '🟡';
                
                console.log(`    ${status} Liquidity: ~$${(estimatedTVL/1000).toFixed(0)}K`);
                console.log(`    📊 Raw liquidity: ${liquidityFloat.toExponential(2)}`);
                
                // Тест quote
                try {
                    const quoter = new ethers.Contract(this.uniswapV3.quoter, this.quoterABI, this.provider);
                    const inputAmount = ethers.parseUnits('1', tokenASymbol === 'USDC' ? 6 : 18);
                    
                    const amountOut = await quoter.quoteExactInputSingle.staticCall(
                        tokenA, tokenB, fee, inputAmount, 0
                    );
                    
                    const outputFormatted = ethers.formatUnits(amountOut, tokenBSymbol === 'USDC' ? 6 : 18);
                    console.log(`    💱 Quote: 1 ${tokenASymbol} = ${parseFloat(outputFormatted).toFixed(4)} ${tokenBSymbol}`);
                    
                } catch (quoteError) {
                    console.log(`    ⚠️ Quote failed: ${quoteError.message.slice(0,50)}...`);
                }
                
            } catch (error) {
                console.log(`    ❌ Error: ${error.message.slice(0,50)}...`);
            }
        }
    }
}

// Запуск теста
if (require.main === module) {
    const test = new V3LiquidityTest();
    test.run().catch(console.error);
}

module.exports = V3LiquidityTest;