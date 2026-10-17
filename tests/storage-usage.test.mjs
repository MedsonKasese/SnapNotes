import test from "node:test";
import assert from "node:assert/strict";
import { calculateCachedStorageUsage, calculateStorageUsage, STORAGE_USAGE_PAGE_SIZE } from "../lib/storage-usage.js";

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

test("storage usage is cached briefly per account and returned as a copy", async () => {
  let now = 1_000;
  let scans = 0;
  const bucket = {
    async list() {
      scans++;
      return { data: [{ id: "object", name: "file.txt", metadata: { size: 12 } }], error: null };
    }
  };
  const options = { ttlMs: 50, clock: () => now };
  const first = await calculateCachedStorageUsage(bucket, "users/cache-test", options);
  first.bytes = 999;
  const cached = await calculateCachedStorageUsage(bucket, "users/cache-test", options);
  assert.deepEqual(cached, { bytes: 12, fileCount: 1, unknownSizeCount: 0 });
  assert.equal(scans, 1);

  await calculateCachedStorageUsage(bucket, "users/cache-test", { ...options, force: true });
  assert.equal(scans, 2, "forced refresh should bypass a still-valid cached result");

  now = 1_050;
  await calculateCachedStorageUsage(bucket, "users/cache-test", options);
  assert.equal(scans, 3, "expired usage should be recalculated");
});

test("simultaneous storage usage requests share one folder scan", async () => {
  let scans = 0;
  let finish;
  const bucket = {
    list() {
      scans++;
      return new Promise(resolve => { finish = () => resolve({ data: [], error: null }); });
    }
  };
  const first = calculateCachedStorageUsage(bucket, "users/concurrent-test");
  const second = calculateCachedStorageUsage(bucket, "users/concurrent-test");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 1);
  finish();
  assert.deepEqual(await Promise.all([first, second]), [
    { bytes: 0, fileCount: 0, unknownSizeCount: 0 },
    { bytes: 0, fileCount: 0, unknownSizeCount: 0 }
  ]);
});


test("forced refresh starts a newer scan instead of reusing an older pending request", async () => {
  const completions = [];
  let scans = 0;
  const bucket = {
    list() {
      const scanNumber = ++scans;
      return new Promise(resolve => completions.push(() => resolve({
        data: [{ id: `object-${scanNumber}`, name: "file.bin", metadata: { size: scanNumber * 10 } }],
        error: null
      })));
    }
  };
  const root = "users/forced-pending-race";
  const older = calculateCachedStorageUsage(bucket, root, { force: false });
  await new Promise(resolve => setImmediate(resolve));
  const newer = calculateCachedStorageUsage(bucket, root, { force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 2, "forced refresh incorrectly reused the older pending scan");

  completions[1]();
  assert.deepEqual(await newer, { bytes: 20, fileCount: 1, unknownSizeCount: 0 });
  completions[0]();
  assert.deepEqual(await older, { bytes: 10, fileCount: 1, unknownSizeCount: 0 });
  assert.deepEqual(await calculateCachedStorageUsage(bucket, root), {
    bytes: 20, fileCount: 1, unknownSizeCount: 0
  }, "the older response overwrote the newer cached usage");
  assert.equal(scans, 2, "a valid result should be served from cache");
});
