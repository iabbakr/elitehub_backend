// src/services/wallet.service.js - PRODUCTION-GRADE WITH REDIS & IDEMPOTENCY
const { db, admin } = require('../config/firebase');
const { client, CACHE_KEYS, CACHE_TTL } = require('../config/redis');

class WalletService {
    /**
     * FIX: Ensure wallet exists with proper initialization.
     * In Firebase Admin SDK, .exists is a property, not a function.
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
     * FIX: Credit wallet with idempotency.
     * Prevents duplicate processing of the same payment reference.
     */
    async creditWallet(userId, amount, reference, metadata = {}) {
        const lockKey = `payment:lock:${reference}`;

        try {
            // Check Redis for idempotency
            const isProcessed = await client.get(lockKey);
            if (isProcessed) {
                console.log('⚠️ Payment already processed:', reference);
                return { success: true, alreadyProcessed: true };
            }

            await this.ensureWalletExists(userId);

            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);

            await db.runTransaction(async (transaction) => {
                const walletDoc = await transaction.get(walletRef);
                
                if (!walletDoc.exists) {
                    throw new Error('Wallet not found during transaction');
                }

                const txnData = {
                    id: reference,
                    type: 'credit',
                    amount: parseFloat(amount),
                    description: metadata.description || `Credit - ${reference}`,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: {
                        ...metadata,
                        reference,
                        processedAt: new Date().toISOString()
                    }
                };

                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.set(txnRef, txnData);
            });

            // Mark as processed in Redis (24-hour expiry)
            await client.setEx(lockKey, 86400, 'true');
            await this.invalidateWalletCache(userId);

            return { success: true, alreadyProcessed: false };
        } catch (error) {
            console.error('❌ Credit wallet error:', error);
            throw error;
        }
    }

    /**
     * ENHANCED: Debit wallet with Idempotency Key logic.
     * Prevents double-charging users during network retries or timeouts.
     */
    async debitWallet(userId, amount, description, metadata = {}) {
        // Use provided idempotencyKey from frontend or fallback to a timestamp-based ref
        const reference = metadata.idempotencyKey || metadata.reference || `db_${Date.now()}_${userId.slice(0, 4)}`;
        const lockKey = `debit:lock:${reference}`;

        try {
            // 1. Check Redis for existing transaction result
            const cachedResult = await client.get(lockKey);
            if (cachedResult) {
                console.log('⚠️ Duplicate debit request blocked:', reference);
                return JSON.parse(cachedResult);
            }

            await this.ensureWalletExists(userId);

            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);

            const result = await db.runTransaction(async (transaction) => {
                const walletDoc = await transaction.get(walletRef);

                if (!walletDoc.exists) {
                    throw new Error('Wallet not found');
                }

                const wallet = walletDoc.data();

                if (wallet.balance < amount) {
                    throw new Error('Insufficient balance');
                }

                const txnData = {
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

                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(-amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.set(txnRef, txnData);

                return { success: true, transaction: txnData };
            });

            // 2. Cache successful result for 24 hours to handle retries
            await client.setEx(lockKey, 86400, JSON.stringify(result));
            await this.invalidateWalletCache(userId);

            return result;

        } catch (error) {
            console.error('❌ Debit wallet error:', error);
            throw error;
        }
    }

    /**
     * FIX: Get wallet with multi-layer caching.
     */
    async getWallet(userId) {
        const cacheKey = CACHE_KEYS.USER_WALLET(userId);

        try {
            const cached = await client.get(cacheKey);
            if (cached) return JSON.parse(cached);

            await this.ensureWalletExists(userId);

            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();
            const wallet = walletDoc.data();

            const txnsSnapshot = await walletRef
                .collection('transactions')
                .orderBy('timestamp', 'desc')
                .limit(50)
                .get();

            const transactions = txnsSnapshot.docs.map(doc => ({
                ...doc.data(),
                id: doc.id
            }));

            const walletData = { ...wallet, transactions };

            await client.setEx(cacheKey, CACHE_TTL.MEDIUM, JSON.stringify(walletData));
            return walletData;

        } catch (error) {
            console.error('❌ Get wallet error:', error);
            throw error;
        }
    }

    /**
     * FIX: Get balance only.
     */
    async getBalance(userId) {
        const balanceKey = `${CACHE_KEYS.USER_WALLET(userId)}:balance`;

        try {
            const cached = await client.get(balanceKey);
            if (cached) return parseFloat(cached);

            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();

            if (!walletDoc.exists) return 0;

            const balance = walletDoc.data().balance || 0;
            await client.setEx(balanceKey, CACHE_TTL.SHORT, balance.toString());

            return balance;
        } catch (error) {
            return 0;
        }
    }

    /**
     * FIX: Invalidate all wallet-related caches.
     */
    async invalidateWalletCache(userId) {
        try {
            const keys = [
                CACHE_KEYS.USER_WALLET(userId),
                `${CACHE_KEYS.USER_WALLET(userId)}:balance`,
            ];
            await Promise.all(keys.map(key => client.del(key)));
        } catch (error) {
            console.warn('Cache invalidation error:', error);
        }
    }

    /**
     * FIX: Process order payment with escrow.
     */
    async processOrderPayment(buyerId, sellerId, orderId, totalAmount, commission) {
        const lockKey = `order:payment:${orderId}`;

        try {
            const isProcessed = await client.get(lockKey);
            if (isProcessed) return { success: true, alreadyProcessed: true };

            await Promise.all([
                this.ensureWalletExists(buyerId),
                this.ensureWalletExists(sellerId)
            ]);

            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);

            await db.runTransaction(async (transaction) => {
                const [buyerDoc, sellerDoc] = await Promise.all([
                    transaction.get(buyerRef),
                    transaction.get(sellerRef)
                ]);

                if (buyerDoc.data().balance < totalAmount) {
                    throw new Error('Insufficient balance');
                }

                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(-totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount - commission),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            await client.setEx(lockKey, 86400, 'true');
            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);

            return { success: true };
        } catch (error) {
            console.error('Process order payment error:', error);
            throw error;
        }
    }

    /**
     * FIX: Release escrow on delivery.
     */
    async releaseEscrow(orderId, buyerId, sellerId, totalAmount, commission) {
        try {
            const sellerRef = db.collection('wallets').doc(sellerId);
            const buyerRef = db.collection('wallets').doc(buyerId);

            await db.runTransaction(async (transaction) => {
                const [sellerDoc, buyerDoc] = await Promise.all([
                    transaction.get(sellerRef),
                    transaction.get(buyerRef)
                ]);

                const sellerAmount = totalAmount - commission;

                transaction.update(sellerRef, {
                    balance: admin.firestore.FieldValue.increment(sellerAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.update(buyerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);

            return { success: true };
        } catch (error) {
            console.error('Release escrow error:', error);
            throw error;
        }
    }

    /**
     * FIX: Refund escrow on cancellation.
     */
    async refundEscrow(orderId, buyerId, sellerId, totalAmount, commission, reason) {
        try {
            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);

            await db.runTransaction(async (transaction) => {
                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-(totalAmount - commission)),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);

            return { success: true };
        } catch (error) {
            console.error('Refund escrow error:', error);
            throw error;
        }
    }
}

module.exports = new WalletService();