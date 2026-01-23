const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { db, runTransaction, getDocument } = require('../config/firebase');
const walletService = require('../services/wallet.service');
const { client, CACHE_KEYS } = require('../config/redis');

/**
 * FIX: OPTIMIZED ORDER ROUTES WITH PROPER ESCROW FLOW
 */

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
        const order = await getDocument('orders', req.params.orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        // Check permissions
        const isBuyer = order.buyerId === req.userId;
        const isSeller = order.sellerId === req.userId;

        if (!isBuyer && !isSeller) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        if (order.status !== 'running') {
            return res.status(400).json({
                success: false,
                message: 'Only running orders can be cancelled'
            });
        }

        // Buyer can't cancel after tracking started
        if (isBuyer && order.trackingStatus) {
            return res.status(400).json({
                success: false,
                message: 'Cannot cancel order after tracking has started'
            });
        }

        // FIX: Idempotency check
        const lockKey = `order:cancel:${req.params.orderId}`;
        const isLocked = await client.get(lockKey);
        
        if (isLocked) {
            return res.status(409).json({
                success: false,
                message: 'Cancellation already in progress'
            });
        }

        await client.setEx(lockKey, 30, 'true');

        try {
            // Update order
            await db.collection('orders').doc(req.params.orderId).update({
                status: 'cancelled',
                cancelReason: reason || 'No reason provided',
                sellerCancelled: isSeller,
                updatedAt: Date.now()
            });

            // FIX: Refund escrow
            await walletService.refundEscrow(
                req.params.orderId,
                order.buyerId,
                order.sellerId,
                order.totalAmount,
                order.commission,
                reason
            );

            await client.del(lockKey);

            // Invalidate caches
            await Promise.all([
                client.del(`order:${req.params.orderId}`),
                client.del(`orders:${order.buyerId}:all:all`),
                client.del(`orders:${order.sellerId}:all:all`),
            ]);

            res.json({
                success: true,
                message: 'Order cancelled successfully'
            });

        } catch (error) {
            await client.del(lockKey);
            throw error;
        }

    } catch (error) {
        console.error('Cancel order error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel order'
        });
    }
});

module.exports = router;