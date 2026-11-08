import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const syncCenterSource = await readFile(new URL("../js/sync-center.js", import.meta.url), "utf8");

function makeSyncCenter({
  syncToCloud = async () => true,
  loadFromCloud = async () => {},
  cloudReady = true,
  confirm = true,
  activeLibraryUid = "user-1",
  deletionStatus = null,
  getAccountDeletionStatus = async () => deletionStatus,
  notes = [],
  folders = [],
  readLocalLibrary = async () => ({ notes, folders }),
  localNotesReady = Promise.resolve(),
  initialStorage = {}
} = {}) {
  const elements = new Map();
  for (const id of ["syncCenterStatus", "syncCenterLast", "syncCenterRetry"]) {
    elements.set(id, {
      textContent: "",
      disabled: false,
      listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); }
    });
  }

  const windowListeners = new Map();
  const values = new Map(Object.entries(initialStorage));
  const calls = { sync: 0, load: 0, attachmentRetry: 0, cleanupRetry: 0, confirm: 0, localRead: 0, deletionRead: 0 };
  const window = {
    firebaseAuth: { currentUser: { uid: "user-1" } },
    snapNotesDataUid: activeLibraryUid,
    notes,
    localNotesReady,
    getFolders: () => folders,
    readLocalLibrary: async (...args) => { calls.localRead++; return readLocalLibrary(...args); },
    getAccountDeletionStatus: async (...args) => { calls.deletionRead++; return getAccountDeletionStatus(...args); },
    syncToCloud: async (...args) => { calls.sync++; return syncToCloud(...args); },
    loadFromCloud: async (...args) => { calls.load++; return loadFromCloud(...args); },
    isCloudLibraryReady: () => cloudReady,
    confirm: () => { calls.confirm++; return confirm; },
    retryPendingAttachmentUploads: async () => { calls.attachmentRetry++; },
    retryPendingAttachmentCleanup: async () => { calls.cleanupRetry++; },
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    dispatchEvent(event) { windowListeners.get(event.type)?.(event); }
  };
  const localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const document = {
    getElementById(id) { return elements.get(id) ?? null; }
  };

  vm.runInNewContext(syncCenterSource, {
    window,
    document,
    localStorage,
    navigator: { onLine: true },
    Date,
    console
  });
  return { elements, localStorage, window, calls };
}

test("successful background sync clears a previous manual retry error", async () => {
  const { elements, window } = makeSyncCenter({ syncToCloud: async () => false });
  const status = elements.get("syncCenterStatus");
  const last = elements.get("syncCenterLast");
  const retry = elements.get("syncCenterRetry");

  assert.equal(retry.disabled, false, "the first sync should be available until confirmed");
  await retry.listeners.get("click")();
  assert.equal(status.textContent, "Cloud note sync did not complete. Please retry.");
  assert.equal(retry.disabled, false, "a failed sync should leave retry available");

  window.dispatchEvent({
    type: "snapnotes:sync-status",
    detail: { status: "synced", uid: "user-1" }
  });

  assert.equal(status.textContent, "Last cloud note synchronization succeeded.");
  assert.match(last.textContent, /^Last confirmed note sync: /);
  assert.equal(retry.disabled, true, "a successful sync should disable retry");
});

test("Sync now re-enables when local changes become pending after a successful sync", () => {
  const { elements, localStorage, window } = makeSyncCenter({ syncToCloud: async () => true });
  const retry = elements.get("syncCenterRetry");

  window.dispatchEvent({
    type: "snapnotes:sync-status",
    detail: { status: "synced", uid: "user-1" }
  });
  assert.equal(retry.disabled, true);

  localStorage.setItem("SnapNotesSyncPending:user-1", "true");
  window.dispatchEvent({
    type: "snapnotes:sync-status",
    detail: { status: "pending", uid: "user-1" }
  });
  assert.equal(retry.disabled, false, "pending local changes should make retry available");
});

test("first-time cloud activation requires a verified local backup and explicit warning confirmation", async () => {
  const { elements, window, calls } = makeSyncCenter({
    activeLibraryUid: "local",
    confirm: true,
    cloudReady: true,
    loadFromCloud: async () => {},
    notes: [{ id: "local-note" }],
    folders: [],
    readLocalLibrary: async () => ({ notes: [{ id: "local-note" }], folders: [] })
  });
  const retry = elements.get("syncCenterRetry");
  assert.equal(retry.textContent, "Start cloud sync");
  await retry.listeners.get("click")();

  assert.equal(calls.localRead, 1);
  assert.equal(calls.deletionRead, 1);
  assert.equal(calls.confirm, 1);
  assert.equal(calls.load, 1);
  assert.equal(calls.sync, 0);
  assert.equal(window.snapNotesDataUid, "user-1");
  assert.match(elements.get("syncCenterStatus").textContent, /Last cloud note synchronization succeeded|Cloud sync not yet confirmed/);
});

test("missing local backup blocks first-time cloud merge without changing ownership or calling cloud", async () => {
  const localNotes = [{ id: "local-note" }];
  const { elements, window, calls } = makeSyncCenter({
    activeLibraryUid: "local",
    notes: localNotes,
    readLocalLibrary: async () => null
  });
  await elements.get("syncCenterRetry").listeners.get("click")();

  assert.equal(calls.confirm, 0);
  assert.equal(calls.load, 0);
  assert.equal(calls.sync, 0);
  assert.equal(window.snapNotesDataUid, "local");
  assert.deepEqual(window.notes, localNotes);
  assert.match(elements.get("syncCenterStatus").textContent, /local backup could not be verified/i);
});

test("first-time cloud activation waits for a successful local library load", async () => {
  const localNotes = [{ id: "local-note" }];
  const { elements, window, calls } = makeSyncCenter({
    activeLibraryUid: "local",
    notes: localNotes,
    localNotesReady: Promise.reject(new Error("IndexedDB load failed"))
  });
  await elements.get("syncCenterRetry").listeners.get("click")();

  assert.equal(calls.localRead, 0);
  assert.equal(calls.confirm, 0);
  assert.equal(calls.load, 0);
  assert.equal(window.snapNotesDataUid, "local");
  assert.deepEqual(window.notes, localNotes);
  assert.match(elements.get("syncCenterStatus").textContent, /local backup could not be verified/i);
});

test("declining first-time cloud activation leaves local mode untouched", async () => {
  const { elements, window, calls } = makeSyncCenter({ activeLibraryUid: "local", confirm: false });
  await elements.get("syncCenterRetry").listeners.get("click")();

  assert.equal(calls.confirm, 1);
  assert.equal(calls.load, 0);
  assert.equal(calls.sync, 0);
  assert.equal(window.snapNotesDataUid, "local");
});

test("account deletion processing blocks first-time sync before confirmation or cloud loading", async () => {
  const { elements, window, calls } = makeSyncCenter({
    activeLibraryUid: "local",
    deletionStatus: { status: "processing", tombstone: true }
  });
  await elements.get("syncCenterRetry").listeners.get("click")();

  assert.equal(calls.deletionRead, 1);
  assert.equal(calls.confirm, 0);
  assert.equal(calls.load, 0);
  assert.equal(window.snapNotesDataUid, "local");
  assert.match(elements.get("syncCenterStatus").textContent, /account deletion is being processed/i);
});

test("an unverified cloud library load rolls the PWA back to local mode", async () => {
  const { elements, window, calls } = makeSyncCenter({
    activeLibraryUid: "local",
    confirm: true,
    cloudReady: false
  });
  await elements.get("syncCenterRetry").listeners.get("click")();

  assert.equal(calls.load, 1);
  assert.equal(window.snapNotesDataUid, "local");
  assert.match(elements.get("syncCenterStatus").textContent, /cloud library could not be verified/i);
});
