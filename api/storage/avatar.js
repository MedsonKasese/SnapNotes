import { storage, send, failure, ownedKey } from "../../lib/supabase-storage.js";

// Profile photos are viewable wherever a user's profile appears; note attachments are not.
export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return send(res, 405, { error: "Method not allowed." }); }
  const uid = req.query?.uid;
  const key = req.query?.key;
  if (typeof uid !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(uid) || !ownedKey(uid, key, "avatar")) {
    return send(res, 404, { error: "Profile photo not found." });
  }
  try {
    const { data, error } = await storage().createSignedUrl(key, 60);
    if (error || !data?.signedUrl) return send(res, 404, { error: "Profile photo not found." });
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, data.signedUrl);
  } catch (error) { return failure(res, error, "Profile photo is unavailable."); }
}
