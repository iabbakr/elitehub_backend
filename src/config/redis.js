const { createClient } = require('redis');

/**
 * PRODUCTION-GRADE REDIS CONFIGURATION
 * Handles caching layer to reduce Firebase costs
 */
const client = createClient({
    url: process.env.REDIS_URL,
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 10) {
                console.error('❌ Redis: Max retries reached');
                return new Error('Redis reconnection failed');
            }
            return Math.min(retries * 100, 3000);
        },
        connectTimeout: 10000,
        keepAlive: 30000
    },
    // Enable command timeout
    commandTimeout: 5000,
    // Connection pool settings
    isolationPoolOptions: {
        min: 2,
        max: 10
    }
});

// Event Handlers
client.on('connect', () => console.log('🔄 Redis: Connecting...'));
client.on('ready', () => console.log('🚀 Redis: Ready!'));
client.on('error', (err) => console.error('❌ Redis Error:', err.message));
client.on('end', () => console.log('🔌 Redis: Connection closed'));
client.on('reconnecting', () => console.log('🔄 Redis: Reconnecting...'));

/**
 * Initialize Redis connection
 */
const connectRedis = async () => {
    try {
        if (!client.isOpen) {
            await client.connect();
        }
    } catch (err) {
        console.error('❌ Redis: Connection failed:', err);
        // Don't crash the app, just log the error
        // The app can still function without Redis (slower)
    }
};

/**
 * CACHE KEYS NAMESPACE
 * Organized key structure prevents collisions
 */
const CACHE_KEYS = {
    USER_PROFILE: (userId) => `user:${userId}:profile`,
    USER_WALLET: (userId) => `user:${userId}:wallet`,
    PRODUCT: (productId) => `product:${productId}`,
    PRODUCTS_CATEGORY: (category) => `products:category:${category}`,
    PRODUCTS_SELLER: (sellerId) => `products:seller:${sellerId}`,
    ORDER: (orderId) => `order:${orderId}`,
    CATEGORIES: (type) => `categories:${type}`,
    PAYMENT_LOCK: (reference) => `payment:lock:${reference}`,
    WEBHOOK_LOCK: (eventId) => `webhook:lock:${eventId}`,
    RATE_LIMIT: (identifier) => `ratelimit:${identifier}`,
};

/**
 * TTL (Time To Live) Constants in seconds
 */
const CACHE_TTL = {
    SHORT: 300,        // 5 minutes
    MEDIUM: 1800,      // 30 minutes  
    LONG: 3600,        // 1 hour
    VERY_LONG: 86400,  // 24 hours
    WEEK: 604800       // 7 days
};

/**
 * Generic cache getter with error handling
 */
async function getCache(key) {
    try {
        if (!client.isOpen) return null;
        const data = await client.get(key);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        console.error(`Cache get error [${key}]:`, err.message);
        return null;
    }
}

/**
 * Generic cache setter with error handling
 */
async function setCache(key, value, ttl = CACHE_TTL.MEDIUM) {
    try {
        if (!client.isOpen) return false;
        await client.setEx(key, ttl, JSON.stringify(value));
        return true;
    } catch (err) {
        console.error(`Cache set error [${key}]:`, err.message);
        return false;
    }
}

/**
 * Delete cache entry
 */
async function deleteCache(key) {
    try {
        if (!client.isOpen) return false;
        await client.del(key);
        return true;
    } catch (err) {
        console.error(`Cache delete error [${key}]:`, err.message);
        return false;
    }
}

/**
 * Delete multiple cache entries matching pattern
 */
async function deleteCachePattern(pattern) {
    try {
        if (!client.isOpen) return false;
        const keys = await client.keys(pattern);
        if (keys.length > 0) {
            await client.del(keys);
        }
        return true;
    } catch (err) {
        console.error(`Cache pattern delete error [${pattern}]:`, err.message);
        return false;
    }
}

/**
 * Invalidate user-related caches
 */
async function invalidateUserCache(userId) {
    await Promise.all([
        deleteCache(CACHE_KEYS.USER_PROFILE(userId)),
        deleteCache(CACHE_KEYS.USER_WALLET(userId)),
        deleteCachePattern(`products:seller:${userId}*`)
    ]);
}

/**
 * Invalidate product-related caches
 */
async function invalidateProductCache(productId, category, sellerId) {
    await Promise.all([
        deleteCache(CACHE_KEYS.PRODUCT(productId)),
        deleteCache(CACHE_KEYS.PRODUCTS_CATEGORY(category)),
        deleteCache(CACHE_KEYS.PRODUCTS_SELLER(sellerId))
    ]);
}

module.exports = {
    client,
    connectRedis,
    CACHE_KEYS,
    CACHE_TTL,
    getCache,
    setCache,
    deleteCache,
    deleteCachePattern,
    invalidateUserCache,
    invalidateProductCache
};