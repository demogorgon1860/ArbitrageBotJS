const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

const config = require('../config/polygon.json');
const logger = require('./logger');
const telegramNotifier = require('./telegram');
const PriceFetcher = require('./priceFetcher'); // Используем обновленный PriceFetcher
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

class ArbitrageBot {
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
        
        // Улучшенная статистика
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
        
        // Оптимизированные настройки производительности
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
            // Fallback стратегия
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
    
    async init() {
        if (this.initializationPromise) {
            return this.initializationPromise;
        }
        
        this.initializationPromise = this._performInitialization();
        return this.initializationPromise;
    }
    
    async _performInitialization() {
        try {
            logger.logInfo('🚀 Initializing Enhanced Arbitrage Bot...');
            logger.logInfo(`📊 Strategy: ${this.activeStrategy.name}`);
            
            // Этап 1: Настройка провайдеров
            await Promise.race([
                this.setupProviders(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Provider setup timeout')), 
                    this.performanceSettings.initializationTimeout)
                )
            ]);
            
            if (this.providers.length === 0) {
                throw new Error('No working RPC providers found');
            }
            
            // Этап 2: Инициализация PriceFetcher
            try {
                this.priceFetcher = new PriceFetcher(this.getProvider());
                logger.logInfo('✅ PriceFetcher initialized successfully');
            } catch (error) {
                logger.logError('Failed to initialize PriceFetcher', error);
                throw new Error(`PriceFetcher initialization failed: ${error.message}`);
            }
            
            // Этап 3: Инициализация TimeCalculator
            try {
                this.timeCalculator = new ArbitrageTimeCalculator();
                logger.logInfo('✅ TimeCalculator initialized');
            } catch (error) {
                logger.logWarning('⚠️ TimeCalculator initialization failed, using simplified calculations', error.message);
                this.timeCalculator = null;
            }
            
            // Этап 4: Загрузка данных и валидация
            await Promise.all([
                this.loadNotificationsCache(),
                this.validateConfiguration(),
                this.testConnections()
            ]);
            
            this.isInitialized = true;
            logger.logSuccess('✅ Enhanced arbitrage bot initialized successfully');
            
        } catch (error) {
            logger.logError('❌ Failed to initialize enhanced bot', error);
            this.isInitialized = false;
            throw error;
        }
    }
    
    async setupProviders() {
        logger.logInfo('🌐 Setting up RPC providers...');
        
        const rpcEndpoints = this.collectRPCEndpoints();
        logger.logInfo(`Found ${rpcEndpoints.length} potential RPC endpoints`);
        
        if (rpcEndpoints.length === 0) {
            throw new Error('No RPC endpoints configured. Please check your .env file.');
        }
        
        // Тестируем провайдеры параллельно
        const providerPromises = rpcEndpoints.slice(0, 8).map(endpoint => 
            this.testAndCreateProvider(endpoint)
        );
        
        const results = await Promise.allSettled(providerPromises);
        
        // Собираем успешные провайдеры
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
        
        // Priority endpoints
        if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
            endpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
            endpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        // Custom RPC endpoints
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                endpoints.push(rpc);
            }
        }
        
        // Public fallback endpoints
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
            const provider = new ethers.JsonRpcProvider(
                endpoint,
                137,
                {
                    staticNetwork: true,
                    batchMaxCount: 1
                }
            );
            
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
    
    async validateConfiguration() {
        logger.logInfo('⚙️ Validating configuration...');
        
        // Проверяем основные токены
        const requiredTokens = ['WMATIC', 'USDC', 'WETH'];
        for (const tokenSymbol of requiredTokens) {
            if (!config.tokens[tokenSymbol]) {
                throw new Error(`Missing required token: ${tokenSymbol}`);
            }
        }
        
        // Проверяем DEX
        const requiredDEXes = ['sushiswap', 'quickswap'];
        for (const dexName of requiredDEXes) {
            if (!config.dexes[dexName]) {
                throw new Error(`Missing required DEX: ${dexName}`);
            }
        }
        
        // Проверяем торговые пути
        const pathsCount = Object.keys(config.tradingPaths || {}).length;
        if (pathsCount === 0) {
            throw new Error('No trading paths configured');
        }
        
        logger.logSuccess('✅ Configuration validated');
    }
    
    async testConnections() {
        logger.logInfo('🔍 Testing connections...');
        
        // Тест Telegram
        const telegramStatus = telegramNotifier.getStatus();
        if (telegramStatus.configured) {
            logger.logSuccess('✅ Telegram connection working');
        } else {
            logger.logWarning('⚠️ Telegram not configured - notifications disabled');
        }
        
        // Тест RPC
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
        
        logger.logSuccess('🚀 Starting enhanced arbitrage monitoring...');
        logger.logInfo(`📊 Checking ${Object.keys(config.tokens).length} tokens across ${Object.keys(config.dexes).length} DEXes`);
        logger.logInfo(`⏱️ Check interval: ${config.settings.checkIntervalMs / 1000}s`);
        logger.logInfo(`💰 Input amount: $${config.settings.inputAmountUSD}`);
        logger.logInfo(`📈 Strategy: ${this.activeStrategy.name} (${this.activeStrategy.minBasisPoints} bps min)`);
        logger.logInfo(`🔧 Low liquidity tokens: ${this.activeStrategy.enableLowLiquidityTokens ? 'Enabled' : 'Disabled'}`);
        logger.logInfo(`🔄 Multi-hop: ${this.activeStrategy.enableMultiHop ? 'Enabled' : 'Disabled'}`);
        
        // Отправляем уведомление о запуске
        try {
            await telegramNotifier.sendStartupNotification();
        } catch (error) {
            logger.logWarning('Failed to send startup notification', error.message);
        }
        
        // Запускаем основной цикл
        this.runLoop().catch(error => {
            logger.logError('Main loop crashed', error);
            this.handleCriticalError(error);
        });
        
        // Настройка graceful shutdown
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
                
                // Ждем до следующей проверки
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
        
        // Обработка токенов батчами
        for (let i = 0; i < tokens.length; i += this.performanceSettings.batchSize) {
            const batch = tokens.slice(i, i + this.performanceSettings.batchSize);
            
            const batchPromises = batch.map(async (token) => {
                try {
                    const result = await this.findArbitrageOpportunity(token);
                    if (result && result.success) {
                        opportunities.push(result.opportunity);
                        this.stats.opportunitiesFound++;
                        
                        if (!this.stats.bestOpportunity || result.opportunity.basisPoints > this.stats.bestOpportunity.basisPoints) {
                            this.stats.bestOpportunity = {
                                token: result.opportunity.token,
                                basisPoints: result.opportunity.basisPoints,
                                adjustedProfit: result.opportunity.adjustedProfit,
                                timestamp: result.opportunity.timestamp
                            };
                        }
                    } else if (result) {
                        rejectedOpportunities.push(result);
                        this.updateRejectionStats(result.rejectionReason);
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
            
            for (const opportunity of opportunities.slice(0, 3)) {
                await this.processOpportunity(opportunity);
            }
            
            this.updateProfitStatistics(opportunities);
            
        } else {
            logger.logInfo(`🔍 No viable opportunities found in ${checkDuration}ms`);
            
            // Детальная диагностика отклонений
            this.logRejectionSummary(rejectedOpportunities);
            await this.diagnosticCheck();
        }
        
        this.lastSuccessfulCheck = Date.now();
    }
    
    async findArbitrageOpportunity(tokenSymbol) {
        try {
            const inputAmountUSD = config.settings.inputAmountUSD;
            const dexNames = Object.keys(config.dexes);
            
            logger.logDebug(`🔍 Checking ${tokenSymbol} across ${dexNames.length} DEXes`);
            
            // Получаем цены со всех DEX
            const priceResults = await this.getOptimizedPrices(tokenSymbol, dexNames, inputAmountUSD);
            
            this.stats.successfulPriceFetches += priceResults.filter(r => r.success).length;
            this.stats.failedPriceFetches += priceResults.filter(r => !r.success).length;
            
            // Фильтруем валидные цены с улучшенными критериями
            const validPrices = priceResults.filter(result => 
                result.success && 
                result.price > 0 && 
                typeof result.price === 'number' && 
                !isNaN(result.price) &&
                isFinite(result.price)
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
            
            // Применяем фильтр ликвидности на основе стратегии
            const liquidPrices = this.filterByLiquidity(validPrices, tokenSymbol);
            
            if (liquidPrices.length < 2) {
                return {
                    success: false,
                    rejectionReason: 'low_liquidity',
                    details: `Only ${liquidPrices.length} prices passed liquidity filter`,
                    token: tokenSymbol
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
            
            // Создаем базовую возможность
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
                    strategy: this.activeStrategy.name
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
     * Фильтрация по ликвидности на основе стратегии
     */
    filterByLiquidity(validPrices, tokenSymbol) {
        if (this.activeStrategy.enableLowLiquidityTokens) {
            // Если стратегия разрешает низкую ликвидность, используем очень низкий порог
            return validPrices.filter(result => 
                result.liquidity && result.liquidity > 100 // Минимум $100
            );
        }
        
        // Стандартная фильтрация на основе конфига
        const minLiquidity = this.getMinLiquidityThreshold(tokenSymbol);
        return validPrices.filter(result => 
            result.liquidity && result.liquidity >= minLiquidity
        );
    }
    
    /**
     * Получение минимального порога ликвидности
     */
    getMinLiquidityThreshold(tokenSymbol) {
        const dynamicThresholds = config.settings?.minLiquidityUSD || {};
        
        if (dynamicThresholds[tokenSymbol]) {
            return dynamicThresholds[tokenSymbol];
        }
        
        // Пороги по умолчанию
        const stablecoins = ['USDC', 'USDT'];
        if (stablecoins.includes(tokenSymbol)) return 500;
        if (['WBTC', 'WETH'].includes(tokenSymbol)) return 2000;
        return 1000;
    }
    
    /**
     * Получение оптимизированных цен
     */
    async getOptimizedPrices(tokenSymbol, dexNames, inputAmountUSD) {
        // Проверяем что priceFetcher инициализирован
        if (!this.priceFetcher) {
            logger.logError('❌ PriceFetcher not initialized');
            return dexNames.map(dexName => ({
                price: 0,
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
                    return result.value;
                } else {
                    return {
                        price: 0,
                        path: null,
                        method: null,
                        dex: dexNames[index],
                        success: false,
                        error: result.reason?.message || 'Unknown error'
                    };
                }
            });
            
        } catch (error) {
            logger.logError('Failed to get optimized prices', error);
            return dexNames.map(dexName => ({
                price: 0,
                path: null,
                method: null,
                dex: dexName,
                success: false,
                error: error.message
            }));
        }
    }
    
    /**
     * Расчет времени и жизнеспособности
     */
    async calculateTiming(opportunity) {
        try {
            if (this.timeCalculator && typeof this.timeCalculator.calculateArbitrageTimings === 'function') {
                return await this.timeCalculator.calculateArbitrageTimings(opportunity, this.getProvider());
            } else {
                // Упрощенный расчет времени
                return this.calculateSimpleTiming(opportunity);
            }
        } catch (error) {
            logger.logError('Timing calculation failed, using fallback', error);
            return this.calculateSimpleTiming(opportunity);
        }
    }
    
    /**
     * Упрощенный расчет времени
     */
    calculateSimpleTiming(opportunity) {
        const { basisPoints, potentialProfit, buyLiquidity, sellLiquidity } = opportunity;
        
        // Простая оценка затрат
        const gasEstimate = 2.5; // $2.5 на газ
        const dexFees = opportunity.inputAmount * 0.006; // 0.6% комиссии DEX
        const slippageCost = opportunity.inputAmount * 0.003; // 0.3% slippage
        const totalCosts = gasEstimate + dexFees + slippageCost;
        
        const adjustedProfit = Math.max(0, potentialProfit - totalCosts);
        
        // Простая оценка confidence на основе стратегии
        let confidence = 0.5;
        if (basisPoints > 150) confidence += 0.2;
        if (basisPoints > 100) confidence += 0.1;
        if (Math.min(buyLiquidity, sellLiquidity) > 5000) confidence += 0.1;
        if (opportunity.buyPath?.length === 2 && opportunity.sellPath?.length === 2) confidence += 0.1;
        
        confidence = Math.min(0.9, confidence);
        
        // Проверяем соответствие стратегии
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
            executionTime: 8000, // 8 секунд
            deadline: Date.now() + 20000, // 20 секунд
            recommendation: {
                action: adjustedProfit > 10 ? 'EXECUTE' : 'MONITOR',
                reason: `Strategy calculation: ${adjustedProfit.toFixed(2)} profit`,
                priority: Math.min(8, Math.floor(adjustedProfit / 2))
            }
        };
    }
    
    /**
     * Обработка возможности
     */
    async processOpportunity(opportunity) {
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
            
            // Отправка уведомления
            const alertSent = await telegramNotifier.sendArbitrageAlert(opportunity);
            
            if (alertSent) {
                logger.logSuccess(`📱 Alert sent for ${opportunity.token} arbitrage`);
            } else {
                logger.logWarning(`📱 Failed to send alert for ${opportunity.token}`);
            }
            
        } catch (error) {
            logger.logError('Error processing opportunity', error);
        }
    }
    
    /**
     * Логирование сводки отклонений
     */
    logRejectionSummary(rejectedOpportunities) {
        if (rejectedOpportunities.length === 0) return;
        
        const rejectionCounts = {};
        rejectedOpportunities.forEach(rejection => {
            const reason = rejection.rejectionReason || 'unknown';
            rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
        });
        
        logger.logInfo('📊 Rejection Summary:');
        Object.entries(rejectionCounts).forEach(([reason, count]) => {
            logger.logInfo(`   ${reason}: ${count} tokens`);
        });
        
        // Топ отклоненных токенов
        const tokenRejections = rejectedOpportunities
            .filter(r => r.token)
            .slice(0, 5);
        
        if (tokenRejections.length > 0) {
            logger.logInfo('🔍 Sample rejections:');
            tokenRejections.forEach(rejection => {
                logger.logInfo(`   ${rejection.token}: ${rejection.rejectionReason} - ${rejection.details || 'N/A'}`);
            });
        }
    }
    
    /**
     * Диагностическая проверка
     */
    async diagnosticCheck() {
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
        
        // Анализ активной стратегии
        logger.logInfo(`🎯 Strategy Analysis:`);
        logger.logInfo(`   Current: ${this.activeStrategy.name}`);
        logger.logInfo(`   Min spread: ${this.activeStrategy.minBasisPoints} bps`);
        logger.logInfo(`   Min confidence: ${(this.activeStrategy.minConfidence * 100).toFixed(1)}%`);
        logger.logInfo(`   Low liquidity: ${this.activeStrategy.enableLowLiquidityTokens ? 'Enabled' : 'Disabled'}`);
        logger.logInfo(`   Multi-hop: ${this.activeStrategy.enableMultiHop ? 'Enabled' : 'Disabled'}`);
        
        // Рекомендации по настройке
        if (this.stats.totalChecks > 100 && this.stats.opportunitiesFound === 0) {
            logger.logWarning('💡 No opportunities found. Try:');
            logger.logWarning('   - Switch to "aggressive" strategy');
            logger.logWarning('   - Enable low liquidity tokens');
            logger.logWarning('   - Lower minimum spread in config');
        }
    }
    
    /**
     * Обновление статистики отклонений
     */
    updateRejectionStats(reason) {
        if (this.stats.rejectionStats[reason]) {
            this.stats.rejectionStats[reason]++;
        } else {
            this.stats.rejectionStats[reason] = 1;
        }
    }
    
    /**
     * Обновление статистики прибыли
     */
    updateProfitStatistics(opportunities) {
        const totalProfit = opportunities.reduce((sum, op) => sum + (op.adjustedProfit || 0), 0);
        this.stats.totalPotentialProfit += totalProfit;
        
        const spreads = opportunities.map(op => op.basisPoints);
        if (spreads.length > 0) {
            this.stats.averageSpread = spreads.reduce((sum, spread) => sum + spread, 0) / spreads.length;
        }
    }
    
    async attemptRecovery(error) {
        logger.logInfo('🔄 Attempting recovery...');
        
        try {
            // 1. Попытка переключения провайдера
            const providerSwitched = await this.switchProvider();
            
            // 2. Пересоздание PriceFetcher если необходимо
            if (!this.priceFetcher || error.message.includes('PriceFetcher')) {
                try {
                    this.priceFetcher = new PriceFetcher(this.getProvider());
                    logger.logInfo('✅ PriceFetcher recreated');
                } catch (pfError) {
                    logger.logError('Failed to recreate PriceFetcher', pfError);
                    return false;
                }
            }
            
            // 3. Тест связи
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
        } catch (error) {
            logger.logError('Failed to save stats', error);
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
            activeStrategy: this.activeStrategy.name
        };
    }
    
    async printStats() {
        const stats = this.getStats();
        
        logger.logInfo('📊 Enhanced Bot Statistics:');
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
        
        if (stats.bestOpportunity) {
            logger.logInfo(`   🏆 Best opportunity: ${stats.bestOpportunity.token} (${stats.bestOpportunity.basisPoints} bps, ${stats.bestOpportunity.adjustedProfit.toFixed(2)})`);
        }
        
        // Показываем статистику отклонений
        const topRejections = Object.entries(stats.rejectionStats)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 3);
        
        if (topRejections.length > 0) {
            logger.logInfo(`   ❌ Top rejections: ${topRejections.map(([reason, count]) => `${reason}(${count})`).join(', ')}`);
        }
    }
    
    async handleCriticalError(error) {
        logger.logError('🚨 Critical error occurred', error);
        
        try {
            await telegramNotifier.sendErrorAlert(error, 'Critical bot error - stopping');
        } catch (notificationError) {
            logger.logError('Failed to send critical error notification', notificationError);
        }
        
        await this.stop();
    }
    
    async stop() {
        if (!this.isRunning) {
            logger.logWarning('⚠️ Bot is not running');
            return;
        }
        
        logger.logInfo('🛑 Stopping enhanced arbitrage bot...');
        this.isRunning = false;
        
        try {
            await this.saveStats();
            await this.printStats();
            
            // Отправка уведомления об остановке
            try {
                const finalStats = this.getStats();
                await telegramNotifier.sendShutdownNotification(finalStats);
            } catch (error) {
                logger.logWarning('Failed to send shutdown notification', error.message);
            }
            
            logger.logSuccess('✅ Enhanced bot stopped gracefully');
        } catch (error) {
            logger.logError('Error during shutdown', error);
        }
    }
}

// Создание и запуск бота
if (require.main === module) {
    const bot = new ArbitrageBot();
    
    // Запуск бота с обработкой ошибок
    bot.start().catch(error => {
        logger.logError('Failed to start bot', error);
        process.exit(1);
    });
    
    // Периодическая отчетность
    setInterval(() => {
        if (bot.isRunning && bot.isInitialized) {
            bot.printStats();
        }
    }, 300000); // Каждые 5 минут
}

module.exports = ArbitrageBot;