const cron = require('node-cron');
const axios = require('axios');
const { client } = require('../config/redis');

// Run every 10 minutes
cron.schedule('*/10 * * * *', async () => {
    console.log('--- System Keep-Alive Triggered ---');

    try {
        // 1. Keep Backend Awake: Ping the health check endpoint
        // Use your production URL here
        const APP_URL = process.env.NODE_ENV === 'production' 
            ? 'https://elitehubng.com/health' 
            : `http://localhost:${process.env.PORT || 3000}/health`;

        const response = await axios.get(APP_URL);
        console.log(`📡 Backend Ping: ${response.status === 200 ? 'SUCCESS' : 'FAILED'}`);

        // 2. Keep Redis Awake: Small write/read operation
        // This prevents the connection from being closed due to inactivity
        if (client.isOpen) {
            await client.set('heartbeat', Date.now());
            const ping = await client.get('heartbeat');
            console.log(`🚀 Redis Heartbeat: ${ping ? 'ACTIVE' : 'INACTIVE'}`);
        }

    } catch (error) {
        console.error('❌ Keep-Alive Error:', error.message);
    }
});