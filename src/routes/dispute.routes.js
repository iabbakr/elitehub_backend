const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate, adminOrSupport } = require('../middleware/auth');
const disputeController = require('../controllers/dispute.controller');

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/webp',
      'video/mp4', 'application/pdf',
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images, videos, and PDFs allowed.'));
    }
  },
});

/**
 * ✅ GUARD: Reject requests where :orderId param is empty/whitespace.
 *
 * Root cause of  GET /disputes//media  →  404 was that the frontend fired the
 * request before orderId was populated (empty string).  Express sees an empty
 * path segment and the route simply doesn't match — but the error message was
 * confusing.  This explicit middleware gives a clean 400 instead and protects
 * all parameterised routes below.
 */
router.param('orderId', (req, res, next, orderId) => {
  if (!orderId || !orderId.trim()) {
    return res.status(400).json({
      success: false,
      message: 'orderId is required and cannot be empty',
    });
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// USER ROUTES  (Buyer & Seller — authenticated participants)
// These must be declared BEFORE the router.use(adminOrSupport) block below,
// otherwise the admin middleware would run first on admin-mounted paths.
// ─────────────────────────────────────────────────────────────────────────────

// Open dispute (buyer only, after seller confirms)
router.post('/open', authenticate, disputeController.openDispute);

// Upload evidence — multer runs first so orderId is in req.body for canAccess
router.post(
  '/upload-media',
  authenticate,
  upload.single('file'),        // 1. Multer populates req.body + req.file
  disputeController.canAccess,  // 2. orderId is now available
  disputeController.uploadMedia
);

// Notify other party of a new message
router.post(
  '/notify-message',
  authenticate,
  disputeController.canAccess,
  disputeController.notifyNewMessage
);

// ✅ FIX: GET /:orderId/media — was returning 404 when orderId was empty string.
// The router.param guard above now rejects those before they hit this handler.
router.get(
  '/:orderId/media',
  authenticate,
  disputeController.canAccess,
  disputeController.getMediaList
);

// Get current dispute status & metadata
router.get(
  '/:orderId/status',
  authenticate,
  disputeController.canAccess,
  disputeController.getDisputeStatus
);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN & SUPPORT ROUTES  (role-gated)
// ─────────────────────────────────────────────────────────────────────────────

// All routes below require admin or support_agent role in addition to auth
router.use(authenticate, adminOrSupport);

// List all disputes with optional ?status= filter (Redis-cached)
router.get('/', disputeController.getAllDisputes);

// Atomic wallet resolution (release to seller / refund to buyer)
router.post('/resolve', disputeController.resolveDispute);

// Delete a specific evidence item
router.delete('/media/:mediaId', disputeController.deleteMedia);

// Compliance audit log
router.get('/audit-log', disputeController.getResolutionAuditLog);

module.exports = router;