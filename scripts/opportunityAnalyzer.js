/**
 * Opportunity Analyzer - Filters and validates arbitrage opportunities
 */

const logger = require('./logger');

class OpportunityAnalyzer {
    constructor(minNetProfit = 0.20) {
        this.minNetProfit = minNetProfit;
        
        // Risk thresholds
        this.riskThresholds = {
            minLiquidity: 1000,      // Minimum $1k liquidity
            maxSlippage: 0.05,       // Maximum 5% slippage
            minROI: 0.02,            // Minimum 0.02% ROI
            maxGasRatio: 0.8         // Gas can't be > 80% of gross profit
        };
    }
    
    isOpportunityValid(opportunity) {
        const { analysis } = opportunity;
        
        // Check net profit
        if (analysis.netProfit < this.minNetProfit) {
            return false;
        }
        
        // Check liquidity
        if (opportunity.buyLiquidity < this.riskThresholds.minLiquidity ||
            opportunity.sellLiquidity < this.riskThresholds.minLiquidity) {
            return false;
        }
        
        // Check ROI
        if (analysis.roi < this.riskThresholds.minROI) {
            return false;
        }
        
        // Check gas ratio
        const gasRatio = analysis.gasCost / analysis.grossProfit;
        if (gasRatio > this.riskThresholds.maxGasRatio) {
            return false;
        }
        
        // Check slippage
        const slippageRatio = analysis.slippage / analysis.inputAmount;
        if (slippageRatio > this.riskThresholds.maxSlippage) {
            return false;
        }
        
        return true;
    }
    
    rankOpportunities(opportunities) {
        return opportunities
            .filter(opp => this.isOpportunityValid(opp))
            .sort((a, b) => {
                // Primary sort by net profit
                const profitDiff = b.analysis.netProfit - a.analysis.netProfit;
                if (Math.abs(profitDiff) > 0.01) return profitDiff;
                
                // Secondary sort by ROI
                return b.analysis.roi - a.analysis.roi;
            });
    }
    
    calculateRiskScore(opportunity) {
        const { analysis, buyLiquidity, sellLiquidity } = opportunity;
        
        let score = 100; // Start with perfect score
        
        // Liquidity risk
        const minLiquidity = Math.min(buyLiquidity, sellLiquidity);
        if (minLiquidity < 10000) score -= 20;
        else if (minLiquidity < 50000) score -= 10;
        
        // Slippage risk
        const slippagePercent = (analysis.slippage / analysis.inputAmount) * 100;
        if (slippagePercent > 3) score -= 20;
        else if (slippagePercent > 1) score -= 10;
        
        // Gas cost risk
        const gasPercent = (analysis.gasCost / analysis.grossProfit) * 100;
        if (gasPercent > 50) score -= 20;
        else if (gasPercent > 30) score -= 10;
        
        // ROI risk
        if (analysis.roi < 0.1) score -= 20;
        else if (analysis.roi < 0.5) score -= 10;
        
        return Math.max(0, score);
    }
}

module.exports = OpportunityAnalyzer;