// src/controllers/product.controller.js
const { db } = require('../config/firebase');
const { client: redis } = require('../config/redis');
const catchAsync = require('../utils/catchAsync');

exports.getProducts = catchAsync(async (req, res, next) => {
  const { category, state } = req.query;
  // Dynamic cache key including state for localized results
  const cacheKey = `products:${category || 'all'}:${state || 'global'}`;

  const cachedData = await redis.get(cacheKey);
  if (cachedData) {
    return res.status(200).json({
      success: true,
      source: 'cache',
      products: JSON.parse(cachedData)
    });
  }

  let query = db.collection('products').orderBy('createdAt', 'desc');
  if (category) query = query.where('category', '==', category);
  if (state) query = query.where('location.state', '==', state);

  const snapshot = await query.limit(50).get();
  const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  if (products.length > 0) {
    await redis.setEx(cacheKey, 600, JSON.stringify(products));
  }

  res.status(200).json({ success: true, source: 'database', products });
});

exports.getSmartFilters = catchAsync(async (req, res) => {
  const { category } = req.query;
  const cacheKey = `filters:${category || 'global'}`;

  const cached = await redis.get(cacheKey);
  if (cached) return res.json({ success: true, filters: JSON.parse(cached) });

  let query = db.collection('products');
  if (category) query = query.where('category', '==', category);

  const snapshot = await query.limit(1000).get();
  const subcategories = new Set();
  const states = new Set();
  const brands = new Set();

  snapshot.forEach(doc => {
    const p = doc.data();
    if (p.subcategory) subcategories.add(p.subcategory);
    if (p.location?.state) states.add(p.location.state);
    if (p.brand) brands.add(p.brand);
  });

  const filters = {
    subcategories: Array.from(subcategories).sort(),
    states: Array.from(states).sort(),
    brands: Array.from(brands).sort()
  };

  await redis.setEx(cacheKey, 3600, JSON.stringify(filters));
  res.json({ success: true, filters });
});

exports.getForYouFeed = catchAsync(async (req, res) => {
  const userId = req.userId;
  const userProfile = req.userProfile; // Assumes middleware populates this
  const interests = userProfile?.interests || [];
  const userState = userProfile?.location?.state;

  let products = [];
  if (interests.length > 0) {
    const interestSnapshot = await db.collection('products')
      .where('category', 'in', interests.slice(0, 10))
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    products = interestSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), isRecommendation: true }));
  }

  const discoverySnapshot = await db.collection('products')
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  const discoveryItems = discoverySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const finalFeed = [...products, ...discoveryItems];
  const uniqueFeed = finalFeed.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);

  // local state weighting
  const weightedFeed = uniqueFeed.sort((a, b) => {
    if (a.location?.state === userState && b.location?.state !== userState) return -1;
    if (b.location?.state === userState && a.location?.state !== userState) return 1;
    return 0;
  });

  res.json({ success: true, products: weightedFeed });
});