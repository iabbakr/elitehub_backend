const { verifyToken, getUserByUid } = require('../config/firebase');
const { getCache, setCache, CACHE_KEYS, CACHE_TTL } = require('../config/redis');

/**
 * PRODUCTION-GRADE AUTHENTICATION MIDDLEWARE
 */

/**
 * Verify Firebase ID Token
 */
const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'No authorization token provided'
            });
        }

        const idToken = authHeader.split('Bearer ')[1];
        
        // Verify token
        const decodedToken = await verifyToken(idToken);
        
        if (!decodedToken) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired token'
            });
        }

        // Add user info to request
        req.user = decodedToken;
        req.userId = decodedToken.uid;
        
        next();
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(401).json({
            success: false,
            message: 'Authentication failed'
        });
    }
};

/**
 * Optional authentication - doesn't fail if no token
 */
const optionalAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const idToken = authHeader.split('Bearer ')[1];
            const decodedToken = await verifyToken(idToken);
            
            if (decodedToken) {
                req.user = decodedToken;
                req.userId = decodedToken.uid;
            }
        }
        
        next();
    } catch (error) {
        // Continue without auth
        next();
    }
};

/**
 * Role-based authorization
 */
const authorize = (...allowedRoles) => {
    return async (req, res, next) => {
        try {
            if (!req.userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            // Try to get user profile from cache first
            const cacheKey = CACHE_KEYS.USER_PROFILE(req.userId);
            let userProfile = await getCache(cacheKey);
            
            // If not in cache, fetch from database
            if (!userProfile) {
                const { getDocument } = require('../config/firebase');
                userProfile = await getDocument('users', req.userId);
                
                if (!userProfile) {
                    return res.status(404).json({
                        success: false,
                        message: 'User not found'
                    });
                }
                
                // Cache for 5 minutes
                await setCache(cacheKey, userProfile, CACHE_TTL.SHORT);
            }

            // Check if user has required role
            if (!allowedRoles.includes(userProfile.role)) {
                return res.status(403).json({
                    success: false,
                    message: 'Insufficient permissions'
                });
            }

            // Add user profile to request
            req.userProfile = userProfile;
            next();
        } catch (error) {
            console.error('Authorization error:', error);
            res.status(500).json({
                success: false,
                message: 'Authorization check failed'
            });
        }
    };
};

/**
 * Resource ownership check
 */
const authorizeOwnership = (resourceType) => {
    return async (req, res, next) => {
        try {
            const resourceId = req.params.id || req.params.userId || req.params.productId;
            const userId = req.userId;

            if (!userId || !resourceId) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid request parameters'
                });
            }

            const { getDocument } = require('../config/firebase');
            const resource = await getDocument(resourceType, resourceId);

            if (!resource) {
                return res.status(404).json({
                    success: false,
                    message: `${resourceType} not found`
                });
            }

            // Check ownership based on resource type
            let isOwner = false;
            
            switch (resourceType) {
                case 'products':
                    isOwner = resource.sellerId === userId;
                    break;
                case 'orders':
                    isOwner = resource.buyerId === userId || resource.sellerId === userId;
                    break;
                case 'wallets':
                case 'users':
                    isOwner = resource.uid === userId || resource.userId === userId;
                    break;
                default:
                    isOwner = resource.userId === userId || resource.uid === userId;
            }

            // Admin override
            if (req.userProfile?.role === 'admin') {
                isOwner = true;
            }

            if (!isOwner) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to this resource'
                });
            }

            req.resource = resource;
            next();
        } catch (error) {
            console.error('Ownership check error:', error);
            res.status(500).json({
                success: false,
                message: 'Ownership verification failed'
            });
        }
    };
};

/**
 * Admin-only middleware
 */
const adminOnly = authorize('admin');

/**
 * Admin or Support Agent middleware
 */
const adminOrSupport = authorize('admin', 'support_agent');

/**
 * Seller-only middleware
 */
const sellerOnly = authorize('seller');

/**
 * Seller or Admin middleware
 */
const sellerOrAdmin = authorize('seller', 'admin');

/**
 * Service provider or Admin middleware
 */
const serviceOrAdmin = authorize('service', 'admin');

/**
 * Rate limiting per user
 */
const userRateLimit = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
    return async (req, res, next) => {
        if (!req.userId) {
            return next();
        }

        const key = `ratelimit:user:${req.userId}`;
        
        try {
            const { client } = require('../config/redis');
            
            if (!client.isOpen) {
                return next();
            }

            const current = await client.incr(key);
            
            if (current === 1) {
                await client.expire(key, Math.floor(windowMs / 1000));
            }

            if (current > maxRequests) {
                return res.status(429).json({
                    success: false,
                    message: 'Too many requests, please try again later'
                });
            }

            res.set('X-RateLimit-Limit', maxRequests);
            res.set('X-RateLimit-Remaining', Math.max(0, maxRequests - current));
            
            next();
        } catch (error) {
            console.error('Rate limit error:', error);
            next();
        }
    };
};

/**
 * Validate request body against schema
 */
const validateBody = (schema) => {
    return (req, res, next) => {
        const { error } = schema.validate(req.body, { abortEarly: false });
        
        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));
            
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors
            });
        }
        
        next();
    };
};

module.exports = {
    authenticate,
    optionalAuth,
    authorize,
    authorizeOwnership,
    adminOnly,
    adminOrSupport,
    sellerOnly,
    sellerOrAdmin,
    serviceOrAdmin,
    userRateLimit,
    validateBody
};