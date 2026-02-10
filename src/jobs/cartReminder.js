const { db } = require('../config/firebase');
const pushNotificationService = require('../services/push-notification.service');
const cron = require('node-cron');

// Run every 5 minutes (Testing Mode)
cron.schedule('*/5 * * * *', async () => {
  console.log('📦 Running Abandoned Cart Recovery Job...');
  
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);

  try {
    // 1. Find carts updated in the window that haven't received a reminder yet
    const abandonedCarts = await db.collection('carts')
      .where('updatedAt', '<=', twoHoursAgo)
      .where('updatedAt', '>', threeHoursAgo)
      .where('lastReminderSent', '==', null) // 🛡️ Ensure we don't double-notify
      .get();

    if (abandonedCarts.empty) {
      console.log('✅ No abandoned carts found in this window.');
      return;
    }

    for (const cartDoc of abandonedCarts.docs) {
      const cart = cartDoc.data();
      const userId = cartDoc.id;

      if (!cart.items || cart.items.length === 0) continue;

      // 2. Double-check if the user placed an order since the cart was last updated
      const recentOrder = await db.collection('orders')
        .where('buyerId', '==', userId)
        .where('createdAt', '>', cart.updatedAt)
        .limit(1)
        .get();

      // 3. Send reminder if no recent order exists
      if (recentOrder.empty) {
        const firstItem = cart.items[0];
        const remainingCount = cart.items.length - 1;
        const msg = remainingCount > 0 
          ? `Your ${firstItem.name} and ${remainingCount} other items are waiting! 🛒`
          : `Don't forget your ${firstItem.name}! It's still in your cart. 🛒`;

        // A. Dispatch the notification
        await pushNotificationService.sendPushToUser(
          userId,
          "Forgot something?",
          msg,
          { screen: "CartTab" }
        );
        
        // B. ✅ CRITICAL: Update the doc so 'lastReminderSent' is no longer null
        await cartDoc.ref.update({ 
          lastReminderSent: Date.now() 
        });
        
        console.log(`🔔 Sent abandoned cart reminder to user: ${userId}`);
      }
    }
  } catch (error) {
    console.error('❌ Abandoned Cart Job Error:', error);
  }
});