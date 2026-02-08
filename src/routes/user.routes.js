const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { userCacheMiddleware, cacheMiddleware } = require('../middleware/cache');
const { getDocument, updateDocument, queryDocuments } = require('../config/firebase');
const { invalidateUserCache, CACHE_TTL } = require('../config/redis');

const EmailService = require('../services/email.service');


/**
 * POST /api/v1/users/welcome
 * Triggered by frontend after a successful signup
 */
router.post('/welcome', async (req, res) => {
  const { email, name, role } = req.body;

  // Basic validation
  if (!email || !name || !role) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    // Determine which welcome email to send based on the user's role
    switch (role) {
      case 'seller':
        await EmailService.sendSellerWelcomeEmail(email, name);
        break;
      case 'service':
        await EmailService.sendServiceWelcomeEmail(email, name);
        break;
      case 'buyer':
      default:
        await EmailService.sendBuyerWelcomeEmail(email, name);
        break;
    }

    res.status(200).json({ success: true, message: 'Welcome email sent successfully' });
  } catch (error) {
    // Log the error but don't expose sensitive info to the client
    console.error('Email Trigger Error:', error);
    res.status(500).json({ success: false, message: 'Failed to send welcome email' });
  }
});

module.exports = router;
/**
 * USER ROUTES
 * Optimized with Redis caching to reduce Firebase reads
 */

/**
 * GET /api/v1/users/profile/:userId
 * Get user profile (cached for 5 minutes)
 */
router.get(
    '/profile/:userId',
    authenticate,
    userCacheMiddleware(CACHE_TTL.SHORT),
    async (req, res) => {
        try {
            const { userId } = req.params;

            // Check authorization
            if (req.userId !== userId && req.userProfile?.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied'
                });
            }

            const user = await getDocument('users', userId);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            // Remove sensitive fields
            const { paystackRecipientCode, ...safeUser } = user;

            res.json({
                success: true,
                user: safeUser
            });
        } catch (error) {
            console.error('Get user profile error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch user profile'
            });
        }
    }
);

/**
 * PUT /api/v1/users/profile/:userId
 * Update user profile
 */
router.put(
    '/profile/:userId',
    authenticate,
    async (req, res) => {
        try {
            const { userId } = req.params;

            // Check authorization
            if (req.userId !== userId && req.userProfile?.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied'
                });
            }

            const allowedFields = [
                'name', 'phone', 'gender', 'location',
                'businessName', 'businessAddress', 'businessPhone',
                'whatsappNumber', 'imageUrl', 'isAvailable',
                'serviceCategory', 'serviceSubcategory', 'serviceDescription',
                'workMode', 'yearsOfExperience', 'certifications',
                'portfolioImages', 'operatingHours',
                'instagramUsername', 'tiktokUsername'
            ];

            const updates = {};
            allowedFields.forEach(field => {
                if (req.body[field] !== undefined) {
                    updates[field] = req.body[field];
                }
            });

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No valid fields to update'
                });
            }

            updates.updatedAt = Date.now();

            await updateDocument('users', userId, updates);

            // Invalidate cache
            await invalidateUserCache(userId);

            res.json({
                success: true,
                message: 'Profile updated successfully'
            });
        } catch (error) {
            console.error('Update user profile error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to update profile'
            });
        }
    }
);

/**
 * GET /api/v1/users/sellers
 * Get all sellers (cached for 10 minutes)
 */
router.get(
    '/sellers',
    cacheMiddleware(CACHE_TTL.MEDIUM),
    async (req, res) => {
        try {
            const { state, category } = req.query;

            let filters = [
                { field: 'role', operator: '==', value: 'seller' },
                { field: 'hasCompletedBusinessProfile', operator: '==', value: true }
            ];

            if (state) {
                filters.push({ field: 'location.state', operator: '==', value: state });
            }

            if (category) {
                filters.push({ field: 'sellerCategories', operator: 'array-contains', value: category });
            }

            const sellers = await queryDocuments('users', filters);

            // Remove sensitive data
            const safeSellers = sellers.map(({ paystackRecipientCode, ...seller }) => seller);

            res.json({
                success: true,
                sellers: safeSellers,
                count: safeSellers.length
            });
        } catch (error) {
            console.error('Get sellers error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch sellers'
            });
        }
    }
);

/**
 * GET /api/v1/users/service-providers
 * Get service providers (cached for 10 minutes)
 */
router.get(
    '/service-providers',
    cacheMiddleware(CACHE_TTL.MEDIUM),
    async (req, res) => {
        try {
            const { category, state, city } = req.query;

            let filters = [
                { field: 'role', operator: '==', value: 'service' },
                { field: 'hasCompletedBusinessProfile', operator: '==', value: true }
            ];

            if (category) {
                filters.push({ field: 'serviceCategory', operator: '==', value: category });
            }

            if (state) {
                filters.push({ field: 'location.state', operator: '==', value: state });
            }

            if (city) {
                filters.push({ field: 'location.city', operator: '==', value: city });
            }

            const providers = await queryDocuments('users', filters);

            // Filter by subscription status
            const now = Date.now();
            const activeProviders = providers.filter(p => 
                (p.subscriptionExpiresAt || 0) > now
            );

            // Remove sensitive data
            const safeProviders = activeProviders.map(({ 
                paystackRecipientCode, 
                ...provider 
            }) => provider);

            res.json({
                success: true,
                providers: safeProviders,
                count: safeProviders.length
            });
        } catch (error) {
            console.error('Get service providers error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch service providers'
            });
        }
    }
);

/**
 * PUT /api/v1/users/:userId/availability
 * Toggle service provider availability
 */
router.put(
    '/:userId/availability',
    authenticate,
    async (req, res) => {
        try {
            const { userId } = req.params;
            const { isAvailable } = req.body;

            if (req.userId !== userId) {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied'
                });
            }

            const user = await getDocument('users', userId);

            if (!user || user.role !== 'service') {
                return res.status(400).json({
                    success: false,
                    message: 'Only service providers can update availability'
                });
            }

            await updateDocument('users', userId, {
                isAvailable: !!isAvailable,
                updatedAt: Date.now()
            });

            // Invalidate cache
            await invalidateUserCache(userId);

            res.json({
                success: true,
                message: 'Availability updated successfully',
                isAvailable: !!isAvailable
            });
        } catch (error) {
            console.error('Update availability error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to update availability'
            });
        }
    }
);

/**
 * GET /api/v1/users/stats
 * Get platform statistics (Admin only, cached for 1 hour)
 */
router.get(
    '/stats',
    authenticate,
    adminOnly,
    cacheMiddleware(CACHE_TTL.LONG),
    async (req, res) => {
        try {
            const users = await queryDocuments('users', []);

            const stats = {
                totalUsers: users.length,
                buyers: users.filter(u => u.role === 'buyer').length,
                sellers: users.filter(u => u.role === 'seller').length,
                serviceProviders: users.filter(u => u.role === 'service').length,
                admins: users.filter(u => u.role === 'admin').length,
                activeUsers: users.filter(u => {
                    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
                    return (u.updatedAt || u.createdAt) > dayAgo;
                }).length,
                completedProfiles: users.filter(u => u.hasCompletedBusinessProfile).length
            };

            res.json({
                success: true,
                stats
            });
        } catch (error) {
            console.error('Get user stats error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch statistics'
            });
        }
    }
);

module.exports = router;