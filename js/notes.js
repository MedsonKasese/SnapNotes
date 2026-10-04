// =========================
// NOTE LIST + NOTE ACTIONS
// =========================

function renderNotes(filterText = "", filterCategory = "all", view = window.getActiveNotesView ? window.getActiveNotesView() : "all") {
    const notesContainer = document.getElementById("notesContainer");
    if (!notesContainer) return;

    const notes = Array.isArray(window.notes) ? window.notes : [];
    const rawQuery = filterText.toLowerCase().trim();
    let sortMode = "newest";
    const tokens = rawQuery.split(/\s+/).filter(Boolean);
    const categoryToken = tokens.find(token => token.startsWith("category:"));
    const pinnedToken = tokens.find(token => token === "is:pinned");
    if (tokens.includes("sort:oldest")) sortMode = "oldest";
    const searchTerms = tokens.filter(token => !token.startsWith("category:") && token !== "is:pinned" && !token.startsWith("sort:"));
    const query = searchTerms.join(" ");

    const visibleNotes = notes.filter(note => {
        if (view === "trash") return Boolean(note.deletedAt);
        if (view === "archive") return Boolean(note.archived) && !note.deletedAt;
        return !note.archived && !note.deletedAt;
    });

    const filteredNotes = visibleNotes.filter(note => {
        const searchableText = [
            note.title || "",
            note.text || "",
            note.category || ""
        ].join(" ").toLowerCase();

        const matchesSearch = !query || searchTerms.every(term => searchableText.includes(term));
        const requestedCategory = categoryToken ? categoryToken.replace("category:", "") : filterCategory;
        const matchesCategory = requestedCategory === "all" || note.category === requestedCategory;
        const matchesPinned = !pinnedToken || note.pinned;
        return matchesSearch && matchesCategory && matchesPinned;
    });

    filteredNotes.sort((a, b) => {
        if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
        const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return sortMode === "oldest" ? aTime - bTime : bTime - aTime;
    });

    notesContainer.innerHTML = "";

    filteredNotes.forEach(note => {
        notesContainer.appendChild(createNoteElement(note));
    });

    updateEmptyState(filteredNotes.length, notes.length);
    updateNotesCount();
}

const historyStack = [];
const redoStack = [];

function recordHistory(id) {
    const note = window.notes.find(item => item.id === id);
    if (note) historyStack.push({ id, snapshot: structuredClone(note) });
    redoStack.length = 0;
}

function undoLastNoteChange() {
    const change = historyStack.pop();
    if (!change) return showToast("Nothing to undo", "warning");

    const index = window.notes.findIndex(note => note.id === change.id);

    if (change.action === "create") {
        if (index !== -1) {
            redoStack.push({ id: change.id, action: "create", snapshot: structuredClone(window.notes[index]) });
            window.notes.splice(index, 1);
        }
    } else {
        if (index === -1) return;
        redoStack.push({ id: change.id, snapshot: structuredClone(window.notes[index]) });
        window.notes[index] = change.snapshot;
    }

    saveNotes();
    renderNotes();
    if (typeof window.updateNavigationCounts === "function") window.updateNavigationCounts();
    showToast("Change undone", "update");
}

function redoLastNoteChange() {
    const change = redoStack.pop();
    if (!change) return showToast("Nothing to redo", "warning");

    const index = window.notes.findIndex(note => note.id === change.id);

    if (change.action === "create") {
        if (index === -1) {
            window.notes.unshift(structuredClone(change.snapshot));
            historyStack.push({ id: change.id, action: "create", snapshot: structuredClone(change.snapshot) });
        }
    } else {
        if (index === -1) return;
        historyStack.push({ id: change.id, snapshot: structuredClone(window.notes[index]) });
        window.notes[index] = change.snapshot;
    }

    saveNotes();
    renderNotes();
    if (typeof window.updateNavigationCounts === "function") window.updateNavigationCounts();
    showToast("Change redone", "update");
}

function createNoteElement(note) {
    const card = document.createElement("article");
    card.className = "note-card";
    card.dataset.id = note.id;
    card.dataset.category = note.category || "general";
    card.tabIndex = 0;
    card.addEventListener("click", event => {
        if (event.target.closest("button, a, .note-dropdown")) return;
        window.openNoteDetail?.(note.id);
    });

    if (note.pinned) {
        card.classList.add("pinned");
    }

    const top = document.createElement("div");
    top.className = "note-card-top";

    const content = document.createElement("div");
    content.className = "note-card-content";

    const title = document.createElement("h2");
    title.className = "note-card-title";
    title.textContent = note.title || "Untitled note";

    const body = document.createElement("div");
    body.className = "note-card-body";
    if (note.html && typeof window.sanitizeNoteHtml === "function") {
        body.innerHTML = window.sanitizeNoteHtml(note.html);
    } else {
        body.textContent = note.text || "";
    }

    content.appendChild(title);
    content.appendChild(body);

    top.appendChild(content);

    const meta = document.createElement("div");
    meta.className = "note-card-meta";

    const metaLeft = document.createElement("div");
    metaLeft.className = "note-card-meta-left";

    const category = document.createElement("span");
    category.className = "note-category";
    category.textContent = formatCategory(note.category);

    const time = document.createElement("span");
    time.className = "note-time";
    time.textContent = note.time || formatDate(note.createdAt);

    metaLeft.append(category, time);

    const actions = document.createElement("div");
    actions.className = "note-card-actions";

    const pinButton = document.createElement("button");
    pinButton.className = "note-action pin" + (note.pinned ? " active" : "");
    pinButton.type = "button";
    pinButton.setAttribute("aria-label", note.pinned ? "Unpin note" : "Pin note");
    pinButton.title = note.pinned ? "Unpin note" : "Pin note";
    pinButton.innerHTML = `<i class="fa-solid fa-thumbtack"></i>`;
    pinButton.addEventListener("click", () => togglePin(note.id));

    const menuWrapper = document.createElement("div");
    menuWrapper.className = "note-menu";

    const menuButton = document.createElement("button");
    menuButton.className = "note-action";
    menuButton.type = "button";
    menuButton.setAttribute("aria-label", "Note actions");
    menuButton.title = "Note actions";
    menuButton.innerHTML = `<i class="fa-solid fa-ellipsis"></i>`;

    const dropdown = document.createElement("div");
    dropdown.className = "note-dropdown";

    const shareButton = createDropdownItem("Share note", () => shareNote(note));
    const editButton = createDropdownItem("Edit note", () => startEditing(card, note));
    const noteView = viewForNote(note);
    if (noteView === "trash") {
        dropdown.append(
            createDropdownItem("Restore note", () => restoreNote(note.id)),
            createDropdownItem("Delete forever", () => permanentlyDeleteNote(note.id), "delete-action")
        );
    } else {
        const archiveButton = noteView === "archive"
            ? createDropdownItem("Restore note", () => restoreNote(note.id))
            : createDropdownItem("Archive note", () => archiveNote(note.id));
        const deleteButton = createDropdownItem("Move to trash", () => deleteNote(note.id), "delete-action");
        dropdown.append(shareButton, editButton, archiveButton, deleteButton);
    }

    menuButton.addEventListener("click", event => {
        event.stopPropagation();
        closeNoteMenus();
        dropdown.classList.toggle("show");
    });

    menuWrapper.append(menuButton, dropdown);
    actions.append(pinButton, menuWrapper);
    meta.append(metaLeft, actions);

    card.append(top, meta);
    return card;
}

function createDropdownItem(text, action, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    if (className) button.classList.add(className);

    button.addEventListener("click", event => {
        event.stopPropagation();
        action();
    });

    return button;
}

function startEditing(card, note) {
    closeNoteMenus();

    const content = card.querySelector(".note-card-content");
    const top = card.querySelector(".note-card-top");
    const meta = card.querySelector(".note-card-meta");

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = note.title || "";
    titleInput.placeholder = "Note title";
    titleInput.className = "edit-note-area";
    titleInput.style.minHeight = "auto";
    titleInput.style.resize = "none";

    const bodyInput = document.createElement("div");
    bodyInput.className = "edit-note-area edit-note-editor";
    bodyInput.contentEditable = "true";
    bodyInput.setAttribute("role", "textbox");
    bodyInput.setAttribute("aria-multiline", "true");
    bodyInput.innerHTML = typeof window.sanitizeNoteHtml === "function"
        ? window.sanitizeNoteHtml(note.html || "")
        : "";
    if (!bodyInput.innerHTML.trim()) {
        bodyInput.textContent = note.text || "";
    }

    const actions = document.createElement("div");
    actions.className = "edit-save-row";

    const cancelButton = document.createElement("button");
    cancelButton.className = "cancel-edit";
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = "Save";

    actions.append(cancelButton, saveButton);

    content.replaceChildren(titleInput, bodyInput, actions);
    top.querySelector(".note-card-actions").hidden = true;
    meta.hidden = true;

    cancelButton.addEventListener("click", () => renderNotes());
    saveButton.addEventListener("click", () => {
        const title = titleInput.value.trim();
        const body = bodyInput.innerText.replace(/\r/g, "").trim();
        const html = typeof window.sanitizeNoteHtml === "function"
            ? window.sanitizeNoteHtml(bodyInput.innerHTML)
            : body;

        if (!title && !body) {
            showToast("Note can't be empty.", "warning");
            return;
        }

        const noteIndex = window.notes.findIndex(item => item.id === note.id);

        if (noteIndex === -1) {
            showToast("Could not find this note. Please refresh and try again.", "warning");
            return;
        }

        const updatedAt = new Date().toISOString();

        recordHistory(note.id);
        const previous = window.notes[noteIndex];
        window.notes[noteIndex] = {
            ...previous,
            title,
            text: body,
            html,
            updatedAt
        };

        // Save locally immediately, then wait for Firestore persistence.
        // This prevents a stale cloud snapshot from replacing the edit.
        saveNotes().then(() => {
            const searchInput = document.getElementById("searchInput");
            const categoryFilter = document.getElementById("categoryFilter");

            renderNotes(
                searchInput ? searchInput.value.trim() : "",
                categoryFilter ? categoryFilter.value : "all"
            );

            if (typeof window.updateNavigationCounts === "function") {
                window.updateNavigationCounts();
            }

            showToast("Note updated successfully", "success");
        });
    });

    titleInput.focus();
}
function viewForNote(note) {
    if (note.deletedAt) return "trash";
    if (note.archived) return "archive";
    return "all";
}

function archiveNote(id) {
    const note = window.notes.find(item => item.id === id);
    if (!note) return;
    recordHistory(id);
    note.archived = true;
    note.updatedAt = new Date().toISOString();
    saveNotes();
    renderNotes();
    updateNavigationCounts();
    showToast("Note archived", "update");
}

function restoreNote(id) {
    const note = window.notes.find(item => item.id === id);
    if (!note) return;
    recordHistory(id);
    note.archived = false;
    note.deletedAt = null;
    note.updatedAt = new Date().toISOString();
    saveNotes();
    renderNotes();
    updateNavigationCounts();
    showToast("Note restored", "success");
}

function deleteNote(id) {
    if (!confirm("Move this note to Trash?")) return;
    const note = window.notes.find(item => item.id === id);
    if (!note) return;
    recordHistory(id);
    note.deletedAt = new Date().toISOString();
    note.archived = false;
    note.updatedAt = note.deletedAt;
    saveNotes();
    renderNotes();
    updateNavigationCounts();
    showToast("Note moved to Trash", "delete");
}

function permanentlyDeleteNote(id) {
    if (!confirm("Delete this note permanently? This cannot be undone.")) return;
    const deleted = window.notes.find(note => note.id === id);
    if (deleted) historyStack.push({ id, snapshot: structuredClone(deleted) });
    window.notes = window.notes.filter(note => note.id !== id);
    saveNotes();
    renderNotes();
    updateNavigationCounts();
    showToast("Note permanently deleted", "delete");
}

function togglePin(id) {
    const note = window.notes.find(item => item.id === id);
    if (!note) return;

    recordHistory(id);
    note.pinned = !note.pinned;
    saveNotes();
    renderNotes();
    showToast(note.pinned ? "Note pinned" : "Note unpinned", note.pinned ? "update" : "warning");
}

function updateNotesCount() {
    const count = Array.isArray(window.notes) ? window.notes.length : 0;
    const countEl = document.getElementById("notesCount");

    if (countEl) {
        countEl.textContent = `${count} ${count === 1 ? "note" : "notes"}`;
    }

    if (typeof window.updateNavigationCounts === "function") {
        window.updateNavigationCounts();
    }
}

function updateEmptyState(filteredCount, totalCount) {
    const emptyState = document.getElementById("emptyState");
    if (!emptyState) return;

    if (totalCount === 0) {
        emptyState.textContent = "No notes yet. Create your first one.";
        emptyState.style.display = "block";
        return;
    }

    if (filteredCount === 0) {
        emptyState.textContent = "No notes match your search or category.";
        emptyState.style.display = "block";
        return;
    }

    emptyState.style.display = "none";
}

function sanitizeNoteHtml(html) {
    const template = document.createElement("div");
    template.innerHTML = html || "";
    template.querySelectorAll("*").forEach(element => {
        const allowed = ["B", "STRONG", "I", "EM", "U", "UL", "OL", "LI", "BR", "A", "DIV", "P"];
        if (!allowed.includes(element.tagName)) {
            element.replaceWith(...Array.from(element.childNodes));
            return;
        }
        Array.from(element.attributes).forEach(attribute => {
            if (element.tagName === "A" && attribute.name === "href") {
                const value = attribute.value.trim();
                if (!/^https?:\/\//i.test(value)) element.removeAttribute("href");
            } else {
                element.removeAttribute(attribute.name);
            }
        });
        if (element.tagName === "A") {
            element.target = "_blank";
            element.rel = "noopener noreferrer";
        }
    });
    return template.innerHTML;
}

function formatCategory(category = "general") {
    return category.charAt(0).toUpperCase() + category.slice(1);
}

function formatDate(dateValue) {
    if (!dateValue) return "No date";

    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return "No date";

    return date.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric"
    });
}

// =========================
// SHARE
// =========================

async function shareNote(note) {
    const text = note.title
        ? `## ${note.title}${note.text ? "\n\n" + note.text : ""}`
        : note.text || "";

    const shareTemplate = document.getElementById("shareTemplate");
    const shareContent = document.getElementById("shareContent");
    const shareTimestamp = document.getElementById("shareTimestamp");

    if (!shareTemplate || !shareContent || !shareTimestamp || typeof html2canvas === "undefined") {
        fallbackShare(text);
        return;
    }

    shareContent.textContent = text;
    shareTimestamp.textContent = note.time || "";

    try {
        showToast("Preparing share image...", "default");

        const canvas = await html2canvas(shareTemplate, {
            backgroundColor: "#ffffff",
            scale: 2,
            logging: false,
            useCORS: true
        });

        canvas.toBlob(async blob => {
            if (!blob) {
                fallbackShare(text);
                return;
            }

            const file = new File([blob], "SnapNote.png", { type: "image/png" });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: "SnapNotes",
                        text
                    });
                    showToast("Note shared", "success");
                } catch (error) {
                    if (error.name !== "AbortError") fallbackShare(text);
                }
            } else {
                fallbackShare(text);
            }
        }, "image/png");
    } catch (error) {
        console.error("Error generating share image:", error);
        fallbackShare(text);
    }
}

function fallbackShare(text) {
    if (navigator.share) {
        navigator.share({ title: "SnapNotes", text })
            .then(() => showToast("Note shared", "success"))
            .catch(() => {});
        return;
    }

    navigator.clipboard.writeText(text)
        .then(() => showToast("Note copied to clipboard", "success"))
        .catch(() => showToast("Could not share note", "warning"));
}

// Compatibility helper for older callers.
// New note creation is handled by the full-page editor.
function addNote() {
    if (typeof window.openNewNoteView === "function") {
        window.openNewNoteView();
    }
}

window.addNote = addNote;
window.renderNotes = renderNotes;
window.shareNote = shareNote;
window.updateEmptyState = updateEmptyState;
window.startNoteEditing = startEditing;
window.updateNotesCount = updateNotesCount;
window.undoLastNoteChange = undoLastNoteChange;
window.redoLastNoteChange = redoLastNoteChange;
