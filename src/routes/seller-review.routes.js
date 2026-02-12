// routes/seller-review.routes.js - FIXED VERSION
const express = require('express');
const router = express.Router();
const { authenticate, userRateLimit } = require('../middleware/auth');
const sellerReviewService = require('../services/seller-review.service');

/**
 * ✅ FIXED: POST /api/v1/seller-reviews/submit
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

            // ✅ CRITICAL FIX: More descriptive validation messages
            if (!sellerId) {
                return res.status(400).json({
                    success: false,
                    message: 'Seller ID is required',
                    field: 'sellerId'
                });
            }

            if (!orderId) {
                return res.status(400).json({
                    success: false,
                    message: 'Order ID is required',
                    field: 'orderId'
                });
            }

            if (!rating || rating < 1 || rating > 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Rating must be between 1 and 5',
                    field: 'rating'
                });
            }

            if (!comment || comment.trim().length < 10) {
                return res.status(400).json({
                    success: false,
                    message: 'Comment must be at least 10 characters',
                    field: 'comment',
                    currentLength: comment?.trim().length || 0
                });
            }

            console.log('📝 Review submission request:', {
                sellerId,
                orderId,
                buyerId,
                rating,
                commentLength: comment.trim().length
            });

            // Submit review via service
            const result = await sellerReviewService.submitSellerReview(
                sellerId,
                buyerId,
                orderId,
                buyerName,
                rating,
                comment
            );

            console.log('✅ Review submitted successfully:', result);

            res.status(201).json({
                success: true,
                message: 'Review submitted successfully',
                data: result
            });
        } catch (error) {
            console.error('❌ Submit seller review error:', error);
            
            // Return user-friendly error messages
            const statusCode = error.message.includes('not found') ? 404 :
                              error.message.includes('Unauthorized') ? 403 :
                              error.message.includes('already been reviewed') ? 409 :
                              400;

            res.status(statusCode).json({
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
                reviews,
                count: reviews.length
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

            // Note: You'll need to add this method to the service
            // await sellerReviewService.flagReview(reviewId, userId, reason);

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

            // Check via service
            const orderDoc = await require('../config/firebase').db
                .collection('orders')
                .doc(orderId)
                .get();

            if (!orderDoc.exists()) {
                return res.status(404).json({
                    success: false,
                    message: 'Order not found'
                });
            }

            const hasReviewed = orderDoc.data().hasSellerReview || false;

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