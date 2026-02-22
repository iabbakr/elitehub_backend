// src/middleware/rateLimiters.js
const rateLimit = require('express-rate-limit');

/**
 * 🛡️ STRICT LIMITER
 * Use for: Withdrawals, PIN changes, Sensitive Data access
 * Goal: Prevent brute force on high-value operations
 */
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, 
  message: {
    success: false,
    message: 'Security lock triggered. Too many sensitive attempts. Please wait 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 📲 AUTH/OTP LIMITER
 * Use for: Login, Register, Resend OTP
 * Goal: Prevent SMS/Email cost spikes and account enumerations
 */
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  strictLimiter,
  authLimiter
};