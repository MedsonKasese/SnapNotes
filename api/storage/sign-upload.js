import { getR2, requireUser, send, validId, signPut, ATTACHMENT_TYPES, AVATAR_TYPES, MAX_ATTACHMENT_BYTES, MAX_AVATAR_BYTES } from "../../lib/r2-storage.js";

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "text/plain": "txt" };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Use POST to request an upload." }); }
  try {
    const user = await requireUser(req);
    const { purpose, noteId, attachmentId, contentType, size } = req.body || {};
    if (!["attachment", "avatar"].includes(purpose)) return send(res, 400, { error: "Unsupported file purpose." });
    const allowedTypes = purpose === "avatar" ? AVATAR_TYPES : ATTACHMENT_TYPES;
    const maxSize = purpose === "avatar" ? MAX_AVATAR_BYTES : MAX_ATTACHMENT_BYTES;
    if (!allowedTypes.has(contentType)) return send(res, 400, { error: "This file type is not supported." });
    if (!Number.isSafeInteger(size) || size < 1 || size > maxSize) return send(res, 400, { error: purpose === "avatar" ? "Profile photos must be smaller than 2 MB." : "Attachments must be 10 MB or smaller." });

    let key;
    if (purpose === "attachment") {
      if (!validId(noteId) || !validId(attachmentId)) return send(res, 400, { error: "Invalid note or attachment identifier." });
      key = `users/${user.uid}/attachments/${noteId}/${attachmentId}`;
    } else {
      key = `users/${user.uid}/profile/avatar-${crypto.randomUUID()}.${EXTENSIONS[contentType]}`;
    }

    const { client, bucket } = getR2();
    const uploadUrl = await signPut(client, bucket, key, contentType, { uid: user.uid, purpose });
    return send(res, 200, {
      uploadUrl, objectKey: key, expiresIn: 300,
      headers: { "Content-Type": contentType, "x-amz-meta-owner": user.uid, "x-amz-meta-purpose": purpose }
    });
  } catch (error) {
    if (error.status) return send(res, error.status, { error: error.message });
    console.error("R2 upload signing failed:", error.message);
    return send(res, 503, { error: "Cloud storage is not ready. Check the R2 configuration in Vercel and try again." });
  }
}
