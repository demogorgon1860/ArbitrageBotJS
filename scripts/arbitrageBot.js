/**
 * Обновленный ArbitrageBot с улучшенным анализом ликвидности
 * Новые возможности:
 * - Точное отображение малых резервов
 * - Отслеживание ликвидности по всей цепочке multi-hop
 * - Детальная диагностика проблем с ликвидностью
 * - Улучшенные уведомления с breakdown ликвидности
 */

const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

const config = require('../config/polygon.json');
const logger = require('./logger'); // Используем обновленный logger
const telegramNotifier = require('./telegram');
const EnhancedPriceFetcher = require('./priceFetcher'); // Используем новый PriceFetcher
const ArbitrageTimeCalculator = require('./timeCalculator');
const {
    calculateBasisPoints,
    createNotificationId,
    isDuplicateNotification,
    saveNotificationsCache,
    loadNotificationsCache,
    getCurrentTimestamp,
    sleep
} = require('./utils');

class EnhancedArbitrageBot {
    constructor() {
        this.providers = [];
        this.currentProviderIndex = 0;
        this.recentNotifications = new Map();
        this.isRunning = false;
        this.isInitialized = false;
        this.startTime = Date.now();
        this.priceFetcher = null;
        this.timeCalculator = null;
        this.lastSuccessfulCheck = null;
        this.initializationPromise = null;
        
        // Расширенная статистика с ликвидностью
        this.stats = {
            totalChecks: 0,
            opportunitiesFound: 0,
            viableOpportunities: 0,
            profitableOpportunities: 0,
            skippedByTime: 0,
            skippedByLiquidity: 0,
            skippedByCost: 0,
            errors: 0,
            rpcFailovers: 0,
            lastCheck: null,
            successfulPriceFetches: 0,
            failedPriceFetches: 0,
            totalPotentialProfit: 0,
            averageSpread: 0,
            bestOpportunity: null,
            
            // НОВАЯ статистика ликвидности
            liquidityStats: {
                totalLiquidityAnalyzed: 0,
                averageLiquidity: 0,
                lowLiquidityPairs: 0,
                highLiquidityPairs: 0,
                multiHopOpportunities: 0,
                liquidityIssuesDetected: 0
            },
            
            // Детальная статистика отбрасывания
            rejectionStats: {
                lowLiquidity: 0,
                lowSpread: 0,
                lowConfidence: 0,
                highSlippage: 0,
                lowProfit: 0,
                fetchError: 0,
                noPath: 0,
                pairNotExists: 0
            }
        };
        
        // Настройки производительности
        this.performanceSettings = {
            batchSize: config.settings?.performanceOptimizations?.batchSize || 2,
            maxConcurrentDEX: config.settings?.performanceOptimizations?.maxConcurrentDEX || 2,
            priceTimeout: config.settings?.priceTimeoutMs || 15000,
            retryAttempts: config.settings?.maxRetries || 3,
            cooldownBetweenBatches: config.settings?.performanceOptimizations?.cooldownBetweenBatches || 2000,
            initializationTimeout: config.settings?.initializationTimeoutMs || 30000
        };
        
        // Получаем активную стратегию
        this.activeStrategy = this.getActiveStrategy();
        logger.logInfo(`🎯 Active strategy: ${this.activeStrategy.name}`);
    }
    
    /**
     * Получение активной стратегии
     */
    getActiveStrategy() {
        const strategies = config.strategies;
        const defaultStrategy = strategies?.defaultStrategy || 'conservative';
        const strategyConfig = strategies?.[defaultStrategy] || strategies?.conservative;
        
        if (!strategyConfig) {
            return {
                name: 'fallback',
                minBasisPoints: 30,
                minConfidence: 0.5,
                enableLowLiquidityTokens: false,
                enableMultiHop: true,
                maxSlippagePercent: 3.0
            };
        }
        
        return {
            name: defaultStrategy,
            ...strategyConfig
        };
    }
    
    // Методы инициализации (остаются прежними)
    async init() {
        if (this.initializationPromise) {
            return this.initializationPromise;
        }
        
        this.initializationPromise = this._performInitialization();
        return this.initializationPromise;
    }
    
    async _performInitialization() {
        try {
            logger.logInfo('🚀 Initializing Enhanced Arbitrage Bot with Liquidity Analysis...');
            logger.logInfo(`📊 Strategy: ${this.activeStrategy.name}`);
            
            await this.setupProviders();
            
            if (this.providers.length === 0) {
                throw new Error('No working RPC providers found');
            }
            
            // Инициализация Enhanced PriceFetcher
            try {
                this.priceFetcher = new EnhancedPriceFetcher(this.getProvider());
                logger.logInfo('✅ Enhanced PriceFetcher initialized successfully');
            } catch (error) {
                logger.logError('Failed to initialize Enhanced PriceFetcher', error);
                throw new Error(`PriceFetcher initialization failed: ${error.message}`);
            }
            
            // Инициализация TimeCalculator
            try {
                this.timeCalculator = new ArbitrageTimeCalculator();
                logger.logInfo('✅ TimeCalculator initialized');
            } catch (error) {
                logger.logWarning('⚠️ TimeCalculator initialization failed, using simplified calculations', error.message);
                this.timeCalculator = null;
            }
            
            await Promise.all([
                this.loadNotificationsCache(),
                this.validateConfiguration(),
                this.testConnections()
            ]);
            
            this.isInitialized = true;
            logger.logSuccess('✅ Enhanced arbitrage bot with liquidity analysis initialized successfully');
            
        } catch (error) {
            logger.logError('❌ Failed to initialize enhanced bot', error);
            this.isInitialized = false;
            throw error;
        }
    }
    
    // Методы настройки провайдеров (остаются прежними)
    async setupProviders() {
        logger.logInfo('🌐 Setting up RPC providers...');
        
        const rpcEndpoints = this.collectRPCEndpoints();
        logger.logInfo(`Found ${rpcEndpoints.length} potential RPC endpoints`);
        
        if (rpcEndpoints.length === 0) {
            throw new Error('No RPC endpoints configured. Please check your .env file.');
        }
        
        const providerPromises = rpcEndpoints.slice(0, 8).map(endpoint => 
            this.testAndCreateProvider(endpoint)
        );
        
        const results = await Promise.allSettled(providerPromises);
        
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                this.providers.push(result.value);
                if (this.providers.length >= 5) break;
            }
        }
        
        if (this.providers.length === 0) {
            throw new Error('No working RPC providers found');
        }
        
        logger.logSuccess(`✅ Connected to ${this.providers.length} RPC providers`);
    }
    
    collectRPCEndpoints() {
        const endpoints = [];
        
        if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
            endpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
            endpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                endpoints.push(rpc);
            }
        }
        
        const publicEndpoints = [
            "https://polygon-rpc.com",
            "https://rpc.ankr.com/polygon",
            "https://rpc-mainnet.matic.network",
            "https://matic-mainnet.chainstacklabs.com"
        ];
        
        endpoints.push(...publicEndpoints);
        return [...new Set(endpoints)];
    }
    
    async testAndCreateProvider(endpoint) {
        try {
            const provider = new ethers.JsonRpcProvider(endpoint, 137, {
                staticNetwork: true,
                batchMaxCount: 1
            });
            
            const blockNumber = await Promise.race([
                provider.getBlockNumber(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Connection timeout')), 5000)
                )
            ]);
            
            const network = await provider.getNetwork();
            if (Number(network.chainId) !== 137) {
                throw new Error(`Wrong network: expected 137, got ${network.chainId}`);
            }
            
            logger.logInfo(`✅ Connected to RPC: ${endpoint.split('/')[2]} (block ${blockNumber})`);
            return provider;
            
        } catch (error) {
            logger.logWarning(`❌ Failed to connect to RPC: ${endpoint.split('/')[2]} - ${error.message}`);
            return null;
        }
    }
    
    getProvider() {
        if (this.providers.length === 0) {
            throw new Error('No RPC providers available');
        }
        return this.providers[this.currentProviderIndex];
    }
    
    // Основные методы проверки арбитража с улучшенным анализом ликвидности
    
    async checkAllTokens() {
        if (!this.priceFetcher) {
            logger.logError('❌ PriceFetcher not available, skipping check');
            return;
        }
        
        const tokens = Object.keys(config.tokens);
        const startTime = Date.now();
        
        this.stats.totalChecks++;
        this.stats.lastCheck = getCurrentTimestamp();
        
        logger.logInfo(`🔍 Enhanced check: ${tokens.length} tokens for arbitrage opportunities...`);
        logger.logInfo(`   🎯 Strategy: ${this.activeStrategy.name} (${this.activeStrategy.minBasisPoints} bps, ${(this.activeStrategy.minConfidence*100).toFixed(1)}% confidence)`);
        
        const opportunities = [];
        const rejectedOpportunities = [];
        const liquidityResults = [];
        
        // Обработка токенов батчами
        for (let i = 0; i < tokens.length; i += this.performanceSettings.batchSize) {
            const batch = tokens.slice(i, i + this.performanceSettings.batchSize);
            
            const batchPromises = batch.map(async (token) => {
                try {
                    const result = await this.findArbitrageOpportunityWithLiquidity(token);
                    if (result && result.success) {
                        opportunities.push(result.opportunity);
                        this.stats.opportunitiesFound++;
                        
                        // Обновляем статистику ликвидности
                        this.updateLiquidityStats(result.opportunity);
                        
                        if (!this.stats.bestOpportunity || result.opportunity.basisPoints > this.stats.bestOpportunity.basisPoints) {
                            this.stats.bestOpportunity = {
                                token: result.opportunity.token,
                                basisPoints: result.opportunity.basisPoints,
                                adjustedProfit: result.opportunity.adjustedProfit,
                                timestamp: result.opportunity.timestamp,
                                liquidityDetails: {
                                    buyLiquidity: result.opportunity.buyLiquidity,
                                    sellLiquidity: result.opportunity.sellLiquidity,
                                    effectiveLiquidity: Math.min(result.opportunity.buyLiquidity, result.opportunity.sellLiquidity)
                                }
                            };
                        }
                    } else if (result) {
                        rejectedOpportunities.push(result);
                        this.updateRejectionStats(result.rejectionReason);
                        
                        // Сохраняем данные о ликвидности даже для отклоненных возможностей
                        if (result.liquidityData) {
                            liquidityResults.push({
                                token,
                                dex: result.dex || 'unknown',
                                liquidity: result.liquidityData.liquidity || 0,
                                success: false,
                                rejectionReason: result.rejectionReason
                            });
                        }
                    }
                    return result;
                } catch (error) {
                    logger.logError(`Error checking ${token}`, error);
                    this.stats.errors++;
                    return { success: false, rejectionReason: 'error', error: error.message, token };
                }
            });
            
            await Promise.allSettled(batchPromises);
            
            if (i + this.performanceSettings.batchSize < tokens.length) {
                await sleep(this.performanceSettings.cooldownBetweenBatches);
            }
        }
        
        const checkDuration = Date.now() - startTime;
        
        if (opportunities.length > 0) {
            opportunities.sort((a, b) => {
                const scoreA = (a.adjustedProfit || 0) * (a.confidence || 0.5);
                const scoreB = (b.adjustedProfit || 0) * (b.confidence || 0.5);
                return scoreB - scoreA;
            });
            
            logger.logSuccess(`✅ Found ${opportunities.length} viable opportunities in ${checkDuration}ms`);
            
            // Логируем детальную информацию о ликвидности для лучших возможностей
            for (const opportunity of opportunities.slice(0, 3)) {
                logger.logArbitrageWithLiquidity(opportunity);
                await this.processOpportunityWithLiquidity(opportunity);
            }
            
            this.updateProfitStatistics(opportunities);
            
        } else {
            logger.logInfo(`🔍 No viable opportunities found in ${checkDuration}ms`);
            
            // НОВАЯ детальная диагностика отклонений с анализом ликвидности
            this.logRejectionSummaryWithLiquidity(rejectedOpportunities);
            await this.diagnosticLiquidityCheck(liquidityResults);
        }
        
        this.lastSuccessfulCheck = Date.now();
    }
    
    /**
     * НОВЫЙ: Поиск арбитража с детальным анализом ликвидности
     */
    async findArbitrageOpportunityWithLiquidity(tokenSymbol) {
        try {
            const inputAmountUSD = config.settings.inputAmountUSD;
            const dexNames = Object.keys(config.dexes);
            
            logger.logDebug(`🔍 Checking ${tokenSymbol} across ${dexNames.length} DEXes with liquidity analysis`);
            
            // Получаем цены со всех DEX с детальной информацией о ликвидности
            const priceResults = await this.getOptimizedPricesWithLiquidity(tokenSymbol, dexNames, inputAmountUSD);
            
            this.stats.successfulPriceFetches += priceResults.filter(r => r.success).length;
            this.stats.failedPriceFetches += priceResults.filter(r => !r.success).length;
            
            // Фильтруем валидные цены с учетом ликвидности
            const validPrices = priceResults.filter(result => 
                result.success && 
                result.price > 0 && 
                typeof result.price === 'number' && 
                !isNaN(result.price) &&
                isFinite(result.price) &&
                result.liquidity !== undefined
            );
            
            if (validPrices.length < 2) {
                logger.logDebug(`❌ Insufficient valid prices for ${tokenSymbol}: ${validPrices.length}/2`);
                return {
                    success: false,
                    rejectionReason: 'insufficient_prices',
                    details: `Only ${validPrices.length}/2 valid prices`,
                    token: tokenSymbol
                };
            }
            
            // НОВЫЙ: Логируем сравнение ликвидности между DEX
            if (typeof logger.logLiquidityComparison === 'function') {
                logger.logLiquidityComparison(tokenSymbol, validPrices);
            }
            
            // Применяем фильтр ликвидности на основе стратегии
            const liquidPrices = this.filterByLiquidityWithDetails(validPrices, tokenSymbol);
            
            if (liquidPrices.length < 2) {
                // Детальная диагностика проблем с ликвидностью
                const liquidityIssues = this.diagnoseLiquidityIssues(validPrices, tokenSymbol);
                if (typeof logger.logLiquidityIssues === 'function') {
                    logger.logLiquidityIssues(tokenSymbol, liquidityIssues);
                }
                
                return {
                    success: false,
                    rejectionReason: 'low_liquidity',
                    details: `Only ${liquidPrices.length} prices passed liquidity filter`,
                    token: tokenSymbol,
                    liquidityData: {
                        validPrices: validPrices.length,
                        liquidPrices: liquidPrices.length,
                        issues: liquidityIssues
                    }
                };
            }
            
            // Сортируем по цене
            liquidPrices.sort((a, b) => a.price - b.price);
            
            const buyPrice = liquidPrices[0]; // Самая низкая цена
            const sellPrice = liquidPrices[liquidPrices.length - 1]; // Самая высокая цена
            
            if (buyPrice.dex === sellPrice.dex) {
                return {
                    success: false,
                    rejectionReason: 'same_dex',
                    details: `Best prices on same DEX: ${buyPrice.dex}`,
                    token: tokenSymbol
                };
            }
            
            // Расчет спреда с учетом активной стратегии
            const basisPoints = calculateBasisPoints(sellPrice.price, buyPrice.price);
            const minBasisPoints = this.activeStrategy.minBasisPoints;
            
            if (basisPoints < minBasisPoints) {
                logger.logDebug(`❌ Spread too low for ${tokenSymbol}: ${basisPoints} < ${minBasisPoints} bps`);
                return {
                    success: false,
                    rejectionReason: 'low_spread',
                    details: `Spread ${basisPoints} < ${minBasisPoints} bps`,
                    token: tokenSymbol,
                    actualSpread: basisPoints
                };
            }
            
            const percentage = basisPoints / 100;
            const potentialProfit = inputAmountUSD * (percentage / 100);
            
            // Создаем базовую возможность с детальной информацией о ликвидности
            const opportunity = {
                token: tokenSymbol,
                buyDex: buyPrice.dex,
                sellDex: sellPrice.dex,
                buyPrice: buyPrice.price,
                sellPrice: sellPrice.price,
                basisPoints,
                percentage,
                inputAmount: inputAmountUSD,
                potentialProfit,
                buyPath: buyPrice.path,
                sellPath: sellPrice.path,
                buyMethod: buyPrice.method,
                sellMethod: sellPrice.method,
                buyLiquidity: buyPrice.liquidity,
                sellLiquidity: sellPrice.liquidity,
                
                // НОВЫЕ поля для детального анализа ликвидности
                buyLiquidityBreakdown: buyPrice.liquidityBreakdown,
                sellLiquidityBreakdown: sellPrice.liquidityBreakdown,
                effectiveLiquidity: Math.min(buyPrice.liquidity, sellPrice.liquidity),
                liquidityRatio: Math.max(buyPrice.liquidity, sellPrice.liquidity) / Math.min(buyPrice.liquidity, sellPrice.liquidity),
                
                estimatedSlippage: {
                    buy: buyPrice.estimatedSlippage || 0.3,
                    sell: sellPrice.estimatedSlippage || 0.3
                },
                timestamp: getCurrentTimestamp()
            };
            
            // Расчет времени и жизнеспособности
            let timingData = await this.calculateTiming(opportunity);
            
            if (!timingData || !timingData.isViable) {
                return {
                    success: false,
                    rejectionReason: 'timing_analysis',
                    details: 'Failed timing viability check',
                    token: tokenSymbol
                };
            }
            
            // Добавляем данные о времени к возможности
            Object.assign(opportunity, {
                timing: timingData,
                adjustedProfit: timingData.adjustedProfit?.adjustedProfit || (potentialProfit * 0.7),
                confidence: timingData.confidence || 0.6,
                executionWindow: timingData.executionTime || 10000,
                deadline: timingData.deadline || (Date.now() + 15000)
            });
            
            this.stats.viableOpportunities++;
            
            // Проверяем прибыльность после всех затрат
            const minProfitThreshold = config.settings?.profitThresholds?.minimum || 3;
            if (opportunity.adjustedProfit > minProfitThreshold) {
                this.stats.profitableOpportunities++;
                
                logger.logSuccess(`💰 PROFITABLE ARBITRAGE: ${tokenSymbol}`, {
                    spread: `${basisPoints} bps`,
                    grossProfit: `${potentialProfit.toFixed(2)}`,
                    netProfit: `${opportunity.adjustedProfit.toFixed(2)}`,
                    confidence: `${(opportunity.confidence * 100).toFixed(1)}%`,
                    buyDex: buyPrice.dex,
                    sellDex: sellPrice.dex,
                    strategy: this.activeStrategy.name,
                    buyLiquidity: `${(opportunity.buyLiquidity/1000).toFixed(1)}K`,
                    sellLiquidity: `${(opportunity.sellLiquidity/1000).toFixed(1)}K`,
                    effectiveLiquidity: `${(opportunity.effectiveLiquidity/1000).toFixed(1)}K`
                });
                
                return {
                    success: true,
                    opportunity: opportunity
                };
            } else {
                return {
                    success: false,
                    rejectionReason: 'low_profit',
                    details: `Profit ${opportunity.adjustedProfit.toFixed(2)} < ${minProfitThreshold}`,
                    token: tokenSymbol
                };
            }
            
        } catch (error) {
            logger.logError(`❌ Error finding arbitrage for ${tokenSymbol}`, error);
            this.stats.errors++;
            
            // Переключение провайдера при сетевых ошибках
            if (error.message.includes('timeout') || error.message.includes('network')) {
                await this.switchProvider();
            }
            
            return {
                success: false,
                rejectionReason: 'fetch_error',
                details: error.message,
                token: tokenSymbol
            };
        }
    }
    
    /**
     * НОВЫЙ: Получение цен с детальной информацией о ликвидности
     */
    async getOptimizedPricesWithLiquidity(tokenSymbol, dexNames, inputAmountUSD) {
        if (!this.priceFetcher) {
            logger.logError('❌ PriceFetcher not initialized');
            return dexNames.map(dexName => ({
                price: 0,
                liquidity: 0,
                liquidityBreakdown: { totalLiquidity: 0, method: 'error', steps: [] },
                path: null,
                method: null,
                dex: dexName,
                success: false,
                error: 'PriceFetcher not initialized'
            }));
        }
        
        const pricePromises = dexNames.slice(0, this.performanceSettings.maxConcurrentDEX).map(dexName =>
            Promise.race([
                this.priceFetcher.getTokenPrice(tokenSymbol, dexName, inputAmountUSD),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Price fetch timeout')), this.performanceSettings.priceTimeout)
                )
            ]).catch(error => ({
                price: 0,
                liquidity: 0,
                liquidityBreakdown: { totalLiquidity: 0, method: 'error', steps: [] },
                path: null,
                method: null,
                dex: dexName,
                success: false,
                error: error.message
            }))
        );
        
        try {
            const results = await Promise.allSettled(pricePromises);
            
            return results.map((result, index) => {
                if (result.status === 'fulfilled') {
                    const priceData = result.value;
                    
                    // Логируем детальную информацию о ликвидности
                    if (priceData.success && typeof logger.logLiquidityDetails === 'function') {
                        logger.logLiquidityDetails(tokenSymbol, dexNames[index], priceData);
                    }
                    
                    return priceData;
                } else {
                    return {
                        price: 0,
                        liquidity: 0,
                        liquidityBreakdown: { totalLiquidity: 0, method: 'promise_error', steps: [] },
                        path: null,
                        method: null,
                        dex: dexNames[index],
                        success: false,
                        error: result.reason?.message || 'Unknown error'
                    };
                }
            });
            
        } catch (error) {
            logger.logError('Failed to get optimized prices with liquidity', error);
            return dexNames.map(dexName => ({
                price: 0,
                liquidity: 0,
                liquidityBreakdown: { totalLiquidity: 0, method: 'catch_error', steps: [] },
                path: null,
                method: null,
                dex: dexName,
                success: false,
                error: error.message
            }));
        }
    }
    
    /**
     * НОВЫЙ: Фильтрация по ликвидности с детальным анализом
     */
    filterByLiquidityWithDetails(validPrices, tokenSymbol) {
        if (this.activeStrategy.enableLowLiquidityTokens) {
            // Если стратегия разрешает низкую ликвидность, используем очень низкий порог
            return validPrices.filter(result => {
                const hasMinimalLiquidity = result.liquidity && result.liquidity > 10; // Минимум $10
                
                if (!hasMinimalLiquidity) {
                    logger.logDebug(`🔍 ${tokenSymbol} on ${result.dex}: Below minimal liquidity threshold (${result.liquidity?.toFixed(2) || 0})`);
                }
                
                return hasMinimalLiquidity;
            });
        }
        
        // Стандартная фильтрация на основе конфига
        const minLiquidity = this.getMinLiquidityThreshold(tokenSymbol);
        return validPrices.filter(result => {
            const meetsThreshold = result.liquidity && result.liquidity >= minLiquidity;
            
            if (!meetsThreshold) {
                logger.logDebug(`🔍 ${tokenSymbol} on ${result.dex}: Below liquidity threshold (${result.liquidity?.toFixed(2) || 0} < ${minLiquidity})`);
            }
            
            return meetsThreshold;
        });
    }
    
    /**
     * НОВЫЙ: Диагностика проблем с ликвидностью
     */
    diagnoseLiquidityIssues(validPrices, tokenSymbol) {
        const issues = [];
        
        validPrices.forEach(priceData => {
            const liquidity = priceData.liquidity || 0;
            const dex = priceData.dex;
            
            if (liquidity === 0) {
                issues.push({
                    dex,
                    issue: 'Zero liquidity detected',
                    details: `No reserves found in ${dex} pools`,
                    suggestion: 'Check if trading pair exists on this DEX'
                });
            } else if (liquidity < 10) {
                issues.push({
                    dex,
                    issue: `Extremely low liquidity (${liquidity.toFixed(2)})`,
                    details: 'May cause failed transactions or extreme slippage',
                    suggestion: 'Avoid trading on this DEX or use much smaller amounts'
                });
            } else if (liquidity < 100) {
                issues.push({
                    dex,
                    issue: `Very low liquidity (${liquidity.toFixed(2)})`,
                    details: 'High slippage expected (>10%)',
                    suggestion: 'Consider smaller trade sizes or alternative DEXes'
                });
            } else if (liquidity < 1000) {
                issues.push({
                    dex,
                    issue: `Low liquidity (${liquidity.toFixed(0)})`,
                    details: 'Moderate to high slippage expected (2-10%)',
                    suggestion: 'Monitor slippage carefully'
                });
            }
            
            // Анализ multi-hop проблем
            if (priceData.liquidityBreakdown?.method === 'multi_hop_aggregation') {
                const bottleneck = priceData.liquidityBreakdown.bottleneck;
                if (bottleneck && bottleneck.liquidity < 500) {
                    issues.push({
                        dex,
                        issue: `Multi-hop bottleneck at ${bottleneck.step}`,
                        details: `Limiting liquidity: ${bottleneck.liquidity.toFixed(0)}`,
                        suggestion: 'Consider direct trading pairs instead of multi-hop'
                    });
                }
            }
        });
        
        return issues;
    }
    
    /**
     * НОВЫЙ: Обновление статистики ликвидности
     */
    updateLiquidityStats(opportunity) {
        const liquidityStats = this.stats.liquidityStats;
        
        liquidityStats.totalLiquidityAnalyzed++;
        
        const buyLiquidity = opportunity.buyLiquidity || 0;
        const sellLiquidity = opportunity.sellLiquidity || 0;
        const effectiveLiquidity = opportunity.effectiveLiquidity || 0;
        
        // Обновляем среднюю ликвидность
        const currentAvg = liquidityStats.averageLiquidity;
        const totalAnalyzed = liquidityStats.totalLiquidityAnalyzed;
        liquidityStats.averageLiquidity = ((currentAvg * (totalAnalyzed - 1)) + effectiveLiquidity) / totalAnalyzed;
        
        // Категоризируем ликвидность
        if (effectiveLiquidity < 1000) {
            liquidityStats.lowLiquidityPairs++;
        } else if (effectiveLiquidity > 10000) {
            liquidityStats.highLiquidityPairs++;
        }
        
        // Отслеживаем multi-hop возможности
        if (opportunity.buyMethod?.includes('multihop') || opportunity.sellMethod?.includes('multihop')) {
            liquidityStats.multiHopOpportunities++;
        }
        
        // Отслеживаем проблемы с ликвидностью
        if (opportunity.liquidityRatio > 5) { // Большая разница в ликвидности между сторонами
            liquidityStats.liquidityIssuesDetected++;
        }
    }
    
    /**
     * НОВЫЙ: Обработка возможности с учетом ликвидности
     */
    async processOpportunityWithLiquidity(opportunity) {
        try {
            const notificationId = createNotificationId(
                opportunity.token,
                opportunity.buyDex,
                opportunity.sellDex,
                opportunity.basisPoints
            );
            
            // Проверка дубликатов
            if (isDuplicateNotification(
                notificationId, 
                this.recentNotifications, 
                config.settings.notificationCooldownMs
            )) {
                logger.logDebug(`🔇 Skipping duplicate notification for ${opportunity.token}`);
                return;
            }
            
            // Отправка уведомления с детальной информацией о ликвидности
            const alertSent = await telegramNotifier.sendArbitrageAlertWithLiquidity(opportunity);
            
            if (alertSent) {
                logger.logSuccess(`📱 Enhanced alert sent for ${opportunity.token} arbitrage`);
                
                // Дополнительное логирование для высоколиквидных возможностей
                if (opportunity.effectiveLiquidity > 50000) {
                    logger.logInfo(`🏆 High-liquidity opportunity: ${opportunity.token} with ${(opportunity.effectiveLiquidity/1000).toFixed(0)}K effective liquidity`);
                }
            } else {
                logger.logWarning(`📱 Failed to send enhanced alert for ${opportunity.token}`);
            }
            
        } catch (error) {
            logger.logError('Error processing opportunity with liquidity details', error);
        }
    }
    
    // Остальные методы (с минимальными изменениями)...
    
    getMinLiquidityThreshold(tokenSymbol) {
        const dynamicThresholds = config.settings?.minLiquidityUSD || {};
        
        if (dynamicThresholds[tokenSymbol]) {
            return dynamicThresholds[tokenSymbol];
        }
        
        const stablecoins = ['USDC', 'USDT'];
        if (stablecoins.includes(tokenSymbol)) return 500;
        if (['WBTC', 'WETH'].includes(tokenSymbol)) return 2000;
        return 1000;
    }
    
    async calculateTiming(opportunity) {
        try {
            if (this.timeCalculator && typeof this.timeCalculator.calculateArbitrageTimings === 'function') {
                return await this.timeCalculator.calculateArbitrageTimings(opportunity, this.getProvider());
            } else {
                return this.calculateSimpleTiming(opportunity);
            }
        } catch (error) {
            logger.logError('Timing calculation failed, using fallback', error);
            return this.calculateSimpleTiming(opportunity);
        }
    }
    
    calculateSimpleTiming(opportunity) {
        const { basisPoints, potentialProfit, buyLiquidity, sellLiquidity } = opportunity;
        
        const gasEstimate = 2.5;
        const dexFees = opportunity.inputAmount * 0.006;
        const slippageCost = opportunity.inputAmount * 0.003;
        const totalCosts = gasEstimate + dexFees + slippageCost;
        
        const adjustedProfit = Math.max(0, potentialProfit - totalCosts);
        
        let confidence = 0.5;
        if (basisPoints > 150) confidence += 0.2;
        if (basisPoints > 100) confidence += 0.1;
        if (Math.min(buyLiquidity, sellLiquidity) > 5000) confidence += 0.1;
        if (opportunity.buyPath?.length === 2 && opportunity.sellPath?.length === 2) confidence += 0.1;
        
        confidence = Math.min(0.9, confidence);
        
        const strategyMinConfidence = this.activeStrategy.minConfidence || 0.4;
        const isViable = adjustedProfit > 3 && confidence > strategyMinConfidence;
        
        return {
            isViable,
            confidence,
            adjustedProfit: {
                adjustedProfit,
                totalCosts,
                gasInUSD: gasEstimate,
                dexFees,
                slippageCost
            },
            executionTime: 8000,
            deadline: Date.now() + 20000,
            recommendation: {
                action: adjustedProfit > 10 ? 'EXECUTE' : 'MONITOR',
                reason: `Strategy calculation: ${adjustedProfit.toFixed(2)} profit`,
                priority: Math.min(8, Math.floor(adjustedProfit / 2))
            }
        };
    }
    
    /**
     * НОВЫЙ: Логирование сводки отклонений с анализом ликвидности
     */
    logRejectionSummaryWithLiquidity(rejectedOpportunities) {
        if (rejectedOpportunities.length === 0) return;
        
        const rejectionCounts = {};
        const liquidityCounts = { low: 0, zero: 0, issues: 0 };
        
        rejectedOpportunities.forEach(rejection => {
            const reason = rejection.rejectionReason || 'unknown';
            rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
            
            // Анализ проблем с ликвидностью
            if (reason === 'low_liquidity') {
                liquidityCounts.low++;
                if (rejection.liquidityData?.issues) {
                    liquidityCounts.issues += rejection.liquidityData.issues.length;
                }
            }
        });
        
        logger.logInfo('📊 Rejection Summary with Liquidity Analysis:');
        Object.entries(rejectionCounts).forEach(([reason, count]) => {
            logger.logInfo(`   ${reason}: ${count} tokens`);
        });
        
        // Детальная статистика ликвидности
        if (liquidityCounts.low > 0) {
            logger.logInfo('💧 Liquidity Issues:');
            logger.logInfo(`   Low liquidity rejections: ${liquidityCounts.low}`);
            logger.logInfo(`   Total liquidity issues detected: ${liquidityCounts.issues}`);
        }
        
        const tokenRejections = rejectedOpportunities
            .filter(r => r.token)
            .slice(0, 5);
        
        if (tokenRejections.length > 0) {
            logger.logInfo('🔍 Sample rejections with liquidity details:');
            tokenRejections.forEach(rejection => {
                let details = rejection.details || 'N/A';
                if (rejection.liquidityData) {
                    details += ` (${rejection.liquidityData.validPrices || 0} valid prices, ${rejection.liquidityData.liquidPrices || 0} liquid)`;
                }
                logger.logInfo(`   ${rejection.token}: ${rejection.rejectionReason} - ${details}`);
            });
        }
    }
    
    /**
     * НОВЫЙ: Диагностическая проверка ликвидности
     */
    async diagnosticLiquidityCheck(liquidityResults) {
        const recentErrors = this.stats.failedPriceFetches;
        const recentSuccess = this.stats.successfulPriceFetches;
        const totalAttempts = recentErrors + recentSuccess;
        
        if (totalAttempts > 0) {
            const successRate = (recentSuccess / totalAttempts) * 100;
            logger.logInfo(`📊 Price fetch success rate: ${successRate.toFixed(1)}%`);
            
            if (successRate < 30) {
                logger.logWarning('⚠️ Low success rate, switching RPC provider');
                await this.switchProvider();
            }
        }
        
        // НОВЫЙ анализ ликвидности
        const liquidityStats = this.stats.liquidityStats;
        logger.logInfo(`💧 Liquidity Analysis:`);
        logger.logInfo(`   Total pairs analyzed: ${liquidityStats.totalLiquidityAnalyzed}`);
        logger.logInfo(`   Average liquidity: ${(liquidityStats.averageLiquidity/1000).toFixed(1)}K`);
        logger.logInfo(`   Low liquidity pairs: ${liquidityStats.lowLiquidityPairs}`);
        logger.logInfo(`   High liquidity pairs: ${liquidityStats.highLiquidityPairs}`);
        logger.logInfo(`   Multi-hop opportunities: ${liquidityStats.multiHopOpportunities}`);
        logger.logInfo(`   Liquidity issues detected: ${liquidityStats.liquidityIssuesDetected}`);
        
        // Анализ активной стратегии
        logger.logInfo(`🎯 Strategy Analysis:`);
        logger.logInfo(`   Current: ${this.activeStrategy.name}`);
        logger.logInfo(`   Min spread: ${this.activeStrategy.minBasisPoints} bps`);
        logger.logInfo(`   Min confidence: ${(this.activeStrategy.minConfidence * 100).toFixed(1)}%`);
        logger.logInfo(`   Low liquidity: ${this.activeStrategy.enableLowLiquidityTokens ? 'Enabled' : 'Disabled'}`);
        logger.logInfo(`   Multi-hop: ${this.activeStrategy.enableMultiHop ? 'Enabled' : 'Disabled'}`);
        
        // Рекомендации по улучшению
        if (this.stats.totalChecks > 100 && this.stats.opportunitiesFound === 0) {
            logger.logWarning('💡 No opportunities found. Recommendations:');
            
            if (liquidityStats.lowLiquidityPairs > liquidityStats.highLiquidityPairs) {
                logger.logWarning('   - Enable low liquidity tokens in strategy');
                logger.logWarning('   - Consider switching to "aggressive" strategy');
            }
            
            if (liquidityStats.multiHopOpportunities === 0) {
                logger.logWarning('   - Enable multi-hop routing for more paths');
            }
            
            logger.logWarning('   - Lower minimum spread in config');
            logger.logWarning('   - Check if DEX contracts are up to date');
        }
    }
    
    updateRejectionStats(reason) {
        if (this.stats.rejectionStats[reason]) {
            this.stats.rejectionStats[reason]++;
        } else {
            this.stats.rejectionStats[reason] = 1;
        }
    }
    
    updateProfitStatistics(opportunities) {
        const totalProfit = opportunities.reduce((sum, op) => sum + (op.adjustedProfit || 0), 0);
        this.stats.totalPotentialProfit += totalProfit;
        
        const spreads = opportunities.map(op => op.basisPoints);
        if (spreads.length > 0) {
            this.stats.averageSpread = spreads.reduce((sum, spread) => sum + spread, 0) / spreads.length;
        }
    }
    
    async switchProvider() {
        if (this.providers.length <= 1) {
            logger.logWarning('⚠️ Cannot switch provider - only one available');
            return false;
        }
        
        const oldIndex = this.currentProviderIndex;
        this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
        this.stats.rpcFailovers++;
        
        const newProvider = this.getProvider();
        
        if (this.priceFetcher && typeof this.priceFetcher.updateProvider === 'function') {
            try {
                this.priceFetcher.updateProvider(newProvider);
                logger.logInfo(`🔄 Switched to RPC provider ${this.currentProviderIndex + 1}/${this.providers.length}`);
                return true;
            } catch (error) {
                logger.logError('Failed to update PriceFetcher provider', error);
                this.currentProviderIndex = oldIndex;
                return false;
            }
        }
        
        return false;
    }
    
    async attemptRecovery(error) {
        logger.logInfo('🔄 Attempting recovery...');
        
        try {
            const providerSwitched = await this.switchProvider();
            
            if (!this.priceFetcher || error.message.includes('PriceFetcher')) {
                try {
                    this.priceFetcher = new EnhancedPriceFetcher(this.getProvider());
                    logger.logInfo('✅ Enhanced PriceFetcher recreated');
                } catch (pfError) {
                    logger.logError('Failed to recreate Enhanced PriceFetcher', pfError);
                    return false;
                }
            }
            
            const provider = this.getProvider();
            await provider.getBlockNumber();
            
            logger.logSuccess('✅ Recovery successful');
            return true;
            
        } catch (recoveryError) {
            logger.logError('❌ Recovery failed', recoveryError);
            return false;
        }
    }
    
    async saveStats() {
        try {
            await saveNotificationsCache(this.recentNotifications);
            
            // Сохраняем расширенную статистику
            const enhancedStats = {
                ...this.stats,
                timestamp: getCurrentTimestamp(),
                strategy: this.activeStrategy.name,
                version: '2.1-enhanced'
            };
            
            await fs.writeJson('./data/enhanced_stats.json', enhancedStats, { spaces: 2 });
        } catch (error) {
            logger.logError('Failed to save enhanced stats', error);
        }
    }
    
    getStats() {
        const uptime = Date.now() - this.startTime;
        const uptimeMinutes = Math.floor(uptime / 60000);
        
        return {
            ...this.stats,
            uptime: `${uptimeMinutes} minutes`,
            uptimeMs: uptime,
            activeProviders: this.providers.length,
            currentProvider: this.currentProviderIndex + 1,
            lastSuccessfulCheck: this.lastSuccessfulCheck ? 
                new Date(this.lastSuccessfulCheck).toISOString() : null,
            successRate: this.stats.totalChecks > 0 ? 
                ((this.stats.totalChecks - this.stats.errors) / this.stats.totalChecks * 100).toFixed(1) + '%' : 'N/A',
            profitabilityRate: this.stats.opportunitiesFound > 0 ?
                ((this.stats.profitableOpportunities / this.stats.opportunitiesFound) * 100).toFixed(1) + '%' : 'N/A',
            priceSuccessRate: (this.stats.successfulPriceFetches + this.stats.failedPriceFetches) > 0 ?
                ((this.stats.successfulPriceFetches / (this.stats.successfulPriceFetches + this.stats.failedPriceFetches)) * 100).toFixed(1) + '%' : 'N/A',
            activeStrategy: this.activeStrategy.name,
            
            // НОВАЯ статистика ликвидности
            liquiditySummary: {
                averageLiquidity: `${(this.stats.liquidityStats.averageLiquidity/1000).toFixed(1)}K`,
                lowLiquidityRatio: this.stats.liquidityStats.totalLiquidityAnalyzed > 0 ? 
                    ((this.stats.liquidityStats.lowLiquidityPairs / this.stats.liquidityStats.totalLiquidityAnalyzed) * 100).toFixed(1) + '%' : 'N/A',
                multiHopRatio: this.stats.liquidityStats.totalLiquidityAnalyzed > 0 ?
                    ((this.stats.liquidityStats.multiHopOpportunities / this.stats.liquidityStats.totalLiquidityAnalyzed) * 100).toFixed(1) + '%' : 'N/A'
            }
        };
    }
    
    async printStats() {
        const stats = this.getStats();
        
        logger.logInfo('📊 Enhanced Bot Statistics with Liquidity Analysis:');
        logger.logInfo(`   ⏱️ Uptime: ${stats.uptime}`);
        logger.logInfo(`   🎯 Strategy: ${stats.activeStrategy}`);
        logger.logInfo(`   🔍 Total checks: ${stats.totalChecks}`);
        logger.logInfo(`   💎 Opportunities found: ${stats.opportunitiesFound}`);
        logger.logInfo(`   ✅ Viable opportunities: ${stats.viableOpportunities}`);
        logger.logInfo(`   💰 Profitable opportunities: ${stats.profitableOpportunities}`);
        logger.logInfo(`   💵 Total potential profit: ${stats.totalPotentialProfit.toFixed(2)}`);
        logger.logInfo(`   📈 Average spread: ${stats.averageSpread.toFixed(1)} bps`);
        logger.logInfo(`   📡 Success rate: ${stats.successRate}`);
        logger.logInfo(`   💱 Price success rate: ${stats.priceSuccessRate}`);
        logger.logInfo(`   💹 Profitability rate: ${stats.profitabilityRate}`);
        logger.logInfo(`   🌐 Active providers: ${stats.activeProviders}`);
        logger.logInfo(`   🔄 RPC failovers: ${stats.rpcFailovers}`);
        
        // НОВАЯ статистика ликвидности
        logger.logInfo(`   💧 Liquidity Summary:`);
        logger.logInfo(`     Average liquidity: ${stats.liquiditySummary.averageLiquidity}`);
        logger.logInfo(`     Low liquidity ratio: ${stats.liquiditySummary.lowLiquidityRatio}`);
        logger.logInfo(`     Multi-hop ratio: ${stats.liquiditySummary.multiHopRatio}`);
        logger.logInfo(`     Issues detected: ${stats.liquidityStats.liquidityIssuesDetected}`);
        
        if (stats.bestOpportunity) {
            const best = stats.bestOpportunity;
            logger.logInfo(`   🏆 Best opportunity: ${best.token} (${best.basisPoints} bps, ${best.adjustedProfit.toFixed(2)})`);
            if (best.liquidityDetails) {
                logger.logInfo(`     Liquidity: Buy ${(best.liquidityDetails.buyLiquidity/1000).toFixed(1)}K, Sell ${(best.liquidityDetails.sellLiquidity/1000).toFixed(1)}K`);
                logger.logInfo(`     Effective: ${(best.liquidityDetails.effectiveLiquidity/1000).toFixed(1)}K`);
            }
        }
        
        const topRejections = Object.entries(stats.rejectionStats)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 3);
        
        if (topRejections.length > 0) {
            logger.logInfo(`   ❌ Top rejections: ${topRejections.map(([reason, count]) => `${reason}(${count})`).join(', ')}`);
        }
    }
    
    async start() {
        if (this.isRunning) {
            logger.logWarning('⚠️ Bot is already running');
            return;
        }
        
        if (!this.isInitialized) {
            logger.logInfo('⏳ Waiting for initialization to complete...');
            await this.init();
        }
        
        this.isRunning = true;
        this.startTime = Date.now();
        
        logger.logSuccess('🚀 Starting enhanced arbitrage monitoring with liquidity analysis...');
        logger.logInfo(`📊 Checking ${Object.keys(config.tokens).length} tokens across ${Object.keys(config.dexes).length} DEXes`);
        logger.logInfo(`⏱️ Check interval: ${config.settings.checkIntervalMs / 1000}s`);
        logger.logInfo(`💰 Input amount: ${config.settings.inputAmountUSD}`);
        logger.logInfo(`📈 Strategy: ${this.activeStrategy.name} (${this.activeStrategy.minBasisPoints} bps min)`);
        logger.logInfo(`🔧 Low liquidity tokens: ${this.activeStrategy.enableLowLiquidityTokens ? 'Enabled' : 'Disabled'}`);
        logger.logInfo(`🔄 Multi-hop: ${this.activeStrategy.enableMultiHop ? 'Enabled' : 'Disabled'}`);
        logger.logInfo(`💧 Enhanced liquidity analysis: Enabled`);
        
        try {
            await telegramNotifier.sendStartupNotification();
        } catch (error) {
            logger.logWarning('Failed to send startup notification', error.message);
        }
        
        this.runLoop().catch(error => {
            logger.logError('Main loop crashed', error);
            this.handleCriticalError(error);
        });
        
        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());
    }
    
    async runLoop() {
        while (this.isRunning) {
            try {
                if (!this.isInitialized || !this.priceFetcher) {
                    logger.logWarning('⚠️ Bot not properly initialized, attempting re-initialization...');
                    await this.init();
                }
                
                await this.checkAllTokens();
                await this.saveStats();
                
                await sleep(config.settings.checkIntervalMs);
                
            } catch (error) {
                logger.logError('❌ Error in main loop', error);
                this.stats.errors++;
                
                const recovered = await this.attemptRecovery(error);
                if (!recovered) {
                    logger.logError('Failed to recover from error, stopping bot');
                    break;
                }
                
                await sleep(5000);
            }
        }
    }
    
    async handleCriticalError(error) {
        logger.logError('🚨 Critical error occurred', error);
        
        try {
            await telegramNotifier.sendErrorAlert(error, 'Critical enhanced bot error - stopping');
        } catch (notificationError) {
            logger.logError('Failed to send critical error notification', notificationError);
        }
        
        await this.stop();
    }
    
    async stop() {
        if (!this.isRunning) {
            logger.logWarning('⚠️ Enhanced bot is not running');
            return;
        }
        
        logger.logInfo('🛑 Stopping enhanced arbitrage bot...');
        this.isRunning = false;
        
        try {
            await this.saveStats();
            await this.printStats();
            
            try {
                const finalStats = this.getStats();
                await telegramNotifier.sendShutdownNotification(finalStats);
            } catch (error) {
                logger.logWarning('Failed to send shutdown notification', error.message);
            }
            
            logger.logSuccess('✅ Enhanced bot with liquidity analysis stopped gracefully');
        } catch (error) {
            logger.logError('Error during enhanced bot shutdown', error);
        }
    }
    
    // Методы валидации и загрузки (остаются прежними)
    async validateConfiguration() {
        logger.logInfo('⚙️ Validating configuration...');
        
        const requiredTokens = ['WMATIC', 'USDC', 'WETH'];
        for (const tokenSymbol of requiredTokens) {
            if (!config.tokens[tokenSymbol]) {
                throw new Error(`Missing required token: ${tokenSymbol}`);
            }
        }
        
        const requiredDEXes = ['sushiswap', 'quickswap'];
        for (const dexName of requiredDEXes) {
            if (!config.dexes[dexName]) {
                throw new Error(`Missing required DEX: ${dexName}`);
            }
        }
        
        const pathsCount = Object.keys(config.tradingPaths || {}).length;
        if (pathsCount === 0) {
            throw new Error('No trading paths configured');
        }
        
        logger.logSuccess('✅ Configuration validated');
    }
    
    async testConnections() {
        logger.logInfo('🔍 Testing connections...');
        
        const telegramStatus = telegramNotifier.getStatus();
        if (telegramStatus.configured) {
            logger.logSuccess('✅ Telegram connection working');
        } else {
            logger.logWarning('⚠️ Telegram not configured - notifications disabled');
        }
        
        try {
            const provider = this.getProvider();
            const [blockNumber, network] = await Promise.all([
                provider.getBlockNumber(),
                provider.getNetwork()
            ]);
            
            if (Number(network.chainId) !== 137) {
                throw new Error(`Wrong network: expected 137, got ${network.chainId}`);
            }
            
            logger.logSuccess(`✅ RPC working - Block: ${blockNumber}, Chain: ${network.chainId}`);
        } catch (error) {
            throw new Error(`RPC connection test failed: ${error.message}`);
        }
    }
    
    async loadNotificationsCache() {
        try {
            this.recentNotifications = await loadNotificationsCache();
            logger.logInfo(`📋 Loaded ${this.recentNotifications.size} cached notifications`);
        } catch (error) {
            logger.logWarning('⚠️ Failed to load notifications cache, starting fresh');
            this.recentNotifications = new Map();
        }
    }
}

// Создание и запуск бота
if (require.main === module) {
    const bot = new EnhancedArbitrageBot();
    
    bot.start().catch(error => {
        logger.logError('Failed to start enhanced bot', error);
        process.exit(1);
    });
    
    setInterval(() => {
        if (bot.isRunning && bot.isInitialized) {
            bot.printStats();
        }
    }, 300000); // Каждые 5 минут
}

module.exports = EnhancedArbitrageBot;