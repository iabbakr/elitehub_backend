const { client } = require('../config/redis');

/**
 * GLOBAL MAINTENANCE MIDDLEWARE
 * Instantly freezes the platform at the API level
 */
const maintenanceGuard = async (req, res, next) => {
    // Only block actions that move money or change data
    const isWriteOperation = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    
    if (isWriteOperation) {
        const isMaintenanceMode = await client.get('system:maintenance_mode');
        
        if (isMaintenanceMode === 'true') {
            return res.status(503).json({
                success: false,
                message: "System Maintenance: We are currently performing emergency security updates. Transactions are temporarily disabled.",
                retryAfter: 3600
            });
        }
    }
    next();
};

module.exports = maintenanceGuard;