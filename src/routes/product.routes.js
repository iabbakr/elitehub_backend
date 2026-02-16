// routes/product.routes.js - OFFLINE-FIRST OPTIMIZED
const express = require('express');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { authenticate, sellerOrAdmin, optionalAuth } = require('../middleware/auth');
const { cacheMiddleware } = require('../middleware/cache');
const rateLimit = require('express-rate-limit');

/**
 * 🛡️ Rate limiter for merchant actions
 */
const merchantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many product uploads, please try again later' }
});

/**
 * 📦 PRODUCT ROUTES - OFFLINE-FIRST OPTIMIZED
 */

// --- 1. Public / Discovery Routes ---

/**
 * @route   GET /api/v1/products
 * @desc    Get all products with search, category, and state filtering
 * @cache   10 minutes (with ETag support for 304 Not Modified)
 */
router.get(
  '/', 
  optionalAuth, 
  cacheMiddleware(600), // 10 minutes
  productController.getProducts
);

/**
 * @route   GET /api/v1/products/for-you
 * @desc    Personalized feed based on user interests
 * @cache   5 minutes
 */
router.get(
  '/for-you', 
  authenticate, 
  cacheMiddleware(300),
  productController.getForYouFeed
);

/**
 * @route   GET /api/v1/products/filters
 * @desc    Get smart facets (subcategories, states, brands)
 * @cache   1 hour
 */
router.get(
  '/filters', 
  cacheMiddleware(3600),
  productController.getSmartFilters
);

/**
 * @route   GET /api/v1/products/seller/:sellerId
 * @desc    Get all products belonging to a specific seller
 * @cache   5 minutes
 */
router.get(
  '/seller/:sellerId', 
  optionalAuth, 
  cacheMiddleware(300),
  productController.getProductsBySeller
);

/**
 * @route   GET /api/v1/products/:id
 * @desc    Get detailed info for a single product
 * @cache   30 minutes (with ETag)
 */
router.get(
  '/:id', 
  optionalAuth, 
  cacheMiddleware(1800),
  productController.getProduct
);

// --- 2. Merchant / Management Routes ---

/**
 * @route   POST /api/v1/products
 * @desc    Create a new product (Invalidates category & search caches)
 */
router.post(
  '/', 
  authenticate, 
  sellerOrAdmin, 
  merchantLimiter,
  productController.createProduct
);

/**
 * @route   PUT /api/v1/products/:id
 * @desc    Update product details (Invalidates specific product cache)
 */
router.put(
  '/:id', 
  authenticate, 
  sellerOrAdmin, 
  productController.updateProduct
);

/**
 * @route   DELETE /api/v1/products/:id
 * @desc    Remove a product (Invalidates all relevant caches)
 */
router.delete(
  '/:id', 
  authenticate, 
  sellerOrAdmin, 
  productController.deleteProduct
);

// --- 3. Admin / Maintenance Routes ---

/**
 * @route   POST /api/v1/products/warm-cache
 * @desc    Pre-cache popular products in Redis (Admin only)
 */
router.post(
  '/warm-cache', 
  authenticate, 
  sellerOrAdmin, 
  productController.warmCache
);

/**
 * @route   GET /api/v1/products/cache/stats
 * @desc    Get cache statistics (Admin only)
 */
router.get(
  '/cache/stats',
  authenticate,
  sellerOrAdmin,
  async (req, res) => {
    try {
      const productCacheService = require('../services/productCacheService');
      const stats = await productCacheService.getCacheStats();
      res.json({ success: true, stats });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to get cache stats' });
    }
  }
);

module.exports = router;