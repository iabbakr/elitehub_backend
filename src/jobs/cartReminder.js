// src/jobs/cartReminder.js (Backend Job)
const { db } = require('../config/firebase');
const pushNotificationService = require('../services/push-notification.service');
const cron = require('node-cron');


// For Testing: Run every 5 minutes
// cron.schedule('*/5 * * * *', async () => { ... });

// For Production: Run every hour
//cron.schedule('0 * * * *', async () => { ... });


// Run every hour at the top of the hour
cron.schedule('*/5 * * * *', async () => {
  console.log('📦 Running Abandoned Cart Recovery Job...');
  
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);

  try {
    // 1. Find carts updated between 2 and 3 hours ago
    const abandonedCarts = await db.collection('carts')
      .where('updatedAt', '<=', twoHoursAgo)
      .where('updatedAt', '>', threeHoursAgo)
      .get();

    if (abandonedCarts.empty) return;

    for (const cartDoc of abandonedCarts.docs) {
      const cart = cartDoc.data();
      const userId = cartDoc.id;

      if (!cart.items || cart.items.length === 0) continue;

      // 2. Check if the user placed an order since the cart was last updated
      const recentOrder = await db.collection('orders')
        .where('buyerId', '==', userId)
        .where('createdAt', '>', cart.updatedAt)
        .limit(1)
        .get();

      // 3. If no order found, send the reminder
      if (recentOrder.empty) {
        const firstItem = cart.items[0];
        const remainingCount = cart.items.length - 1;
        const msg = remainingCount > 0 
          ? `Your ${firstItem.name} and ${remainingCount} other items are waiting! 🛒`
          : `Don't forget your ${firstItem.name}! It's still in your cart. 🛒`;

        await pushNotificationService.sendPushToUser(
          userId,
          "Forgot something?",
          msg,
          { screen: "CartTab" }
        );
        
        console.log(`🔔 Sent abandoned cart reminder to user: ${userId}`);
      }
    }
  } catch (error) {
    console.error('❌ Abandoned Cart Job Error:', error);
  }
});