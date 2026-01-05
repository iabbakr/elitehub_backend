// services/emailService.js (or .ts if using TypeScript)

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// Change this once domain is verified. Recommend a subdomain like 'mail.elitehubng.com'
const FROM_EMAIL = 'EliteHub Nigeria <noreply@elitehubng.com>';

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
    .content { padding: 0 30px 30px; }
    .button { display: inline-block; padding: 14px 32px; background: ${brandColor}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0; }
    .amount { font-size: 32px; font-weight: bold; color: ${brandColor}; margin: 20px 0; text-align: center; }
    .footer { background: #f9f9f9; padding: 20px; text-align: center; color: #888; font-size: 12px; }
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
  async sendEmail(to, subject, html) {
    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to,
        subject,
        html,
      });
      console.log(`📧 Email sent to ${to}: ${subject}`);
    } catch (error) {
      console.error(`Email failed to ${to}:`, error.message || error);
      // Don't throw – email failure shouldn't break core flows
    }
  }

  async sendDepositAlert(toEmail, name, amount) {
    const content = `
      <h2 style="color: #28a745; text-align: center;">Deposit Confirmed ✅</h2>
      <p>Hi ${name},</p>
      <p>Your EliteHub wallet has been successfully credited.</p>
      <div class="amount">₦${amount.toLocaleString()}</div>
      <p>You can now use this balance for airtime, data, bills, and shopping.</p>
      <a href="https://app.elitehubng.com/wallet" class="button">View Wallet</a>
    `;
    await this.sendEmail(toEmail, `Wallet Credited: ₦${amount.toLocaleString()} ✅`, getBaseTemplate(content, '#28a745'));
  }

  async sendWithdrawalConfirmation(toEmail, name, amount, bankDetails) {
    const content = `
      <h2 style="color: #dc3545; text-align: center;">Withdrawal Processed 💸</h2>
      <p>Hi ${name},</p>
      <p>Your withdrawal request has been initiated.</p>
      <div class="amount">₦${amount.toLocaleString()}</div>
      <p><strong>To:</strong><br>
      ${bankDetails.accountName}<br>
      ${bankDetails.bankName} (${bankDetails.accountNumber})</p>
      <p>Funds should reflect within 24 hours.</p>
    `;
    await this.sendEmail(toEmail, `Withdrawal: ₦${amount.toLocaleString()} Processed`, getBaseTemplate(content, '#dc3545'));
  }

  async sendOrderConfirmation(toEmail, name, orderId, orderDetails) {
    const content = `
      <h2 style="text-align: center;">Order Confirmed 🛍️</h2>
      <p>Hi ${name},</p>
      <p>Thank you! Your order has been placed successfully.</p>
      <p><strong>Order ID:</strong> #${orderId.slice(-8).toUpperCase()}</p>
      <div class="amount">₦${orderDetails.totalAmount.toLocaleString()}</div>
      <p><strong>Delivery Address:</strong><br>${orderDetails.deliveryAddress}</p>
      <a href="https://app.elitehubng.com/orders/${orderId}" class="button">Track Order</a>
    `;
    await this.sendEmail(toEmail, `Order Confirmed #${orderId.slice(-8).toUpperCase()}`, getBaseTemplate(content));
  }

  async sendNewOrderAlert(toEmail, sellerName, orderId, orderDetails) {
    const content = `
      <h2 style="color: #28a745; text-align: center;">New Order Received! 🔔</h2>
      <p>Hi ${sellerName},</p>
      <p>You have a new order to fulfill.</p>
      <p><strong>Order ID:</strong> #${orderId.slice(-8).toUpperCase()}</p>
      <div class="amount">₦${orderDetails.sellerAmount.toLocaleString()}</div>
      <p><strong>Items:</strong></p>
      <ul>
        ${orderDetails.products.map(p => `<li>${p.productName} × ${p.quantity}</li>`).join('')}
      </ul>
      <a href="https://app.elitehubng.com/orders/${orderId}" class="button">View Order</a>
    `;
    await this.sendEmail(toEmail, `New Order – ₦${orderDetails.sellerAmount.toLocaleString()}`, getBaseTemplate(content, '#28a745'));
  }

  async sendDeliveryConfirmation(toEmail, name, orderId, amount) {
    const content = `
      <h2 style="color: #28a745; text-align: center;">Order Delivered ✅</h2>
      <p>Hi ${name},</p>
      <p>Your order has been marked as delivered and funds released to the seller.</p>
      <p><strong>Order ID:</strong> #${orderId.slice(-8).toUpperCase()}</p>
      <div class="amount">₦${amount.toLocaleString()}</div>
      <p>Thank you for shopping with EliteHub!</p>
    `;
    await this.sendEmail(toEmail, `Order Delivered #${orderId.slice(-8).toUpperCase()}`, getBaseTemplate(content, '#28a745'));
  }

  async sendBuyerWelcomeEmail(toEmail, name) {
    const firstName = name.split(' ')[0];
    const content = `
      <h1 style="color: #667eea; text-align: center;">Welcome to EliteHub, ${firstName}! 🎉</h1>
      <p>Your trusted marketplace for quality products and services in Nigeria.</p>
      <div style="background: #f8f9ff; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <p><strong>Get started:</strong></p>
        <ul>
          <li>Browse thousands of products</li>
          <li>Secure escrow payments</li>
          <li>Pay bills & buy airtime/data</li>
          <li>Real-time order tracking</li>
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
      <h1 style="color: #f97316; text-align: center;">Ready to Grow, ${firstName}? 🚀</h1>
      <p>Welcome to the EliteHub seller community!</p>
      <div style="background: #fff7ed; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <p><strong>Next steps:</strong></p>
        <ul>
          <li>Add your products</li>
          <li>Complete your business profile</li>
          <li>Set up bank details</li>
        </ul>
      </div>
      <div style="text-align: center;">
        <a href="https://app.elitehubng.com/seller/dashboard" class="button">Seller Dashboard</a>
      </div>
    `;
    await this.sendEmail(toEmail, 'Welcome to EliteHub Marketplace! 💼', getBaseTemplate(content, '#f97316'));
  }

  async sendServiceWelcomeEmail(toEmail, name) {
    const firstName = name.split(' ')[0];
    const content = `
      <h1 style="color: #10b981; text-align: center;">Welcome, ${firstName}! 🛠️</h1>
      <p>Join EliteHub's professional service network.</p>
      <div style="background: #f0fdf4; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <p><strong>Boost your visibility:</strong></p>
        <ul>
          <li>Complete your profile (aim for 70%+)</li>
          <li>Upload portfolio & certifications</li>
          <li>Start receiving client inquiries</li>
        </ul>
      </div>
      <div style="text-align: center;">
        <a href="https://app.elitehubng.com/service/profile" class="button">Complete Profile</a>
      </div>
    `;
    await this.sendEmail(toEmail, 'Pro Account Active – EliteHub Services 🎖️', getBaseTemplate(content, '#10b981'));
  }
}

module.exports = new EmailService();