// jobs/subscriptionReminders.js - CRON JOB FOR REMINDERS
const cron = require('node-cron');
const serviceProviderService = require('../services/service-provider.service');

/**
 * ✅ Run subscription checks every 6 hours
 * Check for expiring subscriptions and send reminders
 */
cron.schedule('0 */6 * * *', async () => {
    console.log('🔔 Running subscription reminder check...');
    
    try {
        // Check expiry reminders (3 days, 1 day before expiry)
        await serviceProviderService.checkExpiryReminders();
        
        // Send reminders to unsubscribed providers (once per week)
        await serviceProviderService.sendUnsubscribedReminders();
        
        console.log('✅ Subscription reminders completed');
    } catch (error) {
        console.error('❌ Subscription reminder error:', error);
    }
});

console.log('✅ Subscription reminder job initialized (runs every 6 hours)');

module.exports = {};