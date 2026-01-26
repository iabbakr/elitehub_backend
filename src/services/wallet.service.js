// src/services/wallet.service.js - FIREBASE AS SOURCE OF TRUTH
const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');

class WalletService {
    /**
     * ✅ FIREBASE SOURCE OF TRUTH
     * Ensure wallet exists with proper initialization
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
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: 1
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
     * ✅ FIREBASE ATOMIC TRANSACTION: Credit wallet with idempotency
     * Prevents duplicate processing of the same payment reference
     */
    async creditWallet(userId, amount, reference, metadata = {}) {
        const lockKey = `payment:lock:${reference}`;

        try {
            // Redis check for idempotency (cost-cutting & security)
            const isProcessed = await client.get(lockKey);
            if (isProcessed) {
                console.log('⚠️ Payment already processed:', reference);
                return { success: true, alreadyProcessed: true };
            }

            await this.ensureWalletExists(userId);

            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);

            // FIREBASE TRANSACTION - Source of truth update
            await db.runTransaction(async (transaction) => {
                const walletDoc = await transaction.get(walletRef);
                
                if (!walletDoc.exists) {
                    throw new Error('Wallet not found during transaction');
                }

                const txnData = {
                    id: reference,
                    type: 'credit',
                    amount: parseFloat(amount),
                    description: metadata.description || `Wallet Top-up - ${reference}`,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: {
                        ...metadata,
                        reference,
                        processedAt: new Date().toISOString()
                    }
                };

                // Update balance in Firebase (source of truth)
                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Add transaction to sub-collection
                transaction.set(txnRef, txnData);
            });

            // Mark as processed in Redis (24-hour expiry for duplicate prevention)
            await client.setEx(lockKey, 86400, 'true');
            
            // Invalidate balance cache
            await this.invalidateWalletCache(userId);

            console.log(`✅ Credited ${amount} to wallet ${userId}`);
            return { success: true, alreadyProcessed: false };
        } catch (error) {
            console.error('❌ Credit wallet error:', error);
            throw error;
        }
    }

    /**
     * ✅ FIREBASE ATOMIC TRANSACTION: Debit wallet with idempotency
     * Prevents double-charging during network retries
     */
    async debitWallet(userId, amount, description, metadata = {}) {
        const reference = metadata.idempotencyKey || metadata.reference || `db_${Date.now()}_${userId.slice(0, 4)}`;
        const lockKey = `debit:lock:${reference}`;

        try {
            // Check Redis for duplicate request
            const cachedResult = await client.get(lockKey);
            if (cachedResult) {
                console.log('⚠️ Duplicate debit request blocked:', reference);
                return JSON.parse(cachedResult);
            }

            await this.ensureWalletExists(userId);

            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);

            // FIREBASE TRANSACTION - Source of truth update
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

                // Update balance in Firebase (source of truth)
                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(-amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Add transaction to sub-collection
                transaction.set(txnRef, txnData);

                return { success: true, transaction: txnData };
            });

            // Cache successful result for 24 hours
            await client.setEx(lockKey, 86400, JSON.stringify(result));
            await this.invalidateWalletCache(userId);

            console.log(`✅ Debited ${amount} from wallet ${userId}`);
            return result;

        } catch (error) {
            console.error('❌ Debit wallet error:', error);
            throw error;
        }
    }

    /**
     * ✅ Get wallet from FIREBASE (source of truth)
     * Redis used ONLY for caching, not as source
     */
    async getWallet(userId) {
        const cacheKey = `wallet:cache:${userId}`;

        try {
            // Try Redis cache first
            const cached = await client.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            // FIREBASE IS SOURCE OF TRUTH
            await this.ensureWalletExists(userId);

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

            const walletData = { ...wallet, transactions };

            // Cache in Redis for 5 minutes
            await client.setEx(cacheKey, 300, JSON.stringify(walletData));
            
            return walletData;

        } catch (error) {
            console.error('❌ Get wallet error:', error);
            throw error;
        }
    }

    /**
     * ✅ Get balance from FIREBASE (source of truth)
     */
    async getBalance(userId) {
        const balanceKey = `wallet:balance:${userId}`;

        try {
            // Try Redis cache
            const cached = await client.get(balanceKey);
            if (cached) {
                return parseFloat(cached);
            }

            // FIREBASE IS SOURCE OF TRUTH
            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();

            if (!walletDoc.exists()) {
                await this.ensureWalletExists(userId);
                return 0;
            }

            const balance = walletDoc.data().balance || 0;
            
            // Cache for 30 seconds
            await client.setEx(balanceKey, 30, balance.toString());

            return balance;
        } catch (error) {
            console.error('❌ Get balance error:', error);
            return 0;
        }
    }

    /**
     * ✅ Invalidate Redis cache (not source of truth)
     */
    async invalidateWalletCache(userId) {
        try {
            const keys = [
                `wallet:cache:${userId}`,
                `wallet:balance:${userId}`,
            ];
            await Promise.all(keys.map(key => client.del(key)));
            console.log(`🗑️  Cache invalidated for user: ${userId}`);
        } catch (error) {
            console.warn('⚠️  Cache invalidation error:', error);
        }
    }

    /**
     * ✅ FIREBASE ATOMIC TRANSACTION: Process order payment with escrow
     */
    async processOrderPayment(buyerId, sellerId, orderId, totalAmount, commission) {
        const lockKey = `order:payment:${orderId}`;

        try {
            // Check if already processed
            const isProcessed = await client.get(lockKey);
            if (isProcessed) {
                console.log('⚠️ Order payment already processed:', orderId);
                return { success: true, alreadyProcessed: true };
            }

            await Promise.all([
                this.ensureWalletExists(buyerId),
                this.ensureWalletExists(sellerId)
            ]);

            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);

            // FIREBASE ATOMIC TRANSACTION
            await db.runTransaction(async (transaction) => {
                const [buyerDoc, sellerDoc] = await Promise.all([
                    transaction.get(buyerRef),
                    transaction.get(sellerRef)
                ]);

                const buyerWallet = buyerDoc.data();
                const sellerWallet = sellerDoc.data();

                if (buyerWallet.balance < totalAmount) {
                    throw new Error('Insufficient balance');
                }

                // Debit buyer
                const buyerTxnRef = buyerRef.collection('transactions').doc();
                transaction.set(buyerTxnRef, {
                    id: buyerTxnRef.id,
                    type: 'debit',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6)} - Escrow`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { orderId, commission }
                });

                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(-totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Pending credit for seller
                const sellerTxnRef = sellerRef.collection('transactions').doc();
                transaction.set(sellerTxnRef, {
                    id: sellerTxnRef.id,
                    type: 'credit',
                    amount: totalAmount - commission,
                    description: `Order #${orderId.slice(-6)} - Pending`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { orderId, commission }
                });

                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount - commission),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            // Mark as processed
            await client.setEx(lockKey, 86400, 'true');
            
            // Invalidate caches
            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);

            console.log(`✅ Order payment processed: ${orderId}`);
            return { success: true };
        } catch (error) {
            console.error('❌ Process order payment error:', error);
            throw error;
        }
    }

    /**
     * ✅ FIREBASE ATOMIC TRANSACTION: Release escrow on delivery
     */
    async releaseEscrow(orderId, buyerId, sellerId, totalAmount, commission) {
        try {
            const sellerRef = db.collection('wallets').doc(sellerId);
            const buyerRef = db.collection('wallets').doc(buyerId);

            // FIREBASE ATOMIC TRANSACTION
            await db.runTransaction(async (transaction) => {
                const [sellerDoc, buyerDoc] = await Promise.all([
                    transaction.get(sellerRef),
                    transaction.get(buyerRef)
                ]);

                const sellerAmount = totalAmount - commission;

                // Release to seller
                const sellerTxnRef = sellerRef.collection('transactions').doc();
                transaction.set(sellerTxnRef, {
                    id: sellerTxnRef.id,
                    type: 'credit',
                    amount: sellerAmount,
                    description: `Order #${orderId.slice(-6)} - Payment Released`,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: { orderId, commission }
                });

                transaction.update(sellerRef, {
                    balance: admin.firestore.FieldValue.increment(sellerAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Remove from buyer's pending
                transaction.update(buyerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);

            console.log(`✅ Escrow released for order: ${orderId}`);
            return { success: true };
        } catch (error) {
            console.error('❌ Release escrow error:', error);
            throw error;
        }
    }

    /**
     * ✅ FIREBASE ATOMIC TRANSACTION: Refund escrow on cancellation
     */
    async refundEscrow(orderId, buyerId, sellerId, totalAmount, commission, reason) {
        try {
            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);

            // FIREBASE ATOMIC TRANSACTION
            await db.runTransaction(async (transaction) => {
                // Refund buyer
                const buyerTxnRef = buyerRef.collection('transactions').doc();
                transaction.set(buyerTxnRef, {
                    id: buyerTxnRef.id,
                    type: 'credit',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6)} - Refund: ${reason}`,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: { orderId, reason }
                });

                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Remove from seller's pending
                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-(totalAmount - commission)),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);

            console.log(`✅ Escrow refunded for order: ${orderId}`);
            return { success: true };
        } catch (error) {
            console.error('❌ Refund escrow error:', error);
            throw error;
        }
    }
}

module.exports = new WalletService();