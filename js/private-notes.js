// =========================
// PRIVATE NOTES
// =========================
// Private note content is encrypted before it is written to localStorage or Firestore.
// The password never leaves the browser and is kept only in memory while private notes
// are unlocked. Forgetting it means the encrypted content cannot be recovered.

const PRIVATE_CRYPTO_VERSION = 1;
const PRIVATE_KDF_ITERATIONS = 600000;
const PRIVATE_MIN_PASSWORD_LENGTH = 12;
const privateUnlockCache = new Map();
let privateKey = null;
let privateSalt = null;

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
        false,
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

function getPrivateNotes() {
    return (Array.isArray(window.notes) ? window.notes : [])
        .filter(note => note?.isPrivate && !note.deletedAt && !note.archived);
}

function getReadablePrivateNote(note) {
    if (!note?.isPrivate) return note;

    const decrypted = privateUnlockCache.get(note.id);
    if (!decrypted) {
        return {
            ...note,
            title: "Private note",
            text: "Unlock Private Notes to view this content.",
            html: "",
            category: "general",
            tags: [],
            reminderAt: null,
            reminderNotified: false,
            time: "Locked"
        };
    }

    return { ...note, ...decrypted, isPrivate: true };
}

function isPrivateNotesUnlocked() {
    return Boolean(privateKey && privateUnlockCache.size);
}

function clearPrivateUnlock() {
    privateUnlockCache.clear();
    privateKey = null;
    privateSalt = null;
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

            finish(password);
        });

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
    const notes = getPrivateNotes();

    for (const note of notes) {
        await decryptPrivatePayload(note, key);
    }

    privateKey = key;
    privateSalt = salt;
    privateUnlockCache.clear();

    for (const note of notes) {
        const decrypted = await decryptPrivatePayload(note, key);
        privateUnlockCache.set(note.id, decrypted);
    }

    return true;
}

async function unlockPrivateNotes() {
    const notes = getPrivateNotes();
    if (!notes.length) {
        showToast("No private notes yet. Move a note to Private to set your password.", "warning");
        return false;
    }

    const password = await requestPrivatePassword("unlock");
    if (!password) return false;

    try {
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
        const password = await requestPrivatePassword("setup");
        if (!password) return null;

        const salt = crypto.getRandomValues(new Uint8Array(16));
        privateKey = await derivePrivateKey(password, salt);
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
        if (!window.crypto?.subtle || !window.crypto?.getRandomValues) {
            throw new Error("Web Crypto is not available.");
        }
        const session = await getPasswordForPrivateAction();
        if (!session) return;

        const payload = {
            title: note.title || "",
            text: note.text || "",
            html: note.html || "",
            category: note.category || "general",
            tags: Array.isArray(note.tags) ? note.tags : [],
            time: note.time || "",
            reminderAt: note.reminderAt || null,
            reminderRecurrence: window.normalizeReminderRecurrence?.(note.reminderRecurrence) || null,
            reminderNotified: Boolean(note.reminderNotified),
            history: Array.isArray(note.versions) ? structuredClone(note.versions) : []
        };

        note.privateData = await encryptPrivatePayload(payload, session.key, session.salt);
        note.isPrivate = true;
        note.title = "Private note";
        note.text = "";
        note.html = "";
        note.category = "general";
        note.tags = [];
        note.time = "Private note";
        note.versions = [];
        note.updatedAt = new Date().toISOString();

        privateUnlockCache.set(note.id, payload);
        const result = await saveNotes();
        if (result?.cloudEnabled && result.synced === false) {
            window.showToast?.("Note moved to Private and saved locally. Cloud sync is pending.", "warning");
        } else {
            window.showToast?.("Note moved to Private", "success");
        }
        renderNotes();
        updateNavigationCounts();
        return true;
    } catch (error) {
        console.error("Could not protect note:", error);
        window.showToast?.("Could not make this note private. Please try again.", "warning");
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
        if (updates.reminderAt) {
            await window.requestReminderPermission?.();
        }

        const current = privateUnlockCache.get(id);
        const payload = {
            title: String(updates.title || ""),
            text: String(updates.text || ""),
            html: String(updates.html || ""),
            category: String(updates.category || current?.category || "general"),
            tags: Array.isArray(updates.tags) ? updates.tags : (current?.tags || []),
            time: current?.time || "Private note",
            reminderAt: updates.reminderAt || null,
            reminderRecurrence: window.normalizeReminderRecurrence?.(updates.reminderRecurrence, updates.reminderAt) || null,
            reminderNotified: Boolean(updates.reminderNotified),
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
        note.reminderAt = updates.reminderAt || null;
        note.reminderRecurrence = window.normalizeReminderRecurrence?.(updates.reminderRecurrence, updates.reminderAt) || null;
        note.reminderNotified = Boolean(updates.reminderNotified);
        note.versions = [];
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
        const payload = privateUnlockCache.get(id) || await decryptPrivatePayload(note, privateKey);
        Object.assign(note, {
            title: payload.title || "",
            text: payload.text || "",
            html: payload.html || "",
            category: payload.category || "general",
            tags: Array.isArray(payload.tags) ? payload.tags : [],
            reminderAt: payload.reminderAt || note.reminderAt || null,
            reminderRecurrence: window.normalizeReminderRecurrence?.(payload.reminderRecurrence, payload.reminderAt) || null,
            reminderNotified: Boolean(payload.reminderNotified ?? note.reminderNotified),
            time: payload.time || note.time || "",
            versions: Array.isArray(payload.history) ? structuredClone(payload.history) : [],
            isPrivate: false,
            updatedAt: new Date().toISOString()
        });
        delete note.privateData;
        privateUnlockCache.delete(id);

        await saveNotes();
        renderNotes();
        updateNavigationCounts();
        showToast("Note moved back to your regular notes", "success");
        return true;
    } catch (error) {
        console.error("Could not make note public:", error);
        showToast("Could not unlock this private note.", "warning");
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
            reminderAt: version.reminderAt || null,
            reminderRecurrence: window.normalizeReminderRecurrence?.(version.reminderRecurrence, version.reminderAt) || null,
            reminderNotified: Boolean(version.reminderNotified),
            history
        };

        note.privateData = await encryptPrivatePayload(payload, privateKey, privateSalt);
        note.title = "Private note";
        note.text = "";
        note.html = "";
        note.category = "general";
        note.tags = [];
        note.time = "Private note";
        note.reminderAt = payload.reminderAt;
        note.reminderRecurrence = window.normalizeReminderRecurrence?.(payload.reminderRecurrence) || null;
        note.reminderNotified = payload.reminderNotified;
        note.versions = [];
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
        time: "Private note",
        createdAt: now,
        updatedAt: now,
        pinned: false,
        archived: false,
        deletedAt: null
    };

    duplicate.privateData = await encryptPrivatePayload(payload, privateKey, privateSalt);
    window.notes.unshift(duplicate);
    privateUnlockCache.set(duplicate.id, payload);
    window.recordNoteCreation?.(duplicate);
    await saveNotes();
    return true;
}

window.getReadablePrivateNote = getReadablePrivateNote;
window.isPrivateNotesUnlocked = isPrivateNotesUnlocked;
window.unlockPrivateNotes = unlockPrivateNotes;
window.clearPrivateUnlock = clearPrivateUnlock;
window.moveNoteToPrivate = moveNoteToPrivate;
window.moveNoteFromPrivate = moveNoteFromPrivate;
window.updatePrivateNote = updatePrivateNote;
window.duplicatePrivateNote = duplicatePrivateNote;
window.getPrivateVersionHistory = getPrivateVersionHistory;
window.restorePrivateNoteVersion = restorePrivateNoteVersion;
window.getPrivateNotesCount = () => getPrivateNotes().length;
window.privateNotesReady = true;
