// services/push-notification.service.js - ENHANCED WITH DISPUTE NOTIFICATIONS
const { db, admin } = require('../config/firebase');

/**
 * ✅ PRODUCTION-GRADE PUSH NOTIFICATION SERVICE
 * Enhanced with dispute-specific notifications and reconciliation alerts
 */
class PushNotificationService {
    /**
     * Internal helper to atomically increment the badge count in Firestore
     */
    async _getAndIncrementBadgeCount(userId) {
        try {
            const userRef = db.collection('users').doc(userId);
            
            await userRef.set({ 
                notificationCount: admin.firestore.FieldValue.increment(1) 
            }, { merge: true });
            
            const userDoc = await userRef.get();
            return userDoc.data()?.notificationCount || 1;
        } catch (error) {
            console.error('Failed to update badge count:', error);
            return 1; 
        }
    }

    /**
     * Send push notification to a specific user
     */
    async sendPushToUser(userId, title, body, data = {}) {
        try {
            const tokenDoc = await db.collection('pushTokens').doc(userId).get();
            
            if (!tokenDoc.exists) {
                console.log(`No push token found for user: ${userId}`);
                return { success: false, reason: 'no_token' };
            }

            const { token } = tokenDoc.data();
            const currentBadgeCount = await this._getAndIncrementBadgeCount(userId);

            const message = {
                to: token,
                sound: 'default',
                title,
                body,
                badge: currentBadgeCount,
                data,
                priority: 'high',
                channelId: 'orders',
            };

            const response = await fetch('https://exp.host/--/api/v2/push/send', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(message),
            });

            const result = await response.json();

            if (result.errors) {
                console.error('Expo API Errors:', result.errors);
                return { success: false, errors: result.errors };
            }

            console.log(`✅ Push sent to ${userId}: ${title} (Badge: ${currentBadgeCount})`);
            return { success: true, result };

        } catch (error) {
            console.error('Push notification failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * ✅ NEW: Dispute-specific notifications
     */
    async sendDisputeAlert(userId, type, orderId, additionalInfo = {}) {
        const shortId = orderId.slice(-6).toUpperCase();
        let title = "";
        let body = "";
        let screenData = {
            screen: "OrdersTab",
            params: {
                screen: "DisputeChatScreen",
                params: { orderId }
            }
        };

        switch (type) {
            case 'dispute_opened':
                title = "⚠️ Dispute Opened";
                body = `A dispute has been opened for Order #${shortId}`;
                break;
            
            case 'dispute_message':
                title = "💬 New Dispute Message";
                body = `You have a new message regarding Order #${shortId}`;
                break;
            
            case 'dispute_resolved_buyer':
                title = "✅ Dispute Resolved";
                body = additionalInfo.resolution === 'refund' 
                    ? `Your refund for Order #${shortId} has been processed`
                    : `Payment for Order #${shortId} has been released to seller`;
                screenData.screen = "OrderDetailScreen";
                break;
            
            case 'dispute_resolved_seller':
                title = "✅ Dispute Resolved";
                body = additionalInfo.resolution === 'release' 
                    ? `Payment for Order #${shortId} has been released to you`
                    : `Buyer has been refunded for Order #${shortId}`;
                screenData.screen = "OrderDetailScreen";
                break;
            
            case 'admin_reviewing':
                title = "👁️ Admin Review";
                body = `Support is now reviewing your dispute for Order #${shortId}`;
                break;

            case 'reconciliation_offer':
                title = "🤝 Reconciliation Offer";
                body = `${additionalInfo.fromRole} has proposed a solution for Order #${shortId}`;
                break;

            default:
                title = "Dispute Update";
                body = `Your dispute for Order #${shortId} has been updated`;
        }

        return this.sendPushToUser(userId, title, body, {
            ...screenData,
            type: 'dispute_update',
            orderId,
            disputeType: type,
            ...additionalInfo
        });
    }

    /**
     * ✅ NEW: Send reconciliation notification to both parties
     */
    async sendReconciliationNotification(buyerId, sellerId, orderId, proposalDetails) {
        const shortId = orderId.slice(-6).toUpperCase();
        
        const notifications = [
            this.sendPushToUser(
                buyerId,
                "🤝 Reconciliation Proposal",
                `Seller proposed: "${proposalDetails.summary}" for Order #${shortId}`,
                {
                    screen: "DisputeChatScreen",
                    params: { orderId },
                    type: 'reconciliation',
                    proposal: proposalDetails
                }
            ),
            this.sendPushToUser(
                sellerId,
                "📝 Proposal Sent",
                `Your reconciliation proposal for Order #${shortId} has been sent to the buyer`,
                {
                    screen: "DisputeChatScreen",
                    params: { orderId },
                    type: 'reconciliation_sent'
                }
            )
        ];

        return Promise.allSettled(notifications);
    }

    /**
     * Specialized helper for wallet & escrow alerts
     */
    async sendTransactionAlert(userId, type, amount, orderId) {
        const shortId = orderId.slice(-6).toUpperCase();
        let title = "";
        let body = "";

        if (type === 'completed') {
            title = "💸 Escrow Released";
            body = `Payment for Order #${shortId} has been finalized. Thank you for shopping!`;
        } else if (type === 'refunded') {
            title = "💰 Refund Successful";
            body = `₦${amount.toLocaleString()} has been credited back to your wallet for Order #${shortId}.`;
        } else {
            title = "💳 Wallet Update";
            body = `Your transaction for Order #${shortId} has been updated.`;
        }

        return this.sendPushToUser(userId, title, body, {
            screen: "ProfileTab",
            params: { 
                screen: "Transactions",
                params: { orderId } 
            },
            type: 'wallet_update',
            orderId
        });
    }

    /**
     * Send push to multiple users
     */
    async sendPushToMultipleUsers(userIds, title, body, data = {}) {
        const results = await Promise.allSettled(
            userIds.map(userId => this.sendPushToUser(userId, title, body, data))
        );

        const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        console.log(`✅ Bulk Push: Sent ${successful}/${userIds.length} successfully`);

        return { successful, total: userIds.length };
    }

    /**
     * Specialized helper for seller payouts
     */
    async sendSellerPayoutAlert(sellerId, amount, orderId) {
        const shortId = orderId.slice(-6).toUpperCase();
        const title = "💸 Payment Received";
        const body = `₦${amount.toLocaleString()} for Order #${shortId} is now available in your balance.`;

        return this.sendPushToUser(sellerId, title, body, {
            screen: "ProfileTab",
            params: { screen: "Transactions" },
            type: 'payout_released',
            orderId
        });
    }

    /**
     * ✅ NEW: Send notification to admin/support when dispute is opened
     */
    async notifyAdminsOfNewDispute(orderId, disputeDetails) {
        try {
            const shortId = orderId.slice(-6).toUpperCase();
            
            // Get all admins and support agents
            const adminsSnapshot = await db.collection('users')
                .where('role', 'in', ['admin', 'support_agent'])
                .get();

            const adminIds = adminsSnapshot.docs.map(doc => doc.id);

            if (adminIds.length === 0) {
                console.warn('No admins found to notify');
                return;
            }

            await this.sendPushToMultipleUsers(
                adminIds,
                "🚨 New Dispute Opened",
                `Order #${shortId}: ${disputeDetails.slice(0, 50)}...`,
                {
                    screen: "ProfileTab",
                    params: {
                        screen: "AdminDisputeScreen",
                        params: { orderId }
                    },
                    type: 'admin_dispute_alert',
                    orderId,
                    priority: 'high'
                }
            );

        } catch (error) {
            console.error('Failed to notify admins:', error);
        }
    }

    /**
     * ✅ NEW: Clear notification badge for user
     */
    async clearBadgeCount(userId) {
        try {
            await db.collection('users').doc(userId).update({
                notificationCount: 0
            });
        } catch (error) {
            console.error('Failed to clear badge count:', error);
        }
    }
}

module.exports = new PushNotificationService();