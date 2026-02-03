const express = require('express');
const router = express.Router();
const { client } = require('../config/redis');
const { db } = require('../config/firebase');
const { authenticate, adminOnly } = require('../middleware/auth');
const walletService = require('../services/wallet.service');
const pushNotificationService = require('../services/push-notification.service');

/**
 * TOGGLE MAINTENANCE MODE
 */
router.post('/system/maintenance', authenticate, adminOnly, async (req, res) => {
    try {
        const { enabled } = req.body;
        await client.set('system:maintenance_mode', enabled.toString());
        res.json({ success: true, isMaintenance: enabled });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * RESOLVE DISPUTE (Atomic release/refund)
 */
router.post('/resolve-dispute', authenticate, adminOnly, async (req, res) => {
    const { orderId, resolution, adminNote } = req.body;

    try {
        const orderSnap = await db.collection('orders').doc(orderId).get();
        if (!orderSnap.exists) return res.status(404).json({ success: false, message: 'Order not found' });
        
        const order = orderSnap.data();
        if (order.disputeStatus !== 'open') {
            return res.status(400).json({ success: false, message: 'No open dispute found' });
        }

        if (resolution === 'release') {
            await walletService.releaseEscrow(orderId, order.buyerId, order.sellerId, order.totalAmount, order.commission);
        } else if (resolution === 'refund') {
            await walletService.refundEscrow(orderId, order.buyerId, order.sellerId, order.totalAmount, order.commission, `Admin Resolution: ${adminNote}`);
        }

        await db.collection('orders').doc(orderId).update({
            disputeStatus: 'resolved',
            adminResolution: resolution,
            adminNotes: adminNote,
            resolvedAt: Date.now(),
            updatedAt: Date.now()
        });

        await pushNotificationService.sendPushToMultipleUsers(
            [order.buyerId, order.sellerId],
            "⚖️ Dispute Resolved",
            `The dispute for Order #${orderId.slice(-6).toUpperCase()} has been finalized.`,
            { screen: "OrderDetailScreen", params: { orderId } }
        );

        res.json({ success: true, message: `Dispute resolved via ${resolution}` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * TRIGGER TRANSACTION SYNC
 * Use this to fix legacy 'pending' logs
 */
router.post('/system/sync-transactions', authenticate, adminOnly, async (req, res) => {
    try {
        const result = await syncStuckTransactions();
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * STUCK TRANSACTION FIXER LOGIC
 */
async function syncStuckTransactions() {
    console.log("🔍 Starting Transaction Sync...");
    let fixedCount = 0;

    const deliveredOrders = await db.collection('orders')
        .where('status', '==', 'delivered')
        .get();

    for (const orderDoc of deliveredOrders.docs) {
        const orderId = orderDoc.id;

        // Requires a Collection Group Index on 'metadata.orderId' and 'status'
        const stuckTxns = await db.collectionGroup('transactions')
            .where('metadata.orderId', '==', orderId)
            .where('status', '==', 'pending')
            .get();

        for (const txnDoc of stuckTxns.docs) {
            await txnDoc.ref.update({
                status: 'completed',
                description: txnDoc.data().description + " (Auto-synced)",
                updatedAt: Date.now()
            });
            fixedCount++;
        }
    }

    console.log(`✅ Sync Complete. Fixed ${fixedCount} transactions.`);
    return { fixedCount, ordersProcessed: deliveredOrders.size };
}

module.exports = router;