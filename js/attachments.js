// =========================
// NOTE ATTACHMENTS
// =========================

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
});
window.addEventListener("online", retryPendingAttachmentUploads);
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
        code.includes("storage/unknown") ||
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
        window.showToast?.("A note can have up to 5 attachments.", "warning");
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

async function uploadAttachmentToCloud(noteId, attachment, file) {
    const user = window.firebaseAuth?.currentUser;
    if (!user) throw new Error("Sign in to sync attachments.");
    if (!navigator.onLine) throw new Error("Offline. Attachment will stay on this device until the connection returns.");

    const { getStorage, ref, uploadBytes, getDownloadURL } =
        await import("https://www.gstatic.com/firebasejs/12.14.0/firebase-storage.js");
    const storage = getStorage();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = "users/" + user.uid + "/attachments/" + noteId + "/" + attachment.id + "-" + safeName;
    const storageRef = ref(storage, storagePath);
    await uploadBytes(storageRef, file, { contentType: file.type || "application/octet-stream" });
    attachment.storagePath = storagePath;
    attachment.downloadUrl = await getDownloadURL(storageRef);
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
    // If an automatic retry is already running, let a manual retry await that
    // same work instead of silently returning while its button appears to do nothing.
    if (attachmentUploadPromise) return attachmentUploadPromise;

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

        for (const note of window.notes) {
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
                } catch (error) {
                    attachment.uploadStatus = "pending";
                    attachment.uploadError = getAttachmentUploadErrorMessage(error);
                    failedCount++;
                    changed = true;
                }
            }
        }

        if (changed) {
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
    }
}

async function resolveAttachmentUrl(attachment) {
    if (attachment?.id) {
        const blob = await getAttachmentFile(attachment.id).catch(() => null);
        if (blob) return URL.createObjectURL(blob);
    }
    if (attachment?.downloadUrl) return attachment.downloadUrl;
    return "";
}

async function removeNoteAttachment(noteId, attachmentId) {
    const note = (window.notes || []).find(item => item.id === noteId);
    const attachment = note?.attachments?.find(item => item.id === attachmentId);
    await deleteAttachmentFile(attachmentId).catch(() => {});

    if (attachment?.storagePath && window.firebaseAuth?.currentUser) {
        try {
            const { getStorage, ref, deleteObject } =
                await import("https://www.gstatic.com/firebasejs/12.14.0/firebase-storage.js");
            await deleteObject(ref(getStorage(), attachment.storagePath));
        } catch (error) {
            console.warn("Could not remove cloud attachment:", error);
        }
    }
    if (note?.attachments) note.attachments = note.attachments.filter(item => item.id !== attachmentId);
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
window.renderNoteAttachments = renderNoteAttachments;
window.removeNoteAttachment = removeNoteAttachment;
