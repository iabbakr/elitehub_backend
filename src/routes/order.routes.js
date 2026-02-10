const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const orderController = require('../controllers/order.controller');

/**
 * ✅ PRODUCTION-GRADE ATOMIC ORDER SYSTEM
 * Features:
 * - Redis idempotency locks (prevents duplicate actions)
 * - Firestore transactions (atomic state changes)
 * - Real-time status validation (no stale data)
 * - Automatic cache invalidation
 */

// ==========================================
// 1. GET ROUTES (with caching)
// ==========================================

/**
 * GET /api/v1/orders
 * Get user's orders with multi-role support and Redis caching
 */
router.get('/', authenticate, orderController.getOrders);

/**
 * GET /api/v1/orders/:orderId
 * ✅ PRODUCTION GRADE: Allow Buyer, Seller, AND Staff (Admin/Support)
 */
router.get('/:orderId', authenticate, orderController.getOrder);

// ==========================================
// 2. ORDER CREATION (Atomic)
// ==========================================

/**
 * POST /api/v1/orders
 * ✅ ATOMIC ORDER CREATION with escrow lock
 */
router.post('/', authenticate, orderController.createOrder);

/**
 * POST /api/v1/orders/bundle
 * ✅ FIXED: ATOMIC BUNDLE ORDER CREATION
 * Creates multiple orders from a single cart atomically
 */
router.post('/bundle', authenticate, orderController.createBundleOrder);

// ==========================================
// 3. SELLER ACTIONS (Atomic)
// ==========================================

/**
 * PUT /api/v1/orders/:orderId/tracking
 * ✅ ATOMIC: Seller updates tracking status
 * 🔒 LOCKS buyer cancellation once acknowledged
 */
router.put('/:orderId/tracking', authenticate, orderController.updateTracking);

// ==========================================
// 4. BUYER ACTIONS (Atomic with Guards)
// ==========================================

/**
 * PUT /api/v1/orders/:orderId/cancel-buyer
 * ✅ ATOMIC: Buyer cancels order
 * 🔒 BLOCKED after seller acknowledgment
 */
router.put('/:orderId/cancel-buyer', authenticate, orderController.cancelOrderBuyer);

/**
 * PUT /api/v1/orders/:orderId/cancel-seller
 * ✅ ATOMIC: Seller cancels order (anytime during running)
 * ⚠️ Incurs strike system penalties
 */
router.put('/:orderId/cancel-seller', authenticate, orderController.cancelOrderSeller);

/**
 * PUT /api/v1/orders/:orderId/confirm-delivery
 * ✅ ATOMIC: Buyer confirms delivery
 * 🔒 Uses wallet.service.releaseEscrow with idempotency
 */
router.put('/:orderId/confirm-delivery', authenticate, orderController.confirmDelivery);

// ==========================================
// 5. ADMIN ROUTES
// ==========================================

/**
 * GET /api/v1/orders/admin/automation-stats
 * Get automation statistics
 */
router.get('/admin/automation-stats', authenticate, adminOnly, orderController.getAutomationStats);

/**
 * GET /api/v1/orders/admin/flagged-sellers
 * Get sellers with strikes
 */
router.get('/admin/flagged-sellers', authenticate, adminOnly, orderController.getFlaggedSellers);

/**
 * POST /api/v1/orders/admin/pardon-seller/:userId
 * Pardon a seller (reset strikes)
 */
router.post('/admin/pardon-seller/:userId', authenticate, adminOnly, orderController.pardonSeller);

/**
 * POST /api/v1/orders/admin/system/maintenance
 * Toggle maintenance mode
 */
router.post('/admin/system/maintenance', authenticate, adminOnly, orderController.toggleMaintenance);

module.exports = router;