const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { db, runTransaction, getDocument } = require('../config/firebase');
const walletService = require('../services/wallet.service');
const { client, CACHE_KEYS } = require('../config/redis');

/**
 * FIX: OPTIMIZED ORDER ROUTES WITH PROPER ESCROW FLOW
 */


router.post('/:orderId/review', authenticate, async (req, res) => {
    try {
        const { rating, comment } = req.body;
        const { orderId } = req.params;
        const userId = req.userId;

        // 1. Validation
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ success: false, message: 'Valid rating (1-5) is required' });
        }

        // 2. Fetch Fresh Order Data
        const order = await getDocument('orders', orderId);

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        // 3. Security & Business Logic Checks
        if (order.buyerId !== userId) {
            return res.status(403).json({ success: false, message: 'Only the buyer can review this order' });
        }

        if (order.status !== 'delivered') {
            return res.status(400).json({ success: false, message: 'You can only review delivered orders' });
        }

        if (order.hasReview) {
            return res.status(400).json({ success: false, message: 'Review already submitted for this order' });
        }

        // 4. Atomic Transaction: Save Review & Update Order/Product/Seller
        await db.runTransaction(async (transaction) => {
            const reviewRef = db.collection('reviews').doc();
            const orderRef = db.collection('orders').doc(orderId);
            const sellerRef = db.collection('users').doc(order.sellerId);

            // Create Review Object
            transaction.set(reviewRef, {
                id: reviewRef.id,
                orderId,
                buyerId: userId,
                sellerId: order.sellerId,
                rating,
                comment: comment || '',
                productNames: order.products.map(p => p.productName),
                createdAt: Date.now()
            });

            // Mark Order as Reviewed
            transaction.update(orderRef, { 
                hasReview: true,
                updatedAt: Date.now() 
            });

            // Optional: Update Seller Rating Average
            const sellerDoc = await transaction.get(sellerRef);
            const sellerData = sellerDoc.data();
            const newTotalReviews = (sellerData.totalReviews || 0) + 1;
            const newAvgRating = sellerData.rating 
                ? ((sellerData.rating * (newTotalReviews - 1)) + rating) / newTotalReviews 
                : rating;

            transaction.update(sellerRef, {
                rating: Number(newAvgRating.toFixed(1)),
                totalReviews: newTotalReviews
            });
        });

        // 5. Invalidate Caches
        await Promise.all([
            client.del(`order:${orderId}`),
            client.del(`orders:${userId}:all:all`),
            client.del(`seller_profile:${order.sellerId}`)
        ]);

        res.status(201).json({
            success: true,
            message: 'Review submitted successfully'
        });

    } catch (error) {
        console.error('Review submission error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit review' });
    }
});

/**
 * PUT /api/v1/orders/:orderId/tracking
 * Update tracking status (Seller Only)
 */

const VALID_TRACKING_STATUSES = ['acknowledged', 'enroute', 'ready_for_pickup'];

router.put('/:orderId/tracking', authenticate, async (req, res) => {
    try {
        const { status } = req.body;
    if (!VALID_TRACKING_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid tracking status' });
    }
        //const { status } = req.body; // acknowledged, enroute, ready_for_pickup
        const { orderId } = req.params;

        const order = await getDocument('orders', orderId);
        if (!order || order.sellerId !== req.userId) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        await db.collection('orders').doc(orderId).update({
            trackingStatus: status,
            updatedAt: Date.now()
        });

        await client.del(`order:${orderId}`);
        
        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Update failed' });
    }
});

/**
 * GET /api/v1/orders/seller/stats
 * Get seller-specific performance metrics and revenue analytics
 */
router.get('/seller/stats', authenticate, async (req, res) => {
    try {
        const sellerId = req.userId;
        const { period = 'week' } = req.query; // 'week' or 'month'

        // Define timeframe
        const now = Date.now();
        const startTime = period === 'month' 
            ? now - (30 * 24 * 60 * 60 * 1000) 
            : now - (7 * 24 * 60 * 60 * 1000);

        // Fetch completed orders for this seller in the timeframe
        const snapshot = await db.collection('orders')
            .where('sellerId', '==', sellerId)
            .where('status', '==', 'delivered')
            .where('updatedAt', '>=', startTime)
            .get();

        const orders = snapshot.docs.map(doc => doc.data());

        // Calculate Stats
        const totalOrders = orders.length;
        const grossRevenue = orders.reduce((sum, o) => sum + o.totalAmount, 0);
        const platformFees = orders.reduce((sum, o) => sum + (o.commission || 0), 0);
        const netEarnings = grossRevenue - platformFees;

        // Group revenue by day for a chart
        const revenueByDay = {};
        orders.forEach(o => {
            const date = new Date(o.updatedAt).toISOString().split('T')[0];
            revenueByDay[date] = (revenueByDay[date] || 0) + (o.totalAmount - (o.commission || 0));
        });

        res.json({
            success: true,
            stats: {
                period,
                totalOrders,
                grossRevenue,
                platformFees,
                netEarnings,
                averageOrderValue: totalOrders > 0 ? Math.round(grossRevenue / totalOrders) : 0,
                revenueByDay
            }
        });
    } catch (error) {
        console.error('Seller stats error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
    }
});

/**
 * GET /api/v1/orders/admin/automation-stats
 * View stats on auto-cancellations and system health
 */
router.get('/admin/automation-stats', authenticate, adminOnly, async (req, res) => {
    try {
        // 1. Get total auto-cancelled orders
        const cancelledSnapshot = await db.collection('orders')
            .where('autoCancelled', '==', true)
            .orderBy('updatedAt', 'desc')
            .limit(20)
            .get();

        const recentCancellations = cancelledSnapshot.docs.map(doc => ({
            id: doc.id,
            sellerId: doc.data().sellerId,
            amount: doc.data().totalAmount,
            time: doc.data().updatedAt
        }));

        // 2. Get system heartbeat status from Redis
        const lastHeartbeat = await client.get('system:keepalive');

        res.json({
            success: true,
            data: {
                totalAutoCancelledCount: cancelledSnapshot.size,
                lastSystemPulse: lastHeartbeat,
                recentCancellations,
                status: lastHeartbeat ? "Automation Active" : "Automation Pending"
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/v1/orders
 * Get user's orders with Redis caching
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const { status, role } = req.query;
        const userId = req.userId;

        // FIX: Try cache first
        const cacheKey = `orders:${userId}:${role || 'all'}:${status || 'all'}`;
        const cached = await client.get(cacheKey);
        
        if (cached) {
            return res.json({
                success: true,
                orders: JSON.parse(cached),
                cached: true
            });
        }

        let query = db.collection('orders');

        // Filter by buyer or seller
        if (role === 'buyer') {
            query = query.where('buyerId', '==', userId);
        } else if (role === 'seller') {
            query = query.where('sellerId', '==', userId);
        } else {
            // Get both
            const [buyerOrders, sellerOrders] = await Promise.all([
                db.collection('orders').where('buyerId', '==', userId).get(),
                db.collection('orders').where('sellerId', '==', userId).get()
            ]);

            let orders = [
                ...buyerOrders.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                ...sellerOrders.docs.map(doc => ({ id: doc.id, ...doc.data() }))
            ];

            // Remove duplicates
            orders = orders.filter((order, index, self) =>
                index === self.findIndex(o => o.id === order.id)
            );

            // Filter by status if provided
            if (status) {
                orders = orders.filter(o => o.status === status);
            }

            orders.sort((a, b) => b.createdAt - a.createdAt);

            // Cache for 1 minute
            await client.setEx(cacheKey, 60, JSON.stringify(orders));

            return res.json({
                success: true,
                orders
            });
        }

        // Filter by status
        if (status) {
            query = query.where('status', '==', status);
        }

        const snapshot = await query.orderBy('createdAt', 'desc').get();
        const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Cache for 1 minute
        await client.setEx(cacheKey, 60, JSON.stringify(orders));

        res.json({
            success: true,
            orders
        });
    } catch (error) {
        console.error('Get orders error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch orders'
        });
    }
});

/**
 * GET /api/v1/orders/:orderId
 * Get single order with caching
 */
router.get('/:orderId', authenticate, async (req, res) => {
    try {
        // Try cache first
        const cacheKey = `order:${req.params.orderId}`;
        const cached = await client.get(cacheKey);
        
        if (cached) {
            const order = JSON.parse(cached);
            
            // Verify access
            if (order.buyerId !== req.userId && order.sellerId !== req.userId && req.userProfile?.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied'
                });
            }
            
            return res.json({
                success: true,
                order,
                cached: true
            });
        }

        const order = await getDocument('orders', req.params.orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        // Check access
        if (order.buyerId !== req.userId && order.sellerId !== req.userId && req.userProfile?.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        // Cache for 5 minutes
        await client.setEx(cacheKey, 300, JSON.stringify(order));

        res.json({
            success: true,
            order
        });
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch order'
        });
    }
});

/**
 * FIX: POST /api/v1/orders - Create order with proper escrow
 */
router.post('/', authenticate, async (req, res) => {
    try {
        const { products, deliveryAddress, phoneNumber, discount = 0 } = req.body;
        const buyerId = req.userId;

        // Validation
        if (!products || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Products are required'
            });
        }

        if (!deliveryAddress) {
            return res.status(400).json({
                success: false,
                message: 'Delivery address is required'
            });
        }

        // Get first product to determine seller
        const firstProduct = await getDocument('products', products[0].productId);
        if (!firstProduct) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        const sellerId = firstProduct.sellerId;

        // FIX: Verify all products and calculate total in one pass
        let subtotal = 0;
        const orderProducts = [];
        const productDocs = [];

        for (const item of products) {
            const product = await getDocument('products', item.productId);
            if (!product) {
                return res.status(404).json({
                    success: false,
                    message: `Product ${item.productId} not found`
                });
            }
            if (product.sellerId !== sellerId) {
                return res.status(400).json({
                    success: false,
                    message: 'All products must be from the same seller'
                });
            }
            if (product.stock < item.quantity) {
                return res.status(400).json({
                    success: false,
                    message: `Insufficient stock for ${product.name}`
                });
            }

            const price = product.discount 
                ? product.price * (1 - product.discount / 100) 
                : product.price;
            
            subtotal += price * item.quantity;
            
            orderProducts.push({
                productId: item.productId,
                productName: product.name,
                quantity: item.quantity,
                price,
                selectedColor: item.selectedColor || null,
                warranty: item.warranty || 'none',
                prescriptionUrl: item.prescriptionUrl || null,
                prescriptionFileName: item.prescriptionFileName || null
            });

            productDocs.push({ ref: product, newStock: product.stock - item.quantity });
        }

        const totalAmount = Math.round(subtotal - discount);
        const commission = Math.round(totalAmount * 0.10);

        // FIX: Check wallet balance BEFORE creating order
        const buyerBalance = await walletService.getBalance(buyerId);
        
        if (buyerBalance < totalAmount) {
            return res.status(400).json({
                success: false,
                message: 'Insufficient wallet balance',
                required: totalAmount,
                available: buyerBalance
            });
        }

        // FIX: Create idempotency key to prevent duplicate orders
        const idempotencyKey = `order:create:${buyerId}:${Date.now()}`;
        const lockKey = `order:lock:${idempotencyKey}`;

        // Check if already processing
        const isLocked = await client.get(lockKey);
        if (isLocked) {
            return res.status(409).json({
                success: false,
                message: 'Order creation already in progress'
            });
        }

        // Set lock for 30 seconds
        await client.setEx(lockKey, 30, 'true');

        let orderId;

        try {
            // FIX: Atomic transaction - create order + update stock + process payment
            await db.runTransaction(async (transaction) => {
                const orderRef = db.collection('orders').doc();
                orderId = orderRef.id;

                const orderData = {
                    id: orderId,
                    buyerId,
                    sellerId,
                    products: orderProducts,
                    totalAmount,
                    commission,
                    status: 'running',
                    deliveryAddress,
                    phoneNumber: phoneNumber || null,
                    disputeStatus: 'none',
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };

                transaction.set(orderRef, orderData);

                // Update product stocks
                for (const { ref, newStock } of productDocs) {
                    const productRef = db.collection('products').doc(ref.id);

                    if (newStock <= 0) {
                        transaction.delete(productRef);
                    } else {
                        transaction.update(productRef, { stock: newStock });
                    }
                }
            });

            // FIX: Process payment AFTER order is created (separate for better error handling)
            await walletService.processOrderPayment(
                buyerId,
                sellerId,
                orderId,
                totalAmount,
                commission
            );

            // Remove lock
            await client.del(lockKey);

            // FIX: Invalidate relevant caches
            await Promise.all([
                client.del(`orders:${buyerId}:all:all`),
                client.del(`orders:${sellerId}:all:all`),
            ]);

            res.status(201).json({
                success: true,
                message: 'Order created successfully',
                orderId,
                totalAmount
            });

        } catch (error) {
            // Remove lock on error
            await client.del(lockKey);
            throw error;
        }

    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create order'
        });
    }
});

/**
 * FIX: PUT /api/v1/orders/:orderId/confirm-delivery
 * Buyer confirms delivery with proper escrow release
 */
router.put('/:orderId/confirm-delivery', authenticate, async (req, res) => {
    try {
        const order = await getDocument('orders', req.params.orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        if (order.buyerId !== req.userId) {
            return res.status(403).json({
                success: false,
                message: 'Only the buyer can confirm delivery'
            });
        }

        if (order.status !== 'running') {
            return res.status(400).json({
                success: false,
                message: 'Order is not in running state'
            });
        }

        // FIX: Idempotency check
        const lockKey = `order:confirm:${req.params.orderId}`;
        const isLocked = await client.get(lockKey);
        
        if (isLocked) {
            return res.status(409).json({
                success: false,
                message: 'Confirmation already in progress'
            });
        }

        // Set lock
        await client.setEx(lockKey, 30, 'true');

        try {
            // Update order status
            await db.collection('orders').doc(req.params.orderId).update({
                status: 'delivered',
                buyerConfirmed: true,
                updatedAt: Date.now()
            });

            // FIX: Release escrow
            await walletService.releaseEscrow(
                req.params.orderId,
                order.buyerId,
                order.sellerId,
                order.totalAmount,
                order.commission
            );

            // Remove lock
            await client.del(lockKey);

            // Invalidate caches
            await Promise.all([
                client.del(`order:${req.params.orderId}`),
                client.del(`orders:${order.buyerId}:all:all`),
                client.del(`orders:${order.sellerId}:all:all`),
            ]);

            res.json({
                success: true,
                message: 'Delivery confirmed successfully'
            });

        } catch (error) {
            await client.del(lockKey);
            throw error;
        }

    } catch (error) {
        console.error('Confirm delivery error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to confirm delivery'
        });
    }
});

/**
 * FIX: PUT /api/v1/orders/:orderId/cancel
 * Cancel order with proper refund
 */
router.put('/:orderId/cancel', authenticate, async (req, res) => {
    try {
        const { reason } = req.body;
        
        // ✅ Get FRESH order data
        const order = await getDocument('orders', req.params.orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        // ✅ Log current order state for debugging
        console.log('📦 Cancel request for order:', {
            orderId: order.id,
            currentStatus: order.status,
            trackingStatus: order.trackingStatus,
            requestedBy: req.userId,
            isBuyer: order.buyerId === req.userId,
            isSeller: order.sellerId === req.userId
        });

        // Check permissions
        const isBuyer = order.buyerId === req.userId;
        const isSeller = order.sellerId === req.userId;

        if (!isBuyer && !isSeller) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        // ✅ FIX: More specific status checking with better error messages
        if (order.status === 'cancelled') {
            return res.status(400).json({
                success: false,
                message: 'Order is already cancelled',
                currentStatus: order.status
            });
        }

        if (order.status === 'delivered') {
            return res.status(400).json({
                success: false,
                message: 'Cannot cancel delivered orders',
                currentStatus: order.status
            });
        }

        if (order.status !== 'running') {
            return res.status(400).json({
                success: false,
                message: `Only running orders can be cancelled. Current status: ${order.status}`,
                currentStatus: order.status
            });
        }

        // ✅ Buyer-specific rules
        if (isBuyer && order.trackingStatus) {
            return res.status(400).json({
                success: false,
                message: 'Cannot cancel order after seller has confirmed it. Please contact support if there is an issue.',
                currentStatus: order.status,
                trackingStatus: order.trackingStatus
            });
        }

        // ✅ Idempotency check
        const lockKey = `order:cancel:${req.params.orderId}`;
        const isLocked = await client.get(lockKey);
        
        if (isLocked) {
            return res.status(409).json({
                success: false,
                message: 'Cancellation already in progress. Please wait.'
            });
        }

        // Set lock for 30 seconds
        await client.setEx(lockKey, 30, 'true');

        try {
            // ✅ Update order status
            await db.collection('orders').doc(req.params.orderId).update({
                status: 'cancelled',
                cancelReason: reason || 'No reason provided',
                sellerCancelled: isSeller,
                cancelledBy: req.userId,
                cancelledAt: Date.now(),
                updatedAt: Date.now()
            });

            console.log('✅ Order status updated to cancelled');

            // ✅ Refund escrow
            await walletService.refundEscrow(
                req.params.orderId,
                order.buyerId,
                order.sellerId,
                order.totalAmount,
                order.commission,
                reason || 'Order cancelled'
            );

            console.log('✅ Escrow refunded successfully');

            // Remove lock
            await client.del(lockKey);

            // ✅ Invalidate caches
            await Promise.all([
                client.del(`order:${req.params.orderId}`),
                client.del(`orders:${order.buyerId}:all:all`),
                client.del(`orders:${order.sellerId}:all:all`),
            ]);

            console.log('✅ Caches invalidated');

            res.json({
                success: true,
                message: 'Order cancelled and refund processed successfully'
            });

        } catch (error) {
            // Remove lock on error
            await client.del(lockKey);
            throw error;
        }

    } catch (error) {
        console.error('❌ Cancel order error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to cancel order'
        });
    }
});

module.exports = router;