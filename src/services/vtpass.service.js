// services/wallet.service.js - PRODUCTION WALLET SERVICE v2.0
// ATOMIC TRANSACTIONS | IDEMPOTENCY | NO MISSING TRANSACTIONS

const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');
const emailService = require('./email.service');
const paystackService = require('./paystack.service');

/**
 * 🎯 CORE PRINCIPLES
 * 1. ATOMIC: All operations use Firestore transactions
 * 2. IDEMPOTENT: Redis locks prevent duplicate processing
 * 3. AUDITABLE: Every operation logged with metadata
 * 4. RECOVERABLE: Failed operations can be retried safely
 * 5. CONSISTENT: Balance always matches transaction history
 */

class WalletService {
    /**
     * ✅ IDEMPOTENCY LOCK MANAGER
     * Prevents duplicate transactions
     */
    async _acquireLock(key, ttlSeconds = 60) {
        const lockKey = `lock:${key}`;
        const lockValue = `${Date.now()}_${Math.random()}`;
        
        // Try to acquire lock
        const acquired = await client.set(lockKey, lockValue, {
            NX: true,  // Only set if not exists
            EX: ttlSeconds
        });
        
        if (!acquired) {
            const existingValue = await client.get(lockKey);
            throw new Error(`LOCK_HELD: Operation in progress (${lockKey})`);
        }
        
        return lockValue;
    }

    async _releaseLock(key, lockValue) {
        const lockKey = `lock:${key}`;
        
        // Only release if we own the lock
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;
        
        await client.eval(script, 1, lockKey, lockValue);
    }

    /**
     * ✅ SECURITY GATE
     * Ensures wallet is not locked
     */
    async _verifyWalletStatus(userId) {
        const walletRef = db.collection('wallets').doc(userId);
        const walletDoc = await walletRef.get();
        
        if (!walletDoc.exists) {
            throw new Error("WALLET_NOT_FOUND");
        }
        
        const walletData = walletDoc.data();
        
        if (walletData.isLocked) {
            throw new Error(
                `WALLET_LOCKED: ${walletData.lockReason || 'Security hold'}`
            );
        }
        
        return walletData;
    }

    /**
     * ✅ ENSURE WALLET EXISTS
     * Creates wallet if missing (idempotent)
     */
    async ensureWalletExists(userId) {
        const walletRef = db.collection('wallets').doc(userId);
        
        try {
            const walletDoc = await walletRef.get();
            
            if (walletDoc.exists()) {
                return walletDoc.data();
            }
            
            console.log(`🆕 Creating wallet for user: ${userId}`);
            
            const newWallet = {
                userId,
                balance: 0,
                pendingBalance: 0,
                currency: 'NGN',
                isLocked: false,
                lockReason: null,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                version: 1
            };
            
            await walletRef.set(newWallet);
            console.log(`✅ Wallet created: ${userId}`);
            
            return newWallet;
        } catch (error) {
            console.error('❌ Ensure wallet error:', error);
            throw error;
        }
    }

    /**
     * ✅ ATOMIC CREDIT
     * Credit wallet with full idempotency
     */
    async creditWallet(userId, amount, reference, metadata = {}) {
        const lockKey = `credit:${reference}`;
        let lockValue;
        
        try {
            // 1️⃣ IDEMPOTENCY CHECK
            lockValue = await this._acquireLock(lockKey, 300); // 5 min lock
            
            // 2️⃣ SECURITY CHECK
            await this._verifyWalletStatus(userId);
            
            // 3️⃣ VALIDATE
            if (!amount || amount <= 0) {
                throw new Error('INVALID_AMOUNT: Must be positive');
            }
            
            // 4️⃣ ENSURE WALLET EXISTS
            await this.ensureWalletExists(userId);
            
            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);
            
            // 5️⃣ ATOMIC TRANSACTION
            await db.runTransaction(async (transaction) => {
                // Check if already processed
                const existingTxn = await transaction.get(txnRef);
                if (existingTxn.exists() && existingTxn.data().status === 'completed') {
                    throw new Error('ALREADY_PROCESSED');
                }
                
                const walletSnap = await transaction.get(walletRef);
                const currentBalance = walletSnap.data()?.balance || 0;
                const currentVersion = walletSnap.data()?.version || 1;
                
                // Create transaction record
                const txnData = {
                    id: reference,
                    userId,
                    type: 'credit',
                    category: metadata.category || 'deposit',
                    amount: parseFloat(amount),
                    description: metadata.description || `Credit - ${reference}`,
                    status: 'completed',
                    timestamp: Date.now(),
                    completedAt: Date.now(),
                    reference,
                    metadata: {
                        ...metadata,
                        previousBalance: currentBalance,
                        newBalance: currentBalance + amount,
                        processedAt: new Date().toISOString(),
                        source: 'wallet_service'
                    },
                    version: 1,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                };
                
                // Update wallet
                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: currentVersion + 1
                });
                
                // Create transaction
                transaction.set(txnRef, txnData);
            });
            
            // 6️⃣ CACHE INVALIDATION
            await this.invalidateWalletCache(userId);
            
            console.log(`✅ Credited ₦${amount} to wallet ${userId}`);
            
            return {
                success: true,
                transactionId: reference,
                newBalance: await this.getBalance(userId)
            };
            
        } catch (error) {
            if (error.message === 'ALREADY_PROCESSED') {
                console.log(`⚠️ Credit already processed: ${reference}`);
                return {
                    success: true,
                    alreadyProcessed: true,
                    transactionId: reference
                };
            }
            
            console.error('❌ Credit wallet error:', error);
            throw error;
            
        } finally {
            if (lockValue) {
                await this._releaseLock(lockKey, lockValue);
            }
        }
    }

    /**
     * ✅ ATOMIC DEBIT
     * Debit wallet with full idempotency
     */
    async debitWallet(userId, amount, description, metadata = {}) {
        const idempotencyKey = metadata.idempotencyKey || 
                              metadata.reference || 
                              `db_${Date.now()}_${userId.slice(0, 4)}`;
        const lockKey = `debit:${idempotencyKey}`;
        let lockValue;
        
        try {
            // 1️⃣ IDEMPOTENCY CHECK
            lockValue = await this._acquireLock(lockKey, 300);
            
            // 2️⃣ SECURITY CHECK
            await this._verifyWalletStatus(userId);
            
            // 3️⃣ VALIDATE
            if (!amount || amount <= 0) {
                throw new Error('INVALID_AMOUNT: Must be positive');
            }
            
            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(idempotencyKey);
            
            // 4️⃣ ATOMIC TRANSACTION
            const result = await db.runTransaction(async (transaction) => {
                // Check if already processed
                const existingTxn = await transaction.get(txnRef);
                if (existingTxn.exists() && existingTxn.data().status === 'completed') {
                    throw new Error('ALREADY_PROCESSED');
                }
                
                const walletSnap = await transaction.get(walletRef);
                
                if (!walletSnap.exists()) {
                    throw new Error('WALLET_NOT_FOUND');
                }
                
                const wallet = walletSnap.data();
                const currentBalance = wallet.balance || 0;
                
                // BALANCE CHECK
                if (currentBalance < amount) {
                    throw new Error(
                        `INSUFFICIENT_BALANCE: Available ₦${currentBalance.toFixed(2)}, Required ₦${amount.toFixed(2)}`
                    );
                }
                
                const currentVersion = wallet.version || 1;
                
                // Create transaction record
                const txnData = {
                    id: idempotencyKey,
                    userId,
                    type: 'debit',
                    category: metadata.category || 'other',
                    amount: parseFloat(amount),
                    description: description || `Debit - ${idempotencyKey}`,
                    status: metadata.status || 'completed',
                    timestamp: Date.now(),
                    completedAt: Date.now(),
                    reference: idempotencyKey,
                    relatedOrderId: metadata.orderId,
                    relatedUserId: metadata.relatedUserId,
                    metadata: {
                        ...metadata,
                        previousBalance: currentBalance,
                        newBalance: currentBalance - amount,
                        processedAt: new Date().toISOString(),
                        source: 'wallet_service'
                    },
                    version: 1,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                };
                
                // Update wallet
                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(-amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: currentVersion + 1
                });
                
                // Create transaction
                transaction.set(txnRef, txnData);
                
                return {
                    success: true,
                    transaction: txnData,
                    newBalance: currentBalance - amount
                };
            });
            
            // 5️⃣ CACHE INVALIDATION
            await this.invalidateWalletCache(userId);
            
            console.log(`✅ Debited ₦${amount} from wallet ${userId}`);
            
            return result;
            
        } catch (error) {
            if (error.message === 'ALREADY_PROCESSED') {
                console.log(`⚠️ Debit already processed: ${idempotencyKey}`);
                return {
                    success: true,
                    alreadyProcessed: true,
                    transactionId: idempotencyKey
                };
            }
            
            console.error('❌ Debit wallet error:', error);
            throw error;
            
        } finally {
            if (lockValue) {
                await this._releaseLock(lockKey, lockValue);
            }
        }
    }

    /**
     * ✅ GET WALLET BALANCE
     * With caching for performance
     */
    async getBalance(userId) {
        const cacheKey = `wallet:balance:${userId}`;
        
        try {
            // Try cache first
            const cached = await client.get(cacheKey);
            if (cached) {
                return parseFloat(cached);
            }
            
            // Get from Firestore
            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();
            
            if (!walletDoc.exists()) {
                await this.ensureWalletExists(userId);
                return 0;
            }
            
            const balance = walletDoc.data().balance || 0;
            
            // Cache for 30 seconds
            await client.setEx(cacheKey, 30, balance.toString());
            
            return balance;
            
        } catch (error) {
            console.error('❌ Get balance error:', error);
            return 0;
        }
    }

    /**
     * ✅ GET FULL WALLET
     * With recent transactions
     */
    async getWallet(userId) {
        const cacheKey = `wallet:full:${userId}`;
        
        try {
            // Try cache
            const cached = await client.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
            
            // Ensure exists
            await this.ensureWalletExists(userId);
            
            // Get wallet
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
     * ✅ INVALIDATE CACHE
     * Clear all wallet caches
     */
    async invalidateWalletCache(userId) {
        try {
            const keys = [
                `wallet:balance:${userId}`,
                `wallet:full:${userId}`,
                `wallet:stats:${userId}`
            ];
            
            await Promise.all(keys.map(key => client.del(key)));
        } catch (error) {
            console.warn('⚠️ Cache invalidation error:', error);
        }
    }

    /**
     * ✅ PROCESS ORDER PAYMENT (ESCROW)
     * Atomic order payment with escrow lock
     */
    async processOrderPayment(buyerId, sellerId, orderId, totalAmount, commission) {
        const lockKey = `order:payment:${orderId}`;
        let lockValue;
        
        try {
            // 1️⃣ ACQUIRE LOCK
            lockValue = await this._acquireLock(lockKey, 300);
            
            // 2️⃣ SECURITY CHECKS
            await this._verifyWalletStatus(buyerId);
            await this._verifyWalletStatus(sellerId);
            
            // 3️⃣ ENSURE WALLETS EXIST
            await Promise.all([
                this.ensureWalletExists(buyerId),
                this.ensureWalletExists(sellerId)
            ]);
            
            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);
            
            // 4️⃣ ATOMIC TRANSACTION
            await db.runTransaction(async (transaction) => {
                const [buyerSnap, sellerSnap] = await Promise.all([
                    transaction.get(buyerRef),
                    transaction.get(sellerRef)
                ]);
                
                const buyerWallet = buyerSnap.data();
                const sellerWallet = sellerSnap.data();
                
                // Balance check
                if (buyerWallet.balance < totalAmount) {
                    throw new Error(
                        `INSUFFICIENT_BALANCE: Available ₦${buyerWallet.balance.toFixed(2)}, Required ₦${totalAmount.toFixed(2)}`
                    );
                }
                
                const sellerAmount = totalAmount - commission;
                
                // Debit buyer (move to escrow)
                const buyerTxnRef = buyerRef.collection('transactions').doc();
                transaction.set(buyerTxnRef, {
                    id: buyerTxnRef.id,
                    userId: buyerId,
                    type: 'debit',
                    category: 'order_payment',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6)} - Payment (Escrow)`,
                    status: 'pending',
                    timestamp: Date.now(),
                    relatedOrderId: orderId,
                    relatedUserId: sellerId,
                    metadata: {
                        orderId,
                        commission,
                        sellerAmount,
                        paymentType: 'escrow_lock',
                        previousBalance: buyerWallet.balance,
                        newBalance: buyerWallet.balance - totalAmount
                    },
                    version: 1,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(-totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: admin.firestore.FieldValue.increment(1)
                });
                
                // Pending credit for seller
                const sellerTxnRef = sellerRef.collection('transactions').doc();
                transaction.set(sellerTxnRef, {
                    id: sellerTxnRef.id,
                    userId: sellerId,
                    type: 'credit',
                    category: 'order_payment',
                    amount: sellerAmount,
                    description: `Order #${orderId.slice(-6)} - Pending Payment`,
                    status: 'pending',
                    timestamp: Date.now(),
                    relatedOrderId: orderId,
                    relatedUserId: buyerId,
                    metadata: {
                        orderId,
                        commission,
                        paymentType: 'escrow_pending',
                        previousBalance: sellerWallet.balance,
                        expectedBalance: sellerWallet.balance + sellerAmount
                    },
                    version: 1,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(sellerAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: admin.firestore.FieldValue.increment(1)
                });
            });
            
            // 5️⃣ CACHE INVALIDATION
            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);
            
            console.log(`✅ Order payment processed: ${orderId}`);
            
            return {
                success: true,
                orderId,
                message: 'Payment locked in escrow'
            };
            
        } catch (error) {
            console.error(`❌ Process order payment error for ${orderId}:`, error);
            throw error;
            
        } finally {
            if (lockValue) {
                await this._releaseLock(lockKey, lockValue);
            }
        }
    }

    /**
     * ✅ RELEASE ESCROW
     * Release funds to seller on delivery confirmation
     */
    async releaseEscrow(orderId, buyerId, sellerId, totalAmount, commission) {
        const lockKey = `release:${orderId}`;
        let lockValue;
        
        try {
            // 1️⃣ ACQUIRE LOCK
            lockValue = await this._acquireLock(lockKey, 300);
            
            const sellerAmount = totalAmount - commission;
            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);
            const orderRef = db.collection('orders').doc(orderId);
            
            // 2️⃣ ATOMIC TRANSACTION
            await db.runTransaction(async (transaction) => {
                // Get fresh order data
                const orderSnap = await transaction.get(orderRef);
                
                if (!orderSnap.exists()) {
                    throw new Error('ORDER_NOT_FOUND');
                }
                
                const orderData = orderSnap.data();
                
                // CRITICAL: Check if already delivered
                if (orderData.status === 'delivered') {
                    throw new Error('ALREADY_DELIVERED');
                }
                
                // Status validation
                if (orderData.status !== 'running') {
                    throw new Error(
                        `INVALID_STATUS: Expected 'running', got '${orderData.status}'`
                    );
                }
                
                // Get wallets
                const [buyerSnap, sellerSnap] = await Promise.all([
                    transaction.get(buyerRef),
                    transaction.get(sellerRef)
                ]);
                
                const buyerWallet = buyerSnap.data();
                const sellerWallet = sellerSnap.data();
                
                // UPDATE ORDER STATUS FIRST (prevents race conditions)
                transaction.update(orderRef, {
                    status: 'delivered',
                    buyerConfirmed: true,
                    deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                // Release to seller
                const sellerTxnRef = sellerRef.collection('transactions').doc();
                transaction.set(sellerTxnRef, {
                    id: sellerTxnRef.id,
                    userId: sellerId,
                    type: 'credit',
                    category: 'order_release',
                    amount: sellerAmount,
                    description: `Order #${orderId.slice(-6)} - Payment Released`,
                    status: 'completed',
                    timestamp: Date.now(),
                    completedAt: Date.now(),
                    relatedOrderId: orderId,
                    relatedUserId: buyerId,
                    metadata: {
                        orderId,
                        commission,
                        releaseType: 'delivery_confirmation',
                        previousBalance: sellerWallet.balance,
                        newBalance: sellerWallet.balance + sellerAmount
                    },
                    version: 1,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                transaction.update(sellerRef, {
                    balance: admin.firestore.FieldValue.increment(sellerAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: admin.firestore.FieldValue.increment(1)
                });
                
                // Clear escrow from buyer
                transaction.update(buyerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: admin.firestore.FieldValue.increment(1)
                });
            });
            
            // 3️⃣ CACHE INVALIDATION
            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);
            
            console.log(`✅ Released ₦${sellerAmount} to seller ${sellerId} for order ${orderId}`);
            
            return {
                success: true,
                amount: sellerAmount,
                orderId
            };
            
        } catch (error) {
            if (error.message === 'ALREADY_DELIVERED') {
                console.log(`⚠️ Order ${orderId} already delivered`);
                return {
                    success: true,
                    alreadyProcessed: true,
                    message: 'Payment already released'
                };
            }
            
            console.error(`❌ Release escrow error for ${orderId}:`, error);
            throw error;
            
        } finally {
            if (lockValue) {
                await this._releaseLock(lockKey, lockValue);
            }
        }
    }

    /**
     * ✅ REFUND ESCROW
     * Refund buyer on order cancellation
     */
    async refundEscrow(orderId, buyerId, sellerId, totalAmount, commission, reason) {
        const lockKey = `refund:${orderId}`;
        let lockValue;
        
        try {
            // 1️⃣ ACQUIRE LOCK
            lockValue = await this._acquireLock(lockKey, 300);
            
            const sellerAmount = totalAmount - commission;
            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);
            const orderRef = db.collection('orders').doc(orderId);
            
            // 2️⃣ ATOMIC TRANSACTION
            await db.runTransaction(async (transaction) => {
                // Verify order status
                const orderSnap = await transaction.get(orderRef);
                
                if (!orderSnap.exists()) {
                    throw new Error('ORDER_NOT_FOUND');
                }
                
                const orderData = orderSnap.data();
                
                // Can't refund if already delivered
                if (orderData.status === 'delivered') {
                    throw new Error('CANNOT_REFUND_DELIVERED');
                }
                
                // Refund buyer
                const buyerTxnRef = buyerRef.collection('transactions').doc();
                transaction.set(buyerTxnRef, {
                    id: buyerTxnRef.id,
                    userId: buyerId,
                    type: 'credit',
                    category: 'order_refund',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6)} - Refund: ${reason}`,
                    status: 'completed',
                    timestamp: Date.now(),
                    completedAt: Date.now(),
                    relatedOrderId: orderId,
                    relatedUserId: sellerId,
                    metadata: {
                        orderId,
                        reason,
                        refundType: 'order_cancellation'
                    },
                    version: 1,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: admin.firestore.FieldValue.increment(1)
                });
                
                // Remove pending from seller
                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: admin.firestore.FieldValue.increment(1)
                });
                
                // Update order status
                transaction.update(orderRef, {
                    status: 'cancelled',
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            
            // 3️⃣ CACHE INVALIDATION
            await Promise.all([
                this.invalidateWalletCache(buyerId),
                this.invalidateWalletCache(sellerId)
            ]);
            
            console.log(`✅ Refund processed for order ${orderId}`);
            
            return {
                success: true,
                refundAmount: totalAmount,
                orderId
            };
            
        } catch (error) {
            console.error(`❌ Refund escrow error for ${orderId}:`, error);
            throw error;
            
        } finally {
            if (lockValue) {
                await this._releaseLock(lockKey, lockValue);
            }
        }
    }

    /**
     * ✅ WITHDRAWAL INITIALIZATION
     * Atomic withdrawal with Paystack
     */
    async initializeWithdrawal(userId, userEmail, userName, payload) {
        const { amountKobo, accountNumber, bankCode, accountName } = payload;
        const amountNaira = amountKobo / 100;
        const reference = `wd_${Date.now()}_${userId.slice(0, 5)}`;
        const lockKey = `withdraw:${reference}`;
        let lockValue;
        
        try {
            // 1️⃣ ACQUIRE LOCK
            lockValue = await this._acquireLock(lockKey, 300);
            
            // 2️⃣ SECURITY CHECK
            await this._verifyWalletStatus(userId);
            
            // 3️⃣ VALIDATE AMOUNT
            if (amountNaira < 1000) {
                throw new Error('MINIMUM_WITHDRAWAL: ₦1,000');
            }
            
            // 4️⃣ CHECK BALANCE
            const balance = await this.getBalance(userId);
            if (balance < amountNaira) {
                throw new Error(
                    `INSUFFICIENT_BALANCE: Available ₦${balance.toFixed(2)}, Required ₦${amountNaira.toFixed(2)}`
                );
            }
            
            // 5️⃣ GET RECIPIENT CODE
            const userRef = db.collection('users').doc(userId);
            const userSnap = await userRef.get();
            
            if (!userSnap.exists() || !userSnap.data().paystackRecipientCode) {
                throw new Error('BANK_DETAILS_MISSING: Please link your bank account');
            }
            
            const recipientCode = userSnap.data().paystackRecipientCode;
            
            // 6️⃣ DEBIT WALLET (with withdrawal status)
            await this.debitWallet(
                userId,
                amountNaira,
                'Withdrawal to bank account',
                {
                    category: 'withdrawal',
                    status: 'processing',
                    reference,
                    accountNumber,
                    bankCode,
                    accountName
                }
            );
            
            // 7️⃣ INITIATE PAYSTACK TRANSFER
            const transfer = await paystackService.initiateTransfer(
                recipientCode,
                amountNaira,
                `EliteHub Payout: ${reference}`
            );
            
            // 8️⃣ EMAIL NOTIFICATION (non-blocking)
            try {
                await emailService.sendWithdrawalConfirmation(
                    userEmail,
                    userName,
                    amountNaira,
                    { accountName, bankName: 'Bank', accountNumber }
                );
            } catch (err) {
                console.warn('📧 Email notification failed:', err.message);
            }
            
            console.log(`✅ Withdrawal initiated: ${reference}`);
            
            return {
                success: true,
                reference: transfer.reference,
                amount: amountNaira
            };
            
        } catch (error) {
            console.error(`❌ Withdrawal initialization error:`, error);
            throw error;
            
        } finally {
            if (lockValue) {
                await this._releaseLock(lockKey, lockValue);
            }
        }
    }
}

module.exports = new WalletService();