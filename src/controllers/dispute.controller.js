const { db } = require('../config/firebase');
const { client: redis } = require('../config/redis');
const cdnService = require('../services/cdn.service');
const walletService = require('../services/wallet.service');
const pushNotificationService = require('../services/push-notification.service');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');

/**
 * 🛡️ ACL MIDDLEWARE
 * Ensures the requester is part of the order or staff
 */
exports.canAccess = catchAsync(async (req, res, next) => {
  const orderId = req.body.orderId || req.params.orderId || req.query.orderId;
  if (!orderId) throw new AppError('OrderId is required', 400);

  const orderDoc = await db.collection('orders').doc(orderId).get();
  if (!orderDoc.exists) throw new AppError('Order not found', 404);
  
  const order = orderDoc.data();
  const isParticipant = order.buyerId === req.userId || order.sellerId === req.userId;
  const isStaff = ['admin', 'support_agent'].includes(req.user.role);

  if (!isParticipant && !isStaff) throw new AppError('Access denied', 403);

  req.order = order;
  next();
});

exports.uploadMedia = catchAsync(async (req, res) => {
  if (!req.file) throw new AppError('No file uploaded', 400);
  const { orderId, uploaderRole } = req.body;

  const result = await cdnService.uploadFile(req.file.buffer, {
    folder: `disputes/${orderId}`,
    resourceType: req.file.mimetype.startsWith('video/') ? 'video' : 'image'
  });

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

  res.json({ success: true, url: result.secure_url });
});

exports.notifyNewMessage = catchAsync(async (req, res) => {
  const { orderId, messageSnippet } = req.body;
  const order = req.order;
  const recipientId = req.userId === order.buyerId ? order.sellerId : order.buyerId;

  await pushNotificationService.sendDisputeAlert(recipientId, 'dispute_message', orderId);
  await pushNotificationService.notifyAdminsOfNewDispute(orderId, messageSnippet);
  res.json({ success: true });
});

exports.getMediaList = catchAsync(async (req, res) => {
  const snapshot = await db.collection('disputeMedia')
    .where('orderId', '==', req.params.orderId)
    .orderBy('createdAt', 'desc').get();

  res.json({ success: true, media: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) });
});

exports.getAllDisputes = catchAsync(async (req, res) => {
  const { status = 'all' } = req.query;
  const cacheKey = `disputes:${status}`;

  const cached = await redis.get(cacheKey);
  if (cached) return res.json({ success: true, ...JSON.parse(cached), cached: true });

  let query = db.collection('orders');
  if (status === 'open') query = query.where('disputeStatus', '==', 'open');
  else if (status === 'resolved') query = query.where('disputeStatus', '==', 'resolved');
  else query = query.where('disputeStatus', 'in', ['open', 'resolved']);

  const snapshot = await query.orderBy('updatedAt', 'desc').limit(100).get();
  const disputes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const result = { 
    disputes, 
    stats: { total: disputes.length, open: disputes.filter(d => d.disputeStatus === 'open').length } 
  };
  
  await redis.setEx(cacheKey, 120, JSON.stringify(result));
  res.json({ success: true, ...result });
});

exports.resolveDispute = catchAsync(async (req, res) => {
  const { orderId, resolution, adminNote } = req.body;
  const lockKey = `dispute:resolve:lock:${orderId}`;

  // 🛡️ Redis Distributed Lock
  const isLocked = await redis.get(lockKey);
  if (isLocked) throw new AppError('Resolution already in progress', 409);
  await redis.setEx(lockKey, 60, 'processing');

  try {
    const orderRef = db.collection('orders').doc(orderId);
    const order = (await orderRef.get()).data();

    if (!order || order.disputeStatus !== 'open') throw new AppError('Dispute not open', 400);

    // Wallet operations
    if (resolution === 'release') {
      await walletService.releaseEscrow(orderId, order.buyerId, order.sellerId, order.totalAmount, order.commission);
    } else {
      await walletService.refundEscrow(orderId, order.buyerId, order.sellerId, order.totalAmount, order.commission, `Admin: ${adminNote}`);
    }

    await orderRef.update({
      disputeStatus: 'resolved',
      adminResolution: resolution,
      adminNotes: adminNote,
      resolvedBy: req.userId,
      status: resolution === 'refund' ? 'cancelled' : 'delivered',
      resolvedAt: Date.now(),
      updatedAt: Date.now()
    });

    await pushNotificationService.sendPushToUser(order.buyerId, "⚖️ Dispute Resolved", resolution === 'refund' ? "Refund processed" : "Payment released");
    await pushNotificationService.sendPushToUser(order.sellerId, "⚖️ Dispute Resolved", resolution === 'release' ? "Escrow funds released" : "Buyer refunded");

    res.json({ success: true, message: `Dispute ${resolution}ed` });
  } finally {
    await redis.del(lockKey);
  }
});

exports.deleteMedia = catchAsync(async (req, res) => {
  const mediaRef = db.collection('disputeMedia').doc(req.params.mediaId);
  const media = (await mediaRef.get()).data();
  if (!media) throw new AppError('Media not found', 404);

  // ✅ Fixed Cloudinary call using cdnService
  await cdnService.deleteFile(media.publicId, media.resourceType);
  await mediaRef.delete();

  res.json({ success: true, message: 'Evidence deleted' });
});