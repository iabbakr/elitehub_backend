// services/push-notification.service.js
// PRODUCTION-GRADE PUSH NOTIFICATION SERVICE
//
// Changes from original:
//  • _getAndIncrementBadgeCount now returns the LIVE count from Firestore
//    so the badge on the device icon is always accurate.
//  • sendPushToUser sets channelId per notification type for Android.
//  • sendOrderAlert is a new method that always routes to OrdersTab and
//    drives the frontend unreadOrderCount via the data payload.
//  • All dispute helpers preserved with improved channelId routing.

const { db, admin } = require('../config/firebase');

// ─── Notification channels (Android) ─────────────────────────────────────────
const CHANNEL_IDS = {
  orders: 'orders',       // order updates
  payments: 'payments',   // wallet / escrow
  disputes: 'disputes',   // dispute alerts
  default: 'default',
};

class PushNotificationService {
  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Atomically increment the Firestore badge count and return the new value.
   * The frontend's Firestore listener (useNotificationStore.syncWithFirestore)
   * picks up the change in real-time and calls setBadgeCountAsync.
   */
  async _getAndIncrementBadgeCount(userId) {
    try {
      const userRef = db.collection('users').doc(userId);

      // Atomic increment
      await userRef.set(
        { notificationCount: admin.firestore.FieldValue.increment(1) },
        { merge: true }
      );

      // Read back the new value
      const snap = await userRef.get();
      return snap.data()?.notificationCount ?? 1;
    } catch (error) {
      console.error('[Push] Badge increment failed:', error);
      return 1;
    }
  }

  /**
   * Fetch the Expo push token for a user from Firestore.
   * Returns null if not found.
   */
  async _getToken(userId) {
    const tokenDoc = await db.collection('pushTokens').doc(userId).get();
    if (!tokenDoc.exists) return null;
    return tokenDoc.data()?.token ?? null;
  }

  /**
   * Fire-and-forget delivery via Expo push gateway.
   */
  async _sendViaExpo(message) {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json();

    if (result.errors) {
      console.error('[Push] Expo API errors:', result.errors);
      return { success: false, errors: result.errors };
    }

    return { success: true, result };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Core send method
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Send a push notification to a single user.
   *
   * @param {string}  userId
   * @param {string}  title
   * @param {string}  body
   * @param {object}  data          - Extra payload for navigation / store updates
   * @param {string}  channelId     - Android notification channel
   */
  async sendPushToUser(userId, title, body, data = {}, channelId = CHANNEL_IDS.default) {
    try {
      const token = await this._getToken(userId);

      if (!token) {
        console.log(`[Push] No token for user ${userId}`);
        return { success: false, reason: 'no_token' };
      }

      const badgeCount = await this._getAndIncrementBadgeCount(userId);

      const message = {
        to: token,
        sound: 'default',
        title,
        body,
        badge: badgeCount,
        data,
        priority: 'high',
        channelId,
      };

      const outcome = await this._sendViaExpo(message);

      if (outcome.success) {
        console.log(`[Push] ✅ Sent to ${userId}: "${title}" (badge=${badgeCount})`);
      }

      return outcome;
    } catch (error) {
      console.error('[Push] sendPushToUser error:', error);
      return { success: false, error: error.message };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Order notifications  ← NEW unified method
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Send an order-related push.
   * The data payload includes `type` so the frontend
   * useNotificationStore.addNotification() can increment unreadOrderCount.
   *
   * @param {string} userId
   * @param {string} type   - One of the OrderNotificationType values
   * @param {string} orderId
   * @param {string} title
   * @param {string} body
   * @param {object} extra  - Additional data merged into the payload
   */
  async sendOrderAlert(userId, type, orderId, title, body, extra = {}) {
    const shortId = orderId.slice(-6).toUpperCase();

    return this.sendPushToUser(
      userId,
      title,
      body,
      {
        screen: 'OrdersTab',
        params: {
          screen: 'OrderDetailScreen',
          params: { orderId },
        },
        type,        // ← frontend reads this to decide if it's an order notification
        orderId,
        shortId,
        ...extra,
      },
      CHANNEL_IDS.orders
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Dispute notifications
  // ──────────────────────────────────────────────────────────────────────────

  async sendDisputeAlert(userId, type, orderId, additionalInfo = {}) {
    const shortId = orderId.slice(-6).toUpperCase();
    let title = '';
    let body = '';

    const baseData = {
      screen: 'OrdersTab',
      params: {
        screen: 'DisputeChatScreen',
        params: { orderId },
      },
      type: 'dispute_message', // default; overridden per case
      orderId,
      disputeType: type,
      ...additionalInfo,
    };

    switch (type) {
      case 'dispute_opened':
        title = '⚠️ Dispute Opened';
        body = `A dispute has been opened for Order #${shortId}`;
        baseData.type = 'dispute_opened';
        break;

      case 'dispute_message':
        title = '💬 New Dispute Message';
        body = `You have a new message regarding Order #${shortId}`;
        baseData.type = 'dispute_message';
        break;

      case 'dispute_resolved_buyer':
        title = '✅ Dispute Resolved';
        body =
          additionalInfo.resolution === 'refund'
            ? `Your refund for Order #${shortId} has been processed`
            : `Payment for Order #${shortId} has been released to seller`;
        baseData.type = 'dispute_resolved';
        baseData.params = { screen: 'OrderDetailScreen', params: { orderId } };
        break;

      case 'dispute_resolved_seller':
        title = '✅ Dispute Resolved';
        body =
          additionalInfo.resolution === 'release'
            ? `Payment for Order #${shortId} has been released to you`
            : `Buyer has been refunded for Order #${shortId}`;
        baseData.type = 'dispute_resolved';
        baseData.params = { screen: 'OrderDetailScreen', params: { orderId } };
        break;

      case 'admin_reviewing':
        title = '👁️ Admin Review';
        body = `Support is now reviewing your dispute for Order #${shortId}`;
        break;

      case 'new_dispute_admin':
        title = '🚨 New Dispute';
        body = `A new dispute has been opened for Order #${shortId}`;
        baseData.params = {
          screen: 'AdminDisputeScreen',
          params: { orderId },
        };
        break;

      case 'reconciliation_offer':
        title = '🤝 Reconciliation Offer';
        body = `${additionalInfo.fromRole} has proposed a solution for Order #${shortId}`;
        break;

      default:
        title = 'Dispute Update';
        body = `Your dispute for Order #${shortId} has been updated`;
    }

    return this.sendPushToUser(userId, title, body, baseData, CHANNEL_IDS.disputes);
  }

  async sendReconciliationNotification(buyerId, sellerId, orderId, proposalDetails) {
    const shortId = orderId.slice(-6).toUpperCase();

    return Promise.allSettled([
      this.sendPushToUser(
        buyerId,
        '🤝 Reconciliation Proposal',
        `Seller proposed: "${proposalDetails.summary}" for Order #${shortId}`,
        {
          screen: 'OrdersTab',
          params: { screen: 'DisputeChatScreen', params: { orderId } },
          type: 'dispute_message',
          orderId,
          proposal: proposalDetails,
        },
        CHANNEL_IDS.disputes
      ),
      this.sendPushToUser(
        sellerId,
        '📝 Proposal Sent',
        `Your reconciliation proposal for Order #${shortId} has been sent to the buyer`,
        {
          screen: 'OrdersTab',
          params: { screen: 'DisputeChatScreen', params: { orderId } },
          type: 'dispute_message',
          orderId,
        },
        CHANNEL_IDS.disputes
      ),
    ]);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Wallet / transaction notifications
  // ──────────────────────────────────────────────────────────────────────────

  async sendTransactionAlert(userId, type, amount, orderId) {
    const shortId = orderId.slice(-6).toUpperCase();
    let title = '';
    let body = '';
    let notifType = 'payment_released';

    if (type === 'completed') {
      title = '💸 Escrow Released';
      body = `Payment for Order #${shortId} has been finalized.`;
      notifType = 'payment_released';
    } else if (type === 'refunded') {
      title = '💰 Refund Successful';
      body = `₦${amount.toLocaleString()} has been credited back to your wallet for Order #${shortId}.`;
      notifType = 'payment_refunded';
    } else {
      title = '💳 Wallet Update';
      body = `Your transaction for Order #${shortId} has been updated.`;
      notifType = 'payment_released';
    }

    return this.sendPushToUser(
      userId,
      title,
      body,
      {
        screen: 'ProfileTab',
        params: { screen: 'Transactions', params: { orderId } },
        type: notifType,
        orderId,
      },
      CHANNEL_IDS.payments
    );
  }

  async sendSellerPayoutAlert(sellerId, amount, orderId) {
    const shortId = orderId.slice(-6).toUpperCase();
    return this.sendPushToUser(
      sellerId,
      '💸 Payment Released',
      `₦${amount.toLocaleString()} for Order #${shortId} is now available in your balance.`,
      {
        screen: 'ProfileTab',
        params: { screen: 'Transactions' },
        type: 'payment_released',
        orderId,
      },
      CHANNEL_IDS.payments
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Bulk helpers
  // ──────────────────────────────────────────────────────────────────────────

  async sendPushToMultipleUsers(userIds, title, body, data = {}, channelId = CHANNEL_IDS.default) {
    const results = await Promise.allSettled(
      userIds.map((id) => this.sendPushToUser(id, title, body, data, channelId))
    );

    const successful = results.filter(
      (r) => r.status === 'fulfilled' && r.value.success
    ).length;

    console.log(`[Push] Bulk: ${successful}/${userIds.length} delivered`);
    return { successful, total: userIds.length };
  }

  async notifyAdminsOfNewDispute(orderId, disputeDetails) {
    try {
      const shortId = orderId.slice(-6).toUpperCase();
      const adminsSnapshot = await db
        .collection('users')
        .where('role', 'in', ['admin', 'support_agent'])
        .get();

      const adminIds = adminsSnapshot.docs.map((doc) => doc.id);
      if (adminIds.length === 0) return;

      await this.sendPushToMultipleUsers(
        adminIds,
        '🚨 New Dispute Opened',
        `Order #${shortId}: ${String(disputeDetails).slice(0, 50)}...`,
        {
          screen: 'OrdersTab',
          params: { screen: 'AdminDisputeScreen', params: { orderId } },
          type: 'dispute_opened',
          orderId,
        },
        CHANNEL_IDS.disputes
      );
    } catch (error) {
      console.error('[Push] notifyAdminsOfNewDispute error:', error);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Badge management
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Reset badge count to 0 in Firestore.
   * The frontend Firestore listener picks this up and calls setBadgeCountAsync(0).
   */
  async clearBadgeCount(userId) {
    try {
      await db.collection('users').doc(userId).update({ notificationCount: 0 });
    } catch (error) {
      console.error('[Push] clearBadgeCount error:', error);
    }
  }
}

module.exports = new PushNotificationService();