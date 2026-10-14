import { storage, requireUser, send, failure, validId, ATTACHMENT_TYPES, AVATAR_TYPES, MAX_ATTACHMENT_SIZE, MAX_AVATAR_SIZE } from "../../lib/supabase-storage.js";

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Method not allowed." }); }
  try {
    const user = await requireUser(req);
    const { purpose, noteId, attachmentId, contentType, size } = req.body || {};
    const avatar = purpose === "avatar";
    if (!avatar && purpose !== "attachment") return send(res, 400, { error: "Unsupported file purpose." });
    if (!(avatar ? AVATAR_TYPES : ATTACHMENT_TYPES).has(contentType)) return send(res, 400, { error: "Unsupported file type." });
    if (!Number.isSafeInteger(size) || size < 1 || size > (avatar ? MAX_AVATAR_SIZE : MAX_ATTACHMENT_SIZE)) return send(res, 400, { error: "File is empty or exceeds the size limit." });
    if (!avatar && (!validId(noteId) || !validId(attachmentId))) return send(res, 400, { error: "Invalid note or attachment ID." });
    // Randomize every object name so a signed upload cannot overwrite a previously synced file.
    const key = avatar
      ? `users/${user.uid}/profile/avatar-${crypto.randomUUID()}.${EXT[contentType]}`
      : `users/${user.uid}/attachments/${noteId}/${crypto.randomUUID()}`;
    const { data, error } = await storage().createSignedUploadUrl(key, { upsert: false });
    if (error || !data?.signedUrl) throw new Error(error?.message || "Could not create upload URL.");
    return send(res, 200, { uploadUrl: data.signedUrl, objectKey: key, expiresIn: 7200 });
  } catch (error) { return failure(res, error, "Cloud storage is unavailable. Check Supabase settings in Vercel."); }
}
