const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { db, runTransaction, getDocument } = require('../config/firebase');
const walletService = require('../services/wallet.service');

/**
 * ORDER ROUTES
 * Order creation and management
 */

/**
 * GET /api/v1/orders
 * Get user's orders
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const { status, role } = req.query;
        const userId = req.userId;

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
 * Get single order
 */
router.get('/:orderId', authenticate, async (req, res) => {
    try {
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
 * POST /api/v1/orders
 * Create new order
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

        // Verify all products belong to same seller
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
        }

        // Calculate total
        let subtotal = 0;
        const orderProducts = [];

        for (const item of products) {
            const product = await getDocument('products', item.productId);
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
        }

        const totalAmount = Math.round(subtotal - discount);
        const commission = Math.round(totalAmount * 0.10); // 10% commission

        // Check wallet balance
        const wallet = await walletService.getWallet(buyerId);
        if (wallet.balance < totalAmount) {
            return res.status(400).json({
                success: false,
                message: 'Insufficient wallet balance',
                required: totalAmount,
                available: wallet.balance
            });
        }

        // Create order with atomic transaction
        let orderId;
        await runTransaction(async (transaction) => {
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
            for (const item of products) {
                const productRef = db.collection('products').doc(item.productId);
                const productDoc = await transaction.get(productRef);
                const newStock = productDoc.data().stock - item.quantity;

                if (newStock <= 0) {
                    transaction.delete(productRef);
                } else {
                    transaction.update(productRef, { stock: newStock });
                }
            }
        });

        // Process payment (escrow)
        await walletService.transferToEscrow(
            buyerId,
            sellerId,
            orderId,
            totalAmount,
            commission
        );

        res.status(201).json({
            success: true,
            message: 'Order created successfully',
            orderId,
            totalAmount
        });
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create order'
        });
    }
});

/**
 * PUT /api/v1/orders/:orderId/confirm-delivery
 * Buyer confirms delivery
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

        // Update order status
        await db.collection('orders').doc(req.params.orderId).update({
            status: 'delivered',
            buyerConfirmed: true,
            updatedAt: Date.now()
        });

        // Release escrow
        await walletService.releaseEscrow(
            req.params.orderId,
            order.buyerId,
            order.sellerId,
            order.totalAmount,
            order.commission
        );

        res.json({
            success: true,
            message: 'Delivery confirmed successfully'
        });
    } catch (error) {
        console.error('Confirm delivery error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to confirm delivery'
        });
    }
});

/**
 * PUT /api/v1/orders/:orderId/cancel
 * Cancel order
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

        // Update order
        await db.collection('orders').doc(req.params.orderId).update({
            status: 'cancelled',
            cancelReason: reason || 'No reason provided',
            sellerCancelled: isSeller,
            updatedAt: Date.now()
        });

        // Refund escrow
        await walletService.refundEscrow(
            req.params.orderId,
            order.buyerId,
            order.sellerId,
            order.totalAmount,
            order.commission,
            reason
        );

        res.json({
            success: true,
            message: 'Order cancelled successfully'
        });
    } catch (error) {
        console.error('Cancel order error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel order'
        });
    }
});

module.exports = router;