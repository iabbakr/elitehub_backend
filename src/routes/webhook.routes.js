const express = require('express');
const router = express.Router();
const paystackService = require('../services/paystack.service');
const walletService = require('../services/wallet.service');
const { client } = require('../config/redis');
const { sendDepositAlert } = require('../services/email.service');

/**
 * PAYSTACK WEBHOOK HANDLER
 * Production-grade with signature verification and idempotency
 */

router.post('/paystack', async (req, res) => {
    try {
        // 1. Verify webhook signature
        const signature = req.headers['x-paystack-signature'];
        
        if (!paystackService.verifyWebhookSignature(req.body, signature)) {
            console.error('❌ Invalid webhook signature');
            return res.status(401).json({
                success: false,
                message: 'Invalid signature'
            });
        }

        const event = req.body;
        const eventId = event.id || event.data?.id;

        // 2. Check if event already processed (Redis idempotency)
        const lockKey = `webhook:lock:${eventId}`;
        const isProcessed = await client.get(lockKey);

        if (isProcessed) {
            console.log('⚠️ Webhook already processed:', eventId);
            return res.status(200).json({
                success: true,
                message: 'Event already processed'
            });
        }

        // 3. Set processing lock (24 hours)
        await client.setEx(lockKey, 86400, 'processing');

        // 4. Handle different event types
        switch (event.event) {
            case 'charge.success':
                await handleChargeSuccess(event);
                break;
            
            case 'transfer.success':
                await handleTransferSuccess(event);
                break;
            
            case 'transfer.failed':
                await handleTransferFailed(event);
                break;
            
            case 'transfer.reversed':
                await handleTransferReversed(event);
                break;
            
            default:
                console.log('Unhandled event type:', event.event);
        }

        // 5. Mark as completed
        await client.setEx(lockKey, 86400, 'completed');

        // Always respond quickly to Paystack
        res.status(200).json({ success: true });

    } catch (error) {
        console.error('Webhook processing error:', error);
        
        // Still return 200 to prevent Paystack retries
        res.status(200).json({
            success: false,
            message: 'Error logged, will retry manually if needed'
        });
    }
});

/**
 * Handle successful payment
 */
async function handleChargeSuccess(event) {
    try {
        const { amount, customer, reference, metadata } = event.data;
        const amountInNaira = amount / 100;
        
        console.log(`✅ Payment Success: ₦${amountInNaira} from ${customer.email}`);

        // Credit user wallet
        const userId = metadata?.userId || metadata?.user_id;
        
        if (!userId) {
            console.error('No userId in payment metadata');
            return;
        }

        await walletService.creditWallet(
            userId,
            amountInNaira,
            reference,
            {
                customerEmail: customer.email,
                customerName: customer.first_name + ' ' + customer.last_name,
                paymentMethod: 'paystack',
                originalAmount: amountInNaira
            }
        );

        // Send email notification
        try {
            await sendDepositAlert(
                customer.email,
                customer.first_name || 'Customer',
                amountInNaira
            );
        } catch (emailError) {
            console.error('Email notification failed:', emailError);
            // Don't fail the webhook if email fails
        }

        console.log(`💰 Wallet credited: ${userId} - ₦${amountInNaira}`);
    } catch (error) {
        console.error('Handle charge success error:', error);
        throw error;
    }
}

/**
 * Handle successful transfer (withdrawal)
 */
async function handleTransferSuccess(event) {
    try {
        const { amount, recipient, reference, reason } = event.data;
        const amountInNaira = amount / 100;
        
        console.log(`✅ Transfer Success: ₦${amountInNaira} to ${recipient.details.account_number}`);

        // Update transaction status in database
        const { db } = require('../config/firebase');
        const txnQuery = await db.collection('transactions')
            .where('reference', '==', reference)
            .limit(1)
            .get();

        if (!txnQuery.empty) {
            const txnDoc = txnQuery.docs[0];
            await txnDoc.ref.update({
                status: 'success',
                completedAt: Date.now(),
                gatewayResponse: 'Transfer successful'
            });
        }

    } catch (error) {
        console.error('Handle transfer success error:', error);
    }
}

/**
 * Handle failed transfer
 */
async function handleTransferFailed(event) {
    try {
        const { amount, recipient, reference } = event.data;
        const amountInNaira = amount / 100;
        
        console.log(`❌ Transfer Failed: ₦${amountInNaira} - ${reference}`);

        // Get transaction and refund user
        const { db } = require('../config/firebase');
        const txnQuery = await db.collection('transactions')
            .where('reference', '==', reference)
            .limit(1)
            .get();

        if (!txnQuery.empty) {
            const txnDoc = txnQuery.docs[0];
            const txnData = txnDoc.data();
            
            // Refund to wallet
            if (txnData.userId) {
                await walletService.creditWallet(
                    txnData.userId,
                    amountInNaira,
                    `refund_${reference}`,
                    {
                        type: 'withdrawal_refund',
                        originalReference: reference,
                        reason: 'Transfer failed'
                    }
                );
            }

            // Update transaction
            await txnDoc.ref.update({
                status: 'failed',
                failedAt: Date.now(),
                refunded: true
            });
        }

    } catch (error) {
        console.error('Handle transfer failed error:', error);
    }
}

/**
 * Handle reversed transfer
 */
async function handleTransferReversed(event) {
    try {
        const { amount, reference } = event.data;
        const amountInNaira = amount / 100;
        
        console.log(`🔄 Transfer Reversed: ₦${amountInNaira} - ${reference}`);

        // Similar to failed transfer - refund user
        await handleTransferFailed(event);

    } catch (error) {
        console.error('Handle transfer reversed error:', error);
    }
}

/**
 * Test webhook endpoint (for development)
 */
router.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'Webhook endpoint is active',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;