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

function mergeNotes(localNotes = [], cloudNotes = []) {
    const merged = new Map();

    [...cloudNotes, ...localNotes].forEach(note => {
        if (!note?.id) return;

        const existing = merged.get(note.id);
        if (!existing) {
            merged.set(note.id, note);
            return;
        }

        const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
        const incomingTime = new Date(note.updatedAt || note.createdAt || 0).getTime();

        if (incomingTime >= existingTime) {
            merged.set(note.id, note);
        }
    });

    return Array.from(merged.values());
}

export async function syncToCloud() {
    if (!auth.currentUser) return false;

    if (!navigator.onLine) {
        markSyncPending();
        return false;
    }

    const uid = auth.currentUser.uid;

    try {
        const userDocRef = doc(db, "users", uid);
        await setDoc(userDocRef, {
            notes: Array.isArray(window.notes) ? window.notes : [],
            lastSynced: new Date().toISOString(),
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

        const merged = mergeNotes(localNotes, cloudNotes);

        window.notes = merged;
        localStorage.setItem("SnapNotes", JSON.stringify(merged));

        window.renderNotes();
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

async function syncPendingChanges() {
    if (localStorage.getItem(PENDING_KEY) !== "true") return;
    if (!navigator.onLine || !auth.currentUser) return;

    await syncToCloud();
}

window.syncToCloud = syncToCloud;
window.addEventListener("online", syncPendingChanges);
window.addEventListener("snapnotes:auth-ready", syncPendingChanges);
