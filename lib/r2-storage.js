import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_TYPES = new Set([
  "application/pdf", "text/plain", "image/jpeg", "image/png", "image/gif", "image/webp"
]);
export const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function send(res, status, body) {
  return res.status(status).json(body);
}

export function getR2() {
  const { R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_BUCKET_NAME || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("Cloudflare R2 is not configured. Check the R2 environment variables in Vercel.");
  }
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
  });
  return { client, bucket: R2_BUCKET_NAME };
}

export function getAdminAuth() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Firebase server credentials are not configured.");
  let account;
  try { account = JSON.parse(raw); }
  catch { throw new Error("Firebase server credentials are invalid JSON."); }
  if (!getApps().length) initializeApp({ credential: cert(account) });
  return getAuth();
}

export async function requireUser(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error("Sign in to continue.");
    error.status = 401;
    throw error;
  }
  try {
    return await getAdminAuth().verifyIdToken(match[1]);
  } catch {
    const error = new Error("Your sign-in session expired. Sign in again and retry.");
    error.status = 401;
    throw error;
  }
}

export function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

export function isOwnedKey(uid, key, purpose) {
  if (typeof key !== "string" || key.length > 600) return false;
  if (purpose === "attachment") return key.startsWith(`users/${uid}/attachments/`);
  if (purpose === "avatar") return key.startsWith(`users/${uid}/profile/avatar-`) && /^[a-zA-Z0-9._/-]+$/.test(key);
  return false;
}

export async function signPut(client, bucket, key, contentType, metadata) {
  const command = new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: contentType,
    CacheControl: "private, max-age=0, no-cache",
    Metadata: { owner: metadata.uid, purpose: metadata.purpose }
  });
  return getSignedUrl(client, command, { expiresIn: 300 });
}

export async function signGet(client, bucket, key) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

export async function removeObject(client, bucket, key) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function inspectObject(client, bucket, key) {
  return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}
