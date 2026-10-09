// =========================
// NOTE edit history
// =========================

const MAX_NOTE_VERSIONS = 20;

function createVersionSnapshot(note) {
    return {
        title: String(note?.title || ""),
        text: String(note?.text || ""),
        html: String(note?.html || ""),
        category: String(note?.category || "general"),
        tags: Array.isArray(note?.tags) ? [...note.tags] : [],
        reminderAt: note?.reminderAt || null,
        reminderNotified: Boolean(note?.reminderNotified),
        time: String(note?.time || ""),
        savedAt: new Date().toISOString()
    };
}

function appendVersion(history, noteOrSnapshot) {
    const list = Array.isArray(history) ? history : [];
    const snapshot = noteOrSnapshot?.savedAt
        ? {
            ...noteOrSnapshot,
            tags: Array.isArray(noteOrSnapshot.tags) ? [...noteOrSnapshot.tags] : []
        }
        : createVersionSnapshot(noteOrSnapshot);

    const previous = list[list.length - 1];
    const sameContent = previous &&
        previous.title === snapshot.title &&
        previous.text === snapshot.text &&
        previous.html === snapshot.html &&
        JSON.stringify(previous.tags || []) === JSON.stringify(snapshot.tags || []) &&
        previous.reminderAt === snapshot.reminderAt;

    if (sameContent) return list.slice(-MAX_NOTE_VERSIONS);

    list.push(snapshot);
    return list.slice(-MAX_NOTE_VERSIONS);
}

function getVersionHistory(note) {
    return Array.isArray(note?.versions) ? note.versions : [];
}

function versionPreview(version) {
    const text = String(version?.text || "").replace(/\s+/g, " ").trim();
    return text || "No body text in this version.";
}

function formatVersionDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown time";
    return date.toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short"
    });
}

function ensureVersionHistoryModal() {
    let modal = document.getElementById("editHistoryModal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "editHistoryModal";
    modal.className = "auth-modal edit-history-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
        <div class="auth-sheet edit-history-sheet" role="dialog" aria-modal="true" aria-labelledby="editHistoryTitle">
            <div class="modal-heading">
                <p class="eyebrow">Note history</p>
                <h3 id="editHistoryTitle">Edit History</h3>
                <p class="edit-history-description">Restore an earlier version without losing your current one.</p>
            </div>
            <div id="editHistoryList" class="edit-history-list"></div>
            <div class="edit-history-footer">
                <span>Up to 20 versions are kept per note.</span>
                <button type="button" class="cancel-button" id="closeVersionHistoryBtn">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", event => {
        if (event.target === modal) closeVersionHistory();
    });
    modal.querySelector("#closeVersionHistoryBtn")?.addEventListener("click", closeVersionHistory);
    return modal;
}

function closeVersionHistory() {
    const modal = document.getElementById("editHistoryModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
}

function renderVersionHistory(noteId, versions, isPrivate = false) {
    const modal = ensureVersionHistoryModal();
    const list = modal.querySelector("#editHistoryList");
    list.innerHTML = "";

    const ordered = [...(versions || [])].sort((a, b) =>
        Date.parse(b.savedAt || 0) - Date.parse(a.savedAt || 0)
    );

    if (!ordered.length) {
        list.innerHTML = '<p class="edit-history-empty">No previous versions yet. Edit this note and SnapNotes will keep the earlier version here.</p>';
    } else {
        ordered.forEach((version, index) => {
            const item = document.createElement("article");
            item.className = "edit-history-item";

            const copy = document.createElement("div");
            copy.className = "edit-history-copy";

            const title = document.createElement("strong");
            title.textContent = version.title || "Untitled note";

            const date = document.createElement("time");
            date.textContent = formatVersionDate(version.savedAt);

            const preview = document.createElement("p");
            preview.textContent = versionPreview(version);

            copy.append(title, date, preview);

            const restore = document.createElement("button");
            restore.type = "button";
            restore.className = "secondary-action version-restore-button";
            restore.textContent = index === 0 ? "Restore" : "Restore version";
            restore.addEventListener("click", async () => {
                const ok = isPrivate
                    ? await window.restorePrivateNoteVersion?.(noteId, version)
                    : await restorePublicNoteVersion(noteId, version);

                if (ok) closeVersionHistory();
            });

            item.append(copy, restore);
            list.appendChild(item);
        });
    }

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
}

async function openNoteVersionHistory(id) {
    const rawNote = Array.isArray(window.notes)
        ? window.notes.find(note => note.id === id)
        : null;
    if (!rawNote) return false;

    if (rawNote.isPrivate) {
        const unlocked = window.isPrivateNotesUnlocked?.()
            ? true
            : await window.unlockPrivateNotes?.();
        if (!unlocked) return false;

        const versions = await window.getPrivateVersionHistory?.(id);
        renderVersionHistory(id, versions || [], true);
        return true;
    }

    renderVersionHistory(id, getVersionHistory(rawNote), false);
    return true;
}

async function restorePublicNoteVersion(id, version) {
    const index = window.notes.findIndex(note => note.id === id);
    if (index === -1) return false;

    const note = window.notes[index];
    note.versions = appendVersion(note.versions, note);
    Object.assign(note, {
        title: version.title || "",
        text: version.text || "",
        html: version.html || "",
        category: version.category || "general",
        tags: Array.isArray(version.tags) ? [...version.tags] : [],
        reminderAt: version.reminderAt || null,
        reminderNotified: Boolean(version.reminderNotified),
        time: version.time || note.time || "",
        updatedAt: new Date().toISOString()
    });

    await window.saveNotes?.();
    window.renderNotes?.();
    window.updateNavigationCounts?.();
    window.showToast?.("Earlier version restored.", "success");
    return true;
}

window.MAX_NOTE_VERSIONS = MAX_NOTE_VERSIONS;
window.createVersionSnapshot = createVersionSnapshot;
window.appendVersion = appendVersion;
window.getVersionHistory = getVersionHistory;
window.openNoteVersionHistory = openNoteVersionHistory;
window.restorePublicNoteVersion = restorePublicNoteVersion;
window.closeVersionHistory = closeVersionHistory;
