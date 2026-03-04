/**
 * scripts/fix-stuck-referrals.js
 *
 * Self-contained — no dependency on walletService.
 *
 * Root cause of the stuck state:
 *   hasCompletedFirstPurchase is only set BY the referral bonus processing.
 *   Since that processing never ran, the flag is still false — so any script
 *   that checks the flag will always skip everyone.
 *
 * Fix:
 *   Instead of trusting hasCompletedFirstPurchase, we query the orders
 *   collection for each referee and look for at least one delivered order.
 *   If found, we process the bonus and also set the flag correctly.
 *
 * Usage (from project root):
 *   node scripts/fix-stuck-referrals.js
 *
 * Safe to re-run — fully idempotent via Redis + Firestore transaction guards.
 */

require('dotenv').config();

const { db, admin }            = require('../src/config/firebase');
const { client, connectRedis } = require('../src/config/redis');

const REFERRAL_BONUS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Check if a user has at least one delivered order, and return its ID.
// We query buyerId because the referee is always the buyer.
// ─────────────────────────────────────────────────────────────────────────────
async function getFirstDeliveredOrder(refereeId) {
  const snap = await db.collection('orders')
    .where('buyerId', '==', refereeId)
    .where('status', '==', 'delivered')
    .orderBy('createdAt', 'asc')
    .limit(1)
    .get();

  if (snap.empty) return null;
  return snap.docs[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic referral bonus credit — self-contained, no walletService dependency.
// ─────────────────────────────────────────────────────────────────────────────
async function creditReferralBonus(referrerId, refereeId, refereeOrderId) {
  const lockKey = `referral:bonus:${refereeId}`;
  const already = await client.get(lockKey);
  if (already) return { alreadyProcessed: true };

  const referrerWalletRef = db.collection('wallets').doc(referrerId);
  const referrerUserRef   = db.collection('users').doc(referrerId);
  const refereeUserRef    = db.collection('users').doc(refereeId);
  const txnId             = `referral_${refereeId}`;
  const txnRef            = referrerWalletRef.collection('transactions').doc(txnId);
  const referralDocRef    = db.collection('referrals').doc(`${referrerId}_${refereeId}`);

  await db.runTransaction(async (t) => {
    const [walletSnap, referrerSnap, refereeSnap, existingTxnSnap] = await Promise.all([
      t.get(referrerWalletRef),
      t.get(referrerUserRef),
      t.get(refereeUserRef),
      t.get(txnRef),
    ]);

    // Firestore-level idempotency
    if (existingTxnSnap.exists) {
      const err = new Error('ALREADY_PROCESSED');
      err.code  = 'ALREADY_PROCESSED';
      throw err;
    }

    if (!walletSnap.exists)   throw new Error('Referrer wallet not found');
    if (!referrerSnap.exists) throw new Error('Referrer user not found');
    if (!refereeSnap.exists)  throw new Error('Referee user not found');

    const refereeData = refereeSnap.data();

    // Validate referral ownership server-side — never trust client input
    if (refereeData.referredBy !== referrerId) {
      const err = new Error('REFERRAL_MISMATCH');
      err.code  = 'REFERRAL_MISMATCH';
      throw err;
    }

    // 1. Mark referee's first purchase (this is the flag that was never set)
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

    // 4. Increment referrer's referralBonus counter (used by /stats endpoint)
    t.update(referrerUserRef, {
      referralBonus: admin.firestore.FieldValue.increment(REFERRAL_BONUS),
      updatedAt: Date.now(),
    });

    // 5. Delete the pending referral doc — atomically, only on successful credit
    t.delete(referralDocRef);
  });

  // Seal Redis lock for 24h
  await client.setEx(lockKey, 86_400, 'paid');

  // Bust referral caches
  await Promise.allSettled([
    client.del(`referrals:stats:${referrerId}`),
    client.del(`referrals:pending:${referrerId}:first`),
  ]);

  return { alreadyProcessed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  await connectRedis();
  console.log('✅ Redis connected\n');
  console.log('🔍 Scanning for stuck referrals...\n');

  const referralsSnap = await db.collection('referrals')
    .where('released', '==', false)
    .get();

  if (referralsSnap.empty) {
    console.log('✅ No pending referrals found. Nothing to fix.');
    return;
  }

  console.log(`Found ${referralsSnap.size} pending referral(s) to check.\n`);

  let credited = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const docSnap of referralsSnap.docs) {
    const { referrerId, refereeId, refereeName } = docSnap.data();

    if (!referrerId || !refereeId) {
      console.warn(`  ⚠️  Malformed doc ${docSnap.id} — skipping`);
      skipped++;
      continue;
    }

    // ── Check actual orders, NOT the hasCompletedFirstPurchase flag ──────────
    // The flag was never set because the bonus never ran — this is the fix.
    let deliveredOrderId;
    try {
      deliveredOrderId = await getFirstDeliveredOrder(refereeId);
    } catch (err) {
      console.error(`  ❌ Could not query orders for ${refereeId}: ${err.message}`);
      errors++;
      continue;
    }

    if (!deliveredOrderId) {
      console.log(`  ⏳ ${refereeName} (${refereeId}) — no delivered orders yet, leaving pending`);
      skipped++;
      continue;
    }

    console.log(`  💳 ${refereeName} (${refereeId}) — delivered order found: ${deliveredOrderId}`);
    console.log(`     → crediting referrer: ${referrerId}`);

    try {
      const result = await creditReferralBonus(referrerId, refereeId, deliveredOrderId);

      if (result.alreadyProcessed) {
        console.log(`     ℹ️  Already processed — skipping`);
        skipped++;
      } else {
        console.log(`     ✅ ₦${REFERRAL_BONUS} credited to ${referrerId}`);
        credited++;
      }
    } catch (err) {
      if (err.code === 'ALREADY_PROCESSED') {
        console.log(`     ℹ️  Already processed (Firestore guard) — skipping`);
        skipped++;
      } else if (err.code === 'REFERRAL_MISMATCH') {
        console.warn(`     ⚠️  Referral mismatch — skipping (referredBy field doesn't match referrerId in doc)`);
        skipped++;
      } else {
        console.error(`     ❌ Error: ${err.message}`);
        errors++;
      }
    }

    // Small pause to avoid Firestore rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n─────────────────────────────────');
  console.log(`✅ Credited : ${credited}`);
  console.log(`⏭️  Skipped  : ${skipped}`);
  console.log(`❌ Errors   : ${errors}`);
  console.log('─────────────────────────────────\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('💥 Fatal:', err);
    process.exit(1);
  });