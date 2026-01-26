const cron = require('node-cron');
const { db } = require('../config/firebase');
const walletService = require('../services/wallet.service');
const { client } = require('../config/redis');
const firebaseService = require('../services/firebase.service'); 

const SUSPENSION_THRESHOLD = 3; 

cron.schedule('0 * * * *', async () => {
    console.log('--- Starting Auto-Cancellation & Strike Check ---');
    
    const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
    const expirationThreshold = Date.now() - FORTY_EIGHT_HOURS_MS;

    try {
        const expiredOrdersQuery = await db.collection('orders')
            .where('status', '==', 'running')
            .where('trackingStatus', '==', null)
            .where('createdAt', '<=', expirationThreshold)
            .get();

        if (expiredOrdersQuery.empty) return;

        for (const doc of expiredOrdersQuery.docs) {
            const order = doc.data();
            const orderId = doc.id;

            try {
                // 1. Atomic status update for Order
                await db.collection('orders').doc(orderId).update({
                    status: 'cancelled',
                    cancelReason: 'Auto-cancelled: Seller failed to acknowledge within 48 hours.',
                    updatedAt: Date.now(),
                    autoCancelled: true
                });

                // --- 1.5 MISSING STRIKE & SUSPENSION LOGIC ---
                const sellerRef = db.collection('users').doc(order.sellerId);
                
                await db.runTransaction(async (transaction) => {
                    const sellerDoc = await transaction.get(sellerRef);
                    if (!sellerDoc.exists) return;

                    const sellerData = sellerDoc.data();
                    const currentStrikes = (sellerData.autoCancelStrikes || 0) + 1;
                    const shouldSuspend = currentStrikes >= SUSPENSION_THRESHOLD;

                    transaction.update(sellerRef, {
                        autoCancelStrikes: currentStrikes,
                        isSuspended: shouldSuspend,
                        suspensionReason: shouldSuspend ? `Exceeded ${SUSPENSION_THRESHOLD} auto-cancellations.` : null,
                        updatedAt: Date.now()
                    });

                    // Notify Seller of their specific strike status
                    const sellerMsg = shouldSuspend 
                        ? "🚨 Your account has been suspended due to repeated inactivity."
                        : `⚠️ Warning: You have ${currentStrikes}/${SUSPENSION_THRESHOLD} strikes for unacknowledged orders.`;
                    
                    // We don't await inside transaction, we trigger after
                    firebaseService.sendPushToUser(order.sellerId, "Shop Update", sellerMsg, { screen: "SellerDashboard" });
                });
                // ----------------------------------------------

                // 2. Process Refund
                await walletService.refundEscrow(
                    orderId,
                    order.buyerId,
                    order.sellerId,
                    order.totalAmount,
                    order.commission,
                    'Seller inactivity refund'
                );

                // 3. Notify Buyer
                await firebaseService.sendPushToUser(
                    order.buyerId,
                    "💸 Refund Processed",
                    `Order #${orderId.slice(-6).toUpperCase()} was cancelled. Funds returned to wallet.`,
                    { screen: "WalletTab" }
                );

                // 4. Clean Cache
                await Promise.all([
                    client.del(`order:${orderId}`),
                    client.del(`orders:${order.buyerId}:all:all`),
                    client.del(`orders:${order.sellerId}:all:all`),
                    client.del(`user:${order.sellerId}:profile`) // Force dashboard refresh
                ]);

                console.log(`✅ Auto-cancelled, Issued Strike, and Notified: ${orderId}`);
            } catch (err) {
                console.error(`❌ Failed to process auto-cancel for ${orderId}:`, err);
            }
        }
    } catch (error) {
        console.error('CRON ERROR:', error);
    }
});