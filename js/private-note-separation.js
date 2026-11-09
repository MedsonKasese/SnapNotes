import { privateNoteMetadataNeedsMigration } from "./private-note-utils.js";
import { noteTimestamp } from "./note-sync.js";

const PRIVATE_CRYPTO_VERSION = 1;
const PRIVATE_KDF_ITERATIONS = 600000;
const MAX_PRIVATE_RECORD_BYTES = 450 * 1024;
const PRIVATE_NOTE_FIELDS = new Set([
    "id", "documentKey", "privateRecovery", "privateRecoveryFingerprint", "privateRecoverySourceId", "privateRecoveryParentId", "isPrivate", "privateData", "createdAt", "updatedAt", "pinned",
    "archived", "deletedAt", "restoredAt", "title", "text", "html",
    "category", "tags", "time", "reminderAt", "reminderNotified",
    "reminderRepeat", "versions", "attachments", "folderId", "history"
]);
const PRIVATE_DATA_FIELDS = new Set([
    "version", "algorithm", "kdf", "iterations", "salt", "iv", "ciphertext"
]);

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function stablePrivateRecordJson(record) {
    return JSON.stringify(stableValue(record));
}

export function isEncryptedPrivateNote(note) {
    if (!note || typeof note !== "object" || Array.isArray(note)) return false;
    const data = note?.privateData;
    const noteKeys = note && typeof note === "object" ? Object.keys(note) : [];
    const dataKeys = data && typeof data === "object" ? Object.keys(data) : [];
    if (noteKeys.some(key => !PRIVATE_NOTE_FIELDS.has(key)) ||
        dataKeys.some(key => !PRIVATE_DATA_FIELDS.has(key))) return false;

    const safeShell = (!Object.hasOwn(note, "title") || note.title === "Private note") &&
        (!Object.hasOwn(note, "documentKey") || note.documentKey === encodeURIComponent(note.id)) &&
        (!Object.hasOwn(note, "createdAt") || typeof note.createdAt === "string") &&
        (!Object.hasOwn(note, "updatedAt") || typeof note.updatedAt === "string") &&
        (!Object.hasOwn(note, "pinned") || typeof note.pinned === "boolean") &&
        (!Object.hasOwn(note, "archived") || typeof note.archived === "boolean") &&
        (!Object.hasOwn(note, "deletedAt") || note.deletedAt === null || typeof note.deletedAt === "string") &&
        (!Object.hasOwn(note, "restoredAt") || note.restoredAt === null || typeof note.restoredAt === "string") &&
        ((!Object.hasOwn(note, "privateRecovery") && !Object.hasOwn(note, "privateRecoveryFingerprint") &&
            !Object.hasOwn(note, "privateRecoverySourceId") && !Object.hasOwn(note, "privateRecoveryParentId")) ||
            (note.privateRecovery === true && typeof note.privateRecoveryFingerprint === "string" && /^[a-f0-9]{64}$/.test(note.privateRecoveryFingerprint) &&
                typeof note.privateRecoverySourceId === "string" && note.privateRecoverySourceId.length > 0 &&
                typeof note.privateRecoveryParentId === "string" && note.privateRecoveryParentId.length > 0)) &&
        (!Object.hasOwn(note, "text") || note.text === "") &&
        (!Object.hasOwn(note, "html") || note.html === "") &&
        (!Object.hasOwn(note, "category") || note.category === "general") &&
        (!Object.hasOwn(note, "tags") || (Array.isArray(note.tags) && note.tags.length === 0)) &&
        (!Object.hasOwn(note, "time") || note.time === "Private note" || note.time === "Locked") &&
        (!Object.hasOwn(note, "reminderAt") || note.reminderAt === null) &&
        (!Object.hasOwn(note, "reminderNotified") || note.reminderNotified === false) &&
        (!Object.hasOwn(note, "reminderRepeat") || note.reminderRepeat === null) &&
        (!Object.hasOwn(note, "folderId") || note.folderId === null) &&
        (!Object.hasOwn(note, "attachments") || (Array.isArray(note.attachments) && note.attachments.length === 0)) &&
        (!Object.hasOwn(note, "versions") || (Array.isArray(note.versions) && note.versions.length === 0)) &&
        (!Object.hasOwn(note, "history") || (Array.isArray(note.history) && note.history.length === 0));

    if (!safeShell) return false;
    let byteLength;
    try { byteLength = new TextEncoder().encode(stablePrivateRecordJson(note)).length; }
    catch { return false; }

    return Boolean(
        note?.isPrivate === true &&
        typeof note.id === "string" && note.id.length > 0 &&
        data && typeof data === "object" &&
        Number(data.version) === PRIVATE_CRYPTO_VERSION &&
        data.algorithm === "AES-GCM" &&
        data.kdf === "PBKDF2-SHA-256" &&
        Number(data.iterations) === PRIVATE_KDF_ITERATIONS &&
        typeof data.salt === "string" && data.salt.length > 0 &&
        typeof data.iv === "string" && data.iv.length > 0 &&
        typeof data.ciphertext === "string" && data.ciphertext.length > 0 &&
        !privateNoteMetadataNeedsMigration(note) &&
        byteLength <= MAX_PRIVATE_RECORD_BYTES
    );
}

export function splitPrivateNotesFromLibrary(notes = []) {
    const source = Array.isArray(notes) ? notes : [];
    return {
        notes: source.filter(note => !note?.isPrivate),
        privateNotes: source.filter(note => note?.isPrivate)
    };
}

export function createPrivateRecoveryCopy(record, fingerprint) {
    if (!isEncryptedPrivateNote(record) || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw new Error("A valid encrypted version is required to create a recovery copy.");
    }
    const id = `private-recovery-${fingerprint}`;
    return {
        id,
        documentKey: encodeURIComponent(id),
        privateRecovery: true,
        privateRecoveryFingerprint: fingerprint,
        privateRecoverySourceId: record.privateRecoverySourceId || record.id,
        privateRecoveryParentId: record.id,
        isPrivate: true,
        privateData: structuredClone(record.privateData),
        createdAt: record.createdAt || "",
        updatedAt: record.updatedAt || "",
        pinned: false,
        archived: false,
        deletedAt: null,
        restoredAt: null,
        title: "Private note",
        text: "",
        html: "",
        category: "general",
        tags: [],
        time: "Private note",
        reminderAt: null,
        reminderNotified: false,
        reminderRepeat: null,
        versions: []
    };
}

export async function privateRecordFingerprint(record) {
    if (!globalThis.crypto?.subtle) {
        throw new Error("Web Crypto is required to preserve encrypted Private Notes safely.");
    }
    const bytes = new TextEncoder().encode(stablePrivateRecordJson(record));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function planPrivateRecordReconciliation(existing, incoming) {
    if (!isEncryptedPrivateNote(incoming)) {
        throw new Error("Private-note preservation stopped because a record is not safely encrypted.");
    }
    if (!existing) {
        return { canonical: structuredClone(incoming), archivedRecords: [] };
    }
    if (!isEncryptedPrivateNote(existing) || existing.id !== incoming.id) {
        throw new Error("Private-note preservation stopped because the existing record is invalid.");
    }

    if (stablePrivateRecordJson(existing) === stablePrivateRecordJson(incoming)) {
        return { canonical: structuredClone(existing), archivedRecords: [] };
    }

    if (noteTimestamp(incoming) >= noteTimestamp(existing)) {
        return {
            canonical: structuredClone(incoming),
            archivedRecords: [structuredClone(existing)]
        };
    }

    // The caller orders the fully merged local winner last. An older variant
    // never replaces a newer cloud copy; its ciphertext is archived instead.
    return {
        canonical: structuredClone(existing),
        archivedRecords: [structuredClone(incoming)]
    };
}

export async function ensurePrivateNotesPreserved(candidates = [], store) {
    if (!store || typeof store.reconcile !== "function" ||
        typeof store.readCurrent !== "function" || typeof store.readVersion !== "function") {
        throw new TypeError("A private-note preservation store is required.");
    }

    const seen = new Set();
    let preserved = 0;
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        if (!candidate?.isPrivate) continue;
        if (!isEncryptedPrivateNote(candidate)) {
            throw new Error("Cloud sync is paused until every Private Note has a valid encrypted payload and protected metadata.");
        }
        const fingerprint = await privateRecordFingerprint(candidate);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);

        const result = await store.reconcile(structuredClone(candidate));
        if (!result || !isEncryptedPrivateNote(result.canonical)) {
            throw new Error("Private-note preservation could not verify a safe canonical record.");
        }
        for (const archived of result.archivedRecords || []) {
            const versionId = await privateRecordFingerprint(archived);
            const storedVersion = await store.readVersion(versionId);
            if (!storedVersion || storedVersion.noteId !== archived.id ||
                storedVersion.documentKey !== encodeURIComponent(archived.id) ||
                stablePrivateRecordJson(storedVersion.record) !== stablePrivateRecordJson(archived)) {
                throw new Error("Private-note preservation could not verify an archived encrypted version.");
            }
        }
        const canonical = await store.readCurrent(candidate.id);
        if (!canonical || stablePrivateRecordJson(canonical) !== stablePrivateRecordJson(result.canonical)) {
            throw new Error("Private-note preservation could not verify the encrypted record after writing it.");
        }
        preserved++;
    }
    return { preserved };
}

export function privateRecordsForCleanup(records = [], deletedIds = new Set(), movedOutIds = new Set()) {
    const selected = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        const lineage = [record?.id, record?.privateRecoverySourceId, record?.privateRecoveryParentId]
            .filter(value => typeof value === "string" && value);
        if (lineage.some(id => deletedIds.has(id) || movedOutIds.has(id))) {
            if (typeof record.id === "string" && record.id) selected.set(record.id, record);
        }
    }
    return selected;
}

export function localPrivateSnapshotVerified(persisted, localStorageMatches) {
    return persisted?.indexedDbSaved === true && persisted?.localStorageSaved === true && localStorageMatches === true;
}

export function privateMigrationPreflightComplete(preflight) {
    return preflight?.complete === true && typeof preflight.inventoryId === "string" &&
        preflight.inventoryId.trim().length > 0;
}

export async function preservePrivateNotesBeforeCommit({ candidates = [], store, beforeCommit, commit }) {
    if (typeof commit !== "function") throw new TypeError("A snapshot commit callback is required.");
    const result = await ensurePrivateNotesPreserved(candidates, store);
    if (typeof beforeCommit === "function") {
        const ready = await beforeCommit();
        if (ready !== true) return { ...result, committed: false };
    }
    return { ...result, committed: await commit() };
}
