import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canRetryAttachmentUploads, isAttachmentOwnedByUser } from '../js/attachment-ownership.js';
import { isLibraryBoundToUser, rootSnapshotBelongsToLibrary, shouldSyncPendingChanges } from '../js/cloud-sync-guard.js';
import { createAuthTransitionGuard } from '../js/auth-transition-guard.js';

function makeHarness({ dataUid = 'local', localLibrary = { notes: [{ id: 'local-note' }], folders: [] }, failApplyOnce = false } = {}) {
  const localNotes = [{ id: 'local-note' }];
  const writes = { firestore: 0, localStorage: 0, attachments: 0, deletionMarkers: 0 };
  const events = [];
  let currentDataUid = dataUid;
  let appliedLibrary = null;
  let applyFailed = false;
  const transition = createAuthTransitionGuard({
    getDataUid: () => currentDataUid,
    setDataUid: uid => { currentDataUid = uid; events.push(['set-memory-library-id', uid]); },
    readLocalLibrary: async () => { events.push(['read-local']); return localLibrary; },
    applyLocalLibrary: async snapshot => {
      if (failApplyOnce && !applyFailed) {
        applyFailed = true;
        throw new Error('mock render/apply failure');
      }
      appliedLibrary = snapshot;
      events.push(['apply-in-memory', snapshot]);
    },
    clearPrivateUnlock: () => events.push(['clear-private-unlock-memory-only'])
  });
  return {
    localNotes,
    writes,
    events,
    transition,
    getDataUid: () => currentDataUid,
    getAppliedLibrary: () => appliedLibrary
  };
}

test('sign-in from local mode leaves local notes unchanged and does not associate them with the account', async () => {
  const harness = makeHarness();
  const before = structuredClone(harness.localNotes);
  const result = await harness.transition({ uid: 'account-a' });

  assert.equal(result.changed, true);
  assert.equal(result.libraryUid, 'local');
  assert.equal(harness.getDataUid(), 'local');
  assert.deepEqual(harness.localNotes, before);
  assert.equal(harness.events.some(([name]) => name === 'read-local'), false);
  assert.deepEqual(harness.writes, { firestore: 0, localStorage: 0, attachments: 0, deletionMarkers: 0 });
});

test('sign-out from an account library restores only the read local snapshot in memory', async () => {
  const snapshot = { notes: [{ id: 'device-note' }], folders: [{ id: 'device-folder' }] };
  const harness = makeHarness({ dataUid: 'account-a', localLibrary: snapshot });
  await harness.transition({ uid: 'account-a' });
  const result = await harness.transition(null);

  assert.equal(result.changed, true);
  assert.equal(result.restoredLocal, true);
  assert.equal(harness.getDataUid(), 'local');
  assert.deepEqual(harness.getAppliedLibrary(), snapshot);
  assert.equal(harness.events.some(([name]) => name === 'read-local'), true);
  assert.deepEqual(harness.writes, { firestore: 0, localStorage: 0, attachments: 0, deletionMarkers: 0 });
});

test('switching from account A to B never reuses A notes and keeps local mode', async () => {
  const snapshot = { notes: [{ id: 'local-note' }], folders: [] };
  const harness = makeHarness({ dataUid: 'account-a', localLibrary: snapshot });
  await harness.transition({ uid: 'account-a' });
  const result = await harness.transition({ uid: 'account-b' });

  assert.equal(result.previousUid, 'account-a');
  assert.equal(result.nextUid, 'account-b');
  assert.equal(result.restoredLocal, true);
  assert.equal(harness.getDataUid(), 'local');
  assert.deepEqual(harness.getAppliedLibrary(), snapshot);
  assert.deepEqual(harness.writes, { firestore: 0, localStorage: 0, attachments: 0, deletionMarkers: 0 });
});

test('failed local restore clears the active account identity and applies an empty in-memory library', async () => {
  const harness = makeHarness({ dataUid: 'account-a', failApplyOnce: true });
  await harness.transition({ uid: 'account-a' });
  const result = await harness.transition(null);

  assert.equal(result.restoredLocal, true);
  assert.equal(harness.getDataUid(), 'local');
  assert.deepEqual(harness.getAppliedLibrary(), { notes: [], folders: [] });
  assert.deepEqual(harness.writes, { firestore: 0, localStorage: 0, attachments: 0, deletionMarkers: 0 });
});

test('repeated Firebase observer update for the same account has no library side effects', async () => {
  const harness = makeHarness({ dataUid: 'account-a' });
  await harness.transition({ uid: 'account-a' });
  harness.events.length = 0;
  const result = await harness.transition({ uid: 'account-a', emailVerified: true });

  assert.equal(result.changed, false);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.writes, { firestore: 0, localStorage: 0, attachments: 0, deletionMarkers: 0 });
});

test('local-only notes stay blocked from Firestore while offline and after reconnect', () => {
  assert.equal(isLibraryBoundToUser(undefined, 'account-a'), false);
  assert.equal(isLibraryBoundToUser('local', 'account-a'), false);
  assert.equal(shouldSyncPendingChanges({
    uid: 'account-a', authUid: 'account-a', activeLibraryUid: 'local', online: false, pending: true
  }), false);
  assert.equal(shouldSyncPendingChanges({
    uid: 'account-a', authUid: 'account-a', activeLibraryUid: 'local', online: true, pending: true
  }), false);
  assert.equal(shouldSyncPendingChanges({
    uid: 'account-a', authUid: 'account-a', activeLibraryUid: 'account-a', online: false, pending: true
  }), false);
  assert.equal(shouldSyncPendingChanges({
    uid: 'account-a', authUid: 'account-a', activeLibraryUid: 'account-a', online: true, pending: true
  }), true);
  assert.equal(shouldSyncPendingChanges({
    uid: 'account-a', authUid: 'account-b', activeLibraryUid: 'account-a', online: true, pending: true
  }), false);
});

test('a root localStorage snapshot is never read as another library and folder saves respect its owner', () => {
  assert.equal(rootSnapshotBelongsToLibrary(null, 'local'), true);
  assert.equal(rootSnapshotBelongsToLibrary('account-a', 'account-a'), true);
  assert.equal(rootSnapshotBelongsToLibrary('account-a', 'local'), false);
  assert.equal(rootSnapshotBelongsToLibrary('account-a', 'account-b'), false);

  const storageSource = readFileSync(new URL('../js/storage.js', import.meta.url), 'utf8');
  assert.match(storageSource, /rootSnapshotBelongsToLibrary\(rootLibraryUid, libraryId\)/);
  assert.match(storageSource, /SnapNotesRootLibraryUid/);
  const folderSource = readFileSync(new URL('../js/folders.js', import.meta.url), 'utf8');
  assert.match(folderSource, /rootLibraryUid !== null && rootLibraryUid !== activeLibraryUid/);
  const saveStart = folderSource.indexOf('function saveFolders()');
  const saveEnd = folderSource.indexOf('\nfunction getFolders()', saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  assert.match(folderSource.slice(saveStart, saveEnd), /rootLibraryUid === null \|\| rootLibraryUid === libraryId[\s\S]*?localStorage\.setItem\(FOLDERS_KEY/);
});

test('attachment upload ownership requires an exact non-empty UID match', () => {
  assert.equal(isAttachmentOwnedByUser('account-a', 'account-a'), true);
  assert.equal(isAttachmentOwnedByUser('account-a', 'account-b'), false);
  assert.equal(isAttachmentOwnedByUser(null, 'account-a'), false);
  assert.equal(isAttachmentOwnedByUser('', 'account-a'), false);
  assert.equal(isAttachmentOwnedByUser('account-a', ''), false);
  assert.equal(canRetryAttachmentUploads('account-a', 'account-a'), true);
  assert.equal(canRetryAttachmentUploads('local', 'account-a'), false);
  assert.equal(canRetryAttachmentUploads('account-b', 'account-a'), false);
  assert.equal(canRetryAttachmentUploads('account-a', ''), false);
});

test('auth and reconnect integration has no automatic transition writes or attachment retries', () => {
  const authSource = readFileSync(new URL('../js/auth.js', import.meta.url), 'utf8');
  const observerStart = authSource.indexOf('onAuthStateChanged(auth, async user => {');
  assert.notEqual(observerStart, -1);
  const observerEnd = authSource.indexOf('\n});', observerStart);
  assert.notEqual(observerEnd, -1);
  const observer = authSource.slice(observerStart, observerEnd);
  assert.match(observer, /handleAuthTransition\(user\)/);
  assert.doesNotMatch(observer, /loadFromCloud|persistLocalLibrary|cacheAccountBeforeSignOut|restoreAccountCache|retryPendingAttachmentUploads|clearLocalAccountDataForDeletion/);
  assert.doesNotMatch(observer, /localStorage\.(setItem|removeItem)/);
  const deletionStart = authSource.indexOf('async function reportScheduledAccountDeletion');
  const deletionEnd = authSource.indexOf('\nasync function readLocalLibraryForAuthTransition', deletionStart);
  assert.ok(deletionStart >= 0 && deletionEnd > deletionStart);
  assert.doesNotMatch(authSource.slice(deletionStart, deletionEnd), /clearLocalAccountDataForDeletion/);
  const signOutStart = authSource.indexOf('userAvatar.addEventListener("click", () => {');
  const signOutEnd = authSource.indexOf('\n});', signOutStart);
  assert.ok(signOutStart >= 0 && signOutEnd > signOutStart);
  assert.doesNotMatch(authSource.slice(signOutStart, signOutEnd), /cacheAccountBeforeSignOut|persistLocalLibrary|localStorage\.(setItem|removeItem)|window\.notes\s*=/);

  const attachmentSource = readFileSync(new URL('../js/attachments.js', import.meta.url), 'utf8');
  const authListenerStart = attachmentSource.indexOf('window.addEventListener("snapnotes:auth-changed"');
  const authListenerEnd = attachmentSource.indexOf('\n});', authListenerStart);
  const authListener = attachmentSource.slice(authListenerStart, authListenerEnd);
  assert.match(authListener, /updateAttachmentAccess/);
  assert.doesNotMatch(authListener, /retryPendingAttachmentUploads|retryPendingAttachmentCleanup/);
  assert.match(attachmentSource, /isAttachmentOwnedByUser\(record\?\.uid, currentUid\)/);
  assert.match(attachmentSource, /canRetryAttachmentUploads\(window\.snapNotesDataUid, currentUid\)/);
  assert.match(attachmentSource, /canRetryAttachmentUploads\(window\.snapNotesDataUid, expectedUid\)/);

  const firestoreSource = readFileSync(new URL('../js/firestore.js', import.meta.url), 'utf8');
  assert.match(firestoreSource, /function belongsToCurrentAccount\(uid\)[\s\S]*?isLibraryBoundToUser\(window\.snapNotesDataUid, uid\)/);
  assert.match(firestoreSource, /shouldSyncPendingChanges\(\{[\s\S]*?activeLibraryUid: window\.snapNotesDataUid[\s\S]*?online: navigator\.onLine/);
  const storageSource = readFileSync(new URL('../js/storage.js', import.meta.url), 'utf8');
  assert.match(storageSource, /if \(window\.snapNotesDataUid === undefined\) window\.snapNotesDataUid = "local"/);
  assert.match(storageSource, /isLibraryBoundToUser\(String\(libraryId\), syncUid\)/);
});
