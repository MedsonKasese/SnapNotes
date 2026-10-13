import { getR2, requireUser, send, isOwnedKey, signGet } from "../../lib/r2-storage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Use POST to request a download." }); }
  try {
    const user = await requireUser(req);
    const { objectKey } = req.body || {};
    if (!isOwnedKey(user.uid, objectKey, "attachment")) return send(res, 403, { error: "You cannot access this attachment." });
    const { client, bucket } = getR2();
    const url = await signGet(client, bucket, objectKey);
    return send(res, 200, { url, expiresIn: 300 });
  } catch (error) {
    if (error.status) return send(res, error.status, { error: error.message });
    console.error("R2 download signing failed:", error.message);
    return send(res, 503, { error: "Could not open this attachment. Please retry." });
  }
}
