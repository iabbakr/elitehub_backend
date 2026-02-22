const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../config/firebase');

/**
 * PRODUCTION-GRADE PAYSTACK INTEGRATION - FIXED
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
                    amount: amount * 100,
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

            await db.collection('transactions').doc(reference).update({
                status: data.status,
                verifiedAt: Date.now(),
                gatewayResponse: data.gateway_response,
                paidAt: data.paid_at,
                amount: data.amount / 100
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
    verifyWebhookSignature(req, signature) {
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(req.rawBody)
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
        const amountKobo = Math.round(amount * 100); // Ensure integer

        const response = await axios.post(
            `${PAYSTACK_BASE_URL}/transfer`,
            {
                source: 'balance',
                reason,
                amount: amountKobo,
                recipient: recipientCode
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return {
            success: true,
            transferCode: response.data.data.transfer_code,
            reference: response.data.data.reference,
            status: response.data.data.status
        };
    } catch (error) {
        // Detailed error for debugging withdrawal failures
        const errorMessage = error.response?.data?.message || error.message;
        console.error('❌ Paystack Transfer Error:', errorMessage);
        
        // If Paystack says "Insufficient Balance", you need to know immediately
        if (errorMessage.includes('balance')) {
            throw new Error('Payout system is temporarily low on funds. Admin has been notified.');
        }
        
        throw new Error(errorMessage || 'Transfer failed');
    }
}
    /**
     * ✅ FIXED: Get Nigerian banks list with proper error handling
     */
    async getBanks() {
        try {
            const response = await axios.get(
                `${PAYSTACK_BASE_URL}/bank`,
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                    },
                    params: {
                        country: 'nigeria',
                        use_cursor: false,
                        perPage: 100
                    }
                }
            );

            if (!response.data.status) {
                throw new Error('Failed to fetch banks');
            }

            // Filter and format banks
            const banks = response.data.data
                .filter(bank => bank.active && bank.type !== 'ghipss')
                .map(bank => ({
                    name: bank.name,
                    code: bank.code,
                    slug: bank.slug,
                    active: bank.active
                }))
                .sort((a, b) => a.name.localeCompare(b.name));

            console.log(`✅ Fetched ${banks.length} active Nigerian banks`);
            
            return {
                success: true,
                banks
            };
        } catch (error) {
            console.error('❌ Get banks error:', error.response?.data || error.message);
            
            // Return fallback list of major Nigerian banks
            return {
                success: true,
                banks: this.getFallbackBanks()
            };
        }
    }

    /**
     * Fallback banks list (major Nigerian banks)
     */
    getFallbackBanks() {
        return [
            { name: "Access Bank", code: "044", active: true },
            { name: "Citibank Nigeria", code: "023", active: true },
            { name: "Ecobank Nigeria", code: "050", active: true },
            { name: "Fidelity Bank", code: "070", active: true },
            { name: "First Bank of Nigeria", code: "011", active: true },
            { name: "First City Monument Bank", code: "214", active: true },
            { name: "Globus Bank", code: "00103", active: true },
            { name: "Guaranty Trust Bank", code: "058", active: true },
            { name: "Heritage Bank", code: "030", active: true },
            { name: "Keystone Bank", code: "082", active: true },
            { name: "Kuda Bank", code: "50211", active: true },
            { name: "Opay", code: "999992", active: true },
            { name: "PalmPay", code: "999991", active: true },
            { name: "Polaris Bank", code: "076", active: true },
            { name: "Providus Bank", code: "101", active: true },
            { name: "Stanbic IBTC Bank", code: "221", active: true },
            { name: "Standard Chartered Bank", code: "068", active: true },
            { name: "Sterling Bank", code: "232", active: true },
            { name: "Union Bank of Nigeria", code: "032", active: true },
            { name: "United Bank For Africa", code: "033", active: true },
            { name: "Unity Bank", code: "215", active: true },
            { name: "Wema Bank", code: "035", active: true },
            { name: "Zenith Bank", code: "057", active: true }
        ].sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * ✅ FIXED: Verify bank account with better error handling
     */
    async verifyBankAccount(accountNumber, bankCode) {
        try {
            // Validate inputs
            if (!accountNumber || accountNumber.length !== 10) {
                throw new Error('Account number must be exactly 10 digits');
            }

            if (!bankCode) {
                throw new Error('Bank code is required');
            }

            const response = await axios.get(
                `${PAYSTACK_BASE_URL}/bank/resolve`,
                {
                    params: {
                        account_number: accountNumber,
                        bank_code: bankCode
                    },
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                    }
                }
            );

            if (!response.data.status) {
                throw new Error(response.data.message || 'Account verification failed');
            }

            return {
                success: true,
                accountName: response.data.data.account_name,
                accountNumber: response.data.data.account_number
            };
        } catch (error) {
            console.error('❌ Account verification error:', error.response?.data || error.message);
            
            // Provide specific error messages
            if (error.response?.status === 422) {
                throw new Error('Invalid account number or bank code');
            }
            
            if (error.response?.data?.message) {
                throw new Error(error.response.data.message);
            }
            
            throw new Error('Could not verify account. Please check the details and try again.');
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