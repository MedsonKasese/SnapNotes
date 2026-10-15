// =========================
// NOTE ATTACHMENTS
// =========================

import { enqueueAndProcessAttachmentCleanup, processAttachmentCleanupQueue } from "./attachment-cleanup.js";

const ATTACHMENT_DB = "SnapNotesAttachments";
const ATTACHMENT_STORE = "files";
const MAX_ATTACHMENTS_PER_NOTE = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
    "application/pdf",
    "text/plain",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp"
]);

let pendingAttachmentFiles = [];
let attachmentUploadPromise = null;
let attachmentRetryQueued = false;

function isAttachmentUserSignedIn() {
    return Boolean(window.firebaseAuth?.currentUser);
}

function updateAttachmentAccess() {
    const button = document.getElementById("addAttachmentBtn");
    if (!button) return;
    const available = isAttachmentUserSignedIn();
    // Keep the control actionable so signed-out users receive an explanation.
    button.disabled = false;
    button.title = available ? "Attach files" : "Sign in to attach files";
    button.setAttribute("aria-label", available ? "Attach files" : "Sign in to attach files");
    button.setAttribute("aria-disabled", "false");
    button.classList.toggle("attachment-requires-signin", !available);
}

window.addEventListener("snapnotes:auth-changed", () => {
    updateAttachmentAccess();
    retryPendingAttachmentUploads();
    retryPendingAttachmentCleanup();
});
window.addEventListener("online", retryPendingAttachmentUploads);
window.addEventListener("online", retryPendingAttachmentCleanup);
document.addEventListener("DOMContentLoaded", updateAttachmentAccess);

function openAttachmentPicker(input) {
    if (!isAttachmentUserSignedIn()) {
        window.showToast?.("Sign in to your SnapNotes account to add attachments and sync them across devices.", "warning");
        return false;
    }
    input?.click();
    return true;
}

function openAttachmentDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(ATTACHMENT_DB, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(ATTACHMENT_STORE)) {
                request.result.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function putAttachmentFile(id, file) {
    const db = await openAttachmentDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE, "readwrite");
        tx.objectStore(ATTACHMENT_STORE).put({
            id,
            uid: window.firebaseAuth?.currentUser?.uid || null,
            blob: file,
            updatedAt: new Date().toISOString()
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error("Local attachment save was cancelled.")); };
    });
}

async function getAttachmentFile(id) {
    const db = await openAttachmentDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE, "readonly");
        const request = tx.objectStore(ATTACHMENT_STORE).get(id);
        request.onsuccess = () => resolve(request.result?.blob || null);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function deleteAttachmentFile(id) {
    const db = await openAttachmentDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE, "readwrite");
        tx.objectStore(ATTACHMENT_STORE).delete(id);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function tagLegacyAttachmentFilesForUser(uid, attachmentIds = []) {
    if (!uid || !Array.isArray(attachmentIds) || !attachmentIds.length) return 0;
    if (window.snapNotesDataUid !== uid || window.firebaseAuth?.currentUser?.uid !== uid) return 0;
    const ids = new Set(attachmentIds.filter(id => typeof id === "string" && id));
    if (!ids.size) return 0;
    const db = await openAttachmentDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE, "readwrite");
        const request = tx.objectStore(ATTACHMENT_STORE).openCursor();
        let tagged = 0;
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (window.snapNotesDataUid !== uid || window.firebaseAuth?.currentUser?.uid !== uid) return;
            if (!cursor.value?.uid && ids.has(cursor.value?.id)) {
                cursor.update({ ...cursor.value, uid });
                tagged++;
            }
            cursor.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(tagged); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error("Legacy attachment ownership migration was cancelled.")); };
    });
}

async function deleteLocalAttachmentFilesForUser(uid, attachmentIds = []) {
    if (!uid) return 0;
    const legacyIds = new Set(Array.isArray(attachmentIds) ? attachmentIds.filter(id => typeof id === "string" && id) : []);
    const db = await openAttachmentDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE, "readwrite");
        const request = tx.objectStore(ATTACHMENT_STORE).openCursor();
        let removed = 0;
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (cursor.value?.uid === uid || (!cursor.value?.uid && legacyIds.has(cursor.value?.id))) {
                cursor.delete();
                removed++;
            }
            cursor.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(removed); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error("Local attachment cleanup was cancelled.")); };
    });
}

function clearAttachmentCleanupQueueForUser(uid) {
    if (!uid) return;
    try {
        const queue = JSON.parse(localStorage.getItem("SnapNotesAttachmentCleanup") || "[]");
        if (!Array.isArray(queue)) return;
        const ownedPrefix = `users/${uid}/`;
        localStorage.setItem("SnapNotesAttachmentCleanup", JSON.stringify(queue.filter(item =>
            item?.uid !== uid && !(typeof item?.storagePath === "string" && item.storagePath.startsWith(ownedPrefix))
        )));
    } catch (error) {
        console.warn("Could not clear stale local attachment cleanup entries:", error);
    }
}

async function runAttachmentCleanup(attachments) {
    const user = window.firebaseAuth?.currentUser;
    return enqueueAndProcessAttachmentCleanup(attachments, {
        storage: localStorage,
        currentUid: user?.uid || null,
        removeLocal: deleteAttachmentFile,
        removeRemote: objectKey => storageApi("delete-object", { purpose: "attachment", objectKey })
    });
}

async function cleanupAttachmentsForNotes(notes) {
    const attachments = (Array.isArray(notes) ? notes : [])
        .flatMap(note => Array.isArray(note?.attachments) ? note.attachments : []);
    return runAttachmentCleanup(attachments);
}

async function retryPendingAttachmentCleanup() {
    return processAttachmentCleanupQueue({
        storage: localStorage,
        currentUid: window.firebaseAuth?.currentUser?.uid || null,
        removeLocal: deleteAttachmentFile,
        removeRemote: objectKey => storageApi("delete-object", { purpose: "attachment", objectKey })
    });
}

function validateAttachment(file) {
    if (!file) return "Invalid attachment.";
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) return "Only images, PDF, and text files are supported.";
    if (file.size > MAX_ATTACHMENT_SIZE) return "Each attachment must be 10 MB or smaller.";
    return "";
}

function formatAttachmentSize(size) {
    if (size < 1024) return size + " B";
    if (size < 1024 * 1024) return Math.round(size / 1024) + " KB";
    return (size / (1024 * 1024)).toFixed(1) + " MB";
}

function attachmentIcon(type) {
    if (type.startsWith("image/")) return "fa-image";
    if (type === "application/pdf") return "fa-file-pdf";
    return "fa-file-lines";
}

function getAttachmentUploadErrorMessage(error) {
    const code = String(error?.code || "").toLowerCase();
    const message = String(error?.message || "").toLowerCase();
    const networkFailure = !navigator.onLine ||
        code.includes("network-request-failed") ||
        code.includes("retry-limit-exceeded") ||
        message.includes("failed to fetch") ||
        message.includes("network") ||
        message.includes("offline") ||
        message.includes("timed out");

    if (networkFailure) {
        return "Network problem. The file is safe on this device and will retry automatically when you're online.";
    }
    if (code.includes("unauthorized") || code.includes("unauthenticated") || code.includes("permission-denied")) {
        return "Cloud storage denied access. The file is safe on this device; sign in again and retry.";
    }
    if (code.includes("quota-exceeded")) {
        return "Cloud storage is full. The file is safe on this device; free up storage and retry.";
    }
    return "Upload failed. The file is safe on this device; check your connection or account access, then retry.";
}

function resetPendingAttachments() {
    pendingAttachmentFiles = [];
    renderPendingAttachments();
}

function addPendingAttachments(files) {
    if (!isAttachmentUserSignedIn()) {
        window.showToast?.("Sign in to your SnapNotes account to add attachments and sync them across devices.", "warning");
        return;
    }

    const incoming = Array.from(files || []);
    const available = Math.max(0, MAX_ATTACHMENTS_PER_NOTE - pendingAttachmentFiles.length);
    if (!available) {
        window.showToast?.("A note can have up to 5 attachments. Upgrade to PRO to add more attachments.", "warning");
        return;
    }

    for (const file of incoming.slice(0, available)) {
        const error = validateAttachment(file);
        if (error) {
            window.showToast?.(error, "warning");
            continue;
        }
        const duplicate = pendingAttachmentFiles.some(existing =>
            existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified
        );
        if (!duplicate) pendingAttachmentFiles.push(file);
    }

    if (incoming.length > available) window.showToast?.("Only 5 attachments can be added to one note.", "warning");
    renderPendingAttachments();
}

function renderPendingAttachments() {
    const list = document.getElementById("pendingAttachments");
    if (!list) return;
    list.innerHTML = "";
    list.hidden = pendingAttachmentFiles.length === 0;

    pendingAttachmentFiles.forEach((file, index) => {
        const item = document.createElement("div");
        item.className = "attachment-chip";
        const icon = document.createElement("i");
        icon.className = "fa-solid " + attachmentIcon(file.type);
        icon.setAttribute("aria-hidden", "true");
        const copy = document.createElement("span");
        copy.className = "attachment-chip-copy";
        copy.innerHTML = "<strong></strong><small></small>";
        copy.querySelector("strong").textContent = file.name;
        copy.querySelector("small").textContent = formatAttachmentSize(file.size) + " · Ready to save locally";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "attachment-remove";
        remove.setAttribute("aria-label", "Remove " + file.name);
        remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        remove.addEventListener("click", () => {
            pendingAttachmentFiles.splice(index, 1);
            renderPendingAttachments();
        });
        item.append(icon, copy, remove);
        list.appendChild(item);
    });
}

async function storageApi(path, body) {
    const user = window.firebaseAuth?.currentUser;
    if (!user) throw new Error("Sign in to sync files.");
    const response = await fetch("/api/storage/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + await user.getIdToken() },
        body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Storage request failed.");
    return result;
}

async function uploadAttachmentToCloud(noteId, attachment, file) {
    if (!navigator.onLine) throw new Error("Offline. The attachment is saved on this device.");
    const signed = await storageApi("sign-upload", {
        purpose: "attachment", noteId: String(noteId), attachmentId: String(attachment.id),
        contentType: file.type, size: file.size
    });
    const uploaded = await fetch(signed.uploadUrl, {
        method: "PUT", headers: { "Content-Type": file.type, "x-upsert": "false" }, body: file
    });
    if (!uploaded.ok) throw new Error("Upload failed (HTTP " + uploaded.status + ").");
    await storageApi("complete-upload", {
        purpose: "attachment", objectKey: signed.objectKey,
        expectedSize: file.size, contentType: file.type
    });
    attachment.storageProvider = "supabase";
    attachment.storagePath = signed.objectKey;
    attachment.downloadUrl = null; // Signed URLs expire; never store them in Firestore.
    attachment.uploadStatus = "synced";
    attachment.uploadError = null;
    attachment.uploadedAt = new Date().toISOString();
    return attachment;
}

async function prepareNoteAttachments(noteId, files, existing = []) {
    const attachments = Array.isArray(existing) ? [...existing] : [];
    const incoming = Array.from(files || []);
    if (incoming.length && !isAttachmentUserSignedIn()) {
        throw new Error("Sign in to your SnapNotes account to add attachments and sync them across devices.");
    }
    const available = MAX_ATTACHMENTS_PER_NOTE - attachments.length;
    if (incoming.length > available) throw new Error("A note can have up to 5 attachments.");

    for (const file of incoming) {
        const error = validateAttachment(file);
        if (error) throw new Error(error);
        const attachment = {
            id: crypto.randomUUID(),
            name: file.name,
            type: file.type || "application/octet-stream",
            size: file.size,
            createdAt: new Date().toISOString(),
            storagePath: null,
            downloadUrl: null,
            uploadStatus: "pending",
            uploadError: null
        };

        // Persist the bytes locally first. A cloud outage must never discard the note.
        await putAttachmentFile(attachment.id, file);
        attachments.push(attachment);
    }
    return attachments;
}

async function retryPendingAttachmentUploads(options = {}) {
    // If a retry is already running, await it and queue one follow-up pass. This
    // prevents a reconnect event arriving mid-upload from being lost.
    if (attachmentUploadPromise) {
        attachmentRetryQueued = true;
        return attachmentUploadPromise;
    }

    if (!navigator.onLine) {
        return { uploadedCount: 0, failedCount: 0, offline: true, uploadedIds: [] };
    }
    if (!isAttachmentUserSignedIn()) {
        return { uploadedCount: 0, failedCount: 0, signedOut: true, uploadedIds: [] };
    }
    if (!Array.isArray(window.notes) || !window.notes.length) {
        return { uploadedCount: 0, failedCount: 0, uploadedIds: [] };
    }

    const task = (async () => {
        let changed = false;
        let uploadedCount = 0;
        let failedCount = 0;
        const uploadedIds = [];
        const privateAttachmentUpdates = new Map();

        for (const rawNote of window.notes) {
            if (rawNote?.isPrivate && !window.isPrivateNotesUnlocked?.()) continue;
            const note = window.getReadablePrivateNote?.(rawNote) || rawNote;
            if (!Array.isArray(note.attachments)) continue;
            for (const attachment of note.attachments) {
                if (options.attachmentId && attachment.id !== options.attachmentId) continue;
                if (attachment.uploadStatus === "synced" || attachment.downloadUrl) continue;
                if (!attachment.id || (!attachment.storagePath && attachment.uploadStatus !== "pending")) continue;

                let file;
                try {
                    file = await getAttachmentFile(attachment.id);
                } catch (error) {
                    attachment.uploadStatus = "pending";
                    attachment.uploadError = getAttachmentUploadErrorMessage(error);
                    failedCount++;
                    changed = true;
                    continue;
                }

                // A pending attachment from another device has no local blob here.
                // The original device will upload it when it reconnects.
                if (!file) continue;

                try {
                    await uploadAttachmentToCloud(note.id, attachment, file);
                    changed = true;
                    uploadedCount++;
                    uploadedIds.push(attachment.id);
                    if (rawNote?.isPrivate) privateAttachmentUpdates.set(rawNote.id, note.attachments);
                } catch (error) {
                    attachment.uploadStatus = "pending";
                    attachment.uploadError = getAttachmentUploadErrorMessage(error);
                    failedCount++;
                    changed = true;
                }
            }
        }

        if (changed) {
            for (const [noteId, attachments] of privateAttachmentUpdates) {
                const saved = await window.savePrivateAttachmentMetadata?.(noteId, attachments);
                if (!saved) {
                    failedCount++;
                    window.showToast?.("A private attachment uploaded but its encrypted metadata could not be saved. Keep Private Notes unlocked and retry.", "warning");
                }
            }
            await window.saveNotes?.();
            window.renderNotes?.();
        }

        if (uploadedCount && !options.silent) {
            window.showToast?.(
                uploadedCount === 1
                    ? "Attachment uploaded and synced across your devices."
                    : uploadedCount + " attachments uploaded and synced across your devices.",
                "success"
            );
        }

        return { uploadedCount, failedCount, uploadedIds };
    })();

    attachmentUploadPromise = task;
    try {
        return await task;
    } finally {
        if (attachmentUploadPromise === task) attachmentUploadPromise = null;
        if (attachmentRetryQueued) {
            attachmentRetryQueued = false;
            if (navigator.onLine && isAttachmentUserSignedIn()) {
                Promise.resolve().then(() => retryPendingAttachmentUploads({ silent: true }));
            }
        }
    }
}

async function resolveAttachmentUrl(attachment) {
    if (attachment?.id) {
        const blob = await getAttachmentFile(attachment.id).catch(() => null);
        if (blob) return URL.createObjectURL(blob);
    }
    if (attachment?.storageProvider === "supabase" && attachment.storagePath) {
        try {
            const signed = await storageApi("sign-download", { objectKey: attachment.storagePath });
            return signed.url || "";
        } catch (error) {
            console.warn("Secure attachment download unavailable:", error);
            return "";
        }
    }
    // Keep existing Firebase URLs readable if they are still available.
    if (attachment?.downloadUrl) return attachment.downloadUrl;
    return "";
}

async function removeNoteAttachment(noteId, attachmentId) {
    const note = (window.notes || []).find(item => item.id === noteId);
    const attachment = note?.attachments?.find(item => item.id === attachmentId);
    if (!attachment) return false;
    const result = await runAttachmentCleanup([attachment]);
    if (!result.persisted) {
        window.showToast?.("Could not safely queue attachment cleanup. The attachment is still on the note.", "warning");
        return false;
    }
    if (note?.attachments) note.attachments = note.attachments.filter(item => item.id !== attachmentId);
    if (result.pendingCount) {
        window.showToast?.("Removed from the note. Cloud cleanup is queued and will retry when available.", "warning");
    }
    return true;
}

async function renderNoteAttachments(container, attachments = [], options = {}) {
    if (!container) return;
    container.innerHTML = "";
    if (!attachments.length) {
        container.hidden = true;
        return;
    }
    container.hidden = false;

    for (const attachment of attachments) {
        const item = document.createElement("div");
        item.className = "note-attachment";
        const preview = document.createElement("div");
        preview.className = "note-attachment-preview";
        const copy = document.createElement("div");
        copy.className = "note-attachment-copy";
        const name = document.createElement("strong");
        name.textContent = attachment.name || "Attachment";
        const size = document.createElement("small");
        size.textContent = formatAttachmentSize(Number(attachment.size) || 0);
        const status = document.createElement("small");
        status.className = "attachment-sync-status";
        if (attachment.uploadStatus === "pending" && !attachment.downloadUrl) {
            status.textContent = attachment.uploadError
                ? attachment.uploadError
                : "Saved on this device · waiting to sync";
            status.title = attachment.uploadError || "SnapNotes will upload this file automatically when you're online.";
        } else {
            status.textContent = "Synced across devices";
            status.classList.add("is-synced");
        }
        copy.append(name, size, status);

        const url = await resolveAttachmentUrl(attachment);
        if (attachment.uploadStatus === "pending" && url) {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "attachment-retry";
            retry.textContent = "Retry upload";
            retry.addEventListener("click", async () => {
                if (retry.disabled) return;
                if (!navigator.onLine) {
                    attachment.uploadError = "Network problem. Saved on this device; will retry automatically when you're online.";
                    status.textContent = attachment.uploadError;
                    status.title = attachment.uploadError;
                    window.showToast?.("You're offline. This file is safe on this device and will retry automatically when you're online.", "warning");
                    return;
                }
                if (!isAttachmentUserSignedIn()) {
                    window.showToast?.("Sign in again to upload this attachment. The local file is still saved.", "warning");
                    return;
                }

                retry.disabled = true;
                retry.textContent = "Uploading…";
                retry.setAttribute("aria-busy", "true");

                try {
                    const result = await retryPendingAttachmentUploads({
                        attachmentId: attachment.id,
                        silent: true
                    });

                    if (attachment.uploadStatus === "synced" || result.uploadedIds?.includes(attachment.id)) {
                        status.textContent = "Synced across devices";
                        status.title = "This attachment is uploaded and available across your devices.";
                        status.classList.add("is-synced");
                        retry.remove();
                        window.showToast?.("Attachment uploaded and synced across your devices.", "success");
                    } else {
                        const message = attachment.uploadError ||
                            (result.offline
                                ? "Network problem. Saved on this device; will retry automatically when you're online."
                                : result.signedOut
                                    ? "Sign in again to upload this attachment."
                                    : "Upload could not be completed. The file is still saved locally; please retry.");
                        status.textContent = message;
                        status.title = message;
                        retry.textContent = "Retry upload";
                        retry.disabled = false;
                        retry.removeAttribute("aria-busy");
                        window.showToast?.(message, "warning");
                    }
                } catch (error) {
                    const message = getAttachmentUploadErrorMessage(error);
                    attachment.uploadError = message;
                    status.textContent = message;
                    status.title = message;
                    retry.textContent = "Retry upload";
                    retry.disabled = false;
                    retry.removeAttribute("aria-busy");
                    window.showToast?.(message, "warning");
                }
            });
            copy.appendChild(retry);
        }
        if (attachment.type?.startsWith("image/") && url) {
            const image = document.createElement("img");
            image.src = url;
            image.alt = attachment.name || "Attached image";
            image.loading = "lazy";
            preview.appendChild(image);
        } else {
            const icon = document.createElement("i");
            icon.className = "fa-solid " + attachmentIcon(attachment.type || "");
            icon.setAttribute("aria-hidden", "true");
            preview.appendChild(icon);
        }

        const open = document.createElement("a");
        open.className = "attachment-open";
        if (url) {
            open.href = url;
            open.target = "_blank";
            open.rel = "noopener noreferrer";
        } else {
            open.setAttribute("aria-disabled", "true");
            open.title = "This attachment is waiting to upload from the device where it was added.";
        }
        open.textContent = attachment.type?.startsWith("image/") ? "Open" : "Download";

        item.append(preview, copy, open);
        if (options.removable) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "attachment-remove";
            remove.setAttribute("aria-label", "Remove " + (attachment.name || "attachment"));
            remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            remove.addEventListener("click", async () => {
                await removeNoteAttachment(options.noteId, attachment.id);
                item.remove();
                if (!container.children.length) container.hidden = true;
                options.onChange?.();
            });
            item.appendChild(remove);
        }
        container.appendChild(item);
    }
}

window.MAX_ATTACHMENTS_PER_NOTE = MAX_ATTACHMENTS_PER_NOTE;
window.MAX_ATTACHMENT_SIZE = MAX_ATTACHMENT_SIZE;
window.openAttachmentPicker = openAttachmentPicker;
window.addPendingAttachments = addPendingAttachments;
window.resetPendingAttachments = resetPendingAttachments;
window.getPendingAttachments = () => [...pendingAttachmentFiles];
window.prepareNoteAttachments = prepareNoteAttachments;
window.retryPendingAttachmentUploads = retryPendingAttachmentUploads;
window.retryPendingAttachmentCleanup = retryPendingAttachmentCleanup;
window.cleanupAttachmentsForNotes = cleanupAttachmentsForNotes;
window.queueAttachmentCleanup = runAttachmentCleanup;
window.deleteLocalAttachmentFilesForUser = deleteLocalAttachmentFilesForUser;
window.tagLegacyAttachmentFilesForUser = tagLegacyAttachmentFilesForUser;
window.clearAttachmentCleanupQueueForUser = clearAttachmentCleanupQueueForUser;
window.renderNoteAttachments = renderNoteAttachments;
window.removeNoteAttachment = removeNoteAttachment;
