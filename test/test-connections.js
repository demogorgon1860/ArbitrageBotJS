#!/usr/bin/env node

/**
 * Тестирование подключений для Polygon Arbitrage Bot
 * Запуск: npm run test
 */

require('dotenv').config();
const { ethers } = require('ethers');

class ConnectionTester {
    constructor() {
        this.results = {
            rpcProviders: [],
            telegramStatus: 'not_configured',
            configStatus: 'unknown',
            overallStatus: 'pending'
        };
    }
    
    async runAllTests() {
        console.log('🧪 Connection Test Suite');
        console.log('═'.repeat(50));
        
        try {
            await this.testRPCProviders();
            await this.testTelegramConnection();
            await this.testConfiguration();
            
            this.printSummary();
            
        } catch (error) {
            console.error('❌ Test suite failed:', error.message);
            process.exit(1);
        }
    }
    
    async testRPCProviders() {
        console.log('\n🌐 Testing RPC Providers...');
        
        const providers = this.collectRPCEndpoints();
        
        if (providers.length === 0) {
            console.log('❌ No RPC providers configured!');
            this.results.overallStatus = 'failed';
            return;
        }
        
        for (const [name, url] of providers) {
            await this.testSingleRPC(name, url);
        }
        
        const workingProviders = this.results.rpcProviders.filter(p => p.status === 'working');
        if (workingProviders.length === 0) {
            console.log('❌ No working RPC providers found!');
            this.results.overallStatus = 'failed';
        } else {
            console.log(`✅ Found ${workingProviders.length} working RPC provider(s)`);
        }
    }
    
    collectRPCEndpoints() {
        const providers = [];
        
        // Alchemy
        if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
            providers.push([
                'Alchemy',
                `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
            ]);
        }
        
        // Infura
        if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
            providers.push([
                'Infura',
                `https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`
            ]);
        }
        
        // Custom RPCs
        for (let i = 1; i <= 10; i++) {
            const rpc = process.env[`POLYGON_RPC_${i}`];
            if (rpc && rpc !== 'undefined' && rpc.startsWith('http')) {
                providers.push([`Custom RPC ${i}`, rpc]);
            }
        }
        
        // Public fallbacks
        const publicRPCs = [
            ['Public RPC 1', 'https://polygon-rpc.com'],
            ['Public RPC 2', 'https://rpc-mainnet.matic.network'],
            ['Public RPC 3', 'https://rpc.ankr.com/polygon']
        ];
        
        providers.push(...publicRPCs);
        
        return providers;
    }
    
    async testSingleRPC(name, url) {
        const startTime = Date.now();
        
        try {
            const provider = new ethers.JsonRpcProvider(url, 137, {
                staticNetwork: true,
                batchMaxCount: 1
            });
            
            // Тест 1: Получение номера блока
            const blockNumber = await Promise.race([
                provider.getBlockNumber(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout')), 5000)
                )
            ]);
            
            // Тест 2: Получение сети
            const network = await provider.getNetwork();
            
            // Тест 3: Получение баланса тестового адреса
            const balance = await provider.getBalance('0x0000000000000000000000000000000000000000');
            
            const responseTime = Date.now() - startTime;
            
            if (Number(network.chainId) !== 137) {
                throw new Error(`Wrong network: expected 137, got ${network.chainId}`);
            }
            
            console.log(`  ✅ ${name}: Block ${blockNumber} (${responseTime}ms)`);
            
            this.results.rpcProviders.push({
                name,
                url: this.maskUrl(url),
                status: 'working',
                blockNumber,
                responseTime,
                chainId: Number(network.chainId)
            });
            
        } catch (error) {
            const responseTime = Date.now() - startTime;
            console.log(`  ❌ ${name}: ${error.message} (${responseTime}ms)`);
            
            this.results.rpcProviders.push({
                name,
                url: this.maskUrl(url),
                status: 'failed',
                error: error.message,
                responseTime
            });
        }
    }
    
    async testTelegramConnection() {
        console.log('\n📱 Testing Telegram Connection...');
        
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        
        if (!botToken || !chatId || botToken === 'undefined' || chatId === 'undefined') {
            console.log('  ⚠️ Telegram not configured (optional)');
            this.results.telegramStatus = 'not_configured';
            return;
        }
        
        try {
            const TelegramBot = require('node-telegram-bot-api');
            const bot = new TelegramBot(botToken, { polling: false });
            
            // Тест getMe
            const botInfo = await Promise.race([
                bot.getMe(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout')), 5000)
                )
            ]);
            
            console.log(`  ✅ Bot connected: @${botInfo.username} (${botInfo.first_name})`);
            
            // Тест отправки сообщения
            try {
                await bot.sendMessage(chatId, '🧪 Test message from Polygon Arbitrage Bot setup');
                console.log(`  ✅ Test message sent to chat ${chatId}`);
                this.results.telegramStatus = 'working';
            } catch (sendError) {
                console.log(`  ⚠️ Bot connected but cannot send to chat ${chatId}: ${sendError.message}`);
                this.results.telegramStatus = 'send_failed';
            }
            
        } catch (error) {
            console.log(`  ❌ Telegram connection failed: ${error.message}`);
            this.results.telegramStatus = 'failed';
        }
    }
    
    async testConfiguration() {
        console.log('\n⚙️ Testing Configuration...');
        
        try {
            // Проверка config файла
            const config = require('../config/polygon.json');
            
            // Проверка основных секций
            const requiredSections = ['tokens', 'dexes', 'tradingPaths', 'settings'];
            for (const section of requiredSections) {
                if (!config[section]) {
                    throw new Error(`Missing configuration section: ${section}`);
                }
            }
            
            console.log('  ✅ Configuration file valid');
            
            // Проверка токенов
            const tokenCount = Object.keys(config.tokens).length;
            console.log(`  ✅ ${tokenCount} tokens configured`);
            
            // Проверка DEX
            const dexCount = Object.keys(config.dexes).length;
            console.log(`  ✅ ${dexCount} DEXes configured`);
            
            // Проверка торговых путей
            const pathCount = Object.keys(config.tradingPaths).length;
            console.log(`  ✅ ${pathCount} trading paths configured`);
            
            this.results.configStatus = 'valid';
            
        } catch (error) {
            console.log(`  ❌ Configuration error: ${error.message}`);
            this.results.configStatus = 'invalid';
        }
    }
    
    printSummary() {
        console.log('\n📊 Test Summary');
        console.log('═'.repeat(30));
        
        // RPC Providers
        const workingRPCs = this.results.rpcProviders.filter(p => p.status === 'working');
        const failedRPCs = this.results.rpcProviders.filter(p => p.status === 'failed');
        
        console.log(`🌐 RPC Providers: ${workingRPCs.length} working, ${failedRPCs.length} failed`);
        
        if (workingRPCs.length > 0) {
            const avgResponseTime = workingRPCs.reduce((sum, p) => sum + p.responseTime, 0) / workingRPCs.length;
            console.log(`   Average response time: ${avgResponseTime.toFixed(0)}ms`);
        }
        
        // Telegram
        const telegramEmoji = {
            'working': '✅',
            'not_configured': '⚠️',
            'send_failed': '⚠️',
            'failed': '❌'
        };
        console.log(`📱 Telegram: ${telegramEmoji[this.results.telegramStatus]} ${this.results.telegramStatus}`);
        
        // Configuration
        const configEmoji = this.results.configStatus === 'valid' ? '✅' : '❌';
        console.log(`⚙️ Configuration: ${configEmoji} ${this.results.configStatus}`);
        
        // Overall status
        const canRun = workingRPCs.length > 0 && this.results.configStatus === 'valid';
        
        console.log('\n' + '═'.repeat(30));
        
        if (canRun) {
            console.log('🎉 All critical tests passed! Bot is ready to run.');
            console.log('   Run: npm start');
            
            if (this.results.telegramStatus === 'not_configured') {
                console.log('\n💡 Tip: Configure Telegram for notifications');
            }
        } else {
            console.log('❌ Critical tests failed. Please fix the issues above.');
            
            if (workingRPCs.length === 0) {
                console.log('   - Configure at least one working RPC provider');
            }
            
            if (this.results.configStatus !== 'valid') {
                console.log('   - Fix configuration file issues');
            }
        }
    }
    
    maskUrl(url) {
        // Маскируем API ключи в URL
        return url.replace(/\/v2\/[a-zA-Z0-9_-]+/, '/v2/***API_KEY***')
                 .replace(/\/v3\/[a-zA-Z0-9_-]+/, '/v3/***API_KEY***');
    }
}

// Запуск тестов
if (require.main === module) {
    const tester = new ConnectionTester();
    tester.runAllTests().catch(console.error);
}

module.exports = ConnectionTester;