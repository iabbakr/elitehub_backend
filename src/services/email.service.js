const { Resend } = require('resend');

/**
 * Initialize Resend with your API Key
 * API Key should be stored in your .env file
 */
const resend = new Resend(process.env.RESEND_API_KEY);


if (!process.env.RESEND_API_KEY) {
  console.error('❌ RESEND_API_KEY is missing in .env file');
  process.exit(1);
}

console.log('✅ Resend initialized with API key:', 
  process.env.RESEND_API_KEY.substring(0, 10) + '...'
);
/**
 * The sender address. 
 * Note: Until your domain is verified in the Resend dashboard,
 * you can only send emails to your own registration address.
 */
const FROM_EMAIL = 'EliteHub Nigeria <noreply@elitehubng.com>';

/**
 * Base HTML Template for Consistent Branding
 */
const getBaseTemplate = (content, brandColor = '#667eea') => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border-top: 6px solid ${brandColor}; }
    .header { padding: 30px 30px 10px; text-align: center; }
    .logo { font-size: 28px; font-weight: bold; color: ${brandColor}; }
    .content { padding: 0 30px 30px; line-height: 1.6; color: #333; }
    .button { display: inline-block; padding: 14px 32px; background: ${brandColor}; color: #ffffff !important; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0; }
    .amount { font-size: 32px; font-weight: bold; color: ${brandColor}; margin: 20px 0; text-align: center; }
    .footer { background: #f9f9f9; padding: 20px; text-align: center; color: #888; font-size: 12px; }
    ul { padding-left: 20px; }
    li { margin-bottom: 8px; }
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
   * Core Email Sender
   */
  async sendEmail(to, subject, html) {
    try {
      const { data, error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: [to],
        subject,
        html,
      });

      if (error) {
        throw new Error(error.message);
      }

      console.log(`📧 Email sent to ${to}: ${subject}`);
      return data;
    } catch (error) {
      console.error(`❌ Email failed to ${to}:`, error.message || error);
      // We catch errors here so that a failed email doesn't roll back 
      // a successful database transaction (like a confirmed payment).
      return null;
    }
  }

  // ─────────────────────────────────────────────────────
  // WALLET ALERTS
  // ─────────────────────────────────────────────────────

  async sendDepositAlert(toEmail, name, amount) {
    const content = `
      <h2 style="color: #28a745; text-align: center;">Deposit Confirmed ✅</h2>
      <p>Hi ${name},</p>
      <p>Your EliteHub wallet has been successfully credited and the funds are ready for use.</p>
      <div class="amount">₦${amount.toLocaleString()}</div>
      <p>You can now use this balance for airtime, data, bills, and shopping across our marketplace.</p>
      <div style="text-align: center;">
        <a href="https://app.elitehubng.com/wallet" class="button">View Wallet Balance</a>
      </div>
    `;
    await this.sendEmail(toEmail, `Wallet Credited: ₦${amount.toLocaleString()} ✅`, getBaseTemplate(content, '#28a745'));
  }

  async sendWithdrawalConfirmation(toEmail, name, amount, bankDetails) {
    const content = `
      <h2 style="color: #dc3545; text-align: center;">Withdrawal Processed 💸</h2>
      <p>Hi ${name},</p>
      <p>Your withdrawal request has been successfully initiated.</p>
      <div class="amount">₦${amount.toLocaleString()}</div>
      <p><strong>Transfer Destination:</strong><br>
      ${bankDetails.accountName}<br>
      ${bankDetails.bankName} (${bankDetails.accountNumber})</p>
      <p>Funds typically reflect in your bank account within 24 hours.</p>
    `;
    await this.sendEmail(toEmail, `Withdrawal: ₦${amount.toLocaleString()} Processed`, getBaseTemplate(content, '#dc3545'));
  }

  // ─────────────────────────────────────────────────────
  // ORDER NOTIFICATIONS
  // ─────────────────────────────────────────────────────

  async sendOrderConfirmation(toEmail, name, orderId, orderDetails) {
    const content = `
      <h2 style="text-align: center;">Order Confirmed 🛍️</h2>
      <p>Hi ${name},</p>
      <p>Thank you! Your order has been placed successfully and the seller has been notified.</p>
      <p><strong>Order ID:</strong> #${orderId.slice(-8).toUpperCase()}</p>
      <div class="amount">₦${orderDetails.totalAmount.toLocaleString()}</div>
      <p><strong>Delivery Address:</strong><br>${orderDetails.deliveryAddress}</p>
      <div style="text-align: center;">
        <a href="https://app.elitehubng.com/orders/${orderId}" class="button">Track Your Order</a>
      </div>
    `;
    await this.sendEmail(toEmail, `Order Confirmed #${orderId.slice(-8).toUpperCase()}`, getBaseTemplate(content));
  }

  async sendNewOrderAlert(toEmail, sellerName, orderId, orderDetails) {
    const content = `
      <h2 style="color: #28a745; text-align: center;">New Order Received! 🔔</h2>
      <p>Hi ${sellerName},</p>
      <p>You have a new order waiting to be fulfilled.</p>
      <p><strong>Order ID:</strong> #${orderId.slice(-8).toUpperCase()}</p>
      <div class="amount">₦${orderDetails.sellerAmount.toLocaleString()}</div>
      <p><strong>Items:</strong></p>
      <ul>
        ${orderDetails.products.map(p => `<li>${p.productName} × ${p.quantity}</li>`).join('')}
      </ul>
      <div style="text-align: center;">
        <a href="https://app.elitehubng.com/orders/${orderId}" class="button">View & Fulfill Order</a>
      </div>
    `;
    await this.sendEmail(toEmail, `New Order – ₦${orderDetails.sellerAmount.toLocaleString()}`, getBaseTemplate(content, '#28a745'));
  }

  async sendDeliveryConfirmation(toEmail, name, orderId, amount) {
    const content = `
      <h2 style="color: #28a745; text-align: center;">Order Delivered ✅</h2>
      <p>Hi ${name},</p>
      <p>Your order has been marked as delivered and the escrow funds have been released to the seller.</p>
      <p><strong>Order ID:</strong> #${orderId.slice(-8).toUpperCase()}</p>
      <div class="amount">₦${amount.toLocaleString()}</div>
      <p>Thank you for shopping with EliteHub!</p>
    `;
    await this.sendEmail(toEmail, `Order Delivered #${orderId.slice(-8).toUpperCase()}`, getBaseTemplate(content, '#28a745'));
  }

  // ─────────────────────────────────────────────────────
  // ONBOARDING
  // ─────────────────────────────────────────────────────

  async sendBuyerWelcomeEmail(toEmail, name) {
    const firstName = name.split(' ')[0];
    const content = `
      <h1 style="color: #667eea; text-align: center;">Welcome to EliteHub, ${firstName}! 🎉</h1>
      <p>Your trusted marketplace for quality products and professional services in Nigeria is now at your fingertips.</p>
      <div style="background: #f8f9ff; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <p><strong>What you can do now:</strong></p>
        <ul>
          <li>Browse thousands of verified products</li>
          <li>Pay securely via Escrow</li>
          <li>Pay utility bills & buy airtime/data</li>
          <li>Track your deliveries in real-time</li>
        </ul>
      </div>
      <div style="text-align: center;">
        <a href="https://app.elitehubng.com/explore" class="button">Start Shopping</a>
      </div>
    `;
    await this.sendEmail(toEmail, `Welcome to EliteHub Nigeria, ${firstName}! 🛍️`, getBaseTemplate(content, '#667eea'));
  }

  async sendSellerWelcomeEmail(toEmail, name) {
    const firstName = name.split(' ')[0];
    const content = `
      <h1 style="color: #f97316; text-align: center;">Ready to Scale, ${firstName}? 🚀</h1>
      <p>Welcome to the EliteHub seller community! You are now set to reach thousands of customers across the country.</p>
      <div style="background: #fff7ed; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <p><strong>Your Seller Checklist:</strong></p>
        <ul>
          <li>Add your first product to the marketplace</li>
          <li>Complete your business profile</li>
          <li>Link your verified bank account for payouts</li>
        </ul>
      </div>
      <div style="text-align: center;">
        <a href="https://app.elitehubng.com/seller/dashboard" class="button">Access Seller Dashboard</a>
      </div>
    `;
    await this.sendEmail(toEmail, 'Welcome to EliteHub Marketplace! 💼', getBaseTemplate(content, '#f97316'));
  }

  async sendServiceWelcomeEmail(toEmail, name) {
    const firstName = name.split(' ')[0];
    const content = `
      <h1 style="color: #10b981; text-align: center;">Welcome, ${firstName}! 🛠️</h1>
      <p>Your pro account is active! Start connecting with clients who need your skills.</p>
      <div style="background: #f0fdf4; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <p><strong>Boost your visibility:</strong></p>
        <ul>
          <li>Complete your profile (aim for 70% or higher)</li>
          <li>Upload your work portfolio and certifications</li>
          <li>Respond quickly to new service inquiries</li>
        </ul>
      </div>
      <div style="text-align: center;">
        <a href="https://app.elitehubng.com/service/profile" class="button">Complete My Profile</a>
      </div>
    `;
    await this.sendEmail(toEmail, 'Pro Account Active – EliteHub Services 🎖️', getBaseTemplate(content, '#10b981'));
  }
}

module.exports = new EmailService();