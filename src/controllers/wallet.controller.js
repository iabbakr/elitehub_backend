const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');

exports.creditWallet = async (userId, amount, reference) => {
    const lockKey = `payment:${reference}`;

    // 1. Redis Check (Cost-Cutting & Security)
    const isProcessed = await client.get(lockKey);
    if (isProcessed) return { status: 'already_handled' };

    // 2. Firebase Admin Update (The actual credit)
    const userRef = db.collection('wallets').doc(userId);
    
    await userRef.update({
        balance: admin.firestore.FieldValue.increment(amount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3. Mark in Redis for 24 hours to prevent duplicate credits
    await client.setEx(lockKey, 86400, 'true');

    return { status: 'success' };
};