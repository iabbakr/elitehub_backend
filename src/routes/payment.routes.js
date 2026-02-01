// routes/payment.routes.js - PRODUCTION PAYMENT ROUTES v2.0
// ATOMIC | IDEMPOTENT | AUDITABLE

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const walletService = require('../services/wallet.service');
const { client } = require('../config/redis');
const pushNotificationService = require('../services/push-notification.service');

/**
 * 🎯 PAYMENT PROCESSING PRINCIPLES
 * 1. IDEMPOTENT: Same request = same result (no duplicates)
 * 2. ATOMIC: All-or-nothing (wallet + order together)
 * 3. RECOVERABLE: Failed operations can retry safely
 * 4. AUDITABLE: Every step logged
 * 5. FAST: Redis locks prevent concurrent conflicts
 */

/**
 * POST /api/v1/payments/process-order
 * ✅ ATOMIC ORDER PAYMENT WITH ESCROW
 * 
 * Flow:
 * 1. Validate request
 * 2. Check idempotency (Redis)
 * 3. Process payment atomically
 * 4. Notify seller
 * 5. Return success
 */
router.post('/process-order', authenticate, async (req, res) => {
    const startTime = Date.now();
    
    try {
        const {
            buyerId,
            sellerId,
            orderId,
            totalAmount,
            commission,
            productIds = []
        } = req.body;

        // ==================== VALIDATION ====================
        
        // Required fields
        if (!orderId || !buyerId || !sellerId || !totalAmount) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: orderId, buyerId, sellerId, totalAmount'
            });
        }

        // Amount validation
        if (typeof totalAmount !== 'number' || totalAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid amount: must be positive number'
            });
        }

        // Commission validation
        const calculatedCommission = Math.round(totalAmount * 0.10);
        if (commission !== calculatedCommission) {
            console.warn(`⚠️ Commission mismatch: expected ${calculatedCommission}, got ${commission}`);
        }

        // Authorization check
        if (req.userId !== buyerId) {
            console.error(`🚨 SECURITY: User ${req.userId} attempted payment for ${buyerId}`);
            return res.status(403).json({
                success: false,
                message: 'UNAUTHORIZED: You can only process your own payments'
            });
        }

        // ==================== IDEMPOTENCY CHECK ====================
        
        const lockKey = `payment:${orderId}`;
        
        // Check if already processed
        const existingStatus = await client.get(lockKey);
        
        if (existingStatus === 'completed') {
            console.log(`⚠️ Payment already processed for order ${orderId}`);
            return res.json({
                success: true,
                message: 'Payment already processed',
                orderId,
                alreadyProcessed: true,
                processingTime: Date.now() - startTime
            });
        }

        if (existingStatus === 'processing') {
            return res.status(409).json({
                success: false,
                message: 'Payment is currently being processed. Please wait.',
                orderId,
                inProgress: true
            });
        }

        // Set processing lock (5 minutes)
        await client.setEx(lockKey, 300, 'processing');

        try {
            // ==================== PROCESS PAYMENT ====================
            
            console.log(`💳 Processing payment for order ${orderId}`);
            console.log(`   Buyer: ${buyerId}`);
            console.log(`   Seller: ${sellerId}`);
            console.log(`   Amount: ₦${totalAmount.toLocaleString()}`);
            console.log(`   Commission: ₦${commission.toLocaleString()}`);
            
            const result = await walletService.processOrderPayment(
                buyerId,
                sellerId,
                orderId,
                totalAmount,
                commission
            );

            // Mark as completed
            await client.setEx(lockKey, 86400, 'completed'); // 24 hour record

            // ==================== SUCCESS NOTIFICATION ====================
            
            try {
                await pushNotificationService.sendPushToUser(
                    sellerId,
                    "💰 New Order Payment",
                    `Received ₦${(totalAmount - commission).toLocaleString()} (pending delivery)`,
                    {
                        screen: "OrdersTab",
                        params: { screen: "Orders" },
                        orderId
                    }
                );
            } catch (notifError) {
                console.warn('📱 Notification failed (non-critical):', notifError.message);
            }

            // ==================== SUCCESS RESPONSE ====================
            
            const processingTime = Date.now() - startTime;
            
            console.log(`✅ Payment processed successfully in ${processingTime}ms`);
            
            res.json({
                success: true,
                message: 'Payment processed and locked in escrow',
                orderId,
                amount: totalAmount,
                sellerAmount: totalAmount - commission,
                commission,
                processingTime,
                timestamp: Date.now()
            });

        } catch (processingError) {
            // Remove lock on failure to allow retry
            await client.del(lockKey);
            
            console.error(`❌ Payment processing failed:`, processingError);
            
            throw processingError;
        }

    } catch (error) {
        console.error('❌ Process order payment error:', error);
        
        // Determine error type and status code
        let statusCode = 500;
        let errorMessage = 'Payment processing failed';

        if (error.message.includes('INSUFFICIENT_BALANCE')) {
            statusCode = 400;
            errorMessage = error.message;
        } else if (error.message.includes('WALLET_LOCKED')) {
            statusCode = 403;
            errorMessage = 'Wallet is temporarily locked. Contact support.';
        } else if (error.message.includes('WALLET_NOT_FOUND')) {
            statusCode = 404;
            errorMessage = 'Wallet not found';
        }

        res.status(statusCode).json({
            success: false,
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
            timestamp: Date.now()
        });
    }
});

/**
 * POST /api/v1/payments/confirm-delivery
 * ✅ ATOMIC ESCROW RELEASE
 * 
 * Flow:
 * 1. Validate request
 * 2. Check order status
 * 3. Release escrow atomically
 * 4. Notify seller
 * 5. Return success
 */
router.post('/confirm-delivery', authenticate, async (req, res) => {
    const startTime = Date.now();
    
    try {
        const {
            orderId,
            buyerId,
            sellerId,
            totalAmount,
            commission
        } = req.body;

        // Validation
        if (!orderId || !buyerId || !sellerId || !totalAmount) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Authorization check
        if (req.userId !== buyerId) {
            return res.status(403).json({
                success: false,
                message: 'UNAUTHORIZED: You can only confirm your own deliveries'
            });
        }

        // ==================== RELEASE ESCROW ====================
        
        console.log(`📦 Confirming delivery for order ${orderId}`);
        
        const result = await walletService.releaseEscrow(
            orderId,
            buyerId,
            sellerId,
            totalAmount,
            commission
        );

        if (result.alreadyProcessed) {
            return res.json({
                success: true,
                message: 'Payment already released',
                orderId,
                alreadyProcessed: true
            });
        }

        // ==================== SUCCESS NOTIFICATION ====================
        
        try {
            await pushNotificationService.sendPushToUser(
                sellerId,
                "💸 Payment Released!",
                `₦${result.amount.toLocaleString()} credited to your wallet`,
                {
                    screen: "OrdersTab",
                    params: { screen: "Orders" }
                }
            );
        } catch (notifError) {
            console.warn('📱 Notification failed (non-critical):', notifError.message);
        }

        // ==================== SUCCESS RESPONSE ====================
        
        const processingTime = Date.now() - startTime;
        
        console.log(`✅ Escrow released in ${processingTime}ms`);
        
        res.json({
            success: true,
            message: 'Payment released to seller',
            orderId,
            amount: result.amount,
            processingTime,
            timestamp: Date.now()
        });

    } catch (error) {
        console.error('❌ Confirm delivery error:', error);
        
        let statusCode = 500;
        let errorMessage = 'Failed to release payment';

        if (error.message.includes('ALREADY_DELIVERED')) {
            statusCode = 409;
            errorMessage = 'Order already confirmed and payment released';
        } else if (error.message.includes('INVALID_STATUS')) {
            statusCode = 400;
            errorMessage = error.message;
        }

        res.status(statusCode).json({
            success: false,
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
            timestamp: Date.now()
        });
    }
});

/**
 * POST /api/v1/payments/cancel-order
 * ✅ ATOMIC REFUND
 * 
 * Flow:
 * 1. Validate request
 * 2. Check order status
 * 3. Refund buyer atomically
 * 4. Notify buyer
 * 5. Return success
 */
router.post('/cancel-order', authenticate, async (req, res) => {
    const startTime = Date.now();
    
    try {
        const {
            orderId,
            buyerId,
            sellerId,
            totalAmount,
            commission,
            reason
        } = req.body;

        // Validation
        if (!orderId || !buyerId || !sellerId || !totalAmount || !reason) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Authorization check (either buyer or seller can cancel)
        if (req.userId !== buyerId && req.userId !== sellerId) {
            return res.status(403).json({
                success: false,
                message: 'UNAUTHORIZED: You can only cancel your own orders'
            });
        }

        // ==================== PROCESS REFUND ====================
        
        console.log(`🔄 Cancelling order ${orderId}: ${reason}`);
        
        const result = await walletService.refundEscrow(
            orderId,
            buyerId,
            sellerId,
            totalAmount,
            commission,
            reason
        );

        // ==================== SUCCESS NOTIFICATION ====================
        
        try {
            await pushNotificationService.sendPushToUser(
                buyerId,
                "💰 Refund Processed",
                `₦${result.refundAmount.toLocaleString()} refunded to your wallet`,
                {
                    screen: "OrdersTab",
                    params: { screen: "Orders" }
                }
            );
        } catch (notifError) {
            console.warn('📱 Notification failed (non-critical):', notifError.message);
        }

        // ==================== SUCCESS RESPONSE ====================
        
        const processingTime = Date.now() - startTime;
        
        console.log(`✅ Refund processed in ${processingTime}ms`);
        
        res.json({
            success: true,
            message: 'Order cancelled and buyer refunded',
            orderId,
            refundAmount: result.refundAmount,
            processingTime,
            timestamp: Date.now()
        });

    } catch (error) {
        console.error('❌ Cancel order error:', error);
        
        let statusCode = 500;
        let errorMessage = 'Failed to process refund';

        if (error.message.includes('CANNOT_REFUND_DELIVERED')) {
            statusCode = 400;
            errorMessage = 'Cannot refund delivered orders';
        } else if (error.message.includes('ORDER_NOT_FOUND')) {
            statusCode = 404;
            errorMessage = 'Order not found';
        }

        res.status(statusCode).json({
            success: false,
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
            timestamp: Date.now()
        });
    }
});

/**
 * GET /api/v1/payments/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
    res.json({
        success: true,
        service: 'payment-service',
        status: 'healthy',
        timestamp: Date.now()
    });
});

module.exports = router;