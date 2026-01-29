// routes/review.routes.js - REVIEW & RATING API
const express = require('express');
const router = express.Router();
const { authenticate, userRateLimit } = require('../middleware/auth');
const reviewService = require('../services/review.service');

/**
 * POST /api/v1/reviews/submit
 * Submit a review for a service provider
 */
router.post(
    '/submit',
    authenticate,
    userRateLimit(3, 60 * 60 * 1000), // 3 reviews per hour max
    async (req, res) => {
        try {
            const { providerId, rating, comment } = req.body;
            const userId = req.userId;
            const userName = req.userProfile?.name || 'Anonymous';

            // Validation
            if (!providerId || !rating) {
                return res.status(400).json({
                    success: false,
                    message: 'Provider ID and rating are required'
                });
            }

            if (rating < 1 || rating > 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Rating must be between 1 and 5'
                });
            }

            if (!comment || comment.trim().length < 10) {
                return res.status(400).json({
                    success: false,
                    message: 'Comment must be at least 10 characters'
                });
            }

            // Submit review
            const result = await reviewService.submitReview(
                providerId,
                userId,
                userName,
                rating,
                comment
            );

            res.json({
                success: true,
                message: 'Review submitted successfully',
                data: result
            });
        } catch (error) {
            console.error('Submit review error:', error);
            res.status(400).json({
                success: false,
                message: error.message || 'Failed to submit review'
            });
        }
    }
);

/**
 * GET /api/v1/reviews/provider/:providerId
 * Get reviews for a provider (last 5)
 */
router.get(
    '/provider/:providerId',
    async (req, res) => {
        try {
            const { providerId } = req.params;
            const reviews = await reviewService.getProviderReviews(providerId);

            res.json({
                success: true,
                reviews
            });
        } catch (error) {
            console.error('Get reviews error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch reviews'
            });
        }
    }
);

/**
 * GET /api/v1/reviews/rating/:providerId
 * Get provider rating with counters
 */
router.get(
    '/rating/:providerId',
    async (req, res) => {
        try {
            const { providerId } = req.params;
            const rating = await reviewService.getProviderRating(providerId);

            res.json({
                success: true,
                rating
            });
        } catch (error) {
            console.error('Get rating error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch rating'
            });
        }
    }
);

/**
 * POST /api/v1/reviews/flag/:reviewId
 * Flag a review for inappropriate content
 */
router.post(
    '/flag/:reviewId',
    authenticate,
    userRateLimit(5, 60 * 60 * 1000),
    async (req, res) => {
        try {
            const { reviewId } = req.params;
            const { reason } = req.body;
            const userId = req.userId;

            if (!reason || reason.trim().length < 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Please provide a reason for flagging'
                });
            }

            await reviewService.flagReview(reviewId, userId, reason);

            res.json({
                success: true,
                message: 'Review flagged successfully'
            });
        } catch (error) {
            console.error('Flag review error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to flag review'
            });
        }
    }
);

/**
 * POST /api/v1/reviews/track-view/:providerId
 * Track profile view (one per user per month)
 */
router.post(
    '/track-view/:providerId',
    authenticate,
    async (req, res) => {
        try {
            const { providerId } = req.params;
            const userId = req.userId;

            const result = await reviewService.trackProfileView(providerId, userId);

            res.json({
                success: true,
                ...result
            });
        } catch (error) {
            console.error('Track view error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to track view'
            });
        }
    }
);

/**
 * GET /api/v1/reviews/provider-status/:providerId
 * Check if provider is flagged or active
 */
router.get(
    '/provider-status/:providerId',
    async (req, res) => {
        try {
            const { providerId } = req.params;
            const status = await reviewService.checkProviderStatus(providerId);

            res.json({
                success: true,
                status
            });
        } catch (error) {
            console.error('Check status error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to check provider status'
            });
        }
    }
);

/**
 * POST /api/v1/reviews/admin/pardon/:providerId
 * Admin: Pardon a flagged provider
 */
router.post(
    '/admin/pardon/:providerId',
    authenticate,
    async (req, res) => {
        try {
            const { providerId } = req.params;
            const { reason } = req.body;
            const adminId = req.userId;

            // Check if user is admin
            if (req.userProfile?.role !== 'admin' && req.userProfile?.role !== 'support_agent') {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied'
                });
            }

            if (!reason || reason.trim().length < 10) {
                return res.status(400).json({
                    success: false,
                    message: 'Please provide a detailed reason for pardoning'
                });
            }

            await reviewService.pardonProvider(providerId, adminId, reason);

            res.json({
                success: true,
                message: 'Provider pardoned successfully'
            });
        } catch (error) {
            console.error('Pardon provider error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to pardon provider'
            });
        }
    }
);

/**
 * GET /api/v1/reviews/subscription/:providerId
 * Get subscription information with pricing
 */
router.get(
    '/subscription/:providerId',
    authenticate,
    async (req, res) => {
        try {
            const { providerId } = req.params;

            // Check authorization
            if (req.userId !== providerId && req.userProfile?.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied'
                });
            }

            const info = await reviewService.getSubscriptionInfo(providerId);

            if (!info) {
                return res.status(404).json({
                    success: false,
                    message: 'Provider not found'
                });
            }

            res.json({
                success: true,
                subscription: info
            });
        } catch (error) {
            console.error('Get subscription error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch subscription info'
            });
        }
    }
);

module.exports = router;