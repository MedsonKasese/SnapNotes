// =========================
// NOTE LIST + NOTE ACTIONS
// =========================

function renderNotes(filterText = "", filterCategory = "all") {
    const notesContainer = document.getElementById("notesContainer");
    if (!notesContainer) return;

    const notes = Array.isArray(window.notes) ? window.notes : [];
    const query = filterText.toLowerCase();

    const filteredNotes = notes.filter(note => {
        const searchableText = [
            note.title || "",
            note.text || "",
            note.category || ""
        ].join(" ").toLowerCase();

        const matchesSearch = searchableText.includes(query);
        const matchesCategory =
            filterCategory === "all" || note.category === filterCategory;

        return matchesSearch && matchesCategory;
    });

    filteredNotes.sort((a, b) => {
        if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

    notesContainer.innerHTML = "";

    filteredNotes.forEach(note => {
        notesContainer.appendChild(createNoteElement(note));
    });

    updateEmptyState(filteredNotes.length, notes.length);
    updateNotesCount();
}

function createNoteElement(note) {
    const card = document.createElement("article");
    card.className = "note-card";
    card.dataset.id = note.id;
    card.dataset.category = note.category || "general";

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

    const body = document.createElement("p");
    body.className = "note-card-body";
    body.textContent = note.text || "";

    content.appendChild(title);
    content.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "note-card-actions";

    const pinButton = document.createElement("button");
    pinButton.className = "note-action pin" + (note.pinned ? " active" : "");
    pinButton.type = "button";
    pinButton.setAttribute("aria-label", note.pinned ? "Unpin note" : "Pin note");
    pinButton.innerHTML = `<i class="fa-solid fa-thumbtack"></i>`;
    pinButton.addEventListener("click", () => togglePin(note.id));

    const menuWrapper = document.createElement("div");
    menuWrapper.className = "note-menu";

    const menuButton = document.createElement("button");
    menuButton.className = "note-action";
    menuButton.type = "button";
    menuButton.setAttribute("aria-label", "Note actions");
    menuButton.innerHTML = `<i class="fa-solid fa-ellipsis"></i>`;

    const dropdown = document.createElement("div");
    dropdown.className = "note-dropdown";

    const shareButton = createDropdownItem(
        "Share note",
        () => shareNote(note)
    );

    const editButton = createDropdownItem(
        "Edit note",
        () => startEditing(card, note)
    );

    const deleteButton = createDropdownItem(
        "Delete note",
        () => deleteNote(note.id),
        "delete-action"
    );

    dropdown.append(shareButton, editButton, deleteButton);

    menuButton.addEventListener("click", event => {
        event.stopPropagation();
        closeNoteMenus();
        dropdown.classList.toggle("show");
    });

    menuWrapper.append(menuButton, dropdown);
    actions.append(pinButton, menuWrapper);
    top.append(content, actions);

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
    meta.appendChild(metaLeft);

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

    const bodyInput = document.createElement("textarea");
    bodyInput.className = "edit-note-area";
    bodyInput.value = note.text || "";
    bodyInput.placeholder = "Your note...";
    bodyInput.rows = 5;

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
        const body = bodyInput.value.trim();

        if (!title && !body) {
            showToast("Note can't be empty.", "warning");
            return;
        }

        note.title = title;
        note.text = body;
        note.updatedAt = new Date().toISOString();

        saveNotes();
        renderNotes();
        showToast("Note updated", "update");
    });

    titleInput.focus();
}

function deleteNote(id) {
    if (!confirm("Are you sure you want to delete this note?")) return;

    window.notes = window.notes.filter(note => note.id !== id);
    saveNotes();
    renderNotes();
    updateNavigationCounts();
    showToast("Note deleted", "delete");
}

function togglePin(id) {
    const note = window.notes.find(item => item.id === id);
    if (!note) return;

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
window.updateNotesCount = updateNotesCount;
