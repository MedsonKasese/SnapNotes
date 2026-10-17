import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const syncCenterSource = await readFile(new URL("../js/sync-center.js", import.meta.url), "utf8");

function makeSyncCenter({ syncToCloud }) {
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
  const values = new Map();
  const window = {
    firebaseAuth: { currentUser: { uid: "user-1" } },
    syncToCloud,
    retryPendingAttachmentUploads: async () => {},
    retryPendingAttachmentCleanup: async () => {},
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
  return { elements, localStorage, window };
}

test("successful background sync clears a previous manual retry error", async () => {
  const { elements, window } = makeSyncCenter({ syncToCloud: async () => false });
  const status = elements.get("syncCenterStatus");
  const last = elements.get("syncCenterLast");
  const retry = elements.get("syncCenterRetry");

  await retry.listeners.get("click")();
  assert.equal(status.textContent, "Cloud note sync did not complete. Please retry.");

  window.dispatchEvent({
    type: "snapnotes:sync-status",
    detail: { status: "synced", uid: "user-1" }
  });

  assert.equal(status.textContent, "Last cloud note synchronization succeeded.");
  assert.match(last.textContent, /^Last confirmed note sync: /);
});
