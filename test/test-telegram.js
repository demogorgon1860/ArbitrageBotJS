#!/usr/bin/env node

/**
 * Тестирование Telegram уведомлений
 * Запуск: node test/test-telegram.js
 */

require('dotenv').config();
const telegramNotifier = require('../scripts/telegram');

class TelegramTestSuite {
    constructor() {
        this.testResults = [];
    }
    
    async runTelegramTests() {
        console.log('📱 Telegram Notification Test Suite');
        console.log('═'.repeat(50));
        
        try {
            await this.testConfiguration();
            await this.testBasicMessage();
            await this.testArbitrageAlert();
            await this.testStartupNotification();
            await this.testErrorAlert();
            await this.testPeriodicReport();
            
            this.printSummary();
            
        } catch (error) {
            console.error('❌ Telegram test suite failed:', error.message);
            process.exit(1);
        }
    }
    
    async testConfiguration() {
        console.log('\n⚙️ Testing Telegram configuration...');
        
        const status = telegramNotifier.getStatus();
        
        if (status.configured) {
            console.log('  ✅ Telegram is configured');
            console.log(`  📊 Queue length: ${status.queueLength}`);
            
            this.testResults.push({
                test: 'configuration',
                status: 'passed',
                configured: true
            });
            
        } else {
            console.log('  ❌ Telegram is not configured');
            console.log('  💡 Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
            
            this.testResults.push({
                test: 'configuration',
                status: 'failed',
                configured: false
            });
            
            // Если не настроен, пропускаем остальные тесты
            console.log('\n⏭️ Skipping remaining tests - Telegram not configured');
            return;
        }
    }
    
    async testBasicMessage() {
        console.log('\n📝 Testing basic message sending...');
        
        try {
            const sent = await telegramNotifier.sendTestMessage();
            
            if (sent) {
                console.log('  ✅ Test message sent successfully');
                console.log('  📱 Check your Telegram chat for the test message');
                
                this.testResults.push({
                    test: 'basic_message',
                    status: 'passed'
                });
                
                // Ждем немного чтобы не спамить
                await this.sleep(2000);
                
            } else {
                console.log('  ❌ Failed to send test message');
                
                this.testResults.push({
                    test: 'basic_message',
                    status: 'failed'
                });
            }
            
        } catch (error) {
            console.log(`  ❌ Error sending test message: ${error.message}`);
            
            this.testResults.push({
                test: 'basic_message',
                status: 'error',
                error: error.message
            });
        }
    }
    
    async testArbitrageAlert() {
        console.log('\n💰 Testing arbitrage alert...');
        
        try {
            // Создаем тестовую возможность арбитража
            const testOpportunity = {
                token: 'WETH',
                buyDex: 'quickswap',
                sellDex: 'sushiswap',
                buyPrice: 2845.30,
                sellPrice: 2851.75,
                basisPoints: 226,
                percentage: 2.26,
                inputAmount: 1000,
                potentialProfit: 22.60,
                adjustedProfit: 15.45,
                confidence: 0.78,
                buyLiquidity: 45000,
                sellLiquidity: 38000,
                estimatedSlippage: {
                    buy: 0.3,
                    sell: 0.4
                },
                timing: {
                    executionTime: 8000,
                    recommendation: {
                        action: 'EXECUTE',
                        reason: 'Good opportunity with high confidence',
                        priority: 7
                    }
                },
                timestamp: new Date().toISOString()
            };
            
            const sent = await telegramNotifier.sendArbitrageAlert(testOpportunity);
            
            if (sent) {
                console.log('  ✅ Arbitrage alert sent successfully');
                console.log('  📱 Check your Telegram for the formatted arbitrage alert');
                
                this.testResults.push({
                    test: 'arbitrage_alert',
                    status: 'passed'
                });
                
                await this.sleep(3000);
                
            } else {
                console.log('  ❌ Failed to send arbitrage alert');
                
                this.testResults.push({
                    test: 'arbitrage_alert',
                    status: 'failed'
                });
            }
            
        } catch (error) {
            console.log(`  ❌ Error sending arbitrage alert: ${error.message}`);
            
            this.testResults.push({
                test: 'arbitrage_alert',
                status: 'error',
                error: error.message
            });
        }
    }
    
    async testStartupNotification() {
        console.log('\n🚀 Testing startup notification...');
        
        try {
            const sent = await telegramNotifier.sendStartupNotification();
            
            if (sent) {
                console.log('  ✅ Startup notification sent successfully');
                
                this.testResults.push({
                    test: 'startup_notification',
                    status: 'passed'
                });
                
                await this.sleep(2000);
                
            } else {
                console.log('  ❌ Failed to send startup notification');
                
                this.testResults.push({
                    test: 'startup_notification',
                    status: 'failed'
                });
            }
            
        } catch (error) {
            console.log(`  ❌ Error sending startup notification: ${error.message}`);
            
            this.testResults.push({
                test: 'startup_notification',
                status: 'error',
                error: error.message
            });
        }
    }
    
    async testErrorAlert() {
        console.log('\n🚨 Testing error alert...');
        
        try {
            const testError = new Error('Test error for Telegram notification');
            const sent = await telegramNotifier.sendErrorAlert(testError, 'Test context');
            
            if (sent) {
                console.log('  ✅ Error alert sent successfully');
                
                this.testResults.push({
                    test: 'error_alert',
                    status: 'passed'
                });
                
                await this.sleep(2000);
                
            } else {
                console.log('  ❌ Failed to send error alert');
                
                this.testResults.push({
                    test: 'error_alert',
                    status: 'failed'
                });
            }
            
        } catch (error) {
            console.log(`  ❌ Error sending error alert: ${error.message}`);
            
            this.testResults.push({
                test: 'error_alert',
                status: 'error',
                error: error.message
            });
        }
    }
    
    async testPeriodicReport() {
        console.log('\n📊 Testing periodic report...');
        
        try {
            // Создаем тестовую статистику
            const testStats = {
                uptime: '15 minutes',
                totalChecks: 45,
                opportunitiesFound: 8,
                profitableOpportunities: 3,
                totalPotentialProfit: 127.45,
                averageSpread: 85.3,
                successRate: '95.6%',
                activeProviders: 3,
                lastSuccessfulCheck: new Date().toISOString()
            };
            
            const sent = await telegramNotifier.sendPeriodicReport(testStats);
            
            if (sent) {
                console.log('  ✅ Periodic report sent successfully');
                
                this.testResults.push({
                    test: 'periodic_report',
                    status: 'passed'
                });
                
                await this.sleep(2000);
                
            } else {
                console.log('  ❌ Failed to send periodic report');
                
                this.testResults.push({
                    test: 'periodic_report',
                    status: 'failed'
                });
            }
            
        } catch (error) {
            console.log(`  ❌ Error sending periodic report: ${error.message}`);
            
            this.testResults.push({
                test: 'periodic_report',
                status: 'error',
                error: error.message
            });
        }
    }
    
    printSummary() {
        console.log('\n📊 Telegram Testing Summary');
        console.log('═'.repeat(30));
        
        const configured = this.testResults.find(r => r.test === 'configuration');
        
        if (!configured?.configured) {
            console.log('❌ Telegram not configured');
            console.log('\n💡 To enable Telegram notifications:');
            console.log('1. Create a bot with @BotFather on Telegram');
            console.log('2. Get your chat ID from @userinfobot');
            console.log('3. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env');
            console.log('4. Run this test again');
            return;
        }
        
        const passed = this.testResults.filter(r => r.status === 'passed').length;
        const failed = this.testResults.filter(r => r.status === 'failed').length;
        const errors = this.testResults.filter(r => r.status === 'error').length;
        
        console.log(`✅ Passed: ${passed}`);
        console.log(`❌ Failed: ${failed}`);
        console.log(`⚠️ Errors: ${errors}`);
        
        // Статус очереди сообщений
        const messageStats = telegramNotifier.getMessageStats();
        console.log(`📱 Queue length: ${messageStats.queueLength}`);
        console.log(`🔄 Processing: ${messageStats.isProcessing ? 'Yes' : 'No'}`);
        
        console.log('\n' + '═'.repeat(30));
        
        if (failed === 0 && errors === 0) {
            console.log('🎉 All Telegram tests passed!');
            console.log('📱 Notifications will work correctly when bot runs');
        } else if (passed > 0) {
            console.log('⚠️ Some tests failed, but basic functionality works');
        } else {
            console.log('❌ All tests failed. Check your Telegram configuration');
        }
        
        console.log('\n💡 What was tested:');
        console.log('✓ Bot configuration');
        console.log('✓ Basic message sending');
        console.log('✓ Arbitrage alert formatting');
        console.log('✓ Startup notifications');
        console.log('✓ Error alerts');
        console.log('✓ Periodic reports');
        
        if (passed > 0) {
            console.log('\n📱 Check your Telegram chat to see the test messages!');
        }
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Запуск тестов
if (require.main === module) {
    const tester = new TelegramTestSuite();
    tester.runTelegramTests().catch(console.error);
}

module.exports = TelegramTestSuite;