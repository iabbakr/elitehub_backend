const express = require('express');
const router = express.Router();
const { authenticate, userRateLimit } = require('../middleware/auth');
const walletService = require('../services/wallet.service');

/**
 * BILL PAYMENT ROUTES
 * Airtime, Data, Electricity, TV subscriptions via VTPass
 * Note: VTPass integration would be implemented similarly to Paystack
 */

/**
 * POST /api/v1/bills/airtime
 * Buy airtime
 */
router.post(
    '/airtime',
    authenticate,
    userRateLimit(20, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { network, amount, phone } = req.body;

            if (!network || !amount || !phone) {
                return res.status(400).json({
                    success: false,
                    message: 'Network, amount, and phone number are required'
                });
            }

            if (amount < 50) {
                return res.status(400).json({
                    success: false,
                    message: 'Minimum amount is ₦50'
                });
            }

            // Check wallet balance
            const wallet = await walletService.getWallet(req.userId);
            if (wallet.balance < amount) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient wallet balance'
                });
            }

            // Debit wallet
            const txnId = await walletService.debitWallet(
                req.userId,
                amount,
                `${network} Airtime - ${phone}`,
                {
                    type: 'bill_payment',
                    billType: 'airtime',
                    network,
                    phone
                }
            );

            // TODO: Integrate with VTPass API here
            // For now, we'll simulate a successful purchase

            res.json({
                success: true,
                message: 'Airtime purchase successful',
                transactionId: txnId,
                amount
            });
        } catch (error) {
            console.error('Airtime purchase error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Airtime purchase failed'
            });
        }
    }
);

/**
 * POST /api/v1/bills/data
 * Buy data
 */
router.post(
    '/data',
    authenticate,
    userRateLimit(20, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { network, plan, amount, phone } = req.body;

            if (!network || !plan || !amount || !phone) {
                return res.status(400).json({
                    success: false,
                    message: 'All fields are required'
                });
            }

            // Check wallet balance
            const wallet = await walletService.getWallet(req.userId);
            if (wallet.balance < amount) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient wallet balance'
                });
            }

            // Debit wallet
            const txnId = await walletService.debitWallet(
                req.userId,
                amount,
                `${network} Data - ${plan}`,
                {
                    type: 'bill_payment',
                    billType: 'data',
                    network,
                    plan,
                    phone
                }
            );

            // TODO: Integrate with VTPass API here

            res.json({
                success: true,
                message: 'Data purchase successful',
                transactionId: txnId,
                amount
            });
        } catch (error) {
            console.error('Data purchase error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Data purchase failed'
            });
        }
    }
);

/**
 * POST /api/v1/bills/electricity
 * Pay electricity bill
 */
router.post(
    '/electricity',
    authenticate,
    userRateLimit(10, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { provider, meterNumber, amount, meterType } = req.body;

            if (!provider || !meterNumber || !amount || !meterType) {
                return res.status(400).json({
                    success: false,
                    message: 'All fields are required'
                });
            }

            if (amount < 500) {
                return res.status(400).json({
                    success: false,
                    message: 'Minimum amount is ₦500'
                });
            }

            // Check wallet balance
            const wallet = await walletService.getWallet(req.userId);
            if (wallet.balance < amount) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient wallet balance'
                });
            }

            // Debit wallet
            const txnId = await walletService.debitWallet(
                req.userId,
                amount,
                `${provider} Electricity - ${meterNumber}`,
                {
                    type: 'bill_payment',
                    billType: 'electricity',
                    provider,
                    meterNumber,
                    meterType
                }
            );

            // TODO: Integrate with VTPass API here

            res.json({
                success: true,
                message: 'Electricity payment successful',
                transactionId: txnId,
                amount,
                token: 'XXXX-XXXX-XXXX-XXXX' // Would come from VTPass
            });
        } catch (error) {
            console.error('Electricity payment error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Electricity payment failed'
            });
        }
    }
);

/**
 * POST /api/v1/bills/tv
 * Pay TV subscription
 */
router.post(
    '/tv',
    authenticate,
    userRateLimit(10, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { provider, smartCardNumber, package, amount } = req.body;

            if (!provider || !smartCardNumber || !package || !amount) {
                return res.status(400).json({
                    success: false,
                    message: 'All fields are required'
                });
            }

            // Check wallet balance
            const wallet = await walletService.getWallet(req.userId);
            if (wallet.balance < amount) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient wallet balance'
                });
            }

            // Debit wallet
            const txnId = await walletService.debitWallet(
                req.userId,
                amount,
                `${provider} - ${package}`,
                {
                    type: 'bill_payment',
                    billType: 'tv_subscription',
                    provider,
                    smartCardNumber,
                    package
                }
            );

            // TODO: Integrate with VTPass API here

            res.json({
                success: true,
                message: 'TV subscription successful',
                transactionId: txnId,
                amount
            });
        } catch (error) {
            console.error('TV subscription error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'TV subscription failed'
            });
        }
    }
);

/**
 * GET /api/v1/bills/data-plans/:network
 * Get data plans for a network
 */
router.get('/data-plans/:network', authenticate, async (req, res) => {
    try {
        // TODO: Fetch from VTPass API
        // For now, return mock data
        const mockPlans = {
            mtn: [
                { id: '1gb', name: '1GB - 1 Day', amount: 300 },
                { id: '2gb', name: '2GB - 7 Days', amount: 500 },
                { id: '5gb', name: '5GB - 30 Days', amount: 1500 }
            ],
            glo: [
                { id: '1gb', name: '1GB - 5 Days', amount: 250 },
                { id: '3gb', name: '3GB - 30 Days', amount: 1000 }
            ]
        };

        const plans = mockPlans[req.params.network.toLowerCase()] || [];

        res.json({
            success: true,
            plans
        });
    } catch (error) {
        console.error('Get data plans error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch data plans'
        });
    }
});

module.exports = router;