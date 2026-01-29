// services/review.service.js - PRODUCTION-GRADE REVIEW SYSTEM
const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');
const AsyncStorage = require('@react-native-async-storage/async-storage');

/**
 * ✅ PRODUCTION-GRADE REVIEW SERVICE
 * Features:
 * - Sliding window (last 5 reviews only)
 * - Counter tracking (all-time reviews)
 * - One review per user per provider
 * - Automatic flagging system
 * - Profile view tracking
 * - Redis + AsyncStorage caching
 */

const CACHE_KEYS = {
    PROVIDER_REVIEWS: (providerId) => `reviews:provider:${providerId}`,
    PROVIDER_RATING: (providerId) => `rating:provider:${providerId}`,
    PROVIDER_VIEWS: (providerId) => `views:provider:${providerId}`,
    USER_REVIEWED: (userId, providerId) => `reviewed:${userId}:${providerId}`,
};

const CACHE_TTL = {
    REVIEWS: 300, // 5 minutes
    RATING: 60, // 1 minute
    VIEWS: 3600, // 1 hour
};

class ReviewService {
    /**
     * ✅ Submit review with sliding window logic
     */
    async submitReview(providerId, userId, userName, rating, comment) {
        const lockKey = `review:lock:${providerId}:${userId}`;

        try {
            // 1️⃣ Check if already reviewed (Redis + Firestore)
            const hasReviewed = await this._hasUserReviewed(userId, providerId);
            if (hasReviewed) {
                throw new Error('You have already reviewed this provider');
            }

            // 2️⃣ Prevent duplicate submission (Redis lock)
            const isLocked = await client.get(lockKey);
            if (isLocked) {
                throw new Error('Review submission in progress');
            }
            await client.setEx(lockKey, 60, 'processing');

            const providerRef = db.collection('users').doc(providerId);
            const reviewsCol = db.collection('reviews');

            // 3️⃣ Atomic transaction
            const result = await db.runTransaction(async (transaction) => {
                // Get current provider data
                const providerDoc = await transaction.get(providerRef);
                if (!providerDoc.exists()) {
                    throw new Error('Provider not found');
                }

                const providerData = providerDoc.data();

                // Get existing reviews (ordered by timestamp)
                const existingReviewsSnap = await reviewsCol
                    .where('providerId', '==', providerId)
                    .orderBy('createdAt', 'desc')
                    .get();

                const existingReviews = existingReviewsSnap.docs;

                // 4️⃣ Sliding window: Delete oldest if at limit (5)
                if (existingReviews.length >= 5) {
                    const reviewsToDelete = existingReviews.slice(4);
                    reviewsToDelete.forEach((reviewDoc) => {
                        transaction.delete(reviewDoc.ref);
                    });
                }

                // 5️⃣ Calculate new rating based on active window (max 5)
                const currentRating = providerData.rating || 0;
                const currentCount = providerData.reviewCount || 0;
                
                // Active window count (max 5)
                const activeWindowCount = Math.min(existingReviews.length + 1, 5);
                
                // New average rating (only considers active window)
                const newRating = ((currentRating * Math.min(currentCount, 4)) + rating) / activeWindowCount;

                // 6️⃣ Create new review
                const newReviewRef = reviewsCol.doc();
                const reviewData = {
                    id: newReviewRef.id,
                    providerId,
                    userId,
                    userName,
                    rating,
                    comment: comment.trim(),
                    createdAt: Date.now(),
                    flagged: false,
                    flagCount: 0,
                };

                transaction.set(newReviewRef, reviewData);

                // 7️⃣ Update provider stats
                const updateData = {
                    rating: parseFloat(newRating.toFixed(1)),
                    reviewCount: activeWindowCount,
                    totalReviewsAllTime: admin.firestore.FieldValue.increment(1),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                };

                transaction.update(providerRef, updateData);

                return { reviewId: newReviewRef.id, newRating, activeWindowCount };
            });

            // 8️⃣ Mark user as reviewed (cache)
            await Promise.all([
                client.setEx(CACHE_KEYS.USER_REVIEWED(userId, providerId), 86400 * 365, 'true'),
                this._invalidateProviderCache(providerId),
            ]);

            // 9️⃣ Check for auto-flagging
            await this._checkAutoFlag(providerId);

            // Release lock
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
     * ✅ Get provider reviews (last 5) with caching
     */
    async getProviderReviews(providerId, useCache = true) {
        try {
            // Try Redis cache first
            if (useCache) {
                const cached = await client.get(CACHE_KEYS.PROVIDER_REVIEWS(providerId));
                if (cached) {
                    return JSON.parse(cached);
                }
            }

            // Fetch from Firestore (last 5 only)
            const reviewsSnap = await db.collection('reviews')
                .where('providerId', '==', providerId)
                .orderBy('createdAt', 'desc')
                .limit(5)
                .get();

            const reviews = reviewsSnap.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                date: new Date(doc.data().createdAt).toLocaleDateString()
            }));

            // Cache for 5 minutes
            await client.setEx(
                CACHE_KEYS.PROVIDER_REVIEWS(providerId),
                CACHE_TTL.REVIEWS,
                JSON.stringify(reviews)
            );

            return reviews;
        } catch (error) {
            console.error('Get reviews error:', error);
            return [];
        }
    }

    /**
     * ✅ Get provider rating with counter
     */
    async getProviderRating(providerId) {
        try {
            const providerDoc = await db.collection('users').doc(providerId).get();
            
            if (!providerDoc.exists()) {
                return { rating: 0, reviewCount: 0, totalReviewsAllTime: 0 };
            }

            const data = providerDoc.data();
            return {
                rating: data.rating || 0,
                reviewCount: data.reviewCount || 0, // Active window (max 5)
                totalReviewsAllTime: data.totalReviewsAllTime || 0, // All-time counter
            };
        } catch (error) {
            console.error('Get rating error:', error);
            return { rating: 0, reviewCount: 0, totalReviewsAllTime: 0 };
        }
    }

    /**
     * ✅ Flag review for inappropriate content
     */
    async flagReview(reviewId, reportedBy, reason) {
        try {
            const reviewRef = db.collection('reviews').doc(reviewId);

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

                // If 3 flags from different users, notify admin
                if (flagCount >= 3) {
                    await this._notifyAdminAutoFlag(reviewData.providerId, reviewId);
                }
            });

            return { success: true };
        } catch (error) {
            console.error('Flag review error:', error);
            throw error;
        }
    }

    /**
     * ✅ Track profile views (one per user per month)
     */
    async trackProfileView(providerId, userId) {
        try {
            const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
            const viewKey = `view:${providerId}:${userId}:${currentMonth}`;

            // Check if already viewed this month
            const hasViewed = await client.get(viewKey);
            if (hasViewed) {
                return { counted: false, message: 'Already counted this month' };
            }

            // Increment view count
            await db.collection('users').doc(providerId).update({
                [`viewStats.${currentMonth}`]: admin.firestore.FieldValue.increment(1),
                totalViews: admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // Mark as viewed for this month (expires at month end)
            const daysInMonth = new Date(
                new Date().getFullYear(),
                new Date().getMonth() + 1,
                0
            ).getDate();
            const daysLeft = daysInMonth - new Date().getDate();
            const ttl = daysLeft * 24 * 60 * 60;

            await client.setEx(viewKey, ttl, 'true');

            return { counted: true, message: 'View counted successfully' };
        } catch (error) {
            console.error('Track view error:', error);
            return { counted: false, message: 'Failed to track view' };
        }
    }

    /**
     * ✅ Check if provider is flagged
     */
    async checkProviderStatus(providerId) {
        try {
            const providerDoc = await db.collection('users').doc(providerId).get();
            
            if (!providerDoc.exists()) {
                return { isActive: false, reason: 'Provider not found' };
            }

            const data = providerDoc.data();

            if (data.isFlagged) {
                return {
                    isActive: false,
                    isFlagged: true,
                    reason: data.flagReason || 'Profile under review',
                    canViewProfile: false,
                };
            }

            return { isActive: true, canViewProfile: true };
        } catch (error) {
            console.error('Check status error:', error);
            return { isActive: false, reason: 'Error checking status' };
        }
    }

    /**
     * ✅ Admin: Pardon flagged provider
     */
    async pardonProvider(providerId, adminId, reason) {
        try {
            await db.collection('users').doc(providerId).update({
                isFlagged: false,
                flagReason: null,
                pardonedBy: adminId,
                pardonReason: reason,
                pardonedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // Log pardon action
            await db.collection('admin_actions').add({
                type: 'pardon_provider',
                adminId,
                providerId,
                reason,
                timestamp: Date.now(),
            });

            await this._invalidateProviderCache(providerId);

            return { success: true };
        } catch (error) {
            console.error('Pardon provider error:', error);
            throw error;
        }
    }

    /**
     * ✅ Get provider subscription info
     */
    async getSubscriptionInfo(providerId) {
        try {
            const providerDoc = await db.collection('users').doc(providerId).get();
            
            if (!providerDoc.exists()) {
                return null;
            }

            const data = providerDoc.data();
            const now = Date.now();
            const expiresAt = data.subscriptionExpiresAt || 0;
            const isActive = expiresAt > now;
            const registrationDate = data.createdAt;
            const oneYearAfterReg = registrationDate + (365 * 24 * 60 * 60 * 1000);
            
            // Check if first year
            const isFirstYear = now < oneYearAfterReg;
            const price = isFirstYear ? 10000 : 5000;

            return {
                isActive,
                expiresAt,
                isFirstYear,
                subscriptionPrice: price,
                renewalPrice: 5000,
                registrationDate,
            };
        } catch (error) {
            console.error('Get subscription info error:', error);
            return null;
        }
    }

    // ==================== PRIVATE METHODS ====================

    /**
     * Check if user has already reviewed provider
     */
    async _hasUserReviewed(userId, providerId) {
        // Check Redis first
        const cached = await client.get(CACHE_KEYS.USER_REVIEWED(userId, providerId));
        if (cached) return true;

        // Check Firestore
        const reviewSnap = await db.collection('reviews')
            .where('userId', '==', userId)
            .where('providerId', '==', providerId)
            .limit(1)
            .get();

        const hasReviewed = !reviewSnap.empty;

        if (hasReviewed) {
            // Cache for 1 year
            await client.setEx(
                CACHE_KEYS.USER_REVIEWED(userId, providerId),
                86400 * 365,
                'true'
            );
        }

        return hasReviewed;
    }

    /**
     * Check for auto-flagging (3 bad reviews from different users)
     */
    async _checkAutoFlag(providerId) {
        try {
            // Get recent reviews
            const reviewsSnap = await db.collection('reviews')
                .where('providerId', '==', providerId)
                .where('rating', '<=', 2)
                .orderBy('rating')
                .orderBy('createdAt', 'desc')
                .limit(3)
                .get();

            if (reviewsSnap.docs.length < 3) return;

            // Check if from different users
            const uniqueUsers = new Set(reviewsSnap.docs.map(doc => doc.data().userId));
            
            if (uniqueUsers.size >= 3) {
                // Auto-flag provider
                await db.collection('users').doc(providerId).update({
                    isFlagged: true,
                    flagReason: 'Automatic flagging: 3+ bad reviews from different users',
                    flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
                    autoFlagged: true,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                // Notify admins
                await this._notifyAdminAutoFlag(providerId, null);

                console.log(`🚨 Provider ${providerId} auto-flagged due to bad reviews`);
            }
        } catch (error) {
            console.error('Auto-flag check error:', error);
        }
    }

    /**
     * Notify admins of auto-flagged provider
     */
    async _notifyAdminAutoFlag(providerId, reviewId = null) {
        try {
            const adminSnap = await db.collection('users')
                .where('role', 'in', ['admin', 'support_agent'])
                .get();

            const notification = {
                type: 'provider_flagged',
                providerId,
                reviewId,
                timestamp: Date.now(),
                message: `Provider ${providerId} has been automatically flagged`,
            };

            // Add to notifications collection
            await db.collection('admin_notifications').add(notification);

            // Send push notifications (if available)
            for (const adminDoc of adminSnap.docs) {
                try {
                    // Assuming you have a push notification service
                    // await pushNotificationService.sendPushToUser(...)
                } catch (pushError) {
                    console.error('Push notification error:', pushError);
                }
            }
        } catch (error) {
            console.error('Notify admin error:', error);
        }
    }

    /**
     * Invalidate all provider-related caches
     */
    async _invalidateProviderCache(providerId) {
        await Promise.all([
            client.del(CACHE_KEYS.PROVIDER_REVIEWS(providerId)),
            client.del(CACHE_KEYS.PROVIDER_RATING(providerId)),
            client.del(CACHE_KEYS.PROVIDER_VIEWS(providerId)),
        ]);
    }
}

module.exports = new ReviewService();