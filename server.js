require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { connectRedis } = require('./src/config/redis');
const { db } = require('./src/config/firebase');

// Background Jobs
require('./src/jobs/orderCleanup');
require('./src/jobs/keepAlive');

// Middleware Imports
const maintenanceGuard = require('./src/middleware/maintenance');

// Route Imports
const walletRoutes = require('./src/routes/wallet.routes');
const webhookRoutes = require('./src/routes/webhook.routes');
const uploadRoutes = require('./src/routes/upload.routes');
const userRoutes = require('./src/routes/user.routes');
const productRoutes = require('./src/routes/product.routes');
const orderRoutes = require('./src/routes/order.routes');
const billRoutes = require('./src/routes/bill.routes');
const paymentRoutes = require('./src/routes/payment.routes');
const sellerReviewRoutes = require('./src/routes/seller-review.routes');

const app = express();

// --- 1. Security & Performance Middleware ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
      connectSrc: ["'self'", "https://res.cloudinary.com", "https://api.paystack.co"],
      scriptSrc: ["'self'"],
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://elitehubng.com', 'https://www.elitehubng.com']
    : ['http://localhost:8081', 'http://192.168.100.142:8081', '*'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-cache']
}));

app.use(compression());

// --- 2. Rate Limiter Definitions ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Too many emails sent from this IP, please try again later'
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many attempts, please try again later'
});

// --- 3. Body Parsers & Request Handling ---
// IMPORTANT: Single body parser instance handles both JSON and Paystack rawBody
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    if (req.originalUrl.includes('webhooks/paystack')) {
      req.rawBody = buf;
    }
  }
}));

app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- 4. Custom Middleware Application ---
app.use(maintenanceGuard);

// Apply limiters to specific paths before the global /api/ limiter
app.use('/api/v1/users/welcome', emailLimiter);
app.use('/api/', globalLimiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} [${duration}ms]`);
  });
  next();
});

// --- 5. Health Check ---
app.get('/api/v1/health', async (req, res) => {
  try {
    const { client } = require('./src/config/redis');
    const redisHealthy = client.isOpen && client.isReady; 
    let firebaseHealthy = false;
    
    try {
      await db.collection('health_check').limit(1).get();
      firebaseHealthy = true;
    } catch (err) {
      console.error('Firebase health check failed:', err);
    }

    const status = redisHealthy && firebaseHealthy ? 'healthy' : 'degraded';
    
    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      timestamp: new Date().toISOString(),
      services: {
        redis: redisHealthy ? 'up' : 'down',
        firebase: firebaseHealthy ? 'up' : 'down'
      }
    });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message });
  }
});

// --- 6. API Routes ---
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/upload', uploadRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/bills', billRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/seller-reviews', sellerReviewRoutes);

// --- 7. Error Handling ---
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
  
  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// --- 8. Initialization & Shutdown ---
async function initializeApp() {
  console.log('🛠️  Initializing EliteHub Backend Services...');
  try {
    await connectRedis();
    console.log('✅ Redis: Connected successfully');
    
    await db.collection('health_check').limit(1).get();
    console.log('✅ Firebase: Connected successfully');
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 EliteHub API running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('❌ Failed to initialize app:', error);
    process.exit(1);
  }
}

const gracefulShutdown = async (signal) => {
  console.log(`${signal} received, shutting down gracefully...`);
  const { client } = require('./src/config/redis');
  if (client.isOpen) await client.quit();
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

initializeApp();

module.exports = app;