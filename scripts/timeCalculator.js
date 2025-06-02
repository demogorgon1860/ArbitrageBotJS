const logger = require('./logger');

class ArbitrageTimeCalculator {
    constructor() {
        // Реалистичные параметры сети Polygon
        this.networkTiming = {
            avgBlockTime: 2200,        // ~2.2 секунды на блок
            confirmationBlocks: 1,     // 1 блок для подтверждения на Polygon
            gasEstimationTime: 300,    // время на расчет газа
            mempoolDelay: 500,         // задержка в mempool
            rpcLatency: 150,           // задержка RPC вызовов
            dexProcessingTime: 800     // время обработки на DEX
        };
        
        // Реалистичные параметры арбитража
        this.arbitrageParams = {
            minExecutionWindow: 5000,   // минимальное окно 5 секунд
            maxExecutionWindow: 30000,  // максимальное окно 30 секунд
            priceDecayRate: 0.12,      // скорость распада спреда
            slippageFactor: 0.002,     // базовый slippage 0.2%
            confidenceThreshold: 0.4   // минимальная вероятность успеха 40%
        };
        
        // Кэш данных о сети
        this.networkCache = {
            gasPrice: { value: 25, timestamp: 0 }, // 25 Gwei по умолчанию
            blockTime: { value: 2200, timestamp: 0 },
            maticPrice: { value: 0.9, timestamp: 0 } // $0.9 за MATIC
        };
        
        // Статистика
        this.stats = {
            totalCalculations: 0,
            viableOpportunities: 0,
            avgConfidence: 0
        };
    }
    
    /**
     * Основной метод расчета арбитражных возможностей
     */
    async calculateArbitrageTimings(opportunity, provider = null) {
        try {
            this.stats.totalCalculations++;
            const startTime = Date.now();
            
            // Обновляем данные о сети
            if (provider) {
                await this.updateNetworkData(provider);
            }
            
            // 1. Расчет времени выполнения
            const executionTime = this.calculateExecutionTime(opportunity);
            
            // 2. Окно жизнеспособности
            const viabilityWindow = this.calculateViabilityWindow(opportunity);
            
            // 3. Распад цены во времени
            const priceDecay = this.calculatePriceDecay(opportunity, executionTime);
            
            // 4. Скорректированная прибыль с реальными затратами
            const adjustedProfit = await this.calculateRealisticProfit(opportunity, provider);
            
            // 5. Вероятность успеха
            const confidence = this.calculateConfidence(opportunity, executionTime, viabilityWindow);
            
            // 6. Дедлайн для действий
            const deadline = startTime + viabilityWindow;
            
            const timingData = {
                discoveryTime: startTime,
                executionTime,
                viabilityWindow,
                priceDecay,
                adjustedProfit,
                confidence,
                deadline,
                timeRemaining: Math.max(0, deadline - Date.now()),
                isViable: this.isOpportunityViable(confidence, adjustedProfit, opportunity),
                recommendation: this.getRecommendation(confidence, adjustedProfit, executionTime),
                networkMetrics: this.getNetworkMetrics()
            };
            
            // Обновляем статистику
            if (timingData.isViable) {
                this.stats.viableOpportunities++;
            }
            
            this.updateAverageConfidence(confidence);
            
            logger.logDebug('Arbitrage timing calculated', {
                token: opportunity.token,
                confidence: (confidence * 100).toFixed(1) + '%',
                netProfit: adjustedProfit.adjustedProfit.toFixed(2),
                executionTime: (executionTime / 1000).toFixed(1) + 's'
            });
            
            return timingData;
            
        } catch (error) {
            logger.logError('Failed to calculate arbitrage timings', error);
            return this.getFallbackTiming(opportunity);
        }
    }
    
    /**
     * Реалистичный расчет времени выполнения
     */
    calculateExecutionTime(opportunity) {
        const {
            avgBlockTime,
            confirmationBlocks,
            gasEstimationTime,
            mempoolDelay,
            rpcLatency,
            dexProcessingTime
        } = this.networkTiming;
        
        // Базовое время транзакции
        const transactionTime = avgBlockTime * confirmationBlocks;
        
        // Дополнительное время для сложных путей
        const pathComplexity = this.getPathComplexity(opportunity);
        const complexityMultiplier = 1 + (pathComplexity * 0.2);
        
        // Время сети в зависимости от загрузки
        const networkLoadMultiplier = this.getNetworkLoadMultiplier();
        
        const totalTime = (
            gasEstimationTime * 2 +     // Два свапа
            mempoolDelay * networkLoadMultiplier * 2 +
            transactionTime * 2 +       // Два блока
            rpcLatency * 4 +           // Множественные RPC вызовы
            dexProcessingTime * 2      // Обработка на двух DEX
        ) * complexityMultiplier;
        
        return Math.max(3000, Math.min(25000, totalTime)); // От 3 до 25 секунд
    }
    
    /**
     * Расчет окна жизнеспособности
     */
    calculateViabilityWindow(opportunity) {
        const { basisPoints, token, buyLiquidity, sellLiquidity } = opportunity;
        
        // Базовое окно в зависимости от спреда
        let baseWindow = 15000; // 15 секунд по умолчанию
        
        if (basisPoints > 200) baseWindow = 25000;      // 25с для больших спредов
        else if (basisPoints > 100) baseWindow = 20000; // 20с для средних
        else if (basisPoints > 50) baseWindow = 15000;  // 15с для малых
        else baseWindow = 10000;                        // 10с для микро-спредов
        
        // Корректировка по волатильности токена
        const volatilityMultiplier = this.getTokenVolatilityMultiplier(token);
        
        // Корректировка по ликвидности
        const minLiquidity = Math.min(buyLiquidity || 0, sellLiquidity || 0);
        const liquidityMultiplier = minLiquidity > 10000 ? 1.2 : 
                                   minLiquidity > 5000 ? 1.0 : 0.8;
        
        // Время суток (ликвидность рынка)
        const timeMultiplier = this.getTimeOfDayMultiplier();
        
        const finalWindow = baseWindow * volatilityMultiplier * liquidityMultiplier * timeMultiplier;
        
        return Math.max(
            this.arbitrageParams.minExecutionWindow,
            Math.min(this.arbitrageParams.maxExecutionWindow, finalWindow)
        );
    }
    
    /**
     * Расчет распада цены
     */
    calculatePriceDecay(opportunity, executionTimeMs) {
        const { basisPoints, token } = opportunity;
        const executionTimeSeconds = executionTimeMs / 1000;
        
        // Адаптивная скорость распада
        let decayRate = this.arbitrageParams.priceDecayRate;
        
        // Стейблкоины распадают медленнее
        if (['USDC', 'USDT'].includes(token)) {
            decayRate *= 0.6;
        }
        // Волатильные токены быстрее
        else if (['AAVE', 'CRV'].includes(token)) {
            decayRate *= 1.4;
        }
        
        // Большие спреды более устойчивы
        if (basisPoints > 150) decayRate *= 0.8;
        else if (basisPoints < 75) decayRate *= 1.3;
        
        // Экспоненциальный распад
        const decayFactor = Math.exp(-decayRate * executionTimeSeconds);
        const remainingSpread = basisPoints * decayFactor;
        
        return {
            originalSpread: basisPoints,
            remainingSpread: Math.round(Math.max(0, remainingSpread)),
            decayPercentage: ((basisPoints - remainingSpread) / basisPoints) * 100,
            decayRate,
            timeToHalfLife: Math.log(2) / decayRate
        };
    }
    
    /**
     * Реалистичный расчет прибыли с учетом всех затрат
     */
    async calculateRealisticProfit(opportunity, provider) {
        const { potentialProfit, inputAmount, token } = opportunity;
        
        // 1. Стоимость газа (реалистичная)
        const gasCost = await this.calculateGasCosts(token, provider);
        
        // 2. Комиссии DEX (точные)
        const dexFees = this.calculateDEXFees(opportunity);
        
        // 3. Slippage (на основе ликвидности)
        const slippageCost = this.calculateSlippageCosts(opportunity);
        
        // 4. MEV protection и другие скрытые затраты
        const hiddenCosts = this.calculateHiddenCosts(inputAmount);
        
        const totalCosts = gasCost + dexFees + slippageCost + hiddenCosts;
        const adjustedProfit = Math.max(0, potentialProfit - totalCosts);
        
        return {
            originalProfit: potentialProfit,
            adjustedProfit,
            totalCosts,
            breakdown: {
                gasInUSD: gasCost,
                dexFees,
                slippageCost,
                hiddenCosts
            },
            profitMargin: (adjustedProfit / inputAmount) * 100,
            roi: (adjustedProfit / inputAmount) * 100
        };
    }
    
    /**
     * Реальная стоимость газа
     */
    async calculateGasCosts(tokenSymbol, provider) {
        try {
            // Обновляем цену газа если нужно
            await this.updateGasPrice(provider);
            
            const gasPrice = this.networkCache.gasPrice.value;
            const maticPrice = this.networkCache.maticPrice.value;
            
            // Реалистичные оценки газа для арбитража
            const gasEstimates = {
                'WBTC': 350000,  // WBTC требует больше газа
                'WETH': 300000,  // ETH стандарт
                'USDT': 400000,  // USDT известен высоким потреблением
                'USDC': 280000,  // USDC эффективнее
                'default': 320000 // По умолчанию
            };
            
            const gasLimit = gasEstimates[tokenSymbol] || gasEstimates.default;
            
            // Конвертация в USD
            const gasInMATIC = (gasPrice * gasLimit) / 1e9; // Gwei to MATIC
            const gasInUSD = gasInMATIC * maticPrice;
            
            return Math.max(0.5, gasInUSD); // Минимум $0.5
            
        } catch (error) {
            logger.logWarning('Failed to calculate gas costs, using estimate', error.message);
            return 1.5; // Консервативная оценка $1.5
        }
    }
    
    /**
     * Точные комиссии DEX
     */
    calculateDEXFees(opportunity) {
        const { inputAmount, buyDex, sellDex } = opportunity;
        
        // Комиссии разных DEX
        const dexFees = {
            'sushiswap': 0.003,   // 0.3%
            'quickswap': 0.003,   // 0.3%
            'uniswap': 0.003,     // 0.3% (может варьироваться в V3)
            'default': 0.003
        };
        
        const buyFee = dexFees[buyDex] || dexFees.default;
        const sellFee = dexFees[sellDex] || dexFees.default;
        
        return inputAmount * (buyFee + sellFee);
    }
    
    /**
     * Расчет slippage на основе ликвидности
     */
    calculateSlippageCosts(opportunity) {
        const { inputAmount, buyLiquidity, sellLiquidity } = opportunity;
        
        const minLiquidity = Math.min(buyLiquidity || 1000, sellLiquidity || 1000);
        const tradeRatio = inputAmount / minLiquidity;
        
        // Прогрессивный slippage
        let slippagePercent = 0.001; // 0.1% базовый
        
        if (tradeRatio > 0.05) slippagePercent = 0.02;      // 2% для больших сделок
        else if (tradeRatio > 0.02) slippagePercent = 0.01; // 1% для средних
        else if (tradeRatio > 0.01) slippagePercent = 0.005; // 0.5% для малых
        
        return inputAmount * slippagePercent * 2; // Два свапа
    }
    
    /**
     * Скрытые затраты (MEV, network congestion)
     */
    calculateHiddenCosts(inputAmount) {
        // MEV protection - реальная проблема
        const mevCost = inputAmount * 0.0008; // 0.08%
        
        // Network congestion surcharge
        const congestionCost = inputAmount * 0.0003; // 0.03%
        
        return mevCost + congestionCost;
    }
    
    /**
     * Расчет вероятности успеха
     */
    calculateConfidence(opportunity, executionTime, viabilityWindow) {
        let confidence = 1.0;
        const { basisPoints, token, buyLiquidity, sellLiquidity } = opportunity;
        
        // 1. Временной фактор
        const timeRatio = executionTime / viabilityWindow;
        confidence *= Math.max(0.3, 1 - timeRatio * 0.6);
        
        // 2. Спред фактор
        if (basisPoints < 50) confidence *= 0.4;
        else if (basisPoints < 75) confidence *= 0.6;
        else if (basisPoints < 100) confidence *= 0.8;
        // Большие спреды не штрафуются
        
        // 3. Ликвидность фактор
        const minLiquidity = Math.min(buyLiquidity || 0, sellLiquidity || 0);
        if (minLiquidity > 10000) confidence *= 1.0;
        else if (minLiquidity > 5000) confidence *= 0.9;
        else if (minLiquidity > 2000) confidence *= 0.7;
        else confidence *= 0.5;
        
        // 4. Токен фактор
        const tokenConfidence = this.getTokenConfidenceFactor(token);
        confidence *= tokenConfidence;
        
        // 5. Путь фактор
        const pathConfidence = this.getPathConfidenceFactor(opportunity);
        confidence *= pathConfidence;
        
        return Math.max(0.1, Math.min(0.95, confidence));
    }
    
    /**
     * Проверка жизнеспособности возможности
     */
    isOpportunityViable(confidence, adjustedProfit, opportunity) {
        const minProfit = 3; // Минимум $3
        const minConfidence = this.arbitrageParams.confidenceThreshold;
        const minROI = 0.3; // 0.3% минимальный ROI
        
        const roi = (adjustedProfit.adjustedProfit / opportunity.inputAmount) * 100;
        
        return confidence >= minConfidence && 
               adjustedProfit.adjustedProfit >= minProfit &&
               roi >= minROI;
    }
    
    /**
     * Получение рекомендации
     */
    getRecommendation(confidence, adjustedProfit, executionTime) {
        const profit = adjustedProfit.adjustedProfit;
        const roi = adjustedProfit.roi;
        
        if (profit < 3 || confidence < 0.3) {
            return {
                action: 'SKIP',
                reason: `Low profit/confidence (${profit.toFixed(2)}, ${(confidence*100).toFixed(1)}%)`,
                urgency: 'none',
                priority: 0
            };
        }
        
        if (confidence > 0.8 && profit > 20) {
            return {
                action: 'EXECUTE_IMMEDIATELY',
                reason: `Excellent opportunity (${(confidence*100).toFixed(1)}%, $${profit.toFixed(2)})`,
                urgency: 'critical',
                priority: 10
            };
        }
        
        if (confidence > 0.6 && profit > 10) {
            return {
                action: 'EXECUTE',
                reason: `Good opportunity (${(confidence*100).toFixed(1)}%, $${profit.toFixed(2)})`,
                urgency: 'high',
                priority: 7
            };
        }
        
        if (confidence > 0.4 && profit > 5) {
            return {
                action: 'MONITOR',
                reason: `Marginal opportunity (${(confidence*100).toFixed(1)}%, $${profit.toFixed(2)})`,
                urgency: 'medium',
                priority: 4
            };
        }
        
        return {
            action: 'SKIP',
            reason: `Below threshold (${(confidence*100).toFixed(1)}%, $${profit.toFixed(2)})`,
            urgency: 'low',
            priority: 1
        };
    }
    
    // Вспомогательные методы
    
    getPathComplexity(opportunity) {
        const buyPathLength = opportunity.buyPath?.length || 2;
        const sellPathLength = opportunity.sellPath?.length || 2;
        return (buyPathLength + sellPathLength - 4) / 4; // Нормализовано от 0 до 1
    }
    
    getNetworkLoadMultiplier() {
        const currentHour = new Date().getUTCHours();
        // Пиковые часы UTC (когда активны США и Европа)
        if (currentHour >= 13 && currentHour <= 21) return 1.3;
        if (currentHour >= 22 || currentHour <= 6) return 0.8;
        return 1.0;
    }
    
    getTokenVolatilityMultiplier(tokenSymbol) {
        const volatilityMap = {
            'USDC': 1.5,   // Стейблкоины - длинное окно
            'USDT': 1.5,
            'WETH': 1.0,   // ETH - стандарт
            'WBTC': 1.1,   // BTC чуть стабильнее
            'WMATIC': 1.2, // Родной токен
            'LINK': 0.8,   // Волатильный
            'AAVE': 0.7,   // Очень волатильный
            'CRV': 0.6     // Максимально волатильный
        };
        return volatilityMap[tokenSymbol] || 0.9;
    }
    
    getTimeOfDayMultiplier() {
        const currentHour = new Date().getUTCHours();
        if (currentHour >= 13 && currentHour <= 20) return 1.1; // Активные часы
        if (currentHour >= 21 || currentHour <= 6) return 0.9;  // Тихие часы
        return 1.0;
    }
    
    getTokenConfidenceFactor(tokenSymbol) {
        const confidenceMap = {
            'USDC': 0.95,
            'USDT': 0.9,
            'WETH': 0.9,
            'WBTC': 0.85,
            'WMATIC': 0.9,
            'LINK': 0.8,
            'AAVE': 0.75,
            'CRV': 0.7
        };
        return confidenceMap[tokenSymbol] || 0.8;
    }
    
    getPathConfidenceFactor(opportunity) {
        const buyPathLength = opportunity.buyPath?.length || 2;
        const sellPathLength = opportunity.sellPath?.length || 2;
        
        // Прямые пути лучше
        if (buyPathLength === 2 && sellPathLength === 2) return 1.0;
        if (buyPathLength <= 3 && sellPathLength <= 3) return 0.9;
        return 0.8;
    }
    
    async updateNetworkData(provider) {
        try {
            const now = Date.now();
            
            // Обновляем данные каждые 2 минуты
            if (now - this.networkCache.gasPrice.timestamp > 120000) {
                await this.updateGasPrice(provider);
            }
            
        } catch (error) {
            logger.logDebug('Failed to update network data', error.message);
        }
    }
    
    async updateGasPrice(provider) {
        try {
            if (!provider) return;
            
            const feeData = await provider.getFeeData();
            const gasPriceGwei = parseFloat(ethers.formatUnits(feeData.gasPrice || '25000000000', 'gwei'));
            
            this.networkCache.gasPrice = {
                value: gasPriceGwei,
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.logDebug('Failed to update gas price', error.message);
        }
    }
    
    getNetworkMetrics() {
        return {
            gasPrice: this.networkCache.gasPrice.value,
            maticPrice: this.networkCache.maticPrice.value,
            avgBlockTime: this.networkCache.blockTime.value,
            lastUpdated: Math.max(
                this.networkCache.gasPrice.timestamp,
                this.networkCache.maticPrice.timestamp
            )
        };
    }
    
    getFallbackTiming(opportunity) {
        // Простой fallback расчет
        const adjustedProfit = Math.max(0, opportunity.potentialProfit - 3); // $3 затраты
        
        return {
            isViable: adjustedProfit > 2,
            confidence: 0.5,
            adjustedProfit: {
                adjustedProfit,
                totalCosts: 3,
                gasInUSD: 1.5,
                dexFees: 1.5,
                slippageCost: 0,
                hiddenCosts: 0
            },
            executionTime: 8000,
            deadline: Date.now() + 15000,
            recommendation: {
                action: adjustedProfit > 5 ? 'MONITOR' : 'SKIP',
                reason: 'Fallback calculation',
                priority: 3
            }
        };
    }
    
    updateAverageConfidence(confidence) {
        const totalCalcs = this.stats.totalCalculations;
        const currentAvg = this.stats.avgConfidence;
        this.stats.avgConfidence = ((currentAvg * (totalCalcs - 1)) + confidence) / totalCalcs;
    }
    
    getCalibrationStats() {
        const viabilityRate = this.stats.totalCalculations > 0 ?
            (this.stats.viableOpportunities / this.stats.totalCalculations) * 100 : 0;
        
        return {
            totalCalculations: this.stats.totalCalculations,
            viableOpportunities: this.stats.viableOpportunities,
            viabilityRate: viabilityRate.toFixed(1) + '%',
            avgConfidence: (this.stats.avgConfidence * 100).toFixed(1) + '%'
        };
    }
}

module.exports = ArbitrageTimeCalculator;