// =========================
// NOTE ATTACHMENTS
// =========================

import { enqueueAndProcessAttachmentCleanup, processAttachmentCleanupQueue } from "./attachment-cleanup.js";
import { renderPdfPreview, disposePdfPreview } from "./pdf-preview.js";

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
const privateAttachmentObjectUrls = new Set();
let activeAttachmentPreview = null;
let attachmentPreviewRequestId = 0;
let attachmentViewerReturnFocus = null;
let attachmentRenameReturnFocus = null;
let pendingAttachmentRename = null;

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
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupAttachmentDialogs, { once: true });
else setupAttachmentDialogs();

function setupAttachmentDialogs() {
    const viewer = document.getElementById("attachmentViewer");
    const dialog = viewer?.querySelector("[role=\"dialog\"]");
    viewer?.addEventListener("keydown", event => {
        if (viewer.hidden) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeAttachmentViewer();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = [...viewer.querySelectorAll("button:not(:disabled), a[href], iframe, [tabindex]:not([tabindex=\"-1\"])")]
            .filter(element => !element.hidden && element.getAttribute("aria-hidden") !== "true");
        if (!focusable.length) {
            event.preventDefault();
            dialog?.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !viewer.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !viewer.contains(document.activeElement))) {
            event.preventDefault();
            first.focus();
        }
    });

    const overlay = document.getElementById("attachmentRenameDialog");
    const form = document.getElementById("attachmentRenameForm");
    const input = document.getElementById("attachmentRenameInput");
    const feedback = document.getElementById("attachmentRenameFeedback");
    document.getElementById("attachmentRenameCancel")?.addEventListener("click", () => closeAttachmentRenameDialog());
    overlay?.addEventListener("click", event => {
        if (event.target === overlay) closeAttachmentRenameDialog();
    });
    overlay?.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeAttachmentRenameDialog();
            return;
        }
        if (event.key === "Tab") {
            const focusable = [...overlay.querySelectorAll("input:not(:disabled), button:not(:disabled)")]
                .filter(element => !element.hidden);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
    input?.addEventListener("input", () => { if (feedback) feedback.textContent = ""; });
    form?.addEventListener("submit", saveAttachmentRename);
}

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

async function readAttachmentBlob(attachment) {
    if (attachment?.id) {
        const local = await getAttachmentFile(attachment.id).catch(() => null);
        if (local) return local;
    }

    let url = "";
    if (attachment?.storagePath) {
        const signed = await storageApi("sign-download", { objectKey: attachment.storagePath });
        url = signed.url || "";
    } else if (attachment?.downloadUrl) {
        url = attachment.downloadUrl;
    }
    if (!url) return null;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Could not download an attachment for private protection.");
    const bytes = await response.arrayBuffer();
    return new Blob([bytes], { type: attachment.type || response.headers.get("content-type") || "application/octet-stream" });
}

async function protectPrivateAttachmentsForPrivate(noteId, attachments = []) {
    const protectedAttachments = [];
    const originals = [];
    const createdIds = [];
    try {
        for (const attachment of Array.isArray(attachments) ? attachments : []) {
            if (!attachment || attachment.encrypted === true) {
                if (attachment) protectedAttachments.push(attachment);
                continue;
            }
            if (attachment.downloadUrl && !attachment.storagePath) {
                throw new Error("This note has a legacy attachment URL that SnapNotes cannot safely remove. Remove and re-add that file before moving the note to Private.");
            }
            if (attachment.storagePath && !navigator.onLine) {
                throw new Error("Connect to the internet to protect and replace this note's synced attachments before moving it to Private.");
            }
            const source = await readAttachmentBlob(attachment);
            if (!source) throw new Error("An attachment is not available on this device. Open the note on the device where it was added, then try again.");
            const encrypted = await window.encryptPrivateAttachmentBlob?.(source);
            if (!encrypted?.blob || !encrypted.iv) throw new Error("Private attachment encryption is unavailable. Unlock Private Notes and try again.");

            const id = crypto.randomUUID();
            await putAttachmentFile(id, encrypted.blob);
            createdIds.push(id);
            protectedAttachments.push({
                id,
                name: String(attachment.name || "Attachment"),
                type: String(attachment.type || source.type || "application/octet-stream"),
                size: Number(attachment.size) || source.size,
                createdAt: attachment.createdAt || new Date().toISOString(),
                storageProvider: null,
                storagePath: null,
                downloadUrl: null,
                uploadStatus: "pending",
                uploadError: null,
                encrypted: true,
                encryptionIv: encrypted.iv
            });
            originals.push(attachment.storagePath && !attachment.storageProvider
                ? { ...attachment, storageProvider: "supabase" }
                : attachment);
        }
    } catch (error) {
        await Promise.all(createdIds.map(id => deleteAttachmentFile(id).catch(() => {})));
        throw error;
    }
    return { attachments: protectedAttachments, originals };
}

async function unprotectPrivateAttachmentsFromPrivate(noteId, attachments = []) {
    const restoredAttachments = [];
    const originals = [];
    const createdIds = [];
    try {
        for (const attachment of Array.isArray(attachments) ? attachments : []) {
            if (!attachment?.encrypted) {
                if (attachment) restoredAttachments.push(attachment);
                continue;
            }
            const ciphertext = await readAttachmentBlob(attachment);
            if (!ciphertext) throw new Error("A private attachment is not available. Try again on the device where it was added, or while online.");
            const plaintext = await window.decryptPrivateAttachmentBlob?.(ciphertext, attachment.encryptionIv, attachment.type);
            if (!plaintext) throw new Error("Could not decrypt a private attachment. Unlock Private Notes and try again.");
            const id = crypto.randomUUID();
            await putAttachmentFile(id, plaintext);
            createdIds.push(id);
            const { encrypted, encryptionIv, ...metadata } = attachment;
            restoredAttachments.push({
                ...metadata,
                id,
                size: plaintext.size,
                storageProvider: null,
                storagePath: null,
                downloadUrl: null,
                uploadStatus: "pending",
                uploadError: null
            });
            originals.push(attachment.storagePath && !attachment.storageProvider
                ? { ...attachment, storageProvider: "supabase" }
                : attachment);
        }
    } catch (error) {
        await Promise.all(createdIds.map(id => deleteAttachmentFile(id).catch(() => {})));
        throw error;
    }
    return { attachments: restoredAttachments, originals };
}

async function duplicatePrivateAttachments(attachments = []) {
    const duplicatedAttachments = [];
    const createdIds = [];
    try {
        for (const attachment of Array.isArray(attachments) ? attachments : []) {
            if (!attachment) continue;
            const stored = await readAttachmentBlob(attachment);
            if (!stored) throw new Error("A private attachment is not available to duplicate on this device.");
            const plaintext = attachment.encrypted
                ? await window.decryptPrivateAttachmentBlob?.(stored, attachment.encryptionIv, attachment.type)
                : stored;
            if (!plaintext) throw new Error("Could not decrypt a private attachment for duplication.");
            const encrypted = await window.encryptPrivateAttachmentBlob?.(plaintext);
            if (!encrypted?.blob || !encrypted.iv) throw new Error("Private attachment encryption is unavailable.");
            const id = crypto.randomUUID();
            await putAttachmentFile(id, encrypted.blob);
            createdIds.push(id);
            duplicatedAttachments.push({
                id,
                name: String(attachment.name || "Attachment"),
                type: String(attachment.type || plaintext.type || "application/octet-stream"),
                size: plaintext.size,
                createdAt: new Date().toISOString(),
                storageProvider: null,
                storagePath: null,
                downloadUrl: null,
                uploadStatus: "pending",
                uploadError: null,
                encrypted: true,
                encryptionIv: encrypted.iv
            });
        }
    } catch (error) {
        await Promise.all(createdIds.map(id => deleteAttachmentFile(id).catch(() => {})));
        throw error;
    }
    return duplicatedAttachments;
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
    if (attachment?.encrypted === true) {
        try {
            const ciphertext = await readAttachmentBlob(attachment);
            if (!ciphertext) return "";
            const plaintext = await window.decryptPrivateAttachmentBlob?.(ciphertext, attachment.encryptionIv, attachment.type);
            if (!plaintext) return "";
            const url = URL.createObjectURL(plaintext);
            privateAttachmentObjectUrls.add(url);
            return url;
        } catch (error) {
            console.warn("Private attachment could not be opened:", error?.message || error);
            return "";
        }
    }
    if (attachment?.id) {
        const blob = await getAttachmentFile(attachment.id).catch(() => null);
        if (blob) {
            const url = URL.createObjectURL(blob);
            privateAttachmentObjectUrls.add(url);
            return url;
        }
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

function clearPrivateAttachmentObjectUrls() {
    for (const url of privateAttachmentObjectUrls) URL.revokeObjectURL(url);
    privateAttachmentObjectUrls.clear();
}

async function removeNoteAttachment(noteId, attachmentId) {
    const note = (window.notes || []).find(item => item.id === noteId);
    const attachment = note?.attachments?.find(item => item.id === attachmentId);
    if (!attachment) return false;

    if (!attachmentIsReferencedElsewhere(note, attachment)) {
        const result = await runAttachmentCleanup([attachment]);
        if (!result.persisted) {
            window.showToast?.("Could not safely queue attachment cleanup. The attachment is still on the note.", "warning");
            return false;
        }
        if (result.pendingCount) {
            window.showToast?.("Removed from the note. Cloud cleanup is queued and will retry when available.", "warning");
        }
    }
    if (note?.attachments) note.attachments = note.attachments.filter(item => item !== attachment);
    return true;
}

function attachmentIsReferencedElsewhere(note, attachment) {
    if (!attachment) return false;
    return (Array.isArray(window.notes) ? window.notes : []).some(candidateNote =>
        (Array.isArray(candidateNote?.attachments) ? candidateNote.attachments : []).some(candidate => {
            if (candidateNote === note && candidate === attachment) return false;
            return Boolean(
                (attachment.id && candidate?.id === attachment.id) ||
                (attachment.storagePath && candidate?.storagePath === attachment.storagePath)
            );
        })
    );
}

function formatAttachmentDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function renameNoteAttachment(noteId, attachmentId, trigger) {
    const note = (window.notes || []).find(item => String(item.id) === String(noteId));
    const attachment = note?.attachments?.find(item => item.id === attachmentId);
    const overlay = document.getElementById("attachmentRenameDialog");
    const input = document.getElementById("attachmentRenameInput");
    const feedback = document.getElementById("attachmentRenameFeedback");
    if (!note || note.isPrivate || !attachment || !overlay || !input) return false;

    pendingAttachmentRename = { note, attachment };
    attachmentRenameReturnFocus = trigger || document.activeElement;
    input.value = attachment.name || "Attachment";
    if (feedback) feedback.textContent = "";
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    input.focus();
    input.select();
    return true;
}

function closeAttachmentRenameDialog({ restoreFocus = true } = {}) {
    const overlay = document.getElementById("attachmentRenameDialog");
    if (overlay) {
        overlay.hidden = true;
        overlay.setAttribute("aria-hidden", "true");
    }
    pendingAttachmentRename = null;
    if (restoreFocus && attachmentRenameReturnFocus?.isConnected) attachmentRenameReturnFocus.focus();
    attachmentRenameReturnFocus = null;
}

async function saveAttachmentRename(event) {
    event.preventDefault();
    const target = pendingAttachmentRename;
    const input = document.getElementById("attachmentRenameInput");
    const feedback = document.getElementById("attachmentRenameFeedback");
    const saveButton = document.getElementById("attachmentRenameSave");
    if (!target || !input) return;
    if (saveButton?.disabled) return;
    if (!window.notes?.includes(target.note) || !target.note.attachments?.includes(target.attachment)) {
        if (feedback) feedback.textContent = "This note changed while the dialog was open. Close it and try again.";
        return;
    }

    const name = input.value.replace(/[\\/\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
    if (!name) {
        if (feedback) feedback.textContent = "Enter a file name.";
        input.focus();
        return;
    }

    const oldName = target.attachment.name;
    const oldAttachmentUpdatedAt = target.attachment.updatedAt;
    const oldNoteUpdatedAt = target.note.updatedAt;
    const updatedAt = new Date().toISOString();
    target.attachment.name = name;
    target.attachment.updatedAt = updatedAt;
    target.note.updatedAt = updatedAt;
    if (saveButton) saveButton.disabled = true;
    if (feedback) feedback.textContent = "Saving…";
    try {
        const saveResult = await window.saveNotes?.();
        if (saveResult?.locallySaved === false) throw new Error("Could not save this file name on this device.");
        closeAttachmentRenameDialog({ restoreFocus: false });
        window.renderNotes?.();
        window.openNoteDetail?.(target.note.id);
        const renameButton = [...document.querySelectorAll(".attachment-manage-button[aria-label^='Rename ']")]
            .find(button => button.getAttribute("aria-label") === `Rename ${name}`);
        renameButton?.focus();
        if (saveResult?.cloudEnabled && !saveResult.synced) {
            window.showToast?.("Attachment renamed on this device. Cloud sync is pending.", "warning");
        } else if (saveResult?.cloudEnabled === false) {
            window.showToast?.("Attachment renamed on this device. Sign in to sync it across devices.", "warning");
        } else {
            window.showToast?.("Attachment renamed", "success");
        }
    } catch (error) {
        target.attachment.name = oldName;
        target.attachment.updatedAt = oldAttachmentUpdatedAt;
        target.note.updatedAt = oldNoteUpdatedAt;
        if (feedback) feedback.textContent = error?.message || "Could not save this file name. Try again.";
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
}

function releaseAttachmentPreview(preview) {
    preview?.textAbortController?.abort();
    disposePdfPreview(preview);
    if (preview?.url?.startsWith("blob:")) {
        URL.revokeObjectURL(preview.url);
        privateAttachmentObjectUrls.delete(preview.url);
    }
}

function clearAttachmentViewerContent(content) {
    content?.querySelectorAll("iframe").forEach(frame => { frame.src = "about:blank"; });
    content?.replaceChildren();
}

function beginAttachmentPreview(attachment, url = "", trigger = null) {
    const viewer = document.getElementById("attachmentViewer");
    const title = document.getElementById("attachmentViewerTitle");
    const content = document.getElementById("attachmentViewerContent");
    if (!viewer || !content) return null;

    if (viewer.hidden) attachmentViewerReturnFocus = trigger || (document.activeElement !== document.body ? document.activeElement : null);
    releaseAttachmentPreview(activeAttachmentPreview);
    clearAttachmentViewerContent(content);
    const state = { attachment, url, trigger, requestId: ++attachmentPreviewRequestId, textAbortController: null };
    activeAttachmentPreview = state;
    if (title) title.textContent = attachment.name || "Attachment preview";
    viewer.hidden = false;
    viewer.setAttribute("aria-hidden", "false");
    document.body.classList.add("attachment-viewer-open");
    viewer.querySelector("[role=\"dialog\"]")?.setAttribute("tabindex", "-1");
    document.getElementById("attachmentViewerClose")?.focus();
    document.getElementById("attachmentViewerDownload")?.toggleAttribute("disabled", !url);
    document.getElementById("attachmentViewerShare")?.toggleAttribute("disabled", !url);
    return state;
}

function isCurrentAttachmentPreview(state) {
    const viewer = document.getElementById("attachmentViewer");
    return activeAttachmentPreview === state && !viewer?.hidden && state.requestId === attachmentPreviewRequestId;
}

function showViewerLoading(message = "Preparing preview…") {
    const content = document.getElementById("attachmentViewerContent");
    if (!content) return;
    const status = document.createElement("div");
    status.className = "attachment-viewer-loading";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const spinner = document.createElement("span");
    spinner.className = "attachment-viewer-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = message;
    status.append(spinner, label);
    content.replaceChildren(status);
}

function showViewerFailure(state, message) {
    if (!isCurrentAttachmentPreview(state)) return;
    const content = document.getElementById("attachmentViewerContent");
    const status = document.createElement("p");
    status.className = "attachment-viewer-message";
    status.setAttribute("role", "status");
    status.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "attachment-viewer-retry";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => openAttachmentFromButton(state.attachment, state.trigger));
    content.replaceChildren(status, retry);
}

function closeAttachmentViewer() {
    const viewer = document.getElementById("attachmentViewer");
    const content = document.getElementById("attachmentViewerContent");
    if (!viewer || viewer.hidden) return;
    attachmentPreviewRequestId++;
    releaseAttachmentPreview(activeAttachmentPreview);
    clearAttachmentViewerContent(content);
    activeAttachmentPreview = null;
    viewer.hidden = true;
    viewer.setAttribute("aria-hidden", "true");
    document.body.classList.remove("attachment-viewer-open");
    document.getElementById("attachmentViewerDownload")?.toggleAttribute("disabled", true);
    document.getElementById("attachmentViewerShare")?.toggleAttribute("disabled", true);
    const returnFocus = attachmentViewerReturnFocus;
    attachmentViewerReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus();
}

async function openAttachmentFromButton(attachment, trigger) {
    const state = beginAttachmentPreview(attachment, "", trigger);
    if (!state) return;
    showViewerLoading(attachment.type === "application/pdf" ? "Preparing document preview…" : "Preparing attachment preview…");
    try {
        const url = await resolveAttachmentUrl(attachment);
        if (!isCurrentAttachmentPreview(state)) {
            if (url?.startsWith("blob:")) {
                URL.revokeObjectURL(url);
                privateAttachmentObjectUrls.delete(url);
            }
            return;
        }
        if (!url) {
            showViewerFailure(state, "This attachment is not available on this device yet. Check your connection and try again.");
            return;
        }
        state.url = url;
        document.getElementById("attachmentViewerDownload")?.toggleAttribute("disabled", false);
        document.getElementById("attachmentViewerShare")?.toggleAttribute("disabled", false);
        await renderAttachmentPreview(state);
    } catch (error) {
        showViewerFailure(state, error?.message || "Could not prepare this attachment preview.");
    }
}

async function openAttachmentViewer(attachment, url, trigger = null) {
    const state = beginAttachmentPreview(attachment, url || "", trigger);
    if (!state) return;
    if (!url) {
        showViewerFailure(state, "This attachment is not available on this device yet. Check your connection and try again.");
        return;
    }
    document.getElementById("attachmentViewerDownload")?.toggleAttribute("disabled", false);
    document.getElementById("attachmentViewerShare")?.toggleAttribute("disabled", false);
    await renderAttachmentPreview(state);
}

async function renderAttachmentPreview(state) {
    const content = document.getElementById("attachmentViewerContent");
    if (!content || !isCurrentAttachmentPreview(state)) return;
    const { attachment, url } = state;
    content.replaceChildren();

    if (attachment.type === "application/pdf") {
        showViewerLoading("Loading PDF viewer…");
        await renderPdfPreview({
            state,
            url,
            container: content,
            isCurrent: isCurrentAttachmentPreview,
            onError: message => showViewerFailure(state, message)
        });
        return;
    }
    if (attachment.type?.startsWith("image/")) {
        const image = document.createElement("img");
        image.className = "attachment-viewer-image";
        image.alt = attachment.name || "Attachment preview";
        image.addEventListener("error", () => showViewerFailure(state, "Could not load this image preview. Use Download to save the file."));
        image.src = url;
        content.appendChild(image);
        return;
    }
    if (attachment.type === "text/plain") {
        const pre = document.createElement("pre");
        pre.className = "attachment-viewer-text";
        pre.setAttribute("role", "status");
        pre.textContent = "Loading preview…";
        content.appendChild(pre);
        const controller = new AbortController();
        state.textAbortController = controller;
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error("The text file could not be loaded.");
            const text = await response.text();
            if (!isCurrentAttachmentPreview(state)) return;
            pre.textContent = text;
            pre.removeAttribute("role");
        } catch (error) {
            if (error?.name === "AbortError" || !isCurrentAttachmentPreview(state)) return;
            pre.textContent = "Could not load this preview. Use Download to save the file.";
        }
        return;
    }
    const message = document.createElement("p");
    message.className = "attachment-viewer-message";
    message.textContent = "Preview is not available for this file type. You can still download or share it.";
    content.appendChild(message);
}

async function downloadActiveAttachment() {
    const active = activeAttachmentPreview;
    if (!active?.url) return;
    const filename = String(active.attachment.name || "attachment").replace(/[\\/\u0000-\u001f\u007f]/g, "_");
    try {
        const response = await fetch(active.url);
        if (!response.ok) throw new Error("Download could not be prepared.");
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } catch (error) {
        window.showToast?.(error?.message || "Could not download this attachment.", "warning");
    }
}

async function shareActiveAttachment() {
    const active = activeAttachmentPreview;
    if (!active?.url) return;
    const attachment = active.attachment;
    if (!navigator.share) {
        window.showToast?.("Secure file sharing is not available here. Use Download to save the attachment.", "warning");
        return;
    }
    try {
        const response = await fetch(active.url);
        if (!response.ok) throw new Error("Sharing could not be prepared.");
        const blob = await response.blob();
        const file = new File([blob], attachment.name || "attachment", { type: attachment.type || blob.type });
        if (navigator.canShare && !navigator.canShare({ files: [file] })) {
            window.showToast?.("Secure file sharing is not available here. Use Download to save the attachment.", "warning");
            return;
        }
        await navigator.share({ title: attachment.name || "SnapNotes attachment", files: [file] });
    } catch (error) {
        if (error?.name !== "AbortError") window.showToast?.(error?.message || "Could not share this attachment.", "warning");
    }
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
        const date = document.createElement("small");
        date.className = "attachment-upload-date";
        const timestamp = attachment.uploadedAt || attachment.createdAt;
        const formattedDate = formatAttachmentDate(timestamp);
        date.textContent = formattedDate
            ? `${attachment.uploadedAt ? "Uploaded" : "Added"} ${formattedDate}`
            : "Upload date unavailable";
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
        copy.append(name, size, date, status);

        const url = attachment.type?.startsWith("image/") || attachment.uploadStatus === "pending"
            ? await resolveAttachmentUrl(attachment)
            : "";
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

        const open = document.createElement("button");
        open.type = "button";
        open.className = "attachment-open";
        open.addEventListener("click", () => openAttachmentFromButton(attachment, open));
        if (attachment.uploadStatus === "pending" && !url) open.title = "Try again to load this attachment, or open it on the device where it was added.";
        open.textContent = "Preview";

        item.append(preview, copy, open);
        if (options.removable || options.editable) {
            const actions = document.createElement("div");
            actions.className = "attachment-management-actions";
            if (options.editable) {
                const rename = document.createElement("button");
                rename.type = "button";
                rename.className = "attachment-manage-button";
                rename.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i><span>Rename</span>';
                rename.setAttribute("aria-label", `Rename ${attachment.name || "attachment"}`);
                rename.addEventListener("click", () => renameNoteAttachment(options.noteId, attachment.id, rename));
                actions.appendChild(rename);
            }
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "attachment-manage-button is-danger";
            remove.setAttribute("aria-label", "Remove " + (attachment.name || "attachment"));
            remove.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i><span>Remove</span>';
            remove.addEventListener("click", async () => {
                if (options.editable && localStorage.getItem("SnapNotesConfirmDelete") !== "false" &&
                    !confirm(`Remove "${attachment.name || "this attachment"}" from the note?`)) return;
                const removed = await removeNoteAttachment(options.noteId, attachment.id);
                if (!removed) return;
                item.remove();
                if (!container.children.length) container.hidden = true;
                await options.onChange?.();
            });
            actions.appendChild(remove);
            item.appendChild(actions);
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
window.protectPrivateAttachmentsForPrivate = protectPrivateAttachmentsForPrivate;
window.unprotectPrivateAttachmentsFromPrivate = unprotectPrivateAttachmentsFromPrivate;
window.duplicatePrivateAttachments = duplicatePrivateAttachments;
window.retryPendingAttachmentUploads = retryPendingAttachmentUploads;
window.retryPendingAttachmentCleanup = retryPendingAttachmentCleanup;
window.cleanupAttachmentsForNotes = cleanupAttachmentsForNotes;
window.queueAttachmentCleanup = runAttachmentCleanup;
window.clearPrivateAttachmentObjectUrls = clearPrivateAttachmentObjectUrls;
window.deleteLocalAttachmentFilesForUser = deleteLocalAttachmentFilesForUser;
window.tagLegacyAttachmentFilesForUser = tagLegacyAttachmentFilesForUser;
window.clearAttachmentCleanupQueueForUser = clearAttachmentCleanupQueueForUser;
window.renderNoteAttachments = renderNoteAttachments;
window.removeNoteAttachment = removeNoteAttachment;
window.attachmentIsReferencedElsewhere = attachmentIsReferencedElsewhere;
window.openAttachmentViewer = openAttachmentViewer;
window.closeAttachmentViewer = closeAttachmentViewer;
window.downloadActiveAttachment = downloadActiveAttachment;
window.shareActiveAttachment = shareActiveAttachment;
