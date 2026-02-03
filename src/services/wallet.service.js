// src/services/wallet.service.js - FIREBASE AS SOURCE OF TRUTH
const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');
const emailService = require('./email.service');     // Added the dot
const paystackService = require('./paystack.service'); // Ensure this matches too
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
     * ✅ ATOMIC WITHDRAWAL INITIALIZATION
     * Deducts balance and prepares the Paystack transfer
     */
    async initializeWithdrawal(userId, userEmail, userName, payload) {
        const { amountKobo, accountNumber, bankCode, accountName } = payload;
        const amountNaira = amountKobo / 100;
        const reference = `wd_${Date.now()}_${userId.slice(0, 5)}`;
        const lockKey = `withdraw:lock:${reference}`;

        try {
            // 🛡️ Security Check: Ensure wallet isn't locked
            await this._verifyWalletStatus(userId);

            // 1️⃣ START FIREBASE TRANSACTION
            const result = await db.runTransaction(async (transaction) => {
                const walletRef = db.collection('wallets').doc(userId);
                const userRef = db.collection('users').doc(userId);
                const txnRef = db.collection('transactions').doc(`txn_${reference}`);

                const [walletSnap, userSnap] = await Promise.all([
                    transaction.get(walletRef),
                    transaction.get(userRef)
                ]);

                if (!walletSnap.exists) throw new Error('Wallet not found');
                const wallet = walletSnap.data();

                // 2️⃣ BALANCE CHECK
                if (wallet.balance < amountNaira) {
                    throw new Error('Insufficient balance');
                }

                const userData = userSnap.data();
                if (!userData.paystackRecipientCode) {
                    throw new Error('Bank recipient not found. Please link your bank account again.');
                }

                // 3️⃣ LEDGER RECORD (Auditable)
                transaction.set(txnRef, {
                    id: reference,
                    userId,
                    type: 'debit',
                    amount: amountNaira,
                    description: `Withdrawal to ${accountName} (${bankCode})`,
                    status: 'processing',
                    timestamp: Date.now(),
                    metadata: { 
                        withdrawal: true, 
                        accountNumber, 
                        bankCode, 
                        accountName 
                    }
                });

                // 4️⃣ DEDUCT BALANCE
                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(-amountNaira),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                return { recipientCode: userData.paystackRecipientCode };
            });

            // 5️⃣ INITIATE PAYSTACK TRANSFER
            const transfer = await paystackService.initiateTransfer(
                result.recipientCode,
                amountNaira,
                `EliteHub Payout: ${reference}`
            );

            // 6️⃣ LOCK IN REDIS & INVALIDATE CACHE
            await client.setEx(lockKey, 86400, 'true');
            await this.invalidateWalletCache(userId);

            // 7️⃣ NON-BLOCKING NOTIFICATION
            try {
                await emailService.sendWithdrawalConfirmation(userEmail, userName, amountNaira, {
                    accountName,
                    bankName: "Verified Bank",
                    accountNumber
                });
            } catch (err) {
                console.warn('📧 Notification failed but withdrawal succeeded:', err.message);
            }

            return { 
                success: true, 
                reference: transfer.reference, 
                amount: amountNaira 
            };

        } catch (error) {
            console.error(`❌ Withdrawal Initialization Error for ${userId}:`, error.message);
            throw error;
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
     * ✅ ENHANCED: Process order payment with better error handling
     */
    async processOrderPayment(buyerId, sellerId, orderId, totalAmount, commission) {
        const lockKey = `order:payment:${orderId}`;

        try {
            // Security check
            await this._verifyWalletStatus(buyerId);

            // Idempotency check
            const isProcessed = await client.get(lockKey);
            if (isProcessed) {
                console.log(`⚠️ Order payment already processed: ${orderId}`);
                return { success: true, alreadyProcessed: true };
            }

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

                const buyerWallet = buyerDoc.data();
                
                if (buyerWallet.balance < totalAmount) {
                    throw new Error('Insufficient balance');
                }

                // Debit buyer
                const buyerTxnRef = buyerRef.collection('transactions').doc();
                transaction.set(buyerTxnRef, {
                    id: buyerTxnRef.id,
                    userId: buyerId,
                    type: 'debit',
                    category: 'order_payment',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6)} - Escrow`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { 
                        orderId, 
                        commission,
                        paymentType: 'order_escrow'
                    }
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
                    userId: sellerId,
                    type: 'credit',
                    category: 'order_payment',
                    amount: totalAmount - commission,
                    description: `Order #${orderId.slice(-6)} - Pending`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { 
                        orderId, 
                        commission,
                        paymentType: 'order_pending'
                    }
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

            console.log(`✅ Order payment processed: ${orderId}`);
            return { success: true, alreadyProcessed: false };

        } catch (error) {
            console.error(`❌ Process order payment error for ${orderId}:`, error);
            throw error;
        }
    }

    /**
     * ✅ FIREBASE ATOMIC TRANSACTION: Release escrow on delivery
     */
    // services/wallet.service.js

 /**
     * ✅ CRITICAL FIX: Release escrow with strict idempotency and order status check
     */
    async releaseEscrow(orderId, buyerId, sellerId, totalAmount, commission) {
    const lockKey = `release:lock:${orderId}`;
    const sellerAmount = totalAmount - commission;

    try {
        // 1️⃣ REDIS IDEMPOTENCY CHECK
        const isProcessed = await client.get(lockKey);
        if (isProcessed) {
            console.log(`⚠️ Payment already released for order ${orderId}`);
            return { 
                success: true, 
                alreadyProcessed: true,
                message: 'Payment was already released'
            };
        }

        // 2️⃣ SET REDIS LOCK (24 hour TTL)
        await client.setEx(lockKey, 86400, 'true');

        const sellerRef = db.collection('wallets').doc(sellerId);
        const buyerRef = db.collection('wallets').doc(buyerId);
        const orderRef = db.collection('orders').doc(orderId);

        // 3️⃣ FIREBASE ATOMIC TRANSACTION
        const result = await db.runTransaction(async (transaction) => {
            const orderDoc = await transaction.get(orderRef);
            if (!orderDoc.exists) throw new Error("Order not found");

            const orderData = orderDoc.data();

            // 4️⃣ CRITICAL GUARD: Check if already delivered
            if (orderData.status === 'delivered') {
                return { 
                    success: true, 
                    alreadyProcessed: true,
                    message: 'Order already delivered and paid'
                };
            }

            // 5️⃣ STATUS VALIDATION
            if (orderData.status !== 'running') {
                throw new Error(`Invalid order status: ${orderData.status}`);
            }

            // 6️⃣ GET WALLET DATA
            const [sellerDoc, buyerDoc] = await Promise.all([
                transaction.get(sellerRef),
                transaction.get(buyerRef)
            ]);

            if (!sellerDoc.exists || !buyerDoc.exists) {
                throw new Error("Wallet not found");
            }

            const buyerWallet = buyerDoc.data();

            // 7️⃣ UPDATE ORDER STATUS
            transaction.update(orderRef, {
                status: 'delivered',
                buyerConfirmed: true,
                deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // 8️⃣ UPDATE BUYER'S ORIGINAL PENDING TRANSACTION
            // We use the 'pay_orderId' naming convention established in processOrderPayment
            const buyerOriginalTxnRef = buyerRef.collection('transactions').doc(`pay_${orderId}`);
            const buyerTxnSnap = await transaction.get(buyerOriginalTxnRef);
            
            if (buyerTxnSnap.exists) {
                transaction.update(buyerOriginalTxnRef, {
                    status: 'completed',
                    description: `Order #${orderId.slice(-6).toUpperCase()} - Completed`,
                    completedAt: Date.now(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            // 9️⃣ CREATE INFORMATIONAL LOG FOR BUYER
            // This ensures the buyer sees a new log entry for the release action
            const buyerInfoTxnRef = buyerRef.collection('transactions').doc();
            transaction.set(buyerInfoTxnRef, {
                id: buyerInfoTxnRef.id,
                userId: buyerId,
                type: 'debit',
                category: 'order_release',
                amount: 0, // Informational: money already left available balance at escrow
                description: `Order #${orderId.slice(-6).toUpperCase()} - Payment Released to Seller`,
                timestamp: Date.now(),
                status: 'completed',
                metadata: { 
                    orderId, 
                    informational: true,
                    releaseType: 'delivery_confirmation' 
                }
            });

            // 🔟 RELEASE MONEY TO SELLER
            const sellerTxnRef = sellerRef.collection('transactions').doc();
            transaction.set(sellerTxnRef, {
                id: sellerTxnRef.id,
                userId: sellerId,
                type: 'credit',
                category: 'order_release',
                amount: sellerAmount,
                description: `Order #${orderId.slice(-6).toUpperCase()} - Payment Released`,
                timestamp: Date.now(),
                status: 'completed',
                metadata: { orderId, commission }
            });

            // 1️⃣1️⃣ UPDATE WALLET BALANCES
            transaction.update(sellerRef, {
                balance: admin.firestore.FieldValue.increment(sellerAmount),
                pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            transaction.update(buyerRef, {
                pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return { 
                success: true, 
                alreadyProcessed: false,
                amount: sellerAmount
            };
        });

        // 1️⃣2️⃣ INVALIDATE CACHES
        await Promise.all([
            this.invalidateWalletCache(sellerId),
            this.invalidateWalletCache(buyerId)
        ]);

        return result;

    } catch (error) {
        console.error(`❌ Release escrow error:`, error);
        if (!error.message?.includes('already delivered')) {
            await client.del(lockKey);
        }
        throw error;
    }
}

     /**
     * ✅ ENHANCED: Refund escrow with order status validation
     */
    /**
 * ✅ FULLY UPDATED: Refund escrow with original transaction status update
 * Ensures buyer logs transition from 'pending' to 'refunded' and seller pending is removed.
 */
async refundEscrow(orderId, buyerId, sellerId, totalAmount, commission, reason) {
    const lockKey = `refund:lock:${orderId}`;

    try {
        // 1️⃣ IDEMPOTENCY CHECK
        const isProcessed = await client.get(lockKey);
        if (isProcessed) {
            console.log(`⚠️ Refund already processed for order: ${orderId}`);
            return { success: true, alreadyProcessed: true };
        }

        // 2️⃣ SET REDIS LOCK (24 hour TTL)
        await client.setEx(lockKey, 86400, 'true');

        const buyerRef = db.collection('wallets').doc(buyerId);
        const sellerRef = db.collection('wallets').doc(sellerId);
        const orderRef = db.collection('orders').doc(orderId);

        // 3️⃣ FIREBASE ATOMIC TRANSACTION
        await db.runTransaction(async (transaction) => {
            // Verify order status
            const orderDoc = await transaction.get(orderRef);
            if (!orderDoc.exists) throw new Error("Order not found");

            const orderData = orderDoc.data();

            // 4️⃣ CRITICAL GUARD: Prevent refunding completed orders
            if (orderData.status === 'delivered') {
                throw new Error("Cannot refund delivered orders");
            }

            // 5️⃣ UPDATE BUYER'S ORIGINAL PENDING DEBIT
            // Targets the 'pay_orderId' doc created during order placement
            const buyerOriginalTxnRef = buyerRef.collection('transactions').doc(`pay_${orderId}`);
            const originalSnap = await transaction.get(buyerOriginalTxnRef);
            
            if (originalSnap.exists) {
                transaction.update(buyerOriginalTxnRef, {
                    status: 'refunded',
                    description: `Order #${orderId.slice(-6).toUpperCase()} - Refunded`,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            // 6️⃣ CREATE THE ACTUAL REFUND CREDIT LOG
            // This shows the money moving back into the available balance
            const refundTxnRef = buyerRef.collection('transactions').doc();
            transaction.set(refundTxnRef, {
                id: refundTxnRef.id,
                userId: buyerId,
                type: 'credit',
                category: 'order_refund',
                amount: totalAmount,
                description: `Refund: Order #${orderId.slice(-6).toUpperCase()}`,
                timestamp: Date.now(),
                status: 'completed',
                metadata: { 
                    orderId, 
                    reason,
                    refundType: 'order_cancellation'
                }
            });

            // 7️⃣ UPDATE BUYER BALANCES
            transaction.update(buyerRef, {
                balance: admin.firestore.FieldValue.increment(totalAmount),
                pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // 8️⃣ UPDATE SELLER PENDING BALANCE
            // Remove the anticipated payment from seller's pending view
            transaction.update(sellerRef, {
                pendingBalance: admin.firestore.FieldValue.increment(-(totalAmount - commission)),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // 9️⃣ UPDATE ORDER STATUS
            transaction.update(orderRef, {
                status: 'cancelled',
                cancelReason: reason,
                cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        // 🔟 INVALIDATE CACHES
        await Promise.all([
            this.invalidateWalletCache(buyerId), 
            this.invalidateWalletCache(sellerId)
        ]);

        console.log(`✅ Refund processed for order ${orderId}`);
        return { success: true, alreadyProcessed: false };

    } catch (error) {
        console.error(`❌ Refund escrow error for ${orderId}:`, error);
        
        // Clear lock on failure to allow retry (unless order was actually Delivered)
        if (!error.message?.includes('delivered')) {
            await client.del(lockKey);
        }
        
        throw error;
    }
}

}

module.exports = new WalletService();