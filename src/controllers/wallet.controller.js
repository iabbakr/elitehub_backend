/**
 * walletService.js
 * handles atomic financial operations for EliteHub Nigeria.
 */
const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');
const emailService = require('../services/emailService');

/**
 * 💰 CREDIT WALLET
 * Process incoming funds (Top-ups, Escrow Releases, Refunds)
 */
exports.creditWallet = async (userId, amount, reference, metadata = {}) => {
    const lockKey = `payment_lock:${reference}`;

    try {
        // 1. Level 1 Idempotency: Redis Check (Fastest)
        const isProcessed = await client.get(lockKey);
        if (isProcessed) return { status: 'already_handled' };

        // 2. Start Atomic Firestore Transaction
        const result = await db.runTransaction(async (t) => {
            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = db.collection('transactions').doc(`txn_${reference}`);
            const userRef = db.collection('users').doc(userId);

            const [walletSnap, userSnap, txnSnap] = await Promise.all([
                t.get(walletRef),
                t.get(userRef),
                t.get(txnRef)
            ]);

            // Level 2 Idempotency: Database Integrity Check
            if (txnSnap.exists) throw new Error('Transaction ID already exists in ledger');
            if (!userSnap.exists) throw new Error('User account not found');

            const userData = userSnap.data();

            // 3. Document the Ledger Entry
            t.set(txnRef, {
                id: reference,
                userId,
                type: 'credit',
                amount,
                status: 'completed',
                description: metadata.description || 'Wallet Top-up',
                gateway: metadata.gateway || 'paystack',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                metadata: metadata.extra || {}
            });

            // 4. Update the Balance
            // If the wallet doc doesn't exist, use set with merge; otherwise update.
            if (!walletSnap.exists) {
                t.set(walletRef, {
                    userId,
                    balance: amount,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                t.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            return { email: userData.email, name: userData.name };
        });

        // 5. Finalize Lock in Redis (24-hour TTL)
        await client.setEx(lockKey, 86400, 'true');

        // 6. Non-blocking Notification
        // We don't 'await' this to ensure the API response is snappy
        emailService.sendDepositAlert(result.email, result.name, amount);

        return { status: 'success', reference };

    } catch (error) {
        console.error(`❌ Credit Wallet Failure [Ref: ${reference}]:`, error.message);
        throw error; 
    }
};

/**
 * 💸 DEBIT WALLET
 * Process out-going funds (Purchases, Bill Payments, Withdrawals)
 */
exports.debitWallet = async (userId, amount, reference, metadata = {}) => {
    const lockKey = `debit_lock:${reference}`;

    try {
        const isProcessed = await client.get(lockKey);
        if (isProcessed) return { status: 'already_handled' };

        const result = await db.runTransaction(async (t) => {
            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = db.collection('transactions').doc(`txn_${reference}`);
            
            const [walletSnap, txnSnap] = await Promise.all([
                t.get(walletRef),
                t.get(txnRef)
            ]);

            if (txnSnap.exists) throw new Error('Transaction already processed');
            if (!walletSnap.exists) throw new Error('Wallet not initialized');

            const currentBalance = walletSnap.data().balance || 0;

            // 🛡️ CRITICAL: Insufficient Funds Check
            if (currentBalance < amount) {
                throw new Error('Insufficient wallet balance');
            }

            // Record Debit Transaction
            t.set(txnRef, {
                id: reference,
                userId,
                type: 'debit',
                amount,
                status: 'completed',
                description: metadata.description || 'Wallet Purchase',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });

            // Decrease Balance
            t.update(walletRef, {
                balance: admin.firestore.FieldValue.increment(-amount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return true;
        });

        await client.setEx(lockKey, 86400, 'true');
        return { status: 'success', reference };

    } catch (error) {
        console.error(`❌ Debit Wallet Failure [Ref: ${reference}]:`, error.message);
        throw error;
    }
};

/**
 * 📊 GET WALLET BALANCE
 * Helper to fetch fresh balance from Firestore
 */
exports.getWalletBalance = async (userId) => {
    const walletSnap = await db.collection('wallets').doc(userId).get();
    if (!walletSnap.exists) return 0;
    return walletSnap.data().balance || 0;
};