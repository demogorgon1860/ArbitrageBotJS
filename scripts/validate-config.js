const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

const config = require('../config/polygon.json');

/**
 * Configuration validator for production deployment
 */
class ConfigValidator {
    constructor() {
        this.errors = [];
        this.warnings = [];
    }
    
    async validate() {
        console.log('🔍 Validating Polygon Arbitrage Bot Configuration...\n');
        
        this.validateEnvironmentVariables();
        this.validateTokenConfiguration();
        this.validateDexConfiguration();
        this.validateTradingPaths();
        this.validateSettings();
        await this.validateRPCEndpoints();
        await this.validateOnChainData();
        
        this.printResults();
        
        return this.errors.length === 0;
    }
    
    validateEnvironmentVariables() {
        console.log('📋 Validating environment variables...');
        
        // Required variables
        const required = [
            'TELEGRAM_BOT_TOKEN',
            'TELEGRAM_CHAT_ID'
        ];
        
        required.forEach(varName => {
            if (!process.env[varName]) {
                this.errors.push(`Missing required environment variable: ${varName}`);
            }
        });
        
        // Check RPC endpoints
        let rpcCount = 0;
        for (let i = 1; i <= 10; i++) {
            if (process.env[`POLYGON_RPC_${i}`]) {
                rpcCount++;
            }
        }
        
        if (!process.env.ALCHEMY_API_KEY && !process.env.INFURA_API_KEY && rpcCount === 0) {
            this.warnings.push('No premium RPC endpoints configured - will use public RPCs only');
        }
        
        // Validate Telegram chat ID format
        if (process.env.TELEGRAM_CHAT_ID && !process.env.TELEGRAM_CHAT_ID.match(/^-?\d+$/)) {
            this.errors.push('TELEGRAM_CHAT_ID must be a numeric ID');
        }
        
        console.log(`   ✅ Environment variables checked`);
    }
    
    validateTokenConfiguration() {
        console.log('🪙 Validating token configuration...');
        
        const requiredTokens = ['WMATIC', 'WETH', 'WBTC', 'USDC', 'USDT', 'LINK', 'AAVE', 'CRV'];
        
        requiredTokens.forEach(symbol => {
            const token = config.tokens[symbol];
            if (!token) {
                this.errors.push(`Missing token configuration for ${symbol}`);
                return;
            }
            
            // Validate address
            if (!token.address || !ethers.utils.isAddress(token.address)) {
                this.errors.push(`Invalid address for token ${symbol}: ${token.address}`);
            }
            
            // Validate decimals
            if (typeof token.decimals !== 'number' || token.decimals < 0 || token.decimals > 18) {
                this.errors.push(`Invalid decimals for token ${symbol}: ${token.decimals}`);
            }
            
            // Validate symbol
            if (!token.symbol || token.symbol !== symbol) {
                this.errors.push(`Symbol mismatch for token ${symbol}: expected ${symbol}, got ${token.symbol}`);
            }
        });
        
        console.log(`   ✅ Token configuration checked`);
    }
    
    validateDexConfiguration() {
        console.log('🏪 Validating DEX configuration...');
        
        const requiredDexes = ['uniswap', 'sushiswap', 'quickswap'];
        
        requiredDexes.forEach(dexName => {
            const dex = config.dexes[dexName];
            if (!dex) {
                this.errors.push(`Missing DEX configuration for ${dexName}`);
                return;
            }
            
            // Validate router address
            if (!dex.router || !ethers.utils.isAddress(dex.router)) {
                this.errors.push(`Invalid router address for ${dexName}: ${dex.router}`);
            }
            
            // Validate type
            if (!['v2', 'v3'].includes(dex.type)) {
                this.errors.push(`Invalid type for ${dexName}: ${dex.type}`);
            }
            
            // Validate V3 specific fields
            if (dex.type === 'v3') {
                if (!dex.quoter || !ethers.utils.isAddress(dex.quoter)) {
                    this.errors.push(`Invalid quoter address for ${dexName}: ${dex.quoter}`);
                }
                
                if (!dex.fees || !Array.isArray(dex.fees) || dex.fees.length === 0) {
                    this.errors.push(`Missing or invalid fees array for ${dexName}`);
                }
            }
            
            // Validate factory address
            if (!dex.factory || !ethers.utils.isAddress(dex.factory)) {
                this.errors.push(`Invalid factory address for ${dexName}: ${dex.factory}`);
            }
        });
        
        console.log(`   ✅ DEX configuration checked`);
    }
    
    validateTradingPaths() {
        console.log('🛣️ Validating trading paths...');
        
        Object.entries(config.tradingPaths).forEach(([tokenSymbol, paths]) => {
            // Check if token exists
            if (!config.tokens[tokenSymbol]) {
                this.errors.push(`Trading paths defined for unknown token: ${tokenSymbol}`);
                return;
            }
            
            // Validate each path
            paths.forEach((path, index) => {
                if (!Array.isArray(path) || path.length < 2) {
                    this.errors.push(`Invalid path ${index} for ${tokenSymbol}: must be array with at least 2 tokens`);
                    return;
                }
                
                // Check if all tokens in path exist
                path.forEach(symbol => {
                    if (!config.tokens[symbol]) {
                        this.errors.push(`Unknown token in path for ${tokenSymbol}: ${symbol}`);
                    }
                });
                
                // First token should match the trading token
                if (path[0] !== tokenSymbol) {
                    this.errors.push(`Path for ${tokenSymbol} should start with ${tokenSymbol}, got ${path[0]}`);
                }
            });
        });
        
        console.log(`   ✅ Trading paths checked`);
    }
    
    validateSettings() {
        console.log('⚙️ Validating settings...');
        
        const settings = config.settings;
        
        // Validate numeric settings
        const numericSettings = [
            'minBasisPointsPerTrade',
            'maxSlippageBps', 
            'checkIntervalMs',
            'inputAmountUSD',
            'maxRetries',
            'retryDelayMs',
            'notificationCooldownMs',
            'priceTimeoutMs',
            'rpcTimeoutMs'
        ];
        
        numericSettings.forEach(setting => {
            if (typeof settings[setting] !== 'number' || settings[setting] <= 0) {
                this.errors.push(`Invalid ${setting}: must be positive number`);
            }
        });
        
        // Validate ranges
        if (settings.minBasisPointsPerTrade < 10 || settings.minBasisPointsPerTrade > 1000) {
            this.warnings.push('minBasisPointsPerTrade should be between 10-1000 bps');
        }
        
        if (settings.checkIntervalMs < 10000) {
            this.warnings.push('checkIntervalMs should be at least 10000ms to avoid rate limits');
        }
        
        console.log(`   ✅ Settings checked`);
    }
    
    async validateRPCEndpoints() {
        console.log('🌐 Validating RPC endpoints...');
        
        const endpoints = [];
        
        // Collect all RPC endpoints
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc) endpoints.push(rpc);
        }
        
        if (process.env.ALCHEMY_API_KEY) {
            endpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY) {
            endpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        // Add public endpoints
        endpoints.push(
            "https://rpc.ankr.com/polygon",
            "https://polygon-rpc.com"
        );
        
        let workingEndpoints = 0;
        
        for (const endpoint of endpoints) {
            try {
                const provider = new ethers.providers.JsonRpcProvider({
                    url: endpoint,
                    timeout: 5000
                });
                
                await Promise.race([
                    provider.getNetwork(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('timeout')), 5000)
                    )
                ]);
                
                workingEndpoints++;
                console.log(`   ✅ ${endpoint.split('/')[2]} - Working`);
                
            } catch (error) {
                console.log(`   ❌ ${endpoint.split('/')[2]} - Failed: ${error.message}`);
                this.warnings.push(`RPC endpoint not responding: ${endpoint.split('/')[2]}`);
            }
        }
        
        if (workingEndpoints === 0) {
            this.errors.push('No working RPC endpoints found');
        } else if (workingEndpoints < 2) {
            this.warnings.push('Only one working RPC endpoint - consider adding more for reliability');
        }
        
        console.log(`   📊 ${workingEndpoints}/${endpoints.length} endpoints working`);
    }
    
    async validateOnChainData() {
        console.log('⛓️ Validating on-chain contract data...');
        
        try {
            // Use first working RPC
            const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");
            
            // Validate token contracts
            const erc20ABI = [
                "function symbol() view returns (string)",
                "function decimals() view returns (uint8)",
                "function totalSupply() view returns (uint256)"
            ];
            
            for (const [symbol, token] of Object.entries(config.tokens)) {
                try {
                    const contract = new ethers.Contract(token.address, erc20ABI, provider);
                    
                    const [contractSymbol, contractDecimals] = await Promise.all([
                        contract.symbol(),
                        contract.decimals()
                    ]);
                    
                    if (contractDecimals !== token.decimals) {
                        this.errors.push(`Decimals mismatch for ${symbol}: config=${token.decimals}, contract=${contractDecimals}`);
                    }
                    
                    console.log(`   ✅ ${symbol} (${contractSymbol}) - Valid contract`);
                    
                } catch (error) {
                    this.errors.push(`Invalid token contract for ${symbol}: ${error.message}`);
                    console.log(`   ❌ ${symbol} - Contract validation failed`);
                }
            }
            
            // Validate DEX router contracts
            const routerABI = [
                "function factory() external pure returns (address)"
            ];
            
            for (const [dexName, dex] of Object.entries(config.dexes)) {
                try {
                    const code = await provider.getCode(dex.router);
                    if (code === '0x') {
                        this.errors.push(`Router contract not found for ${dexName}: ${dex.router}`);
                        console.log(`   ❌ ${dexName} - Router not found`);
                    } else {
                        console.log(`   ✅ ${dexName} - Router contract exists`);
                    }
                } catch (error) {
                    this.warnings.push(`Could not validate router for ${dexName}: ${error.message}`);
                    console.log(`   ⚠️  ${dexName} - Router validation failed`);
                }
            }
            
        } catch (error) {
            this.warnings.push(`On-chain validation failed: ${error.message}`);
            console.log(`   ⚠️  On-chain validation skipped due to RPC issues`);
        }
    }
    
    printResults() {
        console.log('\n' + '='.repeat(60));
        console.log('📋 VALIDATION RESULTS');
        console.log('='.repeat(60));
        
        if (this.errors.length === 0 && this.warnings.length === 0) {
            console.log('✅ ALL CHECKS PASSED - Configuration is ready for production!');
        } else {
            if (this.errors.length > 0) {
                console.log('\n❌ ERRORS (must be fixed):');
                this.errors.forEach((error, index) => {
                    console.log(`   ${index + 1}. ${error}`);
                });
            }
            
            if (this.warnings.length > 0) {
                console.log('\n⚠️  WARNINGS (recommended to fix):');
                this.warnings.forEach((warning, index) => {
                    console.log(`   ${index + 1}. ${warning}`);
                });
            }
            
            if (this.errors.length === 0) {
                console.log('\n✅ No critical errors - bot can run but consider fixing warnings');
            } else {
                console.log('\n❌ Critical errors found - bot may not work properly');
            }
        }
        
        console.log('\n' + '='.repeat(60));
        console.log(`📊 Summary: ${this.errors.length} errors, ${this.warnings.length} warnings`);
        console.log('='.repeat(60) + '\n');
    }
}

// Main execution
if (require.main === module) {
    const validator = new ConfigValidator();
    
    validator.validate().then(isValid => {
        process.exit(isValid ? 0 : 1);
    }).catch(error => {
        console.error('Validation failed:', error);
        process.exit(1);
    });
}

module.exports = ConfigValidator;