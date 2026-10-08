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

function openAttachmentDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(ATTACHMENT_DB, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });
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
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
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
    });
}

async function deleteAttachmentFile(id) {
    const db = await openAttachmentDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE, "readwrite");
        tx.objectStore(ATTACHMENT_STORE).delete(id);
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}

function validateAttachment(file) {
    if (!file) return "Invalid attachment.";
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
        return "Only images, PDF, and text files are supported.";
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
        return "Each attachment must be 10 MB or smaller.";
    }
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

function resetPendingAttachments() {
    pendingAttachmentFiles = [];
    renderPendingAttachments();
}

function addPendingAttachments(files) {
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
            existing.name === file.name &&
            existing.size === file.size &&
            existing.lastModified === file.lastModified
        );
        if (!duplicate) pendingAttachmentFiles.push(file);
    }

    if (incoming.length > available) {
        window.showToast?.("Only 5 attachments can be added to one note.", "warning");
    }

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
        copy.querySelector("small").textContent = formatAttachmentSize(file.size);

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
    if (!user || !navigator.onLine) return attachment;

    try {
        const { getStorage, ref, uploadBytes, getDownloadURL } =
            await import("https://www.gstatic.com/firebasejs/12.14.0/firebase-storage.js");
        const storage = getStorage();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = "users/" + user.uid + "/attachments/" + noteId + "/" + attachment.id + "-" + safeName;
        const storageRef = ref(storage, storagePath);

        await uploadBytes(storageRef, file, { contentType: file.type || "application/octet-stream" });
        attachment.storagePath = storagePath;
        attachment.downloadUrl = await getDownloadURL(storageRef);
    } catch (error) {
        console.warn("Attachment cloud upload failed:", error);
    }

    return attachment;
}

async function prepareNoteAttachments(noteId, files, existing = []) {
    const attachments = Array.isArray(existing) ? [...existing] : [];
    const incoming = Array.from(files || []);

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
            downloadUrl: null
        };

        await putAttachmentFile(attachment.id, file);
        await uploadAttachmentToCloud(noteId, attachment, file);
        attachments.push(attachment);
    }

    return attachments.slice(0, MAX_ATTACHMENTS_PER_NOTE);
}

async function resolveAttachmentUrl(attachment) {
    if (attachment?.downloadUrl) return attachment.downloadUrl;

    if (!attachment?.id) return "";
    const blob = await getAttachmentFile(attachment.id);
    if (!blob) return "";

    return URL.createObjectURL(blob);
}

async function removeNoteAttachment(noteId, attachmentId) {
    const note = (window.notes || []).find(item => item.id === noteId);
    const attachment = note?.attachments?.find(item => item.id === attachmentId);

    await deleteAttachmentFile(attachmentId);

    if (attachment?.storagePath && window.firebaseAuth?.currentUser) {
        try {
            const { getStorage, ref, deleteObject } =
                await import("https://www.gstatic.com/firebasejs/12.14.0/firebase-storage.js");
            await deleteObject(ref(getStorage(), attachment.storagePath));
        } catch (error) {
            console.warn("Could not remove cloud attachment:", error);
        }
    }

    if (note?.attachments) {
        note.attachments = note.attachments.filter(item => item.id !== attachmentId);
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
        copy.append(name, size);

        const url = await resolveAttachmentUrl(attachment);

        if (attachment.type?.startsWith("image/") && url) {
            const image = document.createElement("img");
            image.src = url;
            image.alt = attachment.name || "Attached image";
            image.loading = "lazy";
            preview.appendChild(image);
        } else {
            const icon = document.createElement("i");
            icon.className = "fa-solid " + attachmentIcon(attachment.type || "");
            preview.appendChild(icon);
        }

        const open = document.createElement("a");
        open.className = "attachment-open";
        open.href = url || "#";
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        open.textContent = attachment.type?.startsWith("image/") ? "Open" : "Download";
        if (!url) {
            open.removeAttribute("href");
            open.setAttribute("aria-disabled", "true");
        }

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
window.addPendingAttachments = addPendingAttachments;
window.resetPendingAttachments = resetPendingAttachments;
window.getPendingAttachments = () => [...pendingAttachmentFiles];
window.prepareNoteAttachments = prepareNoteAttachments;
window.renderNoteAttachments = renderNoteAttachments;
window.removeNoteAttachment = removeNoteAttachment;
