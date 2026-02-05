// src/services/wallet.service.js - FIXED: Unified Seller Transaction Flow
const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');
const emailService = require('./email.service');
const paystackService = require('./paystack.service');
const pushNotificationService = require('./push-notification.service');

class WalletService {
    /**
     * ✅ SECURITY GATE: Internal helper
     */
    async _verifyWalletStatus(userId) {
        const walletRef = db.collection('wallets').doc(userId);
        const walletDoc = await walletRef.get();
        
        if (!walletDoc.exists) throw new Error("Wallet not found");
        
        const walletData = walletDoc.data();
        
        if (walletData.isLocked) {
            throw new Error(`CRITICAL_LOCK: Wallet is disabled. Reason: ${walletData.lockReason || 'Unspecified security violation'}`);
        }
        
        return walletData;
    }

    async validateWalletAccess(userId) {
        return await this._verifyWalletStatus(userId);
    }

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

    async creditWallet(userId, amount, reference, metadata = {}) {
        const lockKey = `payment:lock:${reference}`;

        try {
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

    async debitWallet(userId, amount, description, metadata = {}) {
        const reference = metadata.idempotencyKey || metadata.reference || `db_${Date.now()}_${userId.slice(0, 4)}`;
        const lockKey = `debit:lock:${reference}`;

        try {
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

    async initializeWithdrawal(userId, userEmail, userName, payload) {
        const { amountKobo, accountNumber, bankCode, accountName } = payload;
        const amountNaira = amountKobo / 100;
        const reference = `wd_${Date.now()}_${userId.slice(0, 5)}`;
        const lockKey = `withdraw:lock:${reference}`;

        try {
            await this._verifyWalletStatus(userId);

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

                if (wallet.balance < amountNaira) {
                    throw new Error('Insufficient balance');
                }

                const userData = userSnap.data();
                if (!userData.paystackRecipientCode) {
                    throw new Error('Bank recipient not found. Please link your bank account again.');
                }

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
                        accountName,
                        reference
                    }
                });

                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(-amountNaira),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                return { recipientCode: userData.paystackRecipientCode };
            });

            const transfer = await paystackService.initiateTransfer(
                result.recipientCode,
                amountNaira,
                `EliteHub Payout: ${reference}`
            );

            await client.setEx(lockKey, 86400, 'true');
            await this.invalidateWalletCache(userId);

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

    async invalidateWalletCache(userId) {
        try {
            const keys = [`wallet:cache:${userId}`, `wallet:balance:${userId}`];
            await Promise.all(keys.map(key => client.del(key)));
        } catch (error) {
            console.warn('⚠️  Cache invalidation error:', error);
        }
    }

    /**
     * ✅ CRITICAL FIX: Single seller transaction that updates from pending → completed
     * Instead of creating 2 separate transactions, we create ONE that gets updated later
     */
    async processOrderPayment(buyerId, sellerId, orderId, totalAmount, commission) {
        const lockKey = `order:payment:${orderId}`;

        try {
            await this._verifyWalletStatus(buyerId);

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

                // ✅ FIX 1: Buyer transaction with reference
                const buyerTxnRef = buyerRef.collection('transactions').doc(`pay_${orderId}`);
                transaction.set(buyerTxnRef, {
                    id: `pay_${orderId}`,
                    userId: buyerId,
                    type: 'debit',
                    category: 'order_payment',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6).toUpperCase()} - Escrow Hold`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { 
                        orderId, 
                        commission,
                        paymentType: 'order_escrow',
                        reference: `pay_${orderId}` // ✅ Added reference
                    }
                });

                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(-totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // ✅ FIX 2: Create ONE seller transaction (pending) with consistent ID
                // This will be UPDATED (not replaced) when delivery is confirmed
                const sellerTxnId = `order_${orderId}`; // Consistent ID
                const sellerTxnRef = sellerRef.collection('transactions').doc(sellerTxnId);
                transaction.set(sellerTxnRef, {
                    id: sellerTxnId,
                    userId: sellerId,
                    type: 'credit',
                    category: 'order_payment',
                    amount: totalAmount - commission,
                    description: `Order #${orderId.slice(-6).toUpperCase()} - Pending Delivery`,
                    timestamp: Date.now(),
                    status: 'pending',
                    metadata: { 
                        orderId, 
                        commission,
                        paymentType: 'order_pending',
                        reference: sellerTxnId // ✅ Added reference
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
     * ✅ CRITICAL FIX: Update existing seller transaction instead of creating new one
     */
    async releaseEscrow(orderId, buyerId, sellerId, totalAmount, commission) {
        const lockKey = `release:lock:${orderId}`;
        const sellerAmount = totalAmount - commission;

        try {
            const isProcessed = await client.get(lockKey);
            if (isProcessed) return { success: true, alreadyProcessed: true };

            await client.setEx(lockKey, 86400, 'true');

            const sellerRef = db.collection('wallets').doc(sellerId);
            const buyerRef = db.collection('wallets').doc(buyerId);
            const orderRef = db.collection('orders').doc(orderId);
            const buyerOriginalTxnRef = buyerRef.collection('transactions').doc(`pay_${orderId}`);

            const result = await db.runTransaction(async (transaction) => {
                // ==========================================
                // PHASE 1: ALL READS FIRST ✅
                // ==========================================
                const [orderDoc, sellerDoc, buyerDoc, buyerTxnSnap] = await Promise.all([
                    transaction.get(orderRef),
                    transaction.get(sellerRef),
                    transaction.get(buyerRef),
                    transaction.get(buyerOriginalTxnRef)
                ]);

                if (!orderDoc.exists) throw new Error("Order not found");
                const orderData = orderDoc.data();
                
                if (orderData.status === 'delivered') return { success: true, alreadyProcessed: true };
                if (orderData.status !== 'running') throw new Error(`Invalid order status: ${orderData.status}`);
                if (!sellerDoc.exists || !buyerDoc.exists) throw new Error("Wallet not found");

                // ==========================================
                // PHASE 2: ALL WRITES AFTER ✅
                // ==========================================
                
                // 1. Update Order Status
                transaction.update(orderRef, {
                    status: 'delivered',
                    buyerConfirmed: true,
                    deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // 2. Sync Buyer's Original Payment Log
                if (buyerTxnSnap.exists) {
                    transaction.update(buyerOriginalTxnRef, {
                        status: 'completed',
                        description: `Order #${orderId.slice(-6).toUpperCase()} - Completed`,
                        completedAt: Date.now(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                // 3. ✅ FIX: UPDATE existing seller transaction instead of creating new one
                const sellerTxnRef = sellerRef.collection('transactions').doc(`order_${orderId}`);
                transaction.update(sellerTxnRef, {
                    status: 'completed',
                    category: 'order_release',
                    description: `Order #${orderId.slice(-6).toUpperCase()} - Payment Released`,
                    completedAt: Date.now(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    metadata: {
                        orderId,
                        commission,
                        paymentType: 'order_released',
                        reference: `order_${orderId}` // Keep reference consistent
                    }
                });

                // 4. Update Balances
                transaction.update(sellerRef, {
                    balance: admin.firestore.FieldValue.increment(sellerAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.update(buyerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                return { success: true, alreadyProcessed: false, amount: sellerAmount };
            });

            await this.invalidateWalletCache(sellerId);
            await this.invalidateWalletCache(buyerId);

            await Promise.allSettled([
                pushNotificationService.sendPushToUser(
                    buyerId,
                    "Order Completed! 🛍️",
                    `Your order #${orderId.slice(-6).toUpperCase()} has been finalized.`,
                    { screen: "OrdersTab" }
                ),
                pushNotificationService.sendPushToUser(
                    sellerId,
                    "💸 Payment Released",
                    `₦${sellerAmount.toLocaleString()} has been added to your balance.`,
                    { screen: "OrdersTab" }
                )
            ]);

            return result;

        } catch (error) {
            console.error(`❌ Release escrow error:`, error);
            if (!error.message?.includes('delivered')) await client.del(lockKey);
            throw error;
        }
    }

    /**
     * ✅ FIXED: Refund with proper transaction status updates and references
     */
    async refundEscrow(orderId, buyerId, sellerId, totalAmount, commission, reason) {
        const lockKey = `refund:lock:${orderId}`;

        try {
            const isProcessed = await client.get(lockKey);
            if (isProcessed) return { success: true, alreadyProcessed: true };

            await client.setEx(lockKey, 86400, 'true');

            const buyerRef = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);
            const orderRef = db.collection('orders').doc(orderId);

            await db.runTransaction(async (transaction) => {
                const orderDoc = await transaction.get(orderRef);
                if (!orderDoc.exists) throw new Error("Order not found");
                if (orderDoc.data().status === 'delivered') throw new Error("Cannot refund delivered orders");

                // 1️⃣ Update buyer's original transaction to refunded
                const buyerOriginalTxnRef = buyerRef.collection('transactions').doc(`pay_${orderId}`);
                const originalSnap = await transaction.get(buyerOriginalTxnRef);
                if (originalSnap.exists) {
                    transaction.update(buyerOriginalTxnRef, {
                        status: 'refunded',
                        description: `Order #${orderId.slice(-6).toUpperCase()} - Refunded`,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                // 2️⃣ Create refund credit transaction with reference
                const refundTxnId = `refund_${orderId}`;
                const refundTxnRef = buyerRef.collection('transactions').doc(refundTxnId);
                transaction.set(refundTxnRef, {
                    id: refundTxnId,
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
                        refundType: 'order_cancellation',
                        reference: refundTxnId // ✅ Added reference
                    }
                });

                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // 3️⃣ Update seller's pending transaction to cancelled
                const sellerTxnRef = sellerRef.collection('transactions').doc(`order_${orderId}`);
                transaction.update(sellerTxnRef, {
                    status: 'cancelled',
                    description: `Order #${orderId.slice(-6).toUpperCase()} - Cancelled`,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-(totalAmount - commission)),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.update(orderRef, {
                    status: 'cancelled',
                    cancelReason: reason,
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            await this.invalidateWalletCache(buyerId);
            await this.invalidateWalletCache(sellerId);

            await pushNotificationService.sendTransactionAlert(buyerId, 'refunded', totalAmount, orderId);

            console.log(`✅ Refund processed for order ${orderId}`);
            return { success: true, alreadyProcessed: false };

        } catch (error) {
            console.error(`❌ Refund escrow error for ${orderId}:`, error);
            if (!error.message?.includes('delivered')) await client.del(lockKey);
            throw error;
        }
    }
}

module.exports = new WalletService();