// =========================
// PRIVATE NOTES
// =========================
// Private note content is encrypted before it is written to localStorage or Firestore.
// The password never leaves the browser and is kept only in memory while private notes
// are unlocked. Forgetting it means the encrypted content cannot be recovered.

import { buildPrivatePayload, lockedPrivateNote, privateNoteMetadataNeedsMigration, stripPrivateMetadata } from "./private-note-utils.js";
import { canUsePrivatePasskey, hasPrivatePasskey, registerPrivatePasskey, removePrivatePasskey, unlockPrivateKeyWithPasskey } from "./private-passkey.js";
import { decryptPrivateAttachment, encryptPrivateAttachment } from "./private-attachment-crypto.js";

const PRIVATE_CRYPTO_VERSION = 1;
const PRIVATE_KDF_ITERATIONS = 600000;
const PRIVATE_MIN_PASSWORD_LENGTH = 12;
const privateUnlockCache = new Map();
let privateKey = null;
let privateSalt = null;
let privateLockTimeout = null;
let privateSectionLeftAt = null;
const PRIVATE_LOCK_KEY = "SnapNotesPrivateLockMode";
const PRIVATE_LOCK_MODES = new Set(["immediate", "1m", "5m", "app-close"]);

function getPrivateLockMode() {
    try {
        const mode = localStorage.getItem(PRIVATE_LOCK_KEY);
        return PRIVATE_LOCK_MODES.has(mode) ? mode : "immediate";
    } catch {
        return "immediate";
    }
}

function cancelScheduledPrivateLock() {
    if (privateLockTimeout !== null) clearTimeout(privateLockTimeout);
    privateLockTimeout = null;
    privateSectionLeftAt = null;
}

function schedulePrivateLockOnLeave() {
    if (privateLockTimeout !== null) clearTimeout(privateLockTimeout);
    privateLockTimeout = null;
    if (privateSectionLeftAt === null) privateSectionLeftAt = Date.now();
    const mode = getPrivateLockMode();
    if (mode === "immediate") {
        clearPrivateUnlock();
        window.closeNoteDetail?.();
        return;
    }
    const delay = mode === "1m" ? 60_000 : mode === "5m" ? 300_000 : null;
    if (delay === null) return;
    const remaining = delay - (Date.now() - privateSectionLeftAt);
    if (remaining <= 0) {
        clearPrivateUnlock();
        window.closeNoteDetail?.();
        window.renderNotes?.();
        window.updateNavigationCounts?.();
        return;
    }
    privateLockTimeout = setTimeout(() => {
        privateLockTimeout = null;
        if (document.querySelector('.drawer-item[data-view="private"].active')) {
            privateSectionLeftAt = null;
            return;
        }
        clearPrivateUnlock();
        window.closeNoteDetail?.();
        window.renderNotes?.();
        window.updateNavigationCounts?.();
    }, remaining);
}

function setupPrivateLockSetting() {
    const control = document.getElementById("privateLockSetting");
    if (!control) return;
    control.value = getPrivateLockMode();
    control.addEventListener("change", () => {
        const mode = PRIVATE_LOCK_MODES.has(control.value) ? control.value : "immediate";
        localStorage.setItem(PRIVATE_LOCK_KEY, mode);
        control.value = mode;
        if (privateSectionLeftAt !== null) schedulePrivateLockOnLeave();
    });
}

document.addEventListener("DOMContentLoaded", setupPrivateLockSetting);
window.addEventListener("pagehide", () => {
    clearPrivateUnlock();
    window.closeNoteDetail?.();
});

function bytesToBase64(bytes) {
    let binary = "";
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function derivePrivateKey(password, salt) {
    if (!window.crypto?.subtle) {
        throw new Error("Web Crypto is not available in this browser.");
    }

    const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: PRIVATE_KDF_ITERATIONS,
            hash: "SHA-256"
        },
        material,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

async function encryptPrivatePayload(payload, key, salt = privateSalt) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        plaintext
    );

    return {
        version: PRIVATE_CRYPTO_VERSION,
        algorithm: "AES-GCM",
        kdf: "PBKDF2-SHA-256",
        iterations: PRIVATE_KDF_ITERATIONS,
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
}

async function decryptPrivatePayload(note, key = privateKey) {
    if (!note?.privateData || !key) throw new Error("Private note is locked.");

    const data = note.privateData;
    if (
        data.version !== PRIVATE_CRYPTO_VERSION ||
        data.algorithm !== "AES-GCM" ||
        data.kdf !== "PBKDF2-SHA-256" ||
        Number(data.iterations) !== PRIVATE_KDF_ITERATIONS ||
        !data.salt ||
        !data.iv ||
        !data.ciphertext
    ) {
        throw new Error("Unsupported private note format.");
    }

    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(data.iv) },
        key,
        base64ToBytes(data.ciphertext)
    );

    return JSON.parse(new TextDecoder().decode(plaintext));
}

async function encryptPrivateAttachmentBlob(blob) {
    if (!privateKey) throw new Error("Unlock Private Notes before protecting attachments.");
    return encryptPrivateAttachment(blob, privateKey);
}

async function decryptPrivateAttachmentBlob(blob, iv, type) {
    if (!privateKey) throw new Error("Unlock Private Notes to view this attachment.");
    return decryptPrivateAttachment(blob, privateKey, iv, type);
}

function getPrivateNotes() {
    return (Array.isArray(window.notes) ? window.notes : [])
        .filter(note => note?.isPrivate);
}

function getReadablePrivateNote(note) {
    if (!note?.isPrivate) return note;

    const decrypted = privateUnlockCache.get(note.id);
    if (!decrypted) {
        return lockedPrivateNote(note);
    }

    return {
        ...note,
        ...decrypted,
        attachments: Array.isArray(decrypted.attachments) ? decrypted.attachments : [],
        folderId: decrypted.folderId || null,
        isPrivate: true
    };
}

function isPrivateNotesUnlocked() {
    return Boolean(privateKey && privateUnlockCache.size);
}

function clearPrivateUnlock() {
    cancelScheduledPrivateLock();
    privateSectionLeftAt = null;
    privateUnlockCache.clear();
    privateKey = null;
    privateSalt = null;
    window.clearPrivateAttachmentObjectUrls?.();
    window.closeNoteDetail?.();
}

function restoreObject(target, snapshot) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, snapshot);
}

function createPrivatePasswordModal(mode) {
    const modal = document.createElement("div");
    modal.className = "auth-modal private-password-modal show";
    modal.setAttribute("aria-hidden", "false");

    const sheet = document.createElement("div");
    sheet.className = "auth-sheet private-password-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "privatePasswordTitle");

    const setup = mode === "setup";
    sheet.innerHTML = `
        <div class="modal-heading">
            <p class="eyebrow">Private Notes</p>
            <h3 id="privatePasswordTitle">${setup ? "Protect your private notes" : "Unlock Private Notes"}</h3>
            <p class="private-password-description">${setup
                ? "Choose a strong passphrase. SnapNotes cannot recover private notes if you forget it."
                : "Enter your private notes password to continue."}</p>
        </div>
        <input type="password" class="private-password-input" autocomplete="new-password" placeholder="Password" minlength="${PRIVATE_MIN_PASSWORD_LENGTH}" maxlength="128">
        ${setup ? `<input type="password" class="private-password-confirm" autocomplete="new-password" placeholder="Confirm password" minlength="${PRIVATE_MIN_PASSWORD_LENGTH}" maxlength="128">` : ""}
        <p class="private-password-hint">${setup ? `Use at least ${PRIVATE_MIN_PASSWORD_LENGTH} characters.` : ""}</p>
        ${!setup && hasPrivatePasskey() ? `<button type="button" class="secondary-action private-passkey-submit">Use passkey or fingerprint</button>` : ""}
        <div class="private-password-actions">
            <button type="button" class="cancel-button private-password-cancel">Cancel</button>
            <button type="button" class="primary-action private-password-submit">${setup ? "Set password" : "Unlock"}</button>
        </div>
    `;

    modal.appendChild(sheet);
    document.body.appendChild(modal);

    const passwordInput = sheet.querySelector(".private-password-input");
    const confirmInput = sheet.querySelector(".private-password-confirm");
    const hint = sheet.querySelector(".private-password-hint");
    const submit = sheet.querySelector(".private-password-submit");
    const cancel = sheet.querySelector(".private-password-cancel");
    const passkeySubmit = sheet.querySelector(".private-passkey-submit");

    const cleanup = () => modal.remove();

    return new Promise(resolve => {
        const finish = value => {
            cleanup();
            resolve(value);
        };

        cancel.addEventListener("click", () => finish(null));

        submit.addEventListener("click", () => {
            const password = passwordInput.value;
            if (password.length < PRIVATE_MIN_PASSWORD_LENGTH) {
                hint.textContent = `Use at least ${PRIVATE_MIN_PASSWORD_LENGTH} characters.`;
                hint.classList.add("error");
                passwordInput.focus();
                return;
            }

            if (setup && password !== confirmInput.value) {
                hint.textContent = "Passwords do not match.";
                hint.classList.add("error");
                confirmInput.focus();
                return;
            }

            finish({ type: "password", value: password });
        });

        passkeySubmit?.addEventListener("click", () => finish({ type: "passkey" }));

        modal.addEventListener("click", event => {
            if (event.target === modal) finish(null);
        });

        sheet.addEventListener("keydown", event => {
            if (event.key === "Escape") finish(null);
            if (event.key === "Enter") submit.click();
        });

        setTimeout(() => passwordInput.focus(), 0);
    });
}

async function requestPrivatePassword(mode) {
    return createPrivatePasswordModal(mode);
}

async function establishPrivateSession(password, salt) {
    const key = await derivePrivateKey(password, salt);
    return establishPrivateSessionWithKey(key, salt);
}

async function establishPrivateSessionWithKey(key, salt) {
    const notes = getPrivateNotes();
    const unlockedNotes = [];
    let migrated = false;

    for (const note of notes) {
        const decrypted = await decryptPrivatePayload(note, key);
        const payload = {
            ...decrypted,
            title: Object.hasOwn(decrypted, "title") ? decrypted.title : (note.title || ""),
            text: Object.hasOwn(decrypted, "text") ? decrypted.text : (note.text || ""),
            html: Object.hasOwn(decrypted, "html") ? decrypted.html : (note.html || ""),
            category: Object.hasOwn(decrypted, "category") ? decrypted.category : (note.category || "general"),
            tags: Array.isArray(decrypted.tags) ? structuredClone(decrypted.tags) : (Array.isArray(note.tags) ? structuredClone(note.tags) : []),
            time: Object.hasOwn(decrypted, "time") ? decrypted.time : (note.time || ""),
            reminderAt: Object.hasOwn(decrypted, "reminderAt") ? decrypted.reminderAt : (note.reminderAt || null),
            reminderNotified: Object.hasOwn(decrypted, "reminderNotified") ? Boolean(decrypted.reminderNotified) : Boolean(note.reminderNotified),
            reminderRepeat: Object.hasOwn(decrypted, "reminderRepeat") ? structuredClone(decrypted.reminderRepeat || null) : structuredClone(note.reminderRepeat || null),
            folderId: Object.hasOwn(decrypted, "folderId") ? (decrypted.folderId || null) : (note.folderId || null),
            attachments: Array.isArray(decrypted.attachments)
                ? structuredClone(decrypted.attachments)
                : (Array.isArray(note.attachments) ? structuredClone(note.attachments) : []),
            history: Array.isArray(decrypted.history)
                ? structuredClone(decrypted.history)
                : Array.isArray(note.history) ? structuredClone(note.history)
                    : Array.isArray(note.versions) ? structuredClone(note.versions) : []
        };
        unlockedNotes.push({
            note,
            payload,
            needsMigration: privateNoteMetadataNeedsMigration(note),
            noteSnapshot: structuredClone(note),
            attachmentSnapshot: structuredClone(payload.attachments)
        });
    }

    privateKey = key;
    privateSalt = salt;
    privateUnlockCache.clear();

    const legacyAttachments = [];
    let attachmentMigrationFailed = false;
    for (const entry of unlockedNotes) {
        const { note, payload, needsMigration } = entry;
        let noteChanged = needsMigration;
        if (payload.attachments.some(attachment => attachment && attachment.encrypted !== true)) {
            try {
                const conversion = await window.protectPrivateAttachmentsForPrivate?.(note.id, payload.attachments);
                if (!conversion) throw new Error("Private attachment protection is unavailable.");
                payload.attachments = conversion.attachments;
                legacyAttachments.push(...conversion.originals);
                noteChanged = true;
            } catch (error) {
                attachmentMigrationFailed = true;
                console.warn("Private attachment migration was incomplete:", error?.message || error);
            }
        }
        if (noteChanged) {
            note.privateData = await encryptPrivatePayload(payload, key, salt);
            if (needsMigration) stripPrivateMetadata(note);
            migrated = true;
        }
        privateUnlockCache.set(note.id, payload);
    }

    const uid = window.firebaseAuth?.currentUser?.uid;
    const attachmentIds = [...new Set(unlockedNotes.flatMap(entry =>
        (Array.isArray(entry.payload.attachments) ? entry.payload.attachments : [])
            .map(attachment => attachment?.id)
            .filter(id => typeof id === "string")
    ))];
    try {
        await window.tagLegacyAttachmentFilesForUser?.(uid, attachmentIds);
    } catch (error) {
        console.warn("Could not migrate private attachment ownership:", error);
    }

    if (migrated) {
        const saveResult = await window.saveNotes?.();
        if (saveResult?.locallySaved === false) {
            for (const entry of unlockedNotes) {
                restoreObject(entry.note, entry.noteSnapshot);
                entry.payload.attachments = entry.attachmentSnapshot;
                privateUnlockCache.set(entry.note.id, entry.payload);
            }
            legacyAttachments.length = 0;
            migrated = false;
            attachmentMigrationFailed = true;
        }
    }
    if (legacyAttachments.length) {
        const cleanup = await window.cleanupAttachmentsForNotes?.([{ attachments: legacyAttachments }]);
        if (cleanup?.persisted === false || cleanup?.pendingCount) attachmentMigrationFailed = true;
    }
    if (migrated) await window.retryPendingAttachmentUploads?.({ silent: true });
    if (attachmentMigrationFailed) {
        window.showToast?.("Some older private attachments could not be fully protected yet. Keep the original files available and reattach them after reviewing their status.", "warning");
    }
    window.checkDueReminders?.();

    return true;
}

async function unlockPrivateNotes() {
    const notes = getPrivateNotes();
    if (!notes.length) {
        showToast("No private notes yet. Move a note to Private to set your password.", "warning");
        return false;
    }

    const credential = await requestPrivatePassword("unlock");
    if (!credential) return false;

    try {
        if (credential.type === "passkey") {
            const key = await unlockPrivateKeyWithPasskey();
            const salt = base64ToBytes(notes[0].privateData.salt);
            await establishPrivateSessionWithKey(key, salt);
            return true;
        }
        const password = credential.value;
        const salt = base64ToBytes(notes[0].privateData.salt);
        await establishPrivateSession(password, salt);
        return true;
    } catch (error) {
        clearPrivateUnlock();
        console.warn("Private note unlock failed:", error);
        showToast("Incorrect private notes password.", "warning");
        return false;
    }
}

async function getPasswordForPrivateAction() {
    const notes = getPrivateNotes();

    if (privateKey && privateSalt) {
        return { key: privateKey, salt: privateSalt };
    }

    if (!notes.length) {
        const credential = await requestPrivatePassword("setup");
        if (!credential) return null;

        const salt = crypto.getRandomValues(new Uint8Array(16));
        privateKey = await derivePrivateKey(credential.value, salt);
        privateSalt = salt;
        privateUnlockCache.clear();
        return { key: privateKey, salt: privateSalt };
    }

    const unlocked = await unlockPrivateNotes();
    if (!unlocked) return null;
    return { key: privateKey, salt: privateSalt };
}

async function moveNoteToPrivate(id) {
    const note = (Array.isArray(window.notes) ? window.notes : []).find(item => item.id === id);
    if (!note || note.isPrivate) {
        window.showToast?.("This note is no longer available.", "warning");
        return false;
    }

    try {
        const originalNote = structuredClone(note);
        if (!window.crypto?.subtle || !window.crypto?.getRandomValues) {
            throw new Error("Web Crypto is not available.");
        }
        const session = await getPasswordForPrivateAction();
        if (!session) return;

        const payload = buildPrivatePayload(note);
        const conversion = await window.protectPrivateAttachmentsForPrivate?.(note.id, payload.attachments);
        if (!conversion) throw new Error("Private attachment protection is unavailable. Refresh and try again.");
        payload.attachments = conversion.attachments;

        note.privateData = await encryptPrivatePayload(payload, session.key, session.salt);
        note.isPrivate = true;
        note.title = "Private note";
        note.text = "";
        note.html = "";
        note.category = "general";
        note.tags = [];
        note.time = "Private note";
        note.versions = [];
        stripPrivateMetadata(note);
        note.updatedAt = new Date().toISOString();

        privateUnlockCache.set(note.id, payload);
        const result = await saveNotes();
        if (result?.locallySaved === false) {
            restoreObject(note, originalNote);
            privateUnlockCache.delete(note.id);
            throw new Error("The note could not be saved locally, so it was not moved to Private. Keep the original files and try again.");
        }
        const cleanup = conversion.originals.length
            ? await window.cleanupAttachmentsForNotes?.([{ attachments: conversion.originals }])
            : null;
        await window.retryPendingAttachmentUploads?.({ silent: true });
        if (cleanup?.persisted === false || cleanup?.pendingCount) {
            window.showToast?.("Private note saved with encrypted attachments. Removal of an older unencrypted cloud copy is queued for retry.", "warning");
        } else if (result?.cloudEnabled && result.synced === false) {
            window.showToast?.("Note moved to Private and saved locally. Cloud sync is pending.", "warning");
        } else {
            window.showToast?.("Note moved to Private", "success");
        }
        renderNotes();
        updateNavigationCounts();
        return true;
    } catch (error) {
        console.error("Could not protect note:", error);
        window.showToast?.(error?.message || "Could not make this note private. Please try again.", "warning");
        return false;
    }
}

async function updatePrivateNote(id, updates) {
    const note = window.notes.find(item => item.id === id);
    if (!note?.isPrivate || !privateKey || !privateSalt) {
        showToast("Unlock Private Notes before editing.", "warning");
        return false;
    }

    try {
        const current = privateUnlockCache.get(id);
        const payload = {
            title: String(updates.title || ""),
            text: String(updates.text || ""),
            html: String(updates.html || ""),
            category: String(updates.category || current?.category || "general"),
            tags: Array.isArray(updates.tags) ? updates.tags : (current?.tags || []),
            time: current?.time || "Private note",
            folderId: current?.folderId || null,
            reminderAt: updates.reminderAt || null,
            reminderNotified: Boolean(updates.reminderNotified),
            reminderRepeat: Object.hasOwn(updates, "reminderRepeat")
                ? structuredClone(updates.reminderRepeat || null)
                : structuredClone(current?.reminderRepeat || null),
            attachments: Array.isArray(updates.attachments) ? structuredClone(updates.attachments) : (current?.attachments || []),
            history: typeof window.appendVersion === "function"
                ? window.appendVersion(current?.history, current || {})
                : (Array.isArray(current?.history) ? current.history : [])
        };

        note.privateData = await encryptPrivatePayload(payload, privateKey, privateSalt);
        note.title = "Private note";
        note.text = "";
        note.html = "";
        note.category = "general";
        note.tags = [];
        note.versions = [];
        stripPrivateMetadata(note);
        note.updatedAt = new Date().toISOString();
        privateUnlockCache.set(id, payload);

        await saveNotes();
        return true;
    } catch (error) {
        console.error("Could not update private note:", error);
        showToast("Could not save the private note.", "warning");
        return false;
    }
}

async function moveNoteFromPrivate(id) {
    const note = window.notes.find(item => item.id === id);
    if (!note?.isPrivate || !privateKey) {
        showToast("Unlock Private Notes first.", "warning");
        return false;
    }

    try {
        const originalNote = structuredClone(note);
        const payload = privateUnlockCache.get(id) || await decryptPrivatePayload(note, privateKey);
        const conversion = await window.unprotectPrivateAttachmentsFromPrivate?.(id, payload.attachments || []);
        if (!conversion) throw new Error("Could not restore private attachments. Try again while online.");
        Object.assign(note, {
            title: payload.title || "",
            text: payload.text || "",
            html: payload.html || "",
            category: payload.category || "general",
            tags: Array.isArray(payload.tags) ? payload.tags : [],
            folderId: payload.folderId || null,
            attachments: conversion.attachments,
            reminderAt: payload.reminderAt || null,
            reminderNotified: Boolean(payload.reminderNotified),
            reminderRepeat: structuredClone(payload.reminderRepeat || null),
            time: payload.time || note.time || "",
            versions: Array.isArray(payload.history) ? structuredClone(payload.history) : [],
            isPrivate: false,
            updatedAt: new Date().toISOString()
        });
        delete note.privateData;
        privateUnlockCache.delete(id);

        const saveResult = await saveNotes();
        if (saveResult?.locallySaved === false) {
            restoreObject(note, originalNote);
            privateUnlockCache.set(id, payload);
            const originalIds = new Set((payload.attachments || []).map(attachment => attachment?.id));
            const temporaryPlaintext = conversion.attachments.filter(attachment => attachment?.id && !originalIds.has(attachment.id));
            if (temporaryPlaintext.length) await window.cleanupAttachmentsForNotes?.([{ attachments: temporaryPlaintext }]);
            throw new Error("The note could not be saved locally, so it remains in Private. Try again when local storage is available.");
        }
        if (conversion.originals.length) {
            await window.cleanupAttachmentsForNotes?.([{ attachments: conversion.originals }]);
        }
        await window.retryPendingAttachmentUploads?.({ silent: true });
        renderNotes();
        updateNavigationCounts();
        showToast("Note moved back to your regular notes", "success");
        return true;
    } catch (error) {
        console.error("Could not make note public:", error);
        showToast(error?.message || "Could not unlock this private note.", "warning");
        return false;
    }
}

async function getPrivateVersionHistory(id) {
    const note = window.notes.find(item => item.id === id);
    if (!note?.isPrivate || !privateKey) return [];

    try {
        const payload = privateUnlockCache.get(id) || await decryptPrivatePayload(note, privateKey);
        if (!privateUnlockCache.has(id)) privateUnlockCache.set(id, payload);
        return Array.isArray(payload.history) ? structuredClone(payload.history) : [];
    } catch (error) {
        console.error("Could not load private note history:", error);
        showToast("Could not load this note's history.", "warning");
        return [];
    }
}

async function restorePrivateNoteVersion(id, version) {
    const note = window.notes.find(item => item.id === id);
    if (!note?.isPrivate || !privateKey || !privateSalt) {
        showToast("Unlock Private Notes before restoring a version.", "warning");
        return false;
    }

    try {
        const current = privateUnlockCache.get(id) || await decryptPrivatePayload(note, privateKey);
        const history = typeof window.appendVersion === "function"
            ? window.appendVersion(current.history, current)
            : (Array.isArray(current.history) ? current.history : []);

        const payload = {
            ...current,
            title: version.title || "",
            text: version.text || "",
            html: version.html || "",
            category: version.category || "general",
            tags: Array.isArray(version.tags) ? [...version.tags] : [],
            time: version.time || current.time || "Private note",
            folderId: version.folderId || current.folderId || null,
            attachments: Array.isArray(version.attachments) ? structuredClone(version.attachments) : (current.attachments || []),
            reminderAt: version.reminderAt || null,
            reminderNotified: Boolean(version.reminderNotified),
            reminderRepeat: structuredClone(version.reminderRepeat || null),
            history
        };

        note.privateData = await encryptPrivatePayload(payload, privateKey, privateSalt);
        note.title = "Private note";
        note.text = "";
        note.html = "";
        note.category = "general";
        note.tags = [];
        note.time = "Private note";
        note.versions = [];
        stripPrivateMetadata(note);
        note.updatedAt = new Date().toISOString();

        privateUnlockCache.set(id, payload);
        await saveNotes();
        renderNotes();
        updateNavigationCounts();
        showToast("Earlier private version restored.", "success");
        return true;
    } catch (error) {
        console.error("Could not restore private note version:", error);
        showToast("Could not restore that private version.", "warning");
        return false;
    }
}

async function duplicatePrivateNote(id) {
    const source = window.notes.find(item => item.id === id);
    if (!source?.isPrivate || !privateKey || !privateSalt) return false;

    const payload = privateUnlockCache.get(id) || await decryptPrivatePayload(source, privateKey);
    let duplicateAttachments;
    try {
        duplicateAttachments = await window.duplicatePrivateAttachments?.(payload.attachments || []);
        if (!Array.isArray(duplicateAttachments)) throw new Error("Private attachment duplication is unavailable.");
    } catch (error) {
        console.warn("Could not duplicate private attachments:", error?.message || error);
        showToast(error?.message || "Could not duplicate this private note.", "warning");
        return false;
    }
    const duplicatePayload = {
        ...structuredClone(payload),
        attachments: duplicateAttachments,
        reminderAt: null,
        reminderNotified: false,
        reminderRepeat: null
    };
    const now = new Date().toISOString();
    const duplicate = {
        ...structuredClone(source),
        id: crypto.randomUUID(),
        title: "Private note",
        text: "",
        html: "",
        category: "general",
        tags: [],
        reminderAt: null,
        reminderNotified: false,
        reminderRepeat: null,
        time: "Private note",
        createdAt: now,
        updatedAt: now,
        pinned: false,
        archived: false,
        deletedAt: null
    };

    duplicate.privateData = await encryptPrivatePayload(duplicatePayload, privateKey, privateSalt);
    stripPrivateMetadata(duplicate);
    window.notes.unshift(duplicate);
    privateUnlockCache.set(duplicate.id, duplicatePayload);
    window.recordNoteCreation?.(duplicate);
    const result = await saveNotes();
    if (result?.locallySaved === false) {
        window.notes = window.notes.filter(note => note.id !== duplicate.id);
        privateUnlockCache.delete(duplicate.id);
        await window.cleanupAttachmentsForNotes?.([{ attachments: duplicateAttachments }]);
        showToast("The duplicate could not be saved locally. The original private note is unchanged.", "warning");
        return false;
    }
    await window.retryPendingAttachmentUploads?.({ silent: true });
    return true;
}

async function savePrivateAttachmentMetadata(id, attachments) {
    const note = window.notes.find(item => item.id === id);
    const current = privateUnlockCache.get(id);
    if (!note?.isPrivate || !current || !privateKey || !privateSalt) return false;
    const payload = { ...current, attachments: Array.isArray(attachments) ? structuredClone(attachments) : [] };
    note.privateData = await encryptPrivatePayload(payload, privateKey, privateSalt);
    stripPrivateMetadata(note);
    note.updatedAt = new Date().toISOString();
    privateUnlockCache.set(id, payload);
    return true;
}

async function markPrivateReminderNotified(id, completionState = { reminderNotified: true }) {
    const note = window.notes.find(item => item.id === id);
    const current = privateUnlockCache.get(id);
    if (!note?.isPrivate || !current || !privateKey || !privateSalt) return false;
    const payload = {
        ...current,
        ...completionState,
        reminderRepeat: Object.hasOwn(completionState || {}, "reminderRepeat")
            ? structuredClone(completionState.reminderRepeat || null)
            : structuredClone(current.reminderRepeat || null)
    };
    note.privateData = await encryptPrivatePayload(payload, privateKey, privateSalt);
    stripPrivateMetadata(note);
    note.updatedAt = new Date().toISOString();
    privateUnlockCache.set(id, payload);
    return true;
}

async function configurePrivatePasskey() {
    if (!privateKey || !privateSalt || !isPrivateNotesUnlocked()) {
        showToast("Unlock Private Notes with your password before setting up a passkey.", "warning");
        return false;
    }
    if (!canUsePrivatePasskey()) {
        showToast("Passkeys are not available in this browser. You can still use your password.", "warning");
        return false;
    }
    try {
        await registerPrivatePasskey(privateKey);
        showToast("Passkey or fingerprint unlocking is ready on this device.", "success");
        return true;
    } catch (error) {
        console.warn("Could not configure a private-notes passkey:", error);
        showToast(error?.name === "NotAllowedError"
            ? "Passkey setup was canceled. Your password remains available."
            : error?.message || "Could not set up a passkey. Your password remains available.", "warning");
        return false;
    }
}

function disablePrivatePasskey() {
    removePrivatePasskey();
    showToast("Passkey unlocking was removed from this device.", "success");
}

window.getReadablePrivateNote = getReadablePrivateNote;
window.isPrivateNotesUnlocked = isPrivateNotesUnlocked;
window.unlockPrivateNotes = unlockPrivateNotes;
window.hasPrivatePasskey = hasPrivatePasskey;
window.canUsePrivatePasskey = canUsePrivatePasskey;
window.configurePrivatePasskey = configurePrivatePasskey;
window.disablePrivatePasskey = disablePrivatePasskey;
window.clearPrivateUnlock = clearPrivateUnlock;
window.schedulePrivateLockOnLeave = schedulePrivateLockOnLeave;
window.cancelScheduledPrivateLock = cancelScheduledPrivateLock;
window.encryptPrivateAttachmentBlob = encryptPrivateAttachmentBlob;
window.decryptPrivateAttachmentBlob = decryptPrivateAttachmentBlob;
window.moveNoteToPrivate = moveNoteToPrivate;
window.moveNoteFromPrivate = moveNoteFromPrivate;
window.updatePrivateNote = updatePrivateNote;
window.duplicatePrivateNote = duplicatePrivateNote;
window.getPrivateVersionHistory = getPrivateVersionHistory;
window.restorePrivateNoteVersion = restorePrivateNoteVersion;
window.savePrivateAttachmentMetadata = savePrivateAttachmentMetadata;
window.markPrivateReminderNotified = markPrivateReminderNotified;
window.getPrivateNotesCount = () => getPrivateNotes().filter(note => !note.deletedAt && !note.archived).length;
window.privateNotesReady = true;
