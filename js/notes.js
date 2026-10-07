// =========================
// NOTE LIST + NOTE ACTIONS
// =========================
const MAX_NOTE_CHARACTERS = 1500;
window.SNAPNOTES_MAX_CHARACTERS = MAX_NOTE_CHARACTERS;
const TRASH_RETENTION_DAYS = 15;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
window.SNAPNOTES_TRASH_RETENTION_DAYS = TRASH_RETENTION_DAYS;

function purgeExpiredTrash(now = Date.now()) {
    const notes = Array.isArray(window.notes) ? window.notes : [];
    const remaining = notes.filter(note => {
        if (!note?.deletedAt) return true;
        const deletedAt = Date.parse(note.deletedAt);
        return Number.isNaN(deletedAt) || deletedAt + TRASH_RETENTION_MS > now;
    });

    if (remaining.length === notes.length) return 0;
    const removedCount = notes.length - remaining.length;
    window.notes = remaining;
    saveNotes();
    return removedCount;
}

function renderNotes(filterText = "", filterCategory = "all", view = window.getActiveNotesView ? window.getActiveNotesView() : "all") {
    const notesContainer = document.getElementById("notesContainer");
    if (!notesContainer) return;
    purgeExpiredTrash();

    const notes = Array.isArray(window.notes) ? window.notes : [];
    const rawQuery = filterText.toLowerCase().trim();
    let sortMode = "newest";
    const tokens = rawQuery.split(/\s+/).filter(Boolean);
    const categoryToken = tokens.find(token => token.startsWith("category:"));
    const pinnedToken = tokens.find(token => token === "is:pinned");
    const archivedToken = tokens.find(token => token === "is:archived");
    const trashToken = tokens.find(token => token === "is:trash" || token === "is:trashed");
    const reminderToken = tokens.find(token => token === "has:reminder");
    const tagTokens = tokens.filter(token => token.startsWith("tag:")).map(token => token.slice(4).trim()).filter(Boolean);
    const positiveTerms = [];
    const negativeTerms = [];
    const searchTokens = rawQuery.match(/"[^"]+"|\S+/g) || [];
    searchTokens.forEach(token => {
        if (token.startsWith("-") && token.length > 1) negativeTerms.push(token.slice(1).replace(/^"|"$/g, ""));
        else if (!token.startsWith("category:") && token !== "is:pinned" && token !== "is:archived" && token !== "is:trash" && token !== "is:trashed" && token !== "has:reminder" && !token.startsWith("tag:") && !token.startsWith("sort:")) positiveTerms.push(token.replace(/^"|"$/g, ""));
    });
    const validCategories = ["all", "general", "work", "personal", "ideas", "important"];
    const requestedCategory = categoryToken
        ? categoryToken.replace("category:", "")
        : filterCategory;
    const hasInvalidCategory = !validCategories.includes(requestedCategory);
    if (tokens.includes("sort:oldest")) sortMode = "oldest";
    const searchTerms = positiveTerms;
    const query = searchTerms.join(" ");

    const visibleNotes = notes.filter(note => {
        if (trashToken) return Boolean(note.deletedAt);
        if (archivedToken) return Boolean(note.archived) && !note.deletedAt;
        if (view === "trash") return Boolean(note.deletedAt);
        if (view === "archive") return Boolean(note.archived) && !note.deletedAt && !note.isPrivate;
        if (view === "private") return Boolean(note.isPrivate) && !note.deletedAt && !note.archived;
        return !note.archived && !note.deletedAt && !note.isPrivate;
    });

    const filteredNotes = visibleNotes.filter(note => {
        const searchableNote = window.getReadablePrivateNote?.(note) || note;
        const searchableText = [
            searchableNote.title || "",
            searchableNote.text || "",
            searchableNote.category || "",
            ...(Array.isArray(searchableNote.tags) ? searchableNote.tags : [])
        ].join(" ").toLowerCase();

        const matchesSearch = !query || searchTerms.every(term => searchableText.includes(term.toLowerCase()));
        const matchesExcluded = negativeTerms.every(term => !searchableText.includes(term.toLowerCase()));
        const matchesCategory = requestedCategory === "all" || note.category === requestedCategory;
        const matchesPinned = !pinnedToken || note.pinned;
        const matchesArchived = !archivedToken || Boolean(note.archived);
        const matchesTrash = !trashToken || Boolean(note.deletedAt);
        const matchesReminder = !reminderToken || Boolean(note.reminderAt);
        const matchesTags = !tagTokens.length || tagTokens.every(tag => (note.tags || []).map(value => value.toLowerCase()).includes(tag.toLowerCase()));
        return matchesSearch && matchesExcluded && matchesCategory && matchesPinned && matchesArchived && matchesTrash && matchesReminder && matchesTags;
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

    updateEmptyState(filteredNotes.length, notes.length, hasInvalidCategory ? requestedCategory : "");
    updateNotesCount(filteredNotes.length);
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
    note = window.getReadablePrivateNote?.(note) || note;
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

    const body = document.createElement("div");
    body.className = "note-card-body";
    const bodyText = getNoteBodyText(note);
    if (note.html && typeof window.sanitizeNoteHtml === "function") {
        body.innerHTML = getNoteBodyHtml(note);
    } else {
        body.textContent = bodyText;
    }

    content.appendChild(title);
    content.appendChild(body);

    if (noteHasMoreThanFiveLines(note, bodyText)) {
        body.classList.add("note-card-body-clamped");

        const expandButton = document.createElement("button");
        expandButton.type = "button";
        expandButton.className = "note-preview-toggle";
        expandButton.textContent = "View full note";
        expandButton.setAttribute("aria-expanded", "false");
        expandButton.addEventListener("click", event => {
            event.stopPropagation();
            const expanded = body.classList.toggle("note-card-body-expanded");
            body.classList.toggle("note-card-body-clamped", !expanded);
            expandButton.textContent = expanded ? "Show less" : "View full note";
            expandButton.setAttribute("aria-expanded", String(expanded));
        });
        content.appendChild(expandButton);
    }

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

    const tags = document.createElement("div");
    tags.className = "note-tags";
    (Array.isArray(note.tags) ? note.tags : []).forEach(tag => {
        const chip = document.createElement("span");
        chip.className = "note-tag";
        chip.textContent = "#" + tag;
        tags.appendChild(chip);
    });
    if (tags.childElementCount) content.appendChild(tags);

    if (note.reminderAt) {
        const reminder = document.createElement("div");
        reminder.className = "note-reminder";
        reminder.innerHTML = '<i class="fa-regular fa-bell"></i>';
        reminder.append(document.createTextNode(formatReminder(note.reminderAt)));
        content.appendChild(reminder);
    }

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

    const detailButton = createDropdownItem("Open note", () => openNoteDetail(note.id));
    const duplicateButton = createDropdownItem("Duplicate note", () => duplicateNote(note.id));
    const shareButton = createDropdownItem("Share note", () => shareNote(note));
    const editButton = createDropdownItem("Edit note", () => startEditing(card, note));
    const privateButton = note.isPrivate
        ? createDropdownItem("Move out of private", () => window.moveNoteFromPrivate?.(note.id))
        : createDropdownItem("Move to private", () => window.moveNoteToPrivate?.(note.id));
    const noteView = viewForNote(note);
    if (noteView === "trash") {
        dropdown.append(
            createDropdownItem("Restore note", () => restoreNote(note.id)),
            createDropdownItem("Delete forever", () => permanentlyDeleteNote(note.id), "delete-action")
        );
    } else if (note.isPrivate) {
        const deleteButton = createDropdownItem("Move to trash", () => deleteNote(note.id), "delete-action");
        dropdown.append(detailButton, duplicateButton, shareButton, editButton, privateButton, deleteButton);
    } else {
        const archiveButton = noteView === "archive"
            ? createDropdownItem("Restore note", () => restoreNote(note.id))
            : createDropdownItem("Archive note", () => archiveNote(note.id));
        const deleteButton = createDropdownItem("Move to trash", () => deleteNote(note.id), "delete-action");
        dropdown.append(detailButton, duplicateButton, shareButton, editButton, privateButton, archiveButton, deleteButton);
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

    button.addEventListener("click", async event => {
        event.stopPropagation();
        closeNoteMenus();
        try {
            await action();
        } catch (error) {
            console.error("SnapNotes note action failed:", error);
            window.showToast?.("That action could not be completed. Please try again.", "warning");
        }
    });

    return button;
}

function startEditing(card, note) {
    closeNoteMenus();

    const content = card.querySelector(".note-card-content");
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
    bodyInput.innerHTML = getNoteBodyHtml(note);
    if (!bodyInput.innerHTML.trim()) {
        bodyInput.textContent = getNoteBodyText(note);
    }

    const metadata = document.createElement("div");
    metadata.className = "note-detail-editor";
    const tagsInput = document.createElement("input");
    tagsInput.value = (note.tags || []).join(", ");
    tagsInput.placeholder = "Tags: work, ideas, urgent";
    const reminderInput = document.createElement("input");
    reminderInput.type = "datetime-local";
    reminderInput.value = note.reminderAt ? String(note.reminderAt).slice(0, 16) : "";
    metadata.append(tagsInput, reminderInput);

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

    content.replaceChildren(titleInput, bodyInput, metadata, actions);
    meta.querySelector(".note-card-actions").hidden = true;
    meta.hidden = true;

    cancelButton.addEventListener("click", () => renderNotes());
    saveButton.addEventListener("click", async () => {
        const title = titleInput.value.trim();
        const body = bodyInput.innerText.replace(/\r/g, "").trim();
        const html = typeof window.sanitizeNoteHtml === "function"
            ? window.sanitizeNoteHtml(bodyInput.innerHTML)
            : body;

        if (!title && !body) {
            showToast("Note can't be empty.", "warning");
            return;
        }

        const characterCount = `${title ? `## ${title}\n` : ""}${body}`.length;
        if (characterCount > MAX_NOTE_CHARACTERS) {
            showToast(`Note is too long. Keep it under ${MAX_NOTE_CHARACTERS} characters.`, "warning");
            return;
        }

        const noteIndex = window.notes.findIndex(item => item.id === note.id);

        if (noteIndex === -1) {
            showToast("Could not find this note. Please refresh and try again.", "warning");
            return;
        }

        if (note.isPrivate && typeof window.updatePrivateNote === "function") {
            const updated = await window.updatePrivateNote(note.id, {
                title,
                text: body,
                html,
                tags: typeof window.parseTags === "function" ? window.parseTags(tagsInput.value) : [],
                reminderAt: reminderInput.value ? new Date(reminderInput.value).toISOString() : null,
                reminderNotified: reminderInput.value === (note.reminderAt ? String(note.reminderAt).slice(0, 16) : "")
                    ? Boolean(note.reminderNotified)
                    : false
            });

            if (updated) {
                renderNotes();
                if (typeof window.updateNavigationCounts === "function") {
                    window.updateNavigationCounts();
                }
                showToast("Private note updated successfully", "success");
            }
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
            tags: typeof window.parseTags === "function" ? window.parseTags(tagsInput.value) : [],
            reminderAt: reminderInput.value ? new Date(reminderInput.value).toISOString() : null,
            reminderNotified: reminderInput.value === (note.reminderAt ? String(note.reminderAt).slice(0, 16) : "") ? Boolean(previous.reminderNotified) : false,
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
function formatReminder(value) {
    const time = Date.parse(value);
    if (Number.isNaN(time)) return "Reminder set";
    return "Reminder " + new Date(time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

async function openNoteDetail(id) {
    const rawNote = window.notes.find(item => item.id === id);
    if (!rawNote) return false;

    if (rawNote.isPrivate && !window.isPrivateNotesUnlocked?.()) {
        const unlocked = await window.unlockPrivateNotes?.();
        if (!unlocked) return false;
    }

    const note = window.getReadablePrivateNote?.(rawNote) || rawNote;
    const modal = document.getElementById("noteDetailModal");
    if (!note || !modal) return false;

    const bodyHtml = note.html && typeof window.sanitizeNoteHtml === "function"
        ? getNoteBodyHtml(note)
        : String(note.text || "").replace(/\n/g, "<br>");
    const tags = (note.tags || []).map(tag => `<span class="note-tag">#${escapeHtml(tag)}</span>`).join("");
    modal.innerHTML = `
        <div class="note-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="noteDetailTitle">
            <div class="note-detail-heading">
                <div>
                    <h2 id="noteDetailTitle">${escapeHtml(note.title || "Untitled note")}</h2>
                    <div class="note-detail-meta"><span>${escapeHtml(formatCategory(note.category))}</span><span>${escapeHtml(note.time || formatDate(note.createdAt))}</span></div>
                </div>
                <button type="button" class="icon-button" data-detail-close aria-label="Close note"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="note-tags">${tags}</div>
            ${note.reminderAt ? `<div class="note-reminder"><i class="fa-regular fa-bell"></i>${escapeHtml(formatReminder(note.reminderAt))}</div>` : ""}
            <div class="note-detail-body">${bodyHtml || "<em>No note body.</em>"}</div>
            <div class="note-detail-actions">
                <button type="button" class="secondary-action" data-detail-edit>Edit note</button>
                <button type="button" class="primary-action" data-detail-close>Close</button>
            </div>
        </div>`;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    modal.querySelectorAll("[data-detail-close]").forEach(button => button.addEventListener("click", closeNoteDetail));
    modal.querySelector("[data-detail-edit]").addEventListener("click", () => {
        closeNoteDetail();
        const card = document.querySelector(`.note-card[data-id="${CSS.escape(id)}"]`);
        if (card) startEditing(card, note);
    });

    return true;
}

function closeNoteDetail() {
    const modal = document.getElementById("noteDetailModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = "";
}

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, character => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[character]));
}

window.openNoteDetail = openNoteDetail;
window.closeNoteDetail = closeNoteDetail;

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
    if (localStorage.getItem("SnapNotesConfirmDelete") !== "false" && !confirm("Move this note to Trash?")) return;
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
    if (localStorage.getItem("SnapNotesConfirmDelete") !== "false" && !confirm("Delete this note permanently? This cannot be undone.")) return;
    const deleted = window.notes.find(note => note.id === id);
    if (deleted) historyStack.push({ id, snapshot: structuredClone(deleted) });
    window.notes = window.notes.filter(note => note.id !== id);
    saveNotes();
    renderNotes();
    updateNavigationCounts();
    showToast("Note permanently deleted", "delete");
}

function emptyTrash() {
    const trashCount = (window.notes || []).filter(note => note.deletedAt).length;
    if (!trashCount) {
        showToast("Trash is already empty", "warning");
        return;
    }

    if (!confirm(`Empty Trash and permanently delete ${trashCount} ${trashCount === 1 ? "note" : "notes"}? This cannot be undone.`)) {
        return;
    }

    window.notes = (window.notes || []).filter(note => !note.deletedAt);
    saveNotes();
    renderNotes("", "all", "trash");
    updateNavigationCounts();
    showToast("Trash emptied", "delete");
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

async function duplicateNote(id) {
    const source = window.notes.find(item => item.id === id);
    if (!source) return;

    if (source.isPrivate && typeof window.duplicatePrivateNote === "function") {
        try {
            const duplicated = await window.duplicatePrivateNote(id);
            if (duplicated) {
                renderNotes();
                if (typeof window.updateNavigationCounts === "function") window.updateNavigationCounts();
                showToast("Private note duplicated", "success");
            }
        } catch (error) {
            console.error("Could not duplicate private note:", error);
            showToast("Could not duplicate the private note.", "warning");
        }
        return;
    }

    const now = new Date().toISOString();
    const duplicate = {
        ...structuredClone(source),
        id: crypto.randomUUID(),
        title: source.title ? `Copy of ${source.title}` : "Copy of Untitled note",
        createdAt: now,
        updatedAt: now,
        time: new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        pinned: false,
        archived: false,
        deletedAt: null
    };

    window.notes.unshift(duplicate);
    window.recordNoteCreation?.(duplicate);
    saveNotes().then(() => {
        renderNotes();
        if (typeof window.updateNavigationCounts === "function") window.updateNavigationCounts();
        showToast("Note duplicated", "success");
    });
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

function updateEmptyState(filteredCount, totalCount, invalidCategory = "") {
    const emptyState = document.getElementById("emptyState");
    if (!emptyState) return;

    if (totalCount === 0) {
        emptyState.textContent = "No notes yet. Create your first one.";
        emptyState.style.display = "block";
        return;
    }

    if (filteredCount === 0) {
        emptyState.textContent = invalidCategory
            ? "Unknown category filter: " + invalidCategory
            : "No notes match your search or category.";
        emptyState.style.display = "block";
        return;
    }

    emptyState.style.display = "none";
}

function getNoteBodyHtml(note) {
    if (!note?.html) return "";

    return stripMarkdownTitleFromHtml(note.html, note.title);
}

function stripMarkdownTitleFromHtml(html, title = "") {
    const sanitized = typeof window.sanitizeNoteHtml === "function"
        ? window.sanitizeNoteHtml(html)
        : html || "";
    const template = document.createElement("div");
    template.innerHTML = sanitized;

    const normalizedTitle = title.trim();
    if (!normalizedTitle) return template.innerHTML;

    const headings = [`## ${normalizedTitle}`, `##${normalizedTitle}`]
        .map(value => value.toLowerCase());

    for (const node of [...template.childNodes]) {
        const text = (node.textContent || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (!text) continue;

        const lowerText = text.toLowerCase();
        const exactHeading = headings.some(heading =>
            lowerText === heading || lowerText === `${heading} #`
        );

        if (exactHeading) {
            node.remove();
        } else {
            const headingPrefix = headings.find(heading =>
                lowerText.startsWith(`${heading} `)
            );
            if (headingPrefix) {
                node.textContent = text.slice(headingPrefix.length).trim();
            }
        }
        break;
    }

    return template.innerHTML;
}

window.stripMarkdownTitleFromHtml = stripMarkdownTitleFromHtml;
window.purgeExpiredTrash = purgeExpiredTrash;

function getNoteBodyText(note) {
    let text = typeof note?.text === "string" ? note.text : "";
    if (!text.trim() && note?.html) {
        text = htmlToPlainText(getNoteBodyHtml(note));
    }
    const lines = text.replace(/\r/g, "").split("\n");
    const firstNonEmptyIndex = lines.findIndex(line => line.trim() !== "");
    const title = (note?.title || "").trim();

    if (firstNonEmptyIndex === -1 || !title) return text.trim();

    const firstLine = lines[firstNonEmptyIndex].trim();
    const headingMatch = firstLine.match(/^##\s*(.*?)\s*#*$/);

    if (headingMatch && headingMatch[1].trim() === title) {
        lines.splice(firstNonEmptyIndex, 1);
    }

    return lines.join("\n").trim();
}

function htmlToPlainText(html) {
    const template = document.createElement("div");
    template.innerHTML = html || "";
    const blockTags = new Set(["ADDRESS", "ARTICLE", "DIV", "LI", "P", "PRE", "SECTION"]);
    let output = "";

    const visit = node => {
        if (node.nodeType === Node.TEXT_NODE) {
            output += node.nodeValue;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.tagName === "BR") {
            output += "\n";
            return;
        }
        const isBlock = blockTags.has(node.tagName);
        if (isBlock && output && !output.endsWith("\n")) output += "\n";
        node.childNodes.forEach(visit);
        if (isBlock && !output.endsWith("\n")) output += "\n";
    };

    template.childNodes.forEach(visit);
    return output.replace(/\n{3,}/g, "\n\n").trim();
}

function noteHasMoreThanFiveLines(note, bodyText) {
    if (bodyText.split("\n").length > 5) return true;
    if (!note?.html) return false;
    const template = document.createElement("div");
    template.innerHTML = getNoteBodyHtml(note);
    const blockCount = template.querySelectorAll("br, address, article, div, li, p, pre, section").length;
    return blockCount > 5;
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
    if (note.isPrivate) {
        if (!window.isPrivateNotesUnlocked?.()) {
            showToast("Unlock Private Notes before sharing.", "warning");
            return;
        }

        const confirmed = confirm("This will share a public copy of this private note. The private lock will not protect the shared copy. Continue?");
        if (!confirmed) return;
    }

    const bodyText = getNoteBodyText(note);
    const bodyHtml = note.html && typeof window.sanitizeNoteHtml === "function"
        ? getNoteBodyHtml(note)
        : "";
    const text = note.title
        ? `${note.title}${bodyText ? "\n\n" + bodyText : ""}`
        : bodyText;

    const shareTemplate = document.getElementById("shareTemplate");
    const shareTimestamp = document.getElementById("shareTimestamp");

    if (!shareTemplate || !shareTimestamp || typeof html2canvas === "undefined") {
        fallbackShare(text);
        return;
    }

    const shareTitle = document.getElementById("shareTitle");
    const shareBody = document.getElementById("shareBody");
    shareTitle.textContent = note.title || "Untitled note";
    if (bodyHtml) {
        shareBody.innerHTML = bodyHtml;
    } else {
        shareBody.textContent = bodyText;
    }
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
window.emptyTrash = emptyTrash;
window.updateEmptyState = updateEmptyState;
window.startNoteEditing = startEditing;
window.recordNoteCreation = note => {
    if (!note?.id) return;
    historyStack.push({ id: note.id, action: "create", snapshot: structuredClone(note) });
    redoStack.length = 0;
};
window.updateNotesCount = updateNotesCount;
window.undoLastNoteChange = undoLastNoteChange;
window.redoLastNoteChange = redoLastNoteChange;
