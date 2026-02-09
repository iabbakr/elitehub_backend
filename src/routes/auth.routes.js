// routes/auth.routes.js - PRODUCTION-GRADE AUTHENTICATION SYSTEM
const express = require('express');
const router = express.Router();
const { auth, db } = require('../config/firebase');
const { authenticate } = require('../middleware/auth');
const { client, CACHE_KEYS, CACHE_TTL } = require('../config/redis');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const EmailService = require('../services/email.service');

/**
 * ==========================================
 * HELPER FUNCTIONS
 * ==========================================
 */

/**
 * Generate unique referral code
 */
function generateReferralCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Check if referral code exists and get referrer UID
 */
async function validateReferralCode(code) {
  if (!code || !code.trim()) return null;
  
  const trimmedCode = code.trim().toUpperCase();
  const snapshot = await db.collection('referralCodes').doc(trimmedCode).get();
  
  if (!snapshot.exists) return null;
  
  return snapshot.data().uid;
}

/**
 * Create wallet for new user
 */
async function createUserWallet(userId) {
  await db.collection('wallets').doc(userId).set({
    userId,
    balance: 0,
    pendingBalance: 0,
    currency: 'NGN',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
    isLocked: false,
  });
}

/**
 * ==========================================
 * PUBLIC ROUTES (No Authentication Required)
 * ==========================================
 */

/**
 * POST /api/v1/auth/signup
 * Create new user account with Firebase Authentication
 */
router.post('/signup', catchAsync(async (req, res, next) => {
  const {
    email,
    password,
    role,
    name,
    phone,
    gender,
    referralCode,
    location,
    sellerCategories,
    serviceCategory,
    interests
  } = req.body;

  // ✅ VALIDATION
  if (!email || !password || !role || !name) {
    return next(new AppError('Email, password, role, and name are required', 400));
  }

  if (!['buyer', 'seller', 'service'].includes(role)) {
    return next(new AppError('Invalid role. Must be buyer, seller, or service', 400));
  }

  if (password.length < 6) {
    return next(new AppError('Password must be at least 6 characters', 400));
  }

  // Email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return next(new AppError('Invalid email format', 400));
  }

  try {
    // ✅ CREATE FIREBASE AUTH USER
    const userRecord = await auth.createUser({
      email: email.trim(),
      password,
      displayName: name.trim(),
      disabled: false
    });

    const uid = userRecord.uid;
    const myReferralCode = generateReferralCode();

    // ✅ VALIDATE REFERRAL CODE IF PROVIDED
    let referredBy = null;
    if (referralCode) {
      referredBy = await validateReferralCode(referralCode);
    }

    // ✅ BUILD USER DOCUMENT
    const userData = {
      uid,
      email: email.trim(),
      role,
      name: name.trim(),
      myReferralCode,
      referralBonus: 0,
      hasCompletedFirstPurchase: false,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      subscriptionExpiresAt: 0,
      hasCompletedBusinessProfile: role === 'buyer',
      favoriteProviders: [],
      favoriteSellers: [],
      favoriteServiceProviders: [],
      autoCancelStrikes: 0,
      isSuspended: false,
      suspensionReason: null
    };

    // Add optional fields
    if (phone) userData.phone = phone.trim();
    if (gender) userData.gender = gender;
    if (location) userData.location = location;
    if (referredBy) userData.referredBy = referredBy;

    // Role-specific fields
    if (role === 'buyer' && interests) {
      userData.interests = interests;
    }

    if (role === 'seller') {
      userData.sellerCategories = sellerCategories || [];
      userData.hasCompletedBusinessProfile = false;
    }

    if (role === 'service') {
      userData.hasUsedFreeTrial = false;
      userData.profileCompletionPercentage = 0;
      userData.hasCompletedBusinessProfile = false;
      userData.isAvailable = true;
      if (serviceCategory) userData.serviceCategory = serviceCategory;
    }

    // ✅ ATOMIC WRITES (All or nothing)
    const batch = db.batch();

    // 1. Create user document
    batch.set(db.collection('users').doc(uid), userData);

    // 2. Create referral code mapping
    batch.set(db.collection('referralCodes').doc(myReferralCode), {
      uid,
      createdAt: Date.now()
    });

    // 3. Create wallet
    batch.set(db.collection('wallets').doc(uid), {
      userId: uid,
      balance: 0,
      pendingBalance: 0,
      currency: 'NGN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      isLocked: false,
    });

    await batch.commit();

    // ✅ GENERATE CUSTOM TOKEN FOR AUTO-LOGIN
    const customToken = await auth.createCustomToken(uid);

    // ✅ SEND WELCOME EMAIL (Fire and forget)
    // ✅ UPDATED ONBOARDING TRIGGER
setImmediate(async () => {
  try {
    console.log(`Attempting to send welcome email to: ${email.trim()}`);
    if (role === 'seller') {
      await EmailService.sendSellerWelcomeEmail(email.trim(), name.trim());
    } else if (role === 'service') {
      await EmailService.sendServiceWelcomeEmail(email.trim(), name.trim());
    } else {
      await EmailService.sendBuyerWelcomeEmail(email.trim(), name.trim());
    }
    console.log(`✅ Welcome email process completed for ${email.trim()}`);
  } catch (error) {
    // This will now show up in your Render logs
    console.error('❌ CRITICAL: Welcome email failed during signup:', error);
  }
});

    // ✅ RESPONSE
    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      user: {
        uid,
        email: userData.email,
        name: userData.name,
        role: userData.role,
        myReferralCode: userData.myReferralCode
      },
      customToken // Client uses this to sign in to Firebase
    });

  } catch (error) {
    console.error('Signup error:', error);

    // Handle Firebase Auth errors
    if (error.code === 'auth/email-already-exists') {
      return next(new AppError('Email already registered', 409));
    }
    if (error.code === 'auth/invalid-email') {
      return next(new AppError('Invalid email format', 400));
    }
    if (error.code === 'auth/weak-password') {
      return next(new AppError('Password is too weak', 400));
    }

    return next(new AppError('Signup failed. Please try again', 500));
  }
}));

/**
 * POST /api/v1/auth/signin
 * Verify credentials (Frontend handles Firebase signIn)
 * This endpoint is optional - mainly for validation
 */
router.post('/signin', catchAsync(async (req, res, next) => {
  const { email } = req.body;

  if (!email) {
    return next(new AppError('Email is required', 400));
  }

  try {
    // ✅ GET USER BY EMAIL
    const userRecord = await auth.getUserByEmail(email.trim());

    // ✅ CHECK IF USER IS DISABLED
    if (userRecord.disabled) {
      return next(new AppError('Account has been disabled. Contact support', 403));
    }

    // ✅ GET USER PROFILE FROM FIRESTORE
    const userDoc = await db.collection('users').doc(userRecord.uid).get();

    if (!userDoc.exists) {
      return next(new AppError('User profile not found', 404));
    }

    const userData = userDoc.data();

    // ✅ CHECK IF SUSPENDED
    if (userData.isSuspended) {
      return next(new AppError(
        `Account suspended: ${userData.suspensionReason || 'Contact support'}`, 
        403
      ));
    }

    // ✅ RESPONSE (Client still does Firebase signIn)
    res.json({
      success: true,
      message: 'User verified. Proceed with Firebase authentication',
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        role: userData.role,
        name: userData.name,
        isSuspended: userData.isSuspended || false
      }
    });

  } catch (error) {
    console.error('SignIn verification error:', error);

    if (error.code === 'auth/user-not-found') {
      return next(new AppError('No account found with this email', 404));
    }

    return next(new AppError('Sign in verification failed', 500));
  }
}));

/**
 * POST /api/v1/auth/verify-email
 * Send email verification link
 */
router.post('/verify-email', authenticate, catchAsync(async (req, res, next) => {
  const { userId } = req;

  try {
    const link = await auth.generateEmailVerificationLink(req.userProfile.email);

    // Send email with verification link
    await EmailService.sendVerificationEmail(req.userProfile.email, req.userProfile.name, link);

    res.json({
      success: true,
      message: 'Verification email sent successfully'
    });

  } catch (error) {
    console.error('Email verification error:', error);
    return next(new AppError('Failed to send verification email', 500));
  }
}));

/**
 * POST /api/v1/auth/forgot-password
 * Send password reset email
 */
router.post('/forgot-password', catchAsync(async (req, res, next) => {
  const { email } = req.body;

  if (!email) {
    return next(new AppError('Email is required', 400));
  }

  try {
    // ✅ CHECK IF USER EXISTS
    const userRecord = await auth.getUserByEmail(email.trim());

    // ✅ GENERATE PASSWORD RESET LINK
    const link = await auth.generatePasswordResetLink(email.trim());

    // ✅ GET USER NAME
    const userDoc = await db.collection('users').doc(userRecord.uid).get();
    const userName = userDoc.exists ? userDoc.data().name : 'User';

    // ✅ SEND EMAIL
    await EmailService.sendPasswordResetEmail(email.trim(), userName, link);

    res.json({
      success: true,
      message: 'Password reset email sent successfully'
    });

  } catch (error) {
    console.error('Password reset error:', error);

    // ✅ DON'T REVEAL IF EMAIL EXISTS (Security)
    res.json({
      success: true,
      message: 'If an account exists with this email, a password reset link has been sent'
    });
  }
}));

/**
 * ==========================================
 * AUTHENTICATED ROUTES
 * ==========================================
 */

/**
 * POST /api/v1/auth/change-password
 * Change user password (requires current password)
 */
router.post('/change-password', authenticate, catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  const { userId } = req;

  if (!currentPassword || !newPassword) {
    return next(new AppError('Current and new password are required', 400));
  }

  if (newPassword.length < 6) {
    return next(new AppError('New password must be at least 6 characters', 400));
  }

  try {
    // ✅ VERIFY CURRENT PASSWORD (Client should do this)
    // This endpoint assumes client verified current password via Firebase

    // ✅ UPDATE PASSWORD
    await auth.updateUser(userId, {
      password: newPassword
    });

    // ✅ SEND NOTIFICATION EMAIL
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      await EmailService.sendPasswordChangedEmail(userData.email, userData.name);
    }

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    return next(new AppError('Failed to change password', 500));
  }
}));

/**
 * POST /api/v1/auth/signout
 * Revoke refresh tokens (optional for extra security)
 */
router.post('/signout', authenticate, catchAsync(async (req, res, next) => {
  const { userId } = req;

  try {
    // ✅ REVOKE ALL REFRESH TOKENS
    await auth.revokeRefreshTokens(userId);

    // ✅ CLEAR REDIS CACHE
    await client.del(`user:${userId}:profile`);

    res.json({
      success: true,
      message: 'Signed out successfully'
    });

  } catch (error) {
    console.error('Signout error:', error);
    return next(new AppError('Signout failed', 500));
  }
}));

/**
 * DELETE /api/v1/auth/delete-account
 * Permanently delete user account
 */
router.delete('/delete-account', authenticate, catchAsync(async (req, res, next) => {
  const { userId } = req;
  const { confirmPassword } = req.body;

  if (!confirmPassword) {
    return next(new AppError('Password confirmation required', 400));
  }

  try {
    // ✅ SOFT DELETE (Keep data for 30 days)
    await db.collection('users').doc(userId).update({
      isActive: false,
      deletedAt: Date.now(),
      deletionScheduledFor: Date.now() + (30 * 24 * 60 * 60 * 1000), // 30 days
      updatedAt: Date.now()
    });

    // ✅ DISABLE FIREBASE AUTH
    await auth.updateUser(userId, {
      disabled: true
    });

    // ✅ CLEAR CACHE
    await client.del(`user:${userId}:profile`);

    res.json({
      success: true,
      message: 'Account deletion scheduled. Your data will be permanently deleted in 30 days.'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    return next(new AppError('Failed to delete account', 500));
  }
}));

/**
 * GET /api/v1/auth/me
 * Get current authenticated user profile
 */
router.get('/me', authenticate, catchAsync(async (req, res, next) => {
  const { userId, userProfile } = req;

  // Remove sensitive fields
  const { paystackRecipientCode, ...safeProfile } = userProfile;

  res.json({
    success: true,
    user: safeProfile
  });
}));

/**
 * POST /api/v1/auth/refresh-token
 * Get fresh ID token (handled by Firebase SDK on client)
 * This is a placeholder for documentation
 */
router.post('/refresh-token', catchAsync(async (req, res, next) => {
  res.json({
    success: false,
    message: 'Token refresh should be handled by Firebase SDK on the client side'
  });
}));

module.exports = router;