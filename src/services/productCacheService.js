// services/productCacheService.js - PRODUCTION OPTIMIZED
const { getCache, setCache, deleteCache, deleteCachePattern, CACHE_KEYS, CACHE_TTL } = require('../config/redis');
const { db } = require('../config/firebase');
const cdnService = require('./cdn.service');

/**
 * PRODUCT CACHE SERVICE
 * Multi-layer caching with CDN optimization
 * Redis → Firebase → CDN
 */

class ProductCacheService {
  /**
   * Get product with multi-layer caching
   * Layer 1: Redis Cache (fastest)
   * Layer 2: Firebase (fallback)
   * Layer 3: CDN optimization for images
   */
  async getProduct(productId) {
    try {
      // Layer 1: Try Redis cache
      const cacheKey = CACHE_KEYS.PRODUCT(productId);
      const cached = await getCache(cacheKey);
      
      if (cached) {
        console.log(`✅ Cache HIT: Product ${productId}`);
        // Optimize image URLs on return
        return this.optimizeProductImages(cached);
      }

      console.log(`⚠️ Cache MISS: Product ${productId}`);
      
      // Layer 2: Fetch from Firebase
      const productDoc = await db.collection('products').doc(productId).get();
      
      if (!productDoc.exists) {
        return null;
      }

      const product = { id: productDoc.id, ...productDoc.data() };
      
      // Cache for 30 minutes
      await setCache(cacheKey, product, CACHE_TTL.MEDIUM);
      
      return this.optimizeProductImages(product);
    } catch (error) {
      console.error('Get product error:', error);
      throw error;
    }
  }

  /**
   * Get products by category with caching
   */
  async getProductsByCategory(category, page = 1, limit = 20) {
    try {
      const cacheKey = `${CACHE_KEYS.PRODUCTS_CATEGORY(category)}:page:${page}`;
      const cached = await getCache(cacheKey);
      
      if (cached) {
        console.log(`✅ Cache HIT: Category ${category} page ${page}`);
        return {
          products: cached.products.map(p => this.optimizeProductImages(p)),
          hasMore: cached.hasMore
        };
      }

      console.log(`⚠️ Cache MISS: Category ${category} page ${page}`);
      
      // Fetch from Firebase
      const snapshot = await db.collection('products')
        .where('category', '==', category)
        .orderBy('createdAt', 'desc')
        .limit(limit + 1)
        .get();

      const products = [];
      snapshot.docs.slice(0, limit).forEach(doc => {
        products.push({ id: doc.id, ...doc.data() });
      });

      const hasMore = snapshot.docs.length > limit;
      
      const result = { products, hasMore };
      
      // Cache for 10 minutes (shorter for category lists)
      await setCache(cacheKey, result, CACHE_TTL.SHORT);
      
      return {
        products: products.map(p => this.optimizeProductImages(p)),
        hasMore
      };
    } catch (error) {
      console.error('Get products by category error:', error);
      throw error;
    }
  }

  /**
   * Get products by seller with caching
   */
  async getProductsBySeller(sellerId, page = 1, limit = 20) {
    try {
      const cacheKey = `${CACHE_KEYS.PRODUCTS_SELLER(sellerId)}:page:${page}`;
      const cached = await getCache(cacheKey);
      
      if (cached) {
        console.log(`✅ Cache HIT: Seller ${sellerId} page ${page}`);
        return {
          products: cached.products.map(p => this.optimizeProductImages(p)),
          hasMore: cached.hasMore
        };
      }

      console.log(`⚠️ Cache MISS: Seller ${sellerId} page ${page}`);
      
      // Fetch from Firebase
      const snapshot = await db.collection('products')
        .where('sellerId', '==', sellerId)
        .orderBy('createdAt', 'desc')
        .limit(limit + 1)
        .get();

      const products = [];
      snapshot.docs.slice(0, limit).forEach(doc => {
        products.push({ id: doc.id, ...doc.data() });
      });

      const hasMore = snapshot.docs.length > limit;
      
      const result = { products, hasMore };
      
      // Cache for 5 minutes
      await setCache(cacheKey, result, CACHE_TTL.SHORT);
      
      return {
        products: products.map(p => this.optimizeProductImages(p)),
        hasMore
      };
    } catch (error) {
      console.error('Get products by seller error:', error);
      throw error;
    }
  }

  /**
   * Optimize product images with CDN transformations
   */
  optimizeProductImages(product) {
    if (!product) return product;

    const optimized = { ...product };

    // Optimize main image URLs
    if (Array.isArray(optimized.imageUrls)) {
      optimized.imageUrls = optimized.imageUrls.map(url => 
        cdnService.optimizeUrl(url, { width: 800, height: 800, crop: 'fit' })
      );
      
      // Add responsive variants
      optimized.imageVariants = cdnService.getResponsiveVariants(optimized.imageUrls[0]);
    } else if (typeof optimized.imageUrls === 'string') {
      optimized.imageUrls = cdnService.optimizeUrl(optimized.imageUrls, { 
        width: 800, 
        height: 800, 
        crop: 'fit' 
      });
      optimized.imageVariants = cdnService.getResponsiveVariants(optimized.imageUrls);
    }

    return optimized;
  }

  /**
   * Search products with caching
   */
  async searchProducts(query, filters = {}) {
    try {
      const searchKey = `search:${query}:${JSON.stringify(filters)}`;
      const cacheKey = `cache:${searchKey}`;
      
      const cached = await getCache(cacheKey);
      
      if (cached) {
        console.log(`✅ Cache HIT: Search "${query}"`);
        return cached.map(p => this.optimizeProductImages(p));
      }

      console.log(`⚠️ Cache MISS: Search "${query}"`);
      
      // Fetch all products (in production, use Algolia/Elasticsearch)
      let productsQuery = db.collection('products');
      
      // Apply filters
      if (filters.category) {
        productsQuery = productsQuery.where('category', '==', filters.category);
      }
      
      if (filters.minPrice) {
        productsQuery = productsQuery.where('price', '>=', parseFloat(filters.minPrice));
      }
      
      if (filters.maxPrice) {
        productsQuery = productsQuery.where('price', '<=', parseFloat(filters.maxPrice));
      }

      const snapshot = await productsQuery.limit(100).get();
      
      let products = [];
      snapshot.forEach(doc => {
        products.push({ id: doc.id, ...doc.data() });
      });

      // Client-side search (for demo - use search service in production)
      if (query) {
        const searchLower = query.toLowerCase();
        products = products.filter(p => 
          p.name?.toLowerCase().includes(searchLower) ||
          p.description?.toLowerCase().includes(searchLower) ||
          p.brand?.toLowerCase().includes(searchLower)
        );
      }

      // Cache search results for 5 minutes
      await setCache(cacheKey, products, CACHE_TTL.SHORT);
      
      return products.map(p => this.optimizeProductImages(p));
    } catch (error) {
      console.error('Search products error:', error);
      throw error;
    }
  }

  /**
   * Invalidate product caches
   */
  async invalidateProduct(productId, category, sellerId) {
    try {
      const promises = [
        deleteCache(CACHE_KEYS.PRODUCT(productId)),
        deleteCachePattern(`${CACHE_KEYS.PRODUCTS_CATEGORY(category)}*`),
        deleteCachePattern(`${CACHE_KEYS.PRODUCTS_SELLER(sellerId)}*`),
        deleteCachePattern('cache:search:*') // Invalidate all search caches
      ];

      await Promise.all(promises);
      console.log(`🗑️ Invalidated caches for product ${productId}`);
    } catch (error) {
      console.error('Cache invalidation error:', error);
    }
  }

  /**
   * Warm cache for popular products
   */
  async warmCache(productIds) {
    try {
      console.log('🔥 Warming cache for products:', productIds);
      
      const promises = productIds.map(async (productId) => {
        const productDoc = await db.collection('products').doc(productId).get();
        if (productDoc.exists) {
          const product = { id: productDoc.id, ...productDoc.data() };
          await setCache(
            CACHE_KEYS.PRODUCT(productId), 
            product, 
            CACHE_TTL.LONG
          );
        }
      });

      await Promise.all(promises);
      console.log('✅ Cache warming complete');
    } catch (error) {
      console.error('Cache warming error:', error);
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    // This would require Redis INFO command access
    // For now, return basic stats
    return {
      enabled: true,
      type: 'Redis',
      ttl: {
        product: CACHE_TTL.MEDIUM,
        category: CACHE_TTL.SHORT,
        search: CACHE_TTL.SHORT
      }
    };
  }
}

module.exports = new ProductCacheService();