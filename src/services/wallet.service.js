const { db, runTransaction, admin } = require('../config/firebase');
const { getCache, setCache, deleteCache, CACHE_KEYS, CACHE_TTL } = require('../config/redis');
const { client } = require('../config/redis');

/**
 * PRODUCTION-GRADE WALLET SERVICE
 * Implements atomic transactions and idempotency
 */

class WalletService {
    /**
     * Get wallet balance with Redis caching
     */
    async getWallet(userId) {
        const cacheKey = CACHE_KEYS.USER_WALLET(userId);
        
        // Try cache first
        let wallet = await getCache(cacheKey);
        
        if (wallet) {
            return wallet;
        }

        // Fetch from Firestore
        const walletDoc = await db.collection('wallets').doc(userId).get();
        
        if (!walletDoc.exists) {
            // Create wallet if it doesn't exist
            wallet = {
                userId,
                balance: 0,
                pendingBalance: 0,
                transactions: [],
                createdAt: Date.now()
            };
            await db.collection('wallets').doc(userId).set(wallet);
        } else {
            wallet = { ...walletDoc.data(), userId: walletDoc.id };
        }

        // Cache for 5 minutes
        await setCache(cacheKey, wallet, CACHE_TTL.SHORT);
        
        return wallet;
    }

    /**
     * Credit wallet with idempotency check
     * Prevents double-crediting from duplicate webhook calls
     */
    async creditWallet(userId, amount, reference, metadata = {}) {
        const lockKey = `payment:lock:${reference}`;
        
        try {
            // Check if payment already processed (Redis lock)
            const isProcessed = await client.get(lockKey);
            
            if (isProcessed) {
                return {
                    success: false,
                    message: 'Payment already processed',
                    alreadyProcessed: true
                };
            }

            // Set processing lock (24 hour TTL)
            await client.setEx(lockKey, 86400, 'processing');

            // Atomic transaction
            await runTransaction(async (transaction) => {
                const walletRef = db.collection('wallets').doc(userId);
                const walletDoc = await transaction.get(walletRef);
                
                if (!walletDoc.exists) {
                    throw new Error('Wallet not found');
                }

                const wallet = walletDoc.data();
                
                // Check for duplicate transaction
                const duplicate = wallet.transactions.some(
                    t => t.metadata?.reference === reference
                );
                
                if (duplicate) {
                    throw new Error('Duplicate transaction detected');
                }

                // Prepare transaction record
                const txn = {
                    id: `dep_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'credit',
                    amount,
                    description: 'Wallet Top-up via Paystack',
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: {
                        reference,
                        ...metadata
                    }
                };

                // Update wallet
                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(amount),
                    transactions: admin.firestore.FieldValue.arrayUnion(txn),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            // Mark as completed in Redis
            await client.setEx(lockKey, 86400, 'completed');

            // Invalidate cache
            await deleteCache(CACHE_KEYS.USER_WALLET(userId));

            return {
                success: true,
                message: 'Wallet credited successfully',
                amount
            };
        } catch (error) {
            console.error('Credit wallet error:', error);
            
            // Clean up lock on error
            await client.del(lockKey);
            
            throw error;
        }
    }

    /**
     * Debit wallet with balance check
     */
    async debitWallet(userId, amount, description, metadata = {}) {
        try {
            const result = await runTransaction(async (transaction) => {
                const walletRef = db.collection('wallets').doc(userId);
                const walletDoc = await transaction.get(walletRef);
                
                if (!walletDoc.exists) {
                    throw new Error('Wallet not found');
                }

                const wallet = walletDoc.data();
                
                if (wallet.balance < amount) {
                    throw new Error('Insufficient balance');
                }

                const txn = {
                    id: `deb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'debit',
                    amount,
                    description,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata
                };

                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(-amount),
                    transactions: admin.firestore.FieldValue.arrayUnion(txn),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                return txn.id;
            });

            // Invalidate cache
            await deleteCache(CACHE_KEYS.USER_WALLET(userId));

            return {
                success: true,
                transactionId: result
            };
        } catch (error) {
            console.error('Debit wallet error:', error);
            throw error;
        }
    }

    /**
     * Transfer between wallets (order escrow)
     */
    async transferToEscrow(buyerId, sellerId, orderId, totalAmount, commission) {
        try {
            await runTransaction(async (transaction) => {
                const buyerWalletRef = db.collection('wallets').doc(buyerId);
                const sellerWalletRef = db.collection('wallets').doc(sellerId);
                
                const [buyerDoc, sellerDoc] = await Promise.all([
                    transaction.get(buyerWalletRef),
                    transaction.get(sellerWalletRef)
                ]);

                if (!buyerDoc.exists || !sellerDoc.exists) {
                    throw new Error('Wallet not found');
                }

                const buyerWallet = buyerDoc.data();
                
                if (buyerWallet.balance < totalAmount) {
                    throw new Error('Insufficient balance');
                }

                const sellerAmount = totalAmount - commission;

                // Buyer transaction
                const buyerTxn = {
                    id: `ord_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'debit',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6)} - Escrow`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { orderId, type: 'order_payment' }
                };

                // Seller transaction
                const sellerTxn = {
                    id: `pen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'credit',
                    amount: sellerAmount,
                    description: `Order #${orderId.slice(-6)} - Pending`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { orderId, type: 'order_payment' }
                };

                // Update buyer wallet
                transaction.update(buyerWalletRef, {
                    balance: admin.firestore.FieldValue.increment(-totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount),
                    transactions: admin.firestore.FieldValue.arrayUnion(buyerTxn)
                });

                // Update seller wallet
                transaction.update(sellerWalletRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(sellerAmount),
                    transactions: admin.firestore.FieldValue.arrayUnion(sellerTxn)
                });
            });

            // Invalidate caches
            await Promise.all([
                deleteCache(CACHE_KEYS.USER_WALLET(buyerId)),
                deleteCache(CACHE_KEYS.USER_WALLET(sellerId))
            ]);

            return { success: true };
        } catch (error) {
            console.error('Transfer to escrow error:', error);
            throw error;
        }
    }

    /**
     * Release escrow funds on order completion
     */
    async releaseEscrow(orderId, buyerId, sellerId, totalAmount, commission) {
        try {
            const sellerAmount = totalAmount - commission;

            await runTransaction(async (transaction) => {
                const buyerWalletRef = db.collection('wallets').doc(buyerId);
                const sellerWalletRef = db.collection('wallets').doc(sellerId);
                
                const [buyerDoc, sellerDoc] = await Promise.all([
                    transaction.get(buyerWalletRef),
                    transaction.get(sellerWalletRef)
                ]);

                const buyerWallet = buyerDoc.data();
                const sellerWallet = sellerDoc.data();

                // Update transaction statuses to completed
                const buyerTxns = buyerWallet.transactions.map(t => 
                    t.metadata?.orderId === orderId && t.status === 'pending'
                        ? { ...t, status: 'completed', updatedAt: Date.now() }
                        : t
                );

                const sellerTxns = sellerWallet.transactions.map(t =>
                    t.metadata?.orderId === orderId && t.status === 'pending'
                        ? { ...t, status: 'completed', updatedAt: Date.now() }
                        : t
                );

                // Update wallets
                transaction.update(buyerWalletRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    transactions: buyerTxns
                });

                transaction.update(sellerWalletRef, {
                    balance: admin.firestore.FieldValue.increment(sellerAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    transactions: sellerTxns
                });
            });

            // Invalidate caches
            await Promise.all([
                deleteCache(CACHE_KEYS.USER_WALLET(buyerId)),
                deleteCache(CACHE_KEYS.USER_WALLET(sellerId))
            ]);

            return { success: true };
        } catch (error) {
            console.error('Release escrow error:', error);
            throw error;
        }
    }

    /**
     * Refund escrow on order cancellation
     */
    async refundEscrow(orderId, buyerId, sellerId, totalAmount, commission, reason) {
        try {
            const sellerAmount = totalAmount - commission;

            await runTransaction(async (transaction) => {
                const buyerWalletRef = db.collection('wallets').doc(buyerId);
                const sellerWalletRef = db.collection('wallets').doc(sellerId);
                
                const [buyerDoc, sellerDoc] = await Promise.all([
                    transaction.get(buyerWalletRef),
                    transaction.get(sellerWalletRef)
                ]);

                const buyerWallet = buyerDoc.data();
                const sellerWallet = sellerDoc.data();

                // Update buyer transactions
                const buyerTxns = buyerWallet.transactions.map(t =>
                    t.metadata?.orderId === orderId && t.status === 'pending'
                        ? { ...t, status: 'refunded', updatedAt: Date.now() }
                        : t
                );

                // Add refund transaction
                const refundTxn = {
                    id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'credit',
                    amount: totalAmount,
                    description: `Refund - Order #${orderId.slice(-6)}`,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: { orderId, reason, type: 'refund' }
                };

                buyerTxns.unshift(refundTxn);

                // Update seller transactions
                const sellerTxns = sellerWallet.transactions.map(t =>
                    t.metadata?.orderId === orderId && t.status === 'pending'
                        ? { ...t, status: 'cancelled', updatedAt: Date.now() }
                        : t
                );

                // Update wallets
                transaction.update(buyerWalletRef, {
                    balance: admin.firestore.FieldValue.increment(totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    transactions: buyerTxns
                });

                transaction.update(sellerWalletRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    transactions: sellerTxns
                });
            });

            // Invalidate caches
            await Promise.all([
                deleteCache(CACHE_KEYS.USER_WALLET(buyerId)),
                deleteCache(CACHE_KEYS.USER_WALLET(sellerId))
            ]);

            return { success: true };
        } catch (error) {
            console.error('Refund escrow error:', error);
            throw error;
        }
    }
}

module.exports = new WalletService();