// services/push-notification.service.js - BACKEND PUSH SERVICE
const { db, admin } = require('../config/firebase');

/**
 * ✅ BACKEND PUSH NOTIFICATION SERVICE
 * Sends push notifications to users via Expo Push Service
 * Handles Badge Counts, Order Updates, and Financial Alerts
 */
class PushNotificationService {
    /**
     * Internal helper to atomically increment the badge count in Firestore
     */
    async _getAndIncrementBadgeCount(userId) {
        try {
            const userRef = db.collection('users').doc(userId);
            
            // 1. Atomically increment the field in the database
            await userRef.set({ 
                notificationCount: admin.firestore.FieldValue.increment(1) 
            }, { merge: true });
            
            // 2. Fetch the new count to send in the push payload
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
            // Get user's push token from Firestore
            const tokenDoc = await db.collection('pushTokens').doc(userId).get();
            
            if (!tokenDoc.exists) {
                console.log(`No push token found for user: ${userId}`);
                return { success: false, reason: 'no_token' };
            }

            const { token } = tokenDoc.data();

            // ✅ Step 1: Increment and get the count for the icon badge
            const currentBadgeCount = await this._getAndIncrementBadgeCount(userId);

            // Prepare Expo push message
            const message = {
                to: token,
                sound: 'default',
                title,
                body,
                // ✅ Step 2: Set the icon badge number
                badge: currentBadgeCount,
                data,
                priority: 'high',
                channelId: 'orders', // Android notification channel
            };

            // Send to Expo Push Service
            const response = await fetch('https://exp.host/--/api/v2/push/send', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(message),
            });

            const result = await response.json();

            // Handle Expo-specific receipt errors
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
}

module.exports = new PushNotificationService();