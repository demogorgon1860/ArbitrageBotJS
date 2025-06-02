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
        this.startTime = Date.now();
        this.priceFetcher = null;
        this.timeCalculator = null;
        this.lastSuccessfulCheck = null;
        
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
        
        // Настройки производительности
        this.performanceSettings = {
            batchSize: 2, // Уменьшено для стабильности
            maxConcurrentDEX: 2, // Максимум 2 DEX одновременно
            priceTimeout: 8000, // 8 секунд на получение цены
            retryAttempts: 2, // Меньше попыток, больше скорость
            cooldownBetweenBatches: 1500 // 1.5 секунды между батчами
        };
        
        this.init();
    }
    
    async init() {
        try {
            logger.logInfo('🚀 Initializing Optimized Polygon Arbitrage Bot...');
            
            await this.setupProviders();
            
            // ИСПРАВЛЕНО: Инициализируем PriceFetcher СРАЗУ после setupProviders
            if (this.providers.length > 0) {
                this.priceFetcher = new PriceFetcher(this.getProvider());
                logger.logInfo('✅ PriceFetcher initialized with provider');
            } else {
                throw new Error('No providers available for PriceFetcher');
            }
            
            // Инициализация TimeCalculator с обработкой ошибок
            try {
                this.timeCalculator = new ArbitrageTimeCalculator();
                logger.logInfo('✅ TimeCalculator initialized');
            } catch (error) {
                logger.logWarning('⚠️ TimeCalculator initialization failed, using simplified calculations', error.message);
                this.timeCalculator = null;
            }
            
            await this.loadNotificationsCache();
            await this.validateConfiguration();
            await this.testConnections();
            
            logger.logSuccess('✅ Optimized arbitrage bot initialized successfully');
        } catch (error) {
            logger.logError('❌ Failed to initialize bot', error);
            process.exit(1);
        }
    }
    
    async setupProviders() {
        logger.logInfo('Setting up RPC providers...');
        
        const rpcEndpoints = [];
        
        // Собираем RPC endpoints из переменных окружения
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                rpcEndpoints.push(rpc);
            }
        }
        
        // Добавляем API ключи
        if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
            rpcEndpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
            rpcEndpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        // Публичные fallback endpoints
        const publicEndpoints = [
            "https://rpc.ankr.com/polygon",
            "https://polygon-rpc.com", 
            "https://rpc-mainnet.matic.network",
            "https://matic-mainnet.chainstacklabs.com"
        ];
        rpcEndpoints.push(...publicEndpoints);
        
        // Убираем дубликаты
        const uniqueEndpoints = [...new Set(rpcEndpoints)];
        
        // Тестируем каждый endpoint быстро
        for (const endpoint of uniqueEndpoints) {
            try {
                const provider = new ethers.JsonRpcProvider(
                    endpoint,
                    137, // Polygon chainId
                    {
                        staticNetwork: true,
                        batchMaxCount: 1
                    }
                );
                
                // Быстрый тест подключения
                await Promise.race([
                    provider.getBlockNumber(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Connection timeout')), 3000)
                    )
                ]);
                
                this.providers.push(provider);
                logger.logInfo(`✅ Connected to RPC: ${endpoint.split('/')[2]}`);
                
                // Ограничиваем до 5 провайдеров для оптимальной производительности
                if (this.providers.length >= 5) break;
                
            } catch (error) {
                logger.logWarning(`❌ Failed to connect to RPC: ${endpoint.split('/')[2]}`);
            }
        }
        
        if (this.providers.length === 0) {
            throw new Error('No working RPC providers found. Please check your .env configuration.');
        }
        
        logger.logSuccess(`Connected to ${this.providers.length} RPC providers`);
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
            return;
        }
        
        this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
        this.stats.rpcFailovers++;
        
        const newProvider = this.getProvider();
        
        // ИСПРАВЛЕНО: Проверяем что priceFetcher существует перед обновлением
        if (this.priceFetcher) {
            this.priceFetcher.updateProvider(newProvider);
        }
        
        logger.logInfo(`🔄 Switched to RPC provider ${this.currentProviderIndex + 1}/${this.providers.length}`);
    }
    
    async validateConfiguration() {
        logger.logInfo('Validating configuration...');
        
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
        
        logger.logSuccess('✅ Configuration validated');
    }
    
    async testConnections() {
        logger.logInfo('Testing connections...');
        
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
            throw new Error(`RPC connection failed: ${error.message}`);
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
        this.runLoop();
        
        // Настройка graceful shutdown
        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());
    }
    
    async runLoop() {
        while (this.isRunning) {
            try {
                await this.checkAllTokens();
                await this.saveStats();
                
                // Ждем до следующей проверки
                await sleep(config.settings.checkIntervalMs);
                
            } catch (error) {
                logger.logError('❌ Error in main loop', error);
                this.stats.errors++;
                
                // Попытка восстановления
                await this.switchProvider();
                await sleep(3000); // Короткая пауза перед повтором
            }
        }
    }
    
    async checkAllTokens() {
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
            
            // Получаем цены со всех DEX параллельно, но ограниченно
            const priceResults = await this.getOptimizedPrices(tokenSymbol, dexNames, inputAmountUSD);
            
            // Обновляем статистику получения цен
            this.stats.successfulPriceFetches += priceResults.filter(r => r.success).length;
            this.stats.failedPriceFetches += priceResults.filter(r => !r.success).length;
            
            // Фильтруем валидные цены
            const validPrices = priceResults.filter(result => 
                result.success && 
                result.price > 0 && 
                typeof result.price === 'number' && 
                !isNaN(result.price) &&
                result.liquidity && result.liquidity > 1000 // Минимальная ликвидность $1K
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
                adjustedProfit: timingData.adjustedProfit?.adjustedProfit || (potentialProfit * 0.7), // Консервативная оценка
                confidence: timingData.confidence || 0.6,
                executionWindow: timingData.executionTime || 10000,
                deadline: timingData.deadline || (Date.now() + 15000)
            });
            
            this.stats.viableOpportunities++;
            
            // Проверяем прибыльность после всех затрат
            if (opportunity.adjustedProfit > 5) { // Минимум $5 чистой прибыли
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
     * Оптимизированное получение цен
     */
    async getOptimizedPrices(tokenSymbol, dexNames, inputAmountUSD) {
        // ИСПРАВЛЕНО: Проверяем что priceFetcher инициализирован
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
                reason: `Simple calculation: $${adjustedProfit.toFixed(2)} profit`,
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
            
            if (successRate < 50) {
                logger.logWarning('⚠️ Low success rate, consider switching RPC provider');
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
                ((this.stats.profitableOpportunities / this.stats.opportunitiesFound) * 100).toFixed(1) + '%' : 'N/A'
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
        logger.logInfo(`   💵 Total potential profit: $${stats.totalPotentialProfit.toFixed(2)}`);
        logger.logInfo(`   📈 Average spread: ${stats.averageSpread.toFixed(1)} bps`);
        logger.logInfo(`   📡 Success rate: ${stats.successRate}`);
        logger.logInfo(`   💹 Profitability rate: ${stats.profitabilityRate}`);
        logger.logInfo(`   🌐 Active providers: ${stats.activeProviders}`);
        
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
        
        process.exit(0);
    }
}

// Создание и запуск бота
if (require.main === module) {
    const bot = new ArbitrageBot();
    
    // Запуск бота
    bot.start().catch(error => {
        logger.logError('Failed to start bot', error);
        process.exit(1);
    });
    
    // Периодическая отчетность
    setInterval(() => {
        bot.printStats();
    }, 300000); // Каждые 5 минут
}

module.exports = ArbitrageBot;