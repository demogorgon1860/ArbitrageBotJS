/**
 * ИСПРАВЛЕННЫЙ PriceFetcher - РАБОЧАЯ ВЕРСИЯ
 * Исправлена проблема с getReserves() в ethers.js v6
 */

const { ethers } = require('ethers');
const logger = require('./logger');

class PriceFetcher {
    constructor(provider) {
        this.provider = provider;
        this.cache = new Map();
        this.cacheTimeout = 30000;
        this.stablecoins = ['USDC', 'USDT'];
    }
    
    updateProvider(newProvider) {
        this.provider = newProvider;
        logger.logInfo('🔄 PriceFetcher provider updated');
    }
    
    async getTokenPrice(tokenSymbol, dexName, inputAmountUSD = 1000) {
        try {
            console.log(`\n🔍 Getting ${tokenSymbol} price from ${dexName}`);
            
            const config = require('../config/polygon.json');
            const token = config.tokens[tokenSymbol];
            const dex = config.dexes[dexName];
            
            if (!token || !dex) {
                throw new Error(`Missing configuration for ${tokenSymbol} on ${dexName}`);
            }
            
            console.log(`  📋 Token: ${token.address} (${token.decimals} decimals)`);
            console.log(`  🏪 DEX: ${dex.name} (${dex.type})`);
            
            // Если стейблкоин
            if (this.stablecoins.includes(tokenSymbol)) {
                console.log(`  💰 Stablecoin detected, returning $1.00`);
                return {
                    success: true,
                    price: 1.0,
                    liquidity: 1000000,
                    method: 'stablecoin',
                    dex: dexName,
                    path: [tokenSymbol],
                    estimatedSlippage: 0.01
                };
            }
            
            // Получаем торговые пути
            const availablePaths = config.tradingPaths[tokenSymbol] || [];
            console.log(`  🛣️ Available paths: ${availablePaths.length}`);
            
            // Пробуем пути к стейблкоинам
            const usdPaths = availablePaths.filter(path => 
                path.length === 2 && this.stablecoins.includes(path[1])
            );
            
            console.log(`  💵 USD paths found: ${usdPaths.length}`);
            
            for (const path of usdPaths) {
                console.log(`\n  🧪 Testing path: ${path.join(' → ')}`);
                
                try {
                    const result = await this.getDirectPairPrice(path, dex);
                    if (result.success) {
                        console.log(`    ✅ SUCCESS! Price: $${result.price.toFixed(4)}`);
                        return result;
                    } else {
                        console.log(`    ❌ Failed: ${result.error}`);
                    }
                } catch (error) {
                    console.log(`    ❌ Exception: ${error.message}`);
                }
            }
            
            // Пробуем пути через другие токены
            const otherPaths = availablePaths.filter(path => !usdPaths.includes(path));
            console.log(`\n  🔄 Trying ${otherPaths.length} conversion paths...`);
            
            for (const path of otherPaths) {
                console.log(`\n  🧪 Testing conversion: ${path.join(' → ')}`);
                
                try {
                    const pathResult = await this.getDirectPairPrice(path, dex);
                    if (pathResult.success) {
                        console.log(`    📊 Path price: ${pathResult.price.toFixed(6)} ${path[1]}`);
                        
                        // Конвертируем в USD
                        const usdPrice = await this.convertToUSD(pathResult.price, path[1], dex);
                        if (usdPrice > 0) {
                            console.log(`    ✅ USD price: $${usdPrice.toFixed(4)}`);
                            return {
                                ...pathResult,
                                price: usdPrice,
                                method: 'converted_to_usd'
                            };
                        } else {
                            console.log(`    ❌ Failed to convert to USD`);
                        }
                    }
                } catch (error) {
                    console.log(`    ❌ Exception: ${error.message}`);
                }
            }
            
            throw new Error('No working paths found');
            
        } catch (error) {
            console.log(`\n❌ Final error: ${error.message}`);
            return {
                success: false,
                error: error.message,
                price: 0,
                dex: dexName
            };
        }
    }
    
    async getDirectPairPrice(path, dex) {
        const config = require('../config/polygon.json');
        const tokenA = config.tokens[path[0]];
        const tokenB = config.tokens[path[1]];
        
        console.log(`      🔗 Testing pair: ${tokenA.address} / ${tokenB.address}`);
        
        try {
            // Получаем адрес пары
            const factoryABI = ["function getPair(address,address) external view returns (address)"];
            const factory = new ethers.Contract(dex.factory, factoryABI, this.provider);
            
            console.log(`      📞 Calling factory.getPair()...`);
            const pairAddress = await factory.getPair(tokenA.address, tokenB.address);
            
            console.log(`      📍 Pair address: ${pairAddress}`);
            
            if (pairAddress === '0x0000000000000000000000000000000000000000') {
                return {
                    success: false,
                    error: 'Pair does not exist'
                };
            }
            
            // ИСПРАВЛЕНО: Правильный ABI для getReserves в ethers.js v6
            const pairABI = [
                "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
                "function token0() external view returns (address)"
            ];
            
            console.log(`      📞 Reading reserves...`);
            const pair = new ethers.Contract(pairAddress, pairABI, this.provider);
            
            // ИСПРАВЛЕНО: Правильное получение данных в ethers.js v6
            const [reservesResult, token0Address] = await Promise.all([
                pair.getReserves(),
                pair.token0()
            ]);
            
            // ИСПРАВЛЕНО: В ethers.js v6 результат - это массив, а не объект
            const reserve0 = reservesResult[0]; // Первый элемент массива
            const reserve1 = reservesResult[1]; // Второй элемент массива
            
            console.log(`      📊 Reserve0: ${reserve0.toString()}`);
            console.log(`      📊 Reserve1: ${reserve1.toString()}`);
            console.log(`      🎯 Token0: ${token0Address}`);
            
            if (reserve0 == 0 || reserve1 == 0) {
                return {
                    success: false,
                    error: 'Empty reserves'
                };
            }
            
            // Определяем порядок токенов
            let reserveA, reserveB;
            if (token0Address.toLowerCase() === tokenA.address.toLowerCase()) {
                reserveA = parseFloat(ethers.formatUnits(reserve0, tokenA.decimals));
                reserveB = parseFloat(ethers.formatUnits(reserve1, tokenB.decimals));
                console.log(`      ✅ TokenA is token0`);
            } else {
                reserveA = parseFloat(ethers.formatUnits(reserve1, tokenA.decimals));
                reserveB = parseFloat(ethers.formatUnits(reserve0, tokenB.decimals));
                console.log(`      ✅ TokenA is token1`);
            }
            
            console.log(`      💧 ReserveA (${tokenA.symbol}): ${reserveA.toFixed(2)}`);
            console.log(`      💧 ReserveB (${tokenB.symbol}): ${reserveB.toFixed(2)}`);
            
            // Цена tokenA в tokenB
            const price = reserveB / reserveA;
            console.log(`      💱 Price: 1 ${tokenA.symbol} = ${price.toFixed(6)} ${tokenB.symbol}`);
            
            if (!isFinite(price) || price <= 0) {
                return {
                    success: false,
                    error: `Invalid price: ${price}`
                };
            }
            
            // Расчет ликвидности в USD (приблизительно)
            let liquidityUSD;
            if (this.stablecoins.includes(tokenB.symbol)) {
                liquidityUSD = reserveB * 2; // Для USD пар
            } else {
                liquidityUSD = Math.sqrt(reserveA * reserveB) * 2; // Геометрическое среднее
            }
            
            console.log(`      💧 Liquidity: $${(liquidityUSD/1000).toFixed(0)}K (estimated)`);
            
            return {
                success: true,
                price,
                liquidity: liquidityUSD,
                reserveA,
                reserveB,
                pairAddress,
                method: 'v2_direct',
                dex: dex.name,
                path: path,
                estimatedSlippage: this.calculateSlippage(1000, liquidityUSD)
            };
            
        } catch (error) {
            console.log(`      ❌ Error: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    async convertToUSD(price, tokenSymbol, dex) {
        console.log(`    🔄 Converting ${price.toFixed(6)} ${tokenSymbol} to USD...`);
        
        if (this.stablecoins.includes(tokenSymbol)) {
            console.log(`    💰 Already USD: $${price.toFixed(4)}`);
            return price;
        }
        
        try {
            let conversionPath;
            
            if (tokenSymbol === 'WMATIC') {
                conversionPath = ['WMATIC', 'USDC'];
            } else if (tokenSymbol === 'WETH') {
                conversionPath = ['WETH', 'USDC'];
            } else {
                console.log(`    ❌ Unknown conversion for ${tokenSymbol}`);
                return 0;
            }
            
            console.log(`    🛣️ Conversion path: ${conversionPath.join(' → ')}`);
            
            const conversionResult = await this.getDirectPairPrice(conversionPath, dex);
            if (conversionResult.success) {
                const usdPrice = price * conversionResult.price;
                console.log(`    ✅ ${price.toFixed(6)} ${tokenSymbol} × ${conversionResult.price.toFixed(4)} USD/${tokenSymbol} = $${usdPrice.toFixed(4)}`);
                return usdPrice;
            } else {
                console.log(`    ❌ Conversion failed: ${conversionResult.error}`);
                return 0;
            }
            
        } catch (error) {
            console.log(`    ❌ Conversion error: ${error.message}`);
            return 0;
        }
    }
    
    calculateSlippage(tradeAmountUSD, liquidityUSD) {
        if (!liquidityUSD || liquidityUSD <= 0) return 0.5;
        
        const ratio = tradeAmountUSD / liquidityUSD;
        if (ratio > 0.1) return 5.0;
        if (ratio > 0.05) return 2.0;
        if (ratio > 0.02) return 1.0;
        if (ratio > 0.01) return 0.5;
        return 0.1;
    }
    
    // Методы кэширования (упрощенные)
    getFromCache(key) { return null; }
    setCache(key, data) { }
    clearCache() { }
}

module.exports = PriceFetcher;