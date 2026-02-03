// services/push-notification.service.js - BACKEND PUSH SERVICE
const { db } = require('../config/firebase');

/**
 * ✅ BACKEND PUSH NOTIFICATION SERVICE
 * Sends push notifications to users via Expo Push Service
 * Handles Order Updates and Financial Transaction Alerts
 */

class PushNotificationService {
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

            // Prepare Expo push message
            const message = {
                to: token,
                sound: 'default',
                title,
                body,
                badge: data.badge ?? undefined,
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

            if (result.data?.status === 'error') {
                console.error('Push notification error:', result.data);
                return { success: false, error: result.data };
            }

            console.log(`✅ Push sent to ${userId}: ${title}`);
            return { success: true, result };

        } catch (error) {
            console.error('Push notification failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Specialized helper for wallet & escrow alerts
     * Targets transitions to 'completed' or 'refunded'
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
                params: { orderId } // Passes orderId for specific highlight if needed
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
}

module.exports = new PushNotificationService();