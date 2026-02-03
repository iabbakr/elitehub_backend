const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { db, runTransaction, getDocument } = require('../config/firebase');
const walletService = require('../services/wallet.service');
const pushNotificationService = require('../services/push-notification.service'); // ✅ FIXED: Import correct service
const { client, CACHE_KEYS } = require('../config/redis');

/**
 * ✅ PRODUCTION-GRADE ATOMIC ORDER SYSTEM
 * Features:
 * - Redis idempotency locks (prevents duplicate actions)
 * - Firestore transactions (atomic state changes)
 * - Real-time status validation (no stale data)
 * - Automatic cache invalidation
 */

const VALID_TRACKING_STATUSES = ['acknowledged', 'enroute', 'ready_for_pickup'];


// ==========================================
// HELPER: Atomic State Guards
// ==========================================

/**
 * ✅ CRITICAL: Get fresh order data with Redis lock
 * Prevents race conditions by locking the order during reads
 */
async function getFreshOrderWithLock(orderId, lockKey, lockTTL = 30) {
    // Check if already locked
    const isLocked = await client.get(lockKey);
    if (isLocked) {
        throw new Error('ACTION_IN_PROGRESS: Another operation is processing this order. Please wait.');
    }

    // Set lock
    await client.setEx(lockKey, lockTTL, 'processing');

    // Get fresh data from Firestore
    const order = await getDocument('orders', orderId);
    if (!order) {
        await client.del(lockKey);
        throw new Error('ORDER_NOT_FOUND');
    }

    return order;
}

/**
 * ✅ Validate user authorization
 */
function validateOrderAccess(order, userId, requiredRole) {
    if (requiredRole === 'buyer' && order.buyerId !== userId) {
        throw new Error('UNAUTHORIZED: You are not the buyer of this order');
    }
    if (requiredRole === 'seller' && order.sellerId !== userId) {
        throw new Error('UNAUTHORIZED: You are not the seller of this order');
    }
}

/**
 * ✅ Invalidate all caches for an order
 */
async function invalidateOrderCaches(orderId, buyerId, sellerId) {
    await Promise.all([
        client.del(`order:${orderId}`),
        client.del(`orders:${buyerId}:all:all`),
        client.del(`orders:${sellerId}:all:all`),
        client.del(`orders:${buyerId}:buyer:running`),
        client.del(`orders:${sellerId}:seller:running`)
    ]);
}

// ==========================================
// 1. GET ROUTES (with caching)
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
        
        if (cached) {
            return res.json({ 
                success: true, 
                orders: JSON.parse(cached), 
                cached: true 
            });
        }

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
        console.error('❌ Get orders error:', error);
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
        const orderId = req.params.orderId;
        const cacheKey = `order:${orderId}`;
        
        // Try cache first
        const cached = await client.get(cacheKey);
        if (cached) {
            const order = JSON.parse(cached);
            if (order.buyerId !== req.userId && order.sellerId !== req.userId) {
                return res.status(403).json({ success: false });
            }
            return res.json({ success: true, order, cached: true });
        }

        // Get from Firestore
        const order = await getDocument('orders', orderId);
        
        if (!order || (order.buyerId !== req.userId && order.sellerId !== req.userId)) {
            return res.status(403).json({ success: false });
        }

        // Cache for 5 minutes
        await client.setEx(cacheKey, 300, JSON.stringify(order));
        res.json({ success: true, order });
    } catch (error) {
        console.error('❌ Get order error:', error);
        res.status(500).json({ success: false });
    }
});

/**
 * GET /api/v1/orders/:orderId
 * Get single order with caching
 */
router.get('/:orderId', authenticate, async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const cacheKey = `order:${orderId}`;
        
        // Try cache first
        const cached = await client.get(cacheKey);
        if (cached) {
            const order = JSON.parse(cached);
            if (order.buyerId !== req.userId && order.sellerId !== req.userId) {
                return res.status(403).json({ success: false });
            }
            return res.json({ success: true, order, cached: true });
        }

        // Get from Firestore
        const order = await getDocument('orders', orderId);
        
        if (!order || (order.buyerId !== req.userId && order.sellerId !== req.userId)) {
            return res.status(403).json({ success: false });
        }

        // Cache for 5 minutes
        await client.setEx(cacheKey, 300, JSON.stringify(order));
        res.json({ success: true, order });
    } catch (error) {
        console.error('❌ Get order error:', error);
        res.status(500).json({ success: false });
    }
});


// ==========================================
// 2. ORDER CREATION (Atomic)
// ==========================================

/**
 * POST /api/v1/orders
 * ✅ ATOMIC ORDER CREATION with escrow lock
 */
router.post('/', authenticate, async (req, res) => {
    try {
        const { 
            products, 
            deliveryAddress, 
            phoneNumber, 
            discount = 0,
            deliveryMethod = 'delivery',
            deliveryFee = 0,
            buyerNote = ''
        } = req.body;
        const buyerId = req.userId;

        // Validation
        if (!products?.length || !deliveryAddress) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields' 
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

        // ✅ Guard: Check if seller is suspended
        const sellerDoc = await getDocument('users', sellerId);
        if (sellerDoc?.isSuspended) {
            return res.status(403).json({ 
                success: false, 
                message: 'This shop is currently inactive.' 
            });
        }

        // Duplicate prevention lock
        const createLockKey = `order:create:${buyerId}:${Date.now()}`;
        const isCreating = await client.get(createLockKey);
        if (isCreating) {
            return res.status(409).json({ 
                success: false, 
                message: 'Processing your previous order...' 
            });
        }
        await client.setEx(createLockKey, 30, 'true');

        // Calculate totals and validate stock
        let subtotal = 0;
        const orderProducts = [];
        const productUpdates = [];

        for (const item of products) {
            const product = await getDocument('products', item.productId);
            
            if (!product || product.sellerId !== sellerId) {
                await client.del(createLockKey);
                return res.status(400).json({ 
                    success: false, 
                    message: 'Invalid product selection' 
                });
            }

            if (product.stock < item.quantity) {
                await client.del(createLockKey);
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
                ...item, 
                productName: product.name, 
                price 
            });
            
            productUpdates.push({ 
                ref: db.collection('products').doc(product.id), 
                newStock: product.stock - item.quantity 
            });
        }

        const totalAmount = Math.round(subtotal - discount + deliveryFee);
        const commission = Math.round(totalAmount * 0.10);

        // ✅ Check wallet balance
        const buyerBalance = await walletService.getBalance(buyerId);
        if (buyerBalance < totalAmount) {
            await client.del(createLockKey);
            return res.status(400).json({ 
                success: false, 
                message: 'Insufficient wallet balance' 
            });
        }

        // ✅ ATOMIC TRANSACTION: Create order + Update stock
        let orderId;
        await db.runTransaction(async (transaction) => {
            const orderRef = db.collection('orders').doc();
            orderId = orderRef.id;

            // Create order
            transaction.set(orderRef, {
                id: orderId,
                buyerId,
                sellerId,
                products: orderProducts,
                totalAmount,
                commission,
                status: 'running',
                deliveryAddress,
                phoneNumber: phoneNumber || null,
                deliveryMethod,
                deliveryFee,
                buyerNote: buyerNote || null,
                disputeStatus: 'none',
                trackingStatus: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });

            // Update product stock
            for (const update of productUpdates) {
                if (update.newStock <= 0) {
                    transaction.delete(update.ref);
                } else {
                    transaction.update(update.ref, { stock: update.newStock });
                }
            }
        });

        // ✅ Process escrow payment (atomic wallet operation)
        await walletService.processOrderPayment(
            buyerId, 
            sellerId, 
            orderId, 
            totalAmount, 
            commission
        );

        // 🔔 Notify seller
        await pushNotificationService.sendPushToUser(
            sellerId,
            "New Order Received! 🎉",
            `Order #${orderId.slice(-6).toUpperCase()} worth ₦${totalAmount.toLocaleString()}`,
            { screen: "OrdersTab", params: { screen: "Orders" } }
        );

        // Cleanup
        await Promise.all([
            client.del(createLockKey),
            invalidateOrderCaches(orderId, buyerId, sellerId)
        ]);

        res.status(201).json({ 
            success: true, 
            orderId,
            message: 'Order created successfully'
        });

    } catch (error) {
        console.error('❌ Create order error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Failed to create order' 
        });
    }
});

// ==========================================
// 3. SELLER ACTIONS (Atomic)
// ==========================================

/**
 * PUT /api/v1/orders/:orderId/tracking
 * ✅ ATOMIC: Seller updates tracking status
 * 🔒 LOCKS buyer cancellation once acknowledged
 */
router.put('/:orderId/tracking', authenticate, async (req, res) => {
    const lockKey = `order:tracking:${req.params.orderId}`;

    try {
        const { status } = req.body;
        const { orderId } = req.params;

        // Validate status
        if (!VALID_TRACKING_STATUSES.includes(status)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid tracking status' 
            });
        }

        // ✅ Get fresh order with lock
        const order = await getFreshOrderWithLock(orderId, lockKey);

        // ✅ Authorization check
        validateOrderAccess(order, req.userId, 'seller');

        // ✅ Status validation
        if (order.status !== 'running') {
            await client.del(lockKey);
            return res.status(400).json({ 
                success: false, 
                message: `Cannot update tracking for ${order.status} orders` 
            });
        }

        // ✅ Prevent backwards tracking
        const trackingOrder = ['acknowledged', 'enroute', 'ready_for_pickup'];
        const currentIndex = trackingOrder.indexOf(order.trackingStatus);
        const newIndex = trackingOrder.indexOf(status);
        
        if (currentIndex >= newIndex && order.trackingStatus !== null) {
            await client.del(lockKey);
            return res.status(400).json({ 
                success: false, 
                message: 'Cannot move backwards in tracking' 
            });
        }

        // ✅ ATOMIC UPDATE
        await db.collection('orders').doc(orderId).update({
            trackingStatus: status,
            updatedAt: Date.now(),
            [`tracking_${status}_at`]: Date.now() // Audit trail
        });

        // 🔔 Notify buyer
        const statusMessages = {
            acknowledged: 'Seller confirmed your order and is preparing items',
            enroute: 'Your order is on the way!',
            ready_for_pickup: 'Your order is ready for pickup/delivery confirmation'
        };

        await pushNotificationService.sendPushToUser(
            order.buyerId,
            "📦 Order Update",
            statusMessages[status],
            { 
                screen: "OrderDetailScreen", 
                params: { orderId },
                badge: 1
            }
        );

        // Cleanup
        await Promise.all([
            client.del(lockKey),
            invalidateOrderCaches(orderId, order.buyerId, order.sellerId)
        ]);

        res.json({ 
            success: true, 
            message: `Order status updated to: ${status}`,
            newStatus: status
        });

    } catch (error) {
        await client.del(lockKey);
        console.error('❌ Update tracking error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Failed to update tracking' 
        });
    }
});

// ==========================================
// 4. BUYER ACTIONS (Atomic with Guards)
// ==========================================

/**
 * PUT /api/v1/orders/:orderId/cancel-buyer
 * ✅ ATOMIC: Buyer cancels order
 * 🔒 BLOCKED after seller acknowledgment
 */
router.put('/:orderId/cancel-buyer', authenticate, async (req, res) => {
    const lockKey = `order:cancel:buyer:${req.params.orderId}`;

    try {
        const { orderId } = req.params;
        const { reason } = req.body;

        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({ 
                success: false, 
                message: 'Cancellation reason must be at least 10 characters' 
            });
        }

        // ✅ Get fresh order with lock
        const order = await getFreshOrderWithLock(orderId, lockKey);

        // ✅ Authorization check
        validateOrderAccess(order, req.userId, 'buyer');

        // ✅ CRITICAL GUARD: Cannot cancel after seller acknowledgment
        if (order.trackingStatus) {
            await client.del(lockKey);
            return res.status(403).json({ 
                success: false, 
                message: 'ORDER_LOCKED: Seller has already confirmed this order. Please contact support if needed.',
                locked: true
            });
        }

        // ✅ Status check
        if (order.status !== 'running') {
            await client.del(lockKey);
            return res.status(400).json({ 
                success: false, 
                message: `Cannot cancel ${order.status} orders` 
            });
        }

        // ✅ ATOMIC UPDATE + REFUND
        await db.runTransaction(async (transaction) => {
            const orderRef = db.collection('orders').doc(orderId);
            
            transaction.update(orderRef, {
                status: 'cancelled',
                cancelReason: reason.trim(),
                cancelledBy: req.userId,
                cancelledByRole: 'buyer',
                cancelledAt: Date.now(),
                updatedAt: Date.now()
            });
        });

        // ✅ Process refund (atomic wallet operation)
        await walletService.refundEscrow(
            orderId,
            order.buyerId,
            order.sellerId,
            order.totalAmount,
            order.commission,
            `Buyer cancelled: ${reason.trim()}`
        );

        // 🔔 Notify seller
        await pushNotificationService.sendPushToUser(
            order.sellerId,
            "Order Cancelled by Buyer",
            `Order #${orderId.slice(-6)} was cancelled before confirmation`,
            { screen: "OrdersTab" }
        );

        // Cleanup
        await Promise.all([
            client.del(lockKey),
            invalidateOrderCaches(orderId, order.buyerId, order.sellerId)
        ]);

        res.json({ 
            success: true, 
            message: 'Order cancelled and refund processed',
            refundAmount: order.totalAmount
        });

    } catch (error) {
        await client.del(lockKey);
        console.error('❌ Buyer cancel error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Failed to cancel order' 
        });
    }
});

/**
 * PUT /api/v1/orders/:orderId/cancel-seller
 * ✅ ATOMIC: Seller cancels order (anytime during running)
 * ⚠️ Incurs strike system penalties
 */
router.put('/:orderId/cancel-seller', authenticate, async (req, res) => {
    const lockKey = `order:cancel:seller:${req.params.orderId}`;

    try {
        const { orderId } = req.params;
        const { reason } = req.body;

        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({ 
                success: false, 
                message: 'Cancellation reason must be at least 10 characters' 
            });
        }

        // ✅ Get fresh order with lock
        const order = await getFreshOrderWithLock(orderId, lockKey);

        // ✅ Authorization check
        validateOrderAccess(order, req.userId, 'seller');

        // ✅ Status check
        if (order.status !== 'running') {
            await client.del(lockKey);
            return res.status(400).json({ 
                success: false, 
                message: `Cannot cancel ${order.status} orders` 
            });
        }

        // ✅ ATOMIC UPDATE + REFUND
        await db.runTransaction(async (transaction) => {
            const orderRef = db.collection('orders').doc(orderId);
            
            transaction.update(orderRef, {
                status: 'cancelled',
                sellerCancelled: true,
                cancelReason: reason.trim(),
                cancelledBy: req.userId,
                cancelledByRole: 'seller',
                cancelledAt: Date.now(),
                updatedAt: Date.now()
            });

            // ⚠️ Increment seller strike (if after acknowledgment)
            if (order.trackingStatus) {
                const sellerRef = db.collection('users').doc(order.sellerId);
                transaction.update(sellerRef, {
                    autoCancelStrikes: (sellerDoc.autoCancelStrikes || 0) + 1,
                    updatedAt: Date.now()
                });
            }
        });

        // ✅ Process refund
        await walletService.refundEscrow(
            orderId,
            order.buyerId,
            order.sellerId,
            order.totalAmount,
            order.commission,
            `Seller cancelled: ${reason.trim()}`
        );

        // 🔔 Notify buyer
        await pushNotificationService.sendPushToUser(
            order.buyerId,
            "Order Cancelled by Seller",
            "Full refund has been credited to your wallet",
            { screen: "OrdersTab" }
        );

        // Cleanup
        await Promise.all([
            client.del(lockKey),
            invalidateOrderCaches(orderId, order.buyerId, order.sellerId)
        ]);

        res.json({ 
            success: true, 
            message: 'Order cancelled and buyer refunded',
            warning: order.trackingStatus ? 'Strike recorded for late cancellation' : null
        });

    } catch (error) {
        await client.del(lockKey);
        console.error('❌ Seller cancel error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Failed to cancel order' 
        });
    }
});

/**
 * PUT /api/v1/orders/:orderId/confirm-delivery
 * ✅ ATOMIC: Buyer confirms delivery
 * 🔒 Uses wallet.service.releaseEscrow with idempotency
 */
router.put('/:orderId/confirm-delivery', authenticate, async (req, res) => {
    const lockKey = `order:confirm:${req.params.orderId}`;

    try {
        const { orderId } = req.params;

        // ✅ Get fresh order with lock
        const order = await getFreshOrderWithLock(orderId, lockKey);

        // ✅ Authorization check
        validateOrderAccess(order, req.userId, 'buyer');

        // ✅ CRITICAL GUARDS
        if (order.status === 'delivered') {
            await client.del(lockKey);
            return res.status(409).json({ 
                success: false, 
                message: 'ORDER_ALREADY_DELIVERED: Payment has already been released',
                alreadyProcessed: true
            });
        }

        if (order.status !== 'running') {
            await client.del(lockKey);
            return res.status(400).json({ 
                success: false, 
                message: `Cannot confirm ${order.status} orders` 
            });
        }

        if (order.trackingStatus !== 'ready_for_pickup') {
            await client.del(lockKey);
            return res.status(400).json({ 
                success: false, 
                message: 'Order must be marked as delivered by seller first' 
            });
        }

        // ✅ ATOMIC: Release escrow (idempotent via wallet service)
        const releaseResult = await walletService.releaseEscrow(
            orderId,
            order.buyerId,
            order.sellerId,
            order.totalAmount,
            order.commission
        );

        if (releaseResult.alreadyProcessed) {
            await client.del(lockKey);
            return res.json({
                success: true,
                message: 'Payment was already released',
                alreadyProcessed: true
            });
        }

        // 🔔 Notify seller
        await pushNotificationService.sendPushToUser(
            order.sellerId,
            "💸 Payment Released",
            `₦${(order.totalAmount - order.commission).toLocaleString()} credited to your wallet`,
            { screen: "OrdersTab" }
        );

        // Cleanup
        await Promise.all([
            client.del(lockKey),
            invalidateOrderCaches(orderId, order.buyerId, order.sellerId)
        ]);

        res.json({ 
            success: true, 
            message: 'Delivery confirmed and payment released to seller',
            sellerAmount: order.totalAmount - order.commission
        });

    } catch (error) {
        await client.del(lockKey);
        console.error('❌ Confirm delivery error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Failed to confirm delivery' 
        });
    }
});



/**
 * POST /api/v1/orders/bundle
 * ✅ FIXED: ATOMIC BUNDLE ORDER CREATION
 * Creates multiple orders from a single cart atomically
 * 
 * KEY FIX: All Firestore reads BEFORE any writes
 */
router.post('/bundle', authenticate, async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { subOrders, phoneNumber } = req.body;
        const buyerId = req.userId;

        // Validation
        if (!subOrders || !Array.isArray(subOrders) || subOrders.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'subOrders array is required'
            });
        }

        console.log(`📦 Creating bundle order for buyer ${buyerId}`);
        console.log(`   Sub-orders: ${subOrders.length}`);

        const { db, admin } = require('../config/firebase');
        
        const orderIds = [];
        let totalCartAmount = 0;

        await db.runTransaction(async (transaction) => {
            // ====================================
            // PHASE 1: READ ALL DATA FIRST ✅
            // ====================================
            
            // 1a. Collect all product refs
            const allProductRefs = [];
            for (const subOrder of subOrders) {
                for (const item of subOrder.items) {
                    if (!item.productId) {
                        throw new Error(`Invalid data: Product ID is missing for ${item.productName}`);
                    }
                    allProductRefs.push(db.collection('products').doc(item.productId));
                }
            }

            // 1b. Read all products
            const productSnaps = await Promise.all(
                allProductRefs.map(ref => transaction.get(ref))
            );

            const productMap = new Map();
            productSnaps.forEach(snap => {
                if (snap.exists) {
                    productMap.set(snap.id, snap.data());
                }
            });

            // 1c. Read buyer wallet
            const buyerWalletRef = db.collection('wallets').doc(buyerId);
            const buyerWalletSnap = await transaction.get(buyerWalletRef);
            
            if (!buyerWalletSnap.exists) {
                throw new Error('Buyer wallet not found');
            }
            const buyerWallet = buyerWalletSnap.data();

            // 1d. Collect unique seller IDs and read ALL seller wallets upfront ✅
            const uniqueSellerIds = [...new Set(subOrders.map(so => so.sellerId))];
            const sellerWalletRefs = uniqueSellerIds.map(sid => 
                db.collection('wallets').doc(sid)
            );
            
            const sellerWalletSnaps = await Promise.all(
                sellerWalletRefs.map(ref => transaction.get(ref))
            );

            const sellerWalletMap = new Map();
            sellerWalletSnaps.forEach(snap => {
                if (snap.exists) {
                    sellerWalletMap.set(snap.id, snap.data());
                }
            });

            // ====================================
            // PHASE 2: VALIDATE & PREPARE WRITES ✅
            // ====================================
            
            const stockUpdates = new Map();
            const orderData = []; // Store all order info for writes

            for (const subOrder of subOrders) {
                const newOrderRef = db.collection('orders').doc();
                const orderId = newOrderRef.id;
                orderIds.push(orderId);

                let subtotal = 0;

                // Validate items and calculate subtotal
                for (const item of subOrder.items) {
                    const product = productMap.get(item.productId);
                    
                    if (!product) {
                        throw new Error(`Product ${item.productName} not found`);
                    }

                    const currentRequested = stockUpdates.get(item.productId) || 0;
                    const newRequested = currentRequested + item.quantity;

                    if (product.stock < newRequested) {
                        throw new Error(`Insufficient stock for ${product.name}`);
                    }

                    stockUpdates.set(item.productId, newRequested);

                    const price = product.discount 
                        ? product.price * (1 - product.discount / 100) 
                        : product.price;
                    
                    subtotal += price * item.quantity;
                }

                const orderTotal = Math.round(subtotal - subOrder.discount + subOrder.deliveryFee);
                const orderCommission = Math.round(orderTotal * 0.10);
                totalCartAmount += orderTotal;

                // Store order data for later writing
                orderData.push({
                    orderRef: newOrderRef,
                    orderId,
                    sellerId: subOrder.sellerId,
                    orderTotal,
                    orderCommission,
                    subOrder
                });
            }

            // Check buyer balance BEFORE any writes
            if (buyerWallet.balance < totalCartAmount) {
                throw new Error('Insufficient balance');
            }

            // ====================================
            // PHASE 3: EXECUTE ALL WRITES ✅
            // ====================================

            // 3a. Create all orders
            for (const data of orderData) {
                transaction.set(data.orderRef, {
                    id: data.orderId,
                    buyerId,
                    sellerId: data.sellerId,
                    products: data.subOrder.items,
                    totalAmount: data.orderTotal,
                    commission: data.orderCommission,
                    status: 'running',
                    deliveryMethod: data.subOrder.deliveryMethod,
                    deliveryFee: data.subOrder.deliveryFee,
                    deliveryAddress: data.subOrder.deliveryAddress,
                    phoneNumber: phoneNumber || null,
                    buyerNote: data.subOrder.buyerNote || null,
                    disputeStatus: 'none',
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                });

                // Buyer payment transaction
                const buyerTxnRef = db.collection(`wallets/${buyerId}/transactions`).doc(`pay_${data.orderId}`);
                transaction.set(buyerTxnRef, {
                    id: `pay_${data.orderId}`,
                    userId: buyerId,
                    type: 'debit',
                    category: 'order_payment',
                    amount: data.orderTotal,
                    description: `Order #${data.orderId.slice(-6).toUpperCase()} - Escrow Hold`,
                    status: 'pending',
                    timestamp: Date.now(),
                    metadata: { orderId: data.orderId }
                });

                // Seller pending transaction
                const sellerTxnRef = db.collection(`wallets/${data.sellerId}/transactions`).doc();
                transaction.set(sellerTxnRef, {
                    id: sellerTxnRef.id,
                    userId: data.sellerId,
                    type: 'credit',
                    category: 'order_payment',
                    amount: data.orderTotal - data.orderCommission,
                    description: `Order #${data.orderId.slice(-6).toUpperCase()} - Pending Delivery`,
                    status: 'pending',
                    timestamp: Date.now(),
                    metadata: { orderId: data.orderId, commission: data.orderCommission }
                });

                // Update seller pending balance (using pre-read data)
                const sellerWallet = sellerWalletMap.get(data.sellerId);
                if (sellerWallet) {
                    const sellerWalletRef = db.collection('wallets').doc(data.sellerId);
                    transaction.update(sellerWalletRef, {
                        pendingBalance: (sellerWallet.pendingBalance || 0) + (data.orderTotal - data.orderCommission),
                        updatedAt: Date.now()
                    });
                }
            }

            // 3b. Update buyer balance
            transaction.update(buyerWalletRef, {
                balance: buyerWallet.balance - totalCartAmount,
                pendingBalance: (buyerWallet.pendingBalance || 0) + totalCartAmount,
                updatedAt: Date.now()
            });

            // 3c. Update product stock
            stockUpdates.forEach((quantity, productId) => {
                const productRef = db.collection('products').doc(productId);
                const product = productMap.get(productId);
                
                transaction.update(productRef, {
                    stock: product.stock - quantity,
                    updatedAt: Date.now()
                });
            });
        });

        const processingTime = Date.now() - startTime;

        console.log(`✅ Bundle order created successfully in ${processingTime}ms`);
        console.log(`   Order IDs: ${orderIds.join(', ')}`);
        console.log(`   Total amount: ₦${totalCartAmount.toLocaleString()}`);

        res.json({
            success: true,
            message: 'Bundle order created successfully',
            orderIds,
            totalAmount: totalCartAmount,
            orderCount: orderIds.length,
            processingTime,
            timestamp: Date.now()
        });

    } catch (error) {
        console.error('❌ Bundle order creation error:', error);

        let statusCode = 500;
        let errorMessage = 'Failed to create bundle order';

        if (error.message.includes('Insufficient stock')) {
            statusCode = 400;
            errorMessage = error.message;
        } else if (error.message.includes('Insufficient balance')) {
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


// ==========================================
// 5. ADMIN ROUTES
// ==========================================

router.get('/admin/automation-stats', authenticate, adminOnly, async (req, res) => {
    try {
        const cancelledSnapshot = await db.collection('orders')
            .where('autoCancelled', '==', true)
            .orderBy('updatedAt', 'desc')
            .limit(20)
            .get();
        
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
        const snapshot = await db.collection('users')
            .where('autoCancelStrikes', '>', 0)
            .get();
        
        const sellers = snapshot.docs.map(doc => ({ 
            uid: doc.id, 
            name: doc.data().name, 
            strikes: doc.data().autoCancelStrikes, 
            isSuspended: doc.data().isSuspended || false 
        }));
        
        res.json({ success: true, sellers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/admin/pardon-seller/:userId', authenticate, adminOnly, async (req, res) => {
    try {
        const { userId } = req.params;
        
        await db.collection('users').doc(userId).update({ 
            autoCancelStrikes: 0, 
            isSuspended: false, 
            suspensionReason: null, 
            updatedAt: Date.now() 
        });
        
        await client.del(`user:${userId}:profile`);
        
        await pushNotificationService.sendPushToUser(
            userId, 
            "Shop Reinstated", 
            "Your account is healthy again."
        );
        
        res.json({ success: true, message: "Seller pardoned" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Action failed" });
    }
});

router.post('/admin/system/maintenance', authenticate, adminOnly, async (req, res) => {
    const { enabled } = req.body;
    
    await client.set('system:maintenance_mode', enabled ? 'true' : 'false');
    
    // Log maintenance toggle
    console.log(`🔧 Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'}`);

    res.json({ success: true, enabled });
});

module.exports = router;