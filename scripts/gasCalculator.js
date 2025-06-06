/**
 * Gas Calculator - Real-time gas cost estimation
 */

const { ethers } = require('ethers');
const logger = require('./logger');
const { validateNumeric } = require('./utils');

class GasCalculator {
    constructor(provider) {
        this.provider = provider;
        this.gasPrice = null;
        this.lastUpdate = 0;
        this.updateInterval = 60000; // 1 minute
        
        // Gas estimates for different operations
        this.gasEstimates = {
            v2Swap: 150000,
            v3Swap: 200000,
            approve: 50000,
            wrapETH: 30000
        };
        
        // Token-specific gas multipliers
        this.tokenMultipliers = {
            'USDT': 1.5, // USDT uses more gas
            'WBTC': 1.2,
            'default': 1.0
        };
    }
    
    async initialize() {
        await this.updateGasPrice();
        logger.logInfo('GasCalculator initialized');
    }
    
    updateProvider(newProvider) {
        this.provider = newProvider;
    }
    
    async updateGasPrice() {
        try {
            const now = Date.now();
            if (now - this.lastUpdate < this.updateInterval && this.gasPrice) {
                return;
            }
            
            const feeData = await this.provider.getFeeData();
            
            if (feeData.gasPrice) {
                this.gasPrice = feeData.gasPrice;
                this.lastUpdate = now;
                
                const gasPriceGwei = parseFloat(ethers.formatUnits(this.gasPrice, 'gwei'));
                logger.logInfo(`Gas price updated: ${gasPriceGwei.toFixed(2)} Gwei`);
            }
            
        } catch (error) {
            logger.logError('Failed to update gas price', error);
            
            // Use fallback
            if (!this.gasPrice) {
                this.gasPrice = ethers.parseUnits('30', 'gwei');
            }
        }
    }
    
    async calculateTotalGasCost(tokenSymbol, buyDex, sellDex) {
        // Ensure gas price is current
        await this.updateGasPrice();
        
        // Calculate gas units
        const gasUnits = this.estimateGasUnits(tokenSymbol, buyDex, sellDex);
        
        // Calculate cost in MATIC
        const gasCostWei = this.gasPrice * BigInt(gasUnits);
        const gasCostMatic = parseFloat(ethers.formatEther(gasCostWei));
        
        // Convert to USD (assuming MATIC = $0.90)
        const maticPrice = 0.90; // In production, fetch from oracle
        const gasCostUSD = gasCostMatic * maticPrice;
        
        return gasCostUSD;
    }
    
    estimateGasUnits(tokenSymbol, buyDex, sellDex) {
        let totalGas = 0;
        
        // Buy side gas
        const buyDexType = this.getDexType(buyDex);
        totalGas += buyDexType === 'v3' ? this.gasEstimates.v3Swap : this.gasEstimates.v2Swap;
        
        // Sell side gas
        const sellDexType = this.getDexType(sellDex);
        totalGas += sellDexType === 'v3' ? this.gasEstimates.v3Swap : this.gasEstimates.v2Swap;
        
        // Token-specific multiplier
        const multiplier = this.tokenMultipliers[tokenSymbol] || this.tokenMultipliers.default;
        totalGas = Math.floor(totalGas * multiplier);
        
        // Add buffer for safety
        totalGas = Math.floor(totalGas * 1.1);
        
        return totalGas;
    }
    
    getDexType(dexName) {
        // Simple check - in production would use config
        return dexName.includes('v3') || dexName === 'uniswap' ? 'v3' : 'v2';
    }
    
    async cleanup() {
        // Nothing to cleanup
    }
}

module.exports = GasCalculator;