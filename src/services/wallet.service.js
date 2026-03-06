'use strict';

// ─── wallet.service.js ────────────────────────────────────────────────────────
// ✅ FIXED: releaseEscrow now credits admin wallet with platform commission
// ✅ FIXED: Commission rate changed to 5% (was 10%)
// ✅ Commission split: 5% total → tracked in admin wallet as platform earnings
// ✅ Admin wallet doc: wallets/admin — created automatically if missing

const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');
const emailService = require('./email.service');
const paystackService = require('./paystack.service');
const pushNotificationService = require('./push-notification.service');

// ─── Platform commission rate ─────────────────────────────────────────────────
const PLATFORM_COMMISSION_RATE = 0.05; // ✅ CHANGED from 0.10 → 0.05

class WalletService {
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
                const newWallet = {
                    userId, balance: 0, pendingBalance: 0, isLocked: false, lockReason: null,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    version: 1
                };
                await walletRef.set(newWallet);
                return newWallet;
            }
            return walletDoc.data();
        } catch (error) {
            console.error('❌ Ensure wallet exists error:', error);
            throw new Error('Failed to ensure wallet exists');
        }
    }

    /**
     * Ensure the admin wallet document exists.
     * Called once during server startup is optional — this lazily creates it
     * on the first commission credit if it doesn't exist.
     */
    async ensureAdminWalletExists(transaction) {
        const adminRef = db.collection('wallets').doc('admin');
        const adminSnap = await transaction.get(adminRef);
        if (!adminSnap.exists) {
            transaction.set(adminRef, {
                userId: 'admin',
                balance: 0,
                pendingBalance: 0,
                isLocked: false,
                currency: 'NGN',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                version: 1
            });
        }
        return adminRef;
    }

    async creditWallet(userId, amount, reference, metadata = {}) {
        const lockKey = `payment:lock:${reference}`;
        try {
            const isProcessed = await client.get(lockKey);
            if (isProcessed) return { success: true, alreadyProcessed: true };

            await this.ensureWalletExists(userId);
            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);

            await db.runTransaction(async (transaction) => {
                const walletDoc = await transaction.get(walletRef);
                if (!walletDoc.exists) throw new Error('Wallet not found during transaction');
                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                transaction.set(txnRef, {
                    id: reference, type: 'credit', amount: parseFloat(amount),
                    description: metadata.description || `Wallet Top-up - ${reference}`,
                    timestamp: Date.now(), status: 'completed',
                    metadata: { ...metadata, reference, processedAt: new Date().toISOString() }
                });
            });

            await client.setEx(lockKey, 86400, 'true');
            await this.invalidateWalletCache(userId);
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
            if (cachedResult) return JSON.parse(cachedResult);

            const walletRef = db.collection('wallets').doc(userId);
            const txnRef = walletRef.collection('transactions').doc(reference);

            const result = await db.runTransaction(async (transaction) => {
                const walletDoc = await transaction.get(walletRef);
                if (!walletDoc.exists) throw new Error('Wallet not found');
                const wallet = walletDoc.data();
                if (wallet.balance < amount) throw new Error('Insufficient balance');
                const txnData = {
                    id: reference, type: 'debit', amount: parseFloat(amount),
                    description: description || `Debit - ${reference}`,
                    timestamp: Date.now(), status: metadata.status || 'completed',
                    metadata: { ...metadata, reference, processedAt: new Date().toISOString() }
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
            const txnsSnapshot = await walletRef.collection('transactions').orderBy('timestamp', 'desc').limit(50).get();
            const transactions = txnsSnapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
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
            if (!walletDoc.exists) { await this.ensureWalletExists(userId); return 0; }
            const balance = walletDoc.data().balance || 0;
            await client.setEx(balanceKey, 30, balance.toString());
            return balance;
        } catch (error) {
            console.error('❌ Get balance error:', error);
            return 0;
        }
    }

    async processOrderPayment(buyerId, sellerId, orderId, totalAmount, commission) {
        const lockKey = `order:payment:${orderId}`;
        try {
            await this._verifyWalletStatus(buyerId);
            const isProcessed = await client.get(lockKey);
            if (isProcessed) return { success: true, alreadyProcessed: true };

            await Promise.all([this.ensureWalletExists(buyerId), this.ensureWalletExists(sellerId)]);

            const buyerRef  = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);

            await db.runTransaction(async (transaction) => {
                const [buyerDoc] = await Promise.all([
                    transaction.get(buyerRef),
                    transaction.get(sellerRef)
                ]);
                const buyerWallet = buyerDoc.data();
                if (buyerWallet.balance < totalAmount) throw new Error('Insufficient balance');

                const buyerTxnRef = buyerRef.collection('transactions').doc(`pay_${orderId}`);
                transaction.set(buyerTxnRef, {
                    id: `pay_${orderId}`, userId: buyerId, type: 'debit', category: 'order_payment',
                    amount: totalAmount,
                    description: `Order #${orderId.slice(-6).toUpperCase()} - Escrow Hold`,
                    timestamp: Date.now(), status: 'pending',
                    metadata: { orderId, commission, paymentType: 'order_escrow', reference: `pay_${orderId}` }
                });
                transaction.update(buyerRef, {
                    balance: admin.firestore.FieldValue.increment(-totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                const sellerTxnId  = `order_${orderId}`;
                const sellerTxnRef = sellerRef.collection('transactions').doc(sellerTxnId);
                transaction.set(sellerTxnRef, {
                    id: sellerTxnId, userId: sellerId, type: 'credit', category: 'order_payment',
                    amount: totalAmount - commission,
                    description: `Order #${orderId.slice(-6).toUpperCase()} - Pending Delivery`,
                    timestamp: Date.now(), status: 'pending',
                    metadata: { orderId, commission, paymentType: 'order_pending', reference: sellerTxnId }
                });
                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(totalAmount - commission),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            await client.setEx(lockKey, 86400, 'true');
            await Promise.all([this.invalidateWalletCache(buyerId), this.invalidateWalletCache(sellerId)]);
            return { success: true, alreadyProcessed: false };
        } catch (error) {
            console.error(`❌ Process order payment error for ${orderId}:`, error);
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // ✅ CRITICAL FIX: releaseEscrow now credits admin wallet with commission.
    //
    // Previous behaviour: commission was deducted from seller payout but
    // never credited anywhere → admin wallet always showed ₦0, earnings
    // dashboard showed nothing.
    //
    // New behaviour:
    //   1. Seller receives  totalAmount − commission
    //   2. Admin wallet receives commission (5% of totalAmount)
    //   3. Both happen in the same Firestore transaction → atomic, no drift
    // ─────────────────────────────────────────────────────────────────────────────
    async releaseEscrow(orderId, buyerId, sellerId, totalAmount, commission) {
        const lockKey     = `release:lock:${orderId}`;
        const sellerAmount = totalAmount - commission;

        try {
            const isProcessed = await client.get(lockKey);
            if (isProcessed) return { success: true, alreadyProcessed: true };
            await client.setEx(lockKey, 86400, 'true');

            const sellerRef           = db.collection('wallets').doc(sellerId);
            const buyerRef            = db.collection('wallets').doc(buyerId);
            const adminRef            = db.collection('wallets').doc('admin');   // ✅ admin wallet
            const orderRef            = db.collection('orders').doc(orderId);
            const buyerOriginalTxnRef = buyerRef.collection('transactions').doc(`pay_${orderId}`);
            const sellerTxnRef        = sellerRef.collection('transactions').doc(`order_${orderId}`);
            const adminCommTxnRef     = adminRef.collection('transactions').doc(`commission_${orderId}`); // ✅

            const result = await db.runTransaction(async (transaction) => {
                // ── PHASE 1: READS ────────────────────────────────────────────
                const [
                    orderDoc, sellerDoc, buyerDoc, adminDoc,
                    buyerTxnSnap, sellerTxnSnap, adminCommSnap
                ] = await Promise.all([
                    transaction.get(orderRef),
                    transaction.get(sellerRef),
                    transaction.get(buyerRef),
                    transaction.get(adminRef),        // ✅
                    transaction.get(buyerOriginalTxnRef),
                    transaction.get(sellerTxnRef),
                    transaction.get(adminCommTxnRef)  // ✅ idempotency check
                ]);

                if (!orderDoc.exists) throw new Error("Order not found");
                const orderData = orderDoc.data();
                if (orderData.status === 'delivered') return { success: true, alreadyProcessed: true };
                if (orderData.status !== 'running')   throw new Error(`Invalid order status: ${orderData.status}`);
                if (!sellerDoc.exists || !buyerDoc.exists) throw new Error("Wallet not found");

                // ── PHASE 2: WRITES ───────────────────────────────────────────

                // 1. Mark order delivered
                transaction.update(orderRef, {
                    status: 'delivered', buyerConfirmed: true,
                    deliveredAt:  admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt:    admin.firestore.FieldValue.serverTimestamp()
                });

                // 2. Update buyer's escrow transaction → completed
                if (buyerTxnSnap.exists) {
                    transaction.update(buyerOriginalTxnRef, {
                        status: 'completed',
                        description: `Order #${orderId.slice(-6).toUpperCase()} - Completed`,
                        completedAt: Date.now(),
                        updatedAt:   admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                // 3. Update / create seller payout transaction
                if (sellerTxnSnap.exists) {
                    transaction.update(sellerTxnRef, {
                        status:      'completed',
                        category:    'order_release',
                        description: `Order #${orderId.slice(-6).toUpperCase()} - Payment Released`,
                        completedAt: Date.now(),
                        updatedAt:   admin.firestore.FieldValue.serverTimestamp()
                    });
                } else {
                    transaction.set(sellerTxnRef, {
                        id: `order_${orderId}`, userId: sellerId, type: 'credit',
                        category: 'order_release', amount: sellerAmount,
                        description: `Order #${orderId.slice(-6).toUpperCase()} - Payment Released`,
                        timestamp: Date.now(), status: 'completed', completedAt: Date.now(),
                        metadata: { orderId, commission, paymentType: 'order_released',
                            reference: `order_${orderId}`, fallbackCreated: true }
                    });
                }

                // 4. ✅ Credit admin wallet with commission (idempotent)
                if (!adminCommSnap.exists) {
                    transaction.set(adminCommTxnRef, {
                        id:          `commission_${orderId}`,
                        userId:      'admin',
                        type:        'credit',
                        category:    'commission',
                        amount:      commission,
                        description: `5% Commission: Order #${orderId.slice(-6).toUpperCase()}`,
                        timestamp:   Date.now(),
                        status:      'completed',
                        metadata: {
                            orderId,
                            totalOrderAmount: totalAmount,
                            commissionRate:   PLATFORM_COMMISSION_RATE,
                            sellerId,
                            buyerId
                        }
                    });

                    // Ensure admin wallet doc exists, then increment
                    if (!adminDoc.exists) {
                        transaction.set(adminRef, {
                            userId: 'admin', balance: commission,
                            pendingBalance: 0, isLocked: false, currency: 'NGN',
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                            version: 1
                        });
                    } else {
                        transaction.update(adminRef, {
                            balance:   admin.firestore.FieldValue.increment(commission),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    }
                }

                // 5. Release seller balance
                transaction.update(sellerRef, {
                    balance:        admin.firestore.FieldValue.increment(sellerAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    updatedAt:      admin.firestore.FieldValue.serverTimestamp()
                });

                // 6. Clear buyer pending
                transaction.update(buyerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt:      admin.firestore.FieldValue.serverTimestamp()
                });

                return { success: true, alreadyProcessed: false, amount: sellerAmount };
            });

            await this.invalidateWalletCache(sellerId);
            await this.invalidateWalletCache(buyerId);
            await this.invalidateWalletCache('admin'); // ✅ bust admin balance cache

            await Promise.allSettled([
                pushNotificationService.sendPushToUser(buyerId, "Order Completed! 🛍️",
                    `Your order #${orderId.slice(-6).toUpperCase()} has been finalised.`, { screen: "OrdersTab" }),
                pushNotificationService.sendPushToUser(sellerId, "💸 Payment Released",
                    `₦${sellerAmount.toLocaleString()} has been added to your balance.`, { screen: "OrdersTab" })
            ]);

            return result;
        } catch (error) {
            console.error(`❌ Release escrow error:`, error);
            if (!error.message?.includes('delivered')) await client.del(lockKey);
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // refundEscrow — unchanged logic but commission is NOT credited to admin
    // (no sale completed = no platform fee earned)
    // ─────────────────────────────────────────────────────────────────────────────
    async refundEscrow(orderId, buyerId, sellerId, totalAmount, commission, reason) {
        const lockKey      = `refund:lock:${orderId}`;
        const sellerAmount = totalAmount - commission;

        try {
            const isProcessed = await client.get(lockKey);
            if (isProcessed) return { success: true, alreadyProcessed: true };
            await client.setEx(lockKey, 86400, 'true');

            const buyerRef  = db.collection('wallets').doc(buyerId);
            const sellerRef = db.collection('wallets').doc(sellerId);
            const orderRef  = db.collection('orders').doc(orderId);

            await db.runTransaction(async (transaction) => {
                const buyerOriginalTxnRef = buyerRef.collection('transactions').doc(`pay_${orderId}`);
                const sellerTxnRef        = sellerRef.collection('transactions').doc(`order_${orderId}`);

                const [orderDoc, originalSnap, sellerTxnSnap] = await Promise.all([
                    transaction.get(orderRef),
                    transaction.get(buyerOriginalTxnRef),
                    transaction.get(sellerTxnRef)
                ]);

                if (!orderDoc.exists) throw new Error("Order not found");
                const orderStatus = orderDoc.data().status;
                if (orderStatus === 'delivered') throw new Error("Cannot refund delivered orders");
                if (orderStatus !== 'running' && orderStatus !== 'cancelled') {
                    throw new Error(`Invalid order status for refund: ${orderStatus}`);
                }

                transaction.update(orderRef, {
                    status: 'cancelled', cancelReason: reason,
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt:   admin.firestore.FieldValue.serverTimestamp()
                });

                if (originalSnap.exists) {
                    transaction.update(buyerOriginalTxnRef, {
                        status:      'refunded',
                        description: `Order #${orderId.slice(-6).toUpperCase()} - Refunded`,
                        updatedAt:   admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                const refundTxnId  = `refund_${orderId}`;
                const refundTxnRef = buyerRef.collection('transactions').doc(refundTxnId);
                transaction.set(refundTxnRef, {
                    id: refundTxnId, userId: buyerId, type: 'credit',
                    category: 'order_refund', amount: totalAmount,
                    description: `Refund: Order #${orderId.slice(-6).toUpperCase()}`,
                    timestamp: Date.now(), status: 'completed',
                    metadata: { orderId, reason, refundType: 'order_cancellation', reference: refundTxnId }
                });

                if (sellerTxnSnap.exists) {
                    transaction.update(sellerTxnRef, {
                        status:      'cancelled',
                        category:    'order_release',
                        description: `Order #${orderId.slice(-6).toUpperCase()} - Cancelled`,
                        updatedAt:   admin.firestore.FieldValue.serverTimestamp()
                    });
                } else {
                    transaction.set(sellerTxnRef, {
                        id: `order_${orderId}`, userId: sellerId, type: 'credit',
                        category: 'order_release', amount: sellerAmount,
                        description: `Order #${orderId.slice(-6).toUpperCase()} - Cancelled`,
                        timestamp: Date.now(), status: 'cancelled',
                        metadata: { orderId, reason, paymentType: 'order_cancelled',
                            reference: `order_${orderId}`, fallbackCreated: true }
                    });
                }

                transaction.update(buyerRef, {
                    balance:        admin.firestore.FieldValue.increment(totalAmount),
                    pendingBalance: admin.firestore.FieldValue.increment(-totalAmount),
                    updatedAt:      admin.firestore.FieldValue.serverTimestamp()
                });
                transaction.update(sellerRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
                    updatedAt:      admin.firestore.FieldValue.serverTimestamp()
                });
            });

            await this.invalidateWalletCache(buyerId);
            await this.invalidateWalletCache(sellerId);

            await Promise.allSettled([
                pushNotificationService.sendTransactionAlert(buyerId, 'refunded', totalAmount, orderId),
                pushNotificationService.sendPushToUser(sellerId, "Order Cancelled",
                    `Order #${orderId.slice(-6).toUpperCase()} was cancelled. Pending balance adjusted.`,
                    { screen: "OrdersTab" })
            ]);

            return { success: true, alreadyProcessed: false };
        } catch (error) {
            console.error(`❌ Refund escrow error for ${orderId}:`, error);
            if (!error.message?.includes('delivered')) await client.del(lockKey);
            throw error;
        }
    }

    // ─── Atomic helpers for dispute resolution (called inside existing transactions) ─

    async releaseEscrowAtomic(transaction, order) {
        const sellerRef    = db.collection('wallets').doc(order.sellerId);
        const buyerRef     = db.collection('wallets').doc(order.buyerId);
        const adminRef     = db.collection('wallets').doc('admin');           // ✅
        const sellerAmount = order.totalAmount - order.commission;

        // Seller
        transaction.update(sellerRef, {
            balance:        admin.firestore.FieldValue.increment(sellerAmount),
            pendingBalance: admin.firestore.FieldValue.increment(-sellerAmount),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp()
        });
        const sellerTxnRef = sellerRef.collection('transactions').doc(`order_${order.id}`);
        transaction.set(sellerTxnRef, {
            id: `order_${order.id}`, type: 'credit', category: 'dispute_resolution',
            amount: sellerAmount,
            description: `Dispute Won: Order #${order.id.slice(-6).toUpperCase()}`,
            status: 'completed', timestamp: Date.now(),
            metadata: { orderId: order.id, resolution: 'release' }
        }, { merge: true });

        // Buyer pending cleared
        transaction.update(buyerRef, {
            pendingBalance: admin.firestore.FieldValue.increment(-order.totalAmount),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp()
        });

        // ✅ Admin commission on dispute release
        const adminCommTxnRef = adminRef.collection('transactions').doc(`commission_${order.id}`);
        transaction.set(adminCommTxnRef, {
            id: `commission_${order.id}`, userId: 'admin', type: 'credit',
            category: 'commission', amount: order.commission,
            description: `5% Commission (Dispute Release): Order #${order.id.slice(-6).toUpperCase()}`,
            timestamp: Date.now(), status: 'completed',
            metadata: { orderId: order.id, resolution: 'release', commissionRate: PLATFORM_COMMISSION_RATE }
        }, { merge: true });
        transaction.update(adminRef, {
            balance:   admin.firestore.FieldValue.increment(order.commission),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }

    async refundEscrowAtomic(transaction, order, reason) {
        const buyerRef  = db.collection('wallets').doc(order.buyerId);
        const sellerRef = db.collection('wallets').doc(order.sellerId);
        const sellerPendingDeduction = order.totalAmount - order.commission;

        transaction.update(buyerRef, {
            balance:        admin.firestore.FieldValue.increment(order.totalAmount),
            pendingBalance: admin.firestore.FieldValue.increment(-order.totalAmount),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp()
        });
        transaction.update(sellerRef, {
            pendingBalance: admin.firestore.FieldValue.increment(-sellerPendingDeduction),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp()
        });
        const refundTxnId  = `refund_${order.id}`;
        const buyerTxnRef  = buyerRef.collection('transactions').doc(refundTxnId);
        transaction.set(buyerTxnRef, {
            id: refundTxnId, type: 'credit', category: 'dispute_refund',
            amount: order.totalAmount,
            description: `Dispute Refund: Order #${order.id.slice(-6).toUpperCase()}`,
            status: 'completed', timestamp: Date.now(),
            metadata: { orderId: order.id, reason }
        });
        // No admin commission on refund — buyer gets 100% back
    }

    async initializeWithdrawal(userId, userEmail, userName, payload) {
        const { amountKobo, accountNumber, bankCode, accountName } = payload;
        const amountNaira = amountKobo / 100;
        const reference   = `wd_${Date.now()}_${userId.slice(0, 5)}`;
        const lockKey     = `withdraw:lock:${reference}`;

        try {
            await this._verifyWalletStatus(userId);

            const result = await db.runTransaction(async (transaction) => {
                const walletRef = db.collection('wallets').doc(userId);
                const userRef   = db.collection('users').doc(userId);
                const txnRef    = db.collection('transactions').doc(`txn_${reference}`);

                const [walletSnap, userSnap] = await Promise.all([
                    transaction.get(walletRef),
                    transaction.get(userRef)
                ]);

                if (!walletSnap.exists) throw new Error('Wallet not found');
                const wallet = walletSnap.data();
                if (wallet.balance < amountNaira) throw new Error('Insufficient balance');

                const userData = userSnap.data();
                if (!userData.paystackRecipientCode) {
                    throw new Error('Bank recipient not found. Please link your bank account again.');
                }

                transaction.set(txnRef, {
                    id: reference, userId, type: 'debit', amount: amountNaira,
                    description: `Withdrawal to ${accountName} (${bankCode})`,
                    status: 'processing', timestamp: Date.now(),
                    metadata: { withdrawal: true, accountNumber, bankCode, accountName, reference }
                });
                transaction.update(walletRef, {
                    balance:   admin.firestore.FieldValue.increment(-amountNaira),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                return { recipientCode: userData.paystackRecipientCode };
            });

            const transfer = await paystackService.initiateTransfer(
                result.recipientCode, amountNaira, `EliteHub Payout: ${reference}`
            );

            await client.setEx(lockKey, 86400, 'true');
            await this.invalidateWalletCache(userId);

            try {
                await emailService.sendWithdrawalConfirmation(userEmail, userName, amountNaira, {
                    accountName, bankName: 'Verified Bank', accountNumber
                });
            } catch (err) {
                console.warn('📧 Notification failed but withdrawal succeeded:', err.message);
            }

            return { success: true, reference: transfer.reference, amount: amountNaira };
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
}

module.exports = new WalletService();