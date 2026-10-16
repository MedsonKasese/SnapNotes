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
import { mergeNotes, noteTimestamp, packLibraryPages } from "./note-sync.js";
import { clearPermanentNoteDeletions, readPermanentNoteDeletions } from "./note-deletions.js";
import { privateNoteMetadataNeedsMigration } from "./private-note-utils.js";

const PENDING_KEY = "SnapNotesSyncPending";
const DELETION_KEY_PREFIX = "SnapNotesAccountDeletion:";
const DELETION_TOMBSTONE_COLLECTION = "accountDeletionTombstones";
const NOTE_DELETION_COLLECTION = "deletedNotes";
const PAGE_COLLECTION = "libraries";
const sessionGuard = createCloudSessionGuard();
const activeSyncs = new Map();
const recoveryBackupByUid = new Map();

window.addEventListener("snapnotes:auth-changed", event => {
    sessionGuard.advance(event.detail?.user?.uid || null);
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
        (window.snapNotesDataUid === undefined || window.snapNotesDataUid === uid));
}

function isCurrentLoad(snapshot) {
    return sessionGuard.isCurrent(snapshot, auth?.currentUser?.uid || null) &&
        belongsToCurrentAccount(snapshot.uid);
}

function pageCollection(uid, revision) {
    return collection(db, "users", uid, PAGE_COLLECTION, revision, "pages");
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
            transaction.set(userDocRef, { deletedNotesVersion: nextVersion }, { merge: true });
            missing.forEach(marker => {
                transaction.set(noteDeletionRef(uid, marker.id), {
                    noteId: marker.id,
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
        const noteId = item.data()?.noteId;
        if (typeof noteId === "string" && noteId) return noteId;
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
                    inactiveLibraryRevisions: inactive.filter(item => item !== revision)
                }, { merge: true });
            }
        });
    } catch (error) {
        console.warn("Could not clear an inactive library cleanup marker:", error?.message || error);
    }
}

async function performSync(uid) {
    if (!belongsToCurrentAccount(uid)) return false;
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
        if (localDeletionMarkers.length) {
            await persistNoteDeletionMarkers(uid, localDeletionMarkers);
            if (!belongsToCurrentAccount(uid)) return false;
        }
        const userDocRef = doc(db, "users", uid);
        const tombstone = await getDoc(deletionTombstoneRef(uid));
        if (!belongsToCurrentAccount(uid)) return false;
        if (tombstone.exists()) {
            await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
            return false;
        }
        const existing = await getDoc(userDocRef);
        if (!belongsToCurrentAccount(uid)) return false;
        const existingData = existing.exists() ? existing.data() : {};
        if (existingData.accountDeletion?.status === "processing") {
            await window.clearLocalAccountDataForDeletion?.(auth.currentUser);
            return false;
        }
        baseRevision = existingData.activeLibraryRevision || null;
        const baseDeletionVersion = Number(existingData.deletedNotesVersion) || 0;

        cloudDeletedIds = await readCloudNoteDeletionIds(uid);
        if (!belongsToCurrentAccount(uid)) return false;
        const deletedIds = new Set([...localDeletionMarkers.map(marker => marker.id), ...cloudDeletedIds]);

        if (deletedIds.size && Array.isArray(window.notes)) {
            const filteredLiveNotes = window.notes.filter(note => !deletedIds.has(note?.id) && !deletedIds.has(note?.conflictOf));
            if (filteredLiveNotes.length !== window.notes.length) {
                window.notes = filteredLiveNotes;
                await window.persistLocalLibrary?.(uid, filteredLiveNotes, window.getFolders?.() || [], Date.now());
                window.renderNotes?.();
                window.updateNavigationCounts?.();
            }
        }

        const notes = structuredClone(Array.isArray(window.notes) ? window.notes : [])
            .filter(note => !deletedIds.has(note?.id) && !deletedIds.has(note?.conflictOf));
        const folders = structuredClone(Array.isArray(window.getFolders?.()) ? window.getFolders() : []);
        if (notes.some(note => privateNoteMetadataNeedsMigration(note))) {
            markSyncPending(uid);
            window.showToast?.("Cloud sync is paused. Unlock Private Notes once to encrypt legacy private metadata.", "warning");
            return false;
        }
        let pages;
        try {
            pages = packLibraryPages(notes, folders);
        } catch (error) {
            console.error("Cloud library contains a record larger than a safe Firestore page:", error);
            markSyncPending(uid);
            window.showToast?.("Cloud sync is pending: one note or attachment record is too large to sync safely.", "warning");
            return false;
        }

        const deviceId = getDeviceId();
        const syncedAt = new Date().toISOString();
        stagedRevision = crypto.randomUUID();

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
                syncVersion: 2,
                lastSyncedBy: deviceId,
                inactiveLibraryRevisions: [...inactiveLibraryRevisions],
                devices: {
                    [deviceId]: { name: getDeviceName(), lastSeen: syncedAt }
                },
                notes: deleteField(),
                folders: deleteField()
            }, { merge: true });
        });

        const inactiveRevisions = new Set([
            ...(Array.isArray(existingData.inactiveLibraryRevisions) ? existingData.inactiveLibraryRevisions : []),
            ...(baseRevision && baseRevision !== stagedRevision ? [baseRevision] : [])
        ]);
        const keepRevision = recoveryBackupByUid.get(uid) || null;
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
        const localNotes = Array.isArray(window.notes) ? window.notes : [];
        const localFolders = Array.isArray(window.getFolders?.()) ? window.getFolders() : [];
        const activeRevision = cloudData.activeLibraryRevision || null;
        const inactiveRevisions = (Array.isArray(cloudData.inactiveLibraryRevisions)
            ? cloudData.inactiveLibraryRevisions
            : []).filter(revision => typeof revision === "string" && revision && revision !== activeRevision);

        if (activeRevision) {
            const library = await readLibraryRevision(uid, activeRevision);
            if (!isCurrentLoad(session)) return;
            const hasRecordedPageCount = cloudData.libraryPageCount !== undefined &&
                cloudData.libraryPageCount !== null && cloudData.libraryPageCount !== "";
            const revisionComplete = hasRecordedPageCount
                ? Number.isInteger(Number(cloudData.libraryPageCount)) &&
                    Number(cloudData.libraryPageCount) >= 0 &&
                    Number(cloudData.libraryPageCount) === library.pageCount
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

                if (recovery) {
                    cloudNotes = mergeNotes([...cloudNotes, ...library.notes], recovery.library.notes);
                    cloudFolders = [...cloudFolders, ...library.folders, ...recovery.library.folders];
                    recoveryBackupByUid.set(uid, recovery.revision);
                    window.showToast?.("Recovered notes from a retained cloud backup.", "success");
                } else {
                    const hasLocalRecovery = localNotes.length > 0 || localFolders.length > 0;
                    const hasLegacyCloudData = cloudNotes.length > 0 || cloudFolders.length > 0;
                    if (!hasLocalRecovery && !hasLegacyCloudData) {
                        markSyncPending(uid);
                        window.showToast?.("The cloud library is incomplete and no safe recovery copy was found. Sync is paused to protect your notes.", "warning");
                        return;
                    }
                    // Keep the incomplete revision as a recovery copy while publishing
                    // the verified local/legacy data. Never delete it during this sync.
                    recoveryBackupByUid.set(uid, activeRevision);
                    cloudNotes = [...cloudNotes, ...library.notes];
                    cloudFolders = [...cloudFolders, ...library.folders];
                    window.showToast?.("Cloud library is incomplete. Recoverable notes are being preserved while sync is repaired.", "warning");
                }
            } else {
                cloudNotes = [...cloudNotes, ...library.notes];
                cloudFolders = [...cloudFolders, ...library.folders];
            }
        }

        if (activeRevision && !cloudNotes.length && !cloudFolders.length &&
            !localNotes.length && !localFolders.length) {
            markSyncPending(uid);
            window.showToast?.("No notes could be verified in cloud storage. Sync is paused to protect your existing notes.", "warning");
            return;
        }

        const localDeletionMarkers = await readPermanentNoteDeletions(uid);
        const cloudDeletedIds = await readCloudNoteDeletionIds(uid);
        if (!isCurrentLoad(session)) return;
        const deletedIds = new Set([...localDeletionMarkers.map(marker => marker.id), ...cloudDeletedIds]);
        const merged = mergeNotes(localNotes, cloudNotes, [...deletedIds]);
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
    await setDoc(doc(db, "users", uid), { accountDeletion }, { merge: true });
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
        transaction.set(userRef, { accountDeletion: null }, { merge: true });
    });
    localStorage.removeItem(`${DELETION_KEY_PREFIX}${uid}`);
}

async function syncPendingChanges() {
    const uid = auth?.currentUser?.uid;
    if (!uid || !navigator.onLine || !belongsToCurrentAccount(uid)) return;
    if (localStorage.getItem(pendingKey(uid)) !== "true" && localStorage.getItem(PENDING_KEY) !== "true") return;
    await syncToCloud(uid);
}

window.syncToCloud = syncToCloud;
window.getAccountDeletionStatus = getAccountDeletionStatus;
window.scheduleAccountDeletion = scheduleAccountDeletion;
window.cancelAccountDeletion = cancelAccountDeletion;
window.addEventListener("snapnotes:cloud-conflict", event => {
    const uid = event.detail?.uid;
    if (belongsToCurrentAccount(uid)) void loadFromCloud(uid);
});
window.addEventListener("online", syncPendingChanges);
window.addEventListener("snapnotes:auth-ready", syncPendingChanges);
