const logger = require('./logger');

class ArbitrageTimeCalculator {
    constructor() {
        // Polygon network timing constants (динамически обновляемые)
        this.networkTiming = {
            avgBlockTime: 2100,        // ~2.1 секунды на блок (будет обновляться)
            confirmationBlocks: 2,     // блоков для подтверждения
            gasEstimationTime: 500,    // время на расчет газа
            mempoolDelay: 300,         // средняя задержка в mempool (адаптивная)
            rpcLatency: 200,           // задержка RPC вызовов
            dexProcessingTime: 1000    // время обработки на DEX
        };
        
        // Арбитражные параметры (калиброванные)
        this.arbitrageParams = {
            minExecutionWindow: 8000,   // мин. окно в мс (снижено)
            maxExecutionWindow: 45000,  // макс. окно в мс (снижено)
            priceDecayRate: 0.08,      // падение спреда % за секунду (увеличено)
            slippageFactor: 0.002,     // дополнительный slippage (снижено)
            confidenceThreshold: 0.55  // мин. вероятность успеха (снижено)
        };
        
        // Cache для динамических параметров
        this.dynamicCache = {
            avgBlockTime: { value: 2100, timestamp: 0, samples: [] },
            gasPriceCache: { price: 30, timestamp: 0, expiry: 30000 },
            networkLoad: { value: 'normal', timestamp: 0 }
        };
        
        // Статистика для калибровки
        this.calibrationStats = {
            totalOpportunities: 0,
            successfulPredictions: 0,
            timeErrors: [],
            priceDecayErrors: []
        };
    }
    
    /**
     * Рассчитать временные параметры арбитража с улучшенными алгоритмами
     */
    async calculateArbitrageTimings(opportunity, provider = null) {
        try {
            const discoveryTime = Date.now();
            
            // Обновить динамические параметры сети
            if (provider) {
                await this.updateNetworkMetrics(provider);
            }
            
            // 1. Время выполнения транзакций (адаптивное)
            const executionTime = this.calculateAdaptiveExecutionTime();
            
            // 2. Окно жизнеспособности (улучшенное)
            const viabilityWindow = this.calculateImprovedViabilityWindow(opportunity);
            
            // 3. Временной распад цены (калиброванный)
            const priceDecay = this.calculateCalibratedPriceDecay(opportunity, executionTime);
            
            // 4. Скорректированная прибыль (с реальными ценами на газ)
            const adjustedProfit = await this.calculatePreciseAdjustedProfit(opportunity, priceDecay, provider);
            
            // 5. Вероятность успеха (улучшенная)
            const confidence = this.calculateImprovedConfidence(opportunity, executionTime, viabilityWindow);
            
            // 6. Дедлайн для действий
            const deadline = discoveryTime + viabilityWindow;
            
            const timingData = {
                discoveryTime,
                executionTime,
                viabilityWindow,
                priceDecay,
                adjustedProfit,
                confidence,
                deadline,
                timeRemaining: Math.max(0, deadline - Date.now()),
                isViable: confidence >= this.arbitrageParams.confidenceThreshold && 
                         adjustedProfit.adjustedProfit > 3, // Снижено до $3
                recommendation: this.getImprovedRecommendation(confidence, adjustedProfit, executionTime),
                networkMetrics: this.getNetworkMetrics()
            };
            
            // Обновить статистику для дальнейшей калибровки
            this.updateCalibrationStats(timingData);
            
            logger.logDebug('Enhanced arbitrage timing calculated', {
                confidence: confidence.toFixed(3),
                adjustedProfit: adjustedProfit.adjustedProfit.toFixed(2),
                executionTime: executionTime.toFixed(0),
                avgBlockTime: this.dynamicCache.avgBlockTime.value.toFixed(0)
            });
            
            return timingData;
            
        } catch (error) {
            logger.logError('Failed to calculate arbitrage timings', error);
            return null;
        }
    }
    
    /**
     * Обновить метрики сети в реальном времени
     */
    async updateNetworkMetrics(provider) {
        try {
            const now = Date.now();
            
            // Обновляем время блока каждые 5 минут
            if (now - this.dynamicCache.avgBlockTime.timestamp > 300000) {
                const currentBlock = await provider.getBlockNumber();
                const block1 = await provider.getBlock(currentBlock);
                const block2 = await provider.getBlock(currentBlock - 10);
                
                if (block1 && block2) {
                    const timeDiff = block1.timestamp - block2.timestamp;
                    const newAvgBlockTime = (timeDiff / 10) * 1000; // в миллисекундах
                    
                    // Добавляем в выборку для сглаживания
                    this.dynamicCache.avgBlockTime.samples.push(newAvgBlockTime);
                    if (this.dynamicCache.avgBlockTime.samples.length > 20) {
                        this.dynamicCache.avgBlockTime.samples.shift();
                    }
                    
                    // Вычисляем сглаженное среднее
                    const avgSamples = this.dynamicCache.avgBlockTime.samples.reduce((a, b) => a + b, 0) / 
                                      this.dynamicCache.avgBlockTime.samples.length;
                    
                    this.dynamicCache.avgBlockTime.value = avgSamples;
                    this.dynamicCache.avgBlockTime.timestamp = now;
                    
                    // Обновляем параметры сети
                    this.networkTiming.avgBlockTime = avgSamples;
                    
                    logger.logDebug('Network metrics updated', {
                        newAvgBlockTime: newAvgBlockTime.toFixed(0),
                        smoothedAvg: avgSamples.toFixed(0),
                        samples: this.dynamicCache.avgBlockTime.samples.length
                    });
                }
            }
            
        } catch (error) {
            logger.logDebug('Failed to update network metrics', error.message);
        }
    }
    
    /**
     * Адаптивный расчет времени выполнения
     */
    calculateAdaptiveExecutionTime() {
        const {
            avgBlockTime,
            confirmationBlocks,
            gasEstimationTime,
            mempoolDelay,
            rpcLatency,
            dexProcessingTime
        } = this.networkTiming;
        
        // Время на транзакции с учетом реального времени блоков
        const transactionTime = (avgBlockTime * confirmationBlocks) * 2;
        
        // Адаптивная задержка mempool в зависимости от загрузки сети
        const networkLoad = this.getNetworkLoadMultiplier();
        const adaptiveMempoolDelay = mempoolDelay * networkLoad;
        
        // Общее время с буфером безопасности
        const baseTime = 
            gasEstimationTime * 2 +
            adaptiveMempoolDelay * 2 +
            transactionTime +
            rpcLatency * 4 +
            dexProcessingTime * 2;
        
        // Добавляем 20% буфер для непредвиденных задержек
        const totalTime = baseTime * 1.2;
        
        return totalTime;
    }
    
    /**
     * Получить множитель загрузки сети
     */
    getNetworkLoadMultiplier() {
        const currentHour = new Date().getUTCHours();
        
        // Простая эвристика на основе времени суток (UTC)
        if (currentHour >= 12 && currentHour <= 20) {
            return 1.3; // Пиковые часы - больше задержек
        } else if (currentHour >= 21 || currentHour <= 6) {
            return 0.8; // Ночные часы - меньше задержек
        }
        return 1.0; // Обычное время
    }
    
    /**
     * Улучшенный расчет окна жизнеспособности
     */
    calculateImprovedViabilityWindow(opportunity) {
        const { basisPoints, token } = opportunity;
        
        // Базовое окно в зависимости от спреда (более консервативно)
        let baseWindow;
        if (basisPoints > 300) {
            baseWindow = 25000; // 25 секунд для очень больших спредов
        } else if (basisPoints > 200) {
            baseWindow = 18000; // 18 секунд для больших спредов
        } else if (basisPoints > 100) {
            baseWindow = 12000; // 12 секунд для средних
        } else if (basisPoints > 50) {
            baseWindow = 8000;  // 8 секунд для малых
        } else {
            baseWindow = 5000;  // 5 секунд для очень малых
        }
        
        // Учитываем волатильность токена (калиброванные коэффициенты)
        const volatilityMultiplier = this.getCalibratedVolatilityMultiplier(token);
        
        // Учитываем время суток (ликвидность)
        const timeOfDayMultiplier = this.getTimeOfDayMultiplier();
        
        const finalWindow = Math.min(
            baseWindow * volatilityMultiplier * timeOfDayMultiplier,
            this.arbitrageParams.maxExecutionWindow
        );
        
        return Math.max(finalWindow, this.arbitrageParams.minExecutionWindow);
    }
    
    /**
     * Калиброванные множители волатильности
     */
    getCalibratedVolatilityMultiplier(tokenSymbol) {
        // Калиброванные на основе исторических данных
        const volatilityMap = {
            'USDC': 1.4,   // стейблкоины - длинное окно
            'USDT': 1.4,
            'WETH': 0.9,   // ETH - средняя волатильность
            'WBTC': 0.95,  // BTC - чуть лучше ETH
            'WMATIC': 1.1,  // MATIC - родной токен
            'LINK': 0.85,  // LINK - высокая волатильность
            'AAVE': 0.7,   // DeFi токены - очень волатильные
            'CRV': 0.6     // Governance токены - максимальная волатильность
        };
        
        return volatilityMap[tokenSymbol] || 0.8;
    }
    
    /**
     * Множитель времени суток
     */
    getTimeOfDayMultiplier() {
        const currentHour = new Date().getUTCHours();
        
        // Больше ликвидности = дольше живут арбитражи
        if (currentHour >= 13 && currentHour <= 21) {
            return 1.1; // Активные часы (US/EU overlap)
        } else if (currentHour >= 22 || currentHour <= 6) {
            return 0.9; // Низкая активность
        }
        return 1.0;
    }
    
    /**
     * Калиброванный расчет временного распада
     */
    calculateCalibratedPriceDecay(opportunity, executionTimeMs) {
        const { basisPoints, token } = opportunity;
        const executionTimeSeconds = executionTimeMs / 1000;
        
        // Адаптивная скорость распада в зависимости от типа токена
        let decayRate = this.arbitrageParams.priceDecayRate;
        
        // Стейблкоины распадают медленнее
        if (['USDC', 'USDT'].includes(token)) {
            decayRate *= 0.5;
        }
        // Волатильные токены - быстрее
        else if (['AAVE', 'CRV'].includes(token)) {
            decayRate *= 1.5;
        }
        
        // Большие спреды более устойчивы
        if (basisPoints > 200) {
            decayRate *= 0.8;
        } else if (basisPoints < 75) {
            decayRate *= 1.3;
        }
        
        // Модель: комбинация экспоненциального и линейного распада
        const exponentialDecay = Math.exp(-decayRate * executionTimeSeconds);
        const linearDecay = Math.max(0, 1 - (decayRate * 0.5 * executionTimeSeconds));
        
        // Взвешенная комбинация (70% экспоненциальный, 30% линейный)
        const combinedDecay = (exponentialDecay * 0.7) + (linearDecay * 0.3);
        
        const remainingSpread = basisPoints * combinedDecay;
        const decayedBasisPoints = basisPoints - remainingSpread;
        
        return {
            originalSpread: basisPoints,
            remainingSpread: Math.round(Math.max(0, remainingSpread)),
            decayedSpread: Math.round(decayedBasisPoints),
            decayPercentage: (decayedBasisPoints / basisPoints) * 100,
            decayModel: 'calibrated_combined',
            effectiveDecayRate: decayRate
        };
    }
    
    /**
     * Точный расчет скорректированной прибыли
     */
    async calculatePreciseAdjustedProfit(opportunity, priceDecay, provider = null) {
        const { potentialProfit, inputAmount } = opportunity;
        
        // Корректировка на временной распад
        const spreadAdjustment = Math.max(0, priceDecay.remainingSpread / priceDecay.originalSpread);
        
        // Улучшенный расчет slippage
        const slippageCost = this.calculatePreciseSlippage(opportunity, inputAmount);
        
        // Реальная стоимость газа
        const gasCost = await this.estimateRealGasCosts(provider);
        
        // Дополнительные costs (MEV protection, network congestion)
        const additionalCosts = this.calculateAdditionalCosts(opportunity);
        
        const totalCosts = slippageCost + gasCost + additionalCosts;
        const adjustedProfit = Math.max(0, (potentialProfit * spreadAdjustment) - totalCosts);
        
        return {
            originalProfit: potentialProfit,
            adjustedProfit,
            slippageCost,
            gasCost,
            additionalCosts,
            totalCosts,
            profitReduction: potentialProfit - adjustedProfit,
            profitMargin: (adjustedProfit / inputAmount) * 100,
            spreadAdjustment,
            effectiveROI: (adjustedProfit / inputAmount) * 100
        };
    }
    
    /**
     * Точный расчет slippage
     */
    calculatePreciseSlippage(opportunity, inputAmount) {
        const { token, buyDex, sellDex } = opportunity;
        
        // Базовый slippage
        let baseSlippage = this.arbitrageParams.slippageFactor;
        
        // Корректировка по размеру сделки
        if (inputAmount > 5000) {
            baseSlippage *= 1.5; // Больше сделка = больше slippage
        } else if (inputAmount < 1000) {
            baseSlippage *= 0.8; // Маленькая сделка = меньше slippage
        }
        
        // Корректировка по DEX (на основе исторических данных)
        const dexSlippageMultipliers = {
            'uniswap': 0.9,    // Лучшая ликвидность
            'sushiswap': 1.0,  // Средняя ликвидность
            'quickswap': 1.2   // Ниже ликвидность
        };
        
        const buyMultiplier = dexSlippageMultipliers[buyDex] || 1.0;
        const sellMultiplier = dexSlippageMultipliers[sellDex] || 1.0;
        const avgMultiplier = (buyMultiplier + sellMultiplier) / 2;
        
        // Корректировка по токену
        const tokenSlippageMultipliers = {
            'USDC': 0.5,   // Минимальный slippage
            'USDT': 0.5,
            'WETH': 0.8,   // Хорошая ликвидность
            'WBTC': 0.9,
            'WMATIC': 0.7,
            'LINK': 1.2,   // Средняя ликвидность
            'AAVE': 1.5,   // Высокий slippage
            'CRV': 1.8     // Очень высокий slippage
        };
        
        const tokenMultiplier = tokenSlippageMultipliers[token] || 1.0;
        
        const finalSlippage = baseSlippage * avgMultiplier * tokenMultiplier;
        return inputAmount * finalSlippage;
    }
    
    /**
     * Расчет дополнительных costs
     */
    calculateAdditionalCosts(opportunity) {
        const { inputAmount } = opportunity;
        
        // MEV protection cost (приблизительно)
        const mevCost = inputAmount * 0.0005; // 0.05%
        
        // Network congestion cost
        const congestionCost = inputAmount * 0.0002; // 0.02%
        
        return mevCost + congestionCost;
    }
    
    /**
     * Улучшенная оценка confidence
     */
    calculateImprovedConfidence(opportunity, executionTime, viabilityWindow) {
        let confidence = 1.0;
        const { basisPoints, token, buyDex, sellDex } = opportunity;
        
        // 1. Временной фактор (улучшенная формула)
        const timeRatio = executionTime / viabilityWindow;
        const timePenalty = Math.min(0.5, timeRatio * 0.6); // Максимум -50%
        confidence *= (1 - timePenalty);
        
        // 2. Спред фактор (более градуальный)
        let spreadMultiplier = 1.0;
        if (basisPoints < 40) {
            spreadMultiplier = 0.3; // Очень низкая для микро-спредов
        } else if (basisPoints < 60) {
            spreadMultiplier = 0.5;
        } else if (basisPoints < 80) {
            spreadMultiplier = 0.65;
        } else if (basisPoints < 120) {
            spreadMultiplier = 0.8;
        } else if (basisPoints < 200) {
            spreadMultiplier = 0.9;
        }
        // Для больших спредов не снижаем
        confidence *= spreadMultiplier;
        
        // 3. Токен фактор (калиброванный)
        const tokenConfidence = this.getTokenConfidenceFactor(token);
        confidence *= tokenConfidence;
        
        // 4. DEX фактор (качество ликвидности)
        const dexConfidence = this.getDexConfidenceFactor(buyDex, sellDex);
        confidence *= dexConfidence;
        
        // 5. Путь фактор (сложность пути)
        const pathConfidence = this.getPathConfidenceFactor(opportunity);
        confidence *= pathConfidence;
        
        // 6. Время суток фактор
        const timeConfidence = this.getTimeOfDayConfidence();
        confidence *= timeConfidence;
        
        return Math.max(0.05, Math.min(0.98, confidence)); // Диапазон 5%-98%
    }
    
    /**
     * Фактор confidence по токену
     */
    getTokenConfidenceFactor(tokenSymbol) {
        const tokenFactors = {
            'USDC': 0.95,  // Очень высокая
            'USDT': 0.92,
            'WETH': 0.88,  // Высокая
            'WBTC': 0.85,
            'WMATIC': 0.90, // Родной токен
            'LINK': 0.78,  // Средняя
            'AAVE': 0.70,  // Ниже средней
            'CRV': 0.65    // Низкая
        };
        
        return tokenFactors[tokenSymbol] || 0.75;
    }
    
    /**
     * Фактор confidence по DEX
     */
    getDexConfidenceFactor(buyDex, sellDex) {
        const dexFactors = {
            'uniswap': 0.95,
            'sushiswap': 0.88,
            'quickswap': 0.82
        };
        
        const buyFactor = dexFactors[buyDex] || 0.8;
        const sellFactor = dexFactors[sellDex] || 0.8;
        
        return (buyFactor + sellFactor) / 2;
    }
    
    /**
     * Фактор confidence по пути
     */
    getPathConfidenceFactor(opportunity) {
        const { buyPath, sellPath } = opportunity;
        let factor = 1.0;
        
        // Прямые пути лучше
        if (buyPath && buyPath.length === 2) factor *= 1.05;
        if (sellPath && sellPath.length === 2) factor *= 1.05;
        
        // Длинные пути хуже
        const avgPathLength = ((buyPath?.length || 3) + (sellPath?.length || 3)) / 2;
        if (avgPathLength > 3) {
            factor *= Math.pow(0.9, avgPathLength - 3);
        }
        
        return Math.max(0.7, factor);
    }
    
    /**
     * Фактор confidence по времени суток
     */
    getTimeOfDayConfidence() {
        const currentHour = new Date().getUTCHours();
        
        if (currentHour >= 13 && currentHour <= 20) {
            return 1.0; // Пиковая ликвидность
        } else if (currentHour >= 8 && currentHour <= 12) {
            return 0.95; // Хорошая ликвидность
        } else if (currentHour >= 21 && currentHour <= 23) {
            return 0.9; // Снижающаяся ликвидность
        } else {
            return 0.8; // Низкая ликвидность (ночь)
        }
    }
    
    /**
     * Реальная оценка газовых затрат
     */
    async estimateRealGasCosts(provider = null) {
        try {
            let gasPriceGwei = this.dynamicCache.gasPriceCache.price;
            
            // Обновить кэш газа если нужно
            if (provider && Date.now() - this.dynamicCache.gasPriceCache.timestamp > this.dynamicCache.gasPriceCache.expiry) {
                try {
                    gasPriceGwei = await this.getCurrentGasPrice(provider);
                    this.dynamicCache.gasPriceCache = {
                        price: gasPriceGwei,
                        timestamp: Date.now(),
                        expiry: 30000
                    };
                } catch (error) {
                    logger.logDebug('Failed to get current gas price, using cached', error.message);
                }
            }
            
            // Более точные оценки газа для арбитража
            const gasEstimates = {
                approval: 50000,       // ERC20 approve (если нужно)
                v2Swap: 120000,        // Uniswap V2 style swap
                v3Swap: 180000,        // Uniswap V3 style swap
                transfer: 21000,       // Базовый transfer
                overhead: 30000        // Дополнительные операции
            };
            
            // Адаптивная оценка в зависимости от сложности
            const estimatedGas = 
                gasEstimates.approval + 
                gasEstimates.v2Swap * 2 + // 2 свапа
                gasEstimates.overhead;
            
            // Конвертация в USD
            const gasCostMatic = (gasPriceGwei * estimatedGas) / 1e9;
            
            // Получить цену MATIC
            let maticPriceUSD = 1;
            try {
                maticPriceUSD = await this.getCachedTokenPriceUSD('WMATIC');
            } catch (error) {
                logger.logDebug('Failed to get MATIC price, using fallback');
            }
            
            const gasCostUSD = gasCostMatic * maticPriceUSD;
            
            return Math.max(0.5, gasCostUSD); // Минимум $0.5
            
        } catch (error) {
            logger.logError('Failed to estimate gas costs', error);
            return 1.5; // Консервативный fallback
        }
    }
    
    /**
     * Получить текущую цену газа
     */
    async getCurrentGasPrice(provider) {
        try {
            const feeData = await provider.getFeeData();
            return parseFloat(ethers.formatUnits(feeData.gasPrice, 'gwei'));
        } catch (error) {
            return 30; // Default fallback
        }
    }
    
    /**
     * Получить кэшированную цену токена в USD
     */
    async getCachedTokenPriceUSD(tokenSymbol) {
        const fallbackPrices = {
            'WETH': 2000,
            'WBTC': 35000,
            'WMATIC': 1,
            'LINK': 15,
            'AAVE': 80,
            'CRV': 0.5,
            'USDC': 1,
            'USDT': 1
        };
        
        try {
            // Попробовать получить из utils, если доступно
            const { getTokenPriceUSD } = require('./utils');
            return await getTokenPriceUSD(tokenSymbol);
        } catch (error) {
            return fallbackPrices[tokenSymbol] || 1;
        }
    }
    
    /**
     * Улучшенные рекомендации
     */
    getImprovedRecommendation(confidence, adjustedProfit, executionTime) {
        const profit = adjustedProfit.adjustedProfit;
        const roi = adjustedProfit.effectiveROI;
        
        if (confidence < 0.25 || profit < 1) {
            return {
                action: 'SKIP',
                reason: `${confidence < 0.25 ? 'Very low confidence' : 'Insufficient profit'} (${confidence.toFixed(1)}%, $${profit.toFixed(2)})`,
                urgency: 'none',
                priority: 0
            };
        }
        
        if (profit < 3 || roi < 0.2) {
            return {
                action: 'MONITOR',
                reason: `Low profit/ROI (${profit.toFixed(2)}, ${roi.toFixed(2)}%)`,
                urgency: 'low',
                priority: 1
            };
        }
        
        if (confidence > 0.85 && profit > 30 && roi > 2.5) {
            return {
                action: 'EXECUTE_IMMEDIATELY',
                reason: `Excellent opportunity (${confidence.toFixed(1)}%, ${profit.toFixed(2)}, ${roi.toFixed(1)}% ROI)`,
                urgency: 'critical',
                priority: 10
            };
        }
        
        if (confidence > 0.75 && profit > 20 && roi > 1.5) {
            return {
                action: 'EXECUTE_FAST',
                reason: `High confidence opportunity (${confidence.toFixed(1)}%, ${profit.toFixed(2)})`,
                urgency: 'high',
                priority: 8
            };
        }
        
        if (confidence > 0.65 && profit > 10 && roi > 0.8) {
            return {
                action: 'EXECUTE',
                reason: `Good opportunity (${confidence.toFixed(1)}%, ${profit.toFixed(2)})`,
                urgency: 'medium',
                priority: 6
            };
        }
        
        if (executionTime > 25000) {
            return {
                action: 'MONITOR',
                reason: `Slow execution expected (${(executionTime/1000).toFixed(1)}s)`,
                urgency: 'low',
                priority: 2
            };
        }
        
        if (confidence > 0.55 && profit > 5 && roi > 0.4) {
            return {
                action: 'CONSIDER',
                reason: `Marginal opportunity (${confidence.toFixed(1)}%, ${profit.toFixed(2)})`,
                urgency: 'low',
                priority: 3
            };
        }
        
        return {
            action: 'SKIP',
            reason: `Below threshold (${confidence.toFixed(1)}%, ${profit.toFixed(2)})`,
            urgency: 'none',
            priority: 0
        };
    }
    
    /**
     * Проверить актуальность возможности
     */
    isOpportunityStillValid(timingData) {
        const now = Date.now();
        const timeElapsed = now - timingData.discoveryTime;
        const timeRemaining = Math.max(0, timingData.deadline - now);
        
        return {
            isValid: now < timingData.deadline,
            timeElapsed,
            timeRemaining,
            urgency: this.getUrgencyLevel(timeRemaining),
            percentageTimeElapsed: (timeElapsed / timingData.viabilityWindow) * 100,
            decayedConfidence: timingData.confidence * (timeRemaining / timingData.viabilityWindow)
        };
    }
    
    /**
     * Получить уровень срочности
     */
    getUrgencyLevel(timeRemaining) {
        if (timeRemaining < 2000) return 'CRITICAL';   // < 2 seconds
        if (timeRemaining < 5000) return 'HIGH';       // < 5 seconds
        if (timeRemaining < 10000) return 'MEDIUM';    // < 10 seconds
        if (timeRemaining < 20000) return 'LOW';       // < 20 seconds
        return 'NONE';
    }
    
    /**
     * Получить метрики сети
     */
    getNetworkMetrics() {
        return {
            avgBlockTime: this.dynamicCache.avgBlockTime.value,
            gasPrice: this.dynamicCache.gasPriceCache.price,
            networkLoad: this.getNetworkLoadMultiplier(),
            lastUpdated: Math.max(
                this.dynamicCache.avgBlockTime.timestamp,
                this.dynamicCache.gasPriceCache.timestamp
            )
        };
    }
    
    /**
     * Обновить статистику калибровки
     */
    updateCalibrationStats(timingData) {
        this.calibrationStats.totalOpportunities++;
        
        // Здесь можно добавить логику для отслеживания точности предсказаний
        // когда будут доступны реальные результаты выполнения арбитража
    }
    
    /**
     * Получить статистику калибровки
     */
    getCalibrationStats() {
        const accuracy = this.calibrationStats.totalOpportunities > 0 ? 
            (this.calibrationStats.successfulPredictions / this.calibrationStats.totalOpportunities) * 100 : 0;
            
        return {
            ...this.calibrationStats,
            accuracy: accuracy.toFixed(1) + '%',
            avgTimeError: this.calibrationStats.timeErrors.length > 0 ?
                this.calibrationStats.timeErrors.reduce((a, b) => a + b, 0) / this.calibrationStats.timeErrors.length : 0
        };
    }
    
    /**
     * Сбросить статистику
     */
    resetCalibrationStats() {
        this.calibrationStats = {
            totalOpportunities: 0,
            successfulPredictions: 0,
            timeErrors: [],
            priceDecayErrors: []
        };
    }
    
    /**
     * Обновить параметры сети (для ручной настройки)
     */
    updateNetworkTiming(newTiming) {
        this.networkTiming = { ...this.networkTiming, ...newTiming };
        logger.logInfo('Network timing parameters updated', newTiming);
    }
    
    /**
     * Обновить параметры арбитража (для ручной настройки)
     */
    updateArbitrageParams(newParams) {
        this.arbitrageParams = { ...this.arbitrageParams, ...newParams };
        logger.logInfo('Arbitrage parameters updated', newParams);
    }
    
    /**
     * Получить текущие параметры
     */
    getCurrentParameters() {
        return {
            networkTiming: this.networkTiming,
            arbitrageParams: this.arbitrageParams,
            dynamicCache: this.dynamicCache,
            calibrationStats: this.getCalibrationStats()
        };
    }
}

module.exports = ArbitrageTimeCalculator;