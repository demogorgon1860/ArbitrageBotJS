# 🚀 Production Deployment Guide

## ✅ Pre-Deployment Checklist

### 1. **Environment Setup**
```bash
# Clone and setup
git clone <repository>
cd polygon-arbitrage-bot
npm install

# Validate configuration
npm run validate
```

### 2. **Required Environment Variables**
Create `.env` file with:
```env
# Multiple RPC endpoints for failover
POLYGON_RPC_1=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYGON_RPC_2=https://polygon.infura.io/v3/YOUR_KEY
POLYGON_RPC_3=https://rpc.ankr.com/polygon

# API Keys for premium access
ALCHEMY_API_KEY=your_alchemy_key
INFURA_API_KEY=your_infura_key

# Telegram (REQUIRED)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Bot settings
MIN_BASIS_POINTS_PER_TRADE=50
CHECK_INTERVAL_MS=30000
INPUT_AMOUNT_USD=1000
```

### 3. **Pre-flight Tests**
```bash
# Validate all configuration
npm run validate

# Test connections and price fetching
npm run test

# Test with small run
npm start
```

## 🎯 Production Features

### ✅ **Real On-Chain Data Only**
- Uses `router.getAmountsOut()` directly from smart contracts
- No simulated or placeholder data
- Real liquidity and slippage calculations
- Accurate hop routing through intermediate tokens

### ✅ **Robust RPC Failover**
- Multiple RPC providers (Alchemy, Infura, public)
- Automatic failover on connection issues
- Connection health monitoring
- Rate limit protection

### ✅ **Production-Grade Error Handling**
- Comprehensive try/catch blocks
- Graceful degradation on errors
- Automatic recovery mechanisms
- Detailed error logging and notifications

### ✅ **Anti-Spam Notifications**
- Duplicate detection with configurable cooldown
- Only sends notifications for NEW opportunities
- Rich Telegram messages with all details
- Emergency error notifications

### ✅ **Comprehensive Logging**
- All opportunities logged to `logs/arbitrage_log.txt`
- Error tracking and debugging
- Performance metrics and statistics
- Automatic log rotation

## 📊 Running in Production

### Option 1: Direct Node.js
```bash
# Production start
NODE_ENV=production npm start

# With PM2 process manager
npm install -g pm2
pm2 start scripts/trade.js --name "arbitrage-bot"
pm2 save
pm2 startup
```

### Option 2: Docker
```bash
# Build and run
npm run docker:build
npm run docker:run

# View logs
npm run docker:logs
```

### Option 3: Hardhat Network
```bash
# Run through Hardhat (useful for debugging)
npm run hardhat
```

## 🔍 Monitoring and Maintenance

### Real-time Monitoring
- Telegram status updates every check cycle
- Error notifications for critical issues
- Statistics tracking (success rates, failovers, etc.)
- Health checks via log monitoring

### Log Files Location
```
logs/
├── arbitrage_log.txt    # All found opportunities
├── error_log.txt        # Errors and warnings  
└── debug_log.txt        # Detailed debug info
```

### Key Metrics to Monitor
- **Opportunities Found**: Should be > 0 regularly
- **RPC Failovers**: Should be minimal
- **Success Rate**: Price fetching success %
- **Error Count**: Should remain low

## ⚠️ Production Considerations

### 1. **Rate Limiting**
- Uses batched requests to avoid overwhelming RPCs
- Configurable delays between token checks
- Multiple RPC providers for load distribution

### 2. **Resource Usage**
- Memory efficient with cleanup routines
- CPU usage spikes during price checks (normal)
- Network usage depends on check frequency

### 3. **Costs**
- RPC API calls (if using premium providers)
- Server/VPS hosting costs
- No gas costs (read-only operations)

### 4. **Security**
- No private keys required or stored
- Read-only blockchain access
- Secure environment variable handling

## 🚨 Troubleshooting

### Common Issues

**"No working RPC providers found"**
```bash
# Check your .env file
cat .env | grep POLYGON_RPC

# Test RPC connectivity
npm run validate
```

**"Failed to get real price"**
- Check if DEX contracts are correct
- Verify token addresses in config
- Check RPC connection stability

**"Telegram notifications not working"**
- Verify bot token and chat ID
- Check bot has permission to send messages
- Test with: `npm run test`

### Debug Mode
```bash
# Enable detailed logging
NODE_ENV=development npm start

# Or check debug logs
tail -f logs/debug_log.txt
```

## 📈 Performance Optimization

### 1. **RPC Configuration**
- Use premium RPC providers (Alchemy/Infura)
- Configure multiple endpoints for failover
- Monitor RPC response times

### 2. **Check Frequency**
- Balance between opportunity detection and rate limits
- Recommended: 30-60 seconds between checks
- Adjust based on market volatility

### 3. **Token Selection**
- Focus on high-volume tokens for better arbitrage
- Remove low-liquidity tokens that rarely have opportunities
- Monitor which tokens provide most opportunities

## 🔧 Configuration Tuning

### Arbitrage Sensitivity
```json
{
  "settings": {
    "minBasisPointsPerTrade": 50,        // 0.5% minimum spread
    "checkIntervalMs": 30000,            // 30 seconds
    "inputAmountUSD": 1000,              // Sample size for quotes
    "notificationCooldownMs": 300000     // 5 min cooldown
  }
}
```

### Recommended Production Settings
- **Minimum spread**: 50-100 bps (0.5-1%)
- **Check interval**: 30-60 seconds
- **Notification cooldown**: 5-10 minutes
- **Sample amount**: $1000-5000

## 📋 Maintenance Schedule

### Daily
- Check bot status and uptime
- Review arbitrage opportunities found
- Monitor error logs for issues

### Weekly  
- Review RPC performance and failovers
- Update token price estimates if needed
- Check for new DEX or token additions

### Monthly
- Update dependencies (`npm update`)
- Review and optimize configuration
- Backup logs and configuration

## 🆘 Emergency Procedures

### Bot Crashes
1. Check logs for error details
2. Restart bot: `pm2 restart arbitrage-bot`
3. If persistent, check RPC connectivity
4. Update configuration if needed

### No Opportunities Found
1. Check if markets are active
2. Verify RPC connections working
3. Test price fetching manually
4. Consider lowering minimum spread temporarily

### High Error Rates
1. Check RPC provider status
2. Verify network connectivity
3. Review recent configuration changes
4. Consider switching primary RPC provider

---

## 🎉 Ready for Production!

Your Polygon Arbitrage Bot is now configured for production use with:
- ✅ Real on-chain price data
- ✅ Robust error handling and failover
- ✅ Comprehensive monitoring and logging
- ✅ Anti-spam notifications
- ✅ Production-grade architecture

**Start monitoring those arbitrage opportunities! 🚀**