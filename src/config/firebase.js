const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

/**
 * FIREBASE ADMIN SDK - PRODUCTION CONFIGURATION
 * Secure server-side Firebase access
 * 
 * Supports two methods:
 * 1. Environment variable FIREBASE_SERVICE_ACCOUNT (recommended for production)
 * 2. Fallback to local serviceAccountKey.json (useful for local development)
 */

let serviceAccount;

// Priority 1: Use environment variable (secure for production - Vercel, Render, Heroku, etc.)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("✅ Firebase service account loaded from FIREBASE_SERVICE_ACCOUNT environment variable");
    } catch (error) {
        console.error("❌ ERROR: Invalid FIREBASE_SERVICE_ACCOUNT environment variable (must be valid JSON string)");
        console.error("   Check for missing quotes, escaped newlines, or parsing issues.");
        process.exit(1);
    }
} else {
    // Priority 2: Fallback to local JSON file
    const serviceAccountPath = path.join(__dirname, "../../serviceAccountKey.json");

    if (!fs.existsSync(serviceAccountPath)) {
        console.error("❌ ERROR: serviceAccountKey.json not found at:", serviceAccountPath);
        console.error("   Either:");
        console.error("   • Place your service account key file there (for local dev), OR");
        console.error("   • Set the FIREBASE_SERVICE_ACCOUNT environment variable (recommended for production)");
        process.exit(1);
    }

    try {
        serviceAccount = require(serviceAccountPath);
        console.log("✅ Firebase service account loaded from local serviceAccountKey.json");
    } catch (error) {
        console.error("❌ ERROR: Failed to load or parse serviceAccountKey.json");
        process.exit(1);
    }
}

// Validate required fields
if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    console.error("❌ ERROR: Invalid service account credentials - missing required fields");
    console.error("   Required: project_id, private_key, client_email");
    process.exit(1);
}

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
        storageBucket: `${serviceAccount.project_id}.appspot.com`
    });
    console.log(`✅ Firebase Admin initialized for project: ${serviceAccount.project_id}`);
}

const db = admin.firestore();
const auth = admin.auth();
const storage = admin.storage();

// Firestore settings for better performance
db.settings({
    ignoreUndefinedProperties: true,
    timestampsInSnapshots: true
});

/**
 * FIRESTORE HELPERS
 */

/**
 * Get document with error handling
 */
async function getDocument(collection, docId) {
    try {
        const doc = await db.collection(collection).doc(docId).get();
        if (!doc.exists) {
            return null;
        }
        return { id: doc.id, ...doc.data() };
    } catch (error) {
        console.error(`Error getting document ${collection}/${docId}:`, error);
        throw error;
    }
}

/**
 * Set document with merge option
 */
async function setDocument(collection, docId, data, merge = true) {
    try {
        await db.collection(collection).doc(docId).set(data, { merge });
        return true;
    } catch (error) {
        console.error(`Error setting document ${collection}/${docId}:`, error);
        throw error;
    }
}

/**
 * Update document fields
 */
async function updateDocument(collection, docId, data) {
    try {
        await db.collection(collection).doc(docId).update({
            ...data,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return true;
    } catch (error) {
        console.error(`Error updating document ${collection}/${docId}:`, error);
        throw error;
    }
}

/**
 * Delete document
 */
async function deleteDocument(collection, docId) {
    try {
        await db.collection(collection).doc(docId).delete();
        return true;
    } catch (error) {
        console.error(`Error deleting document ${collection}/${docId}:`, error);
        throw error;
    }
}

/**
 * Query documents with filters
 */
async function queryDocuments(collection, filters = []) {
    try {
        let query = db.collection(collection);
        
        filters.forEach(({ field, operator, value }) => {
            query = query.where(field, operator, value);
        });
        
        const snapshot = await query.get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
        console.error(`Error querying collection ${collection}:`, error);
        throw error;
    }
}

/**
 * Batch write operations
 */
async function batchWrite(operations) {
    const batch = db.batch();
    
    operations.forEach(({ type, collection, docId, data }) => {
        const docRef = db.collection(collection).doc(docId);
        
        switch (type) {
            case 'set':
                batch.set(docRef, data, { merge: true });
                break;
            case 'update':
                batch.update(docRef, data);
                break;
            case 'delete':
                batch.delete(docRef);
                break;
        }
    });
    
    try {
        await batch.commit();
        return true;
    } catch (error) {
        console.error('Batch write error:', error);
        throw error;
    }
}

/**
 * Transaction helper
 */
async function runTransaction(callback) {
    return db.runTransaction(callback);
}

/**
 * AUTH HELPERS
 */

/**
 * Verify Firebase ID token
 */
async function verifyToken(idToken) {
    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        return decodedToken;
    } catch (error) {
        console.error('Token verification failed:', error);
        return null;
    }
}

/**
 * Get user by UID
 */
async function getUserByUid(uid) {
    try {
        const userRecord = await auth.getUser(uid);
        return userRecord;
    } catch (error) {
        console.error('Error fetching user:', error);
        return null;
    }
}

/**
 * Create custom token
 */
async function createCustomToken(uid, additionalClaims = {}) {
    try {
        const customToken = await auth.createCustomToken(uid, additionalClaims);
        return customToken;
    } catch (error) {
        console.error('Error creating custom token:', error);
        throw error;
    }
}

/**
 * STORAGE HELPERS
 */

/**
 * Get signed URL for private files
 */
async function getSignedUrl(filePath, expiresIn = 3600) {
    try {
        const bucket = storage.bucket();
        const file = bucket.file(filePath);
        
        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: Date.now() + expiresIn * 1000
        });
        
        return url;
    } catch (error) {
        console.error('Error generating signed URL:', error);
        throw error;
    }
}

/**
 * Delete file from storage
 */
async function deleteFile(filePath) {
    try {
        const bucket = storage.bucket();
        await bucket.file(filePath).delete();
        return true;
    } catch (error) {
        console.error('Error deleting file:', error);
        throw error;
    }
}

/**
 * PUSH NOTIFICATION HELPER
 * Sends a notification via the Expo Push API
 */
async function sendPushNotification(userId, title, body, data = {}) {
    try {
        const tokenDoc = await db.collection('pushTokens').doc(userId).get();
        if (!tokenDoc.exists) {
            console.log(`⚠️ No push token found for user ${userId}`);
            return;
        }

        const { token } = tokenDoc.data();
        const axios = require('axios');

        const message = {
            to: token,
            sound: 'default',
            title,
            body,
            data,
            priority: 'high',
            badge: data.badge || 0
        };

        await axios.post('https://exp.host/--/api/v2/push/send', message);
        console.log(`🔔 Notification sent to user ${userId}`);
    } catch (error) {
        console.error("❌ Push Error:", error.message);
    }

}


module.exports = {
    db,
    auth,
    storage,
    admin,
    // Document helpers
    getDocument,
    setDocument,
    updateDocument,
    deleteDocument,
    queryDocuments,
    batchWrite,
    runTransaction,
    // Auth helpers
    verifyToken,
    getUserByUid,
    createCustomToken,
    // Storage helpers
    getSignedUrl,
    deleteFile,
    sendPushNotification
};