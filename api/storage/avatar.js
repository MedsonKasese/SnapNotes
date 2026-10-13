import { getR2, send, signGet, isOwnedKey } from "../../lib/r2-storage.js";

// Profile pictures are intentionally viewable wherever a user's profile is shown.
// The bucket remains private; this endpoint only serves the user's avatar object.
export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return send(res, 405, { error: "Use GET to view a profile photo." }); }
  const uid = typeof req.query?.uid === "string" ? req.query.uid : "";
  const objectKey = typeof req.query?.key === "string" ? req.query.key : "";
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(uid) || !isOwnedKey(uid, objectKey, "avatar")) return send(res, 404, { error: "Profile photo not found." });
  try {
    const { client, bucket } = getR2();
    const url = await signGet(client, bucket, objectKey);
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return res.redirect(302, url);
  } catch (error) {
    console.error("R2 avatar lookup failed:", error.message);
    return send(res, 503, { error: "Profile photo is temporarily unavailable." });
  }
}
