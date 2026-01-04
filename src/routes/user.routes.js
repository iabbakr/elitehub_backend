const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { client } = require('../config/redis');

router.get('/profile/:userId', async (req, res) => {
    const { userId } = req.params;
    const cacheKey = `user_profile:${userId}`;

    try {
        // 1. Try to get data from Redis (Free & Fast)
        const cachedUser = await client.get(cacheKey);
        if (cachedUser) {
            console.log("⚡ Serving from Redis Cache");
            return res.json(JSON.parse(cachedUser));
        }

        // 2. If not in Redis, fetch from Firestore (Costs a 'Read')
        console.log("🔥 Fetching from Firestore");
        const userDoc = await db.collection('users').doc(userId).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ message: "User not found" });
        }

        const userData = userDoc.data();

        // 3. Save to Redis for 1 hour (3600s) to save future costs
        await client.setEx(cacheKey, 3600, JSON.stringify(userData));

        res.json(userData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;