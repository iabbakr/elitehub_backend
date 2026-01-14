const express = require('express');
const router = express.Router();
const { authenticate, authorizeOwnership, userRateLimit } = require('../middleware/auth');
const { cacheMiddleware, userCacheMiddleware } = require('../middleware/cache');
const walletService = require('../services/wallet.service');
const paystackService = require('../services/paystack.service');
const { CACHE_TTL } = require('../config/redis');

/**
 * WALLET ROUTES
 * Production-grade wallet management with caching
 */

/**
 * GET /api/v1/wallet/balance/:userId
 * Get wallet balance (cached for 5 minutes)
 */
router.get(
    '/balance/:userId',
    authenticate,
    authorizeOwnership('wallets'),
    userCacheMiddleware(CACHE_TTL.SHORT),
    async (req, res) => {
        try {
            const wallet = await walletService.getWallet(req.params.userId);

            res.json({
                success: true,
                balance: wallet.balance,
                pendingBalance: wallet.pendingBalance || 0,
                currency: 'NGN'
            });
        } catch (error) {
            console.error('Get balance error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch balance'
            });
        }
    }
);

/**
 * GET /api/v1/wallet/:userId
 * Get full wallet details with transactions
 */
router.get(
    '/:userId',
    authenticate,
    authorizeOwnership('wallets'),
    userCacheMiddleware(CACHE_TTL.SHORT),
    async (req, res) => {
        try {
            const wallet = await walletService.getWallet(req.params.userId);

            res.json({
                success: true,
                wallet: {
                    balance: wallet.balance,
                    pendingBalance: wallet.pendingBalance || 0,
                    transactions: wallet.transactions.slice(0, 50), // Last 50 transactions
                    currency: 'NGN'
                }
            });
        } catch (error) {
            console.error('Get wallet error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch wallet'
            });
        }
    }
);

/**
 * GET /api/v1/wallet/transactions/:userId
 * Get wallet transaction history with pagination
 */
router.get(
    '/transactions/:userId',
    authenticate,
    authorizeOwnership('wallets'),
    async (req, res) => {
        try {
            const { page = 1, limit = 20, type, status } = req.query;
            const wallet = await walletService.getWallet(req.params.userId);

            let transactions = wallet.transactions;

            // Filter by type
            if (type) {
                transactions = transactions.filter(t => t.type === type);
            }

            // Filter by status
            if (status) {
                transactions = transactions.filter(t => t.status === status);
            }

            // Pagination
            const startIndex = (parseInt(page) - 1) * parseInt(limit);
            const endIndex = startIndex + parseInt(limit);
            const paginatedTransactions = transactions.slice(startIndex, endIndex);

            res.json({
                success: true,
                transactions: paginatedTransactions,
                pagination: {
                    total: transactions.length,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(transactions.length / parseInt(limit))
                }
            });
        } catch (error) {
            console.error('Get transactions error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch transactions'
            });
        }
    }
);

/**
 * POST /api/v1/wallet/debit
 * Generic debit for subscriptions, fees, etc.
 */
router.post(
    '/debit',
    authenticate, // Use your existing auth middleware
    async (req, res) => {
        try {
            const { userId, amount, description, category, metadata } = req.body;

            // 1. Security check: Ensure user is only debiting their own wallet
            if (req.userId !== userId && req.userRole !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized wallet access'
                });
            }

            // 2. Basic validation
            if (!amount || amount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Valid amount is required'
                });
            }

            // 3. Call your existing WalletService.debitWallet logic
            const result = await walletService.debitWallet(
                userId,
                amount,
                description || `${category} payment`,
                {
                    ...metadata,
                    category: category || 'general_debit'
                }
            );

            res.json({
                success: true,
                message: 'Wallet debited successfully',
                transaction: result.transaction
            });

        } catch (error) {
            console.error('Wallet debit route error:', error);
            res.status(error.message === 'Insufficient balance' ? 400 : 500).json({
                success: false,
                message: error.message || 'Failed to process debit'
            });
        }
    }
);

/**
 * POST /api/v1/wallet/initialize-deposit
 * Initialize payment for wallet deposit
 */
router.post(
    '/initialize-deposit',
    authenticate,
    userRateLimit(10, 15 * 60 * 1000), // 10 deposits per 15 minutes
    async (req, res) => {
        try {
            const { amount } = req.body;
            const userId = req.userId;

            // Validate amount
            if (!amount || amount < 100) {
                return res.status(400).json({
                    success: false,
                    message: 'Minimum deposit amount is ₦100'
                });
            }

            if (amount > 1000000) {
                return res.status(400).json({
                    success: false,
                    message: 'Maximum deposit amount is ₦1,000,000'
                });
            }

            // Get user email
            const { getDocument } = require('../config/firebase');
            const user = await getDocument('users', userId);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            // Initialize payment with Paystack
            const payment = await paystackService.initializePayment(
                user.email,
                amount,
                {
                    userId,
                    customerName: user.name,
                    type: 'wallet_deposit'
                }
            );

            res.json({
                success: true,
                ...payment
            });
        } catch (error) {
            console.error('Initialize deposit error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to initialize deposit'
            });
        }
    }
);

/**
 * POST /api/v1/wallet/verify-deposit
 * Verify payment and credit wallet
 */
router.post(
    '/verify-deposit',
    authenticate,
    userRateLimit(20, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { reference } = req.body;

            if (!reference) {
                return res.status(400).json({
                    success: false,
                    message: 'Payment reference is required'
                });
            }

            // Verify payment with Paystack
            const verification = await paystackService.verifyPayment(reference);

            if (!verification.success) {
                return res.status(400).json({
                    success: false,
                    message: 'Payment verification failed',
                    status: verification.status
                });
            }

            // Credit wallet
            const result = await walletService.creditWallet(
                req.userId,
                verification.amount,
                reference,
                {
                    customerEmail: verification.customer.email,
                    paymentMethod: 'paystack'
                }
            );

            // Check if already processed
            if (result.alreadyProcessed) {
                return res.json({
                    success: true,
                    message: 'Payment already processed',
                    amount: verification.amount
                });
            }

            res.json({
                success: true,
                message: 'Wallet credited successfully',
                amount: verification.amount
            });
        } catch (error) {
            console.error('Verify deposit error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to verify deposit'
            });
        }
    }
);

/**
 * POST /api/v1/wallet/initialize-withdrawal
 * Initialize withdrawal to bank account
 */
router.post(
    '/initialize-withdrawal',
    authenticate,
    userRateLimit(5, 15 * 60 * 1000), // 5 withdrawals per 15 minutes
    async (req, res) => {
        try {
            const { amount } = req.body;
            const userId = req.userId;

            // Validate amount
            if (!amount || amount < 1000) {
                return res.status(400).json({
                    success: false,
                    message: 'Minimum withdrawal amount is ₦1,000'
                });
            }

            // Get user and check bank details
            const { getDocument } = require('../config/firebase');
            const user = await getDocument('users', userId);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            if (!user.paystackRecipientCode) {
                return res.status(400).json({
                    success: false,
                    message: 'Please add your bank details first',
                    requiresBankDetails: true
                });
            }

            // Check wallet balance
            const wallet = await walletService.getWallet(userId);

            if (wallet.balance < amount) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient balance',
                    availableBalance: wallet.balance
                });
            }

            // Debit wallet first
            await walletService.debitWallet(
                userId,
                amount,
                'Withdrawal to bank account',
                {
                    type: 'withdrawal',
                    status: 'processing'
                }
            );

            // Initiate transfer
            const transfer = await paystackService.initiateTransfer(
                user.paystackRecipientCode,
                amount,
                'Wallet withdrawal'
            );

            res.json({
                success: true,
                message: 'Withdrawal initiated successfully',
                reference: transfer.reference,
                amount
            });
        } catch (error) {
            console.error('Initialize withdrawal error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to initiate withdrawal'
            });
        }
    }
);

/**
 * POST /api/v1/wallet/add-bank-details
 * Add or update bank account details
 */
router.post(
    '/add-bank-details',
    authenticate,
    userRateLimit(3, 15 * 60 * 1000), // 3 updates per 15 minutes
    async (req, res) => {
        try {
            const { accountNumber, bankCode, accountName } = req.body;
            const userId = req.userId;

            // Validate inputs
            if (!accountNumber || !bankCode) {
                return res.status(400).json({
                    success: false,
                    message: 'Account number and bank code are required'
                });
            }

            // Verify account
            const verification = await paystackService.verifyBankAccount(
                accountNumber,
                bankCode
            );

            if (!verification.success) {
                return res.status(400).json({
                    success: false,
                    message: 'Account verification failed. Please check your details.'
                });
            }

            // Create transfer recipient
            const recipient = await paystackService.createTransferRecipient(
                verification.accountName,
                accountNumber,
                bankCode
            );

            // Update user profile
            const { updateDocument } = require('../config/firebase');
            await updateDocument('users', userId, {
                paystackRecipientCode: recipient.recipientCode,
                bankAccount: {
                    accountName: verification.accountName,
                    accountNumber,
                    bankCode,
                    verified: true
                }
            });

            res.json({
                success: true,
                message: 'Bank details added successfully',
                accountName: verification.accountName
            });
        } catch (error) {
            console.error('Add bank details error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to add bank details'
            });
        }
    }
);

/**
 * GET /api/v1/wallet/banks
 * Get list of Nigerian banks
 */
router.get(
    '/banks',
    cacheMiddleware(CACHE_TTL.WEEK), // Cache for 7 days
    async (req, res) => {
        try {
            const banks = await paystackService.getBanks();

            res.json({
                success: true,
                banks: banks.filter(bank => bank.active)
            });
        } catch (error) {
            console.error('Get banks error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch banks'
            });
        }
    }
);

/**
 * POST /api/v1/wallet/verify-account
 * Verify bank account number
 */
router.post(
    '/verify-account',
    authenticate,
    userRateLimit(10, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { accountNumber, bankCode } = req.body;

            if (!accountNumber || !bankCode) {
                return res.status(400).json({
                    success: false,
                    message: 'Account number and bank code are required'
                });
            }

            const verification = await paystackService.verifyBankAccount(
                accountNumber,
                bankCode
            );

            res.json(verification);
        } catch (error) {
            console.error('Verify account error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Account verification failed'
            });
        }
    }
);

/**
 * GET /api/v1/wallet/stats/:userId
 * Get wallet statistics
 */
router.get(
    '/stats/:userId',
    authenticate,
    authorizeOwnership('wallets'),
    userCacheMiddleware(CACHE_TTL.SHORT),
    async (req, res) => {
        try {
            const wallet = await walletService.getWallet(req.params.userId);

            const stats = {
                currentBalance: wallet.balance,
                pendingBalance: wallet.pendingBalance || 0,
                totalDeposits: 0,
                totalWithdrawals: 0,
                totalSpent: 0,
                transactionCount: wallet.transactions.length,
                lastTransaction: wallet.transactions[0] || null
            };

            // Calculate stats
            wallet.transactions.forEach(txn => {
                if (txn.type === 'credit') {
                    if (txn.metadata?.type === 'deposit' || txn.description.includes('Top-up')) {
                        stats.totalDeposits += txn.amount;
                    }
                } else if (txn.type === 'debit') {
                    if (txn.metadata?.type === 'withdrawal') {
                        stats.totalWithdrawals += txn.amount;
                    } else {
                        stats.totalSpent += txn.amount;
                    }
                }
            });

            res.json({
                success: true,
                stats
            });
        } catch (error) {
            console.error('Get stats error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch statistics'
            });
        }
    }
);

module.exports = router;