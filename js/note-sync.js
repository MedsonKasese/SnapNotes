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

export function mergeNotes(localNotes = [], cloudNotes = []) {
    const merged = new Map();
    const conflicts = new Map();

    [...cloudNotes, ...localNotes].forEach(note => {
        if (!note?.id) return;
        const existing = merged.get(note.id);
        if (!existing) {
            merged.set(note.id, note);
            return;
        }

        const existingTime = noteTimestamp(existing);
        const incomingTime = noteTimestamp(note);
        const existingSignature = conflictSignature(existing);
        const incomingSignature = conflictSignature(note);

        if (existingSignature === incomingSignature) {
            if (incomingTime > existingTime) merged.set(note.id, note);
            return;
        }

        // Newer timestamp wins the canonical ID, but every divergent version is
        // retained as a deterministic conflict copy. Equal timestamps prefer local.
        const incomingIsLocal = localNotes.some(item => item?.id === note.id && conflictSignature(item) === incomingSignature);
        const incomingWins = incomingTime > existingTime || (incomingTime === existingTime && incomingIsLocal);
        const winner = incomingWins ? note : existing;
        const loser = incomingWins ? existing : note;
        merged.set(note.id, winner);
        if (!loser.syncConflict) {
            const copy = createConflictCopy(loser);
            conflicts.set(copy.id, copy);
        }
    });

    // Preserve pre-existing conflict copies and deduplicate deterministic copies.
    [...cloudNotes, ...localNotes].forEach(note => {
        if (note?.id && note.syncConflict && !merged.has(note.id)) merged.set(note.id, note);
    });
    for (const [id, conflict] of conflicts) {
        if (!merged.has(id)) merged.set(id, conflict);
    }
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
