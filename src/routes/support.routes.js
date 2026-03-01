const express = require('express');
const router  = express.Router();
const supportController = require('../controllers/support.controller');
const { authenticate, adminOrSupport } = require('../middleware/auth');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * @section User Actions
 * All authenticated users (buyers, sellers, service providers).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Initialize a new chat session (checks Redis for existing session)
router.post('/chats/init', authenticate, supportController.initChat);

// Get current queue status + position for the user
router.get('/chats/status', authenticate, supportController.getChatStatus);

/**
 * Upload media attachment (image / video / document).
 *
 * BUG FIX: This MUST be above the `router.use(adminOrSupport)` wall so that
 * regular users can upload attachments. Using the dedicated support controller
 * endpoint (not /upload/image) so that video/* and document MIME types are
 * accepted — the old /upload/image endpoint filtered out everything except
 * image/* and application/pdf, causing "Invalid image file" for videos.
 *
 * supportChatService.uploadAttachment() should call:
 *   POST /api/v1/support/chats/upload-media   ← this endpoint
 * NOT:
 *   POST /api/v1/upload/image                 ← rejects video/*, only images
 */
router.post(
  '/chats/upload-media',
  authenticate,
  supportController.uploadMiddleware,   // multer: memory storage, 50 MB, allows image+video+doc
  supportController.uploadMedia,
);

// Send a message server-side (guaranteed push delivery even when app backgrounded)
router.post('/chats/:chatId/message', authenticate, supportController.sendMessage);

// Paginated message history  (?limit=50&before=<timestamp>)
router.get('/chats/:chatId/messages', authenticate, supportController.getMessages);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * @section Admin & Support Agent Actions
 * Everything below requires admin or support_agent role.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.use(authenticate, adminOrSupport);

// Assign a waiting chat to the requesting agent (removes from Redis queue)
router.patch('/chats/:chatId/assign', supportController.assignChat);

// Mark chat as resolved (clears Redis session lock, triggers push to user)
router.post('/chats/:chatId/resolve', supportController.resolveChat);

module.exports = router;