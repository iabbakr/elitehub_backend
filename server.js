require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { connectRedis } = require('./src/config/redis');
const { db } = require('./src/config/firebase');
require('./src/jobs/orderCleanup');
// In server.js
require('./src/jobs/orderCleanup');
require('./src/jobs/keepAlive'); // Add this line

// Route Imports
const walletRoutes = require('./src/routes/wallet.routes');
const webhookRoutes = require('./src/routes/webhook.routes');
const uploadRoutes = require('./src/routes/upload.routes');
const userRoutes = require('./src/routes/user.routes');
const productRoutes = require('./src/routes/product.routes');
const orderRoutes = require('./src/routes/order.routes');
const billRoutes = require('./src/routes/bill.routes');
const  paymentRoutes = require('./src/routes/payment.routes');

const app = express();

origin: process.env.NODE_ENV === 'production' 
  ? ['https://elitehubng.com']
  : ['http://localhost:8081', 'http://192.168.100.142:8081', '*'], // Add the '*' temporarily to test

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
      scriptSrc: ["'self'"],
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS Configuration
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://elitehubng.com', 'https://www.elitehubng.com']
    : [
        'http://localhost:8081', 
        'http://192.168.100.142:8081', // Your machine's Local IP
        '*' 
      ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-cache']
}));

// Compression for responses
app.use(compression());

// In server.js (Place this ABOVE your global app.use(express.json()))
app.use(express.json({
  verify: (req, res, buf) => {
    // Only capture rawBody for paystack webhook path to save memory
    if (req.originalUrl.includes('webhooks/paystack')) {
      req.rawBody = buf;
    }
  }
}));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting (global)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', globalLimiter);

// Strict rate limiting for sensitive endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many attempts, please try again later'
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} [${duration}ms]`);
  });
  next();
});

// Health check route (no rate limit)
// Change from app.get('/health') to:
app.get('/api/v1/health', async (req, res) => {
  try {
    const { client } = require('./src/config/redis');
    // client.isReady is the most accurate check for "Green" status
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

// API Routes
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/upload', uploadRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/bills', billRoutes);
app.use('/api/v1/payments', paymentRoutes);

// 404 Handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;
  
  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// Initialize services
async function initializeApp() {
  console.log('🛠️  Initializing EliteHub Backend Services...');
  
  try {
    // Connect Redis
    await connectRedis();
    console.log('✅ Redis: Connected successfully');
    
    // Verify Firebase
    await db.collection('health_check').limit(1).get();
    console.log('✅ Firebase: Connected successfully');
    
    // Start server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 EliteHub API running on port ${PORT}`);
      console.log(`📡 Local Network Access: http://192.168.100.142:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('❌ Failed to initialize app:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  const { client } = require('./src/config/redis');
  await client.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  const { client } = require('./src/config/redis');
  await client.quit();
  process.exit(0);
});

initializeApp();

module.exports = app;