// routes/service-provider.routes.js - PRODUCTION-GRADE BACKEND ROUTES
const express = require('express');
const router = express.Router();
const { authenticate, userRateLimit } = require('../middleware/auth');
const { cacheMiddleware } = require('../middleware/cache');
const serviceProviderService = require('../services/service-provider.service');
const reviewService = require('../services/review.service');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');

/**
 * GET /api/v1/service-providers/category/:category
 *
 * Query params:
 *   state        — filter by state
 *   city         — filter by city
 *   area         — filter by area
 *   subcategory  — filter by service subcategory
 *   q            — search term (matches businessName & serviceDescription)
 *   page         — page number, default 1
 *   limit        — page size, default 20, max 50
 *   userId       — current viewer's uid (surfaces own profile even if unsubscribed)
 *
 * Response:
 *   { success, providers, hasMore, totalCount, page, limit, count }
 */
router.get(
    '/category/:category',
    catchAsync(async (req, res) => {
        const { category } = req.params;
        const {
            state,
            city,
            area,
            subcategory,
            q,
            page  = 1,
            limit = 20,
            userId,
        } = req.query;

        const result = await serviceProviderService.getProvidersByCategory(category, {
            state,
            city,
            area,
            subcategory,
            q,
            page,
            limit,
            currentUserId: userId,
        });

        res.json({
            success: true,
            providers:  result.providers,
            hasMore:    result.hasMore,
            totalCount: result.totalCount,
            page:       result.page,
            limit:      result.limit,
            count:      result.providers.length,
        });
    })
);

/**
 * GET /api/v1/service-providers/subscription/status
 * Must be defined BEFORE /:providerId to avoid route collision
 */
router.get(
    '/subscription/status',
    authenticate,
    catchAsync(async (req, res) => {
        const providerId = req.userId;

        const status = await serviceProviderService.getSubscriptionStatus(providerId);

        res.json({
            success: true,
            subscription: status
        });
    })
);

/**
 * GET /api/v1/service-providers/:providerId
 * Get provider profile with view tracking
 */
router.get(
    '/:providerId',
    catchAsync(async (req, res) => {
        const { providerId } = req.params;
        const viewerId = req.query.viewerId;

        const profile = await serviceProviderService.getProviderProfile(providerId, viewerId);

        res.json({
            success: true,
            provider: profile
        });
    })
);

/**
 * GET /api/v1/service-providers/:providerId/reviews
 * Get provider reviews with caching
 */
router.get(
    '/:providerId/reviews',
    cacheMiddleware(180), // 3 minutes
    catchAsync(async (req, res) => {
        const { providerId } = req.params;

        const reviews = await serviceProviderService.getProviderReviews(providerId);

        res.json({
            success: true,
            reviews,
            count: reviews.length
        });
    })
);

/**
 * POST /api/v1/service-providers/:providerId/review
 * Submit review with validation
 */
router.post(
    '/:providerId/review',
    authenticate,
    userRateLimit(3, 60 * 60 * 1000), // 3 reviews per hour max
    catchAsync(async (req, res, next) => {
        const { providerId } = req.params;
        const { rating, comment } = req.body;
        const userId  = req.userId;
        const userName = req.userProfile?.name || 'Anonymous';

        if (userId === providerId) {
            return next(new AppError('You cannot review yourself', 400));
        }

        if (req.userProfile?.role === 'service') {
            return next(new AppError('Service providers cannot submit reviews', 403));
        }

        if (!rating || rating < 1 || rating > 5) {
            return next(new AppError('Rating must be between 1 and 5', 400));
        }

        if (!comment || comment.trim().length < 10) {
            return next(new AppError('Comment must be at least 10 characters', 400));
        }

        const result = await reviewService.submitReview(
            providerId,
            userId,
            userName,
            rating,
            comment
        );

        const pushNotificationService = require('../services/push-notification.service');
        await pushNotificationService.sendPushToUser(
            providerId,
            "⭐ New Review!",
            `${userName} rated you ${rating} stars`,
            { screen: "ServiceProviderDashboard" }
        );

        res.json({
            success: true,
            message: 'Review submitted successfully',
            data: result
        });
    })
);

/**
 * POST /api/v1/service-providers/subscribe
 * Subscribe provider (deducts from wallet)
 */
router.post(
    '/subscribe',
    authenticate,
    userRateLimit(5, 15 * 60 * 1000),
    catchAsync(async (req, res, next) => {
        const { plan } = req.body;
        const providerId = req.userId;

        if (req.userProfile?.role !== 'service') {
            return next(new AppError('Only service providers can subscribe', 403));
        }

        try {
            const result = await serviceProviderService.subscribe(providerId, plan);
            res.json(result);
        } catch (error) {
            // Check if it's a balance issue and return 400 instead of 500
            if (error.message === 'Insufficient wallet balance') {
                return next(new AppError('Your wallet balance is too low for this plan.', 400));
            }
            if (error.message === 'Profile must be at least 70% complete') {
                return next(new AppError(error.message, 400));
            }
            next(error); // Pass through other actual 500 errors
        }
    })
);

/**
 * POST /api/v1/service-providers/track-view/:providerId
 * Track profile view (authenticated, non-self only)
 */
router.post(
    '/track-view/:providerId',
    authenticate,
    catchAsync(async (req, res) => {
        const { providerId } = req.params;
        const userId = req.userId;

        if (userId === providerId) {
            return res.json({ success: true, tracked: false });
        }

        const result = await serviceProviderService._trackProfileView(providerId, userId);

        res.json({
            success: true,
            tracked: result
        });
    })
);

/**
 * POST /api/v1/service-providers/share/:providerId
 * Generate platform-specific share link
 */
router.post(
    '/share/:providerId',
    catchAsync(async (req, res) => {
        const { providerId } = req.params;
        const { platform } = req.body;

        const provider = await serviceProviderService.getProviderProfile(providerId);

        const shareUrl = `https://elitehubng.com/service-provider/${providerId}`;
        const message  = `Check out ${provider.businessName} on EliteHub! ${provider.serviceDescription || ''}`;

        let platformUrl;
        switch (platform) {
            case 'whatsapp':
                platformUrl = `https://wa.me/?text=${encodeURIComponent(`${message} ${shareUrl}`)}`;
                break;
            case 'facebook':
                platformUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
                break;
            case 'twitter':
                platformUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}&url=${encodeURIComponent(shareUrl)}`;
                break;
            default:
                platformUrl = shareUrl;
        }

        res.json({
            success: true,
            shareUrl: platformUrl,
            message
        });
    })
);

module.exports = router;