const { db } = require('../config/firebase');
const { client: redis } = require('../config/redis');
const catchAsync = require('../utils/catchAsync');
const productCacheService = require('../services/productCacheService');
const AppError = require('../utils/AppError');

// --- 1. Discovery Methods (High Performance) ---

exports.getProducts = catchAsync(async (req, res, next) => {
  const { category, state, search } = req.query;
  
  // If searching, we use the search service logic
  if (search) {
    const products = await productCacheService.searchProducts(search, { category, state });
    return res.json({ success: true, products });
  }

  const cacheKey = `products:${category || 'all'}:${state || 'global'}`;
  const cachedData = await redis.get(cacheKey);
  
  if (cachedData) {
    return res.status(200).json({ success: true, source: 'cache', products: JSON.parse(cachedData) });
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

exports.getProduct = catchAsync(async (req, res, next) => {
  const product = await productCacheService.getProduct(req.params.id);
  if (!product) return next(new AppError('Product not found', 404));
  
  res.json({ success: true, product });
});

// --- 2. Merchant Methods (CRUD) ---

/**
 * ✅ BEST PRACTICE: Ownership & Data Integrity
 */
exports.createProduct = catchAsync(async (req, res, next) => {
  const { name, price, category, imageUrls, stock, location, discount } = req.body;

  // 1. Validation Logic (Moved to backend to prevent junk data)
  if (!name || price <= 0 || !category || !imageUrls?.length) {
    return next(new AppError('Invalid product data. Check price and images.', 400));
  }

  const productData = {
    name: name.trim(),
    description: req.body.description || '',
    price: Number(price),
    discount: Number(discount || 0),
    category,
    subcategory: req.body.subcategory || null,
    imageUrls,
    stock: Math.max(0, Number(stock)),
    location,
    brand: req.body.brand?.trim() || null,
    sellerId: req.userId, // 🛡️ Force identification from Auth token
    sellerBusinessName: req.userProfile.businessName || req.userProfile.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isFeatured: false,
    status: 'active' // Add status for soft-deletes or admin moderation
  };

  const docRef = await db.collection('products').add(productData);
  await docRef.update({ id: docRef.id });

  // 🔄 Backend-First: Background cache invalidation
  // We don't await this so the response is faster for the user
  productCacheService.invalidateProduct(docRef.id, category, req.userId).catch(console.error);

  res.status(201).json({ 
    success: true, 
    product: { id: docRef.id, ...productData } 
  });
});

exports.updateProduct = catchAsync(async (req, res, next) => {
  const productRef = db.collection('products').doc(req.params.id);
  const doc = await productRef.get();

  if (!doc.exists) return next(new AppError('Product not found', 404));
  if (doc.data().sellerId !== req.userId && req.user.role !== 'admin') {
    return next(new AppError('Unauthorized', 403));
  }

  const updates = { ...req.body, updatedAt: Date.now() };
  await productRef.update(updates);

  // Invalidate cache
  await productCacheService.invalidateProduct(req.params.id, doc.data().category, req.userId);

  res.json({ success: true, message: 'Updated successfully' });
});


/**
 * ✅ BEST PRACTICE: Authorization Guard
 */
exports.updateProduct = catchAsync(async (req, res, next) => {
  const productRef = db.collection('products').doc(req.params.id);
  const doc = await productRef.get();

  if (!doc.exists) return next(new AppError('Product not found', 404));
  
  // 🛡️ SECURITY: Verify Ownership
  const isOwner = doc.data().sellerId === req.userId;
  const isAdmin = req.user.role === 'admin';
  
  if (!isOwner && !isAdmin) {
    return next(new AppError('Unauthorized: You do not own this product', 403));
  }

  // 🧹 SANITIZATION: Prevent user from changing sellerId via update
  const { sellerId, createdAt, ...updates } = req.body;
  updates.updatedAt = Date.now();

  await productRef.update(updates);

  await productCacheService.invalidateProduct(req.params.id, doc.data().category, req.userId);

  res.json({ success: true, message: 'Product updated successfully' });
});


exports.deleteProduct = catchAsync(async (req, res, next) => {
  const productRef = db.collection('products').doc(req.params.id);
  const doc = await productRef.get();

  if (!doc.exists) return next(new AppError('Product not found', 404));
  
  // 🛡️ SECURITY: Verify Ownership
  if (doc.data().sellerId !== req.userId && req.user.role !== 'admin') {
    return next(new AppError('Forbidden: Cannot delete items you do not own', 403));
  }

  await productRef.delete();
  
  // 🔥 Wipe from cache immediately
  await productCacheService.invalidateProduct(req.params.id, doc.data().category, req.userId);

  res.json({ success: true, message: 'Product deleted permanently' });
});

// --- 3. Specialized Feeds ---

exports.getProductsBySeller = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const result = await productCacheService.getProductsBySeller(req.params.sellerId, parseInt(page), parseInt(limit));
  res.json({ success: true, ...result });
});

exports.getSmartFilters = catchAsync(async (req, res) => {
  const { category } = req.query;
  const cacheKey = `filters:${category || 'global'}`;
  const cached = await redis.get(cacheKey);
  if (cached) return res.json({ success: true, filters: JSON.parse(cached) });

  const snapshot = await db.collection('products').where('category', '==', category).limit(1000).get();
  const subcategories = new Set(), states = new Set(), brands = new Set();

  snapshot.forEach(doc => {
    const p = doc.data();
    if (p.subcategory) subcategories.add(p.subcategory);
    if (p.location?.state) states.add(p.location.state);
    if (p.brand) brands.add(p.brand);
  });

  const filters = { subcategories: [...subcategories].sort(), states: [...states].sort(), brands: [...brands].sort() };
  await redis.setEx(cacheKey, 3600, JSON.stringify(filters));
  res.json({ success: true, filters });
});

exports.getForYouFeed = catchAsync(async (req, res) => {
  const interests = req.userProfile?.interests || [];
  const userState = req.userProfile?.location?.state;

  let products = [];
  if (interests.length > 0) {
    const snap = await db.collection('products').where('category', 'in', interests.slice(0, 10)).limit(20).get();
    products = snap.docs.map(d => ({ id: d.id, ...d.data(), isRecommendation: true }));
  }

  const discSnap = await db.collection('products').orderBy('createdAt', 'desc').limit(20).get();
  const discItems = discSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const uniqueFeed = [...products, ...discItems].filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
  uniqueFeed.sort((a, b) => (a.location?.state === userState ? -1 : 1));

  res.json({ success: true, products: uniqueFeed });
});

exports.warmCache = catchAsync(async (req, res) => {
  await productCacheService.warmCache(req.body.productIds);
  res.json({ success: true, message: 'Cache warmed' });
});