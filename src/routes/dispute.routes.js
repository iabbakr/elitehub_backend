// routes/dispute.routes.js - PRODUCTION GRADE DISPUTE SYSTEM
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate, adminOrSupport } = require('../middleware/auth');
const { db } = require('../config/firebase');
const { client } = require('../config/redis');
const cdnService = require('../services/cdn.service'); // ✅ This matches your file
const walletService = require('../services/wallet.service');
const pushNotificationService = require('../services/push-notification.service');
const catchAsync = require('../utils/catchAsync');

// --- 1. MIDDLEWARE (Must be defined BEFORE routes) ---

/**
 * Ensures the requester is the Buyer, Seller, or an Admin/Support staff
 */
const canAccessDispute = catchAsync(async (req, res, next) => {
  const orderId = req.body.orderId || req.params.orderId || req.query.orderId;
  
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'OrderId is required' });
  }

  const orderDoc = await db.collection('orders').doc(orderId).get();
  if (!orderDoc.exists) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }
  
  const order = orderDoc.data();
  const isParticipant = order.buyerId === req.userId || order.sellerId === req.userId;
  const isStaff = ['admin', 'support_agent'].includes(req.user.role);

  if (!isParticipant && !isStaff) {
    return res.status(403).json({ success: false, message: 'Access denied to this dispute' });
  }

  // Save the order to the request object for use in routes
  req.order = order;
  next();
});

// Multer configuration
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf', 'application/msword'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// --- 2. PUBLIC PARTICIPANT ROUTES (Buyer, Seller, & Admin) ---

/**
 * POST /api/v1/disputes/upload-media
 * ✅ Upload evidence for the dispute
 */
/**
 * POST /api/v1/disputes/upload-media
 */
router.post('/upload-media', authenticate, canAccessDispute, upload.single('file'), catchAsync(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const { orderId, uploaderRole } = req.body;

  // ✅ Use your cdnService instead of the raw Promise wrapper
  const result = await cdnService.uploadFile(req.file.buffer, {
    folder: `disputes/${orderId}`,
    resourceType: req.file.mimetype.startsWith('video/') ? 'video' : 
                  req.file.mimetype.startsWith('image/') ? 'image' : 'raw'
  });

  // Save reference to Firestore
  await db.collection('disputeMedia').add({
    orderId,
    url: result.secure_url,
    publicId: result.public_id,
    uploadedBy: req.userId,
    uploaderRole,
    resourceType: result.resource_type,
    mimeType: req.file.mimetype,
    createdAt: Date.now()
  });

  res.json({
    success: true,
    url: result.secure_url,
    publicId: result.public_id,
    mimeType: req.file.mimetype
  });
}));

/**
 * POST /api/v1/disputes/notify-message
 * ✅ Triggers push notifications when a participant sends a chat message
 */
router.post('/notify-message', authenticate, canAccessDispute, catchAsync(async (req, res) => {
  const { orderId, messageSnippet } = req.body;
  const order = req.order;

  // Determine recipient (the person who is NOT the sender)
  const recipientId = req.userId === order.buyerId ? order.sellerId : order.buyerId;

  // Notify the other party
  await pushNotificationService.sendDisputeAlert(recipientId, 'dispute_message', orderId);
  
  // Notify admins that there is new activity
  await pushNotificationService.notifyAdminsOfNewDispute(orderId, messageSnippet || "New message in dispute chat");

  res.json({ success: true });
}));

/**
 * GET /api/v1/disputes/:orderId/media
 * ✅ Get evidence list for participants
 */
router.get('/:orderId/media', authenticate, canAccessDispute, catchAsync(async (req, res) => {
  const { orderId } = req.params;

  const snapshot = await db.collection('disputeMedia')
    .where('orderId', '==', orderId)
    .orderBy('createdAt', 'desc')
    .get();

  const media = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  res.json({ success: true, media });
}));

// --- 3. ADMIN & SUPPORT ONLY ROUTES ---

router.use(authenticate, adminOrSupport);

/**
 * GET /api/v1/disputes
 * ✅ Get all disputes for admin dashboard
 */
router.get('/', catchAsync(async (req, res) => {
  const { status = 'all' } = req.query;
  const cacheKey = `disputes:${status}`;

  const cached = await client.get(cacheKey);
  if (cached) {
    const data = JSON.parse(cached);
    return res.json({ success: true, ...data, cached: true });
  }

  let query = db.collection('orders');
  if (status === 'open') query = query.where('disputeStatus', '==', 'open');
  else if (status === 'resolved') query = query.where('disputeStatus', '==', 'resolved');
  else query = query.where('disputeStatus', 'in', ['open', 'resolved']);

  const snapshot = await query.orderBy('updatedAt', 'desc').limit(100).get();
  const disputes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const stats = {
    total: disputes.length,
    open: disputes.filter(d => d.disputeStatus === 'open').length,
    resolved: disputes.filter(d => d.disputeStatus === 'resolved').length,
  };

  const result = { disputes, stats };
  await client.setEx(cacheKey, 120, JSON.stringify(result));

  res.json({ success: true, ...result });
}));

/**
 * POST /api/v1/disputes/resolve
 * ✅ Atomic resolution (Refund or Release)
 */
router.post('/resolve', catchAsync(async (req, res) => {
  const { orderId, resolution, adminNote } = req.body;
  const lockKey = `dispute:resolve:${orderId}`;

  if (!orderId || !['release', 'refund'].includes(resolution) || !adminNote) {
    return res.status(400).json({ success: false, message: 'Invalid resolution data' });
  }

  const isProcessed = await client.get(lockKey);
  if (isProcessed) return res.status(409).json({ success: true, message: 'Already resolved' });

  await client.setEx(lockKey, 30, 'processing');

  const orderDoc = await db.collection('orders').doc(orderId).get();
  const order = orderDoc.data();

  if (!order || order.disputeStatus !== 'open') {
    await client.del(lockKey);
    return res.status(400).json({ success: false, message: 'No open dispute found' });
  }

  if (resolution === 'release') {
    await walletService.releaseEscrow(orderId, order.buyerId, order.sellerId, order.totalAmount, order.commission);
  } else {
    await walletService.refundEscrow(orderId, order.buyerId, order.sellerId, order.totalAmount, order.commission, `Admin: ${adminNote}`);
  }

  await db.collection('orders').doc(orderId).update({
    disputeStatus: 'resolved',
    adminResolution: resolution,
    adminNotes: adminNote.trim(),
    resolvedBy: req.userId,
    resolvedAt: Date.now(),
    updatedAt: Date.now()
  });

  // Push Notifications
  await pushNotificationService.sendPushToUser(order.buyerId, "⚖️ Dispute Resolved", resolution === 'refund' ? "Refund processed" : "Payment released");
  await pushNotificationService.sendPushToUser(order.sellerId, "⚖️ Dispute Resolved", resolution === 'release' ? "Payment released to you" : "Buyer refunded");

  await client.setEx(lockKey, 86400, 'completed');
  res.json({ success: true, message: `Dispute resolved via ${resolution}` });
}));

/**
 * DELETE /api/v1/disputes/media/:mediaId
 * ✅ Delete malicious or incorrect evidence
 */
router.delete('/media/:mediaId', catchAsync(async (req, res) => {
  const { mediaId } = req.params;
  const mediaDoc = await db.collection('disputeMedia').doc(mediaId).get();
  
  if (!mediaDoc.exists) return res.status(404).json({ success: false, message: 'Media not found' });

  const mediaData = mediaDoc.data();
  await cloudinary.uploader.destroy(mediaData.publicId, { resource_type: mediaData.resourceType });
  await db.collection('disputeMedia').doc(mediaId).delete();

  res.json({ success: true, message: 'Media deleted' });
}));

module.exports = router;