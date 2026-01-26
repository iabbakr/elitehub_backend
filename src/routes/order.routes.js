const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { db, runTransaction, getDocument } = require('../config/firebase');
const walletService = require('../services/wallet.service');
const firebaseService = require('../services/firebase.service');
const { client, CACHE_KEYS } = require('../config/redis');

/**
 * PRODUCTION-GRADE ORDER SYSTEM
 * Features: Escrow Flow, Strike-System, Redis Idempotency, and Push Alerts.
 */

const VALID_TRACKING_STATUSES = ['acknowledged', 'enroute', 'ready_for_pickup'];

// ==========================================
// 1. PUBLIC/USER ROUTES
// ==========================================

/**
 * GET /api/v1/orders
 * Get user's orders with multi-role support and Redis caching
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const { status, role } = req.query;
        const userId = req.userId;

        const cacheKey = `orders:${userId}:${role || 'all'}:${status || 'all'}`;
        const cached = await client.get(cacheKey);
        
        if (cached) return res.json({ success: true, orders: JSON.parse(cached), cached: true });

        let query = db.collection('orders');

        if (role === 'buyer') {
            query = query.where('buyerId', '==', userId);
        } else if (role === 'seller') {
            query = query.where('sellerId', '==', userId);
        } else {
            const [buyerSnap, sellerSnap] = await Promise.all([
                db.collection('orders').where('buyerId', '==', userId).get(),
                db.collection('orders').where('sellerId', '==', userId).get()
            ]);

            let orders = [
                ...buyerSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
                ...sellerSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
            ];

            orders = orders.filter((o, i, self) => i === self.findIndex(t => t.id === o.id));
            if (status) orders = orders.filter(o => o.status === status);
            orders.sort((a, b) => b.createdAt - a.createdAt);

            await client.setEx(cacheKey, 60, JSON.stringify(orders));
            return res.json({ success: true, orders });
        }

        if (status) query = query.where('status', '==', status);

        const snapshot = await query.orderBy('createdAt', 'desc').get();
        const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        await client.setEx(cacheKey, 60, JSON.stringify(orders));
        res.json({ success: true, orders });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch orders' });
    }
});

/**
 * POST /api/v1/orders
 * Create order with Escrow & Suspension Check
 */
router.post('/', authenticate, async (req, res) => {
    try {
        const { products, deliveryAddress, phoneNumber, discount = 0 } = req.body;
        const buyerId = req.userId;

        if (!products?.length || !deliveryAddress) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const firstProduct = await getDocument('products', products[0].productId);
        if (!firstProduct) return res.status(404).json({ success: false, message: 'Product not found' });

        const sellerId = firstProduct.sellerId;

        // ✅ FLOT: Guard against suspended sellers
        const sellerDoc = await getDocument('users', sellerId);
        if (sellerDoc?.isSuspended) {
            return res.status(403).json({ success: false, message: 'This shop is currently inactive.' });
        }

        let subtotal = 0;
        const orderProducts = [];
        const productUpdates = [];

        for (const item of products) {
            const product = await getDocument('products', item.productId);
            if (!product || product.sellerId !== sellerId) {
                return res.status(400).json({ success: false, message: 'Invalid product selection' });
            }
            if (product.stock < item.quantity) {
                return res.status(400).json({ success: false, message: `Insufficient stock for ${product.name}` });
            }

            const price = product.discount ? product.price * (1 - product.discount / 100) : product.price;
            subtotal += price * item.quantity;
            
            orderProducts.push({ ...item, productName: product.name, price });
            productUpdates.push({ ref: db.collection('products').doc(product.id), newStock: product.stock - item.quantity });
        }

        const totalAmount = Math.round(subtotal - discount);
        const commission = Math.round(totalAmount * 0.10);

        const buyerBalance = await walletService.getBalance(buyerId);
        if (buyerBalance < totalAmount) return res.status(400).json({ success: false, message: 'Insufficient balance' });

        const lockKey = `order:lock:${buyerId}:${Date.now()}`;
        if (await client.get(lockKey)) return res.status(409).json({ success: false, message: 'Processing...' });
        await client.setEx(lockKey, 30, 'true');

        let orderId;
        await db.runTransaction(async (transaction) => {
            const orderRef = db.collection('orders').doc();
            orderId = orderRef.id;

            transaction.set(orderRef, {
                id: orderId, buyerId, sellerId, products: orderProducts,
                totalAmount, commission, status: 'running', deliveryAddress,
                phoneNumber, createdAt: Date.now(), updatedAt: Date.now()
            });

            for (const update of productUpdates) {
                update.newStock <= 0 ? transaction.delete(update.ref) : transaction.update(update.ref, { stock: update.newStock });
            }
        });

        await walletService.processOrderPayment(buyerId, sellerId, orderId, totalAmount, commission);
        
        // 🔔 Alert Seller
        await firebaseService.sendPushToUser(sellerId, "New Order Received!", `Order #${orderId.slice(-6).toUpperCase()} is ready.`);

        await Promise.all([client.del(`orders:${buyerId}:all:all`), client.del(`orders:${sellerId}:all:all`)]);
        res.status(201).json({ success: true, orderId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * PUT /api/v1/orders/:orderId/confirm-delivery
 * Buyer confirms receipt -> Escrow Release
 */
router.put('/:orderId/confirm-delivery', authenticate, async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const order = await getDocument('orders', orderId);

        if (!order || order.buyerId !== req.userId || order.status !== 'running') {
            return res.status(400).json({ success: false, message: 'Action not allowed' });
        }

        const lockKey = `order:confirm:${orderId}`;
        if (await client.get(lockKey)) return res.status(409).json({ success: false, message: 'Processing...' });
        await client.setEx(lockKey, 30, 'true');

        await db.collection('orders').doc(orderId).update({ status: 'delivered', buyerConfirmed: true, updatedAt: Date.now() });
        await walletService.releaseEscrow(orderId, order.buyerId, order.sellerId, order.totalAmount, order.commission);

        // 🔔 Alert Seller
        await firebaseService.sendPushToUser(order.sellerId, "💸 Funds Released", `Payment for #${orderId.slice(-6).toUpperCase()} is now in your balance.`);

        await Promise.all([client.del(`order:${orderId}`), client.del(`orders:${order.buyerId}:all:all`), client.del(`orders:${order.sellerId}:all:all`)]);
        res.json({ success: true, message: 'Payment released' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Confirmation failed' });
    }
});

/**
 * PUT /api/v1/orders/:orderId/tracking
 * Seller updates tracking (Seller Only)
 */
router.put('/:orderId/tracking', authenticate, async (req, res) => {
    try {
        const { status } = req.body;
        const { orderId } = req.params;

        if (!VALID_TRACKING_STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

        const order = await getDocument('orders', orderId);
        if (!order || order.sellerId !== req.userId) return res.status(403).json({ success: false, message: 'Unauthorized' });

        await db.collection('orders').doc(orderId).update({ trackingStatus: status, updatedAt: Date.now() });

        const buyerOrders = await db.collection('orders')
        .where('buyerId', '==', order.buyerId)
        .where('trackingStatus', '==', 'ready_for_pickup')
        .get();

    await firebaseService.sendPushToUser(
        order.buyerId, 
        "📦 Order Update", 
        `Your order status: ${status.replace('_', ' ')}`, 
        { 
            screen: "OrderDetailScreen", 
            params: { orderId },
            badge: buyerOrders.size // This sets the app icon badge
        }
    );
        await client.del(`order:${orderId}`);
        res.json({ success: true, message: `Updated to ${status}` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Update failed' });
    }
});

// ==========================================
// 2. REVIEWS & ANALYTICS
// ==========================================

router.post('/:orderId/review', authenticate, async (req, res) => {
    try {
        const { rating, comment } = req.body;
        const { orderId } = req.params;
        const userId = req.userId;

        if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Invalid rating' });

        const order = await getDocument('orders', orderId);
        if (!order || order.buyerId !== userId || order.status !== 'delivered' || order.hasReview) {
            return res.status(400).json({ success: false, message: 'Review not allowed' });
        }

        await db.runTransaction(async (transaction) => {
            const reviewRef = db.collection('reviews').doc();
            const sellerRef = db.collection('users').doc(order.sellerId);

            transaction.set(reviewRef, {
                id: reviewRef.id, orderId, buyerId: userId, sellerId: order.sellerId,
                rating, comment: comment || '', createdAt: Date.now()
            });

            transaction.update(db.collection('orders').doc(orderId), { hasReview: true, updatedAt: Date.now() });

            const sellerDoc = await transaction.get(sellerRef);
            const sellerData = sellerDoc.data() || {};
            const newTotal = (sellerData.totalReviews || 0) + 1;
            const newAvg = sellerData.rating ? ((sellerData.rating * (newTotal - 1)) + rating) / newTotal : rating;

            transaction.update(sellerRef, { rating: Number(newAvg.toFixed(1)), totalReviews: newTotal });
        });

        await Promise.all([client.del(`order:${orderId}`), client.del(`seller_profile:${order.sellerId}`)]);
        res.status(201).json({ success: true, message: 'Review saved' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to submit review' });
    }
});

router.get('/seller/stats', authenticate, async (req, res) => {
    try {
        const sellerId = req.userId;
        const { period = 'week' } = req.query;
        const startTime = period === 'month' ? Date.now() - 2592000000 : Date.now() - 604800000;

        const snapshot = await db.collection('orders').where('sellerId', '==', sellerId).where('status', '==', 'delivered').where('updatedAt', '>=', startTime).get();

        const orders = snapshot.docs.map(doc => doc.data());
        const revenueByDay = {};
        orders.forEach(o => {
            const d = new Date(o.updatedAt).toISOString().split('T')[0];
            revenueByDay[d] = (revenueByDay[d] || 0) + (o.totalAmount - o.commission);
        });

        res.json({
            success: true,
            stats: { totalOrders: orders.length, netEarnings: orders.reduce((s, o) => s + (o.totalAmount - o.commission), 0), revenueByDay }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Analytics failed' });
    }
});

// ==========================================
// 3. ADMIN & AUTOMATION
// ==========================================

router.get('/admin/automation-stats', authenticate, adminOnly, async (req, res) => {
    try {
        const cancelledSnapshot = await db.collection('orders').where('autoCancelled', '==', true).orderBy('updatedAt', 'desc').limit(20).get();
        const lastHeartbeat = await client.get('system:keepalive');

        res.json({
            success: true,
            data: {
                totalAutoCancelledCount: cancelledSnapshot.size,
                lastSystemPulse: lastHeartbeat,
                status: lastHeartbeat ? "Active" : "Inactive"
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/admin/flagged-sellers', authenticate, adminOnly, async (req, res) => {
    try {
        const snapshot = await db.collection('users').where('autoCancelStrikes', '>', 0).get();
        const sellers = snapshot.docs.map(doc => ({ uid: doc.id, name: doc.data().name, strikes: doc.data().autoCancelStrikes, isSuspended: doc.data().isSuspended || false }));
        res.json({ success: true, sellers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/admin/pardon-seller/:userId', authenticate, adminOnly, async (req, res) => {
    try {
        const { userId } = req.params;
        await db.collection('users').doc(userId).update({ autoCancelStrikes: 0, isSuspended: false, suspensionReason: null, updatedAt: Date.now() });
        await client.del(`user:${userId}:profile`);
        await firebaseService.sendPushToUser(userId, "Shop Reinstated", "Your account is healthy again.");
        res.json({ success: true, message: "Seller pardoned" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Action failed" });
    }
});

// GET /api/v1/orders/:orderId (Final implementation)
router.get('/:orderId', authenticate, async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const cacheKey = `order:${orderId}`;
        const cached = await client.get(cacheKey);
        
        if (cached) {
            const order = JSON.parse(cached);
            if (order.buyerId !== req.userId && order.sellerId !== req.userId) return res.status(403).json({ success: false });
            return res.json({ success: true, order });
        }

        const order = await getDocument('orders', orderId);
        if (!order || (order.buyerId !== req.userId && order.sellerId !== req.userId)) return res.status(403).json({ success: false });

        await client.setEx(cacheKey, 300, JSON.stringify(order));
        res.json({ success: true, order });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});


// POST /api/v1/orders/admin/system/maintenance
router.post('/admin/system/maintenance', authenticate, adminOnly, async (req, res) => {
    const { enabled } = req.body;
    
    // Update Redis
    await client.set('system:maintenance_mode', enabled ? 'true' : 'false');
    
    // Log the event in System Alerts
    await firebaseService.broadcastAdminAlert(
        "MAINTENANCE_TOGGLED",
        `Platform maintenance was ${enabled ? 'ENABLED' : 'DISABLED'} by Admin.`,
        enabled ? 'high' : 'info'
    );

    res.json({ success: true, enabled });
});
module.exports = router;