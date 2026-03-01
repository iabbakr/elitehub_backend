/**
 * controllers/support.controller.js
 *
 * Production-grade support chat controller.
 *
 * New additions (zero breaking changes):
 *  - POST /chats/:chatId/message   — send message + push notification to recipient
 *  - POST /chats/upload-media      — Cloudinary upload (image, video, document)
 *  - GET  /chats/:chatId/messages  — paginated message history
 *
 * Best-practice push notification pattern:
 *  - Uses FCM v1 HTTP API via firebase-admin
 *  - Notification token stored on user profile document
 *  - Graceful fallback: if token missing or stale, silently skips
 *  - Deduplication: does NOT notify the sender
 */

const { db, admin } = require('../config/firebase');
const { client: redis } = require('../config/redis');
const catchAsync = require('../utils/catchAsync');
const AppError   = require('../utils/AppError');
const cloudinary = require('../config/cloudinary');   // require your configured cloudinary instance
const multer     = require('multer');
const path       = require('path');

// ── Multer config (memory storage — stream directly to Cloudinary) ───────────
const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      // React Native iOS sends this for .mp4/.mov — we detect real type by extension
      'application/octet-stream',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new AppError(`File type not allowed: ${file.mimetype}`, 400));
  },
});
exports.uploadMiddleware = upload.single('file');

// ── Push notification helper ─────────────────────────────────────────────────
/**
 * sendPushNotification
 *
 * Best practice FCM pattern:
 *  1. Fetch recipient's FCM token from Firestore (cached in Redis for 5 min)
 *  2. Send via firebase-admin messaging (handles token refresh internally)
 *  3. On invalid token (registration-not-found / not-registered): prune token from Firestore
 *  4. Never throw — push is non-blocking fire-and-forget
 */
async function sendPushNotification({ recipientUserId, title, body, data = {} }) {
  try {
    // 1. Token lookup: Redis cache → Firestore
    const cacheKey = `fcm_token:${recipientUserId}`;
    let token = await redis.get(cacheKey);

    if (!token) {
      const userSnap = await db.collection('users').doc(recipientUserId).get();
      if (!userSnap.exists) return;
      token = userSnap.data()?.fcmToken;
      if (!token) return; // user hasn't granted notification permission
      await redis.set(cacheKey, token, { EX: 300 }); // cache 5 min
    }

    // 2. Send
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'support_chat' },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    });
  } catch (err) {
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      // Prune stale token
      await db.collection('users').doc(recipientUserId).update({ fcmToken: admin.firestore.FieldValue.delete() });
      await redis.del(`fcm_token:${recipientUserId}`);
    }
    // Never throw — push is best-effort
    console.error('Push notification failed (non-fatal):', err.code || err.message);
  }
}

// ── 1. POST /chats/init ──────────────────────────────────────────────────────
/**
 * Initialize a new support chat session.
 * Guards against duplicate sessions via Redis.
 */
exports.initChat = catchAsync(async (req, res, next) => {
  const { subject, initialMessage } = req.body;
  const userId = req.userId;

  if (!subject?.trim() || !initialMessage?.trim()) {
    return next(new AppError('subject and initialMessage are required', 400));
  }

  // Redis gatekeeper: one active session per user
  const activeChatKey  = `active_support_chat:${userId}`;
  const existingChatId = await redis.get(activeChatKey);
  if (existingChatId) {
    return next(new AppError('You already have an active support session.', 400));
  }

  // Atomic Firestore batch
  const chatRef = db.collection('supportChats').doc();
  const chatId  = chatRef.id;

  const chatData = {
    id:              chatId,
    userId,
    userName:        req.userProfile?.name || 'User',
    userRole:        req.userProfile?.role || 'buyer',
    userEmail:       req.userProfile?.email || '',
    userAvatar:      req.userProfile?.imageUrl || null,
    status:          'waiting',
    subject:         subject.trim(),
    unreadCount:     0,
    adminUnreadCount:1,
    totalMessages:   1,
    createdAt:       Date.now(),
    lastMessage:     initialMessage.substring(0, 100),
    lastMessageTime: Date.now(),
    rating:          null,
    queuePosition:   null,
  };

  const batch     = db.batch();
  const msgRef    = chatRef.collection('messages').doc();

  batch.set(chatRef, chatData);
  batch.set(msgRef, {
    id:          msgRef.id,
    chatId,
    senderId:    userId,
    senderRole:  req.userProfile?.role || 'buyer',
    senderName:  req.userProfile?.name || 'User',
    senderAvatar:req.userProfile?.imageUrl || null,
    message:     initialMessage.trim(),
    messageType: 'text',
    timestamp:   Date.now(),
    isRead:      false,
  });

  await batch.commit();

  // Redis queue + session lock (24h TTL)
  await redis.lPush('support_queue', chatId);
  await redis.set(activeChatKey, chatId, { EX: 86400 });

  // Push to all admins/agents (fire-and-forget)
  _notifyAvailableAgents(req.userProfile?.name || 'A user', subject.trim()).catch(() => {});

  res.status(201).json({ success: true, chatId, message: 'Support request queued' });
});

/**
 * Notify all online support agents of new waiting chat.
 * We query agents with role admin/support_agent who have an FCM token.
 * Capped at 10 to avoid fan-out overload on large teams.
 */
async function _notifyAvailableAgents(userName, subject) {
  const snap = await db.collection('users')
    .where('role', 'in', ['admin', 'support_agent'])
    .where('fcmToken', '!=', null)
    .limit(10)
    .get();

  await Promise.allSettled(snap.docs.map(doc =>
    sendPushNotification({
      recipientUserId: doc.id,
      title: '🟡 New Support Request',
      body:  `${userName}: "${subject.substring(0, 60)}"`,
      data:  { type: 'new_support_chat' },
    }),
  ));
}

// ── 2. PATCH /chats/:chatId/assign ───────────────────────────────────────────
exports.assignChat = catchAsync(async (req, res, next) => {
  const { chatId } = req.params;
  const adminId    = req.userId;

  const chatRef = db.collection('supportChats').doc(chatId);
  const chatDoc = await chatRef.get();

  if (!chatDoc.exists) return next(new AppError('Chat not found', 404));
  const chatData = chatDoc.data();

  if (chatData.status !== 'waiting') {
    return next(new AppError('Chat is already active or resolved', 400));
  }

  await chatRef.update({
    status:            'active',
    assignedAdminId:   adminId,
    assignedAdminName: req.userProfile?.name || 'Agent',
    assignedAdminAvatar: req.userProfile?.imageUrl || null,
    updatedAt:         Date.now(),
  });

  // Remove from Redis queue
  await redis.lRem('support_queue', 0, chatId);

  // Push notification to user: their chat has been assigned
  await sendPushNotification({
    recipientUserId: chatData.userId,
    title: '✅ Support Agent Connected',
    body:  `${req.userProfile?.name || 'A support agent'} has joined your chat.`,
    data:  { type: 'chat_assigned', chatId },
  });

  res.status(200).json({ success: true, message: 'Chat assigned successfully' });
});

// ── 3. POST /chats/:chatId/resolve ───────────────────────────────────────────
exports.resolveChat = catchAsync(async (req, res, next) => {
  const { chatId }        = req.params;
  const { rating, feedback, notes } = req.body;

  const chatRef = db.collection('supportChats').doc(chatId);
  const chatDoc = await chatRef.get();
  if (!chatDoc.exists) return next(new AppError('Chat not found', 404));
  const chatData = chatDoc.data();

  await chatRef.update({
    status:     'resolved',
    resolvedAt: Date.now(),
    updatedAt:  Date.now(),
    rating:     rating  || null,
    feedback:   feedback || null,
    adminNotes: notes   || null,
  });

  // Clear Redis session lock so user can start a new chat
  await redis.del(`active_support_chat:${chatData.userId}`);

  // Push to user: chat resolved — prompt rating
  await sendPushNotification({
    recipientUserId: chatData.userId,
    title: '🎉 Chat Resolved',
    body:  'Your support request has been resolved. Tap to rate your experience.',
    data:  { type: 'chat_resolved', chatId },
  });

  res.status(200).json({ success: true, message: 'Support session closed' });
});

// ── 4. GET /chats/status ─────────────────────────────────────────────────────
exports.getChatStatus = catchAsync(async (req, res) => {
  const userId        = req.userId;
  const activeChatKey = `active_support_chat:${userId}`;
  const chatId        = await redis.get(activeChatKey);

  if (!chatId) return res.json({ success: true, active: false });

  const queue    = await redis.lRange('support_queue', 0, -1);
  const position = queue.indexOf(chatId) + 1;

  // Fetch latest chat doc for richer response
  let chatSnap;
  try {
    chatSnap = await db.collection('supportChats').doc(chatId).get();
  } catch { chatSnap = null; }

  const chatData = chatSnap?.data();

  res.json({
    success:       true,
    active:        true,
    chatId,
    queuePosition: position > 0 ? position : 0,
    status:        position > 0 ? 'waiting' : 'active',
    assignedAdminName: chatData?.assignedAdminName || null,
    subject:           chatData?.subject || null,
    estimatedWaitTime: position > 0 ? Math.max(1, position * 3) : 0, // rough 3 min/position
  });
});

// ── 5. POST /chats/:chatId/message ───────────────────────────────────────────
/**
 * Server-side message send with push notification.
 *
 * The client can also write directly to Firestore via supportChatService,
 * but this endpoint should be called when you need server-side push delivery.
 *
 * Best practice: call this from the mobile app INSTEAD of writing to Firestore
 * directly, so push is guaranteed even when the app is backgrounded.
 */
exports.sendMessage = catchAsync(async (req, res, next) => {
  const { chatId }     = req.params;
  const { message, messageType = 'text', attachments } = req.body;
  const senderId       = req.userId;

  if (!message?.trim() && (!attachments || attachments.length === 0)) {
    return next(new AppError('message or attachments required', 400));
  }

  // Validate message type
  const validTypes = ['text', 'image', 'video', 'file'];
  if (!validTypes.includes(messageType)) {
    return next(new AppError(`messageType must be one of: ${validTypes.join(', ')}`, 400));
  }

  const chatRef = db.collection('supportChats').doc(chatId);
  const chatDoc = await chatRef.get();
  if (!chatDoc.exists) return next(new AppError('Chat not found', 404));
  const chatData = chatDoc.data();

  if (chatData.status === 'resolved' || chatData.status === 'closed') {
    return next(new AppError('Cannot send messages to a closed chat', 400));
  }

  // Write message to Firestore subcollection
  const msgRef = chatRef.collection('messages').doc();
  const senderRole = req.userProfile?.role || 'user';
  const isAdmin    = ['admin', 'support_agent'].includes(senderRole);

  const msgData = {
    id:          msgRef.id,
    chatId,
    senderId,
    senderRole,
    senderName:  req.userProfile?.name || 'User',
    senderAvatar: req.userProfile?.imageUrl || null,
    message:     message?.trim() || (messageType === 'text' ? '' : `Sent a ${messageType}`),
    messageType,
    attachments:  attachments || [],
    timestamp:    Date.now(),
    isRead:       false,
  };

  // Batch: write message + update chat meta
  const batch = db.batch();
  batch.set(msgRef, msgData);
  batch.update(chatRef, {
    lastMessage:      messageType === 'text'
      ? (message?.substring(0, 100) || '')
      : `📎 Sent a ${messageType}`,
    lastMessageTime:  Date.now(),
    totalMessages:    admin.firestore.FieldValue.increment(1),
    // Increment the OTHER party's unread counter
    ...(isAdmin
      ? { unreadCount: admin.firestore.FieldValue.increment(1) }
      : { adminUnreadCount: admin.firestore.FieldValue.increment(1) }
    ),
  });
  await batch.commit();

  // Push to recipient (fire-and-forget)
  const recipientId = isAdmin ? chatData.userId : chatData.assignedAdminId;
  if (recipientId && recipientId !== senderId) {
    const senderName = req.userProfile?.name || (isAdmin ? 'Support' : 'User');
    const pushBody   = messageType === 'text'
      ? (message?.substring(0, 80) || '')
      : `📎 Sent a ${messageType}`;
    sendPushNotification({
      recipientUserId: recipientId,
      title:           `💬 ${senderName}`,
      body:            pushBody,
      data:            { type: 'new_message', chatId, messageType },
    }).catch(() => {});
  }

  res.status(201).json({ success: true, messageId: msgRef.id });
});

// ── 6. POST /chats/upload-media ──────────────────────────────────────────────
/**
 * Upload image / video / document to Cloudinary.
 * Returns { success, url, publicId, resourceType, mimeType }
 *
 * Mount multer middleware in routes:
 *   router.post('/chats/upload-media', authenticate, supportController.uploadMiddleware, supportController.uploadMedia)
 */
exports.uploadMedia = catchAsync(async (req, res, next) => {
  if (!req.file) return next(new AppError('No file provided', 400));

  const { originalname, buffer } = req.file;
  let { mimetype } = req.file;

  // React Native iOS sometimes sends 'application/octet-stream' for .mp4 / .mov.
  // Fall back to extension-based detection so Cloudinary gets the right resource_type.
  if (!mimetype || mimetype === 'application/octet-stream') {
    const ext = path.extname(originalname).toLowerCase();
    const extMap = {
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp',
      '.pdf': 'application/pdf',
    };
    mimetype = extMap[ext] || mimetype;
  }

  const isImage    = mimetype.startsWith('image/');
  const isVideo    = mimetype.startsWith('video/');
  const resourceType = isImage ? 'image' : isVideo ? 'video' : 'raw';

  // Stream buffer to Cloudinary
  const uploadResult = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        folder:        'support_chats',
        public_id:     `${Date.now()}_${path.parse(originalname).name}`,
        overwrite:     false,
        // Auto-quality + auto-format for images
        ...(isImage && { quality: 'auto', fetch_format: 'auto' }),
        // Cap video bitrate to keep uploads reasonable
        ...(isVideo && { video_codec: 'auto', bit_rate: '500k' }),
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      },
    );
    stream.end(buffer);
  });

  const result = uploadResult;

  res.status(200).json({
    success:      true,
    url:          result.secure_url,
    publicId:     result.public_id,
    resourceType: result.resource_type,
    mimeType:     mimetype,
    bytes:        result.bytes,
    format:       result.format,
  });
});

// ── 7. GET /chats/:chatId/messages ───────────────────────────────────────────
/**
 * Paginated message history.
 * Params: ?limit=50&before=<timestamp>
 */
exports.getMessages = catchAsync(async (req, res, next) => {
  const { chatId } = req.params;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = parseInt(req.query.before) || Date.now();

  const chatRef = db.collection('supportChats').doc(chatId);
  const chatDoc = await chatRef.get();
  if (!chatDoc.exists) return next(new AppError('Chat not found', 404));

  // Authorisation: user must be chat participant or admin/support_agent
  const chatData  = chatDoc.data();
  const isAgent   = ['admin', 'support_agent'].includes(req.userProfile?.role);
  const isOwner   = chatData.userId === req.userId;
  if (!isAgent && !isOwner) return next(new AppError('Not authorised', 403));

  const snap = await chatRef.collection('messages')
    .where('timestamp', '<', before)
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  const messages = snap.docs.map(d => d.data()).reverse();

  res.json({
    success:  true,
    messages,
    hasMore:  snap.docs.length === limit,
    oldest:   messages[0]?.timestamp || null,
  });
});