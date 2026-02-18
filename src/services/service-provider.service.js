// services/service-provider.service.js - PRODUCTION-GRADE BACKEND SERVICE
const { db, admin } = require('../config/firebase');
const { client } = require('../config/redis');
const pushNotificationService = require('./push-notification.service');
const reviewService = require('./review.service');

const SUBSCRIPTION_PLANS = {
    MONTHLY: { price: 2000, duration: 30, label: "Monthly - ₦2,000" },
    YEARLY: { price: 10000, duration: 365, label: "Yearly - ₦10,000" }
};

const CACHE_KEYS = {
    PROVIDER_LIST: (category, filters) => `providers:${category}:${JSON.stringify(filters)}`,
    PROVIDER_PROFILE: (providerId) => `provider:profile:${providerId}`,
    PROVIDER_REVIEWS: (providerId) => `provider:reviews:${providerId}`,
    SUBSCRIPTION_STATUS: (providerId) => `provider:subscription:${providerId}`,
};

const CACHE_TTL = {
    PROVIDER_LIST: 300,   // 5 minutes
    PROVIDER_PROFILE: 600, // 10 minutes
    REVIEWS: 180,          // 3 minutes
    SUBSCRIPTION: 60,      // 1 minute
};

class ServiceProviderService {
    /**
     * ✅ Get providers by category with caching
     */
    async getProvidersByCategory(category, filters = {}) {
        const cacheKey = CACHE_KEYS.PROVIDER_LIST(category, filters);

        try {
            const cached = await client.get(cacheKey);
            if (cached) {
                console.log('🚀 Cache HIT: providers list');
                return JSON.parse(cached);
            }

            let query = db.collection('users')
                .where('role', '==', 'service')
                .where('serviceCategory', '==', category)
                .where('hasCompletedBusinessProfile', '==', true);

            if (filters.state) {
                query = query.where('location.state', '==', filters.state);
            }
            if (filters.city) {
                query = query.where('location.city', '==', filters.city);
            }

            const snapshot = await query.get();
            const now = Date.now();

            let providers = snapshot.docs
                .map(doc => ({ uid: doc.id, ...doc.data() }))
                .filter(p => {
                    const isSubscribed = (p.subscriptionExpiresAt || 0) > now;
                    const isSelf = filters.currentUserId === p.uid;
                    return isSubscribed || isSelf;
                });

            providers = this._sortProviders(providers, filters.userFavorites || []);

            await client.setEx(cacheKey, CACHE_TTL.PROVIDER_LIST, JSON.stringify(providers));

            return providers;
        } catch (error) {
            console.error('Get providers error:', error);
            throw error;
        }
    }

    /**
     * ✅ Get provider profile with caching
     */
    async getProviderProfile(providerId, viewerId = null) {
        const cacheKey = CACHE_KEYS.PROVIDER_PROFILE(providerId);

        try {
            const cached = await client.get(cacheKey);
            if (cached) {
                const profile = JSON.parse(cached);

                if (viewerId && viewerId !== providerId) {
                    this._trackProfileView(providerId, viewerId);
                }

                return profile;
            }

            const providerDoc = await db.collection('users').doc(providerId).get();

            // ✅ FIX: .exists is a property in Admin SDK, not a method
            if (!providerDoc.exists) {
                throw new Error('Provider not found');
            }

            const profile = { uid: providerDoc.id, ...providerDoc.data() };

            delete profile.paystackRecipientCode;

            await client.setEx(cacheKey, CACHE_TTL.PROVIDER_PROFILE, JSON.stringify(profile));

            if (viewerId && viewerId !== providerId) {
                await this._trackProfileView(providerId, viewerId);
            }

            return profile;
        } catch (error) {
            console.error('Get provider profile error:', error);
            throw error;
        }
    }

    /**
     * ✅ Get provider reviews with caching
     */
    async getProviderReviews(providerId) {
        const cacheKey = CACHE_KEYS.PROVIDER_REVIEWS(providerId);

        try {
            const cached = await client.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            const reviews = await reviewService.getProviderReviews(providerId, false);

            await client.setEx(cacheKey, CACHE_TTL.REVIEWS, JSON.stringify(reviews));

            return reviews;
        } catch (error) {
            console.error('Get reviews error:', error);
            return [];
        }
    }

    /**
     * ✅ Subscribe provider (BACKEND-FIRST)
     */
    async subscribe(providerId, plan = 'MONTHLY') {
        const lockKey = `subscription:lock:${providerId}`;

        try {
            const isLocked = await client.get(lockKey);
            if (isLocked) {
                throw new Error('Subscription already processing');
            }

            await client.setEx(lockKey, 60, 'processing');

            const selectedPlan = SUBSCRIPTION_PLANS[plan];
            if (!selectedPlan) {
                throw new Error('Invalid subscription plan');
            }

            const providerRef = db.collection('users').doc(providerId);
            const walletRef = db.collection('wallets').doc(providerId);
            const txnRef = db.collection('transactions').doc(`sub_${Date.now()}_${providerId.slice(0, 4)}`);

            await db.runTransaction(async (transaction) => {
                const [providerSnap, walletSnap] = await Promise.all([
                    transaction.get(providerRef),
                    transaction.get(walletRef)
                ]);

                // ✅ FIX: .exists is a property in Admin SDK, not a method
                if (!providerSnap.exists) {
                    throw new Error('Provider not found');
                }

                const provider = providerSnap.data();
                const wallet = walletSnap.exists ? walletSnap.data() : { balance: 0 };

                if ((provider.profileCompletionPercentage || 0) < 70) {
                    throw new Error('Profile must be at least 70% complete');
                }

                if ((wallet.balance || 0) < selectedPlan.price) {
                    throw new Error('Insufficient wallet balance');
                }

                const expiresAt = Date.now() + (selectedPlan.duration * 24 * 60 * 60 * 1000);

                transaction.update(providerRef, {
                    subscriptionExpiresAt: expiresAt,
                    subscriptionType: plan.toLowerCase(),
                    subscriptionPrice: selectedPlan.price,
                    lastSubscriptionDate: Date.now(),
                    updatedAt: Date.now()
                });

                transaction.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(-selectedPlan.price),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                transaction.set(txnRef, {
                    id: txnRef.id,
                    userId: providerId,
                    type: 'debit',
                    category: 'subscription',
                    amount: selectedPlan.price,
                    description: `Service Provider ${selectedPlan.label}`,
                    timestamp: Date.now(),
                    status: 'completed',
                    metadata: {
                        plan,
                        expiresAt,
                        reference: txnRef.id
                    }
                });
            });

            await this._invalidateProviderCache(providerId);
            await client.del(lockKey);

            await pushNotificationService.sendPushToUser(
                providerId,
                "✅ Subscription Active!",
                `Your ${selectedPlan.label} subscription is now active`,
                { screen: "ServiceProviderDashboard" }
            );

            return {
                success: true,
                message: 'Subscription activated successfully',
                expiresAt: Date.now() + (selectedPlan.duration * 24 * 60 * 60 * 1000)
            };
        } catch (error) {
            await client.del(lockKey);
            throw error;
        }
    }

    /**
     * ✅ Get subscription status with caching
     */
    async getSubscriptionStatus(providerId) {
        const cacheKey = CACHE_KEYS.SUBSCRIPTION_STATUS(providerId);

        try {
            const cached = await client.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            const providerDoc = await db.collection('users').doc(providerId).get();

            // ✅ FIX: .exists is a property in Admin SDK, not a method
            if (!providerDoc.exists) {
                throw new Error('Provider not found');
            }

            const provider = providerDoc.data();
            const expiresAt = provider.subscriptionExpiresAt || 0;
            const now = Date.now();
            const isSubscribed = expiresAt > now;

            const status = {
                isSubscribed,
                expiresAt,
                remainingDays: Math.ceil(Math.max(0, expiresAt - now) / 86400000),
                subscriptionType: provider.subscriptionType,
                profileCompletionPercentage: provider.profileCompletionPercentage || 0,
                plans: SUBSCRIPTION_PLANS
            };

            await client.setEx(cacheKey, CACHE_TTL.SUBSCRIPTION, JSON.stringify(status));

            return status;
        } catch (error) {
            console.error('Get subscription status error:', error);
            throw error;
        }
    }

    /**
     * ✅ Check and send expiry reminders
     */
    async checkExpiryReminders() {
        try {
            const threeDaysFromNow = Date.now() + (3 * 24 * 60 * 60 * 1000);

            const expiringSnapshot = await db.collection('users')
                .where('role', '==', 'service')
                .where('subscriptionExpiresAt', '<=', threeDaysFromNow)
                .where('subscriptionExpiresAt', '>', Date.now())
                .get();

            for (const doc of expiringSnapshot.docs) {
                const provider = doc.data();
                const daysLeft = Math.ceil((provider.subscriptionExpiresAt - Date.now()) / 86400000);

                if (daysLeft === 3 || daysLeft === 1) {
                    await pushNotificationService.sendPushToUser(
                        doc.id,
                        "⚠️ Subscription Expiring Soon",
                        `Your subscription expires in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`,
                        { screen: "ServiceProviderDashboard" }
                    );
                }
            }

            console.log(`✅ Checked ${expiringSnapshot.size} expiring subscriptions`);
        } catch (error) {
            console.error('Expiry reminder error:', error);
        }
    }

    /**
     * ✅ Send unsubscribed reminders
     */
    async sendUnsubscribedReminders() {
        try {
            const now = Date.now();
            const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

            const unsubscribedSnapshot = await db.collection('users')
                .where('role', '==', 'service')
                .where('subscriptionExpiresAt', '<', now)
                .where('lastSubscriptionDate', '<', sevenDaysAgo)
                .get();

            for (const doc of unsubscribedSnapshot.docs) {
                const lastNotified = await client.get(`reminder:sent:${doc.id}`);

                if (!lastNotified) {
                    await pushNotificationService.sendPushToUser(
                        doc.id,
                        "📢 Reactivate Your Profile",
                        "Subscribe now to start receiving client requests again!",
                        { screen: "ServiceProviderDashboard" }
                    );

                    await client.setEx(`reminder:sent:${doc.id}`, 604800, 'true');
                }
            }

            console.log(`✅ Sent reminders to ${unsubscribedSnapshot.size} unsubscribed providers`);
        } catch (error) {
            console.error('Unsubscribed reminder error:', error);
        }
    }

    /**
     * ✅ Track profile view
     */
    async _trackProfileView(providerId, viewerId) {
        try {
            const currentMonth = new Date().toISOString().slice(0, 7);
            const viewKey = `view:${providerId}:${viewerId}:${currentMonth}`;

            const hasViewed = await client.get(viewKey);
            if (hasViewed) return;

            await db.collection('users').doc(providerId).update({
                [`viewStats.${currentMonth}`]: admin.firestore.FieldValue.increment(1),
                totalViews: admin.firestore.FieldValue.increment(1),
                updatedAt: Date.now()
            });

            const daysInMonth = new Date(
                new Date().getFullYear(),
                new Date().getMonth() + 1,
                0
            ).getDate();
            const daysLeft = daysInMonth - new Date().getDate();
            const ttl = daysLeft * 24 * 60 * 60;

            await client.setEx(viewKey, ttl, 'true');

            await pushNotificationService.sendPushToUser(
                providerId,
                "👀 Profile View",
                "Someone viewed your profile!",
                { screen: "ServiceProviderDashboard" }
            );
        } catch (error) {
            console.error('Track view error:', error);
        }
    }

    /**
     * ✅ Sort providers
     */
    _sortProviders(providers, userFavorites = []) {
        return providers.sort((a, b) => {
            const aIsFav = userFavorites.includes(a.uid);
            const bIsFav = userFavorites.includes(b.uid);
            if (aIsFav && !bIsFav) return -1;
            if (!aIsFav && bIsFav) return 1;

            const aReviews = a.totalReviewsAllTime || 0;
            const bReviews = b.totalReviewsAllTime || 0;
            if (aReviews !== bReviews) return bReviews - aReviews;

            const aRating = a.rating || 0;
            const bRating = b.rating || 0;
            return bRating - aRating;
        });
    }

    /**
     * ✅ Invalidate all provider caches
     */
    async _invalidateProviderCache(providerId) {
        await Promise.all([
            client.del(CACHE_KEYS.PROVIDER_PROFILE(providerId)),
            client.del(CACHE_KEYS.PROVIDER_REVIEWS(providerId)),
            client.del(CACHE_KEYS.SUBSCRIPTION_STATUS(providerId)),
        ]);
    }
}

module.exports = new ServiceProviderService();