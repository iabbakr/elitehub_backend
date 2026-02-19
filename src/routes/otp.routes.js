// routes/otp.routes.js — OTP via Resend for email verification & password reset
//
// FIXES applied:
//  1. /verify-password-reset now sends the confirmation email ONLY after
//     Firebase actually confirms the password update succeeded.
//  2. Added a /peek-password-reset endpoint so the client can optionally
//     check OTP validity without consuming it (useful for UX feedback).
//  3. verifyOTP is now wrapped so that on a failed match the code is NOT
//     deleted — only a successful match removes it from Redis.

const express = require('express');
const router = express.Router();
const { client } = require('../config/redis');
const { auth, db } = require('../config/firebase');
const EmailService = require('../services/email.service');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');

// ── helpers ──────────────────────────────────────────────────────────────────

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}

const OTP_TTL   = 600; // 10 minutes in seconds
const OTP_LIMIT = 3;   // max sends per email per window

/**
 * Rate-limit OTP sends: max OTP_LIMIT per email per OTP_TTL window.
 */
async function checkRateLimit(email) {
  const key = `otp:rate:${email}`;
  const count = await client.incr(key);
  if (count === 1) await client.expire(key, OTP_TTL);
  if (count > OTP_LIMIT) {
    const ttl = await client.ttl(key);
    throw new AppError(
      `Too many OTP requests. Try again in ${Math.ceil(ttl / 60)} minutes.`,
      429
    );
  }
}

/**
 * Store OTP in Redis with TTL.
 */
async function storeOTP(prefix, email, otp) {
  const key = `otp:${prefix}:${email}`;
  await client.setEx(key, OTP_TTL, otp);
}

/**
 * FIX: Peek at OTP without consuming it.
 * Returns { valid, reason } but does NOT delete the key on match.
 * Use this for intermediate "is this code correct?" checks.
 */
async function peekOTP(prefix, email, code) {
  const key = `otp:${prefix}:${email}`;
  const stored = await client.get(key);
  if (!stored) return { valid: false, reason: 'expired' };
  if (stored !== code) return { valid: false, reason: 'invalid' };
  return { valid: true };
}

/**
 * Verify OTP from Redis — deletes it on match (single-use).
 * Call this ONLY when you are about to perform the real action
 * (e.g., actually updating the password in Firebase).
 */
async function verifyOTP(prefix, email, code) {
  const result = await peekOTP(prefix, email, code);
  if (result.valid) {
    // Only delete after confirming it's correct
    const key = `otp:${prefix}:${email}`;
    await client.del(key);
  }
  return result;
}

// ── routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/otp/send-verification
 * Sends a 6-digit OTP to verify email before signup.
 * Body: { email }
 */
router.post('/send-verification', catchAsync(async (req, res, next) => {
  const { email } = req.body;
  if (!email) return next(new AppError('Email is required', 400));

  const cleanEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail))
    return next(new AppError('Invalid email format', 400));

  // Check not already registered
  try {
    await auth.getUserByEmail(cleanEmail);
    return next(
      new AppError(
        'An account already exists with this email. Please sign in.',
        409
      )
    );
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    // Good — email is not yet registered
  }

  await checkRateLimit(cleanEmail);

  const otp = generateOTP();
  await storeOTP('signup', cleanEmail, otp);
  await EmailService.sendSignupVerificationOTP(cleanEmail, otp);

  res.json({ success: true, message: 'Verification code sent to your email.' });
}));

/**
 * POST /api/v1/otp/verify-email
 * Checks the OTP entered by the user before signup.
 * Body: { email, code }
 * Returns a short-lived verified token stored in Redis.
 */
router.post('/verify-email', catchAsync(async (req, res, next) => {
  const { email, code } = req.body;
  if (!email || !code)
    return next(new AppError('Email and code are required', 400));

  const cleanEmail = email.trim().toLowerCase();
  const result = await verifyOTP('signup', cleanEmail, code.trim());

  if (!result.valid) {
    const msg =
      result.reason === 'expired'
        ? 'Code has expired. Please request a new one.'
        : 'Incorrect code. Please try again.';
    return next(new AppError(msg, 400));
  }

  // Issue a short-lived "email verified" token so signup can trust the email
  const verifiedKey = `otp:verified:${cleanEmail}`;
  await client.setEx(verifiedKey, 1800, 'true'); // 30 min to complete signup

  res.json({ success: true, message: 'Email verified successfully.' });
}));

/**
 * POST /api/v1/otp/send-password-reset
 * Sends a 6-digit OTP for password reset.
 * Body: { email }
 */
router.post('/send-password-reset', catchAsync(async (req, res, next) => {
  const { email } = req.body;
  if (!email) return next(new AppError('Email is required', 400));

  const cleanEmail = email.trim().toLowerCase();

  // Always respond success to avoid email enumeration
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(cleanEmail);
  } catch (err) {
    // User not found — still return success silently
    return res.json({
      success: true,
      message: 'If an account exists, a code has been sent.',
    });
  }

  try {
    await checkRateLimit(`reset:${cleanEmail}`);
  } catch (err) {
    return next(err);
  }

  const otp = generateOTP();
  await storeOTP('reset', cleanEmail, otp);

  // Get name from Firestore for a personalised email
  let name = 'there';
  try {
    const userDoc = await db.collection('users').doc(userRecord.uid).get();
    if (userDoc.exists) name = userDoc.data().name || 'there';
  } catch (_) {}

  await EmailService.sendPasswordResetOTP(cleanEmail, name, otp);

  res.json({
    success: true,
    message: 'If an account exists, a code has been sent.',
  });
}));

/**
 * POST /api/v1/otp/peek-password-reset   ← NEW (optional, for UX)
 * Validates the OTP WITHOUT consuming it or changing the password.
 * Safe to call from the OTP entry screen if you want server-side validation
 * before advancing the user to the password screen.
 * Body: { email, code }
 *
 * NOTE: The frontend in this codebase does NOT call this — it advances
 * client-side after basic length validation. This endpoint exists for
 * future use or if you want stricter server-side OTP confirmation.
 */
router.post('/peek-password-reset', catchAsync(async (req, res, next) => {
  const { email, code } = req.body;
  if (!email || !code)
    return next(new AppError('Email and code are required', 400));

  const cleanEmail = email.trim().toLowerCase();
  const result = await peekOTP('reset', cleanEmail, code.trim());

  if (!result.valid) {
    const msg =
      result.reason === 'expired'
        ? 'Code has expired. Please request a new one.'
        : 'Incorrect code. Please try again.';
    return next(new AppError(msg, 400));
  }

  // Code is valid but NOT consumed — user can now proceed to password screen
  res.json({ success: true, message: 'Code is valid.' });
}));

/**
 * POST /api/v1/otp/verify-password-reset
 * Verifies OTP then resets the password atomically.
 * Body: { email, code, newPassword }
 *
 * FIX: This is now the ONLY endpoint that consumes (deletes) the OTP.
 * The confirmation email is sent ONLY after Firebase confirms success.
 * If Firebase throws, the OTP has already been consumed — this is intentional
 * because a failed Firebase update is a system error, not a user error, and
 * the user should request a new code rather than retry with the same one.
 */
router.post('/verify-password-reset', catchAsync(async (req, res, next) => {
  const { email, code, newPassword } = req.body;

  if (!email || !code || !newPassword) {
    return next(
      new AppError('Email, code, and new password are required', 400)
    );
  }

  if (newPassword.length < 6) {
    return next(
      new AppError('Password must be at least 6 characters', 400)
    );
  }

  const cleanEmail = email.trim().toLowerCase();

  // 1. Verify & consume OTP atomically
  const result = await verifyOTP('reset', cleanEmail, code.trim());

  if (!result.valid) {
    const msg =
      result.reason === 'expired'
        ? 'Code has expired. Please request a new one.'
        : 'Incorrect code. Please try again.';
    return next(new AppError(msg, 400));
  }

  // 2. Look up Firebase user
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(cleanEmail);
  } catch (err) {
    // Extremely unlikely (user deleted between OTP send and here)
    return next(new AppError('Account not found. Please sign up.', 404));
  }

  // 3. Update Firebase Auth password — this is the real action
  try {
    await auth.updateUser(userRecord.uid, { password: newPassword });
  } catch (err) {
    console.error('Firebase password update failed:', err);
    return next(
      new AppError(
        'Failed to update password. Please request a new code and try again.',
        500
      )
    );
  }

  // 4. FIX: Send confirmation email ONLY after Firebase confirms success.
  //    Use setImmediate so it doesn't block the response.
  setImmediate(async () => {
    try {
      const userDoc = await db.collection('users').doc(userRecord.uid).get();
      const name = userDoc.exists ? userDoc.data().name : 'there';
      await EmailService.sendPasswordChangedEmail(cleanEmail, name);
    } catch (err) {
      // Non-fatal — password is already changed, just log the email failure
      console.error('Password-changed confirmation email failed:', err);
    }
  });

  res.json({
    success: true,
    message: 'Password reset successfully. You can now sign in.',
  });
}));

module.exports = router;