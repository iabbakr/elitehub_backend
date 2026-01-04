const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate, userRateLimit } = require('../middleware/auth');
const cdnService = require('../services/cdn.service');

// Configure multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        files: 5 // Max 5 files at once
    },
    fileFilter: (req, file, cb) => {
        // Allow only images and PDFs
        const allowedMimes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
            'application/pdf'
        ];

        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only images and PDFs are allowed'));
        }
    }
});

/**
 * GET /api/v1/upload/sign-params
 * Get signed parameters for client-side upload
 */
router.get('/sign-params', authenticate, (req, res) => {
    try {
        const folder = req.query.folder || 'elitehub';
        
        // Validate folder based on user permissions
        const allowedFolders = {
            products: ['seller', 'admin'],
            prescriptions: ['buyer', 'admin'],
            avatars: ['buyer', 'seller', 'service', 'admin'],
            portfolios: ['service', 'admin']
        };

        const userRole = req.user.role || 'buyer';
        
        if (allowedFolders[folder] && !allowedFolders[folder].includes(userRole)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to upload to this folder'
            });
        }

        const params = cdnService.getSignedUploadParams(folder, {
            tags: [`user_${req.userId}`]
        });

        res.json({
            success: true,
            params
        });
    } catch (error) {
        console.error('Sign params error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate upload parameters'
        });
    }
});

/**
 * POST /api/v1/upload/image
 * Server-side single image upload
 */
router.post(
    '/image',
    authenticate,
    userRateLimit(20, 15 * 60 * 1000), // 20 uploads per 15 minutes
    upload.single('image'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'No file provided'
                });
            }

            const folder = req.body.folder || 'elitehub';
            
            const result = await cdnService.uploadFile(req.file.buffer, {
                folder,
                public_id: `${folder}_${req.userId}_${Date.now()}`,
                tags: [`user_${req.userId}`]
            });

            res.json({
                success: true,
                url: result.secure_url,
                publicId: result.public_id,
                format: result.format,
                width: result.width,
                height: result.height
            });
        } catch (error) {
            console.error('Upload error:', error);
            res.status(500).json({
                success: false,
                message: 'Upload failed',
                error: error.message
            });
        }
    }
);

/**
 * POST /api/v1/upload/images
 * Server-side multiple images upload
 */
router.post(
    '/images',
    authenticate,
    userRateLimit(10, 15 * 60 * 1000), // 10 batch uploads per 15 minutes
    upload.array('images', 5), // Max 5 images
    async (req, res) => {
        try {
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No files provided'
                });
            }

            const folder = req.body.folder || 'elitehub';
            
            const uploadPromises = req.files.map((file, index) => 
                cdnService.uploadFile(file.buffer, {
                    folder,
                    public_id: `${folder}_${req.userId}_${Date.now()}_${index}`,
                    tags: [`user_${req.userId}`]
                })
            );

            const results = await Promise.all(uploadPromises);

            const urls = results.map(result => ({
                url: result.secure_url,
                publicId: result.public_id,
                format: result.format,
                width: result.width,
                height: result.height
            }));

            res.json({
                success: true,
                images: urls,
                count: urls.length
            });
        } catch (error) {
            console.error('Multiple upload error:', error);
            res.status(500).json({
                success: false,
                message: 'Upload failed',
                error: error.message
            });
        }
    }
);

/**
 * POST /api/v1/upload/product-image
 * Upload product image with automatic optimization
 */
router.post(
    '/product-image',
    authenticate,
    userRateLimit(30, 15 * 60 * 1000),
    upload.single('image'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'No file provided'
                });
            }

            const productId = req.body.productId || `temp_${Date.now()}`;
            
            const result = await cdnService.uploadProductImage(
                req.file.buffer,
                productId
            );

            // Generate responsive variants
            const variants = cdnService.getResponsiveVariants(result.secure_url);

            res.json({
                success: true,
                url: result.secure_url,
                publicId: result.public_id,
                variants
            });
        } catch (error) {
            console.error('Product image upload error:', error);
            res.status(500).json({
                success: false,
                message: 'Upload failed',
                error: error.message
            });
        }
    }
);

/**
 * POST /api/v1/upload/avatar
 * Upload user avatar
 */
router.post(
    '/avatar',
    authenticate,
    userRateLimit(5, 15 * 60 * 1000), // 5 avatar uploads per 15 minutes
    upload.single('avatar'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'No file provided'
                });
            }

            const result = await cdnService.uploadAvatar(
                req.file.buffer,
                req.userId
            );

            res.json({
                success: true,
                url: result.secure_url,
                publicId: result.public_id
            });
        } catch (error) {
            console.error('Avatar upload error:', error);
            res.status(500).json({
                success: false,
                message: 'Avatar upload failed',
                error: error.message
            });
        }
    }
);

/**
 * POST /api/v1/upload/prescription
 * Upload prescription document
 */
router.post(
    '/prescription',
    authenticate,
    userRateLimit(10, 15 * 60 * 1000),
    upload.single('prescription'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'No file provided'
                });
            }

            const productId = req.body.productId;
            
            if (!productId) {
                return res.status(400).json({
                    success: false,
                    message: 'Product ID is required'
                });
            }

            const result = await cdnService.uploadPrescription(
                req.file.buffer,
                req.userId,
                productId
            );

            res.json({
                success: true,
                url: result.secure_url,
                publicId: result.public_id,
                fileName: req.file.originalname
            });
        } catch (error) {
            console.error('Prescription upload error:', error);
            res.status(500).json({
                success: false,
                message: 'Prescription upload failed',
                error: error.message
            });
        }
    }
);

/**
 * DELETE /api/v1/upload/:publicId
 * Delete uploaded file
 */
router.delete('/:publicId', authenticate, async (req, res) => {
    try {
        const publicId = req.params.publicId.replace(/_/g, '/');
        
        // Verify ownership before deletion
        if (!publicId.includes(req.userId)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to delete this file'
            });
        }

        const result = await cdnService.deleteFile(publicId);

        res.json({
            success: result.success,
            message: result.success ? 'File deleted successfully' : 'File not found'
        });
    } catch (error) {
        console.error('Delete file error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete file',
            error: error.message
        });
    }
});

/**
 * POST /api/v1/upload/optimize-url
 * Get optimized version of existing URL
 */
router.post('/optimize-url', (req, res) => {
    try {
        const { url, width, height, crop } = req.body;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'URL is required'
            });
        }

        const optimizedUrl = cdnService.optimizeUrl(url, { width, height, crop });
        const variants = cdnService.getResponsiveVariants(url);

        res.json({
            success: true,
            optimizedUrl,
            variants
        });
    } catch (error) {
        console.error('Optimize URL error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to optimize URL'
        });
    }
});

// Error handler for multer errors
router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is 10MB'
            });
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
                success: false,
                message: 'Too many files. Maximum is 5 files'
            });
        }
    }
    
    res.status(400).json({
        success: false,
        message: error.message
    });
});

module.exports = router;