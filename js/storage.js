import { deleteLocalLibrary, persistLocalLibrary as writeIndexedDbLibrary, readLocalLibrary } from "./local-library.js";

// =========================
// CENTRALIZED STATE
// =========================

let notes = [];
window.notes = notes;
let localLoadGeneration = 0;
let localStateRevision = 0;

function activeLibraryId() {
    if (window.snapNotesDataUid !== undefined) return window.snapNotesDataUid || "local";
    return window.firebaseAuth?.currentUser?.uid || "local";
}

function tryGetLocalStorage(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function trySetLocalStorage(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (error) {
        console.warn(`Could not update localStorage key ${key}:`, error);
        return false;
    }
}

let persistenceRequested = false;
function requestPersistentOriginStorage() {
    if (persistenceRequested) return;
    persistenceRequested = true;
    if (!navigator.storage?.persist) return;
    void navigator.storage.persisted?.().then(persisted => {
        if (!persisted) return navigator.storage.persist();
        return true;
    }).catch(error => console.warn("Could not request persistent browser storage:", error));
}

async function persistLibrarySnapshot(id, noteSnapshot, folderSnapshot, savedAt = Date.now()) {
    requestPersistentOriginStorage();
    const libraryId = String(id || "local");
    let indexedDbSaved = false;
    let localStorageSaved = false;

    try {
        await writeIndexedDbLibrary(libraryId, noteSnapshot, folderSnapshot, savedAt);
        indexedDbSaved = true;
    } catch (error) {
        console.warn("Could not persist the local library to IndexedDB:", error);
    }

    if (libraryId === String(activeLibraryId())) {
        const notesSaved = trySetLocalStorage("SnapNotes", JSON.stringify(noteSnapshot));
        const foldersSaved = trySetLocalStorage("SnapNotesFolders", JSON.stringify(folderSnapshot));
        const timeSaved = trySetLocalStorage("SnapNotesSavedAt", String(savedAt));
        localStorageSaved = notesSaved && foldersSaved && timeSaved;
    }

    return { savedAt, indexedDbSaved, localStorageSaved, locallySaved: indexedDbSaved || localStorageSaved };
}

// =========================
// SAVE NOTES TO DURABLE LOCAL STORAGE + CLOUD
// =========================

async function saveNotes() {
    localStateRevision++;
    const notesSnapshot = structuredClone(Array.isArray(window.notes) ? window.notes : []);
    const foldersSnapshot = structuredClone(Array.isArray(window.getFolders?.()) ? window.getFolders() : []);
    const savedAt = Date.now();
    const libraryId = activeLibraryId();
    const localResult = await persistLibrarySnapshot(libraryId, notesSnapshot, foldersSnapshot, savedAt);

    if (!localResult.locallySaved) {
        window.showToast?.("Local storage is unavailable. Keep this page open and reconnect to sync your notes.", "warning");
    }

    const cloudEnabled = Boolean(window.firebaseAuth?.currentUser);
    if (!cloudEnabled || typeof window.syncToCloud !== "function") {
        return { synced: false, cloudEnabled, locallySaved: localResult.locallySaved };
    }

    try {
        const synced = await window.syncToCloud();
        return { synced: synced === true, cloudEnabled: true, locallySaved: localResult.locallySaved };
    } catch (error) {
        console.error("Cloud save failed after local save:", error);
        return { synced: false, cloudEnabled: true, locallySaved: localResult.locallySaved };
    }
}

// =========================
// LOAD NOTES FROM LOCAL STORAGE, THEN RECOVER A NEWER DURABLE SNAPSHOT
// =========================

function loadNotes() {
    const generation = ++localLoadGeneration;
    const revision = localStateRevision;
    const libraryId = String(activeLibraryId());
    const savedNotes = tryGetLocalStorage("SnapNotes");
    let hasLocalNotes = false;

    if (savedNotes) {
        try {
            const parsed = JSON.parse(savedNotes);
            if (Array.isArray(parsed)) {
                window.notes = parsed;
                hasLocalNotes = true;
                renderNotes();
            }
        } catch (error) {
            console.error("Failed to parse notes from local storage", error);
            window.notes = [];
        }
    }

    const localSavedAt = Number(tryGetLocalStorage("SnapNotesSavedAt")) || 0;
    const restore = readLocalLibrary(libraryId).then(record => {
        if (!record || !Array.isArray(record.notes)) return;
        if (generation !== localLoadGeneration || revision !== localStateRevision || libraryId !== String(activeLibraryId())) return;
        if (hasLocalNotes && Number(record.savedAt) <= localSavedAt) return;

        window.notes = record.notes;
        const savedAt = Number(record.savedAt) || Date.now();
        trySetLocalStorage("SnapNotes", JSON.stringify(record.notes));
        trySetLocalStorage("SnapNotesSavedAt", String(savedAt));
        if (Array.isArray(record.folders)) trySetLocalStorage("SnapNotesFolders", JSON.stringify(record.folders));
        window.loadFolders?.();
        renderNotes();
        window.updateNavigationCounts?.();
    }).catch(error => {
        console.warn("Could not recover the durable local notes snapshot:", error);
    });

    window.localNotesReady = restore;
    return restore;
}

// =========================
// TOAST NOTIFICATION
// =========================

let toastTimeout;

function showToast(message, type = "default") {
    const toast = document.getElementById("toast");
    if (!toast) return;

    clearTimeout(toastTimeout);
    toast.textContent = message;
    toast.className = "";
    toast.classList.add(type);
    toast.style.opacity = "1";

    toastTimeout = setTimeout(function () {
        toast.style.opacity = "0";
    }, 2000);
}

// Expose to window for other scripts.
window.showToast = showToast;
window.saveNotes = saveNotes;
window.loadNotes = loadNotes;
window.persistLocalLibrary = persistLibrarySnapshot;
window.readLocalLibrary = readLocalLibrary;
window.deleteLocalLibrarySnapshot = deleteLocalLibrary;
