import { storage, requireUser, send, failure, ownedKey } from "../../lib/supabase-storage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Method not allowed." }); }
  try {
    const user = await requireUser(req);
    const { objectKey, purpose } = req.body || {};
    if (!ownedKey(user.uid, objectKey, purpose)) return send(res, 403, { error: "File access denied." });
    const { error } = await storage().remove([objectKey]);
    if (error) throw error;
    return send(res, 200, { ok: true });
  } catch (error) { return failure(res, error, "Could not delete the cloud file."); }
}
