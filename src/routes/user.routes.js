const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticate, adminOnly } = require('../middleware/auth');
const { userCacheMiddleware, cacheMiddleware } = require('../middleware/cache');
const { CACHE_TTL } = require('../config/redis');

/**
 * @section Auth & Onboarding
 */

/**
 * POST /api/v1/users/welcome
 * Triggered after successful signup to send role-based emails
 */
router.post('/welcome', userController.sendWelcomeEmail);

/**
 * @section Profile Management
 */

// GET current user profile (Cached 5m)
router.get(
    '/profile/:userId',
    authenticate,
    userCacheMiddleware(CACHE_TTL.SHORT),
    userController.getUserProfile
);

// PUT update standard profile fields
router.put(
    '/profile/:userId',
    authenticate,
    userController.updateUserProfile
);

// PUT update specialized business details (Sellers/Services)
router.put(
    '/profile/business',
    authenticate,
    userController.updateBusinessProfile
);

// PUT toggle service provider availability
router.put(
    '/:userId/availability',
    authenticate,
    userController.toggleAvailability
);

/**
 * @section Social & Discovery
 */

// POST toggle favorite status for a seller
router.post(
    '/favorites/seller/:sellerId',
    authenticate,
    userController.toggleFavoriteSeller
);

// GET all active sellers (Cached 10m)
router.get(
    '/sellers',
    cacheMiddleware(CACHE_TTL.MEDIUM),
    userController.getSellers
);

// GET all active service providers (Cached 10m)
router.get(
    '/service-providers',
    cacheMiddleware(CACHE_TTL.MEDIUM),
    userController.getServiceProviders
);

/**
 * @section Admin Operations
 */

// GET platform statistics (Admin Only, Cached 1hr)
router.get(
    '/stats',
    authenticate,
    adminOnly,
    cacheMiddleware(CACHE_TTL.LONG),
    userController.getPlatformStats
);

module.exports = router;