const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../config/firebase');

/**
 * PRODUCTION-GRADE PAYSTACK INTEGRATION
 * Implements secure payment processing with webhook verification
 */

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

if (!PAYSTACK_SECRET_KEY) {
    console.error('❌ PAYSTACK_SECRET_KEY is not configured');
}

class PaystackService {
    /**
     * Initialize payment transaction
     */
    async initializePayment(email, amount, metadata = {}) {
        try {
            const response = await axios.post(
                `${PAYSTACK_BASE_URL}/transaction/initialize`,
                {
                    email,
                    amount: amount * 100, // Convert to kobo
                    currency: 'NGN',
                    callback_url: metadata.callback_url || 'elitehubng://payment-callback',
                    metadata: {
                        ...metadata,
                        custom_fields: [
                            {
                                display_name: 'Customer Name',
                                variable_name: 'customer_name',
                                value: metadata.customerName || email
                            }
                        ]
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.data.status) {
                throw new Error(response.data.message || 'Payment initialization failed');
            }

            const { authorization_url, access_code, reference } = response.data.data;

            // Store pending transaction
            await db.collection('transactions').doc(reference).set({
                reference,
                email,
                amount,
                status: 'pending',
                userId: metadata.userId,
                createdAt: Date.now(),
                metadata
            });

            return {
                success: true,
                authorization_url,
                access_code,
                reference
            };
        } catch (error) {
            console.error('Paystack initialization error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.message || 'Payment initialization failed');
        }
    }

    /**
     * Verify payment transaction
     */
    async verifyPayment(reference) {
        try {
            const response = await axios.get(
                `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                    }
                }
            );

            if (!response.data.status) {
                throw new Error('Payment verification failed');
            }

            const { data } = response.data;

            // Update transaction in database
            await db.collection('transactions').doc(reference).update({
                status: data.status,
                verifiedAt: Date.now(),
                gatewayResponse: data.gateway_response,
                paidAt: data.paid_at,
                amount: data.amount / 100 // Convert from kobo
            });

            return {
                success: data.status === 'success',
                status: data.status,
                amount: data.amount / 100,
                reference: data.reference,
                customer: data.customer
            };
        } catch (error) {
            console.error('Paystack verification error:', error.response?.data || error.message);
            throw new Error('Payment verification failed');
        }
    }

    /**
     * Verify webhook signature
     */
    // src/services/paystack.service.js
verifyWebhookSignature(req, signature) {
    // Paystack sends the signature in the header: x-paystack-signature
    // We compare it against a hash of the raw request body
    const hash = crypto
        .createHmac('sha512', PAYSTACK_SECRET_KEY)
        .update(req.rawBody) // Use the raw buffer captured in server.js
        .digest('hex');

    return hash === signature;
}

    /**
     * Create transfer recipient (for withdrawals)
     */
    async createTransferRecipient(name, accountNumber, bankCode) {
        try {
            const response = await axios.post(
                `${PAYSTACK_BASE_URL}/transferrecipient`,
                {
                    type: 'nuban',
                    name,
                    account_number: accountNumber,
                    bank_code: bankCode,
                    currency: 'NGN'
                },
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.data.status) {
                throw new Error(response.data.message || 'Failed to create recipient');
            }

            return {
                success: true,
                recipientCode: response.data.data.recipient_code,
                details: response.data.data.details
            };
        } catch (error) {
            console.error('Create recipient error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.message || 'Failed to create transfer recipient');
        }
    }

    /**
     * Initiate transfer (withdrawal)
     */
    async initiateTransfer(recipientCode, amount, reason = 'Wallet withdrawal') {
        try {
            const response = await axios.post(
                `${PAYSTACK_BASE_URL}/transfer`,
                {
                    source: 'balance',
                    reason,
                    amount: amount * 100, // Convert to kobo
                    recipient: recipientCode
                },
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.data.status) {
                throw new Error(response.data.message || 'Transfer failed');
            }

            return {
                success: true,
                transferCode: response.data.data.transfer_code,
                reference: response.data.data.reference,
                status: response.data.data.status
            };
        } catch (error) {
            console.error('Transfer error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.message || 'Transfer failed');
        }
    }

    /**
     * Get Nigerian banks list
     */
    async getBanks() {
        try {
            const response = await axios.get(
                `${PAYSTACK_BASE_URL}/bank?country=nigeria`,
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                    }
                }
            );

            if (!response.data.status) {
                throw new Error('Failed to fetch banks');
            }

            return response.data.data.map(bank => ({
                name: bank.name,
                code: bank.code,
                slug: bank.slug,
                active: bank.active
            }));
        } catch (error) {
            console.error('Fetch banks error:', error.response?.data || error.message);
            throw new Error('Failed to fetch bank list');
        }
    }

    /**
     * Verify bank account
     */
    async verifyBankAccount(accountNumber, bankCode) {
        try {
            const response = await axios.get(
                `${PAYSTACK_BASE_URL}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                    }
                }
            );

            if (!response.data.status) {
                throw new Error('Account verification failed');
            }

            return {
                success: true,
                accountName: response.data.data.account_name,
                accountNumber: response.data.data.account_number
            };
        } catch (error) {
            console.error('Account verification error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.message || 'Account verification failed');
        }
    }

    /**
     * Check transfer status
     */
    async verifyTransfer(transferCode) {
        try {
            const response = await axios.get(
                `${PAYSTACK_BASE_URL}/transfer/${transferCode}`,
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                    }
                }
            );

            if (!response.data.status) {
                throw new Error('Transfer verification failed');
            }

            return {
                success: true,
                status: response.data.data.status,
                amount: response.data.data.amount / 100,
                recipient: response.data.data.recipient
            };
        } catch (error) {
            console.error('Transfer verification error:', error.response?.data || error.message);
            throw new Error('Transfer verification failed');
        }
    }
}

module.exports = new PaystackService();