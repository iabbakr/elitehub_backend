// routes/stateManager.routes.js - STATE MANAGER COMMISSION BACKEND
const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { cacheMiddleware, userCacheMiddleware } = require('../middleware/cache');
const { getDocument, queryDocuments, updateDocument, runTransaction } = require('../config/firebase');
const { CACHE_TTL, invalidateUserCache } = require('../config/redis');
const { db } = require('../config/firebase');

const MANAGER_COMMISSION_RATE = 0.02; // 2% of platform commission

/**
 * GET /api/v1/state-manager/stats/:managerId
 * Get commission statistics for a state manager
 */
router.get(
    '/stats/:managerId',
    authenticate,
    userCacheMiddleware(CACHE_TTL.SHORT),
    async (req, res) => {
        try {
            const { managerId } = req.params;

            // Authorization check
            if (req.userId !== managerId && req.userProfile?.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized access'
                });
            }

            const manager = await getDocument('users', managerId);

            if (!manager || !['state_manager_1', 'state_manager_2'].includes(manager.role)) {
                return res.status(403).json({
                    success: false,
                    message: 'Only state managers can access this endpoint'
                });
            }

            const state = manager.assignedState;

            // Get all managers for this state
            const managers = await queryDocuments('users', [
                { field: 'assignedState', operator: '==', value: state },
                { field: 'role', operator: 'in', value: ['state_manager_1', 'state_manager_2'] },
                { field: 'isActive', operator: '==', value: true }
            ]);

            const isShared = managers.length > 1;
            const sharePercentage = isShared ? 50 : 100;

            // Find co-manager
            const coManager = managers.find(m => m.uid !== managerId);

            // Get commission transactions
            const commissions = await queryDocuments('stateCommissions', [
                { field: 'managerId', operator: '==', value: managerId },
                { field: 'state', operator: '==', value: state }
            ]);

            // Calculate stats
            const totalEarned = commissions
                .filter(c => c.status === 'paid')
                .reduce((sum, c) => sum + (c.managerCommission || 0), 0);

            const pendingCommission = commissions
                .filter(c => c.status === 'pending')
                .reduce((sum, c) => sum + (c.managerCommission || 0), 0);

            // Monthly earnings (last 30 days)
            const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
            const monthlyEarnings = commissions
                .filter(c => c.status === 'paid' && c.createdAt >= thirtyDaysAgo)
                .reduce((sum, c) => sum + (c.managerCommission || 0), 0);

            res.json({
                success: true,
                stats: {
                    totalEarned,
                    monthlyEarnings,
                    pendingCommission,
                    coManagerId: coManager?.uid,
                    coManagerName: coManager?.name,
                    isShared,
                    sharePercentage
                }
            });
        } catch (error) {
            console.error('Get commission stats error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch commission statistics'
            });
        }
    }
);

/**
 * GET /api/v1/state-manager/history/:managerId
 * Get commission history
 */
router.get(
    '/history/:managerId',
    authenticate,
    async (req, res) => {
        try {
            const { managerId } = req.params;
            const { limit = 50, status } = req.query;

            // Authorization check
            if (req.userId !== managerId && req.userProfile?.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized access'
                });
            }

            const filters = [
                { field: 'managerId', operator: '==', value: managerId }
            ];

            if (status) {
                filters.push({ field: 'status', operator: '==', value: status });
            }

            const commissions = await queryDocuments('stateCommissions', filters);

            // Sort by date (newest first)
            const sorted = commissions.sort((a, b) => b.createdAt - a.createdAt);

            // Limit results
            const limited = sorted.slice(0, parseInt(limit));

            res.json({
                success: true,
                commissions: limited,
                total: commissions.length
            });
        } catch (error) {
            console.error('Get commission history error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch commission history'
            });
        }
    }
);

/**
 * GET /api/v1/state-manager/orders/:state
 * Get all orders in a state
 */
router.get(
    '/orders/:state',
    authenticate,
    async (req, res) => {
        try {
            const { state } = req.params;
            const { status } = req.query;

            // Verify user is manager for this state
            const manager = await getDocument('users', req.userId);

            if (
                !manager ||
                !['state_manager_1', 'state_manager_2', 'admin'].includes(manager.role) ||
                (manager.assignedState !== state && manager.role !== 'admin')
            ) {
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized access'
                });
            }

            // Get sellers in state
            const sellers = await queryDocuments('users', [
                { field: 'role', operator: '==', value: 'seller' },
                { field: 'location.state', operator: '==', value: state }
            ]);

            const sellerIds = sellers.map(s => s.uid);

            if (sellerIds.length === 0) {
                return res.json({
                    success: true,
                    orders: [],
                    count: 0
                });
            }

            // Get orders for these sellers (in batches due to Firestore 'in' limit)
            const batchSize = 10;
            let allOrders = [];

            for (let i = 0; i < sellerIds.length; i += batchSize) {
                const batch = sellerIds.slice(i, i + batchSize);
                
                const filters = [
                    { field: 'sellerId', operator: 'in', value: batch }
                ];

                if (status && status !== 'all') {
                    filters.push({ field: 'status', operator: '==', value: status });
                }

                const orders = await queryDocuments('orders', filters);
                allOrders = allOrders.concat(orders);
            }

            // Sort by date
            allOrders.sort((a, b) => b.createdAt - a.createdAt);

            res.json({
                success: true,
                orders: allOrders,
                count: allOrders.length
            });
        } catch (error) {
            console.error('Get state orders error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch state orders'
            });
        }
    }
);

/**
 * POST /api/v1/state-manager/process-commission
 * Process commission for a delivered order
 * This is called automatically when an order is delivered
 */
router.post(
    '/process-commission',
    authenticate,
    async (req, res) => {
        try {
            const { orderId, orderAmount, platformCommission, sellerState } = req.body;

            // Validate inputs
            if (!orderId || !orderAmount || !platformCommission || !sellerState) {
                return res.status(400).json({
                    success: false,
                    message: 'Missing required fields'
                });
            }

            // Get active managers for this state
            const managers = await queryDocuments('users', [
                { field: 'assignedState', operator: '==', value: sellerState },
                { field: 'role', operator: 'in', value: ['state_manager_1', 'state_manager_2'] },
                { field: 'isActive', operator: '==', value: true }
            ]);

            if (managers.length === 0) {
                return res.json({
                    success: true,
                    message: 'No active managers for this state'
                });
            }

            // Calculate commission
            const baseCommission = platformCommission * MANAGER_COMMISSION_RATE;
            const isShared = managers.length > 1;
            const managerCommission = isShared ? baseCommission / 2 : baseCommission;
            const sharePercentage = isShared ? 50 : 100;

            // Create commission records
            const commissionPromises = managers.map(async (manager) => {
                const coManager = managers.find(m => m.uid !== manager.uid);

                const commissionData = {
                    managerId: manager.uid,
                    managerName: manager.name,
                    state: sellerState,
                    orderId,
                    orderAmount,
                    platformCommission,
                    managerCommission,
                    sharePercentage,
                    coManagerId: coManager?.uid || null,
                    coManagerName: coManager?.name || null,
                    status: 'pending',
                    createdAt: Date.now()
                };

                // Add to Firestore
                const docRef = db.collection('stateCommissions').doc();
                await docRef.set({
                    id: docRef.id,
                    ...commissionData
                });

                return docRef.id;
            });

            await Promise.all(commissionPromises);

            res.json({
                success: true,
                message: 'Commission processed successfully',
                commissionAmount: managerCommission,
                managersCount: managers.length
            });
        } catch (error) {
            console.error('Process commission error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to process commission'
            });
        }
    }
);

/**
 * POST /api/v1/state-manager/payout/:managerId
 * Payout pending commissions (Admin only)
 */
router.post(
    '/payout/:managerId',
    authenticate,
    adminOnly,
    async (req, res) => {
        try {
            const { managerId } = req.params;

            // Get pending commissions
            const pendingCommissions = await queryDocuments('stateCommissions', [
                { field: 'managerId', operator: '==', value: managerId },
                { field: 'status', operator: '==', value: 'pending' }
            ]);

            if (pendingCommissions.length === 0) {
                return res.json({
                    success: true,
                    message: 'No pending commissions',
                    amount: 0
                });
            }

            const totalAmount = pendingCommissions.reduce(
                (sum, c) => sum + (c.managerCommission || 0),
                0
            );

            // Process payout using transaction
            await runTransaction(async (transaction) => {
                // Update all commission records
                for (const commission of pendingCommissions) {
                    const ref = db.collection('stateCommissions').doc(commission.id);
                    transaction.update(ref, {
                        status: 'paid',
                        paidAt: Date.now()
                    });
                }

                // Add to manager's wallet
                const walletRef = db.collection('wallets').doc(managerId);
                const walletDoc = await transaction.get(walletRef);

                if (!walletDoc.exists) {
                    throw new Error('Manager wallet not found');
                }

                const currentBalance = walletDoc.data().balance || 0;

                // Create transaction record
                const txnRef = db.collection(`wallets/${managerId}/transactions`).doc();
                transaction.set(txnRef, {
                    id: txnRef.id,
                    type: 'credit',
                    amount: totalAmount,
                    description: `State Manager Commission Payout - ${pendingCommissions.length} orders`,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: {
                        type: 'state_commission',
                        commissionCount: pendingCommissions.length
                    }
                });

                // Update wallet balance
                transaction.update(walletRef, {
                    balance: currentBalance + totalAmount,
                    updatedAt: Date.now()
                });
            });

            // Invalidate cache
            await invalidateUserCache(managerId);

            res.json({
                success: true,
                message: 'Commission payout completed',
                amount: totalAmount,
                count: pendingCommissions.length
            });
        } catch (error) {
            console.error('Commission payout error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to process payout'
            });
        }
    }
);

/**
 * POST /api/v1/state-manager/auto-payout
 * Auto-payout commissions older than 7 days (Scheduled job)
 */
router.post(
    '/auto-payout',
    authenticate,
    adminOnly,
    async (req, res) => {
        try {
            const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

            // Get pending commissions older than 7 days
            const pendingCommissions = await queryDocuments('stateCommissions', [
                { field: 'status', operator: '==', value: 'pending' }
            ]);

            const oldCommissions = pendingCommissions.filter(c => c.createdAt <= sevenDaysAgo);

            // Group by manager
            const managerGroups = {};
            oldCommissions.forEach(c => {
                if (!managerGroups[c.managerId]) {
                    managerGroups[c.managerId] = [];
                }
                managerGroups[c.managerId].push(c);
            });

            const results = [];

            // Process each manager
            for (const managerId of Object.keys(managerGroups)) {
                try {
                    const commissions = managerGroups[managerId];
                    const totalAmount = commissions.reduce((sum, c) => sum + c.managerCommission, 0);

                    await runTransaction(async (transaction) => {
                        // Update commission records
                        for (const commission of commissions) {
                            const ref = db.collection('stateCommissions').doc(commission.id);
                            transaction.update(ref, {
                                status: 'paid',
                                paidAt: Date.now()
                            });
                        }

                        // Credit wallet
                        const walletRef = db.collection('wallets').doc(managerId);
                        const walletDoc = await transaction.get(walletRef);

                        if (!walletDoc.exists) {
                            throw new Error(`Wallet not found for manager ${managerId}`);
                        }

                        const currentBalance = walletDoc.data().balance || 0;

                        const txnRef = db.collection(`wallets/${managerId}/transactions`).doc();
                        transaction.set(txnRef, {
                            id: txnRef.id,
                            type: 'credit',
                            amount: totalAmount,
                            description: `Auto State Commission Payout - ${commissions.length} orders`,
                            timestamp: Date.now(),
                            status: 'completed',
                            metadata: {
                                type: 'state_commission',
                                commissionCount: commissions.length,
                                auto: true
                            }
                        });

                        transaction.update(walletRef, {
                            balance: currentBalance + totalAmount,
                            updatedAt: Date.now()
                        });
                    });

                    results.push({
                        managerId,
                        amount: totalAmount,
                        count: commissions.length,
                        success: true
                    });

                    await invalidateUserCache(managerId);
                } catch (error) {
                    console.error(`Failed to payout for manager ${managerId}:`, error);
                    results.push({
                        managerId,
                        success: false,
                        error: error.message
                    });
                }
            }

            res.json({
                success: true,
                message: 'Auto-payout completed',
                results,
                totalManagers: Object.keys(managerGroups).length,
                totalCommissions: oldCommissions.length
            });
        } catch (error) {
            console.error('Auto-payout error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to process auto-payout'
            });
        }
    }
);

module.exports = router;