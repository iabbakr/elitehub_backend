const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

let serviceAccount;

// 1. Credentials Loading
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("✅ Firebase service account loaded from environment variable");
    } catch (error) {
        console.error("❌ ERROR: Invalid FIREBASE_SERVICE_ACCOUNT environment variable");
        process.exit(1);
    }
} else {
    const serviceAccountPath = path.join(__dirname, "../../serviceAccountKey.json");
    if (!fs.existsSync(serviceAccountPath)) {
        console.error("❌ ERROR: serviceAccountKey.json not found");
        process.exit(1);
    }
    serviceAccount = require(serviceAccountPath);
    console.log("✅ Firebase service account loaded from local JSON");
}

// 2. Initialization
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
        storageBucket: `${serviceAccount.project_id}.appspot.com`
    });
    console.log(`✅ Firebase Admin initialized: ${serviceAccount.project_id}`);
}

const db = admin.firestore();
const auth = admin.auth();
const storage = admin.storage();

db.settings({ ignoreUndefinedProperties: true, timestampsInSnapshots: true });

// 3. Base Helpers Export
module.exports = {
    db, auth, storage, admin,
    
    // Firestore Helpers
    getDocument: async (coll, id) => {
        const doc = await db.collection(coll).doc(id).get();
        return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    setDocument: async (coll, id, data, merge = true) => {
        return await db.collection(coll).doc(id).set(data, { merge });
    },
    updateDocument: async (coll, id, data) => {
        return await db.collection(coll).doc(id).update({
            ...data, updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    },
    deleteDocument: async (coll, id) => {
        return await db.collection(coll).doc(id).delete();
    },
    queryDocuments: async (coll, filters = []) => {
        let q = db.collection(coll);
        filters.forEach(f => q = q.where(f.field, f.operator, f.value));
        const snap = await q.get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    batchWrite: async (ops) => {
        const batch = db.batch();
        ops.forEach(o => {
            const ref = db.collection(o.collection).doc(o.docId);
            if (o.type === 'set') batch.set(ref, o.data, { merge: true });
            else if (o.type === 'update') batch.update(ref, o.data);
            else if (o.type === 'delete') batch.delete(ref);
        });
        return await batch.commit();
    },
    runTransaction: async (cb) => await db.runTransaction(cb),

    // Auth Helpers
    verifyToken: async (token) => await auth.verifyIdToken(token).catch(() => null),
    getUserByUid: async (uid) => await auth.getUser(uid).catch(() => null),
    createCustomToken: async (uid, claims = {}) => await auth.createCustomToken(uid, claims),

    // Storage Helpers
    getSignedUrl: async (path, exp = 3600) => {
        const [url] = await storage.bucket().file(path).getSignedUrl({
            action: 'read', expires: Date.now() + exp * 1000
        });
        return url;
    },
    deleteFile: async (path) => {
        await storage.bucket().file(path).delete();
        return true;
    }
};