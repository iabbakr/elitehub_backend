const { db, sendPushNotification } = require('../config/firebase');
const axios = require('axios');

const firebaseService = {
    /**
     * PUSH NOTIFICATION
     */
    async sendPushNotification(userId, title, body, data = {}) {
        try {
            const tokenDoc = await db.collection('pushTokens').doc(userId).get();
            if (!tokenDoc.exists) return;

            const { token } = tokenDoc.data();
            const message = {
                to: token,
                sound: 'default',
                title, body, data,
                priority: 'high',
                badge: data.badge || 0
            };

            await axios.post('https://exp.host/--/api/v2/push/send', message);
            console.log(`🔔 Notification sent to user ${userId}`);
        } catch (error) {
            console.error("❌ Push Error:", error.message);
        }
    },

    /**
     * BROADCAST ADMIN ALERT & AUTO-LOCK
     */
    async broadcastAdminAlert(type, message, severity = 'high', userId = null) {
        try {
            // 1. 🛡️ Auto-Lock Kill Switch for Emergency
            if (severity === 'emergency' && userId) {
                await db.collection('wallets').doc(userId).update({
                    isLocked: true,
                    lockReason: `Security: ${type}`,
                    lockedAt: Date.now()
                });
                console.log(`🔒 SECURITY PROTOCOL: Wallet for ${userId} has been locked.`);
            }

            // 2. Log Incident to Firestore
            await db.collection('system_alerts').add({
                type, message, severity, userId,
                timestamp: Date.now(),
                resolved: false
            });

            // 3. Notify Administrators
            const adminSnap = await db.collection('users')
                .where('role', '==', 'admin')
                .get();

            const pushPromises = adminSnap.docs.map(adminDoc => 
                this.sendPushNotification(
                    adminDoc.id, 
                    `🚨 ${severity.toUpperCase()} ALERT: ${type}`, 
                    message, 
                    { screen: "AdminAlerts", severity, userId }
                )
            );

            await Promise.all(pushPromises);
        } catch (error) {
            console.error("Alert/Lock failure:", error.message);
        }
    }
};

module.exports = firebaseService;