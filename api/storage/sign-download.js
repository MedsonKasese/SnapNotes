import { storage, requireUser, send, failure, ownedKey } from "../../lib/supabase-storage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Method not allowed." }); }
  try {
    const user = await requireUser(req);
    const { objectKey } = req.body || {};
    if (!ownedKey(user.uid, objectKey, "attachment")) return send(res, 403, { error: "File access denied." });
    const { data, error } = await storage().createSignedUrl(objectKey, 300);
    if (error || !data?.signedUrl) return send(res, 404, { error: "Attachment not available." });
    return send(res, 200, { url: data.signedUrl, expiresIn: 300 });
  } catch (error) { return failure(res, error, "Could not open this attachment."); }
}
