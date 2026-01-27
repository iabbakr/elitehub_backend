const cron = require('node-cron');
const axios = require('axios');
const { client } = require('../config/redis');

cron.schedule('*/10 * * * *', async () => {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    
    console.log(`\n--- ⏳ System Keep-Alive Started [${timestamp}] ---`);

    try {
        // 1. Backend Ping with correct path
        const APP_URL = process.env.NODE_ENV === 'production' 
            ? 'https://elitehubng.com/api/v1/health' 
            : `http://localhost:${process.env.PORT || 3000}/api/v1/health`;

        const response = await axios.get(APP_URL);
        const duration = Date.now() - startTime;

        console.log(`📡 Backend Status: ${response.status} (${duration}ms)`);

        // 2. Redis Pulse Check
        if (client.isOpen) {
            // Store detailed heartbeat data in Redis
            const heartbeatData = JSON.stringify({
                lastRun: timestamp,
                status: 'healthy',
                responseTime: duration
            });
            
            await client.set('system:heartbeat', heartbeatData);
            console.log(`🚀 Redis Status: Verified & Updated`);
        }

    } catch (error) {
        console.error(`❌ Keep-Alive Failed: ${error.message}`);
        
        // Log failure to Redis if possible so you can alert on it later
        if (client.isOpen) {
            await client.set('system:heartbeat:error', JSON.stringify({
                time: timestamp,
                error: error.message
            }));
        }
    }
    console.log(`--- ✅ Keep-Alive Cycle Complete ---\n`);
});