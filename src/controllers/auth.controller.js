const { db, admin } = require('../config/firebase');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');

/**
 * ✅ GET /api/v1/auth/me
 * Atomic bundle of Profile, Wallet, and Stats
 */
exports.getMe = catchAsync(async (req, res, next) => {
  const userId = req.userId;

  // Parallel execution for high performance
  const [userDoc, walletDoc, orderStats] = await Promise.all([
    db.collection('users').doc(userId).get(),
    db.collection('wallets').doc(userId).get(),
    db.collection('orders').where('buyerId', '==', userId).count().get()
  ]);

  if (!userDoc.exists) {
    return next(new AppError('User account not found', 404));
  }

  const userData = userDoc.data();
  const walletData = walletDoc.exists ? walletDoc.data() : { balance: 0, pendingBalance: 0 };

  // Remove highly sensitive internal fields before sending to client
  const { paystackRecipientCode, ...safeUserData } = userData;

  res.status(200).json({
    success: true,
    user: {
      ...safeUserData,
      wallet: {
        balance: walletData.balance || 0,
        pendingBalance: walletData.pendingBalance || 0,
        currency: 'NGN'
      },
      stats: {
        totalOrders: orderStats.data().count
      }
    }
  });
});

/**
 * ✅ POST /api/v1/auth/activate-seller
 * Handles payment and subscription logic in an atomic transaction
 */
exports.activateSeller = catchAsync(async (req, res, next) => {
  const FEE = 5000;
  const userId = req.userId;

  await db.runTransaction(async (t) => {
    const userRef = db.collection('users').doc(userId);
    const walletRef = db.collection('wallets').doc(userId);
    // Use a high-entropy ID for the transaction ledger
    const txnRef = db.collection('transactions').doc(`sub_${Date.now()}_${userId.slice(0, 4)}`);

    const [userSnap, walletSnap] = await Promise.all([t.get(userRef), t.get(walletRef)]);

    if (!userSnap.exists) throw new AppError('User profile not found', 404);
    
    const walletData = walletSnap.exists ? walletSnap.data() : { balance: 0 };

    if (walletData.balance < FEE) {
      throw new AppError('Insufficient balance to activate shop. Please top up your wallet.', 400);
    }

    // 1. Update User Profile to Active Seller status
    t.update(userRef, {
      subscriptionExpiresAt: Date.now() + (365 * 24 * 60 * 60 * 1000), // 1 Year
      subscriptionType: 'yearly',
      hasCompletedBusinessProfile: true,
      role: 'seller', // Ensure role is promoted if they were a buyer
      updatedAt: Date.now()
    });

    // 2. Debit Wallet atomically
    t.update(walletRef, { 
      balance: admin.firestore.FieldValue.increment(-FEE),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3. Log the transaction ledger
    t.set(txnRef, {
      id: txnRef.id,
      userId,
      amount: FEE,
      type: 'debit',
      category: 'subscription_payment',
      description: 'Annual Merchant Shop Activation Fee',
      status: 'completed',
      timestamp: Date.now()
    });
  });

  res.status(200).json({ 
    success: true, 
    message: 'Congratulations! Your shop has been activated for 1 year.' 
  });
});

/**
 * ✅ POST /api/v1/auth/signout
 * Optional server-side cleanup if using session tokens or Redis blacklists
 */
exports.signOut = catchAsync(async (req, res, next) => {
  // If you use Redis to blacklist JWTs, handle it here
  res.status(200).json({ 
    success: true, 
    message: 'Successfully signed out' 
  });
});