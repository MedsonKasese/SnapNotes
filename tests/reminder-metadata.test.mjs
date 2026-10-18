import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  buildPrivatePayload,
  lockedPrivateNote,
  privateNoteMetadataNeedsMigration,
  stripPrivateMetadata
} from "../js/private-note-utils.js";
import { mergeNotes, noteSignature } from "../js/note-sync.js";

const repeat = { frequency: "weekly", interval: 2, days: [1, 3] };

test("private payload retains cloned reminder repeat metadata while public private-note fields are stripped", () => {
  const source = {
    id: "private-1",
    isPrivate: true,
    title: "Private note",
    reminderAt: "2026-10-19T09:00:00.000Z",
    reminderNotified: false,
    reminderRepeat: structuredClone(repeat)
  };

  assert.equal(privateNoteMetadataNeedsMigration(source), true, "unencrypted repeat metadata must trigger migration");
  const encryptedPayload = buildPrivatePayload(source);
  assert.deepEqual(encryptedPayload.reminderRepeat, repeat);
  assert.notStrictEqual(encryptedPayload.reminderRepeat, source.reminderRepeat);

  stripPrivateMetadata(source);
  assert.equal(source.reminderAt, null);
  assert.equal(source.reminderNotified, false);
  assert.equal(source.reminderRepeat, null, "repeat metadata must not remain in the plaintext note record");
  assert.deepEqual(encryptedPayload.reminderRepeat, repeat, "stripping public fields must not alter the encrypted payload");

  const locked = lockedPrivateNote({ id: "private-1", isPrivate: true, reminderRepeat: repeat });
  assert.equal(locked.reminderRepeat, null, "locked-note presentation must not expose recurrence settings");
});

test("sync signatures and conflict merging detect recurrence-only divergence", () => {
  const cloud = {
    id: "note-1",
    title: "Plan",
    text: "same text",
    reminderAt: "2026-10-19T09:00:00.000Z",
    reminderRepeat: { frequency: "weekly", interval: 1 },
    updatedAt: "2026-10-19T08:00:00.000Z",
    versions: []
  };
  const local = {
    ...structuredClone(cloud),
    reminderRepeat: { frequency: "monthly", interval: 1 },
    updatedAt: "2026-10-19T08:01:00.000Z"
  };

  assert.notEqual(noteSignature(cloud), noteSignature(local));
  const merged = mergeNotes([local], [cloud]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].reminderRepeat, local.reminderRepeat);
  assert.ok(merged[0].versions.some(version =>
    JSON.stringify(version.reminderRepeat) === JSON.stringify(cloud.reminderRepeat)
  ), "the losing recurrence state should be retained in version history");
});

test("version snapshots and restore preserve repeat metadata, and repeat-only edits are distinct", async () => {
  const window = {
    notes: [],
    async saveNotes() {},
    renderNotes() {},
    updateNavigationCounts() {},
    showToast() {}
  };
  const context = vm.createContext({ window, structuredClone, Date, JSON, String, Array, Boolean });
  const source = readFileSync(new URL("../js/version-history.js", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "version-history.js" });

  const original = { title: "Task", text: "Do it", reminderAt: "2026-10-19T09:00:00.000Z", reminderRepeat: { frequency: "weekly" } };
  const snapshot = window.createVersionSnapshot(original);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.reminderRepeat)), original.reminderRepeat);

  const history = window.appendVersion([], original);
  const repeatOnlyEdit = { ...original, reminderRepeat: { frequency: "monthly" } };
  assert.equal(window.appendVersion(history, repeatOnlyEdit).length, 2, "repeat-only changes must be versioned");

  window.notes = [{ id: "note-1", title: "Current", text: "Current body", versions: [] }];
  const restored = { title: "Earlier", text: "Earlier body", reminderRepeat: { frequency: "daily", interval: 3 } };
  assert.equal(await window.restorePublicNoteVersion("note-1", restored), true);
  assert.deepEqual(JSON.parse(JSON.stringify(window.notes[0].reminderRepeat)), restored.reminderRepeat);
});
