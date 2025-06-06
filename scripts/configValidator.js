/**
 * Configuration Validator
 */

const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

class ConfigValidator {
    static async validateAll() {
        const errors = [];
        const warnings = [];
        
        // Validate environment variables
        this.validateEnvironment(errors, warnings);
        
        // Validate configuration file
        await this.validateConfig(errors, warnings);
        
        // Validate network connectivity
        await this.validateNetwork(errors, warnings);
        
        // Log results
        if (errors.length > 0) {
            errors.forEach(error => logger.logError(error));
        }
        
        if (warnings.length > 0) {
            warnings.forEach(warning => logger.logWarning(warning));
        }
        
        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }
    
    static validateEnvironment(errors, warnings) {
        // Check RPC endpoints
        const hasRPC = process.env.ALCHEMY_API_KEY || 
                      process.env.INFURA_API_KEY || 
                      process.env.POLYGON_RPC_1;
        
        if (!hasRPC) {
            errors.push('No RPC endpoints configured');
        }
        
        // Check Telegram (optional)
        if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
            warnings.push('Telegram not configured - notifications disabled');
        }
        
        // Check trading parameters
        const inputAmount = parseFloat(process.env.INPUT_AMOUNT_USD);
        if (!inputAmount || inputAmount < 10 || inputAmount > 100000) {
            warnings.push(`Invalid INPUT_AMOUNT_USD: ${inputAmount}`);
        }
        
        const minProfit = parseFloat(process.env.MIN_NET_PROFIT_USD);
        if (!minProfit || minProfit < 0.01 || minProfit > 100) {
            warnings.push(`Invalid MIN_NET_PROFIT_USD: ${minProfit}`);
        }
        
        const interval = parseInt(process.env.CHECK_INTERVAL_MS);
        if (!interval || interval < 5000 || interval > 300000) {
            warnings.push(`Invalid CHECK_INTERVAL_MS: ${interval}`);
        }
    }
    
    static async validateConfig(errors, warnings) {
        try {
            const configPath = path.join(__dirname, '../config/polygon.json');
            const config = await fs.readJson(configPath);
            
            // Validate tokens
            if (!config.tokens || Object.keys(config.tokens).length === 0) {
                errors.push('No tokens configured');
            } else {
                for (const [symbol, token] of Object.entries(config.tokens)) {
                    if (!ethers.isAddress(token.address)) {
                        errors.push(`Invalid address for ${symbol}: ${token.address}`);
                    }
                    
                    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 18) {
                        warnings.push(`Invalid decimals for ${symbol}: ${token.decimals}`);
                    }
                }
            }
            
            // Validate DEXes
            if (!config.dexes || Object.keys(config.dexes).length === 0) {
                errors.push('No DEXes configured');
            } else {
                for (const [name, dex] of Object.entries(config.dexes)) {
                    if (!dex.type || !['v2', 'v3'].includes(dex.type)) {
                        warnings.push(`Invalid DEX type for ${name}: ${dex.type}`);
                    }
                    
                    if (dex.type === 'v2' && !ethers.isAddress(dex.router)) {
                        errors.push(`Invalid router for ${name}`);
                    }
                    
                    if (dex.type === 'v3' && !ethers.isAddress(dex.factory)) {
                        errors.push(`Invalid factory for ${name}`);
                    }
                }
            }
            
        } catch (error) {
            errors.push(`Failed to load config: ${error.message}`);
        }
    }
    
    static async validateNetwork(errors, warnings) {
        // Network validation would be done during provider setup
        // This is a placeholder for additional network checks
    }
}

module.exports = ConfigValidator;