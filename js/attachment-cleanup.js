export const ATTACHMENT_CLEANUP_KEY = "SnapNotesAttachmentCleanup";

function parseQueue(storage) {
    try {
        const value = JSON.parse(storage.getItem(ATTACHMENT_CLEANUP_KEY) || "[]");
        return Array.isArray(value)
            ? value.filter(item => item && typeof item === "object" &&
                (typeof item.id === "string" || typeof item.storagePath === "string"))
                .map(item => ({
                    ...item,
                    key: item.key || `${item.uid || "local"}:${item.id || item.storagePath}`
                }))
            : [];
    } catch {
        return [];
    }
}

function attachmentUid(attachment, fallbackUid) {
    const match = String(attachment?.storagePath || "").match(/^users\/([^/]+)\/attachments\//);
    return match?.[1] || fallbackUid || null;
}

export function cleanupEntriesForAttachments(attachments, fallbackUid = null) {
    const entries = new Map();
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
        if (!attachment || typeof attachment !== "object") continue;
        const uid = attachmentUid(attachment, fallbackUid);
        const storagePath = attachment.storageProvider === "supabase" ? attachment.storagePath : null;
        if (!attachment.id && !storagePath) continue;
        const id = String(attachment.id || storagePath);
        entries.set(`${uid || "local"}:${id}`, {
            key: `${uid || "local"}:${id}`,
            uid,
            id: attachment.id ? String(attachment.id) : null,
            storageProvider: attachment.storageProvider || null,
            storagePath: storagePath || null,
            localDone: !attachment.id,
            remoteDone: !storagePath
        });
    }
    return [...entries.values()];
}

export async function enqueueAndProcessAttachmentCleanup(attachments, options) {
    const { storage, currentUid, removeLocal, removeRemote } = options;
    const entries = cleanupEntriesForAttachments(attachments, currentUid);
    if (!entries.length) return { persisted: true, pendingCount: 0 };

    let queue = parseQueue(storage);
    const byKey = new Map(queue.map(item => [item.key, item]));
    for (const entry of entries) {
        const existing = byKey.get(entry.key);
        byKey.set(entry.key, existing ? { ...entry, ...existing } : entry);
    }
    queue = [...byKey.values()];
    try {
        storage.setItem(ATTACHMENT_CLEANUP_KEY, JSON.stringify(queue));
    } catch (error) {
        return { persisted: false, pendingCount: entries.length, error };
    }

    return processAttachmentCleanupQueue({ storage, currentUid, removeLocal, removeRemote });
}

export async function processAttachmentCleanupQueue(options) {
    const { storage, currentUid, removeLocal, removeRemote } = options;
    let queue = parseQueue(storage);
    const remaining = [];

    for (const original of queue) {
        const entry = { ...original };
        if (!entry.localDone && entry.id) {
            try {
                await removeLocal(entry.id);
                entry.localDone = true;
            } catch (error) {
                entry.localError = String(error?.message || error);
            }
        }

        if (!entry.remoteDone && entry.storagePath && entry.storageProvider === "supabase" && entry.uid === currentUid) {
            try {
                await removeRemote(entry.storagePath);
                entry.remoteDone = true;
                delete entry.remoteError;
            } catch (error) {
                entry.remoteError = String(error?.message || error);
            }
        }

        if (!entry.localDone || !entry.remoteDone) remaining.push(entry);
        try {
            storage.setItem(ATTACHMENT_CLEANUP_KEY, JSON.stringify(remaining.concat(queue.slice(queue.indexOf(original) + 1))));
        } catch {
            // The original durable entry remains in storage if an update fails.
        }
    }

    try {
        storage.setItem(ATTACHMENT_CLEANUP_KEY, JSON.stringify(remaining));
    } catch (error) {
        return { persisted: false, pendingCount: remaining.length, error };
    }
    return { persisted: true, pendingCount: remaining.length };
}
