const express = require('express');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { authenticate, sellerOrAdmin, optionalAuth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// 🛡️ Rate limiter for merchant actions (e.g., 20 products per 15 mins)
const merchantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many product uploads, please try again later' }
});

/**
 * 📦 PRODUCT ROUTES - BACKEND-FIRST ARCHITECTURE
 * All routes leverage Redis caching and high-performance controller logic.
 */

// --- 1. Public / Discovery Routes ---

/**
 * @route   GET /api/v1/products
 * @desc    Get all products with search, category, and state filtering (Cached)
 */
router.get('/', optionalAuth, productController.getProducts);

/**
 * @route   GET /api/v1/products/for-you
 * @desc    Personalized feed based on user interests and state weighting
 */
router.get('/for-you', authenticate, productController.getForYouFeed);

/**
 * @route   GET /api/v1/products/filters
 * @desc    Get smart facets (subcategories, states, brands) for a category
 */
router.get('/filters', productController.getSmartFilters);

/**
 * @route   GET /api/v1/products/seller/:sellerId
 * @desc    Get all products belonging to a specific seller
 */
router.get('/seller/:sellerId', optionalAuth, productController.getProductsBySeller);

/**
 * @route   GET /api/v1/products/:id
 * @desc    Get detailed info for a single product
 */
router.get('/:id', optionalAuth, productController.getProduct);


// --- 2. Merchant / Management Routes ---

/**
 * @route   POST /api/v1/products
 * @desc    Create a new product (Invalidates category & search caches)
 */
router.post('/', authenticate, sellerOrAdmin, productController.createProduct);

/**
 * @route   PUT /api/v1/products/:id
 * @desc    Update product details (Invalidates specific product cache)
 */
router.put('/:id', authenticate, sellerOrAdmin, productController.updateProduct);

/**
 * @route   DELETE /api/v1/products/:id
 * @desc    Remove a product (Invalidates all relevant caches)
 */
router.delete('/:id', authenticate, sellerOrAdmin, productController.deleteProduct);


// --- 3. Admin / Maintenance Routes ---

/**
 * @route   POST /api/v1/products/warm-cache
 * @desc    Pre-cache popular products in Redis (Admin only)
 */
router.post('/warm-cache', authenticate, sellerOrAdmin, productController.warmCache);

module.exports = router;