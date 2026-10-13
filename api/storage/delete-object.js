import { getR2, requireUser, send, isOwnedKey, removeObject } from "../../lib/r2-storage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Use POST to delete a file." }); }
  try {
    const user = await requireUser(req);
    const { objectKey, purpose } = req.body || {};
    if (!isOwnedKey(user.uid, objectKey, purpose)) return send(res, 403, { error: "You cannot delete this object." });
    const { client, bucket } = getR2();
    await removeObject(client, bucket, objectKey);
    return send(res, 200, { ok: true });
  } catch (error) {
    if (error.status) return send(res, error.status, { error: error.message });
    console.error("R2 object deletion failed:", error.message);
    return send(res, 503, { error: "Could not remove the cloud file. It can be cleaned up later." });
  }
}
