const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = 'EliteHub Nigeria <noreply@elitehubng.com>';

/**
 * EMAIL SERVICE
 * Production-grade email notifications with templates
 */

/**
 * Base email template
 */
const getBaseTemplate = (content, brandColor = "#667eea") => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { border-top: 6px solid ${brandColor}; padding-top: 20px; margin-bottom: 30px; }
        .logo { font-size: 24px; font-weight: bold; color: ${brandColor}; }
        .content { background: #fff; padding: 30px; border-radius: 8px; }
        .button { display: inline-block; padding: 12px 30px; background: ${brandColor}; color: #fff; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #888; font-size: 12px; }
        .amount { font-size: 28px; font-weight: bold; color: ${brandColor}; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">EliteHub Nigeria</div>
        </div>
        <div class="content">
            ${content}
        </div>
        <div class="footer">
            <p>© ${new Date().getFullYear()} EliteHub Nigeria. All rights reserved.</p>
            <p>Lagos, Nigeria | support@elitehubng.com</p>
        </div>
    </div>
</body>
</html>
`;

class EmailService {
    /**
     * Send deposit alert
     */
    async sendDepositAlert(toEmail, name, amount) {
        try {
            const content = `
                <h2>🎉 Payment Successful!</h2>
                <p>Hi ${name},</p>
                <p>Your EliteHub wallet has been credited successfully.</p>
                <div class="amount">₦${amount.toLocaleString()}</div>
                <p>You can now use your balance for:</p>
                <ul>
                    <li>Airtime & Data top-ups</li>
                    <li>Bill payments</li>
                    <li>Product purchases</li>
                    <li>TV subscriptions</li>
                </ul>
                <a href="https://app.elitehubng.com/wallet" class="button">View Wallet</a>
            `;

            await resend.emails.send({
                from: FROM_EMAIL,
                to: toEmail,
                subject: `Wallet Credited: ₦${amount.toLocaleString()} ✅`,
                html: getBaseTemplate(content, '#28a745')
            });

            console.log(`📧 Deposit email sent to ${toEmail}`);
        } catch (error) {
            console.error('Deposit email error:', error);
            // Don't throw - email failures shouldn't break the flow
        }
    }

    /**
     * Send withdrawal confirmation
     */
    async sendWithdrawalConfirmation(toEmail, name, amount, bankDetails) {
        try {
            const content = `
                <h2>💸 Withdrawal Initiated</h2>
                <p>Hi ${name},</p>
                <p>Your withdrawal request has been processed.</p>
                <div class="amount">₦${amount.toLocaleString()}</div>
                <p><strong>Bank Details:</strong></p>
                <p>
                    ${bankDetails.accountName}<br>
                    ${bankDetails.bankName}<br>
                    ${bankDetails.accountNumber}
                </p>
                <p>Funds should arrive within 24 hours.</p>
            `;

            await resend.emails.send({
                from: FROM_EMAIL,
                to: toEmail,
                subject: `Withdrawal Processed: ₦${amount.toLocaleString()}`,
                html: getBaseTemplate(content, '#dc3545')
            });

            console.log(`📧 Withdrawal email sent to ${toEmail}`);
        } catch (error) {
            console.error('Withdrawal email error:', error);
        }
    }

    /**
     * Send order confirmation to buyer
     */
    async sendOrderConfirmation(toEmail, name, orderId, orderDetails) {
        try {
            const content = `
                <h2>🛍️ Order Confirmed</h2>
                <p>Hi ${name},</p>
                <p>Your order has been placed successfully!</p>
                <p><strong>Order ID:</strong> #${orderId.slice(-8).toUpperCase()}</p>
                <div class="amount">₦${orderDetails.totalAmount.toLocaleString()}</div>
                <p><strong>Delivery Address:</strong></p>
                <p>${orderDetails.deliveryAddress}</p>
                <p>The seller will prepare your order shortly.</p>
                <a href="https://app.elitehubng.com/orders/${orderId}" class="button">Track Order</a>
            `;

            await resend.emails.send({
                from: FROM_EMAIL,
                to: toEmail,
                subject: `Order Confirmed - #${orderId.slice(-8).toUpperCase()}`,
                html: getBaseTemplate(content)
            });

            console.log(`📧 Order confirmation sent to ${toEmail}`);
        } catch (error) {
            console.error('Order confirmation email error:', error);
        }
    }

    /**
     * Send new order alert to seller
     */
    async sendNewOrderAlert(toEmail, sellerName, orderId, orderDetails) {
        try {
            const content = `
                <h2>🔔 New Order Received!</h2>
                <p>Hi ${sellerName},</p>
                <p>You have a new order to fulfill.</p>
                <p><strong>Order ID:</strong> #${orderId.slice(-8).toUpperCase()}</p>
                <div class="amount">₦${orderDetails.sellerAmount.toLocaleString()}</div>
                <p><strong>Items:</strong></p>
                <ul>
                    ${orderDetails.products.map(p => `<li>${p.productName} × ${p.quantity}</li>`).join('')}
                </ul>
                <p>Please prepare the order for delivery.</p>
                <a href="https://app.elitehubng.com/orders/${orderId}" class="button">View Order</a>
            `;

            await resend.emails.send({
                from: FROM_EMAIL,
                to: toEmail,
                subject: `New Order - ₦${orderDetails.sellerAmount.toLocaleString()}`,
                html: getBaseTemplate(content, '#28a745')
            });

            console.log(`📧 New order alert sent to ${toEmail}`);
        } catch (error) {
            console.error('Order alert email error:', error);
        }
    }

    /**
     * Send delivery confirmation
     */
    async sendDeliveryConfirmation(toEmail, name, orderId, amount) {
        try {
            const content = `
                <h2>✅ Order Delivered</h2>
                <p>Hi ${name},</p>
                <p>Your order has been marked as delivered.</p>
                <p><strong>Order ID:</strong> #${orderId.slice(-8).toUpperCase()}</p>
                <div class="amount">₦${amount.toLocaleString()}</div>
                <p>Funds have been released to the seller.</p>
                <p>Thank you for shopping with EliteHub!</p>
            `;

            await resend.emails.send({
                from: FROM_EMAIL,
                to: toEmail,
                subject: `Order Delivered - #${orderId.slice(-8).toUpperCase()}`,
                html: getBaseTemplate(content, '#28a745')
            });

            console.log(`📧 Delivery confirmation sent to ${toEmail}`);
        } catch (error) {
            console.error('Delivery email error:', error);
        }
    }

    /**
     * Send welcome email to buyers
     */
    async sendBuyerWelcomeEmail(toEmail, name) {
        try {
            const content = `
                <h2>Welcome to EliteHub! 🎉</h2>
                <p>Hi ${name},</p>
                <p>Thank you for joining EliteHub Nigeria - your trusted marketplace for quality products and services.</p>
                <h3>Get Started:</h3>
                <ul>
                    <li>Browse thousands of products</li>
                    <li>Enjoy secure escrow payments</li>
                    <li>Pay bills & buy airtime</li>
                    <li>Track your orders in real-time</li>
                </ul>
                <a href="https://app.elitehubng.com/explore" class="button">Start Shopping</a>
            `;

            await resend.emails.send({
                from: FROM_EMAIL,
                to: toEmail,
                subject: 'Welcome to EliteHub Nigeria! 🎉',
                html: getBaseTemplate(content)
            });

            console.log(`📧 Welcome email sent to ${toEmail}`);
        } catch (error) {
            console.error('Welcome email error:', error);
        }
    }

    /**
     * Send welcome email to sellers
     */
    async sendSellerWelcomeEmail(toEmail, name) {
        try {
            const content = `
                <h2>Welcome to EliteHub Marketplace! 🎉</h2>
                <p>Hi ${name},</p>
                <p>Congratulations on joining EliteHub as a seller!</p>
                <h3>Next Steps:</h3>
                <ul>
                    <li>Complete your business profile</li>
                    <li>Add your first products</li>
                    <li>Set up your bank details for withdrawals</li>
                    <li>Start receiving orders</li>
                </ul>
                <p><strong>Seller Benefits:</strong></p>
                <ul>
                    <li>Secure escrow system</li>
                    <li>Low commission rates (10%)</li>
                    <li>Real-time order notifications</li>
                    <li>24/7 support</li>
                </ul>
                <a href="https://app.elitehubng.com/seller/dashboard" class="button">Go to Dashboard</a>
            `;

            await resend.emails.send({
                from: FROM_EMAIL,
                to: toEmail,
                subject: 'Welcome to EliteHub Marketplace! 🎉',
                html: getBaseTemplate(content, '#28a745')
            });

            console.log(`📧 Seller welcome email sent to ${toEmail}`);
        } catch (error) {
            console.error('Seller welcome email error:', error);
        }
    }

    /**
     * Send service provider welcome email
     */
    async sendServiceWelcomeEmail(toEmail, name) {
        try {
            const content = `
                <h2>Welcome to EliteHub Services! 🎉</h2>
                <p>Hi ${name},</p>
                <p>Welcome to EliteHub's service provider network!</p>
                <h3>Get Started:</h3>
                <ul>
                    <li>Complete your service profile</li>
                    <li>Add your portfolio & certifications</li>
                    <li>Set your operating hours</li>
                    <li>Start receiving inquiries</li>
                </ul>
                <p>Stand out from the competition with a complete profile!</p>
                <a href="https://app.elitehubng.com/service/profile" class="button">Complete Profile</a>
            `;

            await resend.emails.send({
                from: FROM_EMAIL,
                to: toEmail,
                subject: 'Welcome to EliteHub Services! 🎉',
                html: getBaseTemplate(content, '#667eea')
            });

            console.log(`📧 Service welcome email sent to ${toEmail}`);
        } catch (error) {
            console.error('Service welcome email error:', error);
        }
    }
}

module.exports = new EmailService();