
const express  = require('express');
const router   = express.Router();
const { authenticate } = require('../middleware/auth');
const upgradeController = require('../controllers/upgrade.controller');

/**
 * POST /api/v1/users/upgrade-role
 *
 * Upgrades a buyer account to seller or service provider.
 * Requires:
 *   - Bearer token (authenticate middleware)
 *   - Email verified via /api/v1/otp/verify-upgrade-email BEFORE calling this
 *
 * Body: {
 *   newRole:          "seller" | "service",
 *   businessName:     string,
 *   businessPhone:    string,
 *   businessAddress:  string,
 *   verifiedEmail:    string,
 *   rcNumber?:        string,      // optional, 7 digits
 *   sellerCategories?: string[],   // required if newRole === "seller"
 *   serviceCategory?:  string,     // required if newRole === "service"
 * }
 */
router.post('/upgrade-role', authenticate, upgradeController.upgradeRole);

module.exports = router;