import { createClient } from "@supabase/supabase-js";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const MAX_AVATAR_SIZE = 2 * 1024 * 1024;
export const ATTACHMENT_TYPES = new Set(["application/pdf", "text/plain", "image/jpeg", "image/png", "image/gif", "image/webp"]);
export const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "Snapnotes-files";
export function send(res, status, body) { return res.status(status).json(body); }

export function getStorageClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase Storage environment variables are missing.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function storage() {
  return getStorageClient().storage.from(BUCKET);
}

export async function requireUser(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) { const e = new Error("Sign in to sync your files."); e.status = 401; throw e; }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Firebase server credentials are missing.");
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(raw)) });
  try { return await getAuth().verifyIdToken(match[1]); }
  catch { const e = new Error("Your sign-in session expired. Sign in and retry."); e.status = 401; throw e; }
}

export function validId(id) { return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id); }
export function ownedKey(uid, key, purpose) {
  if (typeof key !== "string" || key.length > 500 || key.includes("..")) return false;
  if (purpose === "attachment") return key.startsWith(`users/${uid}/attachments/`) && /^users\/[a-zA-Z0-9:_-]+\/attachments\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(key);
  if (purpose === "avatar") return key.startsWith(`users/${uid}/profile/avatar-`) && /^users\/[a-zA-Z0-9:_-]+\/profile\/avatar-[a-zA-Z0-9-]+\.(jpg|png|webp)$/.test(key);
  return false;
}
export function failure(res, error, fallback) {
  if (error?.status) return send(res, error.status, { error: error.message });
  console.error("Supabase storage request failed:", error?.message || error);
  return send(res, 503, { error: fallback });
}
