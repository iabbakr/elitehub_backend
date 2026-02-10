const { db, admin } = require('../config/firebase');
const { client: redis } = require('../config/redis');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');

/**
 * POST /api/v1/support/chats/init
 * Replaces frontend createSupportChat logic
 */
exports.initChat = catchAsync(async (req, res, next) => {
    const { subject, initialMessage } = req.body;
    const userId = req.userId;

    // 1. Check Redis for active session (Fast gatekeeper)
    const activeChatKey = `active_support_chat:${userId}`;
    const existingChatId = await redis.get(activeChatKey);
    
    if (existingChatId) {
        return next(new AppError('You already have an active support session.', 400));
    }

    // 2. Prepare Firestore Document (Atomic ID generation)
    const chatRef = db.collection('supportChats').doc();
    const chatId = chatRef.id;

    const chatData = {
        id: chatId,
        userId,
        userName: req.userProfile?.name || 'User',
        userRole: req.userProfile?.role || 'buyer',
        userEmail: req.userProfile?.email,
        status: 'waiting',
        subject,
        unreadCount: 0,
        adminUnreadCount: 1,
        totalMessages: 1,
        createdAt: Date.now(),
        lastMessage: initialMessage.substring(0, 100),
        lastMessageTime: Date.now()
    };

    // 3. Batch write Chat and first Message
    const batch = db.batch();
    const messageRef = chatRef.collection('messages').doc();
    
    batch.set(chatRef, chatData);
    batch.set(messageRef, {
        id: messageRef.id,
        chatId,
        senderId: userId,
        senderRole: req.userProfile?.role,
        senderName: req.userProfile?.name,
        message: initialMessage.trim(),
        messageType: 'text',
        timestamp: Date.now(),
        isRead: false
    });

    await batch.commit();

    // 4. Update Redis Queue and Session Lock
    await redis.lPush('support_queue', chatId);
    await redis.set(activeChatKey, chatId, { EX: 86400 }); // 24hr session lock

    res.status(201).json({ 
        success: true, 
        chatId, 
        message: 'Support request queued' 
    });
});

/**
 * PATCH /api/v1/support/chats/:chatId/assign
 * Replaces frontend assignChatToAdmin
 */
exports.assignChat = catchAsync(async (req, res, next) => {
    const { chatId } = req.params;
    const adminId = req.userId;

    const chatRef = db.collection('supportChats').doc(chatId);
    const chatDoc = await chatRef.get();

    if (!chatDoc.exists) return next(new AppError('Chat not found', 404));
    
    const chatData = chatDoc.data();
    if (chatData.status !== 'waiting') {
        return next(new AppError('Chat is already active or resolved', 400));
    }

    // 1. Update Firestore to 'active'
    await chatRef.update({
        status: 'active',
        assignedAdminId: adminId,
        assignedAdminName: req.userProfile?.name || 'Agent',
        updatedAt: Date.now()
    });

    // 2. Remove from Redis Queue (LREM removes specific value)
    await redis.lRem('support_queue', 0, chatId);

    res.status(200).json({ 
        success: true, 
        message: 'Chat assigned successfully' 
    });
});

/**
 * POST /api/v1/support/chats/:chatId/resolve
 */
exports.resolveChat = catchAsync(async (req, res, next) => {
    const { chatId } = req.params;
    const { rating, feedback } = req.body;

    const chatRef = db.collection('supportChats').doc(chatId);
    const chatDoc = await chatRef.get();

    if (!chatDoc.exists) return next(new AppError('Chat not found', 404));
    const chatData = chatDoc.data();

    // 1. Update Firestore
    await chatRef.update({
        status: 'resolved',
        resolvedAt: Date.now(),
        updatedAt: Date.now(),
        rating: rating || null,
        feedback: feedback || null
    });

    // 2. Clear Redis Session Lock (Crucial: allows user to start new chat)
    const activeChatKey = `active_support_chat:${chatData.userId}`;
    await redis.del(activeChatKey);

    res.status(200).json({ 
        success: true, 
        message: 'Support session closed' 
    });
});

/**
 * GET /api/v1/support/chats/status
 * Check current position in queue or active session
 */
exports.getChatStatus = catchAsync(async (req, res) => {
    const userId = req.userId;
    const activeChatKey = `active_support_chat:${userId}`;
    
    const chatId = await redis.get(activeChatKey);
    if (!chatId) return res.json({ success: true, active: false });

    // Find position in queue
    const queue = await redis.lRange('support_queue', 0, -1);
    const position = queue.indexOf(chatId) + 1;

    res.json({
        success: true,
        active: true,
        chatId,
        queuePosition: position > 0 ? position : 0, // 0 means it's already active
        status: position > 0 ? 'waiting' : 'active'
    });
});