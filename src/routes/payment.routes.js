const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const walletService = require('../services/wallet.service');
const { client } = require('../config/redis');

/**
 * FIX: Process order payment (called from CheckoutReviewScreen)
 */
router.post('/process-order', authenticate, async (req, res) => {
    try {
        const { buyerId, sellerId, orderId, totalAmount, commission, productIds } = req.body;

        // Validate request
        if (!orderId || !buyerId || !sellerId || !totalAmount) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Security: Verify requester is the buyer
        if (req.userId !== buyerId) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized payment attempt'
            });
        }

        // Idempotency check
        const lockKey = `payment:${orderId}`;
        const existing = await client.get(lockKey);
        
        if (existing) {
            return res.json({
                success: true,
                message: 'Payment already processed',
                alreadyProcessed: true
            });
        }

        // Set processing lock (60 seconds)
        await client.setEx(lockKey, 60, 'processing');

        try {
            // Process payment through wallet service
            const result = await walletService.processOrderPayment(
                buyerId,
                sellerId,
                orderId,
                totalAmount,
                commission
            );

            // Mark as completed
            await client.setEx(lockKey, 86400, 'completed');

            res.json({
                success: true,
                message: 'Payment processed successfully',
                orderId
            });

        } catch (error) {
            // Remove lock on failure
            await client.del(lockKey);
            throw error;
        }

    } catch (error) {
        console.error('❌ Process order payment error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Payment processing failed'
        });
    }
});

module.exports = router;