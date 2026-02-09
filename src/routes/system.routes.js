const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { client: redis } = require('../config/redis');
const catchAsync = require('../utils/catchAsync');

// Import your local constants to ensure the app works even if DB is empty
// Adjust the paths based on where your constants live on the backend
const { 
  SELLERS_CATEGORIES, 
  SERVICE_PROVIDER_CATEGORIES 
} = require('../constants/Categories');
const { NIGERIAN_LOCATIONS } = require('../constants/Locations');

router.get('/config', catchAsync(async (req, res) => {
  const cacheKey = 'system:config';
  
  // 1. Try Redis HIT for maximum performance
  const cached = await redis.get(cacheKey);
  if (cached) {
    console.log('🚀 Redis HIT: system:config');
    return res.json({ success: true, data: JSON.parse(cached) });
  }

  // 2. Database Fetch (Allows admin to override categories/locations without code deploy)
  console.log('📡 Redis MISS: system:config. Fetching from Firestore...');
  const configSnap = await db.collection('system').doc('app_config').get();
  const dbConfig = configSnap.exists ? configSnap.data() : {};

  // 3. Merge Strategy: Database values take priority, but Constants provide the base
  const finalConfig = {
    sellerCategories: dbConfig.sellerCategories || SELLERS_CATEGORIES,
    serviceCategories: dbConfig.serviceCategories || SERVICE_PROVIDER_CATEGORIES,
    locations: dbConfig.locations || NIGERIAN_LOCATIONS,
    maintenance: dbConfig.maintenance || false,
    appVersion: dbConfig.appVersion || '1.0.0'
  };

  // 4. Cache for 24 hours (Config rarely changes)
  await redis.setEx(cacheKey, 86400, JSON.stringify(finalConfig));

  res.json({ success: true, data: finalConfig });
}));

module.exports = router;