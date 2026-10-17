import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_CLEANUP_KEY,
  enqueueAttachmentCleanup,
  cancelQueuedAttachmentCleanup,
  processAttachmentCleanupQueue
} from "../js/attachment-cleanup.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

test("attachment cleanup can be durably queued before cloud deletion starts", () => {
  const storage = memoryStorage();
  const attachment = {
    id: "file-1",
    storageProvider: "supabase",
    storagePath: "users/user-1/attachments/note-1/file-1"
  };
  const result = enqueueAttachmentCleanup([attachment], { storage, currentUid: "user-1" });
  const queue = JSON.parse(storage.getItem(ATTACHMENT_CLEANUP_KEY));
  assert.equal(result.persisted, true);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].remoteDone, false);
  assert.equal(queue[0].localDone, false);
});

test("failed note save can cancel a staged cleanup before any file is removed", async () => {
  const storage = memoryStorage();
  const attachment = {
    id: "file-2",
    storageProvider: "supabase",
    storagePath: "users/user-1/attachments/note-1/file-2"
  };
  enqueueAttachmentCleanup([attachment], { storage, currentUid: "user-1" });
  const result = cancelQueuedAttachmentCleanup([attachment], { storage, currentUid: "user-1" });
  assert.equal(result.persisted, true);
  assert.deepEqual(JSON.parse(storage.getItem(ATTACHMENT_CLEANUP_KEY)), []);

  let localDeletes = 0;
  let remoteDeletes = 0;
  await processAttachmentCleanupQueue({
    storage,
    currentUid: "user-1",
    removeLocal: async () => { localDeletes++; },
    removeRemote: async () => { remoteDeletes++; }
  });
  assert.equal(localDeletes, 0);
  assert.equal(remoteDeletes, 0);
});

test("staged cleanup remains queued when offline remote deletion fails", async () => {
  const storage = memoryStorage();
  const attachment = {
    id: "file-3",
    storageProvider: "supabase",
    storagePath: "users/user-1/attachments/note-1/file-3"
  };
  enqueueAttachmentCleanup([attachment], { storage, currentUid: "user-1" });
  let localDeletes = 0;
  const result = await processAttachmentCleanupQueue({
    storage,
    currentUid: "user-1",
    removeLocal: async () => { localDeletes++; },
    removeRemote: async () => { throw new Error("offline"); }
  });
  const queue = JSON.parse(storage.getItem(ATTACHMENT_CLEANUP_KEY));
  assert.equal(localDeletes, 1);
  assert.equal(result.pendingCount, 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].remoteDone, false);
});
