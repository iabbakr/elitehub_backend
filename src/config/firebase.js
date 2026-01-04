const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

const serviceAccountPath = path.join(__dirname, "../../serviceAccountKey.json");

/**
 * FIREBASE ADMIN SDK - PRODUCTION CONFIGURATION
 * Secure server-side Firebase access
 */

if (!fs.existsSync(serviceAccountPath)) {
    console.error("❌ ERROR: serviceAccountKey.json not found!");
    console.error("Place your Firebase service account key in the project root");
    process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

// Validate required fields
if (!serviceAccount.project_id || !serviceAccount.private_key) {
    console.error("❌ ERROR: Invalid serviceAccountKey.json");
    process.exit(1);
}

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
        storageBucket: `${serviceAccount.project_id}.appspot.com`
    });
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
    deleteFile
};