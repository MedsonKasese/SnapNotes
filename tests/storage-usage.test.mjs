import test from "node:test";
import assert from "node:assert/strict";
import { calculateStorageUsage, STORAGE_USAGE_PAGE_SIZE } from "../lib/storage-usage.js";

test("storage usage recursively totals object sizes across account folders", async () => {
  const folders = new Map([
    ["users/user-1", [
      { id: null, name: "attachments" },
      { id: null, name: "profile" }
    ]],
    ["users/user-1/attachments", [{ id: null, name: "note-1" }]],
    ["users/user-1/attachments/note-1", [
      { id: "object-1", name: "first.pdf", metadata: { size: "1200" } },
      { id: "object-2", name: "second.pdf", metadata: { size: 800 } }
    ]],
    ["users/user-1/profile", [{ id: "avatar", name: "avatar.png", metadata: { size: 500 } }]]
  ]);
  const bucket = { async list(folder) { return { data: folders.get(folder) || [], error: null }; } };

  assert.deepEqual(await calculateStorageUsage(bucket, "users/user-1"), {
    bytes: 2500,
    fileCount: 3,
    unknownSizeCount: 0
  });
});

test("storage usage paginates large folders and reports unknown file sizes", async () => {
  const calls = [];
  const bucket = {
    async list(folder, options) {
      calls.push({ folder, ...options });
      if (options.offset === 0) {
        return { data: Array.from({ length: STORAGE_USAGE_PAGE_SIZE }, (_, index) => ({
          id: `object-${index}`,
          name: `file-${index}.bin`,
          metadata: { size: 2 }
        })), error: null };
      }
      if (options.offset === STORAGE_USAGE_PAGE_SIZE) {
        return { data: [{ id: "unknown-size", name: "missing.bin", metadata: {} }], error: null };
      }
      return { data: [], error: null };
    }
  };

  assert.deepEqual(await calculateStorageUsage(bucket, "users/user-2"), {
    bytes: STORAGE_USAGE_PAGE_SIZE * 2,
    fileCount: STORAGE_USAGE_PAGE_SIZE + 1,
    unknownSizeCount: 1
  });
  assert.deepEqual(calls.map(call => call.offset), [0, STORAGE_USAGE_PAGE_SIZE]);
});

test("storage listing errors fail the usage calculation rather than reporting a false zero", async () => {
  const bucket = { async list() { return { data: null, error: new Error("permission denied") }; } };
  await assert.rejects(() => calculateStorageUsage(bucket, "users/user-3"), /permission denied/);
});
