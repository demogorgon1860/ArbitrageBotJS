const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

const config = require('../config/polygon.json');
const logger = require('./logger');
const telegramNotifier = require('./telegram');
const PriceFetcher = require('./priceFetcher');
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
            bestOpportunity: null
        };
        
        // Оптимизированные настройки производительности
        this.performanceSettings = {
            batchSize: 2,
            maxConcurrentDEX: 2,
            priceTimeout: 15000, // Увеличено до 15 секунд
            retryAttempts: 3, // Увеличено количество попыток
            cooldownBetweenBatches: 2000, // Увеличена пауза между батчами
            initializationTimeout: 30000 // Таймаут инициализации
        };
    }
    
    async init() {
        // Предотвращаем множественную инициализацию
        if (this.initializationPromise) {
            return this.initializationPromise;
        }
        
        this.initializationPromise = this._performInitialization();
        return this.initializationPromise;
    }
    
    async _performInitialization() {
        try {
            logger.logInfo('🚀 Initializing Optimized Polygon Arbitrage Bot...');
            
            // Этап 1: Настройка провайдеров с таймаутом
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
            
            // Этап 2: Инициализация PriceFetcher только после готовности провайдеров
            try {
                this.priceFetcher = new PriceFetcher(this.getProvider());
                logger.logInfo('✅ PriceFetcher initialized successfully');
            } catch (error) {
                logger.logError('Failed to initialize PriceFetcher', error);
                throw new Error(`PriceFetcher initialization failed: ${error.message}`);
            }
            
            // Этап 3: Инициализация TimeCalculator с обработкой ошибок
            try {
                this.timeCalculator = new ArbitrageTimeCalculator();
                logger.logInfo('✅ TimeCalculator initialized');
            } catch (error) {
                logger.logWarning('⚠️ TimeCalculator initialization failed, using simplified calculations', error.message);
                this.timeCalculator = null;
            }
            
            // Этап 4: Загрузка кэша и валидация
            await Promise.all([
                this.loadNotificationsCache(),
                this.validateConfiguration(),
                this.testConnections()
            ]);
            
            this.isInitialized = true;
            logger.logSuccess('✅ Optimized arbitrage bot initialized successfully');
            
        } catch (error) {
            logger.logError('❌ Failed to initialize bot', error);
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
        
        // Тестируем провайдеры параллельно с ограниченным concurrency
        const providerPromises = rpcEndpoints.slice(0, 8).map(endpoint => 
            this.testAndCreateProvider(endpoint)
        );
        
        const results = await Promise.allSettled(providerPromises);
        
        // Собираем успешные провайдеры
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                this.providers.push(result.value);
                
                // Ограничиваем до 5 провайдеров для оптимальной производительности
                if (this.providers.length >= 5) break;
            }
        }
        
        if (this.providers.length === 0) {
            throw new Error('No working RPC providers found. All endpoints failed connection tests.');
        }
        
        logger.logSuccess(`✅ Connected to ${this.providers.length} RPC providers`);
    }
    
    collectRPCEndpoints() {
        const endpoints = [];
        
        // Priority endpoints (API keys)
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
            "https://matic-mainnet.chainstacklabs.com",
            "https://polygon-mainnet.infura.io"
        ];
        
        endpoints.push(...publicEndpoints);
        
        // Убираем дубликаты
        return [...new Set(endpoints)];
    }
    
    async testAndCreateProvider(endpoint) {
        try {
            const provider = new ethers.JsonRpcProvider(
                endpoint,
                137, // Polygon chainId
                {
                    staticNetwork: true,
                    batchMaxCount: 1
                }
            );
            
            // Быстрый тест подключения с таймаутом
            const blockNumber = await Promise.race([
                provider.getBlockNumber(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Connection timeout')), 5000)
                )
            ]);
            
            // Дополнительная проверка сети
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
        
        // Безопасное обновление провайдера в PriceFetcher
        if (this.priceFetcher && typeof this.priceFetcher.updateProvider === 'function') {
            try {
                this.priceFetcher.updateProvider(newProvider);
                logger.logInfo(`🔄 Switched to RPC provider ${this.currentProviderIndex + 1}/${this.providers.length}`);
                return true;
            } catch (error) {
                logger.logError('Failed to update PriceFetcher provider', error);
                this.currentProviderIndex = oldIndex; // Откатываем изменения
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
        
        // Тест RPC с улучшенной обработкой ошибок
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
        
        // Ждем завершения инициализации
        if (!this.isInitialized) {
            logger.logInfo('⏳ Waiting for initialization to complete...');
            await this.init();
        }
        
        this.isRunning = true;
        this.startTime = Date.now();
        
        logger.logSuccess('🚀 Starting optimized arbitrage monitoring...');
        logger.logInfo(`📊 Checking ${Object.keys(config.tokens).length} tokens across ${Object.keys(config.dexes).length} DEXes`);
        logger.logInfo(`⏱️ Check interval: ${config.settings.checkIntervalMs / 1000}s`);
        logger.logInfo(`💰 Input amount: $${config.settings.inputAmountUSD}`);
        logger.logInfo(`📈 Min spread: ${config.settings.minBasisPointsPerTrade} bps`);
        
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
                // Проверяем инициализацию перед каждой итерацией
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
                
                // Попытка восстановления
                const recovered = await this.attemptRecovery(error);
                if (!recovered) {
                    logger.logError('Failed to recover from error, stopping bot');
                    break;
                }
                
                // Короткая пауза перед повтором
                await sleep(5000);
            }
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
    
    async handleCriticalError(error) {
        logger.logError('🚨 Critical error occurred', error);
        
        try {
            await telegramNotifier.sendErrorAlert(error, 'Critical bot error - stopping');
        } catch (notificationError) {
            logger.logError('Failed to send critical error notification', notificationError);
        }
        
        await this.stop();
    }
    
    async checkAllTokens() {
        // Проверяем готовность PriceFetcher
        if (!this.priceFetcher) {
            logger.logError('❌ PriceFetcher not available, skipping check');
            return;
        }
        
        const tokens = Object.keys(config.tokens);
        const startTime = Date.now();
        
        this.stats.totalChecks++;
        this.stats.lastCheck = getCurrentTimestamp();
        
        logger.logInfo(`🔍 Checking ${tokens.length} tokens for arbitrage opportunities...`);
        
        const opportunities = [];
        
        // Обработка токенов батчами для лучшей производительности
        for (let i = 0; i < tokens.length; i += this.performanceSettings.batchSize) {
            const batch = tokens.slice(i, i + this.performanceSettings.batchSize);
            
            const batchPromises = batch.map(async (token) => {
                try {
                    const opportunity = await this.findArbitrageOpportunity(token);
                    if (opportunity) {
                        opportunities.push(opportunity);
                        this.stats.opportunitiesFound++;
                        
                        // Обновляем статистику лучшей возможности
                        if (!this.stats.bestOpportunity || opportunity.basisPoints > this.stats.bestOpportunity.basisPoints) {
                            this.stats.bestOpportunity = {
                                token: opportunity.token,
                                basisPoints: opportunity.basisPoints,
                                adjustedProfit: opportunity.adjustedProfit,
                                timestamp: opportunity.timestamp
                            };
                        }
                    }
                    return opportunity;
                } catch (error) {
                    logger.logError(`Error checking ${token}`, error);
                    this.stats.errors++;
                    return null;
                }
            });
            
            await Promise.allSettled(batchPromises);
            
            // Пауза между батчами
            if (i + this.performanceSettings.batchSize < tokens.length) {
                await sleep(this.performanceSettings.cooldownBetweenBatches);
            }
        }
        
        const checkDuration = Date.now() - startTime;
        
        if (opportunities.length > 0) {
            // Сортируем по скорректированной прибыли
            opportunities.sort((a, b) => {
                const scoreA = (a.adjustedProfit || 0) * (a.confidence || 0.5);
                const scoreB = (b.adjustedProfit || 0) * (b.confidence || 0.5);
                return scoreB - scoreA;
            });
            
            logger.logSuccess(`✅ Found ${opportunities.length} viable opportunities in ${checkDuration}ms`);
            
            // Обработка возможностей
            for (const opportunity of opportunities.slice(0, 3)) { // Топ-3 возможности
                await this.processOpportunity(opportunity);
            }
            
            // Обновляем статистику
            this.updateProfitStatistics(opportunities);
            
        } else {
            logger.logInfo(`🔍 No viable opportunities found in ${checkDuration}ms`);
            
            // Диагностика почему нет возможностей
            await this.diagnosticCheck();
        }
        
        this.lastSuccessfulCheck = Date.now();
    }
    
    async findArbitrageOpportunity(tokenSymbol) {
        try {
            const inputAmountUSD = config.settings.inputAmountUSD;
            const dexNames = Object.keys(config.dexes);
            
            logger.logDebug(`🔍 Checking ${tokenSymbol} across ${dexNames.length} DEXes`);
            
            // Получаем цены со всех DEX с улучшенной обработкой ошибок
            const priceResults = await this.getOptimizedPrices(tokenSymbol, dexNames, inputAmountUSD);
            
            // Обновляем статистику получения цен
            this.stats.successfulPriceFetches += priceResults.filter(r => r.success).length;
            this.stats.failedPriceFetches += priceResults.filter(r => !r.success).length;
            
            // Фильтруем валидные цены с улучшенными критериями
            const validPrices = priceResults.filter(result => 
                result.success && 
                result.price > 0 && 
                typeof result.price === 'number' && 
                !isNaN(result.price) &&
                isFinite(result.price) &&
                result.liquidity && result.liquidity > 500 // Снижен минимум ликвидности
            );
            
            if (validPrices.length < 2) {
                logger.logDebug(`❌ Insufficient valid prices for ${tokenSymbol}: ${validPrices.length}/2`);
                return null;
            }
            
            // Сортируем по цене
            validPrices.sort((a, b) => a.price - b.price);
            
            const buyPrice = validPrices[0]; // Самая низкая цена
            const sellPrice = validPrices[validPrices.length - 1]; // Самая высокая цена
            
            if (buyPrice.dex === sellPrice.dex) {
                return null; // Один и тот же DEX
            }
            
            // Расчет спреда
            const basisPoints = calculateBasisPoints(sellPrice.price, buyPrice.price);
            const minBasisPoints = config.settings.minBasisPointsPerTrade;
            
            if (basisPoints < minBasisPoints) {
                logger.logDebug(`❌ Spread too low for ${tokenSymbol}: ${basisPoints} < ${minBasisPoints} bps`);
                return null;
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
                this.updateSkipStatistics('timing');
                return null;
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
            if (opportunity.adjustedProfit > 3) { // Минимум $3 чистой прибыли
                this.stats.profitableOpportunities++;
                
                logger.logSuccess(`💰 PROFITABLE ARBITRAGE: ${tokenSymbol}`, {
                    spread: `${basisPoints} bps`,
                    grossProfit: `$${potentialProfit.toFixed(2)}`,
                    netProfit: `$${opportunity.adjustedProfit.toFixed(2)}`,
                    confidence: `${(opportunity.confidence * 100).toFixed(1)}%`,
                    buyDex: buyPrice.dex,
                    sellDex: sellPrice.dex
                });
                
                return opportunity;
            } else {
                this.updateSkipStatistics('cost');
                return null;
            }
            
        } catch (error) {
            logger.logError(`❌ Error finding arbitrage for ${tokenSymbol}`, error);
            this.stats.errors++;
            
            // Переключение провайдера при сетевых ошибках
            if (error.message.includes('timeout') || error.message.includes('network')) {
                await this.switchProvider();
            }
            
            return null;
        }
    }
    
    /**
     * Оптимизированное получение цен с улучшенной обработкой ошибок
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
        
        // Простая оценка confidence
        let confidence = 0.5;
        if (basisPoints > 150) confidence += 0.2;
        if (basisPoints > 100) confidence += 0.1;
        if (Math.min(buyLiquidity, sellLiquidity) > 5000) confidence += 0.1;
        if (opportunity.buyPath?.length === 2 && opportunity.sellPath?.length === 2) confidence += 0.1;
        
        confidence = Math.min(0.9, confidence);
        
        return {
            isViable: adjustedProfit > 3 && confidence > 0.4, // Минимум $3 и 40% confidence
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
                reason: `Simple calculation: ${adjustedProfit.toFixed(2)} profit`,
                priority: adjustedProfit > 15 ? 8 : 4
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
    
    /**
     * Обновление статистики пропусков
     */
    updateSkipStatistics(reason) {
        switch (reason) {
            case 'timing':
                this.stats.skippedByTime++;
                break;
            case 'liquidity':
                this.stats.skippedByLiquidity++;
                break;
            case 'cost':
                this.stats.skippedByCost++;
                break;
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
                ((this.stats.successfulPriceFetches / (this.stats.successfulPriceFetches + this.stats.failedPriceFetches)) * 100).toFixed(1) + '%' : 'N/A'
        };
    }
    
    async printStats() {
        const stats = this.getStats();
        
        logger.logInfo('📊 Bot Statistics:');
        logger.logInfo(`   ⏱️ Uptime: ${stats.uptime}`);
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
    }
    
    async stop() {
        if (!this.isRunning) {
            logger.logWarning('⚠️ Bot is not running');
            return;
        }
        
        logger.logInfo('🛑 Stopping optimized arbitrage bot...');
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
            
            logger.logSuccess('✅ Bot stopped gracefully');
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