const express = require('express');
const router = express.Router();
const activityController = require('../controllers/activity.controller');
const { authenticate } = require('../middleware/auth');

// Matches the POST request from your useActivityLogger hook
router.post('/log', authenticate, activityController.logActivity);

module.exports = router;