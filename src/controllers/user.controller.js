const { db, admin } = require('../config/firebase');
const { getDocument, updateDocument, queryDocuments } = require('../config/firebase');
const { invalidateUserCache } = require('../config/redis');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const EmailService = require('../services/email.service');

/**
 * Send Welcome Email based on Role
 */
exports.sendWelcomeEmail = catchAsync(async (req, res) => {
    const { email, name, role } = req.body;
    
    // Detailed validation logging
    console.log(`Attempting welcome email for ${email} as ${role}`);

    try {
        let result;
        switch (role) {
            case 'seller': result = await EmailService.sendSellerWelcomeEmail(email, name); break;
            case 'service': result = await EmailService.sendServiceWelcomeEmail(email, name); break;
            default: result = await EmailService.sendBuyerWelcomeEmail(email, name); break;
        }

        if (!result) {
            return res.status(500).json({ success: false, message: 'Email service failed' });
        }

        res.status(200).json({ success: true, message: 'Welcome email sent' });
    } catch (err) {
        console.error("RESEND ERROR:", err.message);
        throw new AppError(`Email failed: ${err.message}`, 500);
    }
});

/**
 * Get Single User Profile
 */
exports.getUserProfile = catchAsync(async (req, res) => {
    const { userId } = req.params;

    // Security check: Only self or admin
    if (req.userId !== userId && req.userProfile?.role !== 'admin') {
        throw new AppError('Access denied', 403);
    }

    const user = await getDocument('users', userId);
    if (!user) throw new AppError('User not found', 404);

    const { paystackRecipientCode, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
});

/**
 * Update Standard Profile
 */
exports.updateUserProfile = catchAsync(async (req, res) => {
    const { userId } = req.params;
    if (req.userId !== userId && req.userProfile?.role !== 'admin') {
        throw new AppError('Access denied', 403);
    }

    const allowedFields = [
        'name', 'phone', 'gender', 'location', 'imageUrl', 
        'instagramUsername', 'tiktokUsername'
    ];

    const updates = {};
    allowedFields.forEach(field => {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    if (Object.keys(updates).length === 0) throw new AppError('No valid fields to update', 400);

    updates.updatedAt = Date.now();
    await updateDocument('users', userId, updates);
    await invalidateUserCache(userId);

    res.json({ success: true, message: 'Profile updated' });
});

/**
 * Update Business Specific Profile
 */
exports.updateBusinessProfile = catchAsync(async (req, res) => {
    const { 
        businessName, businessAddress, businessPhone, 
        rcNumber, whatsappNumber, serviceCategory, serviceDescription 
    } = req.body;
    const userId = req.userId;

    if (!businessName || !businessAddress || !businessPhone) {
        throw new AppError('Missing required business fields', 400);
    }

    const phoneRegex = /^(?:\+234|0)[789]\d{9}$/;
    if (!phoneRegex.test(businessPhone)) throw new AppError('Invalid business phone format', 400);

    const updateData = {
        businessName: businessName.trim(),
        businessAddress: businessAddress.trim(),
        businessPhone: businessPhone.trim(),
        rcNumber: rcNumber ? rcNumber.trim().toUpperCase() : null,
        whatsappNumber: whatsappNumber ? whatsappNumber.trim() : null,
        hasCompletedBusinessProfile: true,
        updatedAt: Date.now(),
    };

    if (serviceCategory) updateData.serviceCategory = serviceCategory;
    if (serviceDescription) updateData.serviceDescription = serviceDescription.trim();

    await db.collection('users').doc(userId).update(updateData);
    await invalidateUserCache(userId);

    res.status(200).json({ success: true, message: 'Business profile updated', data: updateData });
});

/**
 * Toggle Service Provider Availability
 */
exports.toggleAvailability = catchAsync(async (req, res) => {
    const { userId } = req.params;
    const { isAvailable } = req.body;

    if (req.userId !== userId) throw new AppError('Access denied', 403);

    const user = await getDocument('users', userId);
    if (!user || user.role !== 'service') throw new AppError('Unauthorized role', 400);

    await updateDocument('users', userId, { isAvailable: !!isAvailable, updatedAt: Date.now() });
    await invalidateUserCache(userId);

    res.json({ success: true, isAvailable: !!isAvailable });
});

/**
 * Toggle Favorite Seller
 */
exports.toggleFavoriteSeller = catchAsync(async (req, res) => {
    const { sellerId } = req.params;
    const userId = req.userId;
    if (userId === sellerId) throw new AppError('You cannot follow yourself', 400);

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const isFavorited = (userDoc.data().favoriteSellers || []).includes(sellerId);

    if (isFavorited) {
        await userRef.update({ favoriteSellers: admin.firestore.FieldValue.arrayRemove(sellerId) });
    } else {
        await userRef.update({ favoriteSellers: admin.firestore.FieldValue.arrayUnion(sellerId) });
        // Notify seller (helper)
        const { pushNotificationService } = require('../services/pushNotificationService');
        pushNotificationService.sendPushToUser(sellerId, "New Follower! 🚀", `${req.user.name} followed you.`).catch(() => {});
    }

    await invalidateUserCache(userId);
    res.json({ success: true, isFavorited: !isFavorited });
});

/**
 * Get Sellers List
 */
exports.getSellers = catchAsync(async (req, res) => {
    const { state, category } = req.query;
    let filters = [
        { field: 'role', operator: '==', value: 'seller' },
        { field: 'hasCompletedBusinessProfile', operator: '==', value: true }
    ];
    if (state) filters.push({ field: 'location.state', operator: '==', value: state });
    if (category) filters.push({ field: 'sellerCategories', operator: 'array-contains', value: category });

    const sellers = await queryDocuments('users', filters);
    const safeSellers = sellers.map(({ paystackRecipientCode, ...s }) => s);

    res.json({ success: true, sellers: safeSellers });
});

/**
 * Get Service Providers List
 */
exports.getServiceProviders = catchAsync(async (req, res) => {
    const { category, state, city } = req.query;
    let filters = [{ field: 'role', operator: '==', value: 'service' }];

    if (category) filters.push({ field: 'serviceCategory', operator: '==', value: category });
    if (state) filters.push({ field: 'location.state', operator: '==', value: state });

    const providers = await queryDocuments('users', filters);
    const now = Date.now();
    const activeProviders = providers.filter(p => (p.subscriptionExpiresAt || 0) > now);

    res.json({ success: true, providers: activeProviders.map(({ paystackRecipientCode, ...p }) => p) });
});

/**
 * Get Platform Stats (Admin Only)
 */
exports.getPlatformStats = catchAsync(async (req, res) => {
    const users = await queryDocuments('users', []);
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);

    res.json({
        success: true,
        stats: {
            totalUsers: users.length,
            buyers: users.filter(u => u.role === 'buyer').length,
            sellers: users.filter(u => u.role === 'seller').length,
            activeUsers: users.filter(u => (u.updatedAt || u.createdAt) > dayAgo).length,
        }
    });
});