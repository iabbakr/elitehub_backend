// services/seller-review.service.js - SELLER REVIEW SERVICE
const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');

const CACHE_KEYS = {
    SELLER_REVIEWS: (sellerId) => `seller_reviews:${sellerId}`,
    SELLER_RATING: (sellerId) => `seller_rating:${sellerId}`,
    SELLER_STATS: (sellerId) => `seller_stats:${sellerId}`,
    REVIEW_CHECK: (buyerId, sellerId, orderId) => `review_check:${buyerId}:${sellerId}:${orderId}`,
};

const CACHE_TTL = {
    REVIEWS: 300, // 5 minutes
    RATING: 60, // 1 minute
    STATS: 600, // 10 minutes
};

class SellerReviewService {
    /**
     * ✅ Submit seller review (linked to order)
     */
    async submitSellerReview(sellerId, buyerId, orderId, buyerName, rating, comment) {
        const lockKey = `seller_review:lock:${orderId}:${buyerId}`;

        try {
            // 1️⃣ Check if order exists and is delivered
            const orderDoc = await db.collection('orders').doc(orderId).get();
            
            if (!orderDoc.exists()) {
                throw new Error('Order not found');
            }

            const order = orderDoc.data();

            // Verify order belongs to this buyer and seller
            if (order.buyerId !== buyerId) {
                throw new Error('Unauthorized: This is not your order');
            }

            if (order.sellerId !== sellerId) {
                throw new Error('Seller mismatch');
            }

            // Only delivered orders can be reviewed
            if (order.status !== 'delivered') {
                throw new Error('Only delivered orders can be reviewed');
            }

            // 2️⃣ Check if already reviewed
            const hasReviewed = await this.hasReviewedOrder(buyerId, sellerId, orderId);
            if (hasReviewed) {
                throw new Error('You have already reviewed this seller for this order');
            }

            // 3️⃣ Prevent duplicate submission (Redis lock)
            const isLocked = await client.get(lockKey);
            if (isLocked) {
                throw new Error('Review submission in progress');
            }
            await client.setEx(lockKey, 60, 'processing');

            const sellerRef = db.collection('users').doc(sellerId);
            const reviewsCol = db.collection('seller_reviews');

            // 4️⃣ Atomic transaction
            const result = await db.runTransaction(async (transaction) => {
                const sellerDoc = await transaction.get(sellerRef);
                
                if (!sellerDoc.exists()) {
                    throw new Error('Seller not found');
                }

                const sellerData = sellerDoc.data();

                // Get existing reviews (for sliding window - last 10)
                const existingReviewsSnap = await reviewsCol
                    .where('sellerId', '==', sellerId)
                    .orderBy('createdAt', 'desc')
                    .get();

                const existingReviews = existingReviewsSnap.docs;

                // 5️⃣ Sliding window: Delete oldest if at limit (10)
                if (existingReviews.length >= 10) {
                    const reviewsToDelete = existingReviews.slice(9);
                    reviewsToDelete.forEach((reviewDoc) => {
                        transaction.delete(reviewDoc.ref);
                    });
                }

                // 6️⃣ Calculate new rating
                const currentRating = sellerData.rating || 0;
                const currentCount = sellerData.reviewCount || 0;
                const activeWindowCount = Math.min(existingReviews.length + 1, 10);
                const newRating = ((currentRating * Math.min(currentCount, 9)) + rating) / activeWindowCount;

                // 7️⃣ Create new review
                const newReviewRef = reviewsCol.doc();
                const reviewData = {
                    id: newReviewRef.id,
                    sellerId,
                    buyerId,
                    orderId,
                    buyerName,
                    rating,
                    comment: comment.trim(),
                    createdAt: Date.now(),
                    flagged: false,
                    flagCount: 0,
                };

                transaction.set(newReviewRef, reviewData);

                // 8️⃣ Update order to mark as reviewed
                transaction.update(db.collection('orders').doc(orderId), {
                    hasSellerReview: true,
                    reviewedAt: Date.now(),
                });

                // 9️⃣ Update seller stats
                const updateData = {
                    rating: parseFloat(newRating.toFixed(1)),
                    reviewCount: activeWindowCount,
                    totalReviews: admin.firestore.FieldValue.increment(1),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                };

                transaction.update(sellerRef, updateData);

                return { reviewId: newReviewRef.id, newRating, activeWindowCount };
            });

            // 🔟 Cache and cleanup
            await Promise.all([
                client.setEx(CACHE_KEYS.REVIEW_CHECK(buyerId, sellerId, orderId), 86400 * 365, 'true'),
                this._invalidateSellerCache(sellerId),
            ]);

            await client.del(lockKey);

            return {
                success: true,
                reviewId: result.reviewId,
                newRating: result.newRating,
                reviewCount: result.activeWindowCount,
            };
        } catch (error) {
            await client.del(lockKey);
            throw error;
        }
    }

    /**
     * ✅ Get seller reviews (last 10) with caching
     */
    async getSellerReviews(sellerId, limit = 10) {
        try {
            // Try Redis cache first
            const cacheKey = `${CACHE_KEYS.SELLER_REVIEWS(sellerId)}:${limit}`;
            const cached = await client.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            // Fetch from Firestore
            const reviewsSnap = await db.collection('seller_reviews')
                .where('sellerId', '==', sellerId)
                .orderBy('createdAt', 'desc')
                .limit(limit)
                .get();

            const reviews = reviewsSnap.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                date: new Date(doc.data().createdAt).toLocaleDateString()
            }));

            // Cache for 5 minutes
            await client.setEx(cacheKey, CACHE_TTL.REVIEWS, JSON.stringify(reviews));

            return reviews;
        } catch (error) {
            console.error('Get seller reviews error:', error);
            return [];
        }
    }

    /**
     * ✅ Get seller rating with counter
     */
    async getSellerRating(sellerId) {
        try {
            const sellerDoc = await db.collection('users').doc(sellerId).get();
            
            if (!sellerDoc.exists()) {
                return { rating: 0, reviewCount: 0, totalReviews: 0 };
            }

            const data = sellerDoc.data();
            return {
                rating: data.rating || 0,
                reviewCount: data.reviewCount || 0, // Active window (max 10)
                totalReviews: data.totalReviews || 0, // All-time counter
            };
        } catch (error) {
            console.error('Get seller rating error:', error);
            return { rating: 0, reviewCount: 0, totalReviews: 0 };
        }
    }

    /**
     * ✅ Get comprehensive seller statistics
     */
    async getSellerStats(sellerId) {
        try {
            // Try cache first
            const cached = await client.get(CACHE_KEYS.SELLER_STATS(sellerId));
            if (cached) {
                return JSON.parse(cached);
            }

            const [sellerDoc, productsSnap, ordersSnap] = await Promise.all([
                db.collection('users').doc(sellerId).get(),
                db.collection('products').where('sellerId', '==', sellerId).get(),
                db.collection('orders')
                    .where('sellerId', '==', sellerId)
                    .where('status', '==', 'delivered')
                    .get()
            ]);

            if (!sellerDoc.exists()) {
                throw new Error('Seller not found');
            }

            const sellerData = sellerDoc.data();
            const totalProducts = productsSnap.docs.length;
            const deliveredOrders = ordersSnap.docs;
            
            // Calculate total items sold
            const totalItemsSold = deliveredOrders.reduce((sum, doc) => {
                const order = doc.data();
                const itemCount = order.products.reduce((acc, item) => acc + item.quantity, 0);
                return sum + itemCount;
            }, 0);

            // Get categories
            const categories = sellerData.sellerCategories || [];

            const stats = {
                businessName: sellerData.businessName || sellerData.name,
                businessAddress: sellerData.businessAddress,
                rating: sellerData.rating || 0,
                reviewCount: sellerData.reviewCount || 0,
                totalReviews: sellerData.totalReviews || 0,
                totalProducts,
                totalItemsSold,
                categories,
                memberSince: sellerData.createdAt,
                imageUrl: sellerData.imageUrl || null,
            };

            // Cache for 10 minutes
            await client.setEx(CACHE_KEYS.SELLER_STATS(sellerId), CACHE_TTL.STATS, JSON.stringify(stats));

            return stats;
        } catch (error) {
            console.error('Get seller stats error:', error);
            throw error;
        }
    }

    /**
     * ✅ Check if buyer has reviewed this seller for this order
     */
    async hasReviewedOrder(buyerId, sellerId, orderId) {
        // Check Redis first
        const cached = await client.get(CACHE_KEYS.REVIEW_CHECK(buyerId, sellerId, orderId));
        if (cached) return true;

        // Check Firestore
        const reviewSnap = await db.collection('seller_reviews')
            .where('buyerId', '==', buyerId)
            .where('sellerId', '==', sellerId)
            .where('orderId', '==', orderId)
            .limit(1)
            .get();

        const hasReviewed = !reviewSnap.empty;

        if (hasReviewed) {
            // Cache for 1 year
            await client.setEx(
                CACHE_KEYS.REVIEW_CHECK(buyerId, sellerId, orderId),
                86400 * 365,
                'true'
            );
        }

        return hasReviewed;
    }

    /**
     * ✅ Flag review
     */
    async flagReview(reviewId, reportedBy, reason) {
        try {
            const reviewRef = db.collection('seller_reviews').doc(reviewId);

            await db.runTransaction(async (transaction) => {
                const reviewDoc = await transaction.get(reviewRef);
                
                if (!reviewDoc.exists()) {
                    throw new Error('Review not found');
                }

                const reviewData = reviewDoc.data();
                const flagCount = (reviewData.flagCount || 0) + 1;

                transaction.update(reviewRef, {
                    flagged: true,
                    flagCount,
                    flags: admin.firestore.FieldValue.arrayUnion({
                        reportedBy,
                        reason,
                        timestamp: Date.now(),
                    }),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            });

            return { success: true };
        } catch (error) {
            console.error('Flag review error:', error);
            throw error;
        }
    }

    /**
     * Invalidate all seller-related caches
     */
    async _invalidateSellerCache(sellerId) {
        const pattern = `seller_reviews:${sellerId}*`;
        const keys = await client.keys(pattern);
        
        if (keys.length > 0) {
            await client.del(keys);
        }

        await Promise.all([
            client.del(CACHE_KEYS.SELLER_RATING(sellerId)),
            client.del(CACHE_KEYS.SELLER_STATS(sellerId)),
        ]);
    }
}

module.exports = new SellerReviewService();