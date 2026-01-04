// src/routes/webhook.routes.js - FIXED PRODUCTION VERSION
const express = require('express');
const router = express.Router();
const paystackService = require('../services/paystack.service');
const walletService = require('../services/wallet.service');
const { client } = require('../config/redis');
const { sendDepositAlert } = require('../services/email.service');

/**
 * CRITICAL FIX: Paystack webhook signature verification
 * The signature must be verified against the RAW body buffer
 */
router.post('/paystack', async (req, res) => {
    try {
        // 1. Get signature from header
        const signature = req.headers['x-paystack-signature'];
        
        if (!signature) {
            console.error('❌ No webhook signature provided');
            return res.status(401).json({
                success: false,
                message: 'No signature'
            });
        }

        // 2. Verify signature using RAW body (req.rawBody set in server.js)
        const isValid = paystackService.verifyWebhookSignature(req, signature);
        
        if (!isValid) {
            console.error('❌ Invalid webhook signature');
            return res.status(401).json({
                success: false,
                message: 'Invalid signature'
            });
        }

        const event = req.body;
        const eventId = event.id || event.data?.id || `evt_${Date.now()}`;

        // 3. Idempotency check
        const lockKey = `webhook:lock:${eventId}`;
        const isProcessed = await client.get(lockKey);

        if (isProcessed) {
            console.log('⚠️ Webhook already processed:', eventId);
            return res.status(200).json({
                success: true,
                message: 'Event already processed'
            });
        }

        // 4. Set processing lock (24 hours)
        await client.setEx(lockKey, 86400, 'processing');

        console.log(`📨 Webhook received: ${event.event}`, {
            eventId,
            reference: event.data?.reference
        });

        // 5. Handle different event types
        switch (event.event) {
            case 'charge.success':
                await handleChargeSuccess(event);
                break;
            
            case 'transfer.success':
                await handleTransferSuccess(event);
                break;
            
            case 'transfer.failed':
            case 'transfer.reversed':
                await handleTransferFailed(event);
                break;
            
            default:
                console.log('ℹ️ Unhandled event type:', event.event);
        }

        // 6. Mark as completed
        await client.setEx(lockKey, 86400, 'completed');

        // Always respond 200 to prevent Paystack retries
        res.status(200).json({ success: true });

    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        
        // Still return 200 to prevent Paystack retries
        res.status(200).json({
            success: false,
            message: 'Error logged, will retry manually if needed'
        });
    }
});

/**
 * FIXED: Handle successful payment
 */
async function handleChargeSuccess(event) {
    try {
        const { amount, customer, reference, metadata } = event.data;
        const amountInNaira = amount / 100;
        
        console.log(`✅ Payment Success: ₦${amountInNaira} from ${customer.email}`);

        // Extract userId from metadata
        const userId = metadata?.userId || metadata?.user_id;
        
        if (!userId) {
            console.error('❌ No userId in payment metadata');
            return;
        }

        // Credit wallet using improved service
        const result = await walletService.creditWallet(
            userId,
            amountInNaira,
            reference,
            {
                customerEmail: customer.email,
                customerName: `${customer.first_name} ${customer.last_name}`,
                paymentMethod: 'paystack',
                type: 'deposit'
            }
        );

        if (result.alreadyProcessed) {
            console.log('⚠️ Payment already credited:', reference);
            return;
        }

        // Send email notification (non-blocking)
        try {
            await sendDepositAlert(
                customer.email,
                customer.first_name || 'Customer',
                amountInNaira
            );
        } catch (emailError) {
            console.error('📧 Email notification failed:', emailError);
            // Don't fail the webhook if email fails
        }

        console.log(`💰 Wallet credited successfully: ${userId} - ₦${amountInNaira}`);
    } catch (error) {
        console.error('❌ Handle charge success error:', error);
        throw error;
    }
}

/**
 * Handle successful transfer (withdrawal)
 */
async function handleTransferSuccess(event) {
    try {
        const { amount, recipient, reference } = event.data;
        const amountInNaira = amount / 100;
        
        console.log(`✅ Transfer Success: ₦${amountInNaira} to ${recipient.details?.account_number}`);

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
            
            console.log('📝 Transaction updated to success:', reference);
        }
    } catch (error) {
        console.error('❌ Handle transfer success error:', error);
    }
}

/**
 * Handle failed/reversed transfer
 */
async function handleTransferFailed(event) {
    try {
        const { amount, reference } = event.data;
        const amountInNaira = amount / 100;
        
        console.log(`❌ Transfer Failed: ₦${amountInNaira} - ${reference}`);

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
                
                console.log(`💰 Refunded: ${txnData.userId} - ₦${amountInNaira}`);
            }

            // Update transaction
            await txnDoc.ref.update({
                status: 'failed',
                failedAt: Date.now(),
                refunded: true
            });
        }
    } catch (error) {
        console.error('❌ Handle transfer failed error:', error);
    }
}

/**
 * Test endpoint
 */
router.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'Webhook endpoint is active',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;