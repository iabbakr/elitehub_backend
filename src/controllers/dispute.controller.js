const { db, admin } = require('../config/firebase');
const { client: redis } = require('../config/redis');
const cdnService = require('../services/cdn.service');
const walletService = require('../services/wallet.service');
const pushNotificationService = require('../services/push-notification.service');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');

/**
 * ✅ ACL MIDDLEWARE: Verify order participation
 * Allows: Buyer, Seller, Admin, Support Agent
 */
exports.canAccess = catchAsync(async (req, res, next) => {
  const orderId = req.body.orderId || req.params.orderId || req.query.orderId;
  
  if (!orderId) {
    throw new AppError('OrderId is required', 400);
  }

  const orderDoc = await db.collection('orders').doc(orderId).get();
  
  if (!orderDoc.exists) {
    throw new AppError('Order not found', 404);
  }
  
  const order = orderDoc.data();
  const isParticipant = order.buyerId === req.userId || order.sellerId === req.userId;
  const isStaff = ['admin', 'support_agent'].includes(req.userProfile?.role);

  if (!isParticipant && !isStaff) {
    throw new AppError('Access denied to this dispute', 403);
  }

  req.order = order;
  req.orderId = orderId;
  next();
});

/**
 * ✅ UPLOAD MEDIA/EVIDENCE
 * Stores in Cloudinary with dispute folder structure
 */
exports.uploadMedia = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new AppError('No file uploaded', 400);
  }

  const { orderId } = req.body;
  const uploaderRole = req.userProfile.role;

  // Prevent uploads to resolved disputes
  const orderRef = db.collection('orders').doc(orderId);
  const order = (await orderRef.get()).data();
  
  if (order.disputeStatus === 'resolved') {
    throw new AppError('Cannot upload to resolved disputes', 400);
  }

  // Upload to CDN
  const result = await cdnService.uploadFile(req.file.buffer, {
    folder: `disputes/${orderId}`,
    resourceType: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
    transformation: req.file.mimetype.startsWith('image/') ? [
      { width: 1200, quality: 'auto:good', fetch_format: 'auto' }
    ] : null
  });

  // Store metadata in Firestore
  const mediaRef = await db.collection('disputeMedia').add({
    orderId,
    url: result.secure_url,
    publicId: result.public_id,
    uploadedBy: req.userId,
    uploaderRole,
    uploaderName: req.userProfile.name,
    resourceType: result.resource_type,
    mimeType: req.file.mimetype,
    fileSize: req.file.size,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: Date.now() + (48 * 60 * 60 * 1000) // 48 hours for cleanup
  });

  // Update order to track evidence submission
  await orderRef.update({
    lastEvidenceUploadAt: admin.firestore.FieldValue.serverTimestamp(),
    evidenceCount: admin.firestore.FieldValue.increment(1)
  });

  res.json({ 
    success: true, 
    url: result.secure_url,
    mediaId: mediaRef.id 
  });
});

/**
 * ✅ NOTIFY NEW MESSAGE
 * Triggers push notifications to other party + admins
 */
exports.notifyNewMessage = catchAsync(async (req, res) => {
  const { orderId, messageSnippet } = req.body;
  const order = req.order;
  const senderId = req.userId;
  const senderRole = req.userProfile.role;

  // Determine recipients based on sender
  const recipients = [];
  
  if (senderRole === 'admin' || senderRole === 'support_agent') {
    // Admin message → notify buyer and seller
    recipients.push(order.buyerId, order.sellerId);
  } else {
    // User message → notify other party + all staff
    const otherParty = senderId === order.buyerId ? order.sellerId : order.buyerId;
    recipients.push(otherParty);
    
    // Notify all admins/support
    const staffSnapshot = await db.collection('users')
      .where('role', 'in', ['admin', 'support_agent'])
      .get();
    
    staffSnapshot.docs.forEach(doc => recipients.push(doc.id));
  }

  // Send push notifications
  const uniqueRecipients = [...new Set(recipients)].filter(id => id !== senderId);
  
  await Promise.allSettled(
    uniqueRecipients.map(recipientId =>
      pushNotificationService.sendDisputeAlert(
        recipientId,
        'dispute_message',
        orderId,
        { messageSnippet }
      )
    )
  );

  res.json({ success: true, notifiedCount: uniqueRecipients.length });
});

/**
 * ✅ GET MEDIA LIST
 * Returns all evidence for a dispute
 */
exports.getMediaList = catchAsync(async (req, res) => {
  const { orderId } = req.params;

  const snapshot = await db.collection('disputeMedia')
    .where('orderId', '==', orderId)
    .orderBy('createdAt', 'desc')
    .get();

  const media = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
    createdAt: doc.data().createdAt?.toMillis() || Date.now()
  }));

  res.json({ success: true, media });
});

exports.openDispute = catchAsync(async (req, res) => {
  const { orderId, reason, details } = req.body;
  const orderRef = db.collection('orders').doc(orderId);
  const order = (await orderRef.get()).data();

  // Guard: Only buyer can open dispute, and only if order is 'running'
  if (order.buyerId !== req.userId) throw new AppError('Only buyers can open disputes', 403);
  if (order.status !== 'running') throw new AppError('Can only dispute active orders', 400);

  await orderRef.update({
    disputeStatus: 'open',
    disputeReason: reason,
    disputeDetails: details,
    disputedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Notify Seller and Admins
  await pushNotificationService.sendDisputeAlert(order.sellerId, 'dispute_opened', orderId);

  res.json({ success: true, message: 'Dispute opened successfully' });
});

/**
 * ✅ GET DISPUTE STATUS
 * Returns current status and metadata
 */
exports.getDisputeStatus = catchAsync(async (req, res) => {
  const { orderId } = req.params;
  
  const orderDoc = await db.collection('orders').doc(orderId).get();
  const order = orderDoc.data();

  res.json({
    success: true,
    status: order.disputeStatus,
    resolution: order.adminResolution || null,
    resolvedBy: order.resolvedBy || null,
    resolvedAt: order.resolvedAt || null,
    adminNotes: order.adminNotes || null
  });
});

/**
 * ✅ GET ALL DISPUTES (Admin Dashboard)
 * Cached with Redis for performance
 */
exports.getAllDisputes = catchAsync(async (req, res) => {
  const { status = 'all' } = req.query;
  const cacheKey = `disputes:list:${status}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json({ 
      success: true, 
      ...JSON.parse(cached), 
      cached: true 
    });
  }

  // Build query
  let query = db.collection('orders');
  
  if (status === 'open') {
    query = query.where('disputeStatus', '==', 'open');
  } else if (status === 'resolved') {
    query = query.where('disputeStatus', '==', 'resolved');
  } else {
    query = query.where('disputeStatus', 'in', ['open', 'resolved']);
  }

  const snapshot = await query
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get();

  const disputes = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
    createdAt: doc.data().createdAt,
    updatedAt: doc.data().updatedAt
  }));

  // Calculate stats
  const stats = {
    total: disputes.length,
    open: disputes.filter(d => d.disputeStatus === 'open').length,
    resolved: disputes.filter(d => d.disputeStatus === 'resolved').length,
    avgResolutionTime: calculateAvgResolutionTime(disputes)
  };

  const result = { disputes, stats };
  
  // Cache for 2 minutes
  await redis.setEx(cacheKey, 120, JSON.stringify(result));

  res.json({ success: true, ...result });
});

/**
 * ✅ RESOLVE DISPUTE (ATOMIC)
 * Handles wallet refund/release + chat cleanup scheduling
 */
exports.resolveDispute = catchAsync(async (req, res) => {
  const { orderId, resolution, adminNote } = req.body;
  const adminId = req.userId;
  const adminName = req.userProfile.name;

  if (!['release', 'refund'].includes(resolution)) {
    throw new AppError('Invalid resolution type', 400);
  }

  const lockKey = `dispute:resolve:lock:${orderId}`;
  const isLocked = await redis.get(lockKey);
  if (isLocked) throw new AppError('Resolution already in progress', 409);
  
  await redis.setEx(lockKey, 60, 'processing');

  try {
    // RUN ATOMIC TRANSACTION
    const result = await db.runTransaction(async (transaction) => {
      const orderRef = db.collection('orders').doc(orderId);
      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists) throw new Error('Order not found');
      const order = orderSnap.data();

      if (order.disputeStatus !== 'open') throw new Error('Dispute is not open');

      // 1. Execute Wallet Operation via Service
      // Note: We pass the 'transaction' object into the wallet service 
      // so it becomes part of this atomic block.
      if (resolution === 'release') {
        await walletService.releaseEscrowAtomic(transaction, order);
      } else {
        await walletService.refundEscrowAtomic(transaction, order, adminNote);
      }

      // 2. Update Order Status
      transaction.update(orderRef, {
        disputeStatus: 'resolved',
        adminResolution: resolution,
        adminNotes: adminNote,
        resolvedBy: adminId,
        resolvedByName: adminName,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: resolution === 'refund' ? 'cancelled' : 'delivered',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        chatCleanupScheduledAt: Date.now() + (24 * 60 * 60 * 1000)
      });

      // 3. Log to Audit Trail
      const auditRef = db.collection('disputeResolutions').doc();
      transaction.set(auditRef, {
        orderId,
        resolution,
        adminId,
        adminName,
        adminNote,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return { buyerId: order.buyerId, sellerId: order.sellerId };
    });

    // --- Post-Transaction (Non-blocking) ---
    await Promise.allSettled([
      pushNotificationService.sendDisputeAlert(result.buyerId, 'dispute_resolved', orderId, { resolution }),
      pushNotificationService.sendDisputeAlert(result.sellerId, 'dispute_resolved', orderId, { resolution }),
      redis.del('disputes:list:all', 'disputes:list:open', 'disputes:list:resolved')
    ]);

    res.json({ success: true, message: `Dispute resolved via ${resolution}` });

  } catch (error) {
    console.error('Resolution Transaction Failed:', error);
    throw new AppError(error.message || 'Transaction failed', 500);
  } finally {
    await redis.del(lockKey);
  }
});

/**
 * ✅ DELETE MEDIA
 * Removes evidence from CDN and Firestore
 */
exports.deleteMedia = catchAsync(async (req, res) => {
  const { mediaId } = req.params;

  const mediaRef = db.collection('disputeMedia').doc(mediaId);
  const mediaDoc = await mediaRef.get();

  if (!mediaDoc.exists) {
    throw new AppError('Media not found', 404);
  }

  const media = mediaDoc.data();

  // Delete from Cloudinary
  await cdnService.deleteFile(media.publicId, media.resourceType);

  // Delete from Firestore
  await mediaRef.delete();

  res.json({ success: true, message: 'Evidence deleted successfully' });
});

/**
 * ✅ GET RESOLUTION AUDIT LOG
 * Returns resolution history for compliance
 */
exports.getResolutionAuditLog = catchAsync(async (req, res) => {
  const { orderId, startDate, endDate, limit = 100 } = req.query;

  let query = db.collection('disputeResolutions');

  if (orderId) {
    query = query.where('orderId', '==', orderId);
  }

  if (startDate) {
    query = query.where('timestamp', '>=', new Date(startDate));
  }

  if (endDate) {
    query = query.where('timestamp', '<=', new Date(endDate));
  }

  const snapshot = await query
    .orderBy('timestamp', 'desc')
    .limit(parseInt(limit))
    .get();

  const resolutions = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
    timestamp: doc.data().timestamp?.toMillis() || Date.now()
  }));

  res.json({ success: true, resolutions, count: resolutions.length });
});

/**
 * HELPER: Calculate average resolution time
 */
function calculateAvgResolutionTime(disputes) {
  const resolved = disputes.filter(d => d.disputeStatus === 'resolved' && d.resolvedAt);
  
  if (resolved.length === 0) return 0;

  const total = resolved.reduce((sum, d) => {
    const duration = d.resolvedAt - d.createdAt;
    return sum + duration;
  }, 0);

  return Math.round(total / resolved.length / (1000 * 60 * 60)); // Hours
}

module.exports = exports;