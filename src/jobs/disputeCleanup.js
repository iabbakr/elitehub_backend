const cron = require('node-cron');
const { db, admin } = require('../config/firebase');
const cdnService = require('../services/cdn.service');

/**
 * ✅ DISPUTE CLEANUP JOB
 * Runs every 6 hours to delete resolved dispute chats + media after 24h
 * Reduces Firebase storage costs while maintaining audit trail
 */
class DisputeCleanupService {
  constructor() {
    this.isRunning = false;
  }

  /**
   * Start the cleanup cron job
   */
  start() {
    // Run every 6 hours
    cron.schedule('0 */6 * * *', async () => {
      if (this.isRunning) {
        console.log('⏭️ Cleanup already running, skipping...');
        return;
      }

      try {
        this.isRunning = true;
        console.log('🧹 Starting dispute cleanup...');
        await this.cleanupResolvedDisputes();
      } catch (error) {
        console.error('❌ Cleanup failed:', error);
      } finally {
        this.isRunning = false;
      }
    });

    console.log('✅ Dispute cleanup cron started (runs every 6 hours)');
  }

  /**
   * Main cleanup logic
   */
  async cleanupResolvedDisputes() {
    const now = Date.now();
    const cutoffTime = now - (24 * 60 * 60 * 1000); // 24 hours ago

    // Find resolved disputes past cleanup deadline
    const ordersSnapshot = await db.collection('orders')
      .where('disputeStatus', '==', 'resolved')
      .where('chatCleanupScheduledAt', '<=', now)
      .limit(50) // Process in batches
      .get();

    if (ordersSnapshot.empty) {
      console.log('✅ No disputes to clean up');
      return;
    }

    console.log(`📋 Found ${ordersSnapshot.size} disputes to clean up`);

    const cleanupPromises = ordersSnapshot.docs.map(orderDoc =>
      this.cleanupSingleDispute(orderDoc.id, orderDoc.data())
    );

    const results = await Promise.allSettled(cleanupPromises);

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    console.log(`✅ Cleanup complete: ${succeeded} succeeded, ${failed} failed`);
  }

  /**
   * Cleanup individual dispute
   */
  async cleanupSingleDispute(orderId, orderData) {
    try {
      console.log(`🧹 Cleaning dispute: ${orderId}`);

      // 1. Delete chat messages (subcollection)
      const messagesRef = db.collection('orders').doc(orderId).collection('disputeChat');
      const messagesSnapshot = await messagesRef.get();
      
      const messageDeletions = messagesSnapshot.docs.map(doc => doc.ref.delete());
      await Promise.all(messageDeletions);

      console.log(`  ✓ Deleted ${messagesSnapshot.size} chat messages`);

      // 2. Delete media files from CDN
      const mediaSnapshot = await db.collection('disputeMedia')
        .where('orderId', '==', orderId)
        .get();

      const mediaDeletions = mediaSnapshot.docs.map(async (doc) => {
        const media = doc.data();
        try {
          await cdnService.deleteFile(media.publicId, media.resourceType);
          await doc.ref.delete();
        } catch (error) {
          console.warn(`  ⚠️ Failed to delete media ${doc.id}:`, error.message);
        }
      });

      await Promise.allSettled(mediaDeletions);

      console.log(`  ✓ Deleted ${mediaSnapshot.size} media files`);

      // 3. Update order to mark cleanup complete
      await db.collection('orders').doc(orderId).update({
        chatCleanupCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
        chatCleanupScheduledAt: admin.firestore.FieldValue.delete(),
        disputeChatDeleted: true
      });

      console.log(`  ✅ Dispute ${orderId} cleaned successfully`);

    } catch (error) {
      console.error(`  ❌ Failed to clean dispute ${orderId}:`, error);
      throw error;
    }
  }

  /**
   * Manual cleanup trigger (for admin tools)
   */
  async cleanupSpecificDispute(orderId) {
    const orderDoc = await db.collection('orders').doc(orderId).get();
    
    if (!orderDoc.exists) {
      throw new Error('Order not found');
    }

    const orderData = orderDoc.data();

    if (orderData.disputeStatus !== 'resolved') {
      throw new Error('Can only cleanup resolved disputes');
    }

    await this.cleanupSingleDispute(orderId, orderData);
    
    return { success: true, message: 'Dispute cleaned manually' };
  }
}

const disputeCleanupService = new DisputeCleanupService();

// Auto-start when imported
if (process.env.NODE_ENV === 'production' || process.env.ENABLE_CRON === 'true') {
  disputeCleanupService.start();
}

module.exports = disputeCleanupService;