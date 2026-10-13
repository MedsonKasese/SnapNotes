import { getR2, requireUser, send, isOwnedKey, inspectObject, removeObject, ATTACHMENT_TYPES, AVATAR_TYPES, MAX_ATTACHMENT_BYTES, MAX_AVATAR_BYTES } from "../../lib/r2-storage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Use POST to complete an upload." }); }
  try {
    const user = await requireUser(req);
    const { purpose, objectKey, expectedSize, contentType } = req.body || {};
    if (!["attachment", "avatar"].includes(purpose) || !isOwnedKey(user.uid, objectKey, purpose)) return send(res, 403, { error: "You cannot complete an upload for this object." });
    const allowedTypes = purpose === "avatar" ? AVATAR_TYPES : ATTACHMENT_TYPES;
    const maxSize = purpose === "avatar" ? MAX_AVATAR_BYTES : MAX_ATTACHMENT_BYTES;
    if (!allowedTypes.has(contentType) || !Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maxSize) return send(res, 400, { error: "The uploaded file metadata is invalid." });

    const { client, bucket } = getR2();
    let object;
    try { object = await inspectObject(client, bucket, objectKey); }
    catch { return send(res, 400, { error: "The uploaded file could not be verified. Please retry the upload." }); }

    if (object.Metadata?.owner !== user.uid || object.Metadata?.purpose !== purpose ||
        object.ContentType !== contentType || object.ContentLength !== expectedSize || object.ContentLength > maxSize) {
      await removeObject(client, bucket, objectKey).catch(() => {});
      return send(res, 400, { error: "The uploaded file did not pass verification and was removed. Please retry." });
    }

    return send(res, 200, { ok: true, objectKey, size: object.ContentLength, contentType: object.ContentType });
  } catch (error) {
    if (error.status) return send(res, error.status, { error: error.message });
    console.error("R2 upload verification failed:", error.message);
    return send(res, 503, { error: "Could not verify the uploaded file. Please retry." });
  }
}
