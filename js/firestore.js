import { db, auth } from "./firebaseConfig.js";
import {
    collection,
    deleteDoc,
    deleteField,
    doc,
    getDoc,
    getDocs,
    runTransaction,
    setDoc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { createCloudSessionGuard } from "./cloud-session.js";
import { isLibraryBoundToUser, shouldSyncPendingChanges } from "./cloud-sync-guard.js";
import { isLibraryRevisionComplete, mergeNotes, noteSignature, noteTimestamp, packLibraryPages } from "./note-sync.js";
import { clearPermanentNoteDeletions, readPermanentNoteDeletions } from "./note-deletions.js";
import { privateNoteMetadataNeedsMigration } from "./private-note-utils.js";
import {
    createPrivateRecoveryCopy,
    isEncryptedPrivateNote,
    localPrivateSnapshotVerified,
    planPrivateRecordReconciliation,
    preservePrivateNotesBeforeCommit,
    privateRecordFingerprint,
    privateRecordsForCleanup,
    privateMigrationPreflightComplete,
    splitPrivateNotesFromLibrary,
    stablePrivateRecordJson
} from "./private-note-separation.js";

const PENDING_KEY = "SnapNotesSyncPending";
const DELETION_KEY_PREFIX = "SnapNotesAccountDeletion:";
const DELETION_TOMBSTONE_COLLECTION = "accountDeletionTombstones";
const NOTE_DELETION_COLLECTION = "deletedNotes";
const PAGE_COLLECTION = "libraries";
const PRIVATE_NOTE_COLLECTION = "privateNotes";
const PRIVATE_NOTE_VERSION_COLLECTION = "privateNoteVersions";
const PRIVATE_NOTE_REVISION_COLLECTION = "privateNoteRevisions";
const PRIVATE_MIGRATION_PREFLIGHT_COLLECTION = "privateNotesMigrationPreflights";
const sessionGuard = createCloudSessionGuard();
const activeSyncs = new Map();
const cloudReadyUids = new Set();
const recoveryBackupByUid = new Map();

window.addEventListener("snapnotes:auth-changed", event => {
    sessionGuard.advance(event.detail?.user?.uid || null);
    cloudReadyUids.clear();
    recoveryBackupByUid.clear();
});

function getDeviceId() {
    let id = localStorage.getItem("SnapNotesDeviceId");
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("SnapNotesDeviceId", id);
    }
    return id;
}

function getDeviceName() {
    return /Android/i.test(navigator.userAgent) ? "Android device" :
        /iPhone|iPad/i.test(navigator.userAgent) ? "iPhone/iPad" : "Web browser";
}

function pendingKey(uid) {
    return uid ? `${PENDING_KEY}:${uid}` : PENDING_KEY;
}

function markSyncPending(uid) {
    localStorage.setItem(pendingKey(uid), "true");
    window.dispatchEvent(new CustomEvent("snapnotes:sync-status", {
        detail: { status: "pending", uid }
    }));
}

function clearSyncPending(uid) {
    localStorage.removeItem(pendingKey(uid));
    localStorage.removeItem(PENDING_KEY);
    window.dispatchEvent(new CustomEvent("snapnotes:sync-status", {
        detail: { status: "synced", uid }
    }));
}

function belongsToCurrentAccount(uid) {
    return Boolean(uid && auth?.currentUser?.uid === uid &&
        isLibraryBoundToUser(window.snapNotesDataUid, uid));
}

function isCurrentLoad(snapshot) {
    return sessionGuard.isCurrent(snapshot, auth?.currentUser?.uid || null) &&
        belongsToCurrentAccount(snapshot.uid);
}

function localStorageHasLegacyPrivateNotes(uid) {
    let rootOwner;
    try { rootOwner = window.localStorage.getItem("SnapNotesRootLibraryUid"); }
    catch { return true; }
    if (rootOwner !== uid) return false;
    try {
        const rawNotes = window.localStorage.getItem("SnapNotes");
        if (rawNotes === null) return false;
        const notes = JSON.parse(rawNotes);
        if (!Array.isArray(notes)) return true;
        return notes.some(note => note?.isPrivate &&
            (privateNoteMetadataNeedsMigration(note) || !isEncryptedPrivateNote(note)));
    } catch {
        return true;
    }
}

function verifyLocalStorageLibrary(uid, expectedNotes, expectedFolders) {
    try {
        if (window.localStorage.getItem("SnapNotesRootLibraryUid") !== uid) return false;
        const notes = JSON.parse(window.localStorage.getItem("SnapNotes") || "null");
        const folders = JSON.parse(window.localStorage.getItem("SnapNotesFolders") || "null");
        return Array.isArray(notes) && Array.isArray(folders) &&
            stablePrivateRecordJson(notes) === stablePrivateRecordJson(expectedNotes) &&
            stablePrivateRecordJson(folders) === stablePrivateRecordJson(expectedFolders);
    } catch {
        return false;
    }
}

function pageCollection(uid, revision) {
    return collection(db, "users", uid, PAGE_COLLECTION, revision, "pages");
}

function privateNoteCollection(uid) {
    return collection(db, "users", uid, PRIVATE_NOTE_COLLECTION);
}

function privateNoteRef(uid, noteId) {
    return doc(privateNoteCollection(uid), encodeURIComponent(noteId));
}

function privateNoteVersionRef(uid, fingerprint) {
    return doc(collection(db, "users", uid, PRIVATE_NOTE_VERSION_COLLECTION), fingerprint);
}

function privateNoteRevisionRef(uid, noteId) {
    return doc(collection(db, "users", uid, PRIVATE_NOTE_REVISION_COLLECTION), encodeURIComponent(noteId));
}

function privateMigrationPreflightRef() {
    return doc(db, PRIVATE_MIGRATION_PREFLIGHT_COLLECTION, "global");
}

async function readPrivateNoteRecords(uid) {
    if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed before private notes could be read.");
    const [snapshot, versionSnapshot] = await Promise.all([
        getDocs(privateNoteCollection(uid)),
        getDocs(collection(db, "users", uid, PRIVATE_NOTE_VERSION_COLLECTION))
    ]);
    if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed while private notes were loading.");
    const records = snapshot.docs.map(item => item.data() || {});
    if (records.some((note, index) => !isEncryptedPrivateNote(note) ||
        note.documentKey !== encodeURIComponent(note.id) ||
        snapshot.docs[index].id !== note.documentKey)) {
        throw new Error("Cloud Private Notes contain a record that is not safely encrypted.");
    }
    for (const item of versionSnapshot.docs) {
        const version = item.data() || {};
        if (version.fingerprint !== item.id || typeof version.noteId !== "string" ||
            version.noteId !== version.record?.id || version.documentKey !== encodeURIComponent(version.noteId) ||
            !isEncryptedPrivateNote(version.record) ||
            await privateRecordFingerprint(version.record) !== item.id) {
            throw new Error("Cloud Private Note recovery data failed integrity validation.");
        }
        records.push(createPrivateRecoveryCopy(version.record, item.id));
    }
    return records;
}

function privateNotePreservationStore(uid) {
    return {
        async reconcile(incoming) {
            if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed before private-note preservation.");
            const safeIncoming = { ...incoming, documentKey: encodeURIComponent(incoming.id) };
            const reference = privateNoteRef(uid, safeIncoming.id);
            return runTransaction(db, async transaction => {
                if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed during private-note preservation.");
                const currentSnapshot = await transaction.get(reference);
                const current = currentSnapshot.exists() ? currentSnapshot.data() || {} : null;
                const plan = planPrivateRecordReconciliation(current, safeIncoming);
                const archived = await Promise.all((plan.archivedRecords || []).map(async record => ({
                    record,
                    fingerprint: await privateRecordFingerprint(record)
                })));
                const archivedSnapshots = await Promise.all(archived.map(item =>
                    transaction.get(privateNoteVersionRef(uid, item.fingerprint))));
                const newArchives = archived.filter((_, index) => !archivedSnapshots[index].exists());
                const revisionRef = newArchives.length ? privateNoteRevisionRef(uid, safeIncoming.id) : null;
                const revisionSnapshot = revisionRef ? await transaction.get(revisionRef) : null;
                if (revisionSnapshot?.exists()) {
                    const revisionData = revisionSnapshot.data() || {};
                    if (revisionData.noteId !== safeIncoming.id ||
                        revisionData.documentKey !== encodeURIComponent(safeIncoming.id) ||
                        !Number.isSafeInteger(revisionData.revision) || revisionData.revision < 1) {
                        throw new Error("Private Note archive revision metadata is invalid.");
                    }
                }

                archived.forEach((item, index) => {
                    if (!archivedSnapshots[index].exists()) {
                        transaction.set(privateNoteVersionRef(uid, item.fingerprint), {
                            noteId: item.record.id,
                            documentKey: encodeURIComponent(item.record.id),
                            fingerprint: item.fingerprint,
                            record: item.record
                        });
                    }
                });
                if (revisionRef) {
                    const revision = revisionSnapshot?.exists() ? revisionSnapshot.data().revision : 0;
                    transaction.set(revisionRef, {
                        noteId: safeIncoming.id,
                        documentKey: encodeURIComponent(safeIncoming.id),
                        revision: revision + 1
                    });
                }
                if (!current || stablePrivateRecordJson(current) !== stablePrivateRecordJson(plan.canonical)) {
                    transaction.set(reference, plan.canonical);
                }
                return plan;
            });
        },
        async readCurrent(noteId) {
            if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed while verifying private-note preservation.");
            const snapshot = await getDoc(privateNoteRef(uid, noteId));
            if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed while verifying private-note preservation.");
            return snapshot.exists() ? snapshot.data() || null : null;
        },
        async readCleanupSnapshot(records) {
            if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed before cleanup state could be verified.");
            const recordIds = [...new Set(records.map(record => record?.id).filter(id => typeof id === "string" && id))];
            const watchedIds = [...new Set(records.flatMap(record =>
                [record?.id, record?.privateRecoverySourceId, record?.privateRecoveryParentId]
                    .filter(id => typeof id === "string" && id)))];
            return runTransaction(db, async transaction => {
                const recordSnapshots = await Promise.all(recordIds.map(id => transaction.get(privateNoteRef(uid, id))));
                const revisionSnapshots = await Promise.all(watchedIds.map(id => transaction.get(privateNoteRevisionRef(uid, id))));
                if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed while cleanup state was being verified.");
                const currentRecords = new Map(recordIds.map((id, index) => [
                    id,
                    recordSnapshots[index].exists() ? recordSnapshots[index].data() || null : null
                ]));
                const revisions = new Map();
                watchedIds.forEach((id, index) => {
                    const snapshot = revisionSnapshots[index];
                    const data = snapshot.exists() ? snapshot.data() || {} : null;
                    if (data && (data.noteId !== id || data.documentKey !== encodeURIComponent(id) ||
                        !Number.isSafeInteger(data.revision) || data.revision < 1)) {
                        throw new Error("Private Note archive revision metadata is invalid; cleanup was paused.");
                    }
                    revisions.set(id, data?.revision || 0);
                });
                return { currentRecords, revisions };
            });
        },
        async readVersion(fingerprint) {
            if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed while verifying an archived private note.");
            const snapshot = await getDoc(privateNoteVersionRef(uid, fingerprint));
            if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed while verifying an archived private note.");
            return snapshot.exists() ? snapshot.data() || null : null;
        }
    };
}

async function deleteSeparatedPrivateNotes(uid, expectedRecords, expectedRevisions) {
    if (!belongsToCurrentAccount(uid) || !expectedRecords.length || !(expectedRevisions instanceof Map)) return false;
    const expectedById = new Map(expectedRecords.map(note => [note.id, note]));
    const ids = new Set(expectedById.keys());
    const watchedIds = new Set(expectedRecords.flatMap(note =>
        [note.id, note.privateRecoverySourceId, note.privateRecoveryParentId]
            .filter(value => typeof value === "string" && value)));
    if ([...watchedIds].some(id => !expectedRevisions.has(id))) return false;
    const watchedRevisionRefs = new Map([...watchedIds].map(id => [id, privateNoteRevisionRef(uid, id)]));
    const versions = await getDocs(collection(db, "users", uid, PRIVATE_NOTE_VERSION_COLLECTION));
    if (!belongsToCurrentAccount(uid)) return false;
    const recoveryFingerprints = new Set(expectedRecords
        .map(note => note.privateRecoveryFingerprint)
        .filter(value => typeof value === "string"));
    const toDelete = versions.docs.filter(item => ids.has(item.data()?.noteId) ||
        recoveryFingerprints.has(item.id));
    try {
        await runTransaction(db, async transaction => {
            const currentSnapshots = await Promise.all([...ids].map(id => transaction.get(privateNoteRef(uid, id))));
            const versionSnapshots = await Promise.all(toDelete.map(item => transaction.get(item.ref)));
            const revisionSnapshots = await Promise.all([...watchedRevisionRefs.values()].map(reference => transaction.get(reference)));
            if (!belongsToCurrentAccount(uid)) throw new Error("The active account changed before Private Note cleanup.");
            revisionSnapshots.forEach((snapshot, index) => {
                const id = [...watchedIds][index];
                const data = snapshot.exists() ? snapshot.data() || {} : null;
                const currentRevision = data?.revision || 0;
                if ((data && (data.noteId !== id || data.documentKey !== encodeURIComponent(id))) ||
                    currentRevision !== expectedRevisions.get(id)) {
                    throw new Error("A Private Note archive changed during move-out or deletion; cleanup was paused to preserve the newer copy.");
                }
            });
            currentSnapshots.forEach((snapshot, index) => {
                const id = [...ids][index];
                const expected = expectedById.get(id);
                if (snapshot.exists() && stablePrivateRecordJson(snapshot.data() || {}) === stablePrivateRecordJson(expected)) return;
                const originStillPresent = expected.privateRecovery === true &&
                    typeof expected.privateRecoveryFingerprint === "string" &&
                    toDelete.some(item => item.id === expected.privateRecoveryFingerprint) &&
                    versionSnapshots.some((versionSnapshot, versionIndex) => versionSnapshot.exists() &&
                        toDelete[versionIndex].id === expected.privateRecoveryFingerprint &&
                        versionSnapshot.data()?.fingerprint === expected.privateRecoveryFingerprint &&
                        versionSnapshot.data()?.noteId === versionSnapshot.data()?.record?.id &&
                        versionSnapshot.data()?.documentKey === encodeURIComponent(versionSnapshot.data()?.noteId) &&
                        versionSnapshot.data()?.record?.documentKey === versionSnapshot.data()?.documentKey);
                if (!snapshot.exists() && originStillPresent) return;
                if (snapshot.exists() || !originStillPresent) {
                    throw new Error("A Private Note changed during move-out or deletion; cleanup was paused to preserve the newer copy.");
                }
            });
            versionSnapshots.forEach((snapshot, index) => {
                if (snapshot.exists()) transaction.delete(toDelete[index].ref);
            });
            currentSnapshots.forEach((snapshot, index) => {
                if (snapshot.exists()) transaction.delete(privateNoteRef(uid, [...ids][index]));
            });
        });
        return belongsToCurrentAccount(uid);
    } catch (error) {
        console.warn("Separated Private Note cleanup was deferred:", error?.message || error);
        return false;
    }
}

function noteDeletionCollection(uid) {
    return collection(db, "users", uid, NOTE_DELETION_COLLECTION);
}

function noteDeletionRef(uid, noteId) {
    return doc(noteDeletionCollection(uid), encodeURIComponent(noteId));
}

async function persistNoteDeletionMarkers(uid, markers) {
    const chunks = [];
    for (let index = 0; index < markers.length; index += 200) chunks.push(markers.slice(index, index + 200));
    const userDocRef = doc(db, "users", uid);
    for (const chunk of chunks) {
        await runTransaction(db, async transaction => {
            const userSnapshot = await transaction.get(userDocRef);
            const userData = userSnapshot.exists() ? userSnapshot.data() || {} : {};
            if (userData.accountDeletion?.status === "processing") {
                const deleting = new Error("Account deletion is already being processed.");
                deleting.code = "snapnotes/account-deletion-processing";
                throw deleting;
            }
            if (!belongsToCurrentAccount(uid)) {
                const stale = new Error("The active account changed during deletion-marker sync.");
                stale.code = "snapnotes/stale-account";
                throw stale;
            }
            const refs = chunk.map(marker => noteDeletionRef(uid, marker.id));
            const snapshots = await Promise.all(refs.map(reference => transaction.get(reference)));
            const missing = chunk.filter((_, index) => !snapshots[index].exists());
            if (!missing.length) return;

            const nextVersion = (Number(userData.deletedNotesVersion) || 0) + 1;
            transaction.set(userDocRef, {
                deletedNotesVersion: nextVersion,
                privateNotesSchemaRequired: true,
                syncVersion: 3,
                schemaWriteNonce: crypto.randomUUID()
            }, { merge: true });
            missing.forEach(marker => {
                transaction.set(noteDeletionRef(uid, marker.id), {
                    noteId: marker.id,
                    documentKey: encodeURIComponent(marker.id),
                    deletedAt: marker.deletedAt || new Date().toISOString()
                }, { merge: true });
            });
        });
        if (!belongsToCurrentAccount(uid)) return false;
    }
    return true;
}

async function readCloudNoteDeletionIds(uid) {
    const snapshot = await getDocs(noteDeletionCollection(uid));
    return snapshot.docs.map(item => {
        const data = item.data() || {};
        const noteId = data.noteId;
        if (typeof noteId === "string" && noteId) {
            const expectedKey = encodeURIComponent(noteId);
            if (item.id !== expectedKey || (data.documentKey !== undefined && data.documentKey !== item.id)) {
                throw new Error("A cloud deletion marker failed path validation.");
            }
            return noteId;
        }
        try { return decodeURIComponent(item.id); } catch { return item.id; }
    }).filter(Boolean);
}

function deletionTombstoneRef(uid) {
    return doc(db, DELETION_TOMBSTONE_COLLECTION, uid);
}

async function clearLocalDataIfTombstoned(uid) {
    if (!belongsToCurrentAccount(uid)) return false;
    try {
        const snapshot = await getDoc(deletionTombstoneRef(uid));
        if (!snapshot.exists()) return false;
        await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
        return true;
    } catch {
        return false;
    }
}

async function clearLocalDataIfDeletionProcessing(uid) {
    if (!belongsToCurrentAccount(uid)) return false;
    try {
        const status = await getAccountDeletionStatus(uid);
        if (status?.status !== "processing") return false;
        await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
        return true;
    } catch {
        return false;
    }
}

async function readLibraryRevision(uid, revision) {
    if (!revision) return { notes: [], folders: [], pageCount: 0 };
    const snapshot = await getDocs(pageCollection(uid, revision));
    const result = { notes: [], folders: [], pageCount: snapshot.size };
    snapshot.docs.sort((a, b) => a.id.localeCompare(b.id)).forEach(page => {
        const data = page.data() || {};
        if (Array.isArray(data.notes)) result.notes.push(...data.notes);
        if (Array.isArray(data.folders)) result.folders.push(...data.folders);
    });
    return result;
}

async function removeLibraryRevision(uid, revision) {
    if (!revision) return true;
    try {
        const snapshot = await getDocs(pageCollection(uid, revision));
        await Promise.all(snapshot.docs.map(page => deleteDoc(page.ref)));
        return true;
    } catch (error) {
        console.warn("Could not remove an inactive cloud library revision:", error?.message || error);
        return false;
    }
}

async function forgetInactiveLibraryRevision(uid, revision) {
    if (!revision || !belongsToCurrentAccount(uid)) return;
    const userDocRef = doc(db, "users", uid);
    try {
        await runTransaction(db, async transaction => {
            const snapshot = await transaction.get(userDocRef);
            if (!snapshot.exists() || !belongsToCurrentAccount(uid)) return;
            const data = snapshot.data() || {};
            if (data.activeLibraryRevision === revision) return;
            const inactive = Array.isArray(data.inactiveLibraryRevisions) ? data.inactiveLibraryRevisions : [];
            if (inactive.includes(revision)) {
                transaction.set(userDocRef, {
                    inactiveLibraryRevisions: inactive.filter(item => item !== revision),
                    schemaWriteNonce: crypto.randomUUID()
                }, { merge: true });
            }
        });
    } catch (error) {
        console.warn("Could not clear an inactive library cleanup marker:", error?.message || error);
    }
}

async function performSync(uid) {
    if (!belongsToCurrentAccount(uid)) return false;
    if (!cloudReadyUids.has(uid)) {
        markSyncPending(uid);
        return false;
    }
    if (!navigator.onLine) {
        markSyncPending(uid);
        return false;
    }
    let stagedRevision = null;
    let baseRevision = null;
    let cloudDeletedIds = [];

    try {
        const localDeletionMarkers = await readPermanentNoteDeletions(uid);
        if (!belongsToCurrentAccount(uid)) return false;
        const userDocRef = doc(db, "users", uid);
        const tombstone = await getDoc(deletionTombstoneRef(uid));
        if (!belongsToCurrentAccount(uid)) return false;
        if (tombstone.exists()) {
            await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
            return false;
        }
        const existing = await getDoc(userDocRef);
        if (!belongsToCurrentAccount(uid)) return false;
        let existingData = existing.exists() ? existing.data() : {};
        if (existingData.accountDeletion?.status === "processing") {
            await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
            return false;
        }
        if (existingData.privateNotesSeparated !== true) {
            const preflightSnapshot = await getDoc(privateMigrationPreflightRef());
            if (!belongsToCurrentAccount(uid)) return false;
            if (!preflightSnapshot.exists() ||
                !privateMigrationPreflightComplete(preflightSnapshot.data() || {})) {
                markSyncPending(uid);
                window.showToast?.("Cloud sync is paused until the Admin inventory of legacy library revisions is completed.", "warning");
                return false;
            }
        }
        if (localDeletionMarkers.length) {
            await persistNoteDeletionMarkers(uid, localDeletionMarkers);
            if (!belongsToCurrentAccount(uid)) return false;
            const refreshed = await getDoc(userDocRef);
            if (!belongsToCurrentAccount(uid)) return false;
            existingData = refreshed.exists() ? refreshed.data() || {} : {};
            if (existingData.accountDeletion?.status === "processing") {
                await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
                return false;
            }
        }
        baseRevision = existingData.activeLibraryRevision || null;
        const baseDeletionVersion = Number(existingData.deletedNotesVersion) || 0;

        cloudDeletedIds = await readCloudNoteDeletionIds(uid);
        if (!belongsToCurrentAccount(uid)) return false;
        const deletedIds = new Set([...localDeletionMarkers.map(marker => marker.id), ...cloudDeletedIds]);

        if (deletedIds.size && Array.isArray(window.notes)) {
            const filteredLiveNotes = window.notes.filter(note => !deletedIds.has(note?.id) &&
                !deletedIds.has(note?.conflictOf) && !deletedIds.has(note?.privateRecoverySourceId) &&
                !deletedIds.has(note?.privateRecoveryParentId));
            if (filteredLiveNotes.length !== window.notes.length) {
                window.notes = filteredLiveNotes;
                await window.persistLocalLibrary?.(uid, filteredLiveNotes, window.getFolders?.() || [], Date.now());
                window.renderNotes?.();
                window.updateNavigationCounts?.();
            }
        }
        const initialLocalNotesSnapshot = structuredClone(Array.isArray(window.notes) ? window.notes : []);
        const initialLocalFoldersSnapshot = structuredClone(Array.isArray(window.getFolders?.()) ? window.getFolders() : []);

        const localNotes = structuredClone(Array.isArray(window.notes) ? window.notes : [])
            .filter(note => !deletedIds.has(note?.id) && !deletedIds.has(note?.conflictOf) &&
                !deletedIds.has(note?.privateRecoverySourceId) && !deletedIds.has(note?.privateRecoveryParentId));
        const movedOutPrivateIds = new Set(localNotes.filter(note => note?.id && !note.isPrivate).map(note => note.id));
        const privateCandidates = [];
        if (Array.isArray(existingData.notes)) privateCandidates.push(...existingData.notes.filter(note =>
            note?.isPrivate && !deletedIds.has(note.id)));

        // Read every legacy revision that this sync may later retire. A private
        // record is not removed from ordinary snapshots until its encrypted copy
        // has been written to, and read back from, the separate private store.
        const legacyRevisions = [...new Set([
            ...(baseRevision ? [baseRevision] : []),
            ...(Array.isArray(existingData.inactiveLibraryRevisions) ? existingData.inactiveLibraryRevisions : [])
        ].filter(revision => typeof revision === "string" && revision))];
        const revisionsContainingPrivateNotes = new Set();
        for (const revision of legacyRevisions) {
            if (!belongsToCurrentAccount(uid)) return false;
            const legacyLibrary = await readLibraryRevision(uid, revision);
            if (!belongsToCurrentAccount(uid)) return false;
            if (revision === baseRevision && existingData.libraryPageCount !== undefined &&
                existingData.libraryPageCount !== null && existingData.libraryPageCount !== "" &&
                !isLibraryRevisionComplete(existingData.libraryPageCount, legacyLibrary.pageCount)) {
                throw new Error("The active cloud snapshot is incomplete; private-note separation is paused to protect its contents.");
            }
            const legacyPrivate = legacyLibrary.notes.filter(note => note?.isPrivate);
            if (legacyPrivate.length) revisionsContainingPrivateNotes.add(revision);
            privateCandidates.push(...legacyPrivate.filter(note =>
                !deletedIds.has(note.id)));
        }

        const alreadySeparatedPrivate = await readPrivateNoteRecords(uid);
        if (!belongsToCurrentAccount(uid)) return false;
        privateCandidates.push(...alreadySeparatedPrivate.filter(note =>
            !deletedIds.has(note.id) && !deletedIds.has(note.privateRecoverySourceId) &&
            !deletedIds.has(note.privateRecoveryParentId)));
        // The normal merge has already resolved source conflicts for display;
        // put that chosen local record last so equal timestamps use the same winner.
        privateCandidates.push(...localNotes.filter(note => note?.isPrivate && !deletedIds.has(note.id)));
        const privateRecordsToRemoveAfterCommit = privateRecordsForCleanup(
            [...alreadySeparatedPrivate, ...privateCandidates],
            deletedIds,
            movedOutPrivateIds
        );
        const privateRecordsExpectedForRemoval = new Map();
        const privateRevisionsExpectedForRemoval = new Map();
        const encryptedPrivateCandidates = [];
        const convertedLegacyRecords = new Map();
        const legacyAttachmentOriginals = [];
        for (const candidate of privateCandidates) {
            if (!belongsToCurrentAccount(uid)) return false;
            if (!privateNoteMetadataNeedsMigration(candidate)) {
                if (!isEncryptedPrivateNote(candidate)) {
                    throw new Error("Cloud sync is paused because a Private Note does not have a valid encrypted payload.");
                }
                encryptedPrivateCandidates.push(candidate);
                continue;
            }

            const sourceKey = stablePrivateRecordJson(candidate);
            let converted = convertedLegacyRecords.get(sourceKey);
            if (!converted) {
                converted = await window.preparePrivateRecordForSeparation?.(candidate);
                if (!converted?.record || !isEncryptedPrivateNote(converted.record)) {
                    throw new Error("Unlock Private Notes to re-encrypt legacy private metadata before cloud separation.");
                }
                convertedLegacyRecords.set(sourceKey, converted);
                legacyAttachmentOriginals.push(...(converted.originalAttachments || []));
            }
            encryptedPrivateCandidates.push(converted.record);
        }

        const splitLibrary = splitPrivateNotesFromLibrary(localNotes);
        const notes = splitLibrary.notes;
        const folders = structuredClone(Array.isArray(window.getFolders?.()) ? window.getFolders() : []);
        let pages;
        try {
            pages = packLibraryPages(notes, folders).map(page => ({
                ...page,
                syncVersion: 3,
                schemaWriteNonce: crypto.randomUUID()
            }));
        } catch (error) {
            console.error("Cloud library contains a record larger than a safe Firestore page:", error);
            markSyncPending(uid);
            window.showToast?.("Cloud sync is pending: one note or attachment record is too large to sync safely.", "warning");
            return false;
        }

        const preserveResult = await preservePrivateNotesBeforeCommit({
            candidates: encryptedPrivateCandidates,
            store: privateNotePreservationStore(uid),
            beforeCommit: async () => {
                if (!belongsToCurrentAccount(uid) ||
                    stablePrivateRecordJson(window.notes || []) !== stablePrivateRecordJson(initialLocalNotesSnapshot) ||
                    stablePrivateRecordJson(window.getFolders?.() || []) !== stablePrivateRecordJson(initialLocalFoldersSnapshot)) {
                    markSyncPending(uid);
                    return false;
                }
                const hasLegacyLocalPrivate = initialLocalNotesSnapshot.some(note => note?.isPrivate &&
                    (privateNoteMetadataNeedsMigration(note) || !isEncryptedPrivateNote(note)));
                const needsLocalSanitation = hasLegacyLocalPrivate || localStorageHasLegacyPrivateNotes(uid);
                if (needsLocalSanitation) {
                    const sanitizedLocalNotes = structuredClone(initialLocalNotesSnapshot);
                    for (let index = 0; index < sanitizedLocalNotes.length; index++) {
                        const note = sanitizedLocalNotes[index];
                        if (!note?.isPrivate || deletedIds.has(note.id) || movedOutPrivateIds.has(note.id)) continue;
                        const canonical = await privateNotePreservationStore(uid).readCurrent(note.id);
                        if (!canonical || !isEncryptedPrivateNote(canonical)) {
                            markSyncPending(uid);
                            return false;
                        }
                        sanitizedLocalNotes[index] = canonical;
                    }
                    if (!belongsToCurrentAccount(uid)) return false;
                    const persisted = await window.persistLocalLibrary?.(
                        uid,
                        sanitizedLocalNotes,
                        initialLocalFoldersSnapshot,
                        Date.now()
                    );
                    const localStorageMatches = verifyLocalStorageLibrary(uid, sanitizedLocalNotes, initialLocalFoldersSnapshot);
                    if (!localPrivateSnapshotVerified(persisted, localStorageMatches)) {
                        markSyncPending(uid);
                        return false;
                    }
                    window.notes = sanitizedLocalNotes;
                    window.renderNotes?.();
                    window.updateNavigationCounts?.();
                }
                if (privateRecordsToRemoveAfterCommit.size) {
                    const cleanupSnapshot = await privateNotePreservationStore(uid).readCleanupSnapshot(
                        [...privateRecordsToRemoveAfterCommit.values()]
                    );
                    for (const id of privateRecordsToRemoveAfterCommit.keys()) {
                        const expected = cleanupSnapshot.currentRecords.get(id);
                        const archivedRecovery = alreadySeparatedPrivate.find(note => note.id === id &&
                            note.privateRecovery === true && note.privateRecoveryFingerprint);
                        if (expected) {
                            privateRecordsExpectedForRemoval.set(id, expected);
                        } else if (archivedRecovery) {
                            privateRecordsExpectedForRemoval.set(id, archivedRecovery);
                        } else {
                            markSyncPending(uid);
                            return false;
                        }
                    }
                    for (const [id, revision] of cleanupSnapshot.revisions) {
                        privateRevisionsExpectedForRemoval.set(id, revision);
                    }
                }
                return true;
            },
            commit: async () => {
                const deviceId = getDeviceId();
                const syncedAt = new Date().toISOString();
                stagedRevision = crypto.randomUUID();

                await runTransaction(db, async transaction => {
                    const tombstoneSnapshot = await transaction.get(deletionTombstoneRef(uid));
                    const latest = await transaction.get(userDocRef);
                    if (tombstoneSnapshot.exists()) {
                        const deleted = new Error("This account has been deleted.");
                        deleted.code = "snapnotes/account-deleted";
                        throw deleted;
                    }
                    if (!belongsToCurrentAccount(uid)) {
                        const stale = new Error("The active account changed before schema-v3 staging.");
                        stale.code = "snapnotes/stale-account";
                        throw stale;
                    }
                    const currentData = latest.exists() ? latest.data() || {} : {};
                    const currentRevision = currentData.activeLibraryRevision || null;
                    const currentDeletionVersion = Number(currentData.deletedNotesVersion) || 0;
                    if (currentData.accountDeletion?.status === "processing") {
                        const deleting = new Error("Account deletion is already being processed.");
                        deleting.code = "snapnotes/account-deletion-processing";
                        throw deleting;
                    }
                    if (currentRevision !== baseRevision || currentDeletionVersion !== baseDeletionVersion) {
                        const concurrent = new Error("Another device updated or deleted cloud notes before schema-v3 staging.");
                        concurrent.code = "snapnotes/concurrent-library-update";
                        throw concurrent;
                    }
                    transaction.set(userDocRef, {
                        privateNotesSchemaRequired: true,
                        syncVersion: 3,
                        schemaWriteNonce: crypto.randomUUID()
                    }, { merge: true });
                });

                for (let index = 0; index < pages.length; index++) {
                    if (!belongsToCurrentAccount(uid)) {
                        await removeLibraryRevision(uid, stagedRevision);
                        return false;
                    }
                    const pageRef = doc(pageCollection(uid, stagedRevision), String(index).padStart(5, "0"));
                    await setDoc(pageRef, pages[index]);
                }

                if (!belongsToCurrentAccount(uid)) {
                    await removeLibraryRevision(uid, stagedRevision);
                    return false;
                }

                await runTransaction(db, async transaction => {
                    const tombstoneSnapshot = await transaction.get(deletionTombstoneRef(uid));
                    if (tombstoneSnapshot.exists()) {
                        const deleted = new Error("This account has been deleted.");
                        deleted.code = "snapnotes/account-deleted";
                        throw deleted;
                    }
                    const latest = await transaction.get(userDocRef);
                    if (!belongsToCurrentAccount(uid)) {
                        const stale = new Error("The active account changed during cloud sync.");
                        stale.code = "snapnotes/stale-account";
                        throw stale;
                    }
                    const currentRevision = latest.exists() ? latest.data()?.activeLibraryRevision || null : null;
                    const currentDeletionVersion = latest.exists() ? Number(latest.data()?.deletedNotesVersion) || 0 : 0;
                    if (latest.exists() && latest.data()?.accountDeletion?.status === "processing") {
                        const deleting = new Error("Account deletion is already being processed.");
                        deleting.code = "snapnotes/account-deletion-processing";
                        throw deleting;
                    }
                    if (currentRevision !== baseRevision) {
                        const concurrent = new Error("Another device updated the cloud library during sync.");
                        concurrent.code = "snapnotes/concurrent-library-update";
                        throw concurrent;
                    }
                    if (currentDeletionVersion !== baseDeletionVersion) {
                        const concurrent = new Error("Another device permanently deleted a note during sync.");
                        concurrent.code = "snapnotes/concurrent-library-update";
                        throw concurrent;
                    }

                    const inactiveLibraryRevisions = new Set(Array.isArray(latest.data()?.inactiveLibraryRevisions)
                        ? latest.data().inactiveLibraryRevisions
                        : []);
                    if (currentRevision && currentRevision !== stagedRevision) inactiveLibraryRevisions.add(currentRevision);

                    transaction.set(userDocRef, {
                        activeLibraryRevision: stagedRevision,
                        libraryPageCount: pages.length,
                        lastSynced: syncedAt,
                        syncVersion: 3,
                        privateNotesSchemaRequired: true,
                        privateNotesSeparated: true,
                        schemaWriteNonce: crypto.randomUUID(),
                        lastSyncedBy: deviceId,
                        inactiveLibraryRevisions: [...inactiveLibraryRevisions],
                        devices: {
                            [deviceId]: { name: getDeviceName(), lastSeen: syncedAt }
                        },
                        notes: deleteField(),
                        folders: deleteField()
                    }, { merge: true });
                });
                return true;
            }
        });
        if (preserveResult.committed !== true) return false;

        if (legacyAttachmentOriginals.length) {
            try {
                const cleanup = await window.cleanupAttachmentsForNotes?.([{ attachments: legacyAttachmentOriginals }]);
                if (cleanup?.persisted === false || cleanup?.pendingCount) {
                    window.showToast?.("Private notes were separated safely; removal of older unprotected attachment copies is queued for retry.", "warning");
                }
            } catch (error) {
                console.warn("Could not queue cleanup for older private attachments:", error?.message || error);
            }
        }

        if (privateRecordsExpectedForRemoval.size) {
            try {
                const cleaned = await deleteSeparatedPrivateNotes(
                    uid,
                    [...privateRecordsExpectedForRemoval.values()],
                    privateRevisionsExpectedForRemoval
                );
                if (!cleaned) markSyncPending(uid);
            } catch (error) {
                console.warn("A removed Private Note remains queued for cloud cleanup:", error?.message || error);
            }
        }

        const inactiveRevisions = new Set([
            ...(Array.isArray(existingData.inactiveLibraryRevisions) ? existingData.inactiveLibraryRevisions : []),
            ...(baseRevision && baseRevision !== stagedRevision ? [baseRevision] : [])
        ]);
        const proposedKeepRevision = recoveryBackupByUid.get(uid) || baseRevision;
        const keepRevision = revisionsContainingPrivateNotes.has(proposedKeepRevision) ? null : proposedKeepRevision;
        for (const revision of inactiveRevisions) {
            if (revision === keepRevision) continue;
            if (await removeLibraryRevision(uid, revision)) await forgetInactiveLibraryRevision(uid, revision);
        }
        recoveryBackupByUid.delete(uid);
        await clearPermanentNoteDeletions(uid, [...deletedIds]);
        if (belongsToCurrentAccount(uid)) clearSyncPending(uid);
        return true;
    } catch (error) {
        if (stagedRevision) await removeLibraryRevision(uid, stagedRevision);
        if (belongsToCurrentAccount(uid)) {
            if (await clearLocalDataIfTombstoned(uid)) return false;
            if (await clearLocalDataIfDeletionProcessing(uid)) return false;
            if (error?.code === "snapnotes/account-deletion-processing" || error?.code === "snapnotes/account-deleted") {
                await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
                return false;
            }
            if (error?.code === "snapnotes/concurrent-library-update") {
                console.warn("Cloud library changed during sync; local changes remain pending.");
            } else {
                console.error("Cloud sync failed:", error);
            }
            markSyncPending(uid);
            if (error?.code === "snapnotes/concurrent-library-update") {
                window.dispatchEvent(new CustomEvent("snapnotes:cloud-conflict", { detail: { uid } }));
            }
        }
        return false;
    }
}

export function syncToCloud(expectedUid = auth?.currentUser?.uid) {
    if (!expectedUid || !belongsToCurrentAccount(expectedUid)) return Promise.resolve(false);
    const previous = activeSyncs.get(expectedUid) || Promise.resolve(false);
    const task = previous.catch(() => false).then(() => performSync(expectedUid));
    activeSyncs.set(expectedUid, task);
    return task.finally(() => {
        if (activeSyncs.get(expectedUid) === task) activeSyncs.delete(expectedUid);
    });
}

export async function loadFromCloud(uid) {
    if (!uid || !belongsToCurrentAccount(uid)) return;
    cloudReadyUids.delete(uid);
    recoveryBackupByUid.delete(uid);
    const session = sessionGuard.capture(uid);
    if (!isCurrentLoad(session)) return;

    try {
        await window.localNotesReady;
        if (!isCurrentLoad(session)) return;
        const userDocRef = doc(db, "users", uid);
        const tombstone = await getDoc(deletionTombstoneRef(uid));
        if (!isCurrentLoad(session)) return;
        if (tombstone.exists()) {
            await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
            return;
        }
        const docSnap = await getDoc(userDocRef);
        if (!isCurrentLoad(session)) return;

        const cloudData = docSnap.exists() ? docSnap.data() : {};
        if (cloudData.accountDeletion?.status === "processing") {
            await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
            return;
        }
        let cloudNotes = Array.isArray(cloudData.notes) ? cloudData.notes : [];
        let cloudFolders = Array.isArray(cloudData.folders) ? cloudData.folders : [];
        const detachedPrivateNotes = await readPrivateNoteRecords(uid);
        if (!isCurrentLoad(session)) return;
        cloudNotes = [...cloudNotes, ...detachedPrivateNotes];
        const activeRevision = cloudData.activeLibraryRevision || null;
        const inactiveRevisions = (Array.isArray(cloudData.inactiveLibraryRevisions)
            ? cloudData.inactiveLibraryRevisions
            : []).filter(revision => typeof revision === "string" && revision && revision !== activeRevision);
        if (activeRevision) {
            const library = await readLibraryRevision(uid, activeRevision);
            if (!isCurrentLoad(session)) return;
            // Libraries created before page-count metadata was introduced are valid.
            // Do not mistake a missing count for a corrupt revision and hide existing notes.
            const hasRecordedPageCount = cloudData.libraryPageCount !== undefined &&
                cloudData.libraryPageCount !== null && cloudData.libraryPageCount !== "";
            const revisionComplete = hasRecordedPageCount
                ? isLibraryRevisionComplete(cloudData.libraryPageCount, library.pageCount)
                : library.pageCount > 0;
            if (!revisionComplete) {
                let recovery = null;
                for (const revision of [...inactiveRevisions].reverse()) {
                    try {
                        const backup = await readLibraryRevision(uid, revision);
                        if (!isCurrentLoad(session)) return;
                        if (backup.pageCount > 0 && (backup.notes.length || backup.folders.length)) {
                            recovery = { revision, library: backup };
                            break;
                        }
                    } catch (error) {
                        console.warn("Could not read a retained cloud library revision:", error?.message || error);
                    }
                }
                if (!recovery) {
                    markSyncPending(uid);
                    window.showToast?.("The cloud library appears incomplete. Your local notes are preserved and cloud sync is paused.", "warning");
                    return;
                }
                cloudNotes = mergeNotes([...cloudNotes, ...library.notes], recovery.library.notes);
                cloudFolders = [...cloudFolders, ...library.folders, ...recovery.library.folders];
                recoveryBackupByUid.set(uid, recovery.revision);
                window.showToast?.("Recovered notes from the last safe cloud snapshot.", "success");
            } else {
                cloudNotes = [...cloudNotes, ...library.notes];
                cloudFolders = [...cloudFolders, ...library.folders];
            }
        }

        // A previously populated cloud library must never be replaced by an empty
        // snapshot from a new browser or preview deployment. Preserve its revision
        // and require explicit recovery rather than publishing an empty library.
        if (activeRevision && !cloudNotes.length && !cloudFolders.length &&
            !Array.isArray(cloudData.notes) && !Array.isArray(cloudData.folders)) {
            markSyncPending(uid);
            window.showToast?.("Cloud notes could not be verified. Sync paused to protect your existing notes.", "warning");
            return;
        }

        if (!recoveryBackupByUid.has(uid)) {
            const backupRevision = inactiveRevisions.at(-1);
            if (backupRevision) {
                try {
                    const backup = await readLibraryRevision(uid, backupRevision);
                    if (!isCurrentLoad(session)) return;
                    const currentById = new Map(cloudNotes.filter(note => note?.id).map(note => [note.id, note]));
                    const mergedBackupNotes = mergeNotes(cloudNotes, backup.notes);
                    const backupContributed = mergedBackupNotes.some(note => {
                        const current = currentById.get(note.id);
                        return !current || noteSignature(current) !== noteSignature(note);
                    });
                    if (backupContributed) {
                        cloudNotes = mergedBackupNotes;
                        recoveryBackupByUid.set(uid, backupRevision);
                        window.showToast?.("Recovered notes from a recent cloud backup.", "success");
                    }
                } catch (error) {
                    console.warn("Could not check the retained cloud backup:", error?.message || error);
                }
            }
        }

        const localDeletionMarkers = await readPermanentNoteDeletions(uid);
        const cloudDeletedIds = await readCloudNoteDeletionIds(uid);
        if (!isCurrentLoad(session)) return;
        const localNotes = Array.isArray(window.notes) ? window.notes : [];
        const localFolders = Array.isArray(window.getFolders?.()) ? window.getFolders() : [];
        const deletedIds = new Set([...localDeletionMarkers.map(marker => marker.id), ...cloudDeletedIds]);
        // An empty cloud response on a fresh preview origin is not proof that
        // the user's library is empty. Production may still hold local-only notes.
        // Never publish an empty revision until a cloud library has been verified.
        if (!cloudNotes.length && !localNotes.length && !cloudFolders.length && !localFolders.length) {
            console.warn("SnapNotes cloud hydration returned an empty library", {
                userDocumentExists: docSnap.exists(),
                activeRevisionPresent: Boolean(activeRevision),
                expectedPageCount: cloudData.libraryPageCount ?? null,
                inactiveRevisionCount: inactiveRevisions.length,
                cloudNoteCount: cloudNotes.length,
                localNoteCount: localNotes.length,
                deletionMarkerCount: deletedIds.size
            });
            markSyncPending(uid);
            window.showToast?.("No notes were returned from cloud storage. Sync is paused to protect your existing notes. Check production before making changes.", "warning");
            return;
        }
        const visibleLocalNotes = localNotes.filter(note => !deletedIds.has(note?.privateRecoverySourceId) &&
            !deletedIds.has(note?.privateRecoveryParentId));
        const visibleCloudNotes = cloudNotes.filter(note => !deletedIds.has(note?.privateRecoverySourceId) &&
            !deletedIds.has(note?.privateRecoveryParentId));
        const merged = mergeNotes(visibleLocalNotes, visibleCloudNotes, [...deletedIds]);
        const folderMap = new Map();
        [...cloudFolders, ...localFolders].forEach(folder => {
            if (!folder?.id) return;
            const existing = folderMap.get(folder.id);
            if (!existing) {
                folderMap.set(folder.id, folder);
                return;
            }
            const existingTime = noteTimestamp(existing);
            const incomingTime = noteTimestamp(folder);
            if (incomingTime > existingTime) folderMap.set(folder.id, folder);
        });
        const mergedFolders = [...folderMap.values()].slice(0, 20);

        if (!isCurrentLoad(session)) return;
        window.snapNotesDataUid = uid;
        window.notes = merged;
        await window.persistLocalLibrary?.(uid, merged, mergedFolders, Date.now());
        window.loadFolders?.();
        window.renderNotes?.();
        window.handlePendingNotificationNote?.();
        window.updateNavigationCounts?.();

        const legacyAttachmentIds = new Set();
        for (const rawNote of merged) {
            const readable = window.getReadablePrivateNote?.(rawNote) || rawNote;
            for (const attachments of [rawNote?.attachments, readable?.attachments]) {
                if (!Array.isArray(attachments)) continue;
                for (const attachment of attachments) if (typeof attachment?.id === "string") legacyAttachmentIds.add(attachment.id);
            }
        }
        try {
            await window.tagLegacyAttachmentFilesForUser?.(uid, [...legacyAttachmentIds]);
        } catch (error) {
            console.warn("Could not migrate legacy attachment ownership:", error);
        }
        if (!isCurrentLoad(session)) return;

        cloudReadyUids.add(uid);
        const synced = await syncToCloud(uid);
        if (!isCurrentLoad(session)) return;
        await window.retryPendingAttachmentCleanup?.();
        await window.retryPendingAttachmentUploads?.();
        if (!isCurrentLoad(session)) return;
        if (merged.length && synced) {
            window.showToast?.("Notes synced", "success");
        } else if (merged.length && !merged.some(note => privateNoteMetadataNeedsMigration(note))) {
            window.showToast?.("Notes are saved locally; cloud sync is pending.", "warning");
        }
    } catch (error) {
        if (!isCurrentLoad(session)) return;
        if (await clearLocalDataIfTombstoned(uid)) return;
        if (await clearLocalDataIfDeletionProcessing(uid)) return;
        if (!isCurrentLoad(session)) return;
        console.error("Failed to sync notes:", error);
        markSyncPending(uid);
        if (error?.code === "permission-denied") {
            window.showToast?.("Cloud notes could not load: Firestore permissions denied. Your cloud data has not been deleted.", "error");
        } else {
            window.showToast?.("Could not load cloud notes. Your existing cloud data is unchanged; please retry later.", "warning");
        }
    }
}

export async function getAccountDeletionStatus(uid) {
    if (!uid) return null;
    const tombstone = await getDoc(deletionTombstoneRef(uid));
    if (tombstone.exists()) {
        return { ...tombstone.data(), status: "processing", tombstone: true };
    }
    const snapshot = await getDoc(doc(db, "users", uid));
    return snapshot.exists() ? snapshot.data().accountDeletion || null : null;
}

export async function scheduleAccountDeletion(uid) {
    if (!uid) throw new Error("A signed-in account is required.");
    if ((await getDoc(deletionTombstoneRef(uid))).exists()) throw new Error("This account has already been deleted.");
    const requestedAt = new Date();
    const scheduledFor = new Date(requestedAt.getTime() + 10 * 24 * 60 * 60 * 1000);
    const accountDeletion = {
        requestedAt: requestedAt.toISOString(),
        scheduledFor: scheduledFor.toISOString(),
        status: "scheduled"
    };
    await setDoc(doc(db, "users", uid), {
        accountDeletion,
        privateNotesSchemaRequired: true,
        syncVersion: 3,
        schemaWriteNonce: crypto.randomUUID()
    }, { merge: true });
    try { localStorage.setItem(`${DELETION_KEY_PREFIX}${uid}`, JSON.stringify(accountDeletion)); } catch {}
    return accountDeletion;
}

export async function cancelAccountDeletion(uid) {
    if (!uid) throw new Error("A signed-in account is required.");
    const userRef = doc(db, "users", uid);
    await runTransaction(db, async transaction => {
        if ((await transaction.get(deletionTombstoneRef(uid))).exists()) {
            throw new Error("This account has already been deleted.");
        }
        const snapshot = await transaction.get(userRef);
        if (snapshot.exists() && snapshot.data()?.accountDeletion?.status === "processing") {
            throw new Error("Account deletion is already being processed and can no longer be cancelled.");
        }
        transaction.set(userRef, {
            accountDeletion: null,
            privateNotesSchemaRequired: true,
            syncVersion: 3,
            schemaWriteNonce: crypto.randomUUID()
        }, { merge: true });
    });
    localStorage.removeItem(`${DELETION_KEY_PREFIX}${uid}`);
}

async function syncPendingChanges() {
    const uid = auth?.currentUser?.uid;
    const pending = localStorage.getItem(pendingKey(uid)) === "true" || localStorage.getItem(PENDING_KEY) === "true";
    if (!shouldSyncPendingChanges({
        uid,
        authUid: auth?.currentUser?.uid,
        activeLibraryUid: window.snapNotesDataUid,
        online: navigator.onLine,
        pending
    })) return;
    await syncToCloud(uid);
}

window.syncToCloud = syncToCloud;
window.loadFromCloud = loadFromCloud;
window.isCloudLibraryReady = uid => Boolean(uid && cloudReadyUids.has(uid) && belongsToCurrentAccount(uid));
window.getAccountDeletionStatus = getAccountDeletionStatus;
window.scheduleAccountDeletion = scheduleAccountDeletion;
window.cancelAccountDeletion = cancelAccountDeletion;
window.addEventListener("snapnotes:cloud-conflict", event => {
    const uid = event.detail?.uid;
    if (belongsToCurrentAccount(uid)) void loadFromCloud(uid);
});
window.addEventListener("online", syncPendingChanges);
window.addEventListener("snapnotes:auth-ready", syncPendingChanges);
