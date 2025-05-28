const logger = require('./logger');

class ArbitrageTimeCalculator {
    constructor() {
        // Polygon network timing constants
        this.networkTiming = {
            avgBlockTime: 2100,        // ~2.1 секунды на блок
            confirmationBlocks: 2,     // блоков для подтверждения
            gasEstimationTime: 500,    // время на расчет газа
            mempoolDelay: 300,         // средняя задержка в mempool
            rpcLatency: 200,           // задержка RPC вызовов
            dexProcessingTime: 1000    // время обработки на DEX
        };
        
        // Арбитражные параметры
        this.arbitrageParams = {
            minExecutionWindow: 10000,  // мин. окно в мс
            maxExecutionWindow: 60000,  // макс. окно в мс
            priceDecayRate: 0.05,      // падение спреда % за секунду
            slippageFactor: 0.003,     // дополнительный slippage
            confidenceThreshold: 0.6   // мин. вероятность успеха
        };
    }
    
    /**
     * Рассчитать временные параметры арбитража
     */
    calculateArbitrageTimings(opportunity) {
        try {
            const discoveryTime = Date.now();
            
            // 1. Время выполнения транзакций
            const executionTime = this.calculateExecutionTime();
            
            // 2. Окно жизнеспособности
            const viabilityWindow = this.calculateViabilityWindow(opportunity);
            
            // 3. Временной распад цены
            const priceDecay = this.calculatePriceDecay(opportunity, executionTime);
            
            // 4. Скорректированная прибыль
            const adjustedProfit = this.calculateAdjustedProfit(opportunity, priceDecay);
            
            // 5. Вероятность успеха
            const confidence = this.calculateConfidence(opportunity, executionTime, viabilityWindow);
            
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
                isViable: confidence >= this.arbitrageParams.confidenceThreshold,
                recommendation: this.getRecommendation(confidence, adjustedProfit, executionTime)
            };
            
            logger.logDebug('Arbitrage timing calculated', timingData);
            
            return timingData;
            
        } catch (error) {
            logger.logError('Failed to calculate arbitrage timings', error);
            return null;
        }
    }
    
    /**
     * Рассчитать время выполнения арбитража
     */
    calculateExecutionTime() {
        const {
            avgBlockTime,
            confirmationBlocks,
            gasEstimationTime,
            mempoolDelay,
            rpcLatency,
            dexProcessingTime
        } = this.networkTiming;
        
        // Время на 2 транзакции (покупка + продажа)
        const transactionTime = (avgBlockTime * confirmationBlocks) * 2;
        
        // Общее время
        const totalTime = 
            gasEstimationTime * 2 +     // расчет газа для 2 тx
            mempoolDelay * 2 +          // ожидание в mempool
            transactionTime +           // выполнение транзакций
            rpcLatency * 4 +            // RPC вызовы
            dexProcessingTime * 2;      // обработка на DEX
        
        return totalTime;
    }
    
    /**
     * Рассчитать окно жизнеспособности
     */
    calculateViabilityWindow(opportunity) {
        const { basisPoints } = opportunity;
        
        // Чем больше спред, тем дольше окно
        let baseWindow = this.arbitrageParams.minExecutionWindow;
        
        if (basisPoints > 200) {
            baseWindow = 30000; // 30 секунд для больших спредов
        } else if (basisPoints > 100) {
            baseWindow = 20000; // 20 секунд для средних
        } else {
            baseWindow = 10000; // 10 секунд для малых
        }
        
        // Учесть волатильность токена
        const volatilityMultiplier = this.getVolatilityMultiplier(opportunity.token);
        
        return Math.min(
            baseWindow * volatilityMultiplier,
            this.arbitrageParams.maxExecutionWindow
        );
    }
    
    /**
     * Рассчитать распад цены во времени
     */
    calculatePriceDecay(opportunity, executionTimeMs) {
        const { basisPoints } = opportunity;
        const executionTimeSeconds = executionTimeMs / 1000;
        
        // Модель экспоненциального распада
        const decayRate = this.arbitrageParams.priceDecayRate;
        
        // Распад спреда: spread * e^(-rate * time)
        const remainingSpread = basisPoints * Math.exp(-decayRate * executionTimeSeconds);
        const decayedBasisPoints = basisPoints - remainingSpread;
        
        return {
            originalSpread: basisPoints,
            remainingSpread: Math.round(remainingSpread),
            decayedSpread: Math.round(decayedBasisPoints),
            decayPercentage: (decayedBasisPoints / basisPoints) * 100
        };
    }
    
    /**
     * Рассчитать скорректированную прибыль
     */
    calculateAdjustedProfit(opportunity, priceDecay) {
        const { potentialProfit, inputAmount } = opportunity;
        
        // Корректировка на временной распад
        const spreadAdjustment = (priceDecay.remainingSpread / priceDecay.originalSpread);
        
        // Дополнительные costs
        const slippageCost = inputAmount * this.arbitrageParams.slippageFactor;
        const gasCost = this.estimateGasCosts();
        
        const adjustedProfit = (potentialProfit * spreadAdjustment) - slippageCost - gasCost;
        
        return {
            originalProfit: potentialProfit,
            adjustedProfit: Math.max(0, adjustedProfit),
            slippageCost,
            gasCost,
            totalCosts: slippageCost + gasCost,
            profitReduction: potentialProfit - adjustedProfit,
            profitMargin: (adjustedProfit / inputAmount) * 100
        };
    }
    
    /**
     * Рассчитать вероятность успеха
     */
    calculateConfidence(opportunity, executionTime, viabilityWindow) {
        let confidence = 1.0;
        
        // Снижение по времени выполнения
        const timeRatio = executionTime / viabilityWindow;
        confidence *= (1 - timeRatio * 0.3); // макс. -30% за время
        
        // Снижение по размеру спреда
        const { basisPoints } = opportunity;
        if (basisPoints < 100) {
            confidence *= 0.7; // низкая для малых спредов
        } else if (basisPoints < 200) {
            confidence *= 0.85; // средняя
        }
        
        // Снижение по волатильности токена
        const volatilityPenalty = this.getVolatilityPenalty(opportunity.token);
        confidence *= (1 - volatilityPenalty);
        
        // Снижение по ликвидности DEX
        const liquidityFactor = this.getLiquidityFactor(opportunity);
        confidence *= liquidityFactor;
        
        return Math.max(0, Math.min(1, confidence));
    }
    
    /**
     * Получить множитель волатильности для токена
     */
    getVolatilityMultiplier(tokenSymbol) {
        const volatilityMap = {
    /**
     * Получить множитель волатильности для токена
     */
    getVolatilityMultiplier(tokenSymbol) {
        const volatilityMap = {
            'USDC': 1.2,  // стейблкоины - дольше окно
            'USDT': 1.2,
            'WETH': 0.8,  // волатильные - короче окно
            'WBTC': 0.8,
            'LINK': 0.7,
            'AAVE': 0.6,
            'CRV': 0.5,
            'WMATIC': 0.9
        };
        
        return volatilityMap[tokenSymbol] || 0.8;
    }
    
    /**
     * Получить штраф за волатильность
     */
    getVolatilityPenalty(tokenSymbol) {
        const penaltyMap = {
            'USDC': 0.05,  // низкий риск
            'USDT': 0.05,
            'WETH': 0.15,  // средний риск
            'WBTC': 0.15,
            'WMATIC': 0.10,
            'LINK': 0.20,  // высокий риск
            'AAVE': 0.25,
            'CRV': 0.30
        };
        
        return penaltyMap[tokenSymbol] || 0.20;
    }
    
    /**
     * Получить фактор ликвидности
     */
    getLiquidityFactor(opportunity) {
        // Упрощенная оценка ликвидности по DEX
        const liquidityScores = {
            'uniswap': 0.95,    // высокая ликвидность
            'sushiswap': 0.85,  // средняя ликвидность
            'quickswap': 0.80   // ниже средней
        };
        
        const buyScore = liquidityScores[opportunity.buyDex] || 0.7;
        const sellScore = liquidityScores[opportunity.sellDex] || 0.7;
        
        return Math.min(buyScore, sellScore);
    }
    
    /**
     * Оценить затраты на газ
     */
    estimateGasCosts() {
        // Упрощенная оценка для Polygon
        const gasPrice = 30; // Gwei
        const gasLimit = 300000; // для арбитража
        const maticPrice = 1; // USD
        
        const gasCostMatic = (gasPrice * gasLimit) / 1e9;
        const gasCostUSD = gasCostMatic * maticPrice;
        
        return gasCostUSD;
    }
    
    /**
     * Получить рекомендацию
     */
    getRecommendation(confidence, adjustedProfit, executionTime) {
        if (confidence < 0.3) {
            return {
                action: 'SKIP',
                reason: 'Low confidence',
                urgency: 'none'
            };
        }
        
        if (adjustedProfit.adjustedProfit < 5) {
            return {
                action: 'SKIP',
                reason: 'Low adjusted profit',
                urgency: 'none'
            };
        }
        
        if (confidence > 0.8 && adjustedProfit.adjustedProfit > 20) {
            return {
                action: 'EXECUTE_FAST',
                reason: 'High confidence, high profit',
                urgency: 'high'
            };
        }
        
        if (executionTime > 15000) {
            return {
                action: 'MONITOR',
                reason: 'Slow execution expected',
                urgency: 'low'
            };
        }
        
        return {
            action: 'EXECUTE',
            reason: 'Good opportunity',
            urgency: 'medium'
        };
    }
    
    /**
     * Проверить, актуальна ли возможность
     */
    isOpportunityStillValid(timingData) {
        const now = Date.now();
        const timeElapsed = now - timingData.discoveryTime;
        
        return {
            isValid: now < timingData.deadline,
            timeElapsed,
            timeRemaining: Math.max(0, timingData.deadline - now),
            urgency: this.getUrgencyLevel(timingData.timeRemaining)
        };
    }
    
    /**
     * Получить уровень срочности
     */
    getUrgencyLevel(timeRemaining) {
        if (timeRemaining < 5000) return 'CRITICAL';
        if (timeRemaining < 10000) return 'HIGH';
        if (timeRemaining < 20000) return 'MEDIUM';
        return 'LOW';
    }
}

module.exports = ArbitrageTimeCalculator;