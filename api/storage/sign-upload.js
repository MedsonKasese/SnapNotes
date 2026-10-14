import { storage, getStorageClient, BUCKET, requireUser, send, failure, validId, ATTACHMENT_TYPES, AVATAR_TYPES, MAX_ATTACHMENT_SIZE, MAX_AVATAR_SIZE } from "../../lib/supabase-storage.js";

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
    // Distinguish a missing bucket / wrong project from an upload-signing failure.
    const { data: bucket, error: bucketError } = await getStorageClient().storage.getBucket(BUCKET);
    if (bucketError || !bucket) {
      console.error("Supabase bucket check failed", {
        bucket: BUCKET,
        code: bucketError?.code || "UNKNOWN",
        status: bucketError?.statusCode || bucketError?.status || null,
        message: bucketError?.message || "Bucket missing"
      });
      return send(res, 503, { error: "Storage bucket could not be accessed. Check that the Supabase URL and secret key belong to the project containing '" + BUCKET + "'.", code: "BUCKET_UNAVAILABLE" });
    }
    const { data, error } = await storage().createSignedUploadUrl(key, { upsert: false });
    if (error || !data?.signedUrl) {
      console.error("Supabase signed upload failed", {
        bucket: BUCKET,
        code: error?.code || "UNKNOWN",
        status: error?.statusCode || error?.status || null,
        message: error?.message || "Missing signed URL"
      });
      return send(res, 503, { error: "Could not prepare the upload. Please retry or contact support.", code: error?.code || "UPLOAD_SIGN_FAILED" });
    }
    return send(res, 200, { uploadUrl: data.signedUrl, objectKey: key, expiresIn: 7200 });
  } catch (error) { return failure(res, error, "Cloud storage is unavailable. Check Supabase settings in Vercel."); }
}
