// src/controllers/activity.controller.js
const { db, admin } = require('../config/firebase');
const catchAsync = require('../utils/catchAsync');

exports.logActivity = catchAsync(async (req, res) => {
  const { eventType, entityId, metadata } = req.body;
  const userId = req.userId;

  if (!userId) return res.status(401).send();

  const activityData = {
    userId,
    eventType,
    entityId,
    metadata: metadata || {},
    timestamp: Date.now()
  };

  // 1. Log the raw activity (essential for analytics)
  // We use the collection reference to add a new document
  await db.collection('activityLogs').add(activityData);

  // 2. 🛡️ SMART INTEREST UPDATE
  if (eventType === 'product_view' && metadata?.category) {
    const userRef = db.collection('users').doc(userId);
    
    // Check if this is a repeat interest (Viewed > 1 time)
    const recentViews = await db.collection('activityLogs')
      .where('userId', '==', userId)
      .where('eventType', '==', 'product_view')
      .where('metadata.category', '==', metadata.category)
      .limit(2) 
      .get();

    // Only add to interests if they've interacted with this category at least twice
    if (recentViews.size >= 2) {
      await userRef.update({
        interests: admin.firestore.FieldValue.arrayUnion(metadata.category),
        updatedAt: Date.now()
      });
    }
  }

  // 3. 🏁 Standard 204 response for tracking pixels/logs
  res.status(204).send();
});