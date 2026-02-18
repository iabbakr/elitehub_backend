const cloudinary = require('cloudinary').v2;

/**
 * PRODUCTION-GRADE CDN SERVICE
 * Cloudinary integration with automatic optimization
 */

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY || process.env.EXPO_PUBLIC_CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

class CDNService {
    /**
     * Generate signed upload parameters
     */
    getSignedUploadParams(folder = 'elitehub', options = {}) {
        const timestamp = Math.round(Date.now() / 1000);

        const uploadParams = {
            timestamp,
            folder,
            ...options
        };

        const signature = cloudinary.utils.api_sign_request(
            uploadParams,
            process.env.CLOUDINARY_API_SECRET
        );

        return {
            signature,
            timestamp,
            apiKey: process.env.CLOUDINARY_API_KEY || process.env.EXPO_PUBLIC_CLOUDINARY_API_KEY,
            cloudName: process.env.CLOUDINARY_CLOUD_NAME || process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME,
            folder,
            uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET
        };
    }

    /**
     * Upload file to Cloudinary from server
     */
    async uploadFile(fileBuffer, options = {}) {
        try {
            return new Promise((resolve, reject) => {
                const uploadOptions = {
                    folder: options.folder || 'elitehub',
                    resource_type: options.resourceType || 'auto',
                    quality: options.quality || 'auto:best',
                    fetch_format: options.fetchFormat || 'auto',
                    transformation: options.transformation || [],
                    ...options
                };

                const uploadStream = cloudinary.uploader.upload_stream(
                    uploadOptions,
                    (error, result) => {
                        if (error) {
                            console.error('Cloudinary upload error:', error);
                            reject(error);
                        } else {
                            resolve(result);
                        }
                    }
                );

                uploadStream.end(fileBuffer);
            });
        } catch (error) {
            console.error('Upload file error:', error);
            throw error;
        }
    }

    /**
     * Upload multiple files
     */
    async uploadMultiple(files, options = {}) {
        try {
            const uploadPromises = files.map(file => this.uploadFile(file, options));
            return await Promise.all(uploadPromises);
        } catch (error) {
            console.error('Upload multiple error:', error);
            throw error;
        }
    }

    /**
     * Delete file from Cloudinary
     */
    async deleteFile(publicId, resourceType = 'image') {
        try {
            const result = await cloudinary.uploader.destroy(publicId, {
                resource_type: resourceType
            });

            return {
                success: result.result === 'ok',
                publicId,
                result: result.result
            };
        } catch (error) {
            console.error('Delete file error:', error);
            throw error;
        }
    }

    /**
     * Delete multiple files
     */
    async deleteMultiple(publicIds, resourceType = 'image') {
        try {
            const result = await cloudinary.api.delete_resources(publicIds, {
                resource_type: resourceType
            });

            return {
                success: true,
                deleted: result.deleted,
                deletedCounts: result.deleted_counts
            };
        } catch (error) {
            console.error('Delete multiple error:', error);
            throw error;
        }
    }

    /**
     * Optimize image URL
     *
     * ✅ FIX: Uses c_fill (not c_fit) so images always fill their container
     * edge-to-edge without letterboxing. Only width is set — no height
     * constraint — so the image's natural aspect ratio is preserved.
     */
    optimizeUrl(url, options = {}) {
        if (!url) return url;

        if (!url.includes('cloudinary.com')) {
            return url;
        }

        // Guard: don't stack transformations if they already exist
        const uploadIndex = url.indexOf('/upload/');
        if (uploadIndex === -1) return url;

        try {
            const transformations = [
                'f_auto',       // WebP/AVIF for modern devices
                'q_auto:good',  // Good quality — faster than :best, visually identical
            ];

            if (options.width) {
                transformations.push(`w_${options.width}`);
            }

            // ✅ FIX: Only add height if explicitly provided.
            // Previously height was always passed as 800 alongside width 800,
            // which forced a square crop even for portrait/landscape products.
            if (options.height) {
                transformations.push(`h_${options.height}`);
            }

            // ✅ FIX: Default to c_fill so the image fills its frame.
            // c_fit would leave empty space (letterbox). c_fill crops smartly.
            const crop = options.crop || 'fill';
            transformations.push(`c_${crop}`);

            // Gravity for smart cropping (default auto detects focal point)
            if (options.gravity) {
                transformations.push(`g_${options.gravity}`);
            }

            const transformString = transformations.join(',');
            const baseUrl = url.substring(0, uploadIndex + 8);
            const remainingPath = url.substring(uploadIndex + 8);

            return `${baseUrl}${transformString}/${remainingPath}`;
        } catch (error) {
            console.error('Optimize URL error:', error);
            return url;
        }
    }

    /**
     * Thumbnail — square crop for compact cards / avatars
     */
    getThumbnail(url, width = 300, height = 300) {
        return this.optimizeUrl(url, {
            width,
            height,
            crop: 'fill',
            gravity: 'auto'
        });
    }

    /**
     * Generate responsive image variants
     *
     * ✅ FIX: medium and large no longer pass height, so the image's
     * natural aspect ratio is preserved (no squishing or letterboxing).
     */
    getResponsiveVariants(url) {
        return {
            // Square thumbnail — fine for icons/avatars
            thumbnail: this.optimizeUrl(url, { width: 150, height: 150, crop: 'fill', gravity: 'auto' }),
            // Small preview — width only, natural height
            small: this.optimizeUrl(url, { width: 400, crop: 'fill', gravity: 'auto' }),
            // Medium — width only, natural height (used by ProductCard grid/list)
            medium: this.optimizeUrl(url, { width: 800, crop: 'fill', gravity: 'auto' }),
            // Large — width only, natural height (used by product detail / zoom)
            large: this.optimizeUrl(url, { width: 1200, crop: 'fill', gravity: 'auto' }),
            // Original with only format+quality optimization
            original: this.optimizeUrl(url)
        };
    }

    /**
     * Extract public ID from Cloudinary URL
     */
    extractPublicId(url) {
        try {
            const regex = /\/v\d+\/(.+)\.\w+$/;
            const match = url.match(regex);
            return match ? match[1] : null;
        } catch (error) {
            console.error('Extract public ID error:', error);
            return null;
        }
    }

    /**
     * Get CDN URL for static assets
     */
    getCdnUrl(path) {
        const cdnBase =
            process.env.CDN_BASE_URL ||
            `https://res.cloudinary.com/${
                process.env.CLOUDINARY_CLOUD_NAME ||
                process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME
            }`;

        const cleanPath = path.replace(/^\/+/, '');
        return `${cdnBase}/${cleanPath}`;
    }

    /**
     * Generate video thumbnail
     */
    getVideoThumbnail(videoUrl, time = 0) {
        if (!videoUrl || !videoUrl.includes('cloudinary.com')) {
            return null;
        }

        return videoUrl.replace('/upload/', `/upload/so_${time},f_auto,q_auto/`);
    }

    /**
     * Upload with transformation
     */
    async uploadWithTransform(fileBuffer, transformations = [], options = {}) {
        return this.uploadFile(fileBuffer, {
            ...options,
            transformation: transformations
        });
    }

    /**
     * Upload product image with standard transformations
     * c_limit preserves aspect ratio and never upscales
     */
    async uploadProductImage(fileBuffer, productId) {
        return this.uploadFile(fileBuffer, {
            folder: 'products',
            public_id: `product_${productId}_${Date.now()}`,
            transformation: [
                { width: 1200, crop: 'limit' }, // ✅ No fixed height — preserves aspect ratio
                { quality: 'auto:best' },
                { fetch_format: 'auto' }
            ]
        });
    }

    /**
     * Upload user avatar
     */
    async uploadAvatar(fileBuffer, userId) {
        return this.uploadFile(fileBuffer, {
            folder: 'avatars',
            public_id: `avatar_${userId}`,
            transformation: [
                { width: 400, height: 400, crop: 'fill', gravity: 'face' },
                { quality: 'auto:good' },
                { fetch_format: 'auto' }
            ]
        });
    }

    /**
     * Upload prescription document
     */
    async uploadPrescription(fileBuffer, userId, productId) {
        return this.uploadFile(fileBuffer, {
            folder: 'prescriptions',
            public_id: `rx_${userId}_${productId}_${Date.now()}`,
            resource_type: 'auto'
        });
    }
}

module.exports = new CDNService();