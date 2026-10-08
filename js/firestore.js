import { db, auth } from "./firebaseConfig.js";
import {
    doc,
    setDoc,
    getDoc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const PENDING_KEY = "SnapNotesSyncPending";

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

function markSyncPending() {
    localStorage.setItem(PENDING_KEY, "true");
    window.dispatchEvent(new CustomEvent("snapnotes:sync-status", {
        detail: { status: "pending" }
    }));
}

function clearSyncPending() {
    localStorage.removeItem(PENDING_KEY);
    window.dispatchEvent(new CustomEvent("snapnotes:sync-status", {
        detail: { status: "synced" }
    }));
}

function noteSignature(note) {
    return JSON.stringify({
        title: note?.title || "",
        text: note?.text || "",
        html: note?.html || "",
        category: note?.category || "general",
        tags: Array.isArray(note?.tags) ? [...note.tags].sort() : [],
        pinned: Boolean(note?.pinned),
        archived: Boolean(note?.archived),
        deletedAt: note?.deletedAt || null,
        reminderAt: note?.reminderAt || null,
        reminderRecurrence: note?.reminderRecurrence || null,
        folderId: note?.folderId || null,
        attachments: Array.isArray(note?.attachments)
            ? note.attachments.map(attachment => attachment?.id || "").sort()
            : []
    });
}

function createConflictCopy(note) {
    const now = new Date().toISOString();
    return {
        ...structuredClone(note),
        id: crypto.randomUUID(),
        title: `Conflict: ${note.title || "Untitled note"}`,
        createdAt: now,
        updatedAt: now,
        pinned: false,
        syncConflict: true,
        conflictOf: note.id
    };
}

function mergeNotes(localNotes = [], cloudNotes = []) {
    const merged = new Map();
    const conflicts = [];

    [...cloudNotes, ...localNotes].forEach(note => {
        if (!note?.id) return;
        const existing = merged.get(note.id);
        if (!existing) {
            merged.set(note.id, note);
            return;
        }

        const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
        const incomingTime = new Date(note.updatedAt || note.createdAt || 0).getTime();

        if (incomingTime === existingTime && noteSignature(existing) !== noteSignature(note)) {
            // Both devices changed the same note at the same timestamp. Keep the
            // local-first winner but preserve the other version as a conflict copy.
            const localVersion = localNotes.some(item => item?.id === note.id && noteSignature(item) === noteSignature(note));
            const winner = localVersion ? note : existing;
            const loser = localVersion ? existing : note;
            merged.set(note.id, winner);
            conflicts.push(createConflictCopy(loser));
        } else if (incomingTime > existingTime) {
            merged.set(note.id, note);
        }
    });

    return [...merged.values(), ...conflicts];
}

export async function syncToCloud() {
    if (!auth?.currentUser) return false;

    if (!navigator.onLine) {
        markSyncPending();
        return false;
    }

    const uid = auth.currentUser.uid;

    try {
        const userDocRef = doc(db, "users", uid);
        await setDoc(userDocRef, {
            notes: Array.isArray(window.notes) ? window.notes : [],
            folders: Array.isArray(window.getFolders?.()) ? window.getFolders() : [],
            lastSynced: new Date().toISOString(),
            syncVersion: 1,
            lastSyncedBy: getDeviceId(),
            devices: {
                [getDeviceId()]: {
                    name: getDeviceName(),
                    lastSeen: new Date().toISOString()
                }
            }
        }, { merge: true });

        clearSyncPending();
        return true;
    } catch (error) {
        console.error("Cloud sync failed:", error);
        markSyncPending();
        return false;
    }
}

export async function loadFromCloud(uid) {
    try {
        const userDocRef = doc(db, "users", uid);
        const docSnap = await getDoc(userDocRef);

        if (!docSnap.exists()) {
            await syncToCloud();
            return;
        }

        const cloudData = docSnap.data();
        const cloudNotes = Array.isArray(cloudData.notes) ? cloudData.notes : [];
        const localNotes = Array.isArray(window.notes) ? window.notes : [];
        const cloudFolders = Array.isArray(cloudData.folders) ? cloudData.folders : [];
        const localFolders = Array.isArray(window.getFolders?.()) ? window.getFolders() : [];

        const merged = mergeNotes(localNotes, cloudNotes);
        const folderMap = new Map();
        [...cloudFolders, ...localFolders].forEach(folder => {
            if (!folder?.id) return;
            const existing = folderMap.get(folder.id);
            if (!existing) {
                folderMap.set(folder.id, folder);
                return;
            }
            const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
            const incomingTime = new Date(folder.updatedAt || folder.createdAt || 0).getTime();
            if (incomingTime > existingTime) folderMap.set(folder.id, folder);
        });
        const mergedFolders = [...folderMap.values()].slice(0, 20);

        window.notes = merged;
        localStorage.setItem("SnapNotes", JSON.stringify(merged));
        localStorage.setItem("SnapNotesFolders", JSON.stringify(mergedFolders));
        window.loadFolders?.();

        window.renderNotes();
        window.checkDueReminders?.();
        window.handlePendingNotificationNote?.();
        if (typeof window.updateNavigationCounts === "function") {
            window.updateNavigationCounts();
        }

        await syncToCloud();

        if (merged.length) {
            window.showToast("Notes synced", "success");
        }
    } catch (error) {
        console.error("Failed to sync notes:", error);
        markSyncPending();
    }
}

export async function getAccountDeletionStatus(uid) {
    if (!uid) return null;
    const snapshot = await getDoc(doc(db, "users", uid));
    return snapshot.exists() ? snapshot.data().accountDeletion || null : null;
}

export async function scheduleAccountDeletion(uid) {
    if (!uid) throw new Error("A signed-in account is required.");
    const requestedAt = new Date();
    const scheduledFor = new Date(requestedAt.getTime() + 10 * 24 * 60 * 60 * 1000);
    const accountDeletion = {
        requestedAt: requestedAt.toISOString(),
        scheduledFor: scheduledFor.toISOString()
    };
    await setDoc(doc(db, "users", uid), { accountDeletion }, { merge: true });
    return accountDeletion;
}

export async function cancelAccountDeletion(uid) {
    if (!uid) throw new Error("A signed-in account is required.");
    await setDoc(doc(db, "users", uid), { accountDeletion: null }, { merge: true });
}

async function syncPendingChanges() {
    if (localStorage.getItem(PENDING_KEY) !== "true") return;
    if (!navigator.onLine || !auth?.currentUser) return;

    await syncToCloud();
}

window.syncToCloud = syncToCloud;
window.getAccountDeletionStatus = getAccountDeletionStatus;
window.scheduleAccountDeletion = scheduleAccountDeletion;
window.cancelAccountDeletion = cancelAccountDeletion;
window.addEventListener("online", syncPendingChanges);
window.addEventListener("snapnotes:auth-ready", syncPendingChanges);
