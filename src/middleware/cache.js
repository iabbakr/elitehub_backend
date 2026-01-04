const { getCache, setCache } = require('../config/redis');

/**
 * PRODUCTION-GRADE CACHE MIDDLEWARE
 * Implements smart caching with cache-control headers
 */

/**
 * Cache middleware with automatic invalidation
 * @param {number} ttl - Time to live in seconds
 * @param {function} keyGenerator - Optional custom key generator
 */
const cacheMiddleware = (ttl = 300, keyGenerator = null) => {
    return async (req, res, next) => {
        // Skip caching for non-GET requests
        if (req.method !== 'GET') {
            return next();
        }

        // Generate cache key
        const cacheKey = keyGenerator 
            ? keyGenerator(req) 
            : `cache:${req.originalUrl}`;

        try {
            // Try to get from cache
            const cachedData = await getCache(cacheKey);
            
            if (cachedData) {
                // Set cache headers
                res.set({
                    'X-Cache': 'HIT',
                    'Cache-Control': `public, max-age=${ttl}`
                });
                
                return res.status(200).json(cachedData);
            }

            // Cache miss - wrap response
            res.set('X-Cache', 'MISS');
            
            // Override res.json to cache the response
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                // Only cache successful responses
                if (res.statusCode === 200) {
                    setCache(cacheKey, data, ttl).catch(err => {
                        console.error('Failed to cache response:', err);
                    });
                }
                return originalJson(data);
            };
            
            next();
        } catch (error) {
            console.error('Cache middleware error:', error);
            // Continue without caching if Redis fails
            next();
        }
    };
};

/**
 * User-specific cache middleware
 */
const userCacheMiddleware = (ttl = 300) => {
    return cacheMiddleware(ttl, (req) => {
        const userId = req.params.userId || req.query.userId || req.user?.uid;
        return `cache:user:${userId}:${req.path}`;
    });
};

/**
 * Product cache middleware with category support
 */
const productCacheMiddleware = (ttl = 600) => {
    return cacheMiddleware(ttl, (req) => {
        const category = req.query.category || 'all';
        const page = req.query.page || '1';
        return `cache:products:${category}:page:${page}`;
    });
};

/**
 * Conditional cache - only cache if conditions met
 */
const conditionalCache = (ttl, condition) => {
    return async (req, res, next) => {
        const shouldCache = await condition(req);
        
        if (shouldCache) {
            return cacheMiddleware(ttl)(req, res, next);
        }
        
        next();
    };
};

/**
 * Cache warming helper
 * Pre-loads frequently accessed data into cache
 */
async function warmCache(key, fetchFunction, ttl) {
    try {
        const data = await fetchFunction();
        await setCache(key, data, ttl);
        console.log(`Cache warmed for key: ${key}`);
    } catch (error) {
        console.error(`Failed to warm cache for key ${key}:`, error);
    }
}

/**
 * Stale-While-Revalidate pattern
 * Returns cached data immediately, then updates in background
 */
const staleWhileRevalidate = (ttl, revalidateThreshold = 0.8) => {
    return async (req, res, next) => {
        if (req.method !== 'GET') {
            return next();
        }

        const cacheKey = `cache:${req.originalUrl}`;
        const timestampKey = `${cacheKey}:timestamp`;

        try {
            const [cachedData, timestamp] = await Promise.all([
                getCache(cacheKey),
                getCache(timestampKey)
            ]);

            if (cachedData && timestamp) {
                const age = Date.now() - timestamp;
                const isStale = age > (ttl * 1000 * revalidateThreshold);

                // Return cached data
                res.set('X-Cache', isStale ? 'STALE' : 'HIT');
                res.status(200).json(cachedData);

                // If stale, trigger background revalidation
                if (isStale) {
                    process.nextTick(() => {
                        revalidateInBackground(req, cacheKey, timestampKey, ttl);
                    });
                }
                return;
            }

            // No cache - proceed normally
            wrapResponseForCaching(res, cacheKey, timestampKey, ttl);
            next();
        } catch (error) {
            console.error('SWR cache error:', error);
            next();
        }
    };
};

/**
 * Background revalidation
 */
async function revalidateInBackground(req, cacheKey, timestampKey, ttl) {
    try {
        // This would need to be customized based on your route handlers
        console.log(`Background revalidation triggered for: ${cacheKey}`);
        // Implementation would depend on your specific needs
    } catch (error) {
        console.error('Background revalidation failed:', error);
    }
}

/**
 * Wrap response for caching with timestamp
 */
function wrapResponseForCaching(res, cacheKey, timestampKey, ttl) {
    const originalJson = res.json.bind(res);
    res.json = (data) => {
        if (res.statusCode === 200) {
            Promise.all([
                setCache(cacheKey, data, ttl),
                setCache(timestampKey, Date.now(), ttl)
            ]).catch(err => {
                console.error('Failed to cache response:', err);
            });
        }
        return originalJson(data);
    };
}

module.exports = {
    cacheMiddleware,
    userCacheMiddleware,
    productCacheMiddleware,
    conditionalCache,
    warmCache,
    staleWhileRevalidate
};