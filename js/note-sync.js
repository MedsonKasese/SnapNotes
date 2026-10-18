const VOLATILE_NOTE_FIELDS = new Set([
    "id", "createdAt", "updatedAt", "uploadStatus", "uploadError", "uploadedAt"
]);

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function conflictSignature(note) {
    const normalized = Object.fromEntries(Object.entries(note || {})
        .filter(([key]) => !VOLATILE_NOTE_FIELDS.has(key))
        .map(([key, value]) => [key, value]));
    if (Array.isArray(normalized.attachments)) {
        normalized.attachments = normalized.attachments.map(attachment => {
            if (!attachment || typeof attachment !== "object") return attachment;
            return Object.fromEntries(Object.entries(attachment)
                .filter(([key]) => !["uploadStatus", "uploadError", "uploadedAt"].includes(key)));
        }).sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")));
    }
    return JSON.stringify(stableValue(normalized));
}

export function noteSignature(note) {
    return conflictSignature(note);
}

export function noteTimestamp(note) {
    const parsed = Date.parse(note?.updatedAt || note?.createdAt || "");
    return Number.isFinite(parsed) ? parsed : 0;
}

export function isLibraryRevisionComplete(expectedPageCount, actualPageCount) {
    if (expectedPageCount === null || expectedPageCount === undefined || expectedPageCount === "") return false;
    const expected = Number(expectedPageCount);
    const actual = Number(actualPageCount);
    return Number.isInteger(expected) && expected >= 0 &&
        Number.isInteger(actual) && actual >= 0 && expected === actual;
}

function noteVersions(note) {
    return Array.isArray(note?.versions) ? note.versions : [];
}

function versionIdentity(version) {
    return JSON.stringify(stableValue(version || {}));
}

function isHistoryPrefix(shorter, longer) {
    return shorter.length <= longer.length && shorter.every((version, index) =>
        versionIdentity(version) === versionIdentity(longer[index]));
}

function latestHistoryTimestamp(note) {
    return noteVersions(note).reduce((latest, version) => {
        const parsed = Date.parse(version?.savedAt || "");
        return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
    }, 0);
}

function compareLifecycle(existing, incoming) {
    const existingDeletedAt = Date.parse(existing?.deletedAt || "");
    const incomingDeletedAt = Date.parse(incoming?.deletedAt || "");
    const existingRestoredAt = Date.parse(existing?.restoredAt || "");
    const incomingRestoredAt = Date.parse(incoming?.restoredAt || "");
    const existingDeleted = Number.isFinite(existingDeletedAt) && Boolean(existing?.deletedAt);
    const incomingDeleted = Number.isFinite(incomingDeletedAt) && Boolean(incoming?.deletedAt);
    if (existingDeleted === incomingDeleted) return null;

    const deletedAt = existingDeleted ? existingDeletedAt : incomingDeletedAt;
    const activeRestoredAt = existingDeleted ? incomingRestoredAt : existingRestoredAt;
    if (Number.isFinite(activeRestoredAt) && activeRestoredAt > deletedAt) {
        return existingDeleted ? 1 : -1;
    }
    return existingDeleted ? -1 : 1;
}

function compareNoteFreshness(existing, incoming) {
    const lifecycle = compareLifecycle(existing, incoming);
    if (lifecycle !== null) return lifecycle;

    const existingVersions = noteVersions(existing);
    const incomingVersions = noteVersions(incoming);
    if (existingVersions.length !== incomingVersions.length) {
        if (isHistoryPrefix(existingVersions, incomingVersions)) return 1;
        if (isHistoryPrefix(incomingVersions, existingVersions)) return -1;
    }

    const historyTimeDifference = latestHistoryTimestamp(incoming) - latestHistoryTimestamp(existing);
    if (historyTimeDifference) return historyTimeDifference;
    return noteTimestamp(incoming) - noteTimestamp(existing);
}

function currentVersionSnapshot(note) {
    return {
        title: String(note?.title || ""),
        text: String(note?.text || ""),
        html: String(note?.html || ""),
        category: String(note?.category || "general"),
        tags: Array.isArray(note?.tags) ? [...note.tags] : [],
        reminderAt: note?.reminderAt || null,
        reminderNotified: Boolean(note?.reminderNotified),
        reminderRepeat: structuredClone(note?.reminderRepeat || null),
        time: String(note?.time || ""),
        savedAt: note?.updatedAt || note?.createdAt || ""
    };
}

function mergeNoteHistory(winner, loser) {
    if (winner?.isPrivate || loser?.isPrivate) return winner;
    const entries = [...noteVersions(winner), ...noteVersions(loser), currentVersionSnapshot(loser)];
    const byContent = new Map();
    entries.forEach(entry => {
        if (!entry || typeof entry !== "object") return;
        const content = { ...entry };
        delete content.savedAt;
        const key = JSON.stringify(stableValue(content));
        const previous = byContent.get(key);
        const previousTime = Date.parse(previous?.savedAt || "") || 0;
        const nextTime = Date.parse(entry.savedAt || "") || 0;
        if (!previous || nextTime > previousTime) byContent.set(key, entry);
    });
    const versions = [...byContent.values()].sort((a, b) =>
        (Date.parse(a.savedAt || "") || 0) - (Date.parse(b.savedAt || "") || 0));
    return { ...winner, versions: versions.slice(-20) };
}

function stableHash(value) {
    // Two independent 32-bit FNV-style accumulators provide deterministic IDs
    // without relying on browser-only crypto APIs in this pure merge helper.
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
    }
    return first.toString(36) + second.toString(36);
}

export function createConflictCopy(note) {
    const signature = conflictSignature(note);
    const now = new Date().toISOString();
    return {
        ...structuredClone(note),
        id: `conflict-${String(note.id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}-${stableHash(signature)}`,
        title: `Conflict: ${note.title || "Untitled note"}`,
        createdAt: now,
        updatedAt: now,
        pinned: false,
        syncConflict: true,
        conflictOf: note.id
    };
}

export function mergeNotes(localNotes = [], cloudNotes = [], permanentlyDeletedIds = []) {
    const merged = new Map();
    const deletedIds = new Set(permanentlyDeletedIds);

    [...cloudNotes, ...localNotes].forEach(note => {
        if (!note?.id || deletedIds.has(note.id) || deletedIds.has(note.conflictOf)) return;
        const existing = merged.get(note.id);
        if (!existing) {
            merged.set(note.id, note);
            return;
        }

        const existingSignature = conflictSignature(existing);
        const incomingSignature = conflictSignature(note);

        if (existingSignature === incomingSignature) {
            if (compareNoteFreshness(existing, note) > 0) merged.set(note.id, note);
            return;
        }

        // A longer shared edit-history lineage identifies a later edit even when
        // device clocks disagree. Divergent current content is retained in the
        // winner's edit history rather than surfaced as a duplicate note.
        const incomingIsLocal = localNotes.some(item => item?.id === note.id && conflictSignature(item) === incomingSignature);
        const comparison = compareNoteFreshness(existing, note);
        const incomingWins = comparison > 0 || (comparison === 0 && incomingIsLocal);
        const winner = incomingWins ? note : existing;
        const loser = incomingWins ? existing : note;
        merged.set(note.id, mergeNoteHistory(winner, loser));
    });

    // Preserve conflict copies created by older app versions, but no new copies
    // are created now that both edits are retained in the canonical note history.
    [...cloudNotes, ...localNotes].forEach(note => {
        if (note?.id && note.syncConflict && !deletedIds.has(note.id) && !deletedIds.has(note.conflictOf) && !merged.has(note.id)) {
            merged.set(note.id, note);
        }
    });
    return [...merged.values()];
}

function serializedBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function packLibraryPages(notes = [], folders = [], maxBytes = 450 * 1024) {
    const pages = [];
    const add = (key, item) => {
        const page = pages.at(-1) || { notes: [], folders: [] };
        if (!pages.length) pages.push(page);
        page[key].push(item);
        if (serializedBytes(page) <= maxBytes) return;
        page[key].pop();
        if (!page.notes.length && !page.folders.length) {
            throw new RangeError(`A single ${key.slice(0, -1)} exceeds the Firestore page size limit.`);
        }
        const next = { notes: [], folders: [] };
        pages.push(next);
        next[key].push(item);
        if (serializedBytes(next) > maxBytes) {
            throw new RangeError(`A single ${key.slice(0, -1)} exceeds the Firestore page size limit.`);
        }
    };

    for (const note of notes) add("notes", note);
    for (const folder of folders) add("folders", folder);
    return pages;
}
