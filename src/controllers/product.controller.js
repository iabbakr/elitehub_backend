const { db } = require('../config/firebase');
const { client: redis } = require('../config/redis');
const catchAsync = require('../utils/catchAsync');
const productCacheService = require('../services/productCacheService');
const AppError = require('../utils/AppError');

// --- 1. Discovery Methods (High Performance) ---

exports.getProducts = catchAsync(async (req, res, next) => {
  const { category, state, search, limit: limitParam, lastCreatedAt } = req.query;

  // Clamp page size: default 20, max 50 per request
  const pageLimit = Math.min(parseInt(limitParam) || 20, 50);
  const isFirstPage = !lastCreatedAt;

  // ── Search path (no pagination needed — search returns a filtered set) ──
  if (search) {
    const products = await productCacheService.searchProducts(search, { category, state });
    return res.json({ success: true, products, hasMore: false, nextCursor: null });
  }

  // ── Cache only the first page ──────────────────────────────────────────
  const cacheKey = `products:${category || 'all'}:${state || 'global'}:p1`;

  if (isFirstPage) {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      return res.status(200).json({
        success: true,
        source: 'cache',
        ...JSON.parse(cachedData),
      });
    }
  }

  // ── Build Firestore query ──────────────────────────────────────────────
  let query = db.collection('products').orderBy('createdAt', 'desc');
  if (category) query = query.where('category', '==', category);
  if (state)    query = query.where('location.state', '==', state);

  // Cursor: skip everything older than the last item the client already has
  if (lastCreatedAt) {
    query = query.startAfter(parseInt(lastCreatedAt, 10));
  }

  // Fetch one extra doc so we can tell the client whether a next page exists
  const snapshot = await query.limit(pageLimit + 1).get();

  const hasMore  = snapshot.docs.length > pageLimit;
  const docs     = snapshot.docs.slice(0, pageLimit);
  const products = docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // The cursor the client must send on the next request
  const nextCursor = hasMore && products.length > 0
    ? products[products.length - 1].createdAt
    : null;

  const result = { products, hasMore, nextCursor };

  // Cache first page only
  if (isFirstPage && products.length > 0) {
    await redis.setEx(cacheKey, 600, JSON.stringify(result));
  }

  res.status(200).json({ success: true, source: 'database', ...result });
});

exports.getProduct = catchAsync(async (req, res, next) => {
  const product = await productCacheService.getProduct(req.params.id);
  if (!product) return next(new AppError('Product not found', 404));

  res.json({ success: true, product });
});

// --- 2. Merchant Methods (CRUD) ---

exports.createProduct = catchAsync(async (req, res, next) => {
  const { name, price, category, imageUrls, stock, location, discount } = req.body;

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
    sellerId: req.userId,
    sellerBusinessName: req.userProfile.businessName || req.userProfile.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isFeatured: false,
    status: 'active',
  };

  const docRef = await db.collection('products').add(productData);
  await docRef.update({ id: docRef.id });

  productCacheService
    .invalidateProduct(docRef.id, category, req.userId)
    .catch(console.error);

  res.status(201).json({ success: true, product: { id: docRef.id, ...productData } });
});

/**
 * ✅ BEST PRACTICE: Authorization Guard (single, definitive version)
 */
exports.updateProduct = catchAsync(async (req, res, next) => {
  const productRef = db.collection('products').doc(req.params.id);
  const doc = await productRef.get();

  if (!doc.exists) return next(new AppError('Product not found', 404));

  const isOwner = doc.data().sellerId === req.userId;
  const isAdmin = req.user.role === 'admin';

  if (!isOwner && !isAdmin) {
    return next(new AppError('Unauthorized: You do not own this product', 403));
  }

  // 🧹 Prevent user from overwriting immutable fields
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

  if (doc.data().sellerId !== req.userId && req.user.role !== 'admin') {
    return next(new AppError('Forbidden: Cannot delete items you do not own', 403));
  }

  await productRef.delete();
  await productCacheService.invalidateProduct(req.params.id, doc.data().category, req.userId);

  res.json({ success: true, message: 'Product deleted permanently' });
});

// --- 3. Specialized Feeds ---

exports.getProductsBySeller = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const result = await productCacheService.getProductsBySeller(
    req.params.sellerId,
    parseInt(page),
    parseInt(limit)
  );
  res.json({ success: true, ...result });
});

exports.getSmartFilters = catchAsync(async (req, res) => {
  const { category } = req.query;
  const cacheKey = `filters:${category || 'global'}`;
  const cached = await redis.get(cacheKey);
  if (cached) return res.json({ success: true, filters: JSON.parse(cached) });

  const snapshot = await db
    .collection('products')
    .where('category', '==', category)
    .limit(1000)
    .get();

  const subcategories = new Set();
  const states        = new Set();
  const brands        = new Set();

  snapshot.forEach(doc => {
    const p = doc.data();
    if (p.subcategory)     subcategories.add(p.subcategory);
    if (p.location?.state) states.add(p.location.state);
    if (p.brand)           brands.add(p.brand);
  });

  const filters = {
    subcategories: [...subcategories].sort(),
    states:        [...states].sort(),
    brands:        [...brands].sort(),
  };

  await redis.setEx(cacheKey, 3600, JSON.stringify(filters));
  res.json({ success: true, filters });
});

exports.getForYouFeed = catchAsync(async (req, res) => {
  const interests = req.userProfile?.interests || [];
  const userState = req.userProfile?.location?.state;

  let products = [];
  if (interests.length > 0) {
    const snap = await db
      .collection('products')
      .where('category', 'in', interests.slice(0, 10))
      .limit(20)
      .get();
    products = snap.docs.map(d => ({ id: d.id, ...d.data(), isRecommendation: true }));
  }

  const discSnap = await db
    .collection('products')
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  const discItems = discSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const uniqueFeed = [...products, ...discItems].filter(
    (v, i, a) => a.findIndex(t => t.id === v.id) === i
  );
  uniqueFeed.sort((a, b) => (a.location?.state === userState ? -1 : 1));

  res.json({ success: true, products: uniqueFeed });
});

exports.warmCache = catchAsync(async (req, res) => {
  await productCacheService.warmCache(req.body.productIds);
  res.json({ success: true, message: 'Cache warmed' });
});