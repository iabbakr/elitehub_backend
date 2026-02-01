// routes/seller-review.routes.js - SELLER REVIEW & RATING API
const express = require('express');
const router = express.Router();
const { authenticate, userRateLimit } = require('../middleware/auth');
const sellerReviewService = require('../services/seller-review.service');

/**
 * POST /api/v1/seller-reviews/submit
 * Submit a review for a seller (after successful order delivery)
 */
router.post(
    '/submit',
    authenticate,
    userRateLimit(3, 60 * 60 * 1000), // 3 reviews per hour max
    async (req, res) => {
        try {
            const { sellerId, orderId, rating, comment } = req.body;
            const buyerId = req.userId;
            const buyerName = req.userProfile?.name || 'Anonymous';

            // Validation
            if (!sellerId || !orderId || !rating) {
                return res.status(400).json({
                    success: false,
                    message: 'Seller ID, Order ID, and rating are required'
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
            const result = await sellerReviewService.submitSellerReview(
                sellerId,
                buyerId,
                orderId,
                buyerName,
                rating,
                comment
            );

            res.json({
                success: true,
                message: 'Review submitted successfully',
                data: result
            });
        } catch (error) {
            console.error('Submit seller review error:', error);
            res.status(400).json({
                success: false,
                message: error.message || 'Failed to submit review'
            });
        }
    }
);

/**
 * GET /api/v1/seller-reviews/seller/:sellerId
 * Get reviews for a seller (last 10)
 */
router.get(
    '/seller/:sellerId',
    async (req, res) => {
        try {
            const { sellerId } = req.params;
            const limit = parseInt(req.query.limit) || 10;
            
            const reviews = await sellerReviewService.getSellerReviews(sellerId, limit);

            res.json({
                success: true,
                reviews
            });
        } catch (error) {
            console.error('Get seller reviews error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch reviews'
            });
        }
    }
);

/**
 * GET /api/v1/seller-reviews/rating/:sellerId
 * Get seller rating with counters
 */
router.get(
    '/rating/:sellerId',
    async (req, res) => {
        try {
            const { sellerId } = req.params;
            const rating = await sellerReviewService.getSellerRating(sellerId);

            res.json({
                success: true,
                rating
            });
        } catch (error) {
            console.error('Get seller rating error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch rating'
            });
        }
    }
);

/**
 * GET /api/v1/seller-reviews/stats/:sellerId
 * Get comprehensive seller statistics
 */
router.get(
    '/stats/:sellerId',
    async (req, res) => {
        try {
            const { sellerId } = req.params;
            const stats = await sellerReviewService.getSellerStats(sellerId);

            res.json({
                success: true,
                stats
            });
        } catch (error) {
            console.error('Get seller stats error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch seller statistics'
            });
        }
    }
);

/**
 * POST /api/v1/seller-reviews/flag/:reviewId
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

            await sellerReviewService.flagReview(reviewId, userId, reason);

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
 * GET /api/v1/seller-reviews/check-reviewed/:sellerId/:orderId
 * Check if buyer has already reviewed this seller for this order
 */
router.get(
    '/check-reviewed/:sellerId/:orderId',
    authenticate,
    async (req, res) => {
        try {
            const { sellerId, orderId } = req.params;
            const buyerId = req.userId;

            const hasReviewed = await sellerReviewService.hasReviewedOrder(
                buyerId,
                sellerId,
                orderId
            );

            res.json({
                success: true,
                hasReviewed
            });
        } catch (error) {
            console.error('Check reviewed error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to check review status'
            });
        }
    }
);

module.exports = router;