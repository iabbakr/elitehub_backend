// src/services/wallet.service.js - FIREBASE AS SOURCE OF TRUTH
const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');

class WalletService {
    /**
     * ✅ SECURITY GATE: Internal helper
     * Ensures no operations occur on a locked wallet
     */
    async _verifyWalletStatus(userId) {
        const walletRef = db.collection('wallets').doc(userId);
        const walletDoc = await walletRef.get();
        
        if (!walletDoc.exists) throw new Error("Wallet not found");
        
        const walletData = walletDoc.data();
        
        // 🛡️ THE SECURITY GATE
        if (walletData.isLocked) {
            throw new Error(`CRITICAL_LOCK: Wallet is disabled. Reason: ${walletData.lockReason || 'Unspecified security violation'}`);
        }
        
        return walletData;
    }

    /**
     * ✅ PUBLIC SECURITY CHECK
     * Must be called before any debit/payment operation
     */
    async validateWalletAccess(userId) {
        return await this._verifyWalletStatus(userId);
    }

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
                    isLocked: false,
                    lockReason: null,
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
     */
    async creditWallet(userId, amount, reference, metadata = {}) {
        const lockKey = `payment:lock:${reference}`;

        try {
            // Redis check for idempotency
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
                    description: metadata.description || `Wallet Top-up - ${reference}`,
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

            await client.setEx(lockKey, 86400, 'true');
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
     */
    async debitWallet(userId, amount, description, metadata = {}) {
        const reference = metadata.idempotencyKey || metadata.reference || `db_${Date.now()}_${userId.slice(0, 4)}`;
        const lockKey = `debit:lock:${reference}`;

        try {
            // 🛡️ Security Check
            await this._verifyWalletStatus(userId);

            const cachedResult = await client.get(lockKey);
            if (cachedResult) {
                console.log('⚠️ Duplicate debit request blocked:', reference);
                return JSON.parse(cachedResult);
            }

            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);

            const result = await db.runTransaction(async (transaction) => {
                const walletDoc = await transaction.get(walletRef);

                if (!walletDoc.exists) throw new Error('Wallet not found');
                const wallet = walletDoc.data();

                if (wallet.balance < amount) throw new Error('Insufficient balance');

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
     * ✅ Get wallet from FIREBASE
     */
    async getWallet(userId) {
        const cacheKey = `wallet:cache:${userId}`;
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
            await client.setEx(cacheKey, 300, JSON.stringify(walletData));
            
            return walletData;
        } catch (error) {
            console.error('❌ Get wallet error:', error);
            throw error;
        }
    }

    /**
     * ✅ Get balance from FIREBASE
     */
    async getBalance(userId) {
        const balanceKey = `wallet:balance:${userId}`;
        try {
            const cached = await client.get(balanceKey);
            if (cached) return parseFloat(cached);

            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();

            if (!walletDoc.exists) {
                await this.ensureWalletExists(userId);
                return 0;
            }

            const balance = walletDoc.data().balance || 0;
            await client.setEx(balanceKey, 30, balance.toString());

            return balance;
        } catch (error) {
            console.error('❌ Get balance error:', error);
            return 0;
        }
    }

    /**
     * ✅ Invalidate Redis cache
     */
    async invalidateWalletCache(userId) {
        try {
            const keys = [`wallet:cache:${userId}`, `wallet:balance:${userId}`];
            await Promise.all(keys.map(key => client.del(key)));
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
            // 🛡️ Security Check
            await this._verifyWalletStatus(buyerId);

            const isProcessed = await client.get(lockKey);
            if (isProcessed) return { success: true, alreadyProcessed: true };

            await Promise.all([this.ensureWalletExists(buyerId), this.ensureWalletExists(sellerId)]);

            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);

            await db.runTransaction(async (transaction) => {
                const [buyerDoc, sellerDoc] = await Promise.all([
                    transaction.get(buyerRef),
                    transaction.get(sellerRef)
                ]);

                const buyerWallet = buyerDoc.data();
                if (buyerWallet.balance < totalAmount) throw new Error('Insufficient balance');

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

            await client.setEx(lockKey, 86400, 'true');
            await Promise.all([this.invalidateWalletCache(buyerId), this.invalidateWalletCache(sellerId)]);

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
    // services/wallet.service.js

async releaseEscrow(orderId, buyerId, sellerId, totalAmount, commission) {
    try {
        const sellerRef = db.collection('wallets').doc(sellerId);
        const buyerRef = db.collection('wallets').doc(buyerId);
        const orderRef = db.collection('orders').doc(orderId);

        return await db.runTransaction(async (transaction) => {
            const orderDoc = await transaction.get(orderRef);
            
            // GUARD: If order is already delivered, stop the transaction!
            if (orderDoc.data().status === 'delivered') {
                throw new Error("Order already completed and paid.");
            }

            const sellerAmount = totalAmount - commission;

            // 1. Update Order Status (Inside the same lock)
            transaction.update(orderRef, {
                status: 'delivered',
                buyerConfirmed: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // 2. Release Money to Seller
            transaction.update(sellerRef, {
                balance: admin.firestore.FieldValue.increment(sellerAmount),
                pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // 3. Clear Escrow from Buyer
            transaction.update(buyerRef, {
                pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return { success: true };
        });
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

            await db.runTransaction(async (transaction) => {
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

                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-(totalAmount - commission)),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            await Promise.all([this.invalidateWalletCache(buyerId), this.invalidateWalletCache(sellerId)]);
            return { success: true };
        } catch (error) {
            console.error('❌ Refund escrow error:', error);
            throw error;
        }
    }
}

module.exports = new WalletService();