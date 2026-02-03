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
     * ✅ Submit seller review (Production Grade)
     * Fixed: Lifetime average rating math
     * Fixed: Automated counters
     */
    
    async submitSellerReview(sellerId, buyerId, orderId, buyerName, rating, comment) {
        const lockKey = `seller_review:lock:${orderId}:${buyerId}`;

        try {
        // 1️⃣ Security & Validity Checks
        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (!orderDoc.exists) throw new Error('Order not found');

        const order = orderDoc.data();
        if (order.buyerId !== buyerId) throw new Error('Unauthorized');
        if (order.sellerId !== sellerId) throw new Error('Seller mismatch');
        if (order.status !== 'delivered') throw new Error('You can only review delivered orders');
        if (order.hasSellerReview) throw new Error('This order has already been reviewed');
        
        // --- 🛠️ MODIFIED BLOCK ---
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        
        // Use a fallback: if deliveredAt isn't populated yet, use updatedAt or current time
        // This ensures "immediate" reviews don't fail if the timestamp is still null
        const deliveryTime = order.deliveredAt ? 
            (order.deliveredAt._seconds ? order.deliveredAt._seconds * 1000 : order.deliveredAt) : 
            (order.updatedAt || Date.now());

        const timeElapsed = Date.now() - deliveryTime;

        if (timeElapsed > thirtyDays) {
            throw new Error('Review window has expired (30 days limit)');
        }
        
        // Optional: Block reviews that are "too fresh" only if you suspect clock skew, 
        // but generally, allow if timeElapsed is >= 0.
        if (timeElapsed < -60000) { // Allow for 1 min clock skew
             throw new Error('Invalid delivery timestamp');
        }
        // --- 🛠️ END MODIFIED BLOCK ---

        // 2️⃣ Concurrency Lock
        const isLocked = await client.get(lockKey);
        if (isLocked) throw new Error('Processing review, please wait...');
        await client.setEx(lockKey, 30, 'processing');

            const sellerRef = db.collection('users').doc(sellerId);
            const reviewsCol = db.collection('seller_reviews');

            // 3️⃣ Atomic Transaction
            const result = await db.runTransaction(async (transaction) => {
                const sellerDoc = await transaction.get(sellerRef);
                if (!sellerDoc.exists) throw new Error('Seller not found');

                const sellerData = sellerDoc.data();
                
                // Calculate Lifetime cumulative average
                const oldTotalSum = sellerData.totalRatingSum || 0;
                const oldTotalCount = sellerData.totalReviews || 0;
                const newTotalSum = oldTotalSum + rating;
                const newTotalCount = oldTotalCount + 1;
                const globalAverage = parseFloat((newTotalSum / newTotalCount).toFixed(1));

                // Create Review
                const newReviewRef = reviewsCol.doc();
                transaction.set(newReviewRef, {
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
                });

                // Update Order
                transaction.update(db.collection('orders').doc(orderId), {
                    hasSellerReview: true,
                    reviewedAt: Date.now(),
                });

                // Update Seller Profile
                transaction.update(sellerRef, {
                    rating: globalAverage,
                    totalRatingSum: admin.firestore.FieldValue.increment(rating),
                    totalReviews: admin.firestore.FieldValue.increment(1),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                return { reviewId: newReviewRef.id, globalAverage };
            });

            // 4️⃣ Cleanup & Invalidation
            await Promise.all([
                client.setEx(CACHE_KEYS.REVIEW_CHECK(buyerId, sellerId, orderId), 86400 * 30, 'true'),
                this._invalidateSellerCache(sellerId),
                client.del(lockKey)
            ]);

            return result;
        } catch (error) {
            await client.del(lockKey);
            throw error;
        }
    }

    /**
     * ✅ Toggle Seller Follow with Atomic Counter
     */
    async toggleFollowSeller(userId, sellerId, action = 'follow') {
        const followRef = db.collection('seller_followers').doc(`${userId}_${sellerId}`);
        const sellerRef = db.collection('users').doc(sellerId);
        const userRef = db.collection('users').doc(userId);

        await db.runTransaction(async (transaction) => {
            const followDoc = await transaction.get(followRef);

            if (action === 'follow') {
                if (followDoc.exists()) return; // Already following
                transaction.set(followRef, { userId, sellerId, createdAt: Date.now() });
                transaction.update(sellerRef, { followerCount: admin.firestore.FieldValue.increment(1) });
                transaction.update(userRef, { favoriteProviders: admin.firestore.FieldValue.arrayUnion(sellerId) });
            } else {
                if (!followDoc.exists()) return; // Not following
                transaction.delete(followRef);
                transaction.update(sellerRef, { followerCount: admin.firestore.FieldValue.increment(-1) });
                transaction.update(userRef, { favoriteProviders: admin.firestore.FieldValue.arrayUnion(sellerId) });
            }
        });

        await this._invalidateSellerCache(sellerId);
    }

    /**
     * ✅ Get Seller Stats
     */
    async getSellerStats(sellerId) {
        const cacheKey = CACHE_KEYS.SELLER_STATS(sellerId);
        const cached = await client.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const sellerDoc = await db.collection('users').doc(sellerId).get();
    
    // Use this pattern to be 100% safe
    const exists = typeof sellerDoc.exists === 'function' ? sellerDoc.exists() : sellerDoc.exists;
    
    if (!exists) {
        throw new Error('Seller not found');
    }
        
        const data = sellerDoc.data();
        const productsSnap = await db.collection('products')
            .where('sellerId', '==', sellerId)
            .count()
            .get();

        const stats = {
            businessName: data.businessName || data.name,
            imageUrl: data.imageUrl || null,
            rating: data.rating || 0,
            totalReviews: data.totalReviews || 0,
            followerCount: data.followerCount || 0,
            profileViews: data.profileViews || 0,
            totalProducts: productsSnap.data().count,
            memberSince: data.createdAt,
            isVerified: data.isVerified || false
        };

        await client.setEx(cacheKey, CACHE_TTL.STATS, JSON.stringify(stats));
        return stats;
    }
    /**
     * ✅ Get seller rating with counters
     */
    async getSellerRating(sellerId) { 
        const cacheKey = CACHE_KEYS.SELLER_RATING(sellerId);
        const cached = await client.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const sellerDoc = await db.collection('users').doc(sellerId).get();
        if (!sellerDoc.exists) throw new Error('Seller not found');
        
        const data = sellerDoc.data();
        const result = {
            rating: data.rating || 0,
            totalReviews: data.totalReviews || 0,
            reviewCount: data.reviewCount || 0
        };

        await client.setEx(cacheKey, CACHE_TTL.RATING, JSON.stringify(result));
        return result;
    }

    async trackView(sellerId) {
        await db.collection('users').doc(sellerId).update({
            profileViews: admin.firestore.FieldValue.increment(1)
        });
        await client.del(CACHE_KEYS.SELLER_STATS(sellerId));
    }

    async getSellerReviews(sellerId, limit = 10) {
        const cacheKey = `${CACHE_KEYS.SELLER_REVIEWS(sellerId)}:${limit}`;
        const cached = await client.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const snap = await db.collection('seller_reviews')
            .where('sellerId', '==', sellerId)
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();

        const reviews = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        await client.setEx(cacheKey, CACHE_TTL.REVIEWS, JSON.stringify(reviews));
        return reviews;
    }

    async _invalidateSellerCache(sellerId) {
        const keys = await client.keys(`*${sellerId}*`);
        if (keys.length > 0) await client.del(keys);
    }
}

module.exports = new SellerReviewService();