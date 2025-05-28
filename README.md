# 🚀 Polygon Arbitrage Bot - Production Ready

**Полностью рабочий арбитражный бот для сети Polygon** с реальными on-chain данными, готовый к production использованию.

## ✅ **Проект полностью готов к использованию!**

- ✅ **Только реальные цены** с DEX через `getAmountsOut()`
- ✅ **Без симуляций** - только on-chain данные  
- ✅ **Production-grade архитектура** с error handling
- ✅ **RPC failover система** с множественными провайдерами
- ✅ **Anti-spam Telegram уведомления**
- ✅ **Comprehensive логирование**
- ✅ **Smart contract для утилит**

## 📁 Структура проекта

```
polygon-arbitrage-bot/
├── contracts/
│   └── Arb.sol                    # Utility контракт (опционально)
├── scripts/
│   ├── trade.js                   # 🎯 ОСНОВНОЙ БОТ
│   ├── priceFetcher.js           # Получение реальных цен
│   ├── timeCalculator.js         # Расчет времени арбитража  
│   ├── telegram.js               # Telegram уведомления
│   ├── logger.js                 # Система логирования
│   ├── utils.js                  # Утилиты
│   ├── test.js                   # Тестирование системы
│   ├── validate-config.js        # Валидация конфигурации
│   ├── deploy.js                 # Деплой контракта
│   └── contract-interaction.js   # Взаимодействие с контрактом
├── config/
│   └── polygon.json              # Конфигурация токенов и DEX
├── logs/                         # Логи работы бота
├── cache/                        # Кэш уведомлений
├── deployments/                  # Информация о деплоях
├── .env.example                  # Пример переменных окружения
├── hardhat.config.js            # Конфигурация Hardhat
├── package.json                 # Зависимости и скрипты
├── Dockerfile                   # Docker конфигурация
├── docker-compose.yml          # Docker Compose
├── PRODUCTION.md                # Гид по production деплою
└── README.md                    # Основная документация
```

## 🚀 Быстрый старт

### 1. **Установка**

```bash
# Клонирование и установка
git clone <repository-url>
cd polygon-arbitrage-bot
npm install

# Компиляция контрактов
npm run compile
```

### 2. **Настройка окружения**

Создайте `.env` файл:

```bash
cp .env.example .env
```

**Заполните обязательные переменные:**

```bash
# Множественные RPC для failover
POLYGON_RPC_1=https://polygon-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
POLYGON_RPC_2=https://polygon.infura.io/v3/YOUR_INFURA_KEY  
POLYGON_RPC_3=https://rpc.ankr.com/polygon

# API ключи для premium доступа
ALCHEMY_API_KEY=your_alchemy_key
INFURA_API_KEY=your_infura_key

# Telegram бот (ОБЯЗАТЕЛЬНО)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

# Настройки бота
MIN_BASIS_POINTS_PER_TRADE=50
CHECK_INTERVAL_MS=30000
INPUT_AMOUNT_USD=1000
```

### 3. **Валидация и тестирование**

```bash
# Полная валидация конфигурации
npm run validate

# Тестирование всех компонентов
npm run test
```

### 4. **Запуск бота**

```bash
# 🎯 ОСНОВНОЙ ЗАПУСК
npm start

# Или через Hardhat сеть
npm run hardhat
```

## 🎯 Как работает бот

### **Получение реальных цен**

Бот использует **ТОЛЬКО реальные on-chain данные**:

```javascript
// V2 DEX (SushiSwap, QuickSwap)
const amounts = await router.getAmountsOut(inputAmount, [tokenA, tokenB, tokenC]);

// V3 DEX (Uniswap)  
const amountOut = await quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
```

### **Поиск арбитража**

1. ✅ Получает реальные цены со всех DEX
2. ✅ Сравнивает цены по всем торговым путям
3. ✅ Рассчитывает spread в basis points
4. ✅ Учитывает время выполнения и slippage
5. ✅ Фильтрует только жизнеспособные возможности

### **Умные уведомления**

- 📱 Отправляет в Telegram только **новые** возможности
- 🔄 Cooldown система против спама
- 📊 Детальная информация: цены, пути, прибыль, время
- 🚨 Уведомления об ошибках и статусе

## 🏪 Поддерживаемые DEX

| DEX | Тип | Router | Статус |
|-----|-----|---------|--------|
| **Uniswap V3** | V3 | `0xE59...564` | ✅ Активен |
| **SushiSwap** | V2 | `0x1b0...506` | ✅ Активен |  
| **QuickSwap** | V2 | `0xa5E...ff` | ✅ Активен |

## 🪙 Отслеживаемые токены

| Token | Address | Decimals | Paths |
|-------|---------|----------|--------|
| **WETH** | `0x7ce...619` | 18 | 4 paths |
| **WBTC** | `0x1BF...FD6` | 8 | 4 paths |
| **USDC** | `0x279...174` | 6 | 4 paths |
| **USDT** | `0xc21...8eF` | 6 | 3 paths |
| **LINK** | `0x53E...d39` | 18 | 5 paths |
| **AAVE** | `0xD6D...90B` | 18 | 5 paths |
| **CRV** | `0x172...0AF` | 18 | 5 paths |

## 📊 Пример уведомления

```
🚀 Arbitrage Opportunity Found! ⚡

💰 Token: LINK
📈 Spread: 127 bps (1.27%)

🏪 Buy: SushiSwap
💵 Price: $14.235

🏦 Sell: Uniswap V3  
💵 Price: $14.416

💸 Input Amount: $1000
🎯 Theoretical Profit: $12.70
💎 Adjusted Profit: $8.45

⚡ Risk Level: 🟠 Medium-High
🎲 Success Probability: 78.3%
⏱️ Execution Time: 8.4s
⏰ Window Remaining: 15.2s

🛣️ Path: LINK → WETH → USDC

⏰ Discovered: 28.05.2025, 10:30:16
```

## 🔧 Smart Contract (опционально)

### Деплой контракта

```bash
# Деплой на Polygon
npm run deploy

# Взаимодействие с контрактом
npm run interact

# Проверка информации
npm run contract:info
```

### Функции контракта

- ✅ `getBalance()` - проверка балансов токенов
- ✅ `getMultipleBalances()` - пакетная проверка
- ✅ `getTokenInfo()` - детальная информация о токенах
- ✅ `isValidToken()` - валидация токенов
- ✅ `emergencyWithdraw()` - экстренный вывод средств

## 📈 Production деплой

Подробный гид в [PRODUCTION.md](PRODUCTION.md)

### Docker запуск

```bash
# Сборка и запуск
npm run docker:build
npm run docker:run

# Просмотр логов
npm run docker:logs
```

### PM2 Process Manager

```bash
# Установка PM2
npm install -g pm2

# Запуск бота
pm2 start scripts/trade.js --name "arbitrage-bot"
pm2 save
pm2 startup
```

## 📊 Мониторинг

### Логи

- `logs/arbitrage_log.txt` - все найденные возможности
- `logs/error_log.txt` - ошибки и предупреждения
- `logs/debug_log.txt` - отладочная информация

### Просмотр лог