// src/routes/bill.routes.js - COMPLETE PRODUCTION VERSION
const express = require('express');
const router = express.Router();
const { authenticate, userRateLimit } = require('../middleware/auth');
const walletService = require('../services/wallet.service');
const vtpassService = require('../services/vtpass.service');

/**
 * BILL PAYMENT ROUTES
 * Handles: Airtime, Data, Electricity, TV via VTPass
 * With automatic refunds on provider failures
 */

/**
 * POST /api/v1/bills/airtime
 * Buy airtime with auto-refund protection
 */
router.post(
    '/airtime',
    authenticate,
    userRateLimit(20, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { network, amount, phone } = req.body;
            const userId = req.userId;

            // Validation
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

            if (phone.length !== 11) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid phone number'
                });
            }

            // Check wallet balance
            const wallet = await walletService.getWallet(userId);
            if (wallet.balance < amount) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient wallet balance'
                });
            }

            // Debit wallet first
            const debitResult = await walletService.debitWallet(
                userId,
                amount,
                `${network} Airtime - ${phone}`,
                {
                    type: 'bill_payment',
                    billType: 'airtime',
                    network,
                    phone,
                    status: 'processing'
                }
            );

            const transactionId = debitResult.transaction.id;

            try {
                // Process with VTPass
                const vtpassResult = await vtpassService.purchaseAirtime({
                    serviceID: network.toLowerCase(),
                    amount,
                    phone
                });

                // Update transaction status
                const walletRef = require('../config/firebase').db
                    .collection('wallets')
                    .doc(userId);

                await walletRef
                    .collection('transactions')
                    .doc(transactionId)
                    .update({
                        status: 'completed',
                        metadata: {
                            ...debitResult.transaction.metadata,
                            vtpassResponse: vtpassResult,
                            completedAt: Date.now()
                        }
                    });

                console.log(`✅ Airtime purchase successful: ${userId} - ₦${amount}`);

                res.json({
                    success: true,
                    message: 'Airtime purchase successful',
                    transactionId,
                    amount,
                    phone
                });

            } catch (providerError) {
                console.error('VTPass error, refunding:', providerError);

                // AUTOMATIC REFUND on provider failure
                await walletService.creditWallet(
                    userId,
                    amount,
                    `refund_${transactionId}`,
                    {
                        type: 'bill_refund',
                        originalTransaction: transactionId,
                        reason: 'Provider error',
                        originalBillType: 'airtime'
                    }
                );

                // Update original transaction as failed
                await require('../config/firebase').db
                    .collection('wallets')
                    .doc(userId)
                    .collection('transactions')
                    .doc(transactionId)
                    .update({
                        status: 'failed',
                        refunded: true,
                        failedAt: Date.now(),
                        error: providerError.message
                    });

                throw new Error('Provider error. Amount refunded to wallet.');
            }

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
 * Buy data bundle with auto-refund protection
 */
router.post(
    '/data',
    authenticate,
    userRateLimit(20, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { network, plan, variation_code, amount, phone } = req.body;
            const userId = req.userId;

            if (!network || !variation_code || !amount || !phone) {
                return res.status(400).json({
                    success: false,
                    message: 'All fields are required'
                });
            }

            // Check wallet balance
            const wallet = await walletService.getWallet(userId);
            if (wallet.balance < amount) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient wallet balance'
                });
            }

            // Debit wallet
            const debitResult = await walletService.debitWallet(
                userId,
                amount,
                `${network} Data - ${plan}`,
                {
                    type: 'bill_payment',
                    billType: 'data',
                    network,
                    plan,
                    phone,
                    status: 'processing'
                }
            );

            const transactionId = debitResult.transaction.id;

            try {
                // Process with VTPass
                const serviceID = `${network.toLowerCase()}-data`;
                const vtpassResult = await vtpassService.purchaseData({
                    serviceID,
                    billersCode: phone,
                    variation_code,
                    amount,
                    phone
                });

                // Update transaction
                await require('../config/firebase').db
                    .collection('wallets')
                    .doc(userId)
                    .collection('transactions')
                    .doc(transactionId)
                    .update({
                        status: 'completed',
                        metadata: {
                            ...debitResult.transaction.metadata,
                            vtpassResponse: vtpassResult,
                            completedAt: Date.now()
                        }
                    });

                console.log(`✅ Data purchase successful: ${userId} - ₦${amount}`);

                res.json({
                    success: true,
                    message: 'Data purchase successful',
                    transactionId,
                    amount,
                    phone
                });

            } catch (providerError) {
                console.error('VTPass error, refunding:', providerError);

                // AUTO-REFUND
                await walletService.creditWallet(
                    userId,
                    amount,
                    `refund_${transactionId}`,
                    {
                        type: 'bill_refund',
                        originalTransaction: transactionId,
                        reason: 'Provider error',
                        originalBillType: 'data'
                    }
                );

                await require('../config/firebase').db
                    .collection('wallets')
                    .doc(userId)
                    .collection('transactions')
                    .doc(transactionId)
                    .update({
                        status: 'failed',
                        refunded: true,
                        failedAt: Date.now(),
                        error: providerError.message
                    });

                throw new Error('Provider error. Amount refunded to wallet.');
            }

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
 * Pay electricity bill with auto-refund protection
 */
router.post(
    '/electricity',
    authenticate,
    userRateLimit(10, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { provider, meterNumber, amount, meterType } = req.body;
            const userId = req.userId;

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
            const wallet = await walletService.getWallet(userId);
            if (wallet.balance < amount) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient wallet balance'
                });
            }

            // Debit wallet
            const debitResult = await walletService.debitWallet(
                userId,
                amount,
                `${provider} Electricity - ${meterNumber}`,
                {
                    type: 'bill_payment',
                    billType: 'electricity',
                    provider,
                    meterNumber,
                    meterType,
                    status: 'processing'
                }
            );

            const transactionId = debitResult.transaction.id;

            try {
                // Process with VTPass
                const vtpassResult = await vtpassService.purchaseElectricity({
                    serviceID: provider,
                    billersCode: meterNumber,
                    variation_code: meterType,
                    amount,
                    phone: '08000000000' // Placeholder - VTPass requires this field
                });

                // Update transaction with token
                await require('../config/firebase').db
                    .collection('wallets')
                    .doc(userId)
                    .collection('transactions')
                    .doc(transactionId)
                    .update({
                        status: 'completed',
                        metadata: {
                            ...debitResult.transaction.metadata,
                            token: vtpassResult.purchased_code || vtpassResult.token,
                            units: vtpassResult.units,
                            vtpassResponse: vtpassResult,
                            completedAt: Date.now()
                        }
                    });

                console.log(`✅ Electricity purchase successful: ${userId} - ₦${amount}`);

                res.json({
                    success: true,
                    message: 'Electricity payment successful',
                    transactionId,
                    amount,
                    token: vtpassResult.purchased_code || vtpassResult.token || 'Check provider',
                    units: vtpassResult.units
                });

            } catch (providerError) {
                console.error('VTPass error, refunding:', providerError);

                // AUTO-REFUND
                await walletService.creditWallet(
                    userId,
                    amount,
                    `refund_${transactionId}`,
                    {
                        type: 'bill_refund',
                        originalTransaction: transactionId,
                        reason: 'Provider error',
                        originalBillType: 'electricity'
                    }
                );

                await require('../config/firebase').db
                    .collection('wallets')
                    .doc(userId)
                    .collection('transactions')
                    .doc(transactionId)
                    .update({
                        status: 'failed',
                        refunded: true,
                        failedAt: Date.now(),
                        error: providerError.message
                    });

                throw new Error('Provider error. Amount refunded to wallet.');
            }

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
 * Pay TV subscription with auto-refund protection
 */
router.post(
    '/tv',
    authenticate,
    userRateLimit(10, 15 * 60 * 1000),
    async (req, res) => {
        try {
            const { provider, smartCardNumber, package: packageCode, amount } = req.body;
            const userId = req.userId;

            if (!provider || !smartCardNumber || !packageCode || !amount) {
                return res.status(400).json({
                    success: false,
                    message: 'All fields are required'
                });
            }

            // Check wallet balance
            const wallet = await walletService.getWallet(userId);
            if (wallet.balance < amount) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient wallet balance'
                });
            }

            // Debit wallet
            const debitResult = await walletService.debitWallet(
                userId,
                amount,
                `${provider} TV Subscription`,
                {
                    type: 'bill_payment',
                    billType: 'tv_subscription',
                    provider,
                    smartCardNumber,
                    package: packageCode,
                    status: 'processing'
                }
            );

            const transactionId = debitResult.transaction.id;

            try {
                // Process with VTPass
                const vtpassResult = await vtpassService.purchaseTVSubscription({
                    serviceID: provider,
                    billersCode: smartCardNumber,
                    variation_code: packageCode,
                    amount,
                    phone: '08000000000' // Placeholder
                });

                // Update transaction
                await require('../config/firebase').db
                    .collection('wallets')
                    .doc(userId)
                    .collection('transactions')
                    .doc(transactionId)
                    .update({
                        status: 'completed',
                        metadata: {
                            ...debitResult.transaction.metadata,
                            vtpassResponse: vtpassResult,
                            completedAt: Date.now()
                        }
                    });

                console.log(`✅ TV subscription successful: ${userId} - ₦${amount}`);

                res.json({
                    success: true,
                    message: 'TV subscription successful',
                    transactionId,
                    amount
                });

            } catch (providerError) {
                console.error('VTPass error, refunding:', providerError);

                // AUTO-REFUND
                await walletService.creditWallet(
                    userId,
                    amount,
                    `refund_${transactionId}`,
                    {
                        type: 'bill_refund',
                        originalTransaction: transactionId,
                        reason: 'Provider error',
                        originalBillType: 'tv_subscription'
                    }
                );

                await require('../config/firebase').db
                    .collection('wallets')
                    .doc(userId)
                    .collection('transactions')
                    .doc(transactionId)
                    .update({
                        status: 'failed',
                        refunded: true,
                        failedAt: Date.now(),
                        error: providerError.message
                    });

                throw new Error('Provider error. Amount refunded to wallet.');
            }

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
 * Get data plans for a network (cached)
 */
router.get('/data-plans/:network', authenticate, async (req, res) => {
    try {
        const network = req.params.network.toLowerCase();
        const serviceID = `${network}-data`;

        const plans = await vtpassService.getDataPlans(serviceID);

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

/**
 * GET /api/v1/bills/tv-bouquets/:provider
 * Get TV bouquets for a provider (cached)
 */
router.get('/tv-bouquets/:provider', authenticate, async (req, res) => {
    try {
        const provider = req.params.provider.toLowerCase();

        const bouquets = await vtpassService.getTVBouquets(provider);

        res.json({
            success: true,
            bouquets
        });
    } catch (error) {
        console.error('Get TV bouquets error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch TV bouquets'
        });
    }
});

/**
 * POST /api/v1/bills/verify-meter
 * Verify electricity meter number
 */
router.post('/verify-meter', authenticate, async (req, res) => {
    try {
        const { provider, meterNumber } = req.body;

        if (!provider || !meterNumber) {
            return res.status(400).json({
                success: false,
                message: 'Provider and meter number are required'
            });
        }

        const result = await vtpassService.verifyMeterNumber({
            serviceID: provider,
            billersCode: meterNumber
        });

        res.json({
            success: true,
            customerName: result.Customer_Name,
            address: result.Address
        });
    } catch (error) {
        console.error('Verify meter error:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Meter verification failed'
        });
    }
});

/**
 * POST /api/v1/bills/verify-smartcard
 * Verify TV smartcard number
 */
router.post('/verify-smartcard', authenticate, async (req, res) => {
    try {
        const { provider, smartCardNumber } = req.body;

        if (!provider || !smartCardNumber) {
            return res.status(400).json({
                success: false,
                message: 'Provider and smartcard number are required'
            });
        }

        const result = await vtpassService.verifySmartCard(
            provider,
            smartCardNumber
        );

        res.json({
            success: true,
            customerName: result.Customer_Name || result.customer_name
        });
    } catch (error) {
        console.error('Verify smartcard error:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Smartcard verification failed'
        });
    }
});

module.exports = router;