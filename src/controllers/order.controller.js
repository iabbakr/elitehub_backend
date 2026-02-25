'use strict';

const { db, admin } = require('../config/firebase');
const { getDocument, updateDocument } = require('../config/firebase');
const { client } = require('../config/redis');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const walletService = require('../services/wallet.service');
const pushNotificationService = require('../services/push-notification.service');

const VALID_TRACKING_STATUSES = ['acknowledged', 'enroute', 'ready_for_pickup'];
const PLATFORM_COMMISSION_RATE = 0.10;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Get fresh order data with Redis lock
 */
async function getFreshOrderWithLock(orderId, lockKey, lockTTL = 30) {
    const isLocked = await client.get(lockKey);
    if (isLocked) {
        throw new AppError('ACTION_IN_PROGRESS: Another operation is processing this order. Please wait.', 409);
    }

    await client.setEx(lockKey, lockTTL, 'processing');

    const order = await getDocument('orders', orderId);
    if (!order) {
        await client.del(lockKey);
        throw new AppError('ORDER_NOT_FOUND', 404);
    }

    return order;
}

/**
 * Validate user authorization
 */
function validateOrderAccess(order, userId, requiredRole) {
    if (requiredRole === 'buyer' && order.buyerId !== userId) {
        throw new AppError('UNAUTHORIZED: You are not the buyer of this order', 403);
    }
    if (requiredRole === 'seller' && order.sellerId !== userId) {
        throw new AppError('UNAUTHORIZED: You are not the seller of this order', 403);
    }
}

/**
 * Invalidate all caches for an order
 */
async function invalidateOrderCaches(orderId, buyerId, sellerId) {
    await Promise.all([
        client.del(`order:${orderId}`),
        client.del(`order_full:${orderId}`),
        client.del(`orders:${buyerId}:all:all`),
        client.del(`orders:${sellerId}:all:all`),
        client.del(`orders:${buyerId}:buyer:running`),
        client.del(`orders:${sellerId}:seller:running`)
    ]);
}

/**
 * Get tracking message
 */
function getTrackingMessage(status) {
    const messages = {
        acknowledged: 'Seller confirmed your order and is preparing items',
        enroute: 'Your order is on the way!',
        ready_for_pickup: 'Your order is ready for pickup/delivery confirmation'
    };
    return messages[status] || 'Order status updated';
}

// ── FIX: Notify each unique seller after a successful bundle order ────────────
// Called via setImmediate AFTER the transaction commits so it's non-blocking
// and a notification failure can never roll back a completed purchase.
async function notifySellersAfterBundle(subOrders, orderIds) {
    const notifPromises = subOrders.map((subOrder, index) => {
        const orderId = orderIds[index];
        if (!orderId || !subOrder.sellerId) return Promise.resolve();

        const itemTotal = subOrder.items.reduce(
            (sum, item) => sum + item.price * item.quantity,
            0
        );
        const orderTotal = Math.round(
            itemTotal - (subOrder.discount || 0) + (subOrder.deliveryFee || 0)
        );
        const shortId = orderId.slice(-6).toUpperCase();

        return pushNotificationService
            .sendOrderAlert(
                subOrder.sellerId,
                'order_new',
                orderId,
                '🎉 New Order Received!',
                `Order #${shortId} • ₦${orderTotal.toLocaleString('en-NG')} — tap to confirm`,
                { requiresAction: true }
            )
            .catch((err) =>
                console.error(
                    `[Bundle] Seller notify failed for ${subOrder.sellerId}:`,
                    err.message
                )
            );
    });

    await Promise.allSettled(notifPromises);
}

// ==========================================
// 1. GET ORDERS
// ==========================================

exports.getOrders = catchAsync(async (req, res, next) => {
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
        let orders = [...buyerSnap.docs.map(d => ({id: d.id, ...d.data()})), ...sellerSnap.docs.map(d => ({id: d.id, ...d.data()}))];
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
});

exports.getOrder = catchAsync(async (req, res, next) => {
    const { orderId } = req.params;
    const cacheKey = `order_full:${orderId}`;
    const cached = await client.get(cacheKey);
    
    if (cached) return res.status(200).json({ success: true, order: JSON.parse(cached), source: 'cache' });

    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return next(new AppError('Order not found', 404));

    const orderData = { id: orderDoc.id, ...orderDoc.data() };
    const isStaff = ['admin', 'support_agent'].includes(req.user?.role);
    if (orderData.buyerId !== req.userId && orderData.sellerId !== req.userId && !isStaff) {
        return next(new AppError('Unauthorized access', 403));
    }

    const [buyerSnap, sellerSnap] = await Promise.all([
        db.collection('users').doc(orderData.buyerId).get(),
        db.collection('users').doc(orderData.sellerId).get()
    ]);

    const richOrder = {
        ...orderData,
        buyerDetails: buyerSnap.exists ? { name: buyerSnap.data().name, phone: buyerSnap.data().phone, imageUrl: buyerSnap.data().imageUrl } : null,
        sellerDetails: sellerSnap.exists ? { businessName: sellerSnap.data().businessName || sellerSnap.data().name, businessAddress: sellerSnap.data().businessAddress, imageUrl: sellerSnap.data().imageUrl } : null
    };

    await client.setEx(cacheKey, 120, JSON.stringify(richOrder));
    res.status(200).json({ success: true, order: richOrder });
});

// ==========================================
// 2. CREATE ORDER
// ==========================================

/**
 * POST /api/v1/orders
 * Create single order with escrow lock
 */
exports.createOrder = catchAsync(async (req, res, next) => {
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

    if (!products?.length || !deliveryAddress) {
        return next(new AppError('Missing required fields', 400));
    }

    const firstProduct = await getDocument('products', products[0].productId);
    if (!firstProduct) {
        return next(new AppError('Product not found', 404));
    }

    const sellerId = firstProduct.sellerId;

    const sellerDoc = await getDocument('users', sellerId);
    if (sellerDoc?.isSuspended) {
        return next(new AppError('This shop is currently inactive.', 403));
    }

    const createLockKey = `order:create:${buyerId}:${Date.now()}`;
    const isCreating = await client.get(createLockKey);
    if (isCreating) {
        return res.status(409).json({ 
            success: false, 
            message: 'Processing your previous order...' 
        });
    }
    await client.setEx(createLockKey, 30, 'true');

    try {
        let subtotal = 0;
        const orderProducts = [];
        const productUpdates = [];

        for (const item of products) {
            const product = await getDocument('products', item.productId);
            
            if (!product || product.sellerId !== sellerId) {
                await client.del(createLockKey);
                return next(new AppError('Invalid product selection', 400));
            }

            if (product.stock < item.quantity) {
                await client.del(createLockKey);
                return next(new AppError(`Insufficient stock for ${product.name}`, 400));
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
        const commission = Math.round(totalAmount * PLATFORM_COMMISSION_RATE);

        const buyerBalance = await walletService.getBalance(buyerId);
        if (buyerBalance < totalAmount) {
            await client.del(createLockKey);
            return next(new AppError('Insufficient wallet balance', 400));
        }

        let orderId;
        await db.runTransaction(async (transaction) => {
            const orderRef = db.collection('orders').doc();
            orderId = orderRef.id;

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

            for (const update of productUpdates) {
                if (update.newStock <= 0) {
                    transaction.delete(update.ref);
                } else {
                    transaction.update(update.ref, { stock: update.newStock });
                }
            }
        });

        await walletService.processOrderPayment(
            buyerId, 
            sellerId, 
            orderId, 
            totalAmount, 
            commission
        );

        await pushNotificationService.sendPushToUser(
            sellerId,
            "New Order Received! 🎉",
            `Order #${orderId.slice(-6).toUpperCase()} worth ₦${totalAmount.toLocaleString()}`,
            { screen: "OrdersTab", params: { screen: "Orders" } }
        );

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
        await client.del(createLockKey);
        throw error;
    }
});

/**
 * POST /api/v1/orders/bundle
 * Create multiple orders from cart atomically
 */
exports.createBundleOrder = catchAsync(async (req, res, next) => {
    const { subOrders, phoneNumber } = req.body;
    const buyerId = req.userId;

    if (!subOrders || !Array.isArray(subOrders) || subOrders.length === 0) {
        return next(new AppError('subOrders array is required', 400));
    }

    const orderIds = [];
    let totalCartAmount = 0;

    await db.runTransaction(async (transaction) => {
        // PHASE 1: READ ALL DATA FIRST
        const allProductRefs = [];
        for (const subOrder of subOrders) {
            for (const item of subOrder.items) {
                if (!item.productId) {
                    throw new AppError(`Invalid data: Product ID is missing for ${item.productName}`, 400);
                }
                allProductRefs.push(db.collection('products').doc(item.productId));
            }
        }

        const productSnaps = await Promise.all(
            allProductRefs.map(ref => transaction.get(ref))
        );

        const productMap = new Map();
        productSnaps.forEach(snap => {
            if (snap.exists) {
                productMap.set(snap.id, snap.data());
            }
        });

        const buyerWalletRef = db.collection('wallets').doc(buyerId);
        const buyerWalletSnap = await transaction.get(buyerWalletRef);
        
        if (!buyerWalletSnap.exists) {
            throw new AppError('Buyer wallet not found', 404);
        }
        const buyerWallet = buyerWalletSnap.data();

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

        // PHASE 2: VALIDATE & PREPARE
        const stockUpdates = new Map();
        const orderData = [];

        for (const subOrder of subOrders) {
            const newOrderRef = db.collection('orders').doc();
            const orderId = newOrderRef.id;
            orderIds.push(orderId);

            let subtotal = 0;

            for (const item of subOrder.items) {
                const product = productMap.get(item.productId);
                
                if (!product) {
                    throw new AppError(`Product ${item.productName} not found`, 404);
                }

                const currentRequested = stockUpdates.get(item.productId) || 0;
                const newRequested = currentRequested + item.quantity;

                if (product.stock < newRequested) {
                    throw new AppError(`Insufficient stock for ${product.name}`, 400);
                }

                stockUpdates.set(item.productId, newRequested);

                const price = product.discount 
                    ? product.price * (1 - product.discount / 100) 
                    : product.price;
                
                subtotal += price * item.quantity;
            }

            const orderTotal = Math.round(subtotal - subOrder.discount + subOrder.deliveryFee);
            const orderCommission = Math.round(orderTotal * PLATFORM_COMMISSION_RATE);
            totalCartAmount += orderTotal;

            orderData.push({
                orderRef: newOrderRef,
                orderId,
                sellerId: subOrder.sellerId,
                orderTotal,
                orderCommission,
                subOrder
            });
        }

        if (buyerWallet.balance < totalCartAmount) {
            throw new AppError('Insufficient balance', 400);
        }

        // PHASE 3: EXECUTE ALL WRITES
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

            const sellerWallet = sellerWalletMap.get(data.sellerId);
            if (sellerWallet) {
                const sellerWalletRef = db.collection('wallets').doc(data.sellerId);
                transaction.update(sellerWalletRef, {
                    pendingBalance: (sellerWallet.pendingBalance || 0) + (data.orderTotal - data.orderCommission),
                    updatedAt: Date.now()
                });
            }
        }

        transaction.update(buyerWalletRef, {
            balance: buyerWallet.balance - totalCartAmount,
            pendingBalance: (buyerWallet.pendingBalance || 0) + totalCartAmount,
            updatedAt: Date.now()
        });

        stockUpdates.forEach((quantity, productId) => {
            const productRef = db.collection('products').doc(productId);
            const product = productMap.get(productId);
            
            transaction.update(productRef, {
                stock: product.stock - quantity,
                updatedAt: Date.now()
            });
        });
    });

    // ── FIX: Notify sellers after transaction — non-blocking via setImmediate ──
    // setImmediate ensures the response is sent first, so a slow/failed push
    // notification never delays or breaks the buyer's checkout confirmation.
    setImmediate(() => {
        notifySellersAfterBundle(subOrders, orderIds).catch((err) =>
            console.error('[Bundle] Seller notification batch error:', err)
        );
    });

    res.json({
        success: true,
        message: 'Bundle order created successfully',
        orderIds,
        totalAmount: totalCartAmount,
        orderCount: orderIds.length,
        timestamp: Date.now()
    });
});

// ==========================================
// 3. SELLER ACTIONS
// ==========================================

/**
 * PUT /api/v1/orders/:orderId/tracking
 * Seller updates tracking status
 */
exports.updateTracking = catchAsync(async (req, res, next) => {
    const { status } = req.body;
    const { orderId } = req.params;
    const lockKey = `order:tracking:${orderId}`;

    if (!VALID_TRACKING_STATUSES.includes(status)) {
        return next(new AppError('Invalid tracking status', 400));
    }

    try {
        const order = await getFreshOrderWithLock(orderId, lockKey);
        validateOrderAccess(order, req.userId, 'seller');

        if (order.status !== 'running') {
            await client.del(lockKey);
            return next(new AppError(`Cannot update tracking for ${order.status} orders`, 400));
        }

        const trackingOrder = ['acknowledged', 'enroute', 'ready_for_pickup'];
        const currentIndex = trackingOrder.indexOf(order.trackingStatus);
        const newIndex = trackingOrder.indexOf(status);
        
        if (currentIndex >= newIndex && order.trackingStatus !== null) {
            await client.del(lockKey);
            return next(new AppError('Cannot move backwards in tracking', 400));
        }

        await db.collection('orders').doc(orderId).update({
            trackingStatus: status,
            updatedAt: Date.now(),
            [`tracking_${status}_at`]: Date.now()
        });

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
        throw error;
    }
});

// ==========================================
// 4. BUYER ACTIONS
// ==========================================

/**
 * PUT /api/v1/orders/:orderId/cancel-buyer
 * Buyer cancels order (only before seller acknowledgment)
 */
exports.cancelOrderBuyer = catchAsync(async (req, res, next) => {
    const { orderId } = req.params;
    const { reason } = req.body;
    const lockKey = `order:cancel:buyer:${orderId}`;

    if (!reason || reason.trim().length < 10) {
        return next(new AppError('Cancellation reason must be at least 10 characters', 400));
    }

    try {
        const order = await getFreshOrderWithLock(orderId, lockKey);
        validateOrderAccess(order, req.userId, 'buyer');

        if (order.trackingStatus) {
            await client.del(lockKey);
            return res.status(403).json({ 
                success: false, 
                message: 'ORDER_LOCKED: Seller has already confirmed this order. Please contact support if needed.',
                locked: true
            });
        }

        if (order.status !== 'running') {
            await client.del(lockKey);
            return next(new AppError(`Cannot cancel ${order.status} orders`, 400));
        }

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

        await walletService.refundEscrow(
            orderId,
            order.buyerId,
            order.sellerId,
            order.totalAmount,
            order.commission,
            `Buyer cancelled: ${reason.trim()}`
        );

        await pushNotificationService.sendPushToUser(
            order.sellerId,
            "Order Cancelled by Buyer",
            `Order #${orderId.slice(-6)} was cancelled before confirmation`,
            { screen: "OrdersTab" }
        );

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
        throw error;
    }
});

/**
 * PUT /api/v1/orders/:orderId/cancel-seller
 * Seller cancels order (anytime, incurs strikes)
 */
exports.cancelOrderSeller = catchAsync(async (req, res, next) => {
    const { orderId } = req.params;
    const { reason } = req.body;
    const lockKey = `order:cancel:seller:${orderId}`;

    if (!reason || reason.trim().length < 10) {
        return next(new AppError('Cancellation reason must be at least 10 characters', 400));
    }

    try {
        const order = await getFreshOrderWithLock(orderId, lockKey);
        validateOrderAccess(order, req.userId, 'seller');

        if (order.status !== 'running') {
            await client.del(lockKey);
            return next(new AppError(`Cannot cancel ${order.status} orders`, 400));
        }

        await db.runTransaction(async (transaction) => {
            const orderRef = db.collection('orders').doc(orderId);
            const sellerRef = db.collection('users').doc(order.sellerId);

            const sellerSnap = await transaction.get(sellerRef);
            const sellerData = sellerSnap.data() || {};

            transaction.update(orderRef, {
                status: 'cancelled',
                sellerCancelled: true,
                cancelReason: reason.trim(),
                cancelledBy: req.userId,
                cancelledByRole: 'seller',
                cancelledAt: Date.now(),
                updatedAt: Date.now()
            });

            // ⚠️ Auto-strike only if order was already acknowledged
            if (order.trackingStatus) {
                transaction.update(sellerRef, {
                    autoCancelStrikes: admin.firestore.FieldValue.increment(1),
                    isSuspended: (sellerData.autoCancelStrikes || 0) + 1 >= 3,
                    suspensionReason: (sellerData.autoCancelStrikes || 0) + 1 >= 3 
                        ? 'Automated suspension: Multiple cancellations after order confirmation' 
                        : null
                });
            }
        });

        await walletService.refundEscrow(
            orderId,
            order.buyerId,
            order.sellerId,
            order.totalAmount,
            order.commission,
            `Seller cancelled: ${reason.trim()}`
        );

        await pushNotificationService.sendPushToUser(
            order.buyerId,
            "Order Cancelled by Seller",
            "Full refund has been credited to your wallet",
            { screen: "OrdersTab" }
        );

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
        throw error;
    }
});

/**
 * PUT /api/v1/orders/:orderId/confirm-delivery
 *
 * Buyer confirms delivery → releases escrow to seller.
 * After escrow is confirmed, triggers referral bonus check fire-and-forget.
 * Referral failure is INTENTIONALLY non-fatal — delivery is already confirmed.
 */
exports.confirmDelivery = catchAsync(async (req, res, next) => {
    const { orderId } = req.params;
    const lockKey = `order:confirm:${orderId}`;

    try {
        const order = await getFreshOrderWithLock(orderId, lockKey);
        validateOrderAccess(order, req.userId, 'buyer');

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
            return next(new AppError(`Cannot confirm ${order.status} orders`, 400));
        }

        if (order.trackingStatus !== 'ready_for_pickup') {
            await client.del(lockKey);
            return next(new AppError('Order must be marked as delivered by seller first', 400));
        }

        // ── 1. Release escrow (atomic + idempotent) ─────────────────────────
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

        // ── 2. 🎁 Referral bonus — fire-and-forget via internal HTTP call ──
        // Using setImmediate ensures this runs AFTER the response is flushed.
        // Any failure is caught and logged — never propagates to the buyer.
        if (!releaseResult.alreadyProcessed) {
            setImmediate(async () => {
                try {
                    const axios = require('axios');
                    await axios.post(
                        `${process.env.API_BASE_URL}/api/v1/referrals/release`,
                        { buyerId: order.buyerId, orderId },
                        {
                            headers: {
                                'X-Internal-Secret': process.env.INTERNAL_SECRET,
                                'Content-Type': 'application/json',
                            },
                            timeout: 10_000,
                        }
                    );
                } catch (err) {
                    // Non-fatal — escrow is already released, buyer is confirmed.
                    console.error(`[Referral] Auto-release failed for order ${orderId} (non-fatal):`, err.message);
                }
            });
        }

        // ── 3. Notify seller ─────────────────────────────────────────────────
        await pushNotificationService.sendPushToUser(
            order.sellerId,
            "💸 Payment Released",
            `₦${(order.totalAmount - order.commission).toLocaleString()} credited to your wallet`,
            { screen: "OrdersTab" }
        );

        // ── 4. Cleanup ────────────────────────────────────────────────────────
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
        throw error;
    }
});

// ==========================================
// 5. ADMIN ROUTES
// ==========================================

/**
 * GET /api/v1/orders/admin/automation-stats
 */
exports.getAutomationStats = catchAsync(async (req, res, next) => {
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
});

/**
 * GET /api/v1/orders/admin/flagged-sellers
 */
exports.getFlaggedSellers = catchAsync(async (req, res, next) => {
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
});

/**
 * POST /api/v1/orders/admin/pardon-seller/:userId
 */
exports.pardonSeller = catchAsync(async (req, res, next) => {
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
});

/**
 * POST /api/v1/orders/admin/system/maintenance
 */
exports.toggleMaintenance = catchAsync(async (req, res, next) => {
    const { enabled } = req.body;
    
    await client.set('system:maintenance_mode', enabled ? 'true' : 'false');
    
    console.log(`🔧 Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'}`);

    res.json({ success: true, enabled });
});