/**
 * Slippage Calculator - Dynamic slippage estimation
 */

const logger = require('./logger');
const { validateNumeric } = require('./utils');

class SlippageCalculator {
    constructor(provider) {
        this.provider = provider;
        
        // Base slippage rates
        this.baseSlippage = {
            v2: 0.003, // 0.3%
            v3: 0.001  // 0.1% (tighter spreads)
        };
        
        // Liquidity impact multipliers
        this.liquidityImpact = {
            veryLow: 5.0,    // < $1k liquidity
            low: 2.0,        // $1k - $10k
            medium: 1.0,     // $10k - $100k
            high: 0.5,       // $100k - $1M
            veryHigh: 0.3    // > $1M
        };
    }
    
    updateProvider(newProvider) {
        this.provider = newProvider;
    }
    
    async calculateTotalSlippage(tradeSize, buyLiquidity, sellLiquidity, buyPool, sellPool) {
        const buySlippage = this.calculateSingleSlippage(tradeSize, buyLiquidity, buyPool);
        const sellSlippage = this.calculateSingleSlippage(tradeSize, sellLiquidity, sellPool);
        
        // Total slippage cost
        const totalSlippagePercent = buySlippage + sellSlippage;
        const slippageCost = tradeSize * totalSlippagePercent;
        
        return slippageCost;
    }
    
    calculateSingleSlippage(tradeSize, liquidity, poolInfo) {
        // Base slippage
        const poolType = poolInfo?.type || 'v2';
        let slippage = this.baseSlippage[poolType] || this.baseSlippage.v2;
        
        // Liquidity impact
        const liquidityMultiplier = this.getLiquidityMultiplier(liquidity);
        slippage *= liquidityMultiplier;
        
        // Trade size impact
        const tradeSizeImpact = this.calculateTradeSizeImpact(tradeSize, liquidity);
        slippage += tradeSizeImpact;
        
        // Cap at reasonable maximum
        slippage = Math.min(slippage, 0.10); // Max 10%
        
        return slippage;
    }
    
    getLiquidityMultiplier(liquidity) {
        if (liquidity < 1000) return this.liquidityImpact.veryLow;
        if (liquidity < 10000) return this.liquidityImpact.low;
        if (liquidity < 100000) return this.liquidityImpact.medium;
        if (liquidity < 1000000) return this.liquidityImpact.high;
        return this.liquidityImpact.veryHigh;
    }
    
    calculateTradeSizeImpact(tradeSize, liquidity) {
        if (liquidity === 0) return 0.05; // 5% for zero liquidity
        
        const tradeRatio = tradeSize / liquidity;
        
        // Non-linear impact
        if (tradeRatio > 0.1) return 0.05;   // > 10% of liquidity
        if (tradeRatio > 0.05) return 0.02;  // > 5% of liquidity
        if (tradeRatio > 0.01) return 0.005; // > 1% of liquidity
        
        return 0.001; // Minimal impact
    }
}

module.exports = SlippageCalculator;