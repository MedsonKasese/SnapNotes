import { readLocalDeletionMarkers, removeLocalDeletionMarkers, writeLocalDeletionMarkers } from "./local-library.js";

const STORAGE_KEY = "SnapNotesPermanentDeletionMarkers";

function activeUid() {
    if (window.snapNotesDataUid !== undefined) return window.snapNotesDataUid || null;
    return window.firebaseAuth?.currentUser?.uid || null;
}

function readStorageMarkers(storage = globalThis.localStorage) {
    try {
        const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter(marker => marker?.id && typeof marker.id === "string") : [];
    } catch {
        return [];
    }
}

function markerKey(marker) {
    return `${marker.uid || "local"}:${marker.id}`;
}

function uniqueMarkers(markers) {
    const unique = new Map();
    for (const marker of markers) {
        if (!marker?.id || typeof marker.id !== "string") continue;
        const normalized = { id: marker.id, uid: marker.uid || null, deletedAt: marker.deletedAt || new Date().toISOString() };
        unique.set(markerKey(normalized), normalized);
    }
    return [...unique.values()];
}

export async function recordPermanentNoteDeletions(ids, uid = activeUid(), storage = globalThis.localStorage) {
    const validIds = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === "string" && id.length))];
    if (!validIds.length) return true;
    const now = new Date().toISOString();
    const owner = uid || null;
    const existing = readStorageMarkers(storage);
    const markers = uniqueMarkers([...existing, ...validIds.map(id => ({ id, uid: owner, deletedAt: now }))]);
    let localStorageSaved = false;
    let indexedDbSaved = false;
    try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(markers));
        localStorageSaved = Boolean(storage);
    } catch (error) {
        console.warn("Could not persist permanent-deletion markers in localStorage:", error);
    }
    try {
        await writeLocalDeletionMarkers(validIds.map(id => ({ id, uid: owner, deletedAt: now })));
        indexedDbSaved = true;
    } catch (error) {
        console.warn("Could not persist permanent-deletion markers in IndexedDB:", error);
    }
    return localStorageSaved || indexedDbSaved;
}

export async function readPermanentNoteDeletions(uid = activeUid(), storage = globalThis.localStorage) {
    const localMarkers = readStorageMarkers(storage);
    let durableMarkers = [];
    try {
        durableMarkers = await readLocalDeletionMarkers();
    } catch (error) {
        console.warn("Could not read durable permanent-deletion markers:", error);
    }
    return uniqueMarkers([...localMarkers, ...durableMarkers])
        .filter(marker => marker.uid == null || marker.uid === uid);
}

export async function clearPermanentNoteDeletions(uid, ids, storage = globalThis.localStorage) {
    const idSet = new Set(Array.isArray(ids) ? ids : []);
    if (!idSet.size) return true;
    const markers = readStorageMarkers(storage).filter(marker =>
        !(idSet.has(marker.id) && (marker.uid === uid || marker.uid == null)));
    let localStorageCleared = false;
    let indexedDbCleared = false;
    try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(markers));
        localStorageCleared = Boolean(storage);
    } catch (error) {
        console.warn("Could not clear synced deletion markers from localStorage:", error);
    }
    try {
        await removeLocalDeletionMarkers(uid, [...idSet], true);
        indexedDbCleared = true;
    } catch (error) {
        console.warn("Could not clear synced deletion markers from IndexedDB:", error);
    }
    return localStorageCleared || indexedDbCleared;
}

export async function clearAccountPermanentNoteDeletions(uid, storage = globalThis.localStorage) {
    if (!uid) return true;
    let durableMarkers = [];
    try { durableMarkers = await readLocalDeletionMarkers(); } catch {}
    const ownedIds = new Set([
        ...readStorageMarkers(storage).filter(marker => marker.uid === uid).map(marker => marker.id),
        ...durableMarkers.filter(marker => marker.uid === uid).map(marker => marker.id)
    ]);
    const remaining = readStorageMarkers(storage).filter(marker => marker.uid !== uid);
    let localStorageCleared = false;
    let indexedDbCleared = false;
    try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(remaining));
        localStorageCleared = Boolean(storage);
    } catch (error) {
        console.warn("Could not clear account-scoped deletion markers from localStorage:", error);
    }
    try {
        await removeLocalDeletionMarkers(uid, [...ownedIds], false);
        indexedDbCleared = true;
    } catch (error) {
        console.warn("Could not clear account-scoped deletion markers from IndexedDB:", error);
    }
    return localStorageCleared || indexedDbCleared;
}

if (typeof window !== "undefined") {
    window.recordPermanentNoteDeletions = ids => recordPermanentNoteDeletions(ids);
    window.clearPermanentNoteDeletions = ids => clearPermanentNoteDeletions(activeUid(), ids);
    window.readPermanentNoteDeletions = uid => readPermanentNoteDeletions(uid);
    window.clearAccountPermanentNoteDeletions = uid => clearAccountPermanentNoteDeletions(uid);
}
