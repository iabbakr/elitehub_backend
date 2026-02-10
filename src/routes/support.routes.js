const express = require('express');
const router = express.Router();
const supportController = require('../controllers/support.controller');
const { authenticate, adminOrSupport } = require('../middleware/auth');

/**
 * @section User Actions
 */

// Initialize a new chat session (Checks Redis for existing session)
router.post('/chats/init', authenticate, supportController.initChat);

// Get current queue status for the user
router.get('/chats/status', authenticate, supportController.getChatStatus);

/**
 * @section Admin & Support Actions
 */
router.use(authenticate, adminOrSupport);

// Assign waiting chat to an agent (Removes from Redis Queue)
router.patch('/chats/:chatId/assign', supportController.assignChat);

// Mark chat as resolved (Clears Redis session lock)
router.post('/chats/:chatId/resolve', supportController.resolveChat);

module.exports = router;