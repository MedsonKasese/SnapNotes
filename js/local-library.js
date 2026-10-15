const DATABASE_NAME = "SnapNotesLocal";
const DATABASE_VERSION = 1;
const LIBRARY_STORE = "libraries";

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
            const transaction = database.transaction(LIBRARY_STORE, "readwrite");
            transaction.objectStore(LIBRARY_STORE).delete(String(id || "local"));
            await waitForTransaction(transaction);
            return true;
        }
    };
}

const defaultStore = createLocalLibraryStore();

export async function persistLocalLibrary(id, notes, folders, savedAt = Date.now()) {
    return defaultStore.write(id, notes, folders, savedAt);
}

export async function readLocalLibrary(id) {
    return defaultStore.read(id);
}

export async function deleteLocalLibrary(id) {
    return defaultStore.remove(id);
}
