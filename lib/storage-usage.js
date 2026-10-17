export const STORAGE_USAGE_PAGE_SIZE = 1000;
const MAX_STORAGE_FOLDER_DEPTH = 16;
const STORAGE_USAGE_CACHE_TTL_MS = 30_000;
const storageUsageCache = new Map();
// Each root folder has at most one authoritative pending scan. A forced refresh
// supersedes an older in-flight scan instead of accidentally reusing it.
const pendingStorageUsage = new Map();

export async function calculateStorageUsage(bucket, rootFolder) {
  const usage = { bytes: 0, fileCount: 0, unknownSizeCount: 0 };

  async function scanFolder(folder, depth) {
    if (depth > MAX_STORAGE_FOLDER_DEPTH) throw new Error("Storage folder nesting is too deep to inspect safely.");
    for (let offset = 0; ; offset += STORAGE_USAGE_PAGE_SIZE) {
      const { data, error } = await bucket.list(folder, {
        limit: STORAGE_USAGE_PAGE_SIZE,
        offset
      });
      if (error) throw error;
      const entries = Array.isArray(data) ? data : [];

      for (const entry of entries) {
        if (!entry?.name || entry.name === "." || entry.name === ".." || entry.name.includes("/")) continue;
        if (entry.id) {
          usage.fileCount++;
          const size = Number(entry.metadata?.size ?? entry.metadata?.contentLength ?? entry.size);
          if (Number.isFinite(size) && size >= 0) usage.bytes += size;
          else usage.unknownSizeCount++;
        } else {
          await scanFolder(`${folder}/${entry.name}`, depth + 1);
        }
      }

      if (entries.length < STORAGE_USAGE_PAGE_SIZE) break;
    }
  }

  await scanFolder(rootFolder, 0);
  return usage;
}

export async function calculateCachedStorageUsage(bucket, rootFolder, {
  ttlMs = STORAGE_USAGE_CACHE_TTL_MS,
  clock = Date.now,
  force = false
} = {}) {
  const now = clock();
  for (const [key, entry] of storageUsageCache) {
    if (entry.expiresAt <= now) storageUsageCache.delete(key);
  }
  if (force) storageUsageCache.delete(rootFolder);
  const cached = storageUsageCache.get(rootFolder);
  if (!force && cached && cached.expiresAt > now) return { ...cached.usage };

  const existingPending = pendingStorageUsage.get(rootFolder);
  if (!force && existingPending) return { ...(await existingPending.promise) };

  const entry = { promise: null };
  entry.promise = calculateStorageUsage(bucket, rootFolder).then(usage => {
    // A newer forced refresh may have superseded this scan. Never let an older
    // response replace its cache entry.
    if (pendingStorageUsage.get(rootFolder) === entry) {
      storageUsageCache.set(rootFolder, { usage: { ...usage }, expiresAt: clock() + ttlMs });
      while (storageUsageCache.size > 100) storageUsageCache.delete(storageUsageCache.keys().next().value);
    }
    return usage;
  }).finally(() => {
    if (pendingStorageUsage.get(rootFolder) === entry) pendingStorageUsage.delete(rootFolder);
  });
  pendingStorageUsage.set(rootFolder, entry);
  return { ...(await entry.promise) };
}
