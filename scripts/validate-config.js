const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

const config = require('../config/polygon.json');

class ConfigValidator {
    constructor() {
        this.errors = [];
        this.warnings = [];
        this.info = [];
    }
    
    async validate() {
        console.log('🔍 Validating Polygon Arbitrage Bot Configuration...');
        
        this.validateEnvironmentVariables();
        this.validateTokenConfiguration();
        this.validateDEXConfiguration();
        this.validateTradingPaths();
        this.validateSettings();
        await this.validateNetworkConnectivity();
        await this.validateTelegramConfiguration();
        this.validateDirectoryStructure();
        
        this.printResults();
        
        if (this.errors.length > 0) {
            console.log('\n❌ Configuration validation failed!');
            process.exit(1);
        } else {
            console.log('\n✅ Configuration validation passed!');
            console.log('🚀 Bot is ready to run: npm start');
            process.exit(0);
        }
    }
    
    validateEnvironmentVariables() {
        console.log('📋 Validating environment variables...');
        
        // Required variables
        const requiredVars = [
            'TELEGRAM_BOT_TOKEN',
            'TELEGRAM_CHAT_ID'
        ];
        
        // Optional but recommended variables
        const recommendedVars = [
            'ALCHEMY_API_KEY',
            'INFURA_API_KEY'
        ];
        
        // Check required variables
        requiredVars.forEach(varName => {
            if (!process.env[varName] || process.env[varName] === 'undefined') {
                this.errors.push(`Missing required environment variable: ${varName}`);
            } else {
                this.info.push(`✓ ${varName} is set`);
            }
        });
        
        // Check recommended variables
        let hasApiKeys = false;
        recommendedVars.forEach(varName => {
            if (process.env[varName] && process.env[varName] !== 'undefined') {
                this.info.push(`✓ ${varName} is set`);
                hasApiKeys = true;
            }
        });
        
        // Check RPC endpoints
        let rpcCount = 0;
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                rpcCount++;
            }
        }
        
        if (!hasApiKeys && rpcCount === 0) {
            this.errors.push('No RPC access configured - need either API keys or RPC URLs');
        } else {
            this.info.push(`✓ RPC access configured (${hasApiKeys ? 'API keys' : ''}${hasApiKeys && rpcCount > 0 ? ' + ' : ''}${rpcCount > 0 ? `${rpcCount} RPC URLs` : ''})`);
        }
        
        // Check bot configuration
        const configVars = [
            'MIN_BASIS_POINTS_PER_TRADE',
            'CHECK_INTERVAL_MS',
            'INPUT_AMOUNT_USD',
            'NOTIFICATION_COOLDOWN_MS'
        ];
        
        configVars.forEach(varName => {
            if (process.env[varName]) {
                const value = parseInt(process.env[varName]);
                if (isNaN(value) || value <= 0) {
                    this.warnings.push(`Invalid value for ${varName}: ${process.env[varName]}`);
                } else {
                    this.info.push(`✓ ${varName} = ${value}`);
                }
            }
        });
        
        console.log('   ✅ Environment variables checked');
    }
    
    validateTokenConfiguration() {
        console.log('🪙 Validating token configuration...');
        
        if (!config.tokens || Object.keys(config.tokens).length === 0) {
            this.errors.push('No tokens configured');
            return;
        }
        
        Object.entries(config.tokens).forEach(([symbol, token]) => {
            // Check required fields
            if (!token.address) {
                this.errors.push(`Token ${symbol}: missing address`);
            } else if (!ethers.isAddress(token.address)) {
                this.errors.push(`Token ${symbol}: invalid address ${token.address}`);
            } else {
                this.info.push(`✓ ${symbol}: valid address`);
            }
            
            if (typeof token.decimals !== 'number') {
                this.errors.push(`Token ${symbol}: missing or invalid decimals`);
            } else if (token.decimals < 0 || token.decimals > 18) {
                this.warnings.push(`Token ${symbol}: unusual decimals ${token.decimals}`);
            } else {
                this.info.push(`✓ ${symbol}: ${token.decimals} decimals`);
            }
            
            if (!token.symbol) {
                this.warnings.push(`Token ${symbol}: missing symbol field`);
            }
        });
        
        // Check for required tokens
        const requiredTokens = ['WMATIC', 'USDC', 'WETH'];
        requiredTokens.forEach(symbol => {
            if (!config.tokens[symbol]) {
                this.warnings.push(`Missing recommended token: ${symbol}`);
            }
        });
        
        console.log(`   ✅ ${Object.keys(config.tokens).length} tokens validated`);
    }
    
    validateDEXConfiguration() {
        console.log('🏪 Validating DEX configuration...');
        
        if (!config.dexes || Object.keys(config.dexes).length === 0) {
            this.errors.push('No DEXes configured');
            return;
        }
        
        Object.entries(config.dexes).forEach(([dexName, dex]) => {
            // Check required fields
            if (!dex.name) {
                this.warnings.push(`DEX ${dexName}: missing name field`);
            }
            
            if (!dex.router) {
                this.errors.push(`DEX ${dexName}: missing router address`);
            } else if (!ethers.isAddress(dex.router)) {
                this.errors.push(`DEX ${dexName}: invalid router address ${dex.router}`);
            } else {
                this.info.push(`✓ ${dexName}: valid router`);
            }
            
            if (!dex.type) {
                this.warnings.push(`DEX ${dexName}: missing type field`);
            } else if (!['v2', 'v3'].includes(dex.type)) {
                this.warnings.push(`DEX ${dexName}: unknown type ${dex.type}`);
            } else {
                this.info.push(`✓ ${dexName}: type ${dex.type}`);
            }
            
            // V3 specific checks
            if (dex.type === 'v3') {
                if (!dex.quoter) {
                    this.warnings.push(`DEX ${dexName}: V3 DEX missing quoter address`);
                } else if (!ethers.isAddress(dex.quoter)) {
                    this.errors.push(`DEX ${dexName}: invalid quoter address ${dex.quoter}`);
                }
                
                if (!dex.fees || !Array.isArray(dex.fees)) {
                    this.warnings.push(`DEX ${dexName}: V3 DEX missing fee tiers`);
                }
            }
        });
        
        // Check for required DEXes
        const requiredDEXes = ['uniswap', 'sushiswap'];
        requiredDEXes.forEach(dexName => {
            if (!config.dexes[dexName]) {
                this.warnings.push(`Missing recommended DEX: ${dexName}`);
            }
        });
        
        console.log(`   ✅ ${Object.keys(config.dexes).length} DEXes validated`);
    }
    
    validateTradingPaths() {
        console.log('🛤️ Validating trading paths...');
        
        if (!config.tradingPaths || Object.keys(config.tradingPaths).length === 0) {
            this.errors.push('No trading paths configured');
            return;
        }
        
        let totalPaths = 0;
        
        Object.entries(config.tradingPaths).forEach(([token, paths]) => {
            if (!Array.isArray(paths)) {
                this.errors.push(`Trading paths for ${token}: not an array`);
                return;
            }
            
            if (paths.length === 0) {
                this.warnings.push(`Trading paths for ${token}: no paths configured`);
                return;
            }
            
            paths.forEach((path, index) => {
                if (!Array.isArray(path)) {
                    this.errors.push(`Trading path ${token}[${index}]: not an array`);
                    return;
                }
                
                if (path.length < 2) {
                    this.errors.push(`Trading path ${token}[${index}]: too short (${path.length} tokens)`);
                    return;
                }
                
                if (path.length > 4) {
                    this.warnings.push(`Trading path ${token}[${index}]: very long (${path.length} tokens) - may have high slippage`);
                }
                
                // Validate each token in path exists
                path.forEach((tokenSymbol, tokenIndex) => {
                    if (!config.tokens[tokenSymbol]) {
                        this.errors.push(`Trading path ${token}[${index}][${tokenIndex}]: unknown token ${tokenSymbol}`);
                    }
                });
                
                totalPaths++;
            });
            
            this.info.push(`✓ ${token}: ${paths.length} trading paths`);
        });
        
        console.log(`   ✅ ${totalPaths} trading paths validated`);
    }
    
    validateSettings() {
        console.log('⚙️ Validating settings...');
        
        if (!config.settings) {
            this.errors.push('Missing settings configuration');
            return;
        }
        
        const settings = config.settings;
        
        // Check numeric settings
        const numericSettings = [
            { name: 'inputAmountUSD', min: 100, max: 100000, recommended: 1000 },
            { name: 'minBasisPointsPerTrade', min: 10, max: 1000, recommended: 50 },
            { name: 'checkIntervalMs', min: 5000, max: 300000, recommended: 30000 },
            { name: 'notificationCooldownMs', min: 60000, max: 3600000, recommended: 300000 },
            { name: 'rpcTimeoutMs', min: 5000, max: 60000, recommended: 10000 },
            { name: 'priceTimeoutMs', min: 3000, max: 30000, recommended: 8000 },
            { name: 'maxRetries', min: 1, max: 10, recommended: 3 },
            { name: 'retryDelayMs', min: 500, max: 10000, recommended: 2000 }
        ];
        
        numericSettings.forEach(({ name, min, max, recommended }) => {
            const value = settings[name];
            
            if (typeof value !== 'number') {
                this.errors.push(`Setting ${name}: not a number (${typeof value})`);
            } else if (value < min || value > max) {
                this.errors.push(`Setting ${name}: out of range (${value}, expected ${min}-${max})`);
            } else if (value !== recommended) {
                this.info.push(`✓ ${name}: ${value} (recommended: ${recommended})`);
            } else {
                this.info.push(`✓ ${name}: ${value}`);
            }
        });
        
        console.log('   ✅ Settings validated');
    }
    
    async validateNetworkConnectivity() {
        console.log('🌐 Validating network connectivity...');
        
        const rpcEndpoints = [];
        
        // Collect RPC endpoints
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                rpcEndpoints.push(rpc);
            }
        }
        
        // Add API-based endpoints
        if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
            rpcEndpoints.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
        }
        
        if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
            rpcEndpoints.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
        }
        
        // Add public fallbacks
        rpcEndpoints.push(
            'https://rpc.ankr.com/polygon',
            'https://polygon-rpc.com'
        );
        
        let workingEndpoints = 0;
        const uniqueEndpoints = [...new Set(rpcEndpoints)];
        
        for (const endpoint of uniqueEndpoints.slice(0, 5)) { // Test max 5 endpoints
            try {
                const provider = new ethers.JsonRpcProvider(endpoint);
                
                const [network, blockNumber] = await Promise.race([
                    Promise.all([
                        provider.getNetwork(),
                        provider.getBlockNumber()
                    ]),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Timeout')), 8000)
                    )
                ]);
                
                if (Number(network.chainId) === 137) {
                    workingEndpoints++;
                    this.info.push(`✓ RPC working: ${endpoint.split('/')[2]} (block ${blockNumber})`);
                } else {
                    this.warnings.push(`RPC wrong network: ${endpoint} (chain ${network.chainId})`);
                }
                
            } catch (error) {
                this.warnings.push(`RPC failed: ${endpoint.split('/')[2]} (${error.message})`);
            }
        }
        
        if (workingEndpoints === 0) {
            this.errors.push('No working RPC endpoints found');
        } else if (workingEndpoints < 2) {
            this.warnings.push('Only one working RPC endpoint - consider adding more for reliability');
        } else {
            this.info.push(`✓ ${workingEndpoints} working RPC endpoints`);
        }
        
        console.log(`   ✅ Network connectivity checked (${workingEndpoints} working)`);
    }
    
    async validateTelegramConfiguration() {
        console.log('📱 Validating Telegram configuration...');
        
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        
        if (!botToken || botToken === 'undefined') {
            this.errors.push('TELEGRAM_BOT_TOKEN not set');
            return;
        }
        
        if (!chatId || chatId === 'undefined') {
            this.errors.push('TELEGRAM_CHAT_ID not set');
            return;
        }
        
        // Basic format validation
        if (!botToken.includes(':')) {
            this.errors.push('TELEGRAM_BOT_TOKEN: invalid format');
        }
        
        if (!/^-?\d+$/.test(chatId)) {
            this.warnings.push('TELEGRAM_CHAT_ID: unusual format (should be numeric)');
        }
        
        // Test Telegram connection
        try {
            const axios = require('axios');
            const response = await axios.get(
                `https://api.telegram.org/bot${botToken}/getMe`,
                { timeout: 10000 }
            );
            
            if (response.data.ok) {
                this.info.push(`✓ Telegram bot connected: @${response.data.result.username}`);
                
                // Test sending message
                try {
                    await axios.post(
                        `https://api.telegram.org/bot${botToken}/sendMessage`,
                        {
                            chat_id: chatId,
                            text: '🔧 Configuration validation test - Polygon Arbitrage Bot',
                            parse_mode: 'HTML'
                        },
                        { timeout: 10000 }
                    );
                    this.info.push('✓ Test message sent successfully');
                } catch (error) {
                    this.warnings.push(`Failed to send test message: ${error.response?.data?.description || error.message}`);
                }
            } else {
                this.errors.push('Invalid Telegram bot token');
            }
        } catch (error) {
            this.warnings.push(`Telegram connection failed: ${error.message}`);
        }
        
        console.log('   ✅ Telegram configuration checked');
    }
    
    validateDirectoryStructure() {
        console.log('📁 Validating directory structure...');
        
        const requiredDirs = [
            'scripts',
            'config',
            'contracts'
        ];
        
        const optionalDirs = [
            'logs',
            'cache',
            'artifacts'
        ];
        
        requiredDirs.forEach(dir => {
            if (fs.existsSync(dir)) {
                this.info.push(`✓ Directory exists: ${dir}/`);
            } else {
                this.errors.push(`Missing required directory: ${dir}/`);
            }
        });
        
        optionalDirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                try {
                    fs.ensureDirSync(dir);
                    this.info.push(`✓ Created directory: ${dir}/`);
                } catch (error) {
                    this.warnings.push(`Failed to create directory: ${dir}/`);
                }
            } else {
                this.info.push(`✓ Directory exists: ${dir}/`);
            }
        });
        
        // Check important files
        const requiredFiles = [
            'scripts/trade.js',
            'scripts/logger.js',
            'scripts/telegram.js',
            'scripts/utils.js',
            'config/polygon.json',
            'package.json'
        ];
        
        requiredFiles.forEach(file => {
            if (fs.existsSync(file)) {
                this.info.push(`✓ File exists: ${file}`);
            } else {
                this.errors.push(`Missing required file: ${file}`);
            }
        });
        
        console.log('   ✅ Directory structure validated');
    }
    
    printResults() {
        console.log('\n📊 Validation Results:');
        console.log('='.repeat(50));
        
        if (this.errors.length > 0) {
            console.log('\n❌ ERRORS:');
            this.errors.forEach(error => console.log(`   • ${error}`));
        }
        
        if (this.warnings.length > 0) {
            console.log('\n⚠️ WARNINGS:');
            this.warnings.forEach(warning => console.log(`   • ${warning}`));
        }
        
        if (this.info.length > 0) {
            console.log('\n✅ INFO:');
            this.info.forEach(info => console.log(`   ${info}`));
        }
        
        console.log('\n📈 SUMMARY:');
        console.log(`   Errors: ${this.errors.length}`);
        console.log(`   Warnings: ${this.warnings.length}`);
        console.log(`   Info: ${this.info.length}`);
    }
}

// Run validation if this file is executed directly
if (require.main === module) {
    const validator = new ConfigValidator();
    validator.validate().catch(error => {
        console.error('Validation failed:', error);
        process.exit(1);
    });
}

module.exports = ConfigValidator;