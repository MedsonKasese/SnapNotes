import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
  createPrivateRecoveryCopy,
  ensurePrivateNotesPreserved,
  isEncryptedPrivateNote,
  localPrivateSnapshotVerified,
  privateMigrationPreflightComplete,
  planPrivateRecordReconciliation,
  preservePrivateNotesBeforeCommit,
  privateRecordFingerprint,
  privateRecordsForCleanup,
  splitPrivateNotesFromLibrary,
  stablePrivateRecordJson
} from "../js/private-note-separation.js";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

function privateNote(id, { updatedAt = "2026-11-01T00:00:00.000Z", ciphertext = "Y2lwaGVydGV4dA==", extra = {} } = {}) {
  return {
    id,
    isPrivate: true,
    title: "Private note",
    text: "",
    html: "",
    category: "general",
    tags: [],
    time: "Private note",
    reminderAt: null,
    reminderNotified: false,
    reminderRepeat: null,
    versions: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    privateData: {
      version: 1,
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA-256",
      iterations: 600000,
      salt: "c2FsdA==",
      iv: "aXY=",
      ciphertext
    },
    ...extra
  };
}

function fakeStore({ failVersionRead = false } = {}) {
  const current = new Map();
  const versions = new Map();
  return {
    current,
    versions,
    async reconcile(incoming) {
      const plan = planPrivateRecordReconciliation(current.get(incoming.id), incoming);
      for (const record of plan.archivedRecords) {
        const fingerprint = await privateRecordFingerprint(record);
        versions.set(fingerprint, {
          noteId: record.id,
          documentKey: encodeURIComponent(record.id),
          fingerprint,
          record: structuredClone(record)
        });
      }
      current.set(incoming.id, structuredClone(plan.canonical));
      return plan;
    },
    async readCurrent(id) { return current.has(id) ? structuredClone(current.get(id)) : null; },
    async readVersion(id) {
      if (failVersionRead) return null;
      return versions.has(id) ? structuredClone(versions.get(id)) : null;
    }
  };
}

test("ordinary cloud snapshots exclude private records without mutating local records", () => {
  const regular = { id: "regular", title: "Visible" };
  const privateRecord = privateNote("private-1");
  const source = [regular, privateRecord];
  const split = splitPrivateNotesFromLibrary(source);
  assert.deepEqual(split.notes, [regular]);
  assert.deepEqual(split.privateNotes, [privateRecord]);
  assert.deepEqual(source, [regular, privateRecord]);
});

test("private-record validation rejects plaintext metadata, unknown fields, and invalid encryption envelopes", () => {
  const valid = privateNote("private-1");
  assert.equal(isEncryptedPrivateNote(valid), true);
  assert.equal(isEncryptedPrivateNote({ ...valid, title: "Sensitive title" }), false);
  assert.equal(isEncryptedPrivateNote({ ...valid, decryptedContent: "must not sync" }), false);
  assert.equal(isEncryptedPrivateNote({ ...valid, privateData: { ...valid.privateData, algorithm: "AES-CBC" } }), false);
  assert.equal(isEncryptedPrivateNote(null), false);
});

test("separation preserves an initial encrypted record and verifies it after writing", async () => {
  const note = privateNote("private-1");
  const store = fakeStore();
  const result = await ensurePrivateNotesPreserved([note], store);
  assert.deepEqual(result, { preserved: 1 });
  assert.equal(stablePrivateRecordJson(await store.readCurrent(note.id)), stablePrivateRecordJson(note));
});

test("divergent encrypted variants are kept in an archive while the newer canonical version wins", async () => {
  const old = privateNote("private-1", { updatedAt: "2026-11-01T00:00:00.000Z", ciphertext: "b2xk" });
  const newer = privateNote("private-1", { updatedAt: "2026-11-02T00:00:00.000Z", ciphertext: "bmV3" });
  const plan = planPrivateRecordReconciliation(old, newer);
  assert.equal(stablePrivateRecordJson(plan.canonical), stablePrivateRecordJson(newer));
  assert.equal(plan.archivedRecords.length, 1);
  assert.equal(stablePrivateRecordJson(plan.archivedRecords[0]), stablePrivateRecordJson(old));

  const store = fakeStore();
  store.current.set(old.id, old);
  const result = await ensurePrivateNotesPreserved([newer], store);
  const oldFingerprint = await privateRecordFingerprint(old);
  assert.deepEqual(result, { preserved: 1 });
  assert.equal(stablePrivateRecordJson(await store.readCurrent(old.id)), stablePrivateRecordJson(newer));
  assert.equal(stablePrivateRecordJson((await store.readVersion(oldFingerprint)).record), stablePrivateRecordJson(old));
});

test("equal-timestamp conflicts retain the ordered incoming winner and archive the displaced copy", () => {
  const existing = privateNote("private-1", { ciphertext: "Y2xvdWQ=" });
  const incoming = privateNote("private-1", { ciphertext: "bG9jYWw=" });
  const plan = planPrivateRecordReconciliation(existing, incoming);
  assert.equal(stablePrivateRecordJson(plan.canonical), stablePrivateRecordJson(incoming));
  assert.equal(stablePrivateRecordJson(plan.archivedRecords[0]), stablePrivateRecordJson(existing));
});

test("archived encrypted variants become clearly marked recoverable Private Notes without changing ciphertext", async () => {
  const source = privateNote("private-1", { ciphertext: "c2F2ZWQtY2lwaGVydGV4dA==" });
  const fingerprint = await privateRecordFingerprint(source);
  const recovery = createPrivateRecoveryCopy(source, fingerprint);
  assert.equal(recovery.privateRecovery, true);
  assert.equal(recovery.privateRecoveryFingerprint, fingerprint);
  assert.equal(recovery.privateData.ciphertext, source.privateData.ciphertext);
  assert.notEqual(recovery.id, source.id);
  assert.equal(isEncryptedPrivateNote(recovery), true);
});

test("a failed preservation read-back prevents the ordinary snapshot commit and leaves its source unchanged", async () => {
  const sourceSnapshot = [privateNote("private-1", { ciphertext: "b2xk" })];
  const before = structuredClone(sourceSnapshot);
  const next = privateNote("private-1", { updatedAt: "2026-11-03T00:00:00.000Z", ciphertext: "bmV3" });
  const store = fakeStore({ failVersionRead: true });
  store.current.set(sourceSnapshot[0].id, structuredClone(sourceSnapshot[0]));
  let commitCalls = 0;

  await assert.rejects(() => preservePrivateNotesBeforeCommit({
    candidates: [next],
    store,
    commit: async () => { commitCalls++; return true; }
  }), /could not verify an archived encrypted version/i);

  assert.equal(commitCalls, 0, "ordinary pages and the active pointer must not be committed before preservation verifies");
  assert.deepEqual(sourceSnapshot, before, "the old snapshot remains intact for retry or rollback");
});

test("a failed local sanitation save prevents ordinary Firestore commit", async () => {
  const note = privateNote("private-1");
  const store = fakeStore();
  let commitCalls = 0;
  const result = await preservePrivateNotesBeforeCommit({
    candidates: [note],
    store,
    beforeCommit: async () => false,
    commit: async () => { commitCalls++; return true; }
  });
  assert.equal(result.committed, false);
  assert.equal(commitCalls, 0);
});

test("local sanitation requires verified writes to both IndexedDB and localStorage", () => {
  assert.equal(localPrivateSnapshotVerified({ indexedDbSaved: true, localStorageSaved: true }, true), true);
  assert.equal(localPrivateSnapshotVerified({ indexedDbSaved: true, localStorageSaved: false }, true), false);
  assert.equal(localPrivateSnapshotVerified({ indexedDbSaved: false, localStorageSaved: true }, true), false);
  assert.equal(localPrivateSnapshotVerified({ indexedDbSaved: true, localStorageSaved: true }, false), false);
});

test("the Admin inventory preflight is fail-closed and requires a non-empty inventory ID", () => {
  assert.equal(privateMigrationPreflightComplete({ complete: true, inventoryId: "audit-2026-11" }), true);
  assert.equal(privateMigrationPreflightComplete({ complete: true, inventoryId: "  " }), false);
  assert.equal(privateMigrationPreflightComplete({ complete: false, inventoryId: "audit-2026-11" }), false);
  assert.equal(privateMigrationPreflightComplete(null), false);
});

test("permanent deletion and move-out select existing private records and all matching recovery lineage", () => {
  const records = [
    privateNote("deleted-original"),
    { ...privateNote("recovered-from-deleted"), privateRecovery: true,
      privateRecoveryFingerprint: "a".repeat(64), privateRecoverySourceId: "deleted-original",
      privateRecoveryParentId: "deleted-original" },
    { ...privateNote("recovered-child"), privateRecovery: true,
      privateRecoveryFingerprint: "b".repeat(64), privateRecoverySourceId: "root",
      privateRecoveryParentId: "moved-parent" },
    privateNote("unrelated")
  ];
  const selected = privateRecordsForCleanup(records, new Set(["deleted-original"]), new Set(["moved-parent"]));
  assert.deepEqual([...selected.keys()], ["deleted-original", "recovered-from-deleted", "recovered-child"]);
});

test("preservation is idempotent for an already verified record", async () => {
  const note = privateNote("private-1");
  const store = fakeStore();
  const first = await ensurePrivateNotesPreserved([note], store);
  const second = await ensurePrivateNotesPreserved([note], store);
  assert.deepEqual(first, { preserved: 1 });
  assert.deepEqual(second, { preserved: 1 });
  assert.equal(store.versions.size, 0);
});

test("Firestore sync verifies private preservation before it stages ordinary pages and marks schema v3", () => {
  const source = readFileSync(new URL("../js/firestore.js", import.meta.url), "utf8");
  const syncStart = source.indexOf("async function performSync(uid)");
  const syncEnd = source.indexOf("export function syncToCloud", syncStart);
  const performSync = source.slice(syncStart, syncEnd);
  assert.ok(syncStart >= 0 && syncEnd > syncStart);
  assert.ok(performSync.indexOf("await preservePrivateNotesBeforeCommit") < performSync.indexOf("stagedRevision = crypto.randomUUID()"));
  assert.match(performSync, /const notes = splitLibrary\.notes/);
  assert.match(performSync, /privateNotesSeparated: true/);
  assert.match(performSync, /syncVersion: 3/);
  assert.match(performSync, /beforeCommit: async \(\) =>/);
  assert.match(performSync, /persistLocalLibrary\?\./);
  assert.match(performSync, /localPrivateSnapshotVerified\(persisted, localStorageMatches\)/);
  assert.match(performSync, /privateMigrationPreflightComplete\(preflightSnapshot\.data\(\) \|\| \{\}\)/);
  assert.ok(performSync.indexOf("privateMigrationPreflightComplete") < performSync.indexOf("await preservePrivateNotesBeforeCommit"));
  assert.ok(performSync.indexOf("privateMigrationPreflightComplete") < performSync.indexOf("await persistNoteDeletionMarkers"));
  assert.ok(performSync.indexOf("readCleanupSnapshot") < performSync.indexOf("stagedRevision = crypto.randomUUID()"));
  assert.match(performSync, /pages = packLibraryPages\(notes, folders\)\.map\(page => \(\{\s*\.\.\.page,\s*syncVersion: 3,\s*schemaWriteNonce: crypto\.randomUUID\(\)/);
  assert.match(performSync, /privateNotesSchemaRequired: true/);
  assert.match(source, /cloudNotes = \[\.\.\.cloudNotes, \.\.\.detachedPrivateNotes\]/);
  assert.match(source, /getDocs\(collection\(db, "users", uid, PRIVATE_NOTE_VERSION_COLLECTION\)\)/);
  assert.match(source, /transaction\.set\(revisionRef/);
  assert.match(source, /currentRevision !== expectedRevisions\.get\(id\)/);
  assert.match(source, /privateRevisionsExpectedForRemoval/);
  assert.match(source, /A Private Note changed during move-out or deletion/);
});

test("Firestore rules bind private records to document keys and keep deletion markers immutable", () => {
  const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  assert.match(rules, /record\.documentKey == noteId/);
  assert.match(rules, /version\.record\.documentKey == version\.documentKey/);
  assert.match(rules, /version\.fingerprint == versionId/);
  assert.match(rules, /archiveRevisionBumped\(uid, version\.documentKey, version\.noteId\)/);
  assert.match(rules, /getAfter\(revisionPath\)\.data\.revision == get\(revisionPath\)\.data\.revision \+ 1/);
  assert.match(rules, /getAfter\(revisionPath\)\.data\.noteId == noteId/);
  assert.match(rules, /revisionMatchesCanonical\(uid, revisionId, request\.resource\.data\.noteId\)/);
  assert.match(rules, /schemaV3PageWrite\(\)/);
  assert.match(rules, /allow update, delete: if false;/);
  assert.match(rules, /privateNotesSchemaRequired/);
  assert.match(rules, /request\.resource\.data\.schemaWriteNonce != get\(userPath\)\.data\.get\('schemaWriteNonce', ''\)/);
  assert.match(rules, /request\.resource\.data\.schemaWriteNonce != resource\.data\.get\('schemaWriteNonce', ''\)/);
  assert.match(rules, /match \/privateNotesMigrationPreflights\/\{preflightId\}/);
  assert.match(rules, /allow list, create, update, delete: if false;/);
  assert.match(rules, /privateNoteVersions/);
});
