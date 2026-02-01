// services/push-notification.service.js - BACKEND PUSH SERVICE
const { db } = require('../config/firebase');

/**
 * ✅ BACKEND PUSH NOTIFICATION SERVICE
 * Sends push notifications to users via Expo Push Service
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
     * Send push to multiple users
     */
    async sendPushToMultipleUsers(userIds, title, body, data = {}) {
        const results = await Promise.allSettled(
            userIds.map(userId => this.sendPushToUser(userId, title, body, data))
        );

        const successful = results.filter(r => r.status === 'fulfilled').length;
        console.log(`✅ Sent ${successful}/${userIds.length} notifications`);

        return { successful, total: userIds.length };
    }
}

module.exports = new PushNotificationService();