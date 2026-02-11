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
    files: 1 
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images, videos, and PDFs allowed.'));
    }
  }
});

/**
 * @section USER ROUTES (Buyer & Seller)
 * All routes require authentication and order participation
 */

// ✅ FIXED: Open dispute (buyer only, after seller confirms)
router.post('/open', authenticate, disputeController.openDispute);

// ✅ FIXED: Upload media - multer runs first, then canAccess sees orderId in body
router.post(
  '/upload-media',
  authenticate,
  upload.single('file'),       // 1. Multer populates req.body and req.file
  disputeController.canAccess, // 2. Now orderId is in req.body
  disputeController.uploadMedia
);

// Send message notification (triggers push to other party)
router.post(
  '/notify-message',
  authenticate,
  disputeController.canAccess,
  disputeController.notifyNewMessage
);

// ✅ NEW: Get all media for a dispute (with pagination)
router.get(
  '/:orderId/media',
  authenticate,
  disputeController.canAccess,
  disputeController.getMediaList
);

// Get dispute status and metadata
router.get(
  '/:orderId/status',
  authenticate,
  disputeController.canAccess,
  disputeController.getDisputeStatus
);

/**
 * @section ADMIN & SUPPORT ROUTES
 * Require admin or support_agent role
 */
router.use(authenticate, adminOrSupport);

// ✅ FIXED: Get all disputes with pagination
router.get('/', disputeController.getAllDisputes);

// Resolve dispute (atomic wallet operation)
router.post('/resolve', disputeController.resolveDispute);

// Delete media/evidence
router.delete('/media/:mediaId', disputeController.deleteMedia);

// Get resolution history for audit trail
router.get('/audit-log', disputeController.getResolutionAuditLog);

module.exports = router;