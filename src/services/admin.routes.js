const express = require('express');
const router = express.Router();
const { client } = require('../config/redis');

/**
 * TOGGLE MAINTENANCE MODE
 * POST /api/v1/admin/system/maintenance
 */
router.post('/system/maintenance', async (req, res) => {
    try {
        const { enabled } = req.body;
        
        // Save to Redis (as read by your maintenanceGuard)
        await client.set('system:maintenance_mode', enabled.toString());
        
        console.log(`🛡️  MAINTENANCE MODE: ${enabled ? 'ENABLED' : 'DISABLED'}`);
        
        res.json({
            success: true,
            isMaintenance: enabled,
            message: `System maintenance mode ${enabled ? 'activated' : 'deactivated'}`
        });
    } catch (error) {
        console.error('Maintenance toggle error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

module.exports = router;