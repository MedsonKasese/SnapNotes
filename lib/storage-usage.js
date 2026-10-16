export const STORAGE_USAGE_PAGE_SIZE = 1000;
const MAX_STORAGE_FOLDER_DEPTH = 16;

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
