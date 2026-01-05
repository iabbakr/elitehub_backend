const express = require('express');
const router = express.Router();
const { authenticate, sellerOrAdmin, optionalAuth } = require('../middleware/auth');
const { db } = require('../config/firebase');
const productCacheService = require('../services/productCacheService');

/**
 * OPTIMIZED PRODUCT ROUTES
 * With Redis caching and CDN optimization
 */

/**
 * GET /api/v1/products
 * Get all products with filters (cached + CDN optimized)
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, search, minPrice, maxPrice, page = 1, limit = 20 } = req.query;

    // If searching, use search method
    if (search) {
      const products = await productCacheService.searchProducts(search, {
        category,
        minPrice,
        maxPrice
      });

      return res.json({
        success: true,
        products,
        pagination: {
          total: products.length,
          page: 1,
          limit: products.length,
          totalPages: 1
        }
      });
    }

    // If filtering by category, use cached category method
    if (category) {
      const result = await productCacheService.getProductsByCategory(
        category,
        parseInt(page),
        parseInt(limit)
      );

      return res.json({
        success: true,
        products: result.products,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: result.hasMore
        }
      });
    }

    // Otherwise, get all products (with basic caching)
    const products = await productCacheService.searchProducts('', {
      minPrice,
      maxPrice
    });

    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedProducts = products.slice(startIndex, endIndex);

    res.json({
      success: true,
      products: paginatedProducts,
      pagination: {
        total: products.length,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(products.length / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products'
    });
  }
});

/**
 * GET /api/v1/products/:id
 * Get single product (cached + CDN optimized)
 */
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const product = await productCacheService.getProduct(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      product
    });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product'
    });
  }
});

/**
 * GET /api/v1/products/seller/:sellerId
 * Get products by seller (cached + paginated)
 */
router.get('/seller/:sellerId', optionalAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const result = await productCacheService.getProductsBySeller(
      req.params.sellerId,
      parseInt(page),
      parseInt(limit)
    );

    res.json({
      success: true,
      products: result.products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        hasMore: result.hasMore
      }
    });
  } catch (error) {
    console.error('Get seller products error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products'
    });
  }
});

/**
 * POST /api/v1/products
 * Create new product (invalidates cache)
 */
router.post('/', authenticate, sellerOrAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      category,
      subcategory,
      imageUrls,
      stock,
      location,
      discount,
      brand,
      weight,
      condition,
      colors,
      warranty
    } = req.body;

    // Validation
    if (!name || !price || !category || !imageUrls || !stock || !location) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Get seller info from cache or DB
    const sellerDoc = await db.collection('users').doc(req.userId).get();
    const seller = sellerDoc.data();

    const productData = {
      name: name.trim(),
      description: description?.trim() || '',
      price: parseFloat(price),
      category,
      subcategory: subcategory || null,
      imageUrls: Array.isArray(imageUrls) ? imageUrls : [imageUrls],
      sellerId: req.userId,
      sellerBusinessName: seller.businessName || seller.name,
      stock: parseInt(stock),
      location,
      discount: discount ? parseFloat(discount) : 0,
      brand: brand?.trim() || null,
      weight: weight?.trim() || null,
      condition: condition || 'Brand New',
      colors: colors || null,
      warranty: warranty || 'none',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const productRef = db.collection('products').doc();
    await productRef.set({ ...productData, id: productRef.id });

    // Invalidate relevant caches
    await productCacheService.invalidateProduct(
      productRef.id,
      category,
      req.userId
    );

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      productId: productRef.id,
      product: { ...productData, id: productRef.id }
    });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create product'
    });
  }
});

/**
 * PUT /api/v1/products/:id
 * Update product (invalidates cache)
 */
router.put('/:id', authenticate, sellerOrAdmin, async (req, res) => {
  try {
    const productDoc = await db.collection('products').doc(req.params.id).get();

    if (!productDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const product = productDoc.data();

    // Check ownership
    if (product.sellerId !== req.userId && req.userProfile?.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this product'
      });
    }

    const allowedFields = [
      'name', 'description', 'price', 'stock', 'subcategory',
      'imageUrls', 'discount', 'brand', 'weight', 'condition',
      'colors', 'warranty'
    ];

    const updates = {};
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    updates.updatedAt = Date.now();

    await db.collection('products').doc(req.params.id).update(updates);

    // Invalidate caches
    await productCacheService.invalidateProduct(
      req.params.id,
      product.category,
      product.sellerId
    );

    res.json({
      success: true,
      message: 'Product updated successfully'
    });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product'
    });
  }
});

/**
 * DELETE /api/v1/products/:id
 * Delete product (invalidates cache)
 */
router.delete('/:id', authenticate, sellerOrAdmin, async (req, res) => {
  try {
    const productDoc = await db.collection('products').doc(req.params.id).get();

    if (!productDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const product = productDoc.data();

    // Check ownership
    if (product.sellerId !== req.userId && req.userProfile?.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete this product'
      });
    }

    await db.collection('products').doc(req.params.id).delete();

    // Invalidate caches
    await productCacheService.invalidateProduct(
      req.params.id,
      product.category,
      product.sellerId
    );

    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete product'
    });
  }
});

/**
 * POST /api/v1/products/warm-cache
 * Admin endpoint to warm cache for popular products
 */
router.post('/warm-cache', authenticate, sellerOrAdmin, async (req, res) => {
  try {
    const { productIds } = req.body;

    if (!Array.isArray(productIds)) {
      return res.status(400).json({
        success: false,
        message: 'productIds must be an array'
      });
    }

    await productCacheService.warmCache(productIds);

    res.json({
      success: true,
      message: 'Cache warmed successfully',
      count: productIds.length
    });
  } catch (error) {
    console.error('Warm cache error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to warm cache'
    });
  }
});

module.exports = router;