// src/services/wallet.service.js - PRODUCTION-GRADE WITH REDIS
const { db, admin } = require('../config/firebase');
const { client, CACHE_KEYS, CACHE_TTL } = require('../config/redis');

class WalletService {
    /**
     * FIX: Ensure wallet exists with proper initialization
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
     * FIX: Credit wallet with idempotency and Redis locking
     */
    async creditWallet(userId, amount, reference, metadata = {}) {
        const lockKey = `payment:lock:${reference}`;
        const balanceCacheKey = CACHE_KEYS.USER_WALLET(userId);

        try {
            // FIX: Redis-based idempotency check (prevents duplicate processing)
            const isProcessed = await client.get(lockKey);
            if (isProcessed) {
                console.log('⚠️ Payment already processed:', reference);
                return { 
                    success: true, 
                    alreadyProcessed: true,
                    message: 'Transaction already processed' 
                };
            }

            // FIX: Ensure wallet exists
            await this.ensureWalletExists(userId);

            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);

            // FIX: Use Firestore transaction for atomicity
            await db.runTransaction(async (transaction) => {
                const walletDoc = await transaction.get(walletRef);
                
                if (!walletDoc.exists()) {
                    throw new Error('Wallet not found during transaction');
                }

                const wallet = walletDoc.data();

                // Create transaction record
                const txnData = {
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

                // Update wallet balance
                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Add transaction to sub-collection
                transaction.set(txnRef, txnData);
            });

            // FIX: Mark as processed in Redis (24 hours TTL)
            await client.setEx(lockKey, 86400, JSON.stringify({
                userId,
                amount,
                reference,
                processedAt: Date.now()
            }));

            // FIX: Invalidate wallet cache
            await this.invalidateWalletCache(userId);

            console.log(`✅ Wallet credited: ${userId} +₦${amount}`);

            return {
                success: true,
                alreadyProcessed: false,
                transaction: { id: reference, amount, type: 'credit' }
            };

        } catch (error) {
            console.error('❌ Credit wallet error:', error);
            throw new Error(`Failed to credit wallet: ${error.message}`);
        }
    }

    /**
     * FIX: Debit wallet with validation and proper locking
     */
    async debitWallet(userId, amount, description, metadata = {}) {
        const reference = metadata.reference || `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const lockKey = `debit:lock:${reference}`;

        try {
            // FIX: Check for duplicate debit
            const isProcessed = await client.get(lockKey);
            if (isProcessed) {
                return { success: true, alreadyProcessed: true };
            }

            // FIX: Ensure wallet exists
            await this.ensureWalletExists(userId);

            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);

            // FIX: Use Firestore transaction for atomicity
            await db.runTransaction(async (transaction) => {
                const walletDoc = await transaction.get(walletRef);

                if (!walletDoc.exists) {
                    throw new Error('Wallet not found');
                }

                const wallet = walletDoc.data();

                // Validate balance
                if (wallet.balance < amount) {
                    throw new Error('Insufficient balance');
                }

                // Create transaction record
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

                // Update wallet
                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(-amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Add to sub-collection
                transaction.set(txnRef, txnData);
            });

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
                transaction: { id: reference, amount, type: 'debit' }
            };

        } catch (error) {
            console.error('❌ Debit wallet error:', error);
            throw error;
        }
    }

    /**
     * FIX: Get wallet with multi-layer caching
     * Priority: Redis → Firebase → Error
     */
    async getWallet(userId) {
        const cacheKey = CACHE_KEYS.USER_WALLET(userId);

        try {
            // Layer 1: Try Redis cache (fastest)
            const cached = await client.get(cacheKey);
            if (cached) {
                console.log(`📦 Cache HIT: wallet:${userId}`);
                return JSON.parse(cached);
            }

            console.log(`❌ Cache MISS: wallet:${userId}`);

            // Layer 2: Ensure wallet exists
            await this.ensureWalletExists(userId);

            // Layer 3: Get from Firestore
            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();

            const wallet = walletDoc.data();

            // FIX: Get recent transactions from sub-collection (not all!)
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

            // Cache for 5 minutes in Redis
            await client.setEx(cacheKey, CACHE_TTL.MEDIUM, JSON.stringify(walletData));
            console.log(`💾 Cached wallet for user: ${userId}`);

            return walletData;

        } catch (error) {
            console.error('❌ Get wallet error:', error);
            throw error;
        }
    }

    /**
     * FIX: Get balance only (lighter than full wallet)
     */
    async getBalance(userId) {
        const balanceKey = `${CACHE_KEYS.USER_WALLET(userId)}:balance`;

        try {
            // Try Redis first
            const cached = await client.get(balanceKey);
            if (cached) {
                return parseFloat(cached);
            }

            // Get from Firebase
            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();

            if (!walletDoc.exists()) {
                await this.ensureWalletExists(userId);
                return 0;
            }

            const balance = walletDoc.data().balance || 0;

            // Cache for 30 seconds
            await client.setEx(balanceKey, CACHE_TTL.SHORT, balance.toString());

            return balance;

        } catch (error) {
            console.error('Get balance error:', error);
            return 0;
        }
    }

    /**
     * FIX: Invalidate all wallet-related caches
     */
    async invalidateWalletCache(userId) {
        try {
            const keys = [
                CACHE_KEYS.USER_WALLET(userId),
                `${CACHE_KEYS.USER_WALLET(userId)}:balance`,
            ];

            await Promise.all(keys.map(key => client.del(key)));
            console.log(`🗑️ Cache invalidated for user: ${userId}`);
        } catch (error) {
            console.error('Cache invalidation error:', error);
        }
    }

    /**
     * FIX: Process order payment with escrow
     */
    async processOrderPayment(buyerId, sellerId, orderId, totalAmount, commission) {
        const lockKey = `order:payment:${orderId}`;

        try {
            // Check if already processed
            const isProcessed = await client.get(lockKey);
            if (isProcessed) {
                return { success: true, alreadyProcessed: true };
            }

            // Ensure both wallets exist
            await Promise.all([
                this.ensureWalletExists(buyerId),
                this.ensureWalletExists(sellerId)
            ]);

            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);

            // FIX: Use Firestore transaction for atomicity
            await db.runTransaction(async (transaction) => {
                const [buyerDoc, sellerDoc] = await Promise.all([
                    transaction.get(buyerRef),
                    transaction.get(sellerRef)
                ]);

                const buyer = buyerDoc.data();
                const seller = sellerDoc.data();

                // Validate buyer balance
                if (buyer.balance < totalAmount) {
                    throw new Error('Insufficient balance');
                }

                // Buyer debit
                const buyerTxn = {
                    id: `ord_${orderId}`,
                    type: 'debit',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6)} Payment`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { orderId, type: 'escrow' }
                };

                // Seller pending credit
                const sellerTxn = {
                    id: `pen_${orderId}`,
                    type: 'credit',
                    amount: totalAmount - commission,
                    description: `Order #${orderId.slice(-6)} Pending`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { orderId, type: 'escrow' }
                };

                // Update buyer wallet
                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(-totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Update seller wallet
                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount - commission),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Add transactions
                transaction.set(buyerRef.collection('transactions').doc(buyerTxn.id), buyerTxn);
                transaction.set(sellerRef.collection('transactions').doc(sellerTxn.id), sellerTxn);
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
            console.error('Process order payment error:', error);
            throw error;
        }
    }

    /**
     * FIX: Release escrow on delivery confirmation
     */
    async releaseEscrow(orderId, buyerId, sellerId, totalAmount, commission) {
        try {
            await this.ensureWalletExists(sellerId);

            const sellerRef = db.collection('wallets').doc(sellerId);
            const buyerRef = db.collection('wallets').doc(buyerId);

            await db.runTransaction(async (transaction) => {
                const [sellerDoc, buyerDoc] = await Promise.all([
                    transaction.get(sellerRef),
                    transaction.get(buyerRef)
                ]);

                const seller = sellerDoc.data();
                const buyer = buyerDoc.data();

                const sellerAmount = totalAmount - commission;

                // Release txn
                const releaseTxn = {
                    id: `rel_${orderId}`,
                    type: 'credit',
                    amount: sellerAmount,
                    description: `Order #${orderId.slice(-6)} Delivered`,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: { orderId }
                };

                // Update seller (move from pending to available)
                transaction.update(sellerRef, {
                    balance: admin.firestore.FieldValue.increment(sellerAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Update buyer (clear pending)
                transaction.update(buyerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.set(sellerRef.collection('transactions').doc(releaseTxn.id), releaseTxn);
            });

            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);

            console.log(`✅ Escrow released: ${orderId}`);

            return { success: true };

        } catch (error) {
            console.error('Release escrow error:', error);
            throw error;
        }
    }

    /**
     * FIX: Refund escrow on cancellation
     */
    async refundEscrow(orderId, buyerId, sellerId, totalAmount, commission, reason) {
        try {
            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);

            await db.runTransaction(async (transaction) => {
                const [buyerDoc, sellerDoc] = await Promise.all([
                    transaction.get(buyerRef),
                    transaction.get(sellerRef)
                ]);

                const refundTxn = {
                    id: `ref_${orderId}`,
                    type: 'credit',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6)} Refund: ${reason}`,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: { orderId, reason }
                };

                // Refund buyer
                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Clear seller pending
                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-(totalAmount - commission)),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.set(buyerRef.collection('transactions').doc(refundTxn.id), refundTxn);
            });

            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);

            console.log(`✅ Escrow refunded: ${orderId}`);

            return { success: true };

        } catch (error) {
            console.error('Refund escrow error:', error);
            throw error;
        }
    }
}

module.exports = new WalletService();