// services/email.service.js - PRODUCTION EMAIL SERVICE (Resend)
const { Resend } = require('resend');

if (!process.env.RESEND_API_KEY) {
  console.error('❌ RESEND_API_KEY is missing in .env file');
  process.exit(1);
}

const resend = new Resend(process.env.RESEND_API_KEY);

console.log('✅ Resend initialized');

/**
 * FROM address — must match your verified Resend domain.
 * Your domain: elitehubng.com → verified at https://resend.com/domains
 */
/**
 * ✅ CRITICAL: Must match your VERIFIED Resend domain.
 * Your verified domain is: mail.elitehubng.com
 * So FROM address must use @mail.elitehubng.com — NOT @elitehubng.com
 */
const FROM_EMAIL = 'EliteHub Nigeria <noreply@mail.elitehubng.com>';

// ─────────────────────────────────────────────────────────────────
// BASE HTML TEMPLATE
// ─────────────────────────────────────────────────────────────────
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
    .info-box { background: #f8f9ff; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 4px solid ${brandColor}; }
    .footer { background: #f9f9f9; padding: 20px; text-align: center; color: #888; font-size: 12px; }
    ul { padding-left: 20px; }
    li { margin-bottom: 8px; }
    .divider { border: none; border-top: 1px solid #eee; margin: 20px 0; }
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
      <p>Lagos, Nigeria | <a href="mailto:support@elitehubng.com" style="color:#667eea;">support@elitehubng.com</a></p>
      <p style="font-size:11px; color:#bbb;">You received this email because you signed up on EliteHub Nigeria.</p>
    </div>
  </div>
</body>
</html>
`;

// ─────────────────────────────────────────────────────────────────
// EMAIL SERVICE CLASS
// ─────────────────────────────────────────────────────────────────
class EmailService {

  /**
   * ✅ Core sender — wraps Resend API
   * Never throws — logs failure and returns null so a failed
   * email never rolls back a successful database transaction.
   */
  async sendEmail(to, subject, html) {
    try {
      console.log(`📧 Sending email → ${to} | Subject: ${subject}`);

      const { data, error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: [to],
        subject,
        html,
      });

      if (error) {
        console.error(`❌ Resend API error for ${to}:`, error);
        return null;
      }

      console.log(`✅ Email delivered → ${to} | ID: ${data?.id}`);
      return data;
    } catch (err) {
      console.error(`❌ sendEmail exception for ${to}:`, err?.message || err);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ONBOARDING / WELCOME EMAILS
  // ─────────────────────────────────────────────────────────────

  async sendBuyerWelcomeEmail(toEmail, name) {
    const firstName = name.split(' ')[0];
    const content = `
      <h1 style="color:#667eea; text-align:center;">Welcome to EliteHub, ${firstName}! 🎉</h1>
      <p>Hi ${firstName},</p>
      <p>You're now part of Nigeria's fastest-growing marketplace. Here's what you can do right now:</p>
      <div class="info-box">
        <ul>
          <li>🛍️ Browse thousands of verified products</li>
          <li>🔒 Pay securely via our Escrow system</li>
          <li>📱 Buy airtime, data & pay utility bills</li>
          <li>📦 Track your deliveries in real-time</li>
        </ul>
      </div>
      <div style="text-align:center;">
        <a href="https://www.elitehubng.com" class="button">Start Shopping</a>
      </div>
      <hr class="divider">
      <p style="font-size:13px; color:#888;">Need help? Reply to this email or visit our support page.</p>
    `;
    return this.sendEmail(
      toEmail,
      `Welcome to EliteHub Nigeria, ${firstName}! 🛍️`,
      getBaseTemplate(content, '#667eea')
    );
  }

  async sendSellerWelcomeEmail(toEmail, name) {
    const firstName = name.split(' ')[0];
    const content = `
      <h1 style="color:#f97316; text-align:center;">Ready to Scale, ${firstName}? 🚀</h1>
      <p>Hi ${firstName},</p>
      <p>Welcome to the EliteHub seller community! You can now reach thousands of customers across Nigeria.</p>
      <div class="info-box">
        <p><strong>Your Seller Checklist:</strong></p>
        <ul>
          <li>✅ Complete your business profile</li>
          <li>📦 Add your first product to the marketplace</li>
          <li>🏦 Link your verified bank account for payouts</li>
          <li>📢 Share your store link with your customers</li>
        </ul>
      </div>
      <div style="text-align:center;">
        <a href="https://www.elitehubng.com" class="button" style="background:#f97316;">Go to Seller Dashboard</a>
      </div>
      <hr class="divider">
      <p style="font-size:13px; color:#888;">Questions? Email us at <a href="mailto:support@elitehubng.com">support@elitehubng.com</a></p>
    `;
    return this.sendEmail(
      toEmail,
      'Welcome to EliteHub Marketplace! 💼',
      getBaseTemplate(content, '#f97316')
    );
  }

  async sendServiceWelcomeEmail(toEmail, name) {
    const firstName = name.split(' ')[0];
    const content = `
      <h1 style="color:#10b981; text-align:center;">Welcome, ${firstName}! 🛠️</h1>
      <p>Hi ${firstName},</p>
      <p>Your EliteHub Pro account is now active. Start connecting with clients who need your skills.</p>
      <div class="info-box">
        <p><strong>Boost your visibility fast:</strong></p>
        <ul>
          <li>📝 Complete your profile (aim for 70%+)</li>
          <li>🖼️ Upload work portfolio & certifications</li>
          <li>⚡ Subscribe to appear in search results</li>
          <li>💬 Respond quickly to new inquiries</li>
        </ul>
      </div>
      <div style="text-align:center;">
        <a href="https://www.elitehubng.com" class="button" style="background:#10b981;">Complete My Profile</a>
      </div>
      <hr class="divider">
      <p style="font-size:13px; color:#888;">Need help getting started? Email <a href="mailto:support@elitehubng.com">support@elitehubng.com</a></p>
    `;
    return this.sendEmail(
      toEmail,
      'Pro Account Active – EliteHub Services 🎖️',
      getBaseTemplate(content, '#10b981')
    );
  }

  // ─────────────────────────────────────────────────────────────
  // AUTH EMAILS (referenced in auth.routes.js)
  // ─────────────────────────────────────────────────────────────

  /**
   * ✅ MISSING METHOD — Email verification link
   * Called by: POST /api/v1/auth/verify-email
   */
  async sendVerificationEmail(toEmail, name, verificationLink) {
    const firstName = name?.split(' ')[0] || 'there';
    const content = `
      <h2 style="color:#667eea; text-align:center;">Verify Your Email Address 📧</h2>
      <p>Hi ${firstName},</p>
      <p>Please verify your email address to unlock full access to your EliteHub account.</p>
      <div style="text-align:center;">
        <a href="${verificationLink}" class="button">Verify My Email</a>
      </div>
      <p style="font-size:13px; color:#888;">This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.</p>
      <div class="info-box">
        <p style="margin:0; font-size:13px;">If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${verificationLink}" style="color:#667eea; word-break:break-all;">${verificationLink}</a></p>
      </div>
    `;
    return this.sendEmail(
      toEmail,
      'Verify Your EliteHub Email Address ✅',
      getBaseTemplate(content, '#667eea')
    );
  }

  /**
   * ✅ MISSING METHOD — Password reset link
   * Called by: POST /api/v1/auth/forgot-password
   */
  async sendPasswordResetEmail(toEmail, name, resetLink) {
    const firstName = name?.split(' ')[0] || 'there';
    const content = `
      <h2 style="color:#ef4444; text-align:center;">Password Reset Request 🔐</h2>
      <p>Hi ${firstName},</p>
      <p>We received a request to reset your EliteHub password. Click the button below to create a new password.</p>
      <div style="text-align:center;">
        <a href="${resetLink}" class="button" style="background:#ef4444;">Reset My Password</a>
      </div>
      <p style="font-size:13px; color:#888;">⚠️ This link expires in <strong>1 hour</strong>. If you didn't request a password reset, no action is needed — your account is safe.</p>
      <div class="info-box">
        <p style="margin:0; font-size:13px;">If the button doesn't work, copy and paste this link:<br>
        <a href="${resetLink}" style="color:#ef4444; word-break:break-all;">${resetLink}</a></p>
      </div>
    `;
    return this.sendEmail(
      toEmail,
      'EliteHub Password Reset Request 🔐',
      getBaseTemplate(content, '#ef4444')
    );
  }

  /**
   * ✅ MISSING METHOD — Password changed confirmation
   * Called by: POST /api/v1/auth/change-password
   */
  async sendPasswordChangedEmail(toEmail, name) {
    const firstName = name?.split(' ')[0] || 'there';
    const now = new Date().toLocaleString('en-NG', {
      timeZone: 'Africa/Lagos',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const content = `
      <h2 style="color:#10b981; text-align:center;">Password Changed Successfully ✅</h2>
      <p>Hi ${firstName},</p>
      <p>Your EliteHub account password was successfully changed on <strong>${now} (Lagos time)</strong>.</p>
      <div class="info-box">
        <p style="margin:0;">⚠️ <strong>If you did NOT make this change</strong>, please contact us immediately at 
        <a href="mailto:support@elitehubng.com">support@elitehubng.com</a> and we will secure your account.</p>
      </div>
      <div style="text-align:center; margin-top:20px;">
        <a href="https://www.elitehubng.com" class="button" style="background:#10b981;">Go to My Account</a>
      </div>
    `;
    return this.sendEmail(
      toEmail,
      'Your EliteHub Password Has Been Changed ✅',
      getBaseTemplate(content, '#10b981')
    );
  }

  // ─────────────────────────────────────────────────────────────
  // WALLET ALERTS
  // ─────────────────────────────────────────────────────────────

  async sendDepositAlert(toEmail, name, amount) {
    const firstName = name?.split(' ')[0] || 'there';
    const content = `
      <h2 style="color:#28a745; text-align:center;">Wallet Credited ✅</h2>
      <p>Hi ${firstName},</p>
      <p>Your EliteHub wallet has been successfully topped up.</p>
      <div class="amount">₦${Number(amount).toLocaleString()}</div>
      <p>Your funds are ready to use for shopping, airtime, data, and bill payments.</p>
      <div style="text-align:center;">
        <a href="https://www.elitehubng.com" class="button" style="background:#28a745;">View Wallet</a>
      </div>
    `;
    return this.sendEmail(
      toEmail,
      `Wallet Credited: ₦${Number(amount).toLocaleString()} ✅`,
      getBaseTemplate(content, '#28a745')
    );
  }

  async sendWithdrawalConfirmation(toEmail, name, amount, bankDetails) {
    const firstName = name?.split(' ')[0] || 'there';
    const content = `
      <h2 style="color:#dc3545; text-align:center;">Withdrawal Processed 💸</h2>
      <p>Hi ${firstName},</p>
      <p>Your withdrawal has been successfully initiated.</p>
      <div class="amount">₦${Number(amount).toLocaleString()}</div>
      <div class="info-box">
        <p style="margin:0;"><strong>Transfer to:</strong><br>
        ${bankDetails.accountName}<br>
        ${bankDetails.bankName} — ${bankDetails.accountNumber}</p>
      </div>
      <p style="font-size:13px; color:#888;">Funds typically arrive within 24 hours. If you have issues, contact support.</p>
    `;
    return this.sendEmail(
      toEmail,
      `Withdrawal of ₦${Number(amount).toLocaleString()} Processed`,
      getBaseTemplate(content, '#dc3545')
    );
  }

  // ─────────────────────────────────────────────────────────────
  // ORDER NOTIFICATIONS
  // ─────────────────────────────────────────────────────────────

  async sendOrderConfirmation(toEmail, name, orderId, orderDetails) {
    const firstName = name?.split(' ')[0] || 'there';
    const shortId = orderId.slice(-8).toUpperCase();
    const content = `
      <h2 style="text-align:center;">Order Confirmed 🛍️</h2>
      <p>Hi ${firstName},</p>
      <p>Your order has been placed and the seller has been notified. Your funds are held safely in escrow.</p>
      <div class="info-box">
        <p><strong>Order ID:</strong> #${shortId}</p>
        <p><strong>Total:</strong> ₦${Number(orderDetails.totalAmount).toLocaleString()}</p>
        <p style="margin:0;"><strong>Delivery to:</strong> ${orderDetails.deliveryAddress}</p>
      </div>
      <div style="text-align:center;">
        <a href="https://www.elitehubng.com" class="button">Track My Order</a>
      </div>
    `;
    return this.sendEmail(
      toEmail,
      `Order Confirmed #${shortId} 🛍️`,
      getBaseTemplate(content)
    );
  }

  async sendNewOrderAlert(toEmail, sellerName, orderId, orderDetails) {
    const firstName = sellerName?.split(' ')[0] || 'there';
    const shortId = orderId.slice(-8).toUpperCase();
    const content = `
      <h2 style="color:#28a745; text-align:center;">New Order Received! 🔔</h2>
      <p>Hi ${firstName},</p>
      <p>You have a new order waiting to be fulfilled.</p>
      <div class="info-box">
        <p><strong>Order ID:</strong> #${shortId}</p>
        <p><strong>Your Earnings:</strong> ₦${Number(orderDetails.sellerAmount).toLocaleString()}</p>
        <p><strong>Items:</strong></p>
        <ul>
          ${orderDetails.products.map(p => `<li>${p.productName} × ${p.quantity}</li>`).join('')}
        </ul>
      </div>
      <div style="text-align:center;">
        <a href="https://www.elitehubng.com" class="button" style="background:#28a745;">View & Fulfil Order</a>
      </div>
    `;
    return this.sendEmail(
      toEmail,
      `New Order #${shortId} — ₦${Number(orderDetails.sellerAmount).toLocaleString()} 🔔`,
      getBaseTemplate(content, '#28a745')
    );
  }

  // ─────────────────────────────────────────────────────────────
  // OTP EMAILS
  // ─────────────────────────────────────────────────────────────

  /**
   * ✅ Signup email verification OTP
   * Called by: POST /api/v1/otp/send-verification
   */
  async sendSignupVerificationOTP(toEmail, otp) {
    const content = `
      <h2 style="color:#667eea; text-align:center;">Verify Your Email 📧</h2>
      <p>Hi there,</p>
      <p>Enter this code to verify your email address and complete your EliteHub signup:</p>
      <div style="text-align:center; margin: 30px 0;">
        <div style="display:inline-block; background:#f0f0ff; border: 2px dashed #667eea; border-radius:12px; padding: 20px 40px;">
          <span style="font-size:42px; font-weight:900; letter-spacing:12px; color:#667eea;">${otp}</span>
        </div>
      </div>
      <div class="info-box">
        <p style="margin:0; font-size:13px;">⏱️ This code expires in <strong>10 minutes</strong>.<br>
        🔒 Never share this code with anyone — EliteHub will never ask for it.</p>
      </div>
      <p style="font-size:13px; color:#888; margin-top:20px;">If you did not try to sign up, you can safely ignore this email.</p>
    `;
    return this.sendEmail(
      toEmail,
      `${otp} — Your EliteHub Verification Code`,
      getBaseTemplate(content, '#667eea')
    );
  }

  /**
   * ✅ Password reset OTP
   * Called by: POST /api/v1/otp/send-password-reset
   */
  async sendPasswordResetOTP(toEmail, name, otp) {
    const firstName = name?.split(' ')[0] || 'there';
    const content = `
      <h2 style="color:#ef4444; text-align:center;">Password Reset Code 🔐</h2>
      <p>Hi ${firstName},</p>
      <p>We received a request to reset your EliteHub password. Use the code below:</p>
      <div style="text-align:center; margin: 30px 0;">
        <div style="display:inline-block; background:#fff5f5; border: 2px dashed #ef4444; border-radius:12px; padding: 20px 40px;">
          <span style="font-size:42px; font-weight:900; letter-spacing:12px; color:#ef4444;">${otp}</span>
        </div>
      </div>
      <div class="info-box">
        <p style="margin:0; font-size:13px;">⏱️ This code expires in <strong>10 minutes</strong>.<br>
        🔒 Never share this code with anyone — EliteHub will never ask for it.</p>
      </div>
      <p style="font-size:13px; color:#888; margin-top:20px;">If you did not request a password reset, your account is safe — no action needed.</p>
    `;
    return this.sendEmail(
      toEmail,
      `${otp} — Your EliteHub Password Reset Code`,
      getBaseTemplate(content, '#ef4444')
    );
  }

  async sendDeliveryConfirmation(toEmail, name, orderId, amount) {
    const firstName = name?.split(' ')[0] || 'there';
    const shortId = orderId.slice(-8).toUpperCase();
    const content = `
      <h2 style="color:#28a745; text-align:center;">Order Delivered ✅</h2>
      <p>Hi ${firstName},</p>
      <p>Your order <strong>#${shortId}</strong> has been marked as delivered and escrow funds have been released to the seller.</p>
      <div class="amount">₦${Number(amount).toLocaleString()}</div>
      <p>Thank you for shopping on EliteHub! We hope you love your purchase.</p>
      <div style="text-align:center;">
        <a href="https://www.elitehubng.com" class="button" style="background:#28a745;">Leave a Review</a>
      </div>
    `;
    return this.sendEmail(
      toEmail,
      `Order #${shortId} Delivered ✅`,
      getBaseTemplate(content, '#28a745')
    );
  }
}

module.exports = new EmailService();