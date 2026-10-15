import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { BUCKET, getStorageClient } from "../../lib/supabase-storage.js";

const MAX_STORAGE_FILES_PER_RUN = 100;
const MAX_STORAGE_LIST = 1000;
const PROCESSING_LEASE_MS = 30 * 60 * 1000;
const CLEANUP_RETRY_DELAY_MS = 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

function send(res, status, body) {
  return res.status(status).json(body);
}

function getAdminServices() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Firebase server credentials are not configured.");
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("Firebase server credentials are invalid JSON.");
  }
  const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
  return { auth: getAuth(app), db: getFirestore(app) };
}

async function collectStorageBatch(bucket, folder, remaining, paths = []) {
  if (remaining <= 0) return { paths, hasMore: true };
  const { data, error } = await bucket.list(folder, { limit: MAX_STORAGE_LIST, offset: 0 });
  if (error) throw error;
  const entries = Array.isArray(data) ? data : [];
  for (const entry of entries) {
    const fullPath = `${folder}/${entry.name}`;
    if (entry.id) {
      paths.push(fullPath);
      if (paths.length >= remaining) {
        return { paths, hasMore: true };
      }
    } else if (entry.name) {
      const nested = await collectStorageBatch(bucket, fullPath, remaining - paths.length, paths);
      if (nested.hasMore) return nested;
    }
  }
  return { paths, hasMore: entries.length >= MAX_STORAGE_LIST };
}

async function removeUserStorage(storage, uid) {
  const bucket = storage.from(BUCKET);
  const { paths, hasMore } = await collectStorageBatch(bucket, `users/${uid}`, MAX_STORAGE_FILES_PER_RUN);
  for (let index = 0; index < paths.length; index += 100) {
    const { error } = await bucket.remove(paths.slice(index, index + 100));
    if (error) throw error;
  }
  return { deletedCount: paths.length, hasMore };
}

async function removeExpiredDeletionTombstones(db, now) {
  const expired = await db.collection("accountDeletionTombstones")
    .where("expiresAt", "<=", now.toISOString())
    .limit(100)
    .get();
  await Promise.all(expired.docs.map(snapshot => snapshot.ref.delete()));
  return expired.size;
}

async function claimDueDeletion(db, userRef, now) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists) return false;
    const data = snapshot.data() || {};
    const deletion = data.accountDeletion;
    if (!deletion?.scheduledFor || Date.parse(deletion.scheduledFor) > now.getTime()) return false;
    if (Date.parse(deletion.nextCleanupAt || "") > now.getTime()) return false;
    const processingAt = Date.parse(deletion.processingAt || "");
    if (deletion.status === "processing" && Number.isFinite(processingAt) && now.getTime() - processingAt < PROCESSING_LEASE_MS) {
      return false;
    }
    transaction.set(userRef, {
      accountDeletion: {
        ...deletion,
        status: "processing",
        processingAt: now.toISOString(),
        nextCleanupAt: new Date(now.getTime() + CLEANUP_RETRY_DELAY_MS).toISOString()
      }
    }, { merge: true });
    return true;
  });
}

async function releaseForRetry(userRef, error) {
  try {
    await userRef.set({
      accountDeletion: {
        status: "processing",
        processingAt: new Date().toISOString(),
        nextCleanupAt: new Date(Date.now() + CLEANUP_RETRY_DELAY_MS).toISOString(),
        lastError: String(error?.message || "Cleanup failed").slice(0, 240),
        lastAttemptAt: new Date().toISOString()
      }
    }, { merge: true });
  } catch (persistError) {
    console.error("Could not record account-deletion retry state:", persistError?.message || persistError);
  }
}

async function processOneDueAccount(services, userDoc) {
  const uid = userDoc.id;
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(uid)) {
    console.error("Skipping an account with an unsupported UID format.");
    return { uid, status: "skipped" };
  }

  const userRef = services.db.collection("users").doc(uid);
  const claimed = await claimDueDeletion(services.db, userRef, new Date());
  if (!claimed) return { uid, status: "not-claimed" };

  try {
    const storageResult = await removeUserStorage(getStorageClient().storage, uid);
    if (storageResult.hasMore) {
      await userRef.set({ accountDeletion: {
        status: "processing",
        processingAt: new Date().toISOString(),
        nextCleanupAt: new Date(Date.now() + CLEANUP_RETRY_DELAY_MS).toISOString(),
        storageFilesRemoved: storageResult.deletedCount
      } }, { merge: true });
      return { uid, status: "cleaning-storage", removed: storageResult.deletedCount };
    }

    const deletion = userDoc.data()?.accountDeletion || {};
    const tombstoneTime = new Date();
    await services.db.collection("accountDeletionTombstones").doc(uid).set({
      requestedAt: deletion.requestedAt || null,
      scheduledFor: deletion.scheduledFor || null,
      deletedAt: tombstoneTime.toISOString(),
      expiresAt: new Date(tombstoneTime.getTime() + TOMBSTONE_RETENTION_MS).toISOString()
    }, { merge: true });

    try {
      await services.auth.deleteUser(uid);
    } catch (error) {
      if (error?.code !== "auth/user-not-found") throw error;
    }

    await services.db.recursiveDelete(userRef);
    return { uid, status: "deleted", removed: storageResult.deletedCount };
  } catch (error) {
    await releaseForRetry(userRef, error);
    console.error(`Scheduled account cleanup failed for ${uid}:`, error?.message || error);
    return { uid, status: "retry", error: String(error?.message || error).slice(0, 240) };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "Method not allowed." });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return send(res, 401, { error: "Unauthorized." });
  }

  try {
    const services = getAdminServices();
    await removeExpiredDeletionTombstones(services.db, new Date());
    const now = new Date();
    const due = await services.db.collection("users")
      .where("accountDeletion.scheduledFor", "<=", now.toISOString())
      .get();
    const eligible = due.docs.filter(userDoc => {
      const deletion = userDoc.data()?.accountDeletion || {};
      if (Date.parse(deletion.nextCleanupAt || "") > now.getTime()) return false;
      const processingAt = Date.parse(deletion.processingAt || "");
      return deletion.status !== "processing" || !Number.isFinite(processingAt) || now.getTime() - processingAt >= PROCESSING_LEASE_MS;
    }).sort((left, right) => {
      const leftDeletion = left.data()?.accountDeletion || {};
      const rightDeletion = right.data()?.accountDeletion || {};
      const leftTime = Date.parse(leftDeletion.nextCleanupAt || leftDeletion.scheduledFor || "") || 0;
      const rightTime = Date.parse(rightDeletion.nextCleanupAt || rightDeletion.scheduledFor || "") || 0;
      return leftTime - rightTime;
    });
    if (!eligible.length) return send(res, 200, { processed: 0, status: "no-due-accounts" });

    const results = [];
    results.push(await processOneDueAccount(services, eligible[0]));
    return send(res, 200, { processed: results.length, results });
  } catch (error) {
    console.error("Scheduled account deletion worker failed:", error?.message || error);
    return send(res, 500, { error: "Scheduled account cleanup failed; it will be retried." });
  }
}
