const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');

const NOTIFICATIONS_CACHE_FILE = path.join(__dirname, '../data/notifications.json');
const STATS_CACHE_FILE = path.join(__dirname, '../data/stats.json');

/**
 * Расчет basis points между двумя ценами
 * @param {number} sellPrice - Цена продажи
 * @param {number} buyPrice - Цена покупки
 * @returns {number} Basis points (1 basis point = 0.01%)
 */
function calculateBasisPoints(sellPrice, buyPrice) {
    if (!sellPrice || !buyPrice || sellPrice <= 0 || buyPrice <= 0) {
        return 0;
    }
    
    // Проверяем что sellPrice больше buyPrice
    if (sellPrice <= buyPrice) {
        return 0;
    }
    
    // Формула: ((sellPrice - buyPrice) / buyPrice) * 10000
    const spreadPercent = ((sellPrice - buyPrice) / buyPrice) * 100;
    const basisPoints = spreadPercent * 100;
    
    return Math.round(basisPoints * 100) / 100; // Округляем до 2 знаков
}

/**
 * Форматирование суммы токена с правильными decimals
 * @param {string|BigInt} amount - Сумма в wei
 * @param {number} decimals - Количество decimals токена
 * @param {number} precision - Точность отображения
 * @returns {string} Отформатированная сумма
 */
function formatTokenAmount(amount, decimals = 18, precision = 6) {
    try {
        if (!amount || amount === '0') return '0';
        
        const formatted = ethers.formatUnits(amount.toString(), decimals);
        const parsed = parseFloat(formatted);
        
        if (parsed === 0) return '0';
        
        // Динамическая точность в зависимости от размера числа
        if (parsed >= 1000) precision = 2;
        else if (parsed >= 1) precision = 4;
        else if (parsed >= 0.01) precision = 6;
        else precision = 8;
        
        return parsed.toFixed(precision);
    } catch (error) {
        console.error('Error formatting token amount:', error);
        return '0';
    }
}

/**
 * Повторные попытки с экспоненциальной задержкой
 * @param {Function} fn - Функция для выполнения
 * @param {number} maxRetries - Максимальное количество попыток
 * @param {number} baseDelay - Базовая задержка в мс
 * @param {number} maxDelay - Максимальная задержка в мс
 * @returns {Promise} Результат выполнения функции
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000, maxDelay = 10000) {
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            if (attempt === maxRetries) {
                break;
            }
            
            // Экспоненциальная задержка с jitter
            const delay = Math.min(
                baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
                maxDelay
            );
            
            console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
            await sleep(delay);
        }
    }
    
    throw lastError;
}

/**
 * Простая задержка
 * @param {number} ms - Миллисекунды задержки
 * @returns {Promise} Promise, который разрешается через заданное время
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Создание уникального ID для уведомления
 * @param {string} token - Символ токена
 * @param {string} buyDex - DEX для покупки
 * @param {string} sellDex - DEX для продажи
 * @param {number} basisPoints - Размер спреда в basis points
 * @returns {string} Уникальный ID
 */
function createNotificationId(token, buyDex, sellDex, basisPoints) {
    const roundedBasisPoints = Math.round(basisPoints / 10) * 10; // Округляем до 10 bps
    return `${token}_${buyDex}_${sellDex}_${roundedBasisPoints}`;
}

/**
 * Проверка дубликата уведомления
 * @param {string} notificationId - ID уведомления
 * @param {Map} recentNotifications - Карта недавних уведомлений
 * @param {number} cooldownMs - Время cooldown в мс
 * @returns {boolean} true если дубликат
 */
function isDuplicateNotification(notificationId, recentNotifications, cooldownMs = 300000) {
    const now = Date.now();
    const lastNotification = recentNotifications.get(notificationId);
    
    if (!lastNotification) {
        recentNotifications.set(notificationId, now);
        return false;
    }
    
    if (now - lastNotification < cooldownMs) {
        return true; // Дубликат
    }
    
    recentNotifications.set(notificationId, now);
    return false;
}

/**
 * Получение текущей метки времени в ISO формате
 * @returns {string} Текущее время в ISO формате
 */
function getCurrentTimestamp() {
    return new Date().toISOString();
}

/**
 * Безопасное деление с проверкой на ноль
 * @param {number} dividend - Делимое
 * @param {number} divisor - Делитель
 * @param {number} defaultValue - Значение по умолчанию
 * @returns {number} Результат деления или значение по умолчанию
 */
function safeDivide(dividend, divisor, defaultValue = 0) {
    if (!divisor || divisor === 0 || !isFinite(divisor)) {
        return defaultValue;
    }
    
    const result = dividend / divisor;
    return isFinite(result) ? result : defaultValue;
}

/**
 * Форматирование числа с тысячными разделителями
 * @param {number} num - Число для форматирования
 * @param {number} decimals - Количество знаков после запятой
 * @returns {string} Отформатированное число
 */
function formatNumber(num, decimals = 2) {
    if (!isFinite(num)) return '0';
    
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    }).format(num);
}

/**
 * Форматирование процентов
 * @param {number} value - Значение в процентах
 * @param {number} decimals - Количество знаков после запятой
 * @returns {string} Отформатированный процент
 */
function formatPercentage(value, decimals = 2) {
    if (!isFinite(value)) return '0.00%';
    return `${formatNumber(value, decimals)}%`;
}

/**
 * Форматирование валюты
 * @param {number} amount - Сумма
 * @param {string} currency - Валюта
 * @param {number} decimals - Количество знаков после запятой
 * @returns {string} Отформатированная сумма
 */
function formatCurrency(amount, currency = 'USD', decimals = 2) {
    if (!isFinite(amount)) return `$0.00`;
    
    const symbol = currency === 'USD' ? '$' : currency;
    return `${symbol}${formatNumber(Math.abs(amount), decimals)}`;
}

/**
 * Загрузка кэша уведомлений
 * @returns {Promise<Map>} Карта уведомлений
 */
async function loadNotificationsCache() {
    try {
        await fs.ensureDir(path.dirname(NOTIFICATIONS_CACHE_FILE));
        
        if (await fs.pathExists(NOTIFICATIONS_CACHE_FILE)) {
            const data = await fs.readJson(NOTIFICATIONS_CACHE_FILE);
            const notificationsMap = new Map();
            
            // Очищаем старые уведомления (старше 24 часов)
            const now = Date.now();
            const oneDayAgo = now - 24 * 60 * 60 * 1000;
            
            for (const [key, timestamp] of Object.entries(data)) {
                if (timestamp > oneDayAgo) {
                    notificationsMap.set(key, timestamp);
                }
            }
            
            return notificationsMap;
        }
    } catch (error) {
        console.warn('Failed to load notifications cache:', error.message);
    }
    
    return new Map();
}

/**
 * Сохранение кэша уведомлений
 * @param {Map} notificationsMap - Карта уведомлений
 * @returns {Promise<void>}
 */
async function saveNotificationsCache(notificationsMap) {
    try {
        await fs.ensureDir(path.dirname(NOTIFICATIONS_CACHE_FILE));
        
        // Очищаем старые записи перед сохранением
        const now = Date.now();
        const oneDayAgo = now - 24 * 60 * 60 * 1000;
        
        const cleanedData = {};
        for (const [key, timestamp] of notificationsMap.entries()) {
            if (timestamp > oneDayAgo) {
                cleanedData[key] = timestamp;
            }
        }
        
        await fs.writeJson(NOTIFICATIONS_CACHE_FILE, cleanedData, { spaces: 2 });
    } catch (error) {
        console.error('Failed to save notifications cache:', error.message);
    }
}

/**
 * Загрузка статистики
 * @returns {Promise<Object>} Объект статистики
 */
async function loadStats() {
    try {
        await fs.ensureDir(path.dirname(STATS_CACHE_FILE));
        
        if (await fs.pathExists(STATS_CACHE_FILE)) {
            return await fs.readJson(STATS_CACHE_FILE);
        }
    } catch (error) {
        console.warn('Failed to load stats:', error.message);
    }
    
    return {
        totalRuns: 0,
        totalOpportunities: 0,
        totalProfitFound: 0,
        bestOpportunity: null,
        lastRun: null
    };
}

/**
 * Сохранение статистики
 * @param {Object} stats - Объект статистики
 * @returns {Promise<void>}
 */
async function saveStats(stats) {
    try {
        await fs.ensureDir(path.dirname(STATS_CACHE_FILE));
        await fs.writeJson(STATS_CACHE_FILE, stats, { spaces: 2 });
    } catch (error) {
        console.error('Failed to save stats:', error.message);
    }
}

/**
 * Проверка валидности адреса Ethereum
 * @param {string} address - Адрес для проверки
 * @returns {boolean} true если адрес валидный
 */
function isValidAddress(address) {
    try {
        return ethers.isAddress(address);
    } catch {
        return false;
    }
}

/**
 * Проверка что число находится в допустимом диапазоне
 * @param {number} value - Значение
 * @param {number} min - Минимум
 * @param {number} max - Максимум
 * @returns {boolean} true если в диапазоне
 */
function isInRange(value, min, max) {
    return typeof value === 'number' && 
           isFinite(value) && 
           value >= min && 
           value <= max;
}

/**
 * Очистка и валидация цены
 * @param {any} price - Цена для валидации
 * @returns {number|null} Валидная цена или null
 */
function validatePrice(price) {
    const numPrice = typeof price === 'string' ? parseFloat(price) : price;
    
    if (!isFinite(numPrice) || numPrice <= 0 || numPrice > 1e12) {
        return null;
    }
    
    return numPrice;
}

/**
 * Создание throttled функции
 * @param {Function} func - Функция для throttling
 * @param {number} limit - Лимит времени в мс
 * @returns {Function} Throttled функция
 */
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Создание debounced функции
 * @param {Function} func - Функция для debouncing
 * @param {number} delay - Задержка в мс
 * @returns {Function} Debounced функция
 */
function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}

/**
 * Получение случайного элемента из массива
 * @param {Array} array - Массив
 * @returns {any} Случайный элемент
 */
function getRandomElement(array) {
    if (!Array.isArray(array) || array.length === 0) {
        return null;
    }
    return array[Math.floor(Math.random() * array.length)];
}

/**
 * Перемешивание массива (Fisher-Yates)
 * @param {Array} array - Массив для перемешивания
 * @returns {Array} Перемешанный массив
 */
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Ограничение числа в диапазоне
 * @param {number} value - Значение
 * @param {number} min - Минимум
 * @param {number} max - Максимум
 * @returns {number} Ограниченное значение
 */
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Получение времени выполнения функции
 * @param {Function} func - Функция для измерения
 * @returns {Function} Обертка с измерением времени
 */
function measureExecutionTime(func) {
    return async function(...args) {
        const start = Date.now();
        try {
            const result = await func.apply(this, args);
            const executionTime = Date.now() - start;
            console.log(`Execution time: ${executionTime}ms`);
            return result;
        } catch (error) {
            const executionTime = Date.now() - start;
            console.log(`Execution time (with error): ${executionTime}ms`);
            throw error;
        }
    };
}

/**
 * Проверка доступности сети
 * @param {string} url - URL для проверки
 * @param {number} timeout - Timeout в мс
 * @returns {Promise<boolean>} true если доступна
 */
async function checkNetworkAvailability(url, timeout = 5000) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        const response = await fetch(url, {
            method: 'HEAD',
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Создание promise с timeout
 * @param {Promise} promise - Promise для обертки
 * @param {number} timeoutMs - Timeout в мс
 * @param {string} errorMessage - Сообщение об ошибке
 * @returns {Promise} Promise с timeout
 */
function withTimeout(promise, timeoutMs, errorMessage = 'Operation timed out') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
        )
    ]);
}

/**
 * Безопасное JSON.parse
 * @param {string} jsonString - JSON строка
 * @param {any} defaultValue - Значение по умолчанию
 * @returns {any} Распарсенный объект или значение по умолчанию
 */
function safeJsonParse(jsonString, defaultValue = null) {
    try {
        return JSON.parse(jsonString);
    } catch {
        return defaultValue;
    }
}

/**
 * Глубокое клонирование объекта
 * @param {any} obj - Объект для клонирования
 * @returns {any} Клонированный объект
 */
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof Array) return obj.map(item => deepClone(item));
    if (typeof obj === 'object') {
        const cloned = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                cloned[key] = deepClone(obj[key]);
            }
        }
        return cloned;
    }
    return obj;
}

module.exports = {
    // Основные функции
    calculateBasisPoints,
    formatTokenAmount,
    retryWithBackoff,
    sleep,
    
    // Уведомления
    createNotificationId,
    isDuplicateNotification,
    loadNotificationsCache,
    saveNotificationsCache,
    
    // Статистика
    loadStats,
    saveStats,
    
    // Форматирование
    formatNumber,
    formatPercentage,
    formatCurrency,
    getCurrentTimestamp,
    
    // Валидация
    isValidAddress,
    isInRange,
    validatePrice,
    
    // Утилиты
    safeDivide,
    throttle,
    debounce,
    getRandomElement,
    shuffleArray,
    clamp,
    measureExecutionTime,
    checkNetworkAvailability,
    withTimeout,
    safeJsonParse,
    deepClone
};