import { storage, requireUser, send, failure, ownedKey, MAX_ATTACHMENT_SIZE, MAX_AVATAR_SIZE, ATTACHMENT_TYPES, AVATAR_TYPES } from "../../lib/supabase-storage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Method not allowed." }); }
  try {
    const user = await requireUser(req);
    const { objectKey, purpose, expectedSize, contentType } = req.body || {};
    if (!ownedKey(user.uid, objectKey, purpose)) return send(res, 403, { error: "File access denied." });
    const max = purpose === "avatar" ? MAX_AVATAR_SIZE : MAX_ATTACHMENT_SIZE;
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > max ||
      !(purpose === "avatar" ? AVATAR_TYPES : ATTACHMENT_TYPES).has(contentType)) {
      return send(res, 400, { error: "Invalid file metadata." });
    }
    // Query object metadata without downloading the file into a Vercel function.
    const { data, error } = await storage().info(objectKey);
    if (error || !data) return send(res, 400, { error: "Upload not found. Please retry." });
    const actualSize = Number(data.metadata?.size ?? data.size);
    const actualType = String(data.metadata?.mimetype || data.metadata?.contentType || "");
    if (!Number.isFinite(actualSize) || actualSize !== expectedSize || actualSize > max || actualType !== contentType) {
      await storage().remove([objectKey]);
      return send(res, 400, { error: "File verification failed. Please retry." });
    }
    return send(res, 200, { ok: true, objectKey });
  } catch (error) { return failure(res, error, "Could not verify the uploaded file."); }
}
