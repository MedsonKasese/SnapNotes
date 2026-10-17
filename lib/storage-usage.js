export const STORAGE_USAGE_PAGE_SIZE = 1000;
const MAX_STORAGE_FOLDER_DEPTH = 16;
const STORAGE_USAGE_CACHE_TTL_MS = 30_000;
const storageUsageCache = new Map();
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

  let pending = pendingStorageUsage.get(rootFolder);
  if (!pending) {
    pending = calculateStorageUsage(bucket, rootFolder).then(usage => {
      storageUsageCache.set(rootFolder, { usage: { ...usage }, expiresAt: clock() + ttlMs });
      while (storageUsageCache.size > 100) storageUsageCache.delete(storageUsageCache.keys().next().value);
      return usage;
    }).finally(() => pendingStorageUsage.delete(rootFolder));
    pendingStorageUsage.set(rootFolder, pending);
  }
  return { ...(await pending) };
}
