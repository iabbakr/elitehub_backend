const express = require('express');
const router = express.Router();
const { authenticate, sellerOrAdmin, optionalAuth } = require('../middleware/auth');
const { productCacheMiddleware, cacheMiddleware } = require('../middleware/cache');
const { db, queryDocuments, getDocument, updateDocument, deleteDocument } = require('../config/firebase');
const { invalidateProductCache, CACHE_TTL } = require('../config/redis');

/**
 * PRODUCT ROUTES
 * Marketplace product management
 */

/**
 * GET /api/v1/products
 * Get all products with optional filters (cached)
 */
router.get(
    '/',
    optionalAuth,
    productCacheMiddleware(CACHE_TTL.MEDIUM),
    async (req, res) => {
        try {
            const { category, search, minPrice, maxPrice, location, page = 1, limit = 20 } = req.query;

            let filters = [];

            if (category) {
                filters.push({ field: 'category', operator: '==', value: category });
            }

            if (location) {
                filters.push({ field: 'location.state', operator: '==', value: location });
            }

            let products = await queryDocuments('products', filters);

            // Filter by price range
            if (minPrice) {
                products = products.filter(p => p.price >= parseFloat(minPrice));
            }
            if (maxPrice) {
                products = products.filter(p => p.price <= parseFloat(maxPrice));
            }

            // Search filter
            if (search) {
                const searchLower = search.toLowerCase();
                products = products.filter(p => 
                    p.name.toLowerCase().includes(searchLower) ||
                    p.description?.toLowerCase().includes(searchLower)
                );
            }

            // Sort by newest first
            products.sort((a, b) => b.createdAt - a.createdAt);

            // Pagination
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
    }
);

/**
 * GET /api/v1/products/:id
 * Get single product by ID
 */
router.get(
    '/:id',
    optionalAuth,
    cacheMiddleware(CACHE_TTL.MEDIUM),
    async (req, res) => {
        try {
            const product = await getDocument('products', req.params.id);

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
    }
);

/**
 * GET /api/v1/products/seller/:sellerId
 * Get products by seller
 */
router.get(
    '/seller/:sellerId',
    optionalAuth,
    cacheMiddleware(CACHE_TTL.MEDIUM),
    async (req, res) => {
        try {
            const products = await queryDocuments('products', [
                { field: 'sellerId', operator: '==', value: req.params.sellerId }
            ]);

            products.sort((a, b) => b.createdAt - a.createdAt);

            res.json({
                success: true,
                products
            });
        } catch (error) {
            console.error('Get seller products error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch products'
            });
        }
    }
);

/**
 * POST /api/v1/products
 * Create new product
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

        // Get seller info
        const seller = await getDocument('users', req.userId);

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

        // Invalidate cache
        await invalidateProductCache(productRef.id, category, req.userId);

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
 * Update product
 */
router.put('/:id', authenticate, sellerOrAdmin, async (req, res) => {
    try {
        const product = await getDocument('products', req.params.id);

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

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

        await updateDocument('products', req.params.id, updates);

        // Invalidate cache
        await invalidateProductCache(req.params.id, product.category, product.sellerId);

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
 * Delete product
 */
router.delete('/:id', authenticate, sellerOrAdmin, async (req, res) => {
    try {
        const product = await getDocument('products', req.params.id);

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Check ownership
        if (product.sellerId !== req.userId && req.userProfile?.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to delete this product'
            });
        }

        await deleteDocument('products', req.params.id);

        // Invalidate cache
        await invalidateProductCache(req.params.id, product.category, product.sellerId);

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

module.exports = router;