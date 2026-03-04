'use strict';

/**
 * src/routes/referral.routes.js
 *
 * Security model:
 *  - referrerId is ALWAYS read from Firestore (referee.referredBy). Never from client.
 *  - Redis fast-path idempotency prevents double-payout under concurrent requests.
 *  - Firestore transaction makes wallet credit + flag + txn record 100% atomic.
 *  - Referral record is deleted ONLY after successful credit (clean-up on success).
 *  - creditReferralBonus is now EXPORTED so order.controller can call it directly,
 *    removing the fragile internal HTTP round-trip that caused bonuses to silently fail.
 *
 * Endpoints:
 *   POST /api/v1/referrals/release   — internal: kept for backwards compat but order.controller
 *                                      now calls creditReferralBonus() directly instead
 *   GET  /api/v1/referrals/pending   — paginated pending referral list for current user
 *   GET  /api/v1/referrals/stats     — totalEarned / successfulCount / pendingCount
 */

const express = require('express');
const router  = express.Router();
const { db, admin } = require('../config/firebase');
const { client }    = require('../config/redis');
const { authenticate, internalOnly } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const AppError   = require('../utils/AppError');
const pushNotificationService = require('../services/push-notification.service');

const REFERRAL_BONUS = 500; // ₦500
const PAGE_SIZE      = 10;

// ─────────────────────────────────────────────────────────────────────────────
// CORE FUNCTION: Atomic referral bonus credit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * creditReferralBonus
 *
 * ✅ EXPORTED — called directly by order.controller.confirmDelivery
 *    to avoid the fragile internal HTTP round-trip that caused silent failures.
 *
 * Atomically:
 *   1. Marks referee's `hasCompletedFirstPurchase = true`
 *   2. Credits ₦500 to referrer wallet
 *   3. Writes a wallet transaction record (idempotency key = referral_{refereeId})
 *   4. Increments referrer's `referralBonus` counter
 *   5. Deletes the referral display record from `referrals` collection
 *   6. Sets Redis lock (24 h) to block any future processing
 *
 * Returns { alreadyProcessed: true } if the payout was already done.
 *
 * @param {string} referrerId     - UID of the user who shared their code
 * @param {string} refereeId      - UID of the user who used the code (the buyer)
 * @param {string} refereeOrderId - The orderId that triggered this (for audit trail)
 */
async function creditReferralBonus(referrerId, refereeId, refereeOrderId) {
  // ── Level 1: Redis fast-path idempotency ────────────────────────────────
  // Keyed on referee so even if referrerId changes (shouldn't happen), we
  // still catch double-processing attempts.
  const lockKey = `referral:bonus:${refereeId}`;
  const already = await client.get(lockKey);
  if (already) return { alreadyProcessed: true };

  // ── Level 2: Firestore atomic transaction ────────────────────────────────
  const referrerWalletRef = db.collection('wallets').doc(referrerId);
  const referrerUserRef   = db.collection('users').doc(referrerId);
  const refereeUserRef    = db.collection('users').doc(refereeId);

  // Idempotency doc — if this doc already exists, the payout already ran
  const txnId  = `referral_${refereeId}`;
  const txnRef = referrerWalletRef.collection('transactions').doc(txnId);

  // Referral display record (used by /pending list)
  const referralDocRef = db.collection('referrals').doc(`${referrerId}_${refereeId}`);

  await db.runTransaction(async (t) => {
    const [walletSnap, referrerSnap, refereeSnap, existingTxnSnap] = await Promise.all([
      t.get(referrerWalletRef),
      t.get(referrerUserRef),
      t.get(refereeUserRef),
      t.get(txnRef),
    ]);

    // Firestore-level idempotency (belt-and-suspenders against race conditions)
    if (existingTxnSnap.exists) {
      throw Object.assign(new Error('ALREADY_PROCESSED'), { code: 'ALREADY_PROCESSED' });
    }

    if (!walletSnap.exists)   throw new AppError('Referrer wallet not found', 404);
    if (!referrerSnap.exists) throw new AppError('Referrer user not found', 404);
    if (!refereeSnap.exists)  throw new AppError('Referee user not found', 404);

    const refereeData = refereeSnap.data();

    // Security guard: validate referral ownership server-side — never trust client input
    if (refereeData.referredBy !== referrerId) {
      throw Object.assign(new Error('REFERRAL_MISMATCH'), { code: 'REFERRAL_MISMATCH' });
    }

    // Guard: hasCompletedFirstPurchase already true inside transaction
    if (refereeData.hasCompletedFirstPurchase) {
      throw Object.assign(new Error('ALREADY_PROCESSED'), { code: 'ALREADY_PROCESSED' });
    }

    // 1. Mark referee's first purchase
    t.update(refereeUserRef, {
      hasCompletedFirstPurchase: true,
      firstPurchaseOrderId: refereeOrderId,
      firstPurchaseAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 2. Credit ₦500 to referrer wallet
    t.update(referrerWalletRef, {
      balance: admin.firestore.FieldValue.increment(REFERRAL_BONUS),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 3. Write idempotent wallet transaction record
    t.set(txnRef, {
      id: txnId,
      userId: referrerId,
      type: 'credit',
      category: 'referral_bonus',
      amount: REFERRAL_BONUS,
      description: `Referral Bonus — ${refereeData.name || 'New User'} completed first purchase`,
      timestamp: Date.now(),
      status: 'completed',
      metadata: {
        refereeId,
        refereeOrderId,
        refereeName: refereeData.name || '',
        reference: txnId,
      },
    });

    // 4. Increment referrer's referralBonus counter (used by stats endpoint)
    t.update(referrerUserRef, {
      referralBonus: admin.firestore.FieldValue.increment(REFERRAL_BONUS),
      updatedAt: Date.now(),
    });

    // 5. Delete the referral display record INSIDE the transaction.
    //    This is atomic — if any step above fails, this deletion is also rolled back.
    //    After successful deletion the person no longer appears in /pending list.
    t.delete(referralDocRef);
  });

  // ── Post-transaction cleanup ─────────────────────────────────────────────

  // 6. Seal Redis lock for 24 h — blocks any future processing even if
  //    Firestore is slow to propagate the hasCompletedFirstPurchase flag
  await client.setEx(lockKey, 86_400, 'paid');

  // 7. Bust referral caches for this referrer so UI reflects changes immediately
  await Promise.allSettled([
    client.del(`referrals:stats:${referrerId}`),
    client.del(`referrals:pending:${referrerId}:first`),
  ]);

  return { alreadyProcessed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/referrals/release
//
// Internal-only endpoint — kept for backwards compatibility and manual admin
// triggers. order.controller.confirmDelivery now calls creditReferralBonus()
// directly instead of hitting this over HTTP, which was the root cause of
// silent failures when API_BASE_URL or INTERNAL_SECRET env vars were not set.
//
// Body: { buyerId: string, orderId: string }
// Header: X-Internal-Secret: <INTERNAL_SECRET>
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/release',
  internalOnly,
  catchAsync(async (req, res) => {
    const { buyerId, orderId } = req.body;

    if (!buyerId || !orderId) {
      return res.status(400).json({ success: false, message: 'buyerId and orderId are required' });
    }

    // Always read referrerId from Firestore — never trust client input
    const refereeSnap = await db.collection('users').doc(buyerId).get();
    if (!refereeSnap.exists) {
      return res.status(404).json({ success: false, message: 'Buyer not found' });
    }

    const refereeData = refereeSnap.data();

    // Fast exits — nothing to do
    if (!refereeData.referredBy) {
      return res.json({ success: true, released: false, reason: 'no_referrer' });
    }
    if (refereeData.hasCompletedFirstPurchase) {
      return res.json({ success: true, released: false, reason: 'already_processed' });
    }

    const referrerId = refereeData.referredBy;

    try {
      const result = await creditReferralBonus(referrerId, buyerId, orderId);

      if (result.alreadyProcessed) {
        return res.json({ success: true, released: false, reason: 'already_processed' });
      }

      // Push notification — fire-and-forget, never blocks response
      setImmediate(async () => {
        try {
          await pushNotificationService.sendPushToUser(
            referrerId,
            '🎉 Referral Bonus Earned!',
            `₦${REFERRAL_BONUS.toLocaleString('en-NG')} added to your wallet!`,
            { screen: 'ProfileTab', params: { screen: 'AccountInfo' }, type: 'referral_bonus' }
          );
        } catch (err) {
          console.warn('[Referral] Push notification failed (non-fatal):', err.message);
        }
      });

      console.log(`✅ [Referral] ₦${REFERRAL_BONUS} released → referrer: ${referrerId} | referee: ${buyerId} | order: ${orderId}`);
      return res.json({ success: true, released: true, amount: REFERRAL_BONUS });

    } catch (err) {
      if (err.code === 'ALREADY_PROCESSED') {
        return res.json({ success: true, released: false, reason: 'already_processed' });
      }
      if (err.code === 'REFERRAL_MISMATCH') {
        console.error(`[Referral] Mismatch blocked for buyer ${buyerId}`);
        return res.json({ success: true, released: false, reason: 'referral_mismatch' });
      }
      throw err; // bubble to global error handler
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/referrals/pending?lastCreatedAt=<cursor>
//
// Paginated list of users who signed up with the current user's referral code
// but have NOT yet completed their first purchase.
//
// Response: { success, referrals: [{uid, name, createdAt}], hasMore, nextCursor }
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/pending',
  authenticate,
  catchAsync(async (req, res) => {
    const referrerId    = req.userId;
    const lastCreatedAt = req.query.lastCreatedAt ? parseInt(req.query.lastCreatedAt, 10) : null;

    const cacheKey = `referrals:pending:${referrerId}:${lastCreatedAt || 'first'}`;
    const cached   = await client.get(cacheKey);
    if (cached) return res.json({ success: true, ...JSON.parse(cached), cached: true });

    // Query the `referrals` collection (display records) — not `users` directly.
    // This avoids a full users table scan and is much cheaper at scale.
    // Each doc: { referrerId, refereeId, refereeName, createdAt, released }
    let q = db.collection('referrals')
      .where('referrerId', '==', referrerId)
      .where('released', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(PAGE_SIZE + 1); // fetch +1 to detect hasMore

    if (lastCreatedAt) {
      q = q.startAfter(lastCreatedAt);
    }

    const snap    = await q.get();
    const docs    = snap.docs.slice(0, PAGE_SIZE);
    const hasMore = snap.docs.length > PAGE_SIZE;

    const referrals = docs.map((d) => {
      const data = d.data();
      return {
        uid: data.refereeId,
        name: data.refereeName || 'Unknown',
        createdAt: data.createdAt,
        // NOTE: We intentionally omit email/phone for privacy
      };
    });

    const lastDoc    = docs[docs.length - 1];
    const nextCursor = hasMore && lastDoc ? lastDoc.data().createdAt : null;

    const payload = { referrals, hasMore, nextCursor };
    await client.setEx(cacheKey, 60, JSON.stringify(payload)); // 60 s cache

    res.json({ success: true, ...payload });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/referrals/stats
//
// Response: { success, totalEarned, successfulCount, pendingCount }
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/stats',
  authenticate,
  catchAsync(async (req, res) => {
    const referrerId = req.userId;
    const cacheKey   = `referrals:stats:${referrerId}`;
    const cached     = await client.get(cacheKey);
    if (cached) return res.json({ success: true, ...JSON.parse(cached) });

    const userSnap = await db.collection('users').doc(referrerId).get();
    if (!userSnap.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const { referralBonus = 0 } = userSnap.data();

    // Efficient count via Firestore aggregation (no document reads)
    const pendingCountSnap = await db.collection('referrals')
      .where('referrerId', '==', referrerId)
      .where('released', '==', false)
      .count()
      .get();

    const pendingCount    = pendingCountSnap.data().count;
    const successfulCount = Math.floor(referralBonus / REFERRAL_BONUS);
    const totalEarned     = referralBonus;

    const payload = { totalEarned, successfulCount, pendingCount };
    await client.setEx(cacheKey, 120, JSON.stringify(payload)); // 2 min cache

    res.json({ success: true, ...payload });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = router;

/**
 * ✅ KEY CHANGE: creditReferralBonus is exported so order.controller.confirmDelivery
 * can call it directly as a function instead of making an HTTP POST to /release.
 *
 * The old approach failed silently because:
 *   - API_BASE_URL env var was missing/wrong → axios.post threw a connection error
 *   - INTERNAL_SECRET env var was missing → internalOnly middleware returned 403
 *   - Both errors were caught by the setImmediate try/catch and only console.error'd
 *
 * Direct function call eliminates all of that.
 */
module.exports.creditReferralBonus = creditReferralBonus;