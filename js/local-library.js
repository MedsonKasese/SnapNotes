const DATABASE_NAME = "SnapNotesLocal";
const DATABASE_VERSION = 2;
const LIBRARY_STORE = "libraries";
const DELETION_STORE = "deletions";

function waitForTransaction(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Local library storage failed."));
        transaction.onabort = () => reject(transaction.error || new Error("Local library storage was interrupted."));
    });
}

export function createLocalLibraryStore(indexedDB = globalThis.indexedDB) {
    let databasePromise;

    function openDatabase() {
        if (!indexedDB?.open) return Promise.reject(new Error("IndexedDB is not available."));
        if (databasePromise) return databasePromise;
        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(LIBRARY_STORE)) {
                    database.createObjectStore(LIBRARY_STORE, { keyPath: "id" });
                }
                if (!database.objectStoreNames.contains(DELETION_STORE)) {
                    database.createObjectStore(DELETION_STORE, { keyPath: "key" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Could not open local library storage."));
            request.onblocked = () => reject(new Error("Local library storage is blocked by another app tab."));
        });
        return databasePromise;
    }

    return {
        async write(id, notes, folders, savedAt = Date.now()) {
            const database = await openDatabase();
            const transaction = database.transaction(LIBRARY_STORE, "readwrite");
            transaction.objectStore(LIBRARY_STORE).put({
                id: String(id || "local"),
                notes: structuredClone(Array.isArray(notes) ? notes : []),
                folders: structuredClone(Array.isArray(folders) ? folders : []),
                savedAt: Number(savedAt) || Date.now()
            });
            await waitForTransaction(transaction);
            return true;
        },
        async read(id) {
            const database = await openDatabase();
            const transaction = database.transaction(LIBRARY_STORE, "readonly");
            const request = transaction.objectStore(LIBRARY_STORE).get(String(id || "local"));
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error || new Error("Could not read local library storage."));
            });
        },
        async remove(id) {
            const database = await openDatabase();
            const transaction = database.transaction([LIBRARY_STORE, DELETION_STORE], "readwrite");
            transaction.objectStore(LIBRARY_STORE).delete(String(id || "local"));
            const deletionStore = transaction.objectStore(DELETION_STORE);
            const request = deletionStore.getAll();
            request.onsuccess = () => {
                request.result.forEach(marker => {
                    if (marker.uid === String(id || "local")) deletionStore.delete(marker.key);
                });
            };
            await waitForTransaction(transaction);
            return true;
        },
        async writeDeletionMarkers(markers) {
            if (!markers.length) return true;
            const database = await openDatabase();
            const transaction = database.transaction(DELETION_STORE, "readwrite");
            const store = transaction.objectStore(DELETION_STORE);
            markers.forEach(marker => {
                store.put({ ...marker, key: `${marker.uid || "local"}:${marker.id}` });
            });
            await waitForTransaction(transaction);
            return true;
        },
        async readDeletionMarkers() {
            const database = await openDatabase();
            const transaction = database.transaction(DELETION_STORE, "readonly");
            const request = transaction.objectStore(DELETION_STORE).getAll();
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error || new Error("Could not read local deletion markers."));
            });
        },
        async removeDeletionMarkers(uid, ids, includeLocal = false) {
            const idSet = new Set(ids || []);
            if (!idSet.size) return true;
            const database = await openDatabase();
            const transaction = database.transaction(DELETION_STORE, "readwrite");
            const store = transaction.objectStore(DELETION_STORE);
            const request = store.getAll();
            request.onsuccess = () => {
                request.result.forEach(marker => {
                    const ownerMatches = marker.uid === uid || (includeLocal && marker.uid == null);
                    if (ownerMatches && idSet.has(marker.id)) store.delete(marker.key);
                });
            };
            await waitForTransaction(transaction);
            return true;
        }
    };
}

let defaultStore;

function getDefaultStore() {
    if (!defaultStore) defaultStore = createLocalLibraryStore(globalThis.indexedDB);
    return defaultStore;
}

export async function persistLocalLibrary(id, notes, folders, savedAt = Date.now()) {
    return getDefaultStore().write(id, notes, folders, savedAt);
}

export async function readLocalLibrary(id) {
    return getDefaultStore().read(id);
}

export async function deleteLocalLibrary(id) {
    return getDefaultStore().remove(id);
}

export async function writeLocalDeletionMarkers(markers) {
    return getDefaultStore().writeDeletionMarkers(markers);
}

export async function readLocalDeletionMarkers() {
    return getDefaultStore().readDeletionMarkers();
}

export async function removeLocalDeletionMarkers(uid, ids, includeLocal = false) {
    return getDefaultStore().removeDeletionMarkers(uid, ids, includeLocal);
}
