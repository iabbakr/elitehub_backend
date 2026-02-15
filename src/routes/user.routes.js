// routes/user.routes.js - MERGED CLEAN VERSION
const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticate, adminOnly } = require('../middleware/auth');
const { userCacheMiddleware, cacheMiddleware } = require('../middleware/cache');
const { CACHE_TTL } = require('../config/redis');
const { db, admin } = require('../config/firebase');
const catchAsync = require('../utils/catchAsync');

/**
 * @section Favorites Management
 */

/**
 * POST /api/v1/users/favorites/add
 * Add service provider to favorites
 */
router.post(
    '/favorites/add',
    authenticate,
    catchAsync(async (req, res) => {
        const { providerId } = req.body;
        const userId = req.userId;

        if (!providerId) {
            return res.status(400).json({
                success: false,
                message: 'Provider ID is required'
            });
        }

        const userRef = db.collection('users').doc(userId);
        
        await userRef.update({
            favoriteProviders: admin.firestore.FieldValue.arrayUnion(providerId),
            updatedAt: Date.now()
        });

        res.json({
            success: true,
            message: 'Added to favorites'
        });
    })
);

/**
 * POST /api/v1/users/favorites/remove
 * Remove service provider from favorites
 */
router.post(
    '/favorites/remove',
    authenticate,
    catchAsync(async (req, res) => {
        const { providerId } = req.body;
        const userId = req.userId;

        if (!providerId) {
            return res.status(400).json({
                success: false,
                message: 'Provider ID is required'
            });
        }

        const userRef = db.collection('users').doc(userId);
        
        await userRef.update({
            favoriteProviders: admin.firestore.FieldValue.arrayRemove(providerId),
            updatedAt: Date.now()
        });

        res.json({
            success: true,
            message: 'Removed from favorites'
        });
    })
);

/**
 * GET /api/v1/users/favorites/:userId
 * Get user's favorite providers
 */
router.get(
    '/favorites/:userId',
    authenticate,
    catchAsync(async (req, res) => {
        const { userId } = req.params;

        if (req.userId !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        const userDoc = await db.collection('users').doc(userId).get();
        
        if (!userDoc.exists()) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const favorites = userDoc.data().favoriteProviders || [];

        res.json({
            success: true,
            favorites
        });
    })
);

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