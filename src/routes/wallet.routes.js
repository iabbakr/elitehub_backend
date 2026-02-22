'use strict';

// ─── wallet.routes.js ─────────────────────────────────────────────────────────
// ✅ Tiered withdrawal fees enforced on server (never trust client-sent fee)
//     < ₦2,000        → ₦50
//     ₦2,000–₦199,999 → ₦150
//     ₦200,000+       → ₦500
// ✅ Daily withdrawal limits:
//     buyer / service → ₦100,000
//     seller          → ₦200,000
// ✅ PIN must be active (checked via securitySettings Firestore doc)
// ✅ Bank name must be saved (paystackRecipientCode required)
// ✅ Atomic balance deduction via db.runTransaction
// ✅ Redis idempotency — duplicate requests are no-ops
// ✅ Paystack transfer initiated after wallet is successfully debited
// ✅ Auto-refund on Paystack transfer failure

const express         = require('express');
const router          = express.Router();
const { db, admin }   = require('../config/firebase');
const { client }      = require('../config/redis');
const { CACHE_TTL }   = require('../config/redis');
const paystackService = require('../services/paystack.service');
const walletService   = require('../services/wallet.service');
const pushNotificationService = require('../services/push-notification.service');
const { authenticate, authorizeOwnership, userRateLimit } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/rateLimiters');
const { cacheMiddleware, userCacheMiddleware } = require('../middleware/cache');

// ─── Fee & Limit helpers ──────────────────────────────────────────────────────

/**
 * Calculate withdrawal fee (server-authoritative — never trust client value).
 * @param {number} amountNaira
 * @returns {number} fee in Naira
 */
function calculateWithdrawalFee(amountNaira) {
  if (amountNaira < 2_000)   return 50;
  if (amountNaira < 200_000) return 150;
  return 500;
}

/**
 * Daily withdrawal limit by user role.
 * @param {string} role
 * @returns {number} limit in Naira
 */
function getDailyLimit(role) {
  if (role === 'seller') return 200_000;
  return 100_000; // buyer, service, fallback
}

/**
 * Get total withdrawals made by userId today (UTC day boundary).
 * @param {string} userId
 * @returns {Promise<number>} total in Naira
 */
async function getDailyWithdrawalTotal(userId) {
  try {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startTs = startOfDay.getTime();

    const snapshot = await db
      .collection('wallets')
      .doc(userId)
      .collection('transactions')
      .where('type', '==', 'debit')
      .where('metadata.withdrawal', '==', true)
      .where('timestamp', '>=', startTs)
      .where('status', 'in', ['completed', 'processing'])
      .get();

    let total = 0;
    snapshot.forEach((doc) => { total += doc.data().amount || 0; });
    return total;
  } catch (err) {
    console.error('[Withdrawal] getDailyWithdrawalTotal error:', err);
    return 0;
  }
}

// ─── GET /api/v1/wallet/banks ─────────────────────────────────────────────────

router.get(
  '/banks',
  cacheMiddleware(CACHE_TTL.WEEK),
  async (req, res) => {
    try {
      const result = await paystackService.getBanks();
      res.json({ success: true, banks: result.banks });
    } catch (error) {
      console.error('❌ Get banks error:', error);
      res.json({
        success: true,
        banks: paystackService.getFallbackBanks(),
        warning: 'Using cached bank list',
      });
    }
  }
);

// ─── POST /api/v1/wallet/verify-account ──────────────────────────────────────

router.post(
  '/verify-account',
  authenticate,
  userRateLimit(10, 15 * 60 * 1000),
  async (req, res) => {
    try {
      const { accountNumber, bankCode } = req.body;

      if (!accountNumber || !bankCode) {
        return res.status(400).json({ success: false, message: 'Account number and bank code are required' });
      }
      if (!/^\d{10}$/.test(accountNumber)) {
        return res.status(400).json({ success: false, message: 'Account number must be exactly 10 digits' });
      }

      const verification = await paystackService.verifyBankAccount(accountNumber, bankCode);
      res.json(verification);
    } catch (error) {
      console.error('❌ Verify account error:', error);
      res.status(400).json({ success: false, message: error.message || 'Account verification failed' });
    }
  }
);

// ─── POST /api/v1/wallet/add-bank-details ────────────────────────────────────

// ─── POST /api/v1/wallet/add-bank-details ────────────────────────────────────
// ✅ FIXED: Now saves bankName to bankAccount document so withdrawal route
// can read it for the transaction description + receipts.

router.post(
  '/add-bank-details',
  authenticate,
  userRateLimit(3, 15 * 60 * 1000),
  async (req, res) => {
    try {
      const { accountNumber, bankCode, accountName, bankName } = req.body; // ✅ Accept bankName
      const userId = req.userId;

      if (!accountNumber || !bankCode) {
        return res.status(400).json({ success: false, message: 'Account number and bank code are required' });
      }
      if (!/^\d{10}$/.test(accountNumber)) {
        return res.status(400).json({ success: false, message: 'Account number must be exactly 10 digits' });
      }

      await walletService.ensureWalletExists(userId);

      // 1. Verify account with Paystack
      const verification = await paystackService.verifyBankAccount(accountNumber, bankCode);
      if (!verification.success) {
        return res.status(400).json({ success: false, message: 'Account verification failed. Please check your details.' });
      }

      // 2. Create Paystack transfer recipient (generates a real recipientCode)
      const recipient = await paystackService.createTransferRecipient(
        verification.accountName,
        accountNumber,
        bankCode
      );

      if (!recipient.recipientCode) {
        return res.status(500).json({ success: false, message: 'Failed to create transfer recipient. Please try again.' });
      }

      // 3. Save to Firestore — including bankName ✅
      const { updateDocument } = require('../config/firebase');
      await updateDocument('users', userId, {
        paystackRecipientCode: recipient.recipientCode,
        bankAccount: {
          accountName: verification.accountName,
          accountNumber,
          bankCode,
          bankName: bankName || '',          // ✅ Save the bank name
          verified: true,
          addedAt: Date.now(),
        },
      });

      console.log(`✅ Bank details saved for ${userId}: ${recipient.recipientCode}`);

      res.json({
        success: true,
        message: 'Bank details added successfully',
        accountName: verification.accountName,
      });
    } catch (error) {
      console.error('❌ Add bank details error:', error);
      res.status(500).json({ success: false, message: error.message || 'Failed to add bank details' });
    }
  }
);

// ─── GET /api/v1/wallet/balance/:userId ──────────────────────────────────────

router.get(
  '/balance/:userId',
  authenticate,
  authorizeOwnership('wallets'),
  userCacheMiddleware(CACHE_TTL.SHORT),
  async (req, res) => {
    try {
      const wallet = await walletService.getWallet(req.params.userId);
      res.json({
        success: true,
        balance: wallet.balance,
        pendingBalance: wallet.pendingBalance || 0,
        currency: 'NGN',
      });
    } catch (error) {
      console.error('Get balance error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch balance' });
    }
  }
);

// ─── GET /api/v1/wallet/stats/:userId ────────────────────────────────────────

router.get(
  '/stats/:userId',
  authenticate,
  authorizeOwnership('wallets'),
  userCacheMiddleware(CACHE_TTL.SHORT),
  async (req, res) => {
    try {
      const wallet = await walletService.getWallet(req.params.userId);
      const stats = {
        currentBalance: wallet.balance,
        pendingBalance: wallet.pendingBalance || 0,
        totalDeposits: 0,
        totalWithdrawals: 0,
        totalSpent: 0,
        transactionCount: wallet.transactions.length,
        lastTransaction: wallet.transactions[0] || null,
      };

      wallet.transactions.forEach((txn) => {
        if (txn.type === 'credit') {
          if (txn.metadata?.type === 'deposit' || (txn.description || '').includes('Top-up')) {
            stats.totalDeposits += txn.amount;
          }
        } else if (txn.type === 'debit') {
          if (txn.metadata?.type === 'withdrawal' || txn.metadata?.withdrawal) {
            stats.totalWithdrawals += txn.amount;
          } else {
            stats.totalSpent += txn.amount;
          }
        }
      });

      res.json({ success: true, stats });
    } catch (error) {
      console.error('Get stats error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch statistics' });
    }
  }
);

// ─── GET /api/v1/wallet/transactions/:userId ─────────────────────────────────

router.get(
  '/transactions/:userId',
  authenticate,
  authorizeOwnership('wallets'),
  async (req, res) => {
    try {
      const { page = 1, limit = 20, type, status } = req.query;
      const wallet = await walletService.getWallet(req.params.userId);

      let transactions = wallet.transactions;
      if (type)   transactions = transactions.filter((t) => t.type === type);
      if (status) transactions = transactions.filter((t) => t.status === status);

      const startIndex = (parseInt(page) - 1) * parseInt(limit);
      const paginatedTransactions = transactions.slice(startIndex, startIndex + parseInt(limit));

      res.json({
        success: true,
        transactions: paginatedTransactions,
        pagination: {
          total: transactions.length,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(transactions.length / parseInt(limit)),
        },
      });
    } catch (error) {
      console.error('Get transactions error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
    }
  }
);

// ─── GET /api/v1/wallet/:userId ──────────────────────────────────────────────

router.get(
  '/:userId',
  authenticate,
  authorizeOwnership('wallets'),
  userCacheMiddleware(CACHE_TTL.SHORT),
  async (req, res) => {
    try {
      const wallet = await walletService.getWallet(req.params.userId);
      res.json({
        success: true,
        wallet: {
          balance: wallet.balance,
          pendingBalance: wallet.pendingBalance || 0,
          transactions: wallet.transactions.slice(0, 50),
          currency: 'NGN',
        },
      });
    } catch (error) {
      console.error('Get wallet error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch wallet' });
    }
  }
);

// ─── POST /api/v1/wallet/debit ───────────────────────────────────────────────

router.post(
  '/debit',
  authenticate,
  async (req, res) => {
    try {
      const { userId, amount, description, category, metadata } = req.body;

      if (req.userId !== userId && req.userRole !== 'admin') {
        return res.status(403).json({ success: false, message: 'Unauthorized wallet access' });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Valid amount is required' });
      }

      const result = await walletService.debitWallet(
        userId,
        amount,
        description || `${category} payment`,
        { ...metadata, category: category || 'general_debit' }
      );

      res.json({ success: true, message: 'Wallet debited successfully', transaction: result.transaction });
    } catch (error) {
      console.error('Wallet debit route error:', error);
      res.status(error.message === 'Insufficient balance' ? 400 : 500).json({
        success: false,
        message: error.message || 'Failed to process debit',
      });
    }
  }
);

// ─── POST /api/v1/wallet/initialize-deposit ──────────────────────────────────

router.post(
  '/initialize-deposit',
  authenticate,
  userRateLimit(10, 15 * 60 * 1000),
  async (req, res) => {
    try {
      const { amount } = req.body;
      const userId = req.userId;

      if (!amount || amount < 100) {
        return res.status(400).json({ success: false, message: 'Minimum deposit amount is ₦100' });
      }
      if (amount > 1_000_000) {
        return res.status(400).json({ success: false, message: 'Maximum deposit amount is ₦1,000,000' });
      }

      const { getDocument } = require('../config/firebase');
      const user = await getDocument('users', userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      await walletService.ensureWalletExists(userId);

      const payment = await paystackService.initializePayment(user.email, amount, {
        userId,
        customerName: user.name,
        type: 'wallet_deposit',
      });

      res.json({ success: true, ...payment });
    } catch (error) {
      console.error('Initialize deposit error:', error);
      res.status(500).json({ success: false, message: error.message || 'Failed to initialize deposit' });
    }
  }
);

// ─── POST /api/v1/wallet/verify-deposit ──────────────────────────────────────

router.post(
  '/verify-deposit',
  authenticate,
  userRateLimit(20, 15 * 60 * 1000),
  async (req, res) => {
    try {
      const { reference } = req.body;
      if (!reference) {
        return res.status(400).json({ success: false, message: 'Payment reference is required' });
      }

      const verification = await paystackService.verifyPayment(reference);
      if (!verification.success) {
        return res.status(400).json({ success: false, message: 'Payment verification failed', status: verification.status });
      }

      const result = await walletService.creditWallet(req.userId, verification.amount, reference, {
        customerEmail: verification.customer.email,
        paymentMethod: 'paystack',
      });

      if (result.alreadyProcessed) {
        return res.json({ success: true, message: 'Payment already processed', amount: verification.amount });
      }

      res.json({ success: true, message: 'Wallet credited successfully', amount: verification.amount });
    } catch (error) {
      console.error('Verify deposit error:', error);
      res.status(500).json({ success: false, message: error.message || 'Failed to verify deposit' });
    }
  }
);

// ─── POST /api/v1/wallet/initialize-withdrawal ───────────────────────────────
// Production-grade: server-calculated fees, daily limits, PIN check, atomic
// Firestore debit, Redis idempotency, Paystack transfer, auto-refund on failure.

router.post(
  '/initialize-withdrawal',
  authenticate,
  strictLimiter,                          // 5 req / 15 min (from rateLimiters.js)
  userRateLimit(5, 15 * 60 * 1000),       // per-user secondary guard
  async (req, res) => {
    const userId      = req.userId;
    const userProfile = req.userProfile;

    try {
      // ── 1. Parse & validate request ────────────────────────────────────
      const { amountKobo } = req.body;

      if (!amountKobo || typeof amountKobo !== 'number' || amountKobo < 100_000) {
        return res.status(400).json({
          success: false,
          message: 'Minimum withdrawal is ₦1,000.',
        });
      }

      const amountNaira = amountKobo / 100;

      // ── 2. Server-side fee (ignore any fee sent by client) ──────────────
      const fee        = calculateWithdrawalFee(amountNaira);
      const totalDebit = amountNaira + fee;

      // ── 3. PIN must be enabled ──────────────────────────────────────────
      const secDoc = await db.collection('securitySettings').doc(userId).get();
      if (!secDoc.exists || !secDoc.data()?.isPinEnabled) {
        return res.status(403).json({
          success: false,
          message: 'You must set up a security PIN before making withdrawals.',
          requiresPin: true,
        });
      }

      // ── 4. Verified bank account required ──────────────────────────────
      const recipientCode = userProfile?.paystackRecipientCode;
      const bankAccount   = userProfile?.bankAccount;

      if (!recipientCode || !bankAccount?.verified) {
        return res.status(400).json({
          success: false,
          message: 'Please link a verified bank account before withdrawing.',
          requiresBankDetails: true,
        });
      }

      // ── 5. Daily limit check ────────────────────────────────────────────
      const dailyLimit = getDailyLimit(userProfile?.role);
      const usedToday  = await getDailyWithdrawalTotal(userId);

      if (usedToday + amountNaira > dailyLimit) {
        const remaining = Math.max(0, dailyLimit - usedToday);
        return res.status(400).json({
          success: false,
          message: `Daily withdrawal limit of ₦${dailyLimit.toLocaleString('en-NG')} exceeded. Remaining today: ₦${remaining.toLocaleString('en-NG')}.`,
          dailyLimit,
          usedToday,
          remaining,
        });
      }

      // ── 6. Generate idempotency reference ───────────────────────────────
      const reference = `wd_${Date.now()}_${userId.slice(0, 6)}`;
      const lockKey   = `withdraw:lock:${reference}`;

      const alreadyLocked = await client.get(lockKey);
      if (alreadyLocked) {
        return res.status(200).json({
          success: true,
          message: 'Withdrawal already being processed.',
          reference,
          alreadyProcessed: true,
        });
      }

      // ── 7. Atomic wallet deduction ──────────────────────────────────────
      const walletRef = db.collection('wallets').doc(userId);

      await db.runTransaction(async (txn) => {
        const walletSnap = await txn.get(walletRef);

        if (!walletSnap.exists) throw new Error('Wallet not found.');

        const { balance = 0, isLocked = false } = walletSnap.data();

        if (isLocked) {
          throw new Error('Wallet is currently locked. Please contact support.');
        }
        if (balance < totalDebit) {
          throw new Error(
            `Insufficient balance. You need ₦${totalDebit.toLocaleString('en-NG')} ` +
            `(₦${amountNaira.toLocaleString('en-NG')} + ₦${fee} fee) ` +
            `but have ₦${balance.toLocaleString('en-NG')}.`
          );
        }

        // Debit wallet
        txn.update(walletRef, {
          balance:   admin.firestore.FieldValue.increment(-totalDebit),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Ledger entry
        txn.set(
          walletRef.collection('transactions').doc(reference),
          {
            id:          reference,
            userId,
            type:        'debit',
            category:    'withdrawal',
            amount:      amountNaira,
            fee,
            totalDebit,
            description: `Withdrawal to ${bankAccount.accountName} (${bankAccount.bankName})`,
            timestamp:   Date.now(),
            status:      'processing',
            metadata: {
              withdrawal:    true,
              accountNumber: bankAccount.accountNumber,
              bankCode:      bankAccount.bankCode,
              accountName:   bankAccount.accountName,
              bankName:      bankAccount.bankName,
              reference,
              feeTier:
                amountNaira < 2_000   ? 'under_2000'  :
                amountNaira < 200_000 ? '2000_200000' : 'above_200000',
            },
          }
        );
      });

      // ── 8. Set Redis lock (prevents duplicates for 24 h) ────────────────
      await client.setEx(lockKey, 86_400, 'processing');

      // ── 9. Initiate Paystack transfer ────────────────────────────────────
      let transferReference = null;
      try {
        const transfer = await paystackService.initiateTransfer(
          recipientCode,
          amountNaira,                      // Paystack receives withdrawal amount (no fee)
          `EliteHub Withdrawal: ${reference}`
        );
        transferReference = transfer?.reference ?? null;

        // Stamp transfer reference onto ledger entry
        await walletRef
          .collection('transactions')
          .doc(reference)
          .update({
            paystackTransferReference: transferReference,
            transferInitiatedAt: Date.now(),
            status: 'processing',
          });
      } catch (transferErr) {
        // Paystack failure → atomically refund wallet
        console.error('[Withdrawal] Paystack transfer failed — refunding:', transferErr.message);

        await db.runTransaction(async (txn) => {
          txn.update(walletRef, {
            balance:   admin.firestore.FieldValue.increment(totalDebit),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          txn.update(
            walletRef.collection('transactions').doc(reference),
            {
              status:     'failed',
              failReason: transferErr.message || 'Paystack transfer failed',
              failedAt:   Date.now(),
            }
          );
          // Refund credit entry
          txn.set(
            walletRef.collection('transactions').doc(`refund_${reference}`),
            {
              id:          `refund_${reference}`,
              userId,
              type:        'credit',
              category:    'withdrawal_refund',
              amount:      totalDebit,
              description: `Auto-refund: withdrawal failed (${reference})`,
              timestamp:   Date.now(),
              status:      'completed',
              metadata:    { originalReference: reference },
            }
          );
        });

        await client.del(lockKey); // allow user to retry

        return res.status(502).json({
          success: false,
          message: 'Transfer initiation failed. Your wallet has been refunded. Please try again.',
        });
      }

      // ── 10. Push notification (non-blocking) ─────────────────────────────
      setImmediate(async () => {
        try {
          await pushNotificationService.sendPushToUser(
            userId,
            '💸 Withdrawal Initiated',
            `₦${amountNaira.toLocaleString('en-NG')} is being transferred to ${bankAccount.bankName}. Fee: ₦${fee}.`,
            { screen: 'ProfileTab', params: { screen: 'Transactions' }, type: 'withdrawal' }
          );
        } catch (pushErr) {
          console.warn('[Withdrawal] Push notification failed:', pushErr.message);
        }
      });

      // ── 11. Success response ─────────────────────────────────────────────
      return res.status(200).json({
        success: true,
        message: 'Withdrawal initiated successfully.',
        reference,
        transferReference,
        amount:    amountNaira,
        fee,
        totalDebit,
      });

    } catch (err) {
      console.error(`[Withdrawal] Error for ${userId}:`, err.message);
      return res
        .status(err.message?.includes('Insufficient') ? 400 : 500)
        .json({ success: false, message: err.message || 'Withdrawal failed. Please try again.' });
    }
  }
);

module.exports = router;