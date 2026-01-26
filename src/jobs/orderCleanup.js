const cron = require('node-cron');
const { db, runTransaction } = require('../config/firebase'); // Raw DB access
const firebaseService = require('../services/firebase.service'); // EliteHub Logic
const walletService = require('../services/wallet.service');
const { client } = require('../config/redis');

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
                // 1. Update Order Status
                await db.collection('orders').doc(orderId).update({
                    status: 'cancelled',
                    cancelReason: 'Auto-cancelled: Seller failed to acknowledge within 48 hours.',
                    updatedAt: Date.now(),
                    autoCancelled: true
                });

                // 2. Strike & Suspension Logic
                const sellerRef = db.collection('users').doc(order.sellerId);
                
                await runTransaction(async (transaction) => {
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

                    const sellerMsg = shouldSuspend 
                        ? "🚨 Your account has been suspended due to repeated inactivity."
                        : `⚠️ Warning: You have ${currentStrikes}/${SUSPENSION_THRESHOLD} strikes for unacknowledged orders.`;
                    
                    // ✅ Triggered via the new Service layer
                    await firebaseService.sendPushToUser(order.sellerId, "Shop Update", sellerMsg, { screen: "SellerDashboard" });
                });

                // 3. Process Refund
                await walletService.refundEscrow(
                    orderId, order.buyerId, order.sellerId, 
                    order.totalAmount, order.commission, 
                    'Seller inactivity refund'
                );

                // 4. Notify Buyer
                await firebaseService.sendPushToUser(
                    order.buyerId,
                    "💸 Refund Processed",
                    `Order #${orderId.slice(-6).toUpperCase()} was cancelled. Funds returned.`,
                    { screen: "WalletTab" }
                );

                // 5. Clean Cache
                await Promise.all([
                    client.del(`order:${orderId}`),
                    client.del(`orders:${order.buyerId}:all:all`),
                    client.del(`orders:${order.sellerId}:all:all`),
                    client.del(`user:${order.sellerId}:profile`)
                ]);

                console.log(`✅ Processed order ${orderId}`);
            } catch (err) {
                console.error(`❌ Failed to process ${orderId}:`, err);
            }
        }
    } catch (error) {
        console.error('CRON ERROR:', error);
    }
});