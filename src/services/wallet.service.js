// src/services/wallet.service.js - FIXED WITH AUTO WALLET CREATION
const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');

class WalletService {
    /**
     * ✅ NEW: Ensure wallet exists for user (Critical Fix)
     */
    async ensureWalletExists(userId) {
        try {
            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();

            if (!walletDoc.exists) {
                console.log(`🆕 Creating new wallet for user: ${userId}`);
                
                const newWallet = {
                    userId,
                    balance: 0,
                    pendingBalance: 0,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                };

                await walletRef.set(newWallet);
                console.log(`✅ Wallet created successfully for: ${userId}`);
                
                return newWallet;
            }

            return walletDoc.data();
        } catch (error) {
            console.error('❌ Ensure wallet exists error:', error);
            throw new Error('Failed to ensure wallet exists');
        }
    }

    /**
     * Credit wallet with idempotency and sub-collection support
     */
    async creditWallet(userId, amount, reference, metadata = {}) {
        const lockKey = `payment:${reference}`;

        try {
            // Check if already processed
            const isProcessed = await client.get(lockKey);
            if (isProcessed) {
                console.log('⚠️ Payment already processed:', reference);
                return { 
                    success: true, 
                    alreadyProcessed: true,
                    message: 'Transaction already processed' 
                };
            }

            // ✅ Ensure wallet exists before crediting
            await this.ensureWalletExists(userId);

            const walletRef = db.collection('wallets').doc(userId);

            // Create transaction object
            const transaction = {
                id: reference,
                type: 'credit',
                amount: parseFloat(amount),
                description: metadata.type === 'deposit' 
                    ? `Wallet Top-up via ${metadata.paymentMethod || 'Paystack'}`
                    : metadata.description || `Credit - ${reference}`,
                timestamp: Date.now(),
                status: 'completed',
                metadata: {
                    ...metadata,
                    reference,
                    processedAt: new Date().toISOString()
                }
            };

            // Update wallet balance atomically
            await walletRef.update({
                balance: admin.firestore.FieldValue.increment(amount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Add transaction to sub-collection
            const txnRef = walletRef.collection('transactions').doc(reference);
            await txnRef.set(transaction);

            // Mark as processed in Redis (24 hours)
            await client.setEx(lockKey, 86400, JSON.stringify({
                userId,
                amount,
                reference,
                processedAt: Date.now()
            }));

            // Invalidate wallet cache
            await this.invalidateWalletCache(userId);

            console.log(`✅ Wallet credited: ${userId} +₦${amount}`);

            return {
                success: true,
                alreadyProcessed: false,
                transaction
            };

        } catch (error) {
            console.error('❌ Credit wallet error:', error);
            throw new Error(`Failed to credit wallet: ${error.message}`);
        }
    }

    /**
     * Debit wallet with validation
     */
    async debitWallet(userId, amount, description, metadata = {}) {
        const reference = metadata.reference || `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const lockKey = `debit:${reference}`;

        try {
            // Check if already processed
            const isProcessed = await client.get(lockKey);
            if (isProcessed) {
                return { success: true, alreadyProcessed: true };
            }

            // ✅ Ensure wallet exists
            await this.ensureWalletExists(userId);

            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();

            if (!walletDoc.exists) {
                throw new Error('Wallet not found');
            }

            const wallet = walletDoc.data();

            // Validate balance
            if (wallet.balance < amount) {
                throw new Error('Insufficient balance');
            }

            // Create transaction
            const transaction = {
                id: reference,
                type: 'debit',
                amount: parseFloat(amount),
                description: description || `Debit - ${reference}`,
                timestamp: Date.now(),
                status: metadata.status || 'completed',
                metadata: {
                    ...metadata,
                    reference,
                    processedAt: new Date().toISOString()
                }
            };

            // Update wallet
            await walletRef.update({
                balance: admin.firestore.FieldValue.increment(-amount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Add to sub-collection
            await walletRef.collection('transactions').doc(reference).set(transaction);

            // Mark as processed
            await client.setEx(lockKey, 86400, JSON.stringify({
                userId,
                amount,
                reference,
                processedAt: Date.now()
            }));

            // Invalidate cache
            await this.invalidateWalletCache(userId);

            console.log(`✅ Wallet debited: ${userId} -₦${amount}`);

            return {
                success: true,
                transaction
            };

        } catch (error) {
            console.error('❌ Debit wallet error:', error);
            throw error;
        }
    }

    /**
     * Get wallet with caching and auto-creation
     */
    async getWallet(userId) {
        const cacheKey = `wallet:${userId}`;

        try {
            // Try Redis cache first
            const cached = await client.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            // ✅ Ensure wallet exists
            await this.ensureWalletExists(userId);

            // Get from Firestore
            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();

            const wallet = walletDoc.data();

            // Get recent transactions from sub-collection
            const txnsSnapshot = await walletRef
                .collection('transactions')
                .orderBy('timestamp', 'desc')
                .limit(50)
                .get();

            const transactions = txnsSnapshot.docs.map(doc => ({
                ...doc.data(),
                id: doc.id
            }));

            const walletData = {
                ...wallet,
                transactions
            };

            // Cache for 5 minutes
            await client.setEx(cacheKey, 300, JSON.stringify(walletData));

            return walletData;

        } catch (error) {
            console.error('❌ Get wallet error:', error);
            throw error;
        }
    }

    /**
     * Invalidate wallet cache
     */
    async invalidateWalletCache(userId) {
        try {
            await client.del(`wallet:${userId}`);
            await client.del(`wallet:balance:${userId}`);
            console.log(`🗑️ Cache invalidated for user: ${userId}`);
        } catch (error) {
            console.error('Cache invalidation error:', error);
        }
    }
}

module.exports = new WalletService();