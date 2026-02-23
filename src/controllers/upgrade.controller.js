// src/controllers/upgrade.controller.js
// Handles buyer → seller or buyer → service provider role upgrade.
//
// Flow:
//  1. Verify the user is currently a buyer
//  2. Check the "email verified" Redis token set by otp-upgrade.routes.js
//  3. Run an atomic Firestore transaction to update the user document
//  4. Invalidate caches
//  5. Fire a welcome push notification (non-blocking)

const { db, admin } = require('../config/firebase');
const { client }    = require('../config/redis');
const { invalidateUserCache } = require('../config/redis');
const catchAsync    = require('../utils/catchAsync');
const AppError      = require('../utils/AppError');
const EmailService  = require('../services/email.service');

/**
 * POST /api/v1/users/upgrade-role
 *
 * Body:
 *   newRole          — "seller" | "service"
 *   businessName     — string (required)
 *   businessPhone    — string (required)
 *   businessAddress  — string (required)
 *   verifiedEmail    — string — the email the OTP was sent to (required)
 *   rcNumber         — string | null (optional, 7 digits)
 *   sellerCategories — string[] (required if newRole === "seller")
 *   serviceCategory  — string   (required if newRole === "service")
 */
exports.upgradeRole = catchAsync(async (req, res, next) => {
  const userId = req.userId;
  const {
    newRole,
    businessName,
    businessPhone,
    businessAddress,
    verifiedEmail,
    rcNumber,
    sellerCategories,
    serviceCategory,
  } = req.body;

  // ── 1. Input validation ────────────────────────────────────────────────────

  if (!['seller', 'service'].includes(newRole)) {
    return next(new AppError('newRole must be "seller" or "service"', 400));
  }

  if (!businessName?.trim())    return next(new AppError('Business name is required', 400));
  if (!businessPhone?.trim())   return next(new AppError('Business phone is required', 400));
  if (!businessAddress?.trim()) return next(new AppError('Business address is required', 400));
  if (!verifiedEmail?.trim())   return next(new AppError('Verified email is required', 400));

  if (newRole === 'seller' && (!sellerCategories || !sellerCategories.length)) {
    return next(new AppError('At least one seller category is required', 400));
  }
  if (newRole === 'service' && !serviceCategory?.trim()) {
    return next(new AppError('Service category is required', 400));
  }

  if (rcNumber?.trim() && rcNumber.trim().length !== 7) {
    return next(new AppError('RC Number must be exactly 7 digits', 400));
  }

  // Phone format validation (Nigerian numbers)
  const phoneRegex = /^(?:\+234|0)[789]\d{9}$/;
  if (!phoneRegex.test(businessPhone.trim())) {
    return next(new AppError('Invalid business phone format (use 080XXXXXXXXX)', 400));
  }

  const cleanEmail = verifiedEmail.trim().toLowerCase();

  // ── 2. Check OTP-verified token in Redis ───────────────────────────────────

  const verifiedKey = `otp:upgrade:verified:${userId}:${cleanEmail}`;
  const isVerified  = await client.get(verifiedKey);

  if (!isVerified) {
    return next(
      new AppError(
        'Email not verified. Please verify your email before upgrading.',
        403
      )
    );
  }

  // ── 3. Check current user role ─────────────────────────────────────────────

  const userRef  = db.collection('users').doc(userId);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    return next(new AppError('User not found', 404));
  }

  const currentUser = userSnap.data();

  if (currentUser.role !== 'buyer') {
    return next(
      new AppError(
        `Only buyer accounts can be upgraded. Your current role is: ${currentUser.role}`,
        400
      )
    );
  }

  // ── 4. Atomic Firestore update ─────────────────────────────────────────────

  const updatePayload = {
    role:                       newRole,
    businessName:               businessName.trim(),
    businessPhone:              businessPhone.trim(),
    businessAddress:            businessAddress.trim(),
    rcNumber:                   rcNumber?.trim() || null,
    hasCompletedBusinessProfile: false, // They still need to subscribe
    subscriptionExpiresAt:      0,
    updatedAt:                  Date.now(),
  };

  if (newRole === 'seller') {
    updatePayload.sellerCategories = sellerCategories;
  } else {
    updatePayload.serviceCategory            = serviceCategory.trim();
    updatePayload.isAvailable                = true;
    updatePayload.profileCompletionPercentage = 0;
    updatePayload.hasUsedFreeTrial            = false;
  }

  // Use a transaction to ensure atomicity
  await db.runTransaction(async (transaction) => {
    const freshSnap = await transaction.get(userRef);
    if (!freshSnap.exists) throw new AppError('User not found', 404);
    const freshData = freshSnap.data();

    // Double-check role hasn't changed between our read and write
    if (freshData.role !== 'buyer') {
      throw new AppError('Account is no longer a buyer account', 400);
    }

    transaction.update(userRef, updatePayload);
  });

  // ── 5. Consume the verified Redis token (single-use) ──────────────────────

  await client.del(verifiedKey);

  // ── 6. Invalidate user cache ───────────────────────────────────────────────

  try {
    await invalidateUserCache(userId);
  } catch (_) {
    // Non-fatal
  }

  // ── 7. Send welcome email + push notification (non-blocking) ──────────────

  setImmediate(async () => {
    try {
      if (newRole === 'seller') {
        await EmailService.sendSellerWelcomeEmail(currentUser.email, currentUser.name);
      } else {
        await EmailService.sendServiceWelcomeEmail(currentUser.email, currentUser.name);
      }
    } catch (err) {
      console.error('[upgradeRole] Welcome email failed:', err);
    }

    try {
      const pushNotificationService = require('../services/push-notification.service');
      const roleLabel = newRole === 'seller' ? 'Seller' : 'Service Provider';
      await pushNotificationService.sendPushToUser(
        userId,
        `🎉 Welcome, ${roleLabel}!`,
        `Your account has been upgraded. Complete your subscription to go live!`,
        { screen: newRole === 'seller' ? 'SellerDashboard' : 'ServiceProviderDashboard' }
      );
    } catch (err) {
      console.error('[upgradeRole] Push notification failed:', err);
    }
  });

  // ── 8. Respond ─────────────────────────────────────────────────────────────

  res.status(200).json({
    success: true,
    message: `Account successfully upgraded to ${newRole === 'seller' ? 'Seller' : 'Service Provider'}.`,
    newRole,
  });
});