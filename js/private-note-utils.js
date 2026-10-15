export function buildPrivatePayload(note = {}) {
    return {
        title: note.title || "",
        text: note.text || "",
        html: note.html || "",
        category: note.category || "general",
        tags: Array.isArray(note.tags) ? structuredClone(note.tags) : [],
        time: note.time || "",
        folderId: note.folderId || null,
        reminderAt: note.reminderAt || null,
        reminderNotified: Boolean(note.reminderNotified),
        attachments: Array.isArray(note.attachments) ? structuredClone(note.attachments) : [],
        history: Array.isArray(note.history)
            ? structuredClone(note.history)
            : Array.isArray(note.versions) ? structuredClone(note.versions) : []
    };
}

export function lockedPrivateNote(note) {
    return {
        ...note,
        title: "Private note",
        text: "Unlock Private Notes to view this content.",
        html: "",
        category: "general",
        tags: [],
        folderId: null,
        reminderAt: null,
        reminderNotified: false,
        attachments: [],
        versions: [],
        history: [],
        time: "Locked"
    };
}

export function privateNoteMetadataNeedsMigration(note) {
    if (!note?.isPrivate) return false;
    return Boolean(
        (note.title && note.title !== "Private note") ||
        note.text ||
        note.html ||
        (note.category && note.category !== "general") ||
        (Array.isArray(note.tags) && note.tags.length) ||
        (Array.isArray(note.versions) && note.versions.length) ||
        (Array.isArray(note.history) && note.history.length) ||
        (note.time && note.time !== "Private note" && note.time !== "Locked") ||
        (Array.isArray(note.attachments) && note.attachments.length) ||
        note.reminderAt || note.reminderNotified || note.folderId
    );
}

export function stripPrivateMetadata(note) {
    note.title = "Private note";
    note.text = "";
    note.html = "";
    note.category = "general";
    note.tags = [];
    note.time = "Private note";
    note.versions = [];
    delete note.history;
    delete note.attachments;
    delete note.folderId;
    note.reminderAt = null;
    note.reminderNotified = false;
    return note;
}
