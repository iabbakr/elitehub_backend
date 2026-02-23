// src/routes/otp-upgrade.routes.js
// Additional OTP routes for in-app email verification during account upgrades.
// These routes verify that a logged-in user owns a given email address
// WITHOUT signing them out or sending them to a new screen.
//
// Endpoints:
//   POST /api/v1/otp/send-verification-upgrade   — send OTP to any email (auth required)
//   POST /api/v1/otp/verify-upgrade-email        — verify OTP (auth required)

const express = require('express');
const router  = express.Router();
const { client }       = require('../config/redis');
const { auth, db }     = require('../config/firebase');
const { authenticate } = require('../middleware/auth');
const EmailService     = require('../services/email.service');
const catchAsync       = require('../utils/catchAsync');
const AppError         = require('../utils/AppError');

// ── Constants ────────────────────────────────────────────────────────────────

const OTP_TTL         = 600;  // 10 minutes
const RESEND_LIMIT    = 3;    // max 3 sends per window per user
const VERIFIED_TTL    = 1800; // verified token valid for 30 min

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function checkSendRateLimit(userId) {
  const key   = `otp:upgrade:rate:${userId}`;
  const count = await client.incr(key);
  if (count === 1) await client.expire(key, OTP_TTL);
  if (count > RESEND_LIMIT) {
    const ttl = await client.ttl(key);
    throw new AppError(
      `Too many verification requests. Try again in ${Math.ceil(ttl / 60)} minutes.`,
      429
    );
  }
}

async function storeUpgradeOTP(userId, email, otp) {
  // Key scoped to user + email so a user can't hijack another email's OTP
  const key = `otp:upgrade:${userId}:${email}`;
  await client.setEx(key, OTP_TTL, otp);
}

async function verifyUpgradeOTP(userId, email, code) {
  const key    = `otp:upgrade:${userId}:${email}`;
  const stored = await client.get(key);
  if (!stored)        return { valid: false, reason: 'expired' };
  if (stored !== code) return { valid: false, reason: 'invalid' };
  // Consume immediately on match (single-use)
  await client.del(key);
  return { valid: true };
}

// ── POST /otp/send-verification-upgrade ─────────────────────────────────────
// Auth required — sends a verification OTP to the supplied email.
// We don't check if the email is already in Firebase Auth because the user
// might be using the email they registered with (most common case).

router.post(
  '/send-verification-upgrade',
  authenticate,
  catchAsync(async (req, res, next) => {
    const { email } = req.body;
    const userId    = req.userId;

    if (!email) return next(new AppError('Email is required', 400));

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return next(new AppError('Invalid email format', 400));
    }

    await checkSendRateLimit(userId);

    const otp = generateOTP();
    await storeUpgradeOTP(userId, cleanEmail, otp);

    // Reuse the existing signup OTP template (6-digit code email)
    await EmailService.sendSignupVerificationOTP(cleanEmail, otp);

    res.json({
      success: true,
      message: `Verification code sent to ${cleanEmail}`,
    });
  })
);

// ── POST /otp/verify-upgrade-email ───────────────────────────────────────────
// Auth required — verifies the OTP and stores a short-lived "verified" token
// so the upgrade controller can confirm the email was verified.

router.post(
  '/verify-upgrade-email',
  authenticate,
  catchAsync(async (req, res, next) => {
    const { email, code } = req.body;
    const userId          = req.userId;

    if (!email || !code) {
      return next(new AppError('Email and code are required', 400));
    }

    const cleanEmail = email.trim().toLowerCase();
    const result     = await verifyUpgradeOTP(userId, cleanEmail, code.trim());

    if (!result.valid) {
      const msg =
        result.reason === 'expired'
          ? 'Code has expired. Please request a new one.'
          : 'Incorrect code. Please try again.';
      return next(new AppError(msg, 400));
    }

    // Store "this user verified this email" so the upgrade endpoint can trust it
    const verifiedKey = `otp:upgrade:verified:${userId}:${cleanEmail}`;
    await client.setEx(verifiedKey, VERIFIED_TTL, 'true');

    res.json({ success: true, message: 'Email verified successfully.' });
  })
);

module.exports = router;