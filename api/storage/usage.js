import { BUCKET, failure, getStorageClient, requireUser, send } from "../../lib/supabase-storage.js";
import { calculateCachedStorageUsage } from "../../lib/storage-usage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed." });
  }

  try {
    const user = await requireUser(req);
    const bucket = getStorageClient().storage.from(BUCKET);
    const usage = await calculateCachedStorageUsage(bucket, `users/${user.uid}`, {
      force: req.body?.force === true
    });
    return send(res, 200, usage);
  } catch (error) {
    return failure(res, error, "Cloud storage usage could not be loaded.");
  }
}
