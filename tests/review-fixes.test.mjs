import test from "node:test";
import assert from "node:assert/strict";
import { safeNotes } from "../api/ai-notes.js";
import { buildPrivatePayload, lockedPrivateNote, privateNoteMetadataNeedsMigration, stripPrivateMetadata } from "../js/private-note-utils.js";
import { mergeNotes, packLibraryPages, noteSignature, noteTimestamp } from "../js/note-sync.js";
import { createCloudSessionGuard } from "../js/cloud-session.js";
import { enqueueAndProcessAttachmentCleanup, ATTACHMENT_CLEANUP_KEY } from "../js/attachment-cleanup.js";
import { renderSettingsAccount } from "../js/settings-account.js";
import { migrateLegacyDraft, readDrafts, removeDraft, upsertDraft } from "../js/drafts.js";
import { renderSubtitleMarkdownText } from "../js/note-format.js";
import { hasPrivatePasskey, registerPrivatePasskey, removePrivatePasskey, unlockPrivateKeyWithPasskey } from "../js/private-passkey.js";
import { webcrypto } from "node:crypto";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.text = "";
    this.className = "";
    this.src = "";
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_value) { throw new Error("innerHTML must not be used for account data"); }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = [...items]; this.text = ""; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
}

const fakeDocument = { createElement: tag => new FakeElement(tag) };

test("recovery drafts migrate from the previous single-draft key and retain metadata", () => {
  const storage = memoryStorage();
  storage.setItem("SnapNotesDraft", JSON.stringify({
    content: "<div>## Plan</div><div>Unfinished</div>",
    category: "work",
    tags: ["project"],
    reminderAt: "2026-10-16T09:00",
    savedAt: "2026-10-15T08:00:00.000Z"
  }));

  const drafts = migrateLegacyDraft(storage);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].id, /.+/);
  assert.equal(drafts[0].category, "work");
  assert.deepEqual(drafts[0].tags, ["project"]);
  assert.equal(storage.getItem("SnapNotesDraft"), null);
  assert.equal(readDrafts(storage)[0].content, "<div>## Plan</div><div>Unfinished</div>");
});

test("recovery drafts support multiple entries and update the same draft in place", () => {
  const storage = memoryStorage();
  upsertDraft({ id: "draft-a", content: "first", text: "first" }, storage);
  upsertDraft({ id: "draft-b", content: "second", text: "second" }, storage);
  upsertDraft({ id: "draft-a", content: "updated", text: "updated" }, storage);

  assert.equal(readDrafts(storage).length, 2);
  assert.equal(readDrafts(storage).find(draft => draft.id === "draft-a").text, "updated");
  assert.equal(removeDraft("draft-b", storage).length, 1);
});

test("double-asterisk subtitle lines render as safe headings without changing ordinary text", () => {
  const html = renderSubtitleMarkdownText("Intro\n**Highlights**\n**<script>alert(1)</script>**\n**not a subtitle** trailing");
  assert.equal(html, "Intro<br><h3 class=\"note-subtitle\">Highlights</h3><br><h3 class=\"note-subtitle\">&lt;script&gt;alert(1)&lt;/script&gt;</h3><br>**not a subtitle** trailing");
});

test("Ask My Notes filters ineligible entries before applying its eight-note limit", () => {
  const ineligible = Array.from({ length: 10 }, (_, index) => ({ id: `private-${index}`, text: "secret", isPrivate: true }));
  const eligible = Array.from({ length: 10 }, (_, index) => ({ id: `regular-${index}`, text: `body ${index}` }));
  const result = safeNotes([...ineligible, ...eligible]);
  assert.equal(result.length, 8);
  assert.deepEqual(result.map(note => note.id), eligible.slice(0, 8).map(note => note.id));
});

test("Ask My Notes excludes archived, trashed, malformed, and conflict notes", () => {
  const result = safeNotes([
    null,
    { id: "private", text: "secret", isPrivate: true },
    { id: "archived", text: "old", archived: true },
    { id: "trash", text: "gone", deletedAt: "2026-01-01" },
    { id: "conflict", text: "copy", syncConflict: true },
    { id: "ok", text: "eligible" }
  ]);
  assert.deepEqual(result.map(note => note.id), ["ok"]);
});

test("private payload preserves metadata for encryption while locked projection reveals none", () => {
  const source = {
    id: "p1", isPrivate: true, title: "Secret", text: "Body", category: "work", tags: ["x"],
    folderId: "folder-secret", reminderAt: "2026-10-15T09:00:00Z", reminderNotified: false,
    attachments: [{ id: "a1", name: "confidential.pdf", storagePath: "users/u/attachments/n/a" }],
    versions: [{ title: "Old", text: "Old body" }]
  };
  const payload = buildPrivatePayload(source);
  assert.equal(payload.reminderAt, source.reminderAt);
  assert.equal(payload.attachments[0].name, "confidential.pdf");
  assert.equal(payload.history[0].text, "Old body");
  assert.equal(privateNoteMetadataNeedsMigration(source), true);
  const locked = lockedPrivateNote(source);
  assert.equal(locked.title, "Private note");
  assert.equal(locked.reminderAt, null);
  assert.equal(locked.folderId, null);
  assert.deepEqual(locked.attachments, []);
  stripPrivateMetadata(source);
  assert.equal(source.title, "Private note");
  assert.equal(source.text, "");
  assert.deepEqual(source.versions, []);
  assert.equal("attachments" in source, false);
  assert.equal("folderId" in source, false);
  assert.equal(source.reminderAt, null);
});

test("passkey PRF wraps and restores the private-note key without removing password fallback", async () => {
  const descriptors = new Map();
  const define = (name, value) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const storage = memoryStorage();
  const credentialId = Uint8Array.from([1, 2, 3, 4]).buffer;
  const prfOutput = Uint8Array.from({ length: 32 }, (_, index) => index + 7);
  define("crypto", webcrypto);
  define("isSecureContext", true);
  define("location", { hostname: "localhost" });
  define("PublicKeyCredential", class {});
  define("navigator", {
    credentials: {
      async create({ publicKey }) {
        assert.equal(publicKey.rp.id, "localhost");
        assert.deepEqual(publicKey.extensions, { prf: {} });
        return { rawId: credentialId, getClientExtensionResults: () => ({ prf: { enabled: true } }) };
      },
      async get({ publicKey }) {
        assert.equal(publicKey.userVerification, "required");
        assert.ok(publicKey.extensions.prf.eval.first instanceof Uint8Array);
        return { getClientExtensionResults: () => ({ prf: { results: { first: prfOutput.slice().buffer } } }) };
      }
    }
  });

  try {
    const original = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    assert.equal(await registerPrivatePasskey(original, storage), true);
    assert.equal(hasPrivatePasskey(storage), true);
    const unlocked = await unlockPrivateKeyWithPasskey(storage);
    assert.deepEqual(
      new Uint8Array(await webcrypto.subtle.exportKey("raw", unlocked)),
      new Uint8Array(await webcrypto.subtle.exportKey("raw", original))
    );
    removePrivatePasskey(storage);
    assert.equal(hasPrivatePasskey(storage), false);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("cloud load generation rejects stale A-to-B and A-to-B-to-A responses", () => {
  const guard = createCloudSessionGuard();
  guard.advance("A");
  const overlappingOldA = guard.capture("A");
  const overlappingNewA = guard.capture("A");
  assert.equal(guard.isCurrent(overlappingOldA, "A"), false);
  assert.equal(guard.isCurrent(overlappingNewA, "A"), true);
  const oldA = guard.capture("A");
  guard.advance("B");
  assert.equal(guard.isCurrent(oldA, "B"), false);
  guard.advance("A");
  assert.equal(guard.isCurrent(oldA, "A"), false);
  const currentA = guard.capture("A");
  assert.equal(guard.isCurrent(currentA, "A"), true);
});

test("merge preserves divergent versions with different timestamps and is idempotent", () => {
  const cloud = { id: "n1", title: "Plan", text: "Cloud", createdAt: "2026-01-01", updatedAt: "2026-01-02" };
  const local = { ...cloud, text: "Local", updatedAt: "2026-01-03" };
  assert.notEqual(noteSignature(cloud), noteSignature(local));
  const merged = mergeNotes([local], [cloud]);
  assert.equal(merged.find(note => note.id === "n1").text, "Local");
  const conflict = merged.find(note => note.syncConflict);
  assert.equal(conflict.text, "Cloud");
  assert.equal(conflict.conflictOf, "n1");
  const secondMerge = mergeNotes(merged, merged);
  assert.equal(secondMerge.filter(note => note.syncConflict).length, 1);
  assert.equal(secondMerge.find(note => note.syncConflict).id, conflict.id);
});

test("merge detects reminder-only, attachment-metadata, and version-history divergence", () => {
  const base = { id: "n1", text: "same", reminderAt: null, versions: [], attachments: [{ id: "a1", name: "one.pdf" }] };
  const changed = { ...base, reminderAt: "2026-10-15T09:00:00Z", versions: [{ text: "prior" }], attachments: [{ id: "a1", name: "renamed.pdf" }] };
  assert.equal(mergeNotes([base], [changed]).filter(note => note.syncConflict).length, 1);
});

test("merge treats invalid timestamps as oldest and preserves the divergent cloud version", () => {
  const cloud = { id: "n1", title: "Plan", text: "Cloud", updatedAt: "not-a-date" };
  const local = { ...cloud, text: "Local", updatedAt: "2026-01-03T00:00:00Z" };
  assert.equal(noteTimestamp(cloud), 0);
  const merged = mergeNotes([local], [cloud]);
  assert.equal(merged.find(note => note.id === "n1").text, "Local");
  assert.equal(merged.find(note => note.syncConflict).text, "Cloud");
});

test("Firestore library pages remain below the byte limit and reject oversized records", () => {
  const notes = Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: "x".repeat(80) }));
  const pages = packLibraryPages(notes, [], 250);
  assert.ok(pages.length > 1);
  for (const page of pages) assert.ok(new TextEncoder().encode(JSON.stringify(page)).length <= 250);
  assert.throws(() => packLibraryPages([{ id: "too-large", text: "x".repeat(500) }], [], 100), RangeError);
});

test("attachment cleanup records a durable retry when remote cleanup fails", async () => {
  const storage = memoryStorage();
  let localDeletes = 0;
  let remoteAttempts = 0;
  const result = await enqueueAndProcessAttachmentCleanup([
    { id: "a1", storageProvider: "supabase", storagePath: "users/u/attachments/n/a1" }
  ], {
    storage,
    currentUid: "u",
    removeLocal: async () => { localDeletes++; },
    removeRemote: async () => { remoteAttempts++; throw new Error("offline"); }
  });
  assert.equal(result.pendingCount, 1);
  assert.equal(localDeletes, 1);
  assert.equal(remoteAttempts, 1);
  const queued = JSON.parse(storage.getItem(ATTACHMENT_CLEANUP_KEY));
  assert.equal(queued[0].remoteDone, false);
  assert.equal(queued[0].localDone, true);
});

test("attachment cleanup retains remote-only objects for retry", async () => {
  const storage = memoryStorage();
  const result = await enqueueAndProcessAttachmentCleanup([
    { storageProvider: "supabase", storagePath: "users/u/attachments/n/remote-only" }
  ], {
    storage,
    currentUid: "u",
    removeLocal: async () => { throw new Error("no local ID should be removed"); },
    removeRemote: async () => { throw new Error("offline"); }
  });
  assert.equal(result.pendingCount, 1);
  const queued = JSON.parse(storage.getItem(ATTACHMENT_CLEANUP_KEY));
  assert.equal(queued[0].storagePath, "users/u/attachments/n/remote-only");
});

test("attachment cleanup does not delete another account's object", async () => {
  const storage = memoryStorage();
  let remoteDeletes = 0;
  const result = await enqueueAndProcessAttachmentCleanup([
    { id: "a1", storageProvider: "supabase", storagePath: "users/user-a/attachments/n/a1" }
  ], {
    storage,
    currentUid: "user-b",
    removeLocal: async () => {},
    removeRemote: async () => { remoteDeletes++; }
  });
  assert.equal(remoteDeletes, 0);
  assert.equal(result.pendingCount, 1);
});

test("account settings render profile data as literal text and reject unsafe photo schemes", () => {
  const payload = `<img src=x onerror=alert(1)>`;
  const root = new FakeElement("section");
  renderSettingsAccount(root, {
    displayName: payload,
    email: "me@example.com",
    photoURL: "javascript:alert(1)",
    providerData: [{ providerId: "password" }]
  }, fakeDocument);
  assert.ok(root.textContent.includes(payload));
  assert.ok(root.textContent.includes("me@example.com"));
  const avatar = root.children[0];
  assert.equal(avatar.children[0].tagName, "SPAN");
  assert.equal(avatar.children[0].textContent, "<S");
});
