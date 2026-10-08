// =========================
// SNAPNOTES APP CONTROLLER
// =========================

const CATEGORIES = {
    general: "General",
    work: "Work",
    personal: "Personal",
    ideas: "Ideas",
    important: "Important"
};

let activeCategory = "all";
let activeView = "all";
let activeFolderId = null;
window.activeFolderId = null;
let selectedEditorCategory = "general";
let clockTimer = null;
let draftTimer = null;
const DRAFT_KEY = "SnapNotesDraft";
let pendingNotificationNoteId = null;

document.addEventListener("DOMContentLoaded", () => {
    handleNotificationNoteFromUrl();
    loadNotes();
    window.loadFolders?.();
    setupEventListeners();
    restoreDraft();
    setupTheme();
    setupTimestamp();
    setupReminderChecks();
    setupNotificationNoteHandling();
    openNewNoteView();
    handlePendingNotificationNote();
    updateNavigationCounts();
});

function setupNotificationNoteHandling() {
    navigator.serviceWorker?.addEventListener("message", event => {
        if (event.data?.type !== "SNAPNOTES_OPEN_NOTE" || !event.data.noteId) return;
        pendingNotificationNoteId = event.data.noteId;
        handlePendingNotificationNote();
    });
}

window.handlePendingNotificationNote = handlePendingNotificationNote;

async function handlePendingNotificationNote() {
    if (!pendingNotificationNoteId) return;

    const noteId = pendingNotificationNoteId;
    const note = Array.isArray(window.notes)
        ? window.notes.find(item => item.id === noteId)
        : null;

    if (!note) return;

    pendingNotificationNoteId = null;
    await window.openNoteDetail?.(noteId);
}

function handleNotificationNoteFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const noteId = params.get("openNote");
    if (!noteId) return;

    pendingNotificationNoteId = noteId;

    const url = new URL(window.location.href);
    url.searchParams.delete("openNote");
    window.history.replaceState({}, document.title, url.toString());
}

function setupEventListeners() {
    const searchInput = document.getElementById("searchInput");
    const categoryFilter = document.getElementById("categoryFilter");
    const reminderInput = document.getElementById("noteReminderInput");
    const reminderRecurrence = document.getElementById("noteReminderRecurrence");
    const reminderPickerBtn = document.getElementById("reminderPickerBtn");
    const settingsBtn = document.getElementById("settingsBtn");
    const settingsModal = document.getElementById("settingsModal");
    const closeSettingsBtn = document.getElementById("closeSettingsBtn");
    const signOutSettingsBtn = document.getElementById("signOutSettingsBtn");
    const deleteAccountBtn = document.getElementById("deleteAccountBtn");
    const cancelAccountDeletionBtn = document.getElementById("cancelAccountDeletionBtn");
    const settingsTheme = document.getElementById("settingsTheme");
    const settingsThemeToggle = document.getElementById("settingsThemeToggle");
    const privacyPolicyBtn = document.getElementById("privacyPolicyBtn");
    const feedbackBtn = document.getElementById("feedbackBtn");
    const confirmDeleteSetting = document.getElementById("confirmDeleteSetting");
    const settingsAccount = document.getElementById("settingsAccount");
    const openSearch = document.getElementById("openSearch");
    const closeSearch = document.getElementById("closeSearch");
    const menuToggle = document.getElementById("menuToggle");
    const closeMenu = document.getElementById("closeMenu");
    const drawerBackdrop = document.getElementById("drawerBackdrop");
    const saveNoteBtn = document.getElementById("saveNoteBtn");
    const addBtn = document.getElementById("addBtn");
    const newNoteBtn = document.getElementById("newNoteBtn");
    const emptyTrashBtn = document.getElementById("emptyTrashBtn");
    const logoButton = document.getElementById("logoButton");
    const editorCategory = document.getElementById("editorCategory");
    const drawerNav = document.getElementById("drawerNav");
    const categoryMenu = document.getElementById("categoryMenu");
    const exportNotesBtn = document.getElementById("exportNotesBtn");
    const importNotesBtn = document.getElementById("importNotesBtn");
    const attachmentInput = document.getElementById("attachmentInput");
    const addAttachmentBtn = document.getElementById("addAttachmentBtn");
    const createFolderBtn = document.getElementById("createFolderBtn");
    const importNotesInput = document.getElementById("importNotesInput");
    const formatToolbar = document.getElementById("formatToolbar");

    searchInput.addEventListener("input", applyNoteFilters);
    categoryFilter.addEventListener("change", () => {
        activeCategory = categoryFilter.value;
        applyNoteFilters();
    });

    searchInput.addEventListener("focus", () => {
        document.getElementById("searchPanel").classList.add("is-focused");
    });

    openSearch.addEventListener("click", openSearchPanel);
    closeSearch.addEventListener("click", closeSearchPanel);

    settingsBtn.addEventListener("click", openSettings);
    closeSettingsBtn.addEventListener("click", closeSettings);
    signOutSettingsBtn.addEventListener("click", () => document.getElementById("userAvatar").click());
    deleteAccountBtn.addEventListener("click", requestAccountDeletion);
    cancelAccountDeletionBtn.addEventListener("click", cancelScheduledAccountDeletion);
    function syncThemeControl() {
        const isDark = document.body.classList.contains("dark-mode");
        settingsTheme.value = isDark ? "dark" : "light";
        settingsThemeToggle.setAttribute("aria-checked", String(isDark));
        settingsThemeToggle.classList.toggle("active", isDark);
        document.getElementById("themeStatusLabel").textContent = "Dark Mode";
        document.getElementById("themeStatusText").textContent = isDark
            ? "Enabled"
            : "Disabled";
    }

    settingsThemeToggle.addEventListener("click", () => {
        const nextTheme = document.body.classList.contains("dark-mode") ? "light" : "dark";
        applyTheme(nextTheme);
        localStorage.setItem("theme", nextTheme);
        syncThemeControl();
    });
    privacyPolicyBtn.addEventListener("click", () => {
        alert("SnapNotes stores your notes locally on your device and, when you sign in, syncs your notes with Firebase so you can access them across supported devices. Your account information is handled by Firebase Authentication. We do not sell your personal information. A dedicated privacy policy will be added later with full details.");
    });

    feedbackBtn.addEventListener("click", () => {
        window.location.href = "mailto:medsonkasese@yahoo.com?subject=SnapNotes%20Feedback";
    });

    confirmDeleteSetting.addEventListener("change", () => {
        localStorage.setItem("SnapNotesConfirmDelete", String(confirmDeleteSetting.checked));
    });

    menuToggle.addEventListener("click", openDrawer);
    closeMenu.addEventListener("click", closeDrawer);
    drawerBackdrop.addEventListener("click", closeDrawer);

    drawerNav.addEventListener("click", (event) => {
        const item = event.target.closest("[data-category], [data-view]");
        if (!item) return;
        if (item.dataset.view) selectView(item.dataset.view);
        else selectCategory(item.dataset.category);
        closeDrawer();
    });

    saveNoteBtn.addEventListener("click", saveEditorNote);
    addBtn.addEventListener("click", openNewNoteView);
    newNoteBtn.addEventListener("click", openNewNoteView);
    emptyTrashBtn.addEventListener("click", () => window.emptyTrash?.());

    exportNotesBtn.addEventListener("click", exportNotes);
    importNotesBtn.addEventListener("click", () => importNotesInput.click());
    importNotesInput.addEventListener("change", importNotes);
    createFolderBtn?.addEventListener("click", () => window.createFolder?.());
    addAttachmentBtn?.addEventListener("click", () => attachmentInput?.click());
    attachmentInput?.addEventListener("change", event => {
        window.addPendingAttachments?.(event.target.files);
        event.target.value = "";
    });

    const syncReminderRecurrenceControl = () => {
        if (!reminderInput || !reminderRecurrence) return;
        const hasReminder = Boolean(reminderInput.value);
        reminderRecurrence.disabled = !hasReminder;
        if (!hasReminder) reminderRecurrence.value = "";
    };

    reminderInput?.addEventListener("input", syncReminderRecurrenceControl);
    reminderInput?.addEventListener("change", syncReminderRecurrenceControl);
    reminderPickerBtn?.addEventListener("click", () => {
        try {
            if (typeof reminderInput?.showPicker === "function") {
                reminderInput.showPicker();
                return;
            }
        } catch (error) {
            console.debug("Native reminder picker is unavailable:", error);
        }
        reminderInput?.focus();
        reminderInput?.click();
    });
    syncReminderRecurrenceControl();

    logoButton.addEventListener("click", openNewNoteView);

    editorCategory.addEventListener("click", toggleCategoryMenu);

    formatToolbar.addEventListener("mousedown", event => event.preventDefault());
    formatToolbar.addEventListener("click", event => {
        const button = event.target.closest("[data-format]");
        if (!button) return;
        document.execCommand(button.dataset.format, false);
        document.getElementById("noteEditor").focus();
        scheduleDraftSave();
    });

    document.getElementById("insertChecklist").addEventListener("click", () => {
        document.execCommand("insertText", false, "☐ ");
        document.getElementById("noteEditor").focus();
        scheduleDraftSave();
    });

    document.getElementById("insertLink").addEventListener("click", () => {
        const url = prompt("Enter a URL:");
        if (!url) return;
        document.execCommand("createLink", false, url);
        document.getElementById("noteEditor").focus();
        scheduleDraftSave();
    });

    categoryMenu.addEventListener("click", (event) => {
        const item = event.target.closest("[data-category]");
        if (!item) return;
        setEditorCategory(item.dataset.category);
    });

    document.addEventListener("click", (event) => {
        if (!event.target.closest("#categoryMenu") && !event.target.closest("#editorCategory")) {
            closeCategoryMenu();
        }

        if (!event.target.closest(".note-menu")) {
            closeNoteMenus();
        }
    });

    document.addEventListener("keydown", (event) => {
        const activeElement = document.activeElement;
        const isTyping = activeElement?.matches("input, textarea, select, [contenteditable=\"true\"]");
        const modifier = event.ctrlKey || event.metaKey;

        if (modifier && event.key.toLowerCase() === "k" && !isTyping) {
            event.preventDefault();
            openSearchPanel();
            document.getElementById("searchInput")?.focus();
            return;
        }

        if (modifier && event.key.toLowerCase() === "n" && !isTyping) {
            event.preventDefault();
            openNewNoteView();
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            if (event.shiftKey) window.redoLastNoteChange?.();
            else window.undoLastNoteChange?.();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
            event.preventDefault();
            window.redoLastNoteChange?.();
            return;
        }
        if (event.key === "Escape") {
            closeNoteDetail?.();
            closeDrawer();
            closeCategoryMenu();
            closeNoteMenus();
        }
    });

    window.addEventListener("snapnotes:sync-status", event => {
        if (event.detail?.status === "pending") {
            setDraftStatus("Saved locally • Cloud sync pending");
        } else if (event.detail?.status === "synced") {
            setDraftStatus("Saved and synced");
        }
    });

    document.getElementById("noteEditor").addEventListener("input", () => {
        updateCharacterCount();
        scheduleDraftSave();
    });

    document.getElementById("noteEditor").addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            saveEditorNote();
        }
    });
}

function openNewNoteView() {
    window.clearPrivateUnlock?.();
    activeView = "all";
    document.getElementById("newNoteView").hidden = false;
    document.getElementById("notesView").hidden = true;
    document.getElementById("addBtn").hidden = true;
    window.resetPendingAttachments?.();
    updateCharacterCount();
    document.getElementById("noteEditor").focus();
    closeSearchPanel();
    closeDrawer();
}

function openNotesView(category = activeCategory) {
    window.clearPrivateUnlock?.();
    activeView = "all";
    activeFolderId = null;
    window.activeFolderId = null;
    activeCategory = category;
    document.getElementById("categoryFilter").value = category;
    document.getElementById("newNoteView").hidden = true;
    document.getElementById("notesView").hidden = false;
    document.getElementById("addBtn").hidden = false;
    document.getElementById("emptyTrashBtn").hidden = true;

    const title = category === "all" ? "All notes" : CATEGORIES[category];
    document.getElementById("notesViewTitle").textContent = title;
    document.getElementById("notesViewEyebrow").textContent = category === "all" ? "Your notes" : "Category";
    window.updateFolderActiveState?.();

    applyNoteFilters();
}

async function selectView(view) {
    if (view === "private") {
        const unlocked = window.isPrivateNotesUnlocked?.() || await window.unlockPrivateNotes?.();
        if (!unlocked) return;
    } else if (activeView === "private") {
        window.clearPrivateUnlock?.();
    }

    activeView = view;
    activeFolderId = null;
    window.activeFolderId = null;
    document.querySelectorAll(".drawer-item").forEach(item => {
        item.classList.toggle("active", item.dataset.view === view);
    });
    document.getElementById("categoryFilter").value = "all";
    document.getElementById("newNoteView").hidden = true;
    document.getElementById("notesView").hidden = false;
    document.getElementById("addBtn").hidden = view !== "all";
    document.getElementById("emptyTrashBtn").hidden = view !== "trash";

    const titles = {
        archive: "Archived",
        private: "Private Notes",
        trash: "Trash"
    };
    window.updateFolderActiveState?.();
    document.getElementById("notesViewTitle").textContent = titles[view] || "Notes";
    document.getElementById("notesViewEyebrow").textContent = view === "private" ? "Private library" : "Library";
    applyNoteFilters();
}

function selectCategory(category) {
    activeFolderId = null;
    window.activeFolderId = null;
    activeCategory = category;
    document.getElementById("categoryFilter").value = category;
    document.querySelectorAll(".drawer-item").forEach(item => {
        item.classList.toggle("active", item.dataset.category === category);
    });
    openNotesView(category);
}



function openFolderView(folderId) {
    const folder = window.getFolderById?.(folderId);
    if (!folder) return;

    if (activeView === "private") {
        window.clearPrivateUnlock?.();
    }

    activeFolderId = folderId;
    window.activeFolderId = folderId;
    activeView = "all";
    activeCategory = "all";

    document.getElementById("categoryFilter").value = "all";
    document.getElementById("newNoteView").hidden = true;
    document.getElementById("notesView").hidden = false;
    document.getElementById("addBtn").hidden = false;
    document.getElementById("emptyTrashBtn").hidden = true;
    document.getElementById("notesViewTitle").textContent = folder.name;
    document.getElementById("notesViewEyebrow").textContent = "Folder";

    document.querySelectorAll(".drawer-item").forEach(item => {
        item.classList.toggle("active", item.dataset.folderId === folderId);
    });
    window.updateFolderActiveState?.();
    applyNoteFilters();
    closeDrawer();
}

window.openFolderView = openFolderView;
window.activeFolderId = activeFolderId;

function applyNoteFilters() {
    const searchInput = document.getElementById("searchInput");
    const categoryFilter = document.getElementById("categoryFilter");

    activeCategory = categoryFilter.value;
    renderNotes(searchInput.value.trim(), activeCategory, activeView, activeFolderId);
    updateNavigationCounts();
}

function openSearchPanel() {
    const panel = document.getElementById("searchPanel");
    panel.hidden = false;
    panel.classList.add("is-focused");
    const input = document.getElementById("searchInput");
    input.focus();
}

function closeSearchPanel() {
    const panel = document.getElementById("searchPanel");
    const input = document.getElementById("searchInput");

    input.value = "";
    document.getElementById("categoryFilter").value = activeCategory;
    panel.classList.remove("is-focused");
    panel.hidden = true;
    renderNotes("", activeCategory, activeView);
}

function openDrawer() {
    const drawer = document.getElementById("notesDrawer");
    const backdrop = document.getElementById("drawerBackdrop");

    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.getElementById("menuToggle").setAttribute("aria-expanded", "true");
    backdrop.hidden = false;
}

function closeDrawer() {
    const drawer = document.getElementById("notesDrawer");
    const backdrop = document.getElementById("drawerBackdrop");

    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    document.getElementById("menuToggle").setAttribute("aria-expanded", "false");
    backdrop.hidden = true;
}

function toggleCategoryMenu() {
    const menu = document.getElementById("categoryMenu");
    if (!menu.hidden) {
        closeCategoryMenu();
        return;
    }

    const button = document.getElementById("editorCategory");
    const rect = button.getBoundingClientRect();

    menu.style.left = Math.min(rect.left, window.innerWidth - 190) + "px";
    menu.style.top = Math.min(rect.bottom + 6, window.innerHeight - 220) + "px";
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
}

function closeCategoryMenu() {
    const menu = document.getElementById("categoryMenu");
    const button = document.getElementById("editorCategory");
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
}

function setEditorCategory(category) {
    if (!CATEGORIES[category]) return;

    selectedEditorCategory = category;
    document.getElementById("selectedCategoryLabel").textContent = CATEGORIES[category];

    const dot = document.querySelector("#editorCategory .category-dot");
    dot.className = "category-dot " + category;

    closeCategoryMenu();
}


function scheduleDraftSave() {
    clearTimeout(draftTimer);
    setDraftStatus("Saving draft...");
    draftTimer = setTimeout(saveDraft, 500);
}

function saveDraft() {
    const editor = document.getElementById("noteEditor");
    const content = editor?.innerHTML?.trim() || "";
    const text = editor?.innerText?.trim() || "";

    if (!text) {
        localStorage.removeItem(DRAFT_KEY);
        setDraftStatus("Drafts save automatically");
        return;
    }

    localStorage.setItem(DRAFT_KEY, JSON.stringify({
        content,
        category: selectedEditorCategory,
        tags: parseTags(document.getElementById("noteTagsInput")?.value || ""),
        reminderAt: document.getElementById("noteReminderInput")?.value || "",
        reminderRecurrence: window.normalizeReminderRecurrence?.(document.getElementById("noteReminderRecurrence")?.value || "") || null,
        savedAt: new Date().toISOString()
    }));
    setDraftStatus("Draft saved");
}

function restoreDraft() {
    const editor = document.getElementById("noteEditor");
    if (!editor) return;
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;

    try {
        const draft = JSON.parse(raw);
        if (!draft.content) return;
        editor.innerHTML = draft.content;
        setEditorCategory(draft.category || "general");
        const tagsInput = document.getElementById("noteTagsInput");
        const reminderInput = document.getElementById("noteReminderInput");
        const reminderRecurrence = document.getElementById("noteReminderRecurrence");
        if (tagsInput) tagsInput.value = Array.isArray(draft.tags) ? draft.tags.join(", ") : "";
        if (reminderInput) reminderInput.value = draft.reminderAt ? String(draft.reminderAt).slice(0, 16) : "";
        if (reminderRecurrence) {
            reminderRecurrence.value = draft.reminderRecurrence?.frequency || "";
            reminderRecurrence.disabled = !reminderInput?.value;
        }
        updateCharacterCount();
        setDraftStatus("Draft restored");
    } catch (error) {
        localStorage.removeItem(DRAFT_KEY);
        console.error("Failed to restore SnapNotes draft:", error);
    }
}

function clearDraft() {
    clearTimeout(draftTimer);
    localStorage.removeItem(DRAFT_KEY);
    updateCharacterCount();
    setDraftStatus("Drafts save automatically");
}

function setDraftStatus(message) {
    const status = document.getElementById("draftStatus");
    if (status) status.querySelector("span").textContent = message;
}

function updateCharacterCount() {
    const editor = document.getElementById("noteEditor");
    const counter = document.getElementById("editorCharacterCount");
    if (!editor || !counter) return;

    const count = (editor.innerText || "").replace(/\r/g, "").trim().length;
    const limit = window.SNAPNOTES_MAX_CHARACTERS || 1500;
    counter.textContent = `${count}/${limit}`;
    counter.classList.toggle("over-limit", count > limit);
}

async function saveEditorNote() {
    const editor = document.getElementById("noteEditor");
    const saveButton = document.getElementById("saveNoteBtn");
    if (saveButton?.disabled) return;
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.setAttribute("aria-busy", "true");
    }

    try {
        const rawText = editor.innerText.replace(/\r/g, "").trim();
        const maxCharacters = window.SNAPNOTES_MAX_CHARACTERS || 1500;

    if (!rawText) {
        showToast("Write something before saving.", "warning");
        editor.focus();
        return;
    }

    if (rawText.length > maxCharacters) {
        showToast(`Note is too long. Keep it under ${maxCharacters} characters.`, "warning");
        editor.focus();
        return;
    }

    const lines = rawText.split("\n");
    const firstLineIndex = lines.findIndex(line => line.trim() !== "");
    const firstLine = firstLineIndex >= 0 ? lines[firstLineIndex].trim() : "";

    let title = "";
    let body = rawText;

    if (firstLine.startsWith("##")) {
        title = firstLine.replace(/^##\s*/, "").trim();

        const bodyLines = lines.slice(firstLineIndex + 1);
        body = bodyLines.join("\n").trim();
    }

    if (!title && !body) {
        showToast("Your note is empty.", "warning");
        return;
    }

    const now = new Date();
    const formattedDate = now.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric"
    });
    const formattedTime = now.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
    });

    const newNote = {
        id: crypto.randomUUID(),
        title,
        text: body,
        html: extractNoteBodyHtml(editor.innerHTML, title),
        category: selectedEditorCategory,
        tags: parseTags(document.getElementById("noteTagsInput")?.value || ""),
        reminderAt: window.parseReminderDateTimeLocal?.(document.getElementById("noteReminderInput")?.value) || null,
        reminderRecurrence: document.getElementById("noteReminderInput")?.value
            ? window.normalizeReminderRecurrence?.(
                document.getElementById("noteReminderRecurrence")?.value || "",
                document.getElementById("noteReminderInput").value
            )
            : null,
        reminderNotified: false,
        folderId: window.activeFolderId || null,
        versions: [],
        attachments: [],
        pinned: false,
        time: `Created: ${formattedDate} • ${formattedTime}`,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
    };

    try {
        newNote.attachments = await window.prepareNoteAttachments?.(
            newNote.id,
            window.getPendingAttachments?.() || []
        ) || [];
    } catch (error) {
        showToast(error.message || "Could not add the attachments.", "warning");
        return;
    }

    window.notes.unshift(newNote);
    if (newNote.reminderAt) {
        await requestReminderPermission();
    }
    window.recordNoteCreation?.(newNote);
    const saveResult = await saveNotes();

    clearDraft();
    editor.innerHTML = "";
    window.resetPendingAttachments?.();
    const tagsInput = document.getElementById("noteTagsInput");
    const reminderInput = document.getElementById("noteReminderInput");
    const reminderRecurrence = document.getElementById("noteReminderRecurrence");
    if (tagsInput) tagsInput.value = "";
    if (reminderInput) reminderInput.value = "";
    if (reminderRecurrence) {
        reminderRecurrence.value = "";
        reminderRecurrence.disabled = true;
    }
    renderNotes("", activeCategory);
    updateNavigationCounts();
    window.renderFolderNavigation?.();
    window.scheduleNextReminderCheck?.();
    openNotesView("all");

        if (saveResult.cloudEnabled && !saveResult.synced) {
            showToast("Note saved locally. Cloud sync pending.", "warning");
        } else if (saveResult.cloudEnabled) {
            showToast("Note saved and synced", "success");
        } else {
            showToast("Note saved", "success");
        }
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.removeAttribute("aria-busy");
        }
    }
}

function extractNoteBodyHtml(html, title) {
    return window.stripMarkdownTitleFromHtml(html, title);
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
                try {
                    const parsedUrl = new URL(value, window.location.href);
                    if (!["http:", "https:"].includes(parsedUrl.protocol)) element.removeAttribute("href");
                } catch {
                    element.removeAttribute("href");
                }
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

window.sanitizeNoteHtml = sanitizeNoteHtml;


function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportNotes() {
    const notes = Array.isArray(window.notes) ? window.notes : [];
    if (!notes.length) {
        showToast("There are no notes to export.", "warning");
        return;
    }

    const format = prompt("Export format: JSON, Markdown, or TXT", "JSON");
    if (!format) return;

    const choice = format.trim().toLowerCase();

    if (choice === "json") {
        downloadFile(
            `snapnotes-export-${new Date().toISOString().slice(0, 10)}.json`,
            JSON.stringify({
                app: "SnapNotes",
                version: 1,
                exportedAt: new Date().toISOString(),
                notes,
                folders: Array.isArray(window.getFolders?.()) ? window.getFolders() : []
            }, null, 2),
            "application/json"
        );
    } else if (choice === "markdown" || choice === "md") {
        const markdown = notes.map(note => {
            const title = note.title ? `# ${note.title}` : "# Untitled note";
            return `${title}\n\n${note.text || ""}\n\n---`;
        }).join("\n\n");
        downloadFile("snapnotes-export.md", markdown, "text/markdown");
    } else if (choice === "txt" || choice === "text") {
        const text = notes.map(note => {
            const title = note.title || "Untitled note";
            return `${title}\n${note.text || ""}`;
        }).join("\n\n====================\n\n");
        downloadFile("snapnotes-export.txt", text, "text/plain");
    } else {
        showToast("Choose JSON, Markdown, or TXT.", "warning");
        return;
    }

    showToast("Notes exported", "success");
}

async function importNotes(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const imported = Array.isArray(parsed) ? parsed : parsed.notes;
        const importedFolders = Array.isArray(parsed?.folders) ? parsed.folders : [];

        if (!Array.isArray(imported)) {
            throw new Error("Invalid SnapNotes export.");
        }

        const existingIds = new Set((window.notes || []).map(note => note.id));
        if (importedFolders.length && typeof window.getFolders === "function") {
            const existingFolderIds = new Set((window.getFolders() || []).map(folder => folder.id));
            importedFolders.slice(0, 20).forEach(folder => {
                if (!folder?.id || existingFolderIds.has(folder.id)) return;
                const name = String(folder.name || "").trim().replace(/\s+/g, " ").slice(0, 32);
                if (!name) return;
                window.getFolders().push({
                    id: String(folder.id),
                    name,
                    createdAt: folder.createdAt || new Date().toISOString(),
                    updatedAt: folder.updatedAt || folder.createdAt || new Date().toISOString()
                });
            });
            localStorage.setItem("SnapNotesFolders", JSON.stringify(window.getFolders().slice(0, 20)));
            window.renderFolderNavigation?.();
        }
        const normalized = imported
            .filter(note => note && typeof note === "object")
            .map(note => ({
                id: existingIds.has(note.id) ? crypto.randomUUID() : (note.id || crypto.randomUUID()),
                title: String(note.title || ""),
                text: String(note.text || ""),
                html: typeof note.html === "string" ? note.html : "",
                category: CATEGORIES[note.category] ? note.category : "general",
                pinned: Boolean(note.pinned),
                tags: typeof window.parseTags === "function" ? window.parseTags(Array.isArray(note.tags) ? note.tags.join(",") : String(note.tags || "")) : [],
                reminderAt: note.reminderAt || null,
                reminderRecurrence: window.normalizeReminderRecurrence?.(note.reminderRecurrence, note.reminderAt) || null,
                reminderNotified: Boolean(note.reminderNotified),
                archived: Boolean(note.archived),
                deletedAt: note.deletedAt || null,
                isPrivate: Boolean(note.isPrivate && note.privateData),
                privateData: note.isPrivate && note.privateData && typeof note.privateData === "object"
                    ? note.privateData
                    : null,
                attachments: Array.isArray(note.attachments)
                    ? note.attachments.map(attachment => ({
                        id: String(attachment.id || crypto.randomUUID()),
                        name: String(attachment.name || "Attachment"),
                        type: String(attachment.type || "application/octet-stream"),
                        size: Number(attachment.size) || 0,
                        createdAt: attachment.createdAt || new Date().toISOString(),
                        storagePath: attachment.storagePath || null,
                        downloadUrl: attachment.downloadUrl || null
                    })).slice(0, window.MAX_ATTACHMENTS_PER_NOTE || 5)
                    : [],
                time: String(note.time || ""),
                createdAt: note.createdAt || new Date().toISOString(),
                updatedAt: note.updatedAt || note.createdAt || new Date().toISOString()
            }));

        if (!normalized.length) {
            showToast("No valid notes found in that file.", "warning");
            return;
        }

        window.notes = [...normalized, ...(window.notes || [])];
        localStorage.setItem("SnapNotes", JSON.stringify(window.notes));
        await saveNotes();
        renderNotes();
        updateNavigationCounts();
        showToast(`${normalized.length} notes imported`, "success");
    } catch (error) {
        console.error("Import failed:", error);
        showToast("Could not import that file. Use a SnapNotes JSON export.", "warning");
    }
}

function parseTags(value) {
    return [...new Set(String(value || "").split(",").map(tag => tag.trim().toLowerCase().replace(/^#/, "")).filter(Boolean))].slice(0, 10);
}

function setupReminderChecks() {
    clearInterval(window.snapNotesReminderTimer);
    clearTimeout(window.snapNotesReminderTimeout);
    window.snapNotesReminderTimer = setInterval(checkDueReminders, 30000);
    checkDueReminders();
}

function scheduleNextReminderCheck() {
    clearTimeout(window.snapNotesReminderTimeout);
    const nextDue = (Array.isArray(window.notes) ? window.notes : [])
        .filter(note => note.reminderAt && !note.reminderNotified && !note.deletedAt)
        .map(note => Date.parse(note.reminderAt))
        .filter(time => Number.isFinite(time) && time > Date.now())
        .sort((a, b) => a - b)[0];

    if (!nextDue) return;
    window.snapNotesReminderTimeout = setTimeout(checkDueReminders, Math.max(1000, nextDue - Date.now() + 50));
}

async function checkDueReminders() {
    const notes = Array.isArray(window.notes) ? window.notes : [];
    const now = Date.now();
    let changed = false;

    for (const note of notes) {
        if (!note.reminderAt || note.reminderNotified || note.deletedAt) continue;

        const due = Date.parse(note.reminderAt);
        if (Number.isNaN(due) || due > now) continue;

        const recurrence = window.normalizeReminderRecurrence?.(note.reminderRecurrence);

        if ("Notification" in window && Notification.permission === "granted") {
            const shown = await showReminderNotification(note);
            if (!shown) {
                showToast(`Reminder: ${note.title || "Untitled note"}`, "update");
            }
        } else {
            showToast(`Reminder: ${note.title || "Untitled note"}`, "update");
        }

        if (recurrence && window.getNextReminderAt) {
            note.reminderAt = window.getNextReminderAt(note.reminderAt, recurrence, now);
            note.reminderNotified = false;
        } else {
            note.reminderNotified = true;
        }

        changed = true;
    }

    if (changed) {
        await saveNotes();
        renderNotes();
    }
    scheduleNextReminderCheck();
}

async function showReminderNotification(note) {
    try {
        const registration = await navigator.serviceWorker?.ready;
        if (registration?.showNotification) {
            await registration.showNotification(note.title || "SnapNotes reminder", {
                body: note.text || "You set a reminder for this note.",
                icon: "./assets/icons/snapnotes-notification.png",
                badge: "./assets/icons/snapnotes-notification-badge.svg",
                tag: `snapnotes-reminder-${note.id}`,
                renotify: true,
                data: { noteId: note.id }
            });
            return true;
        }
    } catch (error) {
        console.warn("SnapNotes could not show a service-worker notification:", error);
    }
    return false;
}

async function requestReminderPermission() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
}

window.parseTags = parseTags;
window.requestReminderPermission = requestReminderPermission;
window.checkDueReminders = checkDueReminders;
window.scheduleNextReminderCheck = scheduleNextReminderCheck;

function setupTimestamp() {
    updateEditorTimestamp();
    clearInterval(clockTimer);
    clockTimer = setInterval(updateEditorTimestamp, 60000);
}

function updateEditorTimestamp() {
    const timestamp = document.getElementById("editorTimestamp");
    if (!timestamp) return;

    const now = new Date();
    timestamp.textContent = now.toLocaleString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit"
    });
}

function updateNavigationCounts() {
    const notes = Array.isArray(window.notes) ? window.notes : [];
    const activeNotes = notes.filter(note => !note.deletedAt);

    let currentNotes;
    if (activeView === "trash") {
        currentNotes = notes.filter(note => note.deletedAt);
    } else if (activeView === "archive") {
        currentNotes = activeNotes.filter(note => note.archived && !note.isPrivate);
    } else if (activeView === "private") {
        currentNotes = activeNotes.filter(note => note.isPrivate && !note.archived);
    } else {
        currentNotes = activeNotes.filter(note => !note.archived && !note.isPrivate);
        if (activeCategory !== "all") {
            currentNotes = currentNotes.filter(note => note.category === activeCategory);
        }
    }

    const currentCount = currentNotes.length;
    const countEl = document.getElementById("notesCount");
    if (countEl) {
        countEl.textContent =
            `${currentCount} ${currentCount === 1 ? "note" : "notes"}`;
    }

    document.querySelectorAll("[data-count-for]").forEach(element => {
        const key = element.dataset.countFor;
        let count = 0;

        if (key === "all") count = activeNotes.filter(note => !note.archived && !note.isPrivate).length;
        else if (key === "archive") count = activeNotes.filter(note => note.archived && !note.isPrivate).length;
        else if (key === "private") count = activeNotes.filter(note => note.isPrivate && !note.archived).length;
        else if (key === "trash") count = notes.filter(note => note.deletedAt).length;
        else if (key === "folder") count = activeNotes.filter(note => note.folderId && !note.archived && !note.isPrivate).length;
        else count = activeNotes.filter(note => !note.archived && !note.isPrivate && note.category === key).length;

        element.textContent = count;
    });
}

function openSettings() {
    const settingsModal = document.getElementById("settingsModal");
    const settingsTheme = document.getElementById("settingsTheme");
    const confirmDeleteSetting = document.getElementById("confirmDeleteSetting");
    const settingsAccount = document.getElementById("settingsAccount");
    const user = window.firebaseAuth?.currentUser;

    if (!settingsModal) return;

    if (settingsAccount) {
        if (user) {
            const initials = user.displayName
                ? user.displayName.trim().split(/\\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase()
                : user.email
                    ? user.email.substring(0, 2).toUpperCase()
                    : "U";
            const provider = user.providerData?.some(item => item.providerId === "google.com")
                ? "Google account"
                : "Email account";

            settingsAccount.innerHTML = `
                <div class="settings-account-avatar">
                    ${user.photoURL
                        ? `<img src="${user.photoURL}" alt="" referrerpolicy="no-referrer">`
                        : `<span>${initials}</span>`}
                </div>
                <div class="settings-account-details">
                    <strong>${user.displayName || "SnapNotes user"}</strong>
                    <span>${user.email || provider}</span>
                    <small>${provider}</small>
                </div>
            `;
        } else {
            settingsAccount.innerHTML = `
                <div class="settings-account-avatar"><span><i class="fa-solid fa-user"></i></span></div>
                <div class="settings-account-details">
                    <strong>Local mode</strong>
                    <span>Your notes are stored on this device</span>
                </div>
            `;
        }
    }

    if (settingsTheme) {
        const isDark = localStorage.getItem("theme") === "dark";
        settingsTheme.value = isDark ? "dark" : "light";
        settingsThemeToggle.setAttribute("aria-checked", String(isDark));
        settingsThemeToggle.classList.toggle("active", isDark);
        document.getElementById("themeStatusLabel").textContent = isDark ? "Dark mode" : "Light mode";
        document.getElementById("themeStatusText").textContent = isDark
            ? "Dark mode is enabled"
            : "Dark mode is disabled";
    }

    if (confirmDeleteSetting) {
        confirmDeleteSetting.checked =
            localStorage.getItem("SnapNotesConfirmDelete") !== "false";
    }

    refreshAccountDeletionStatus(user);

    settingsModal.classList.add("show");
    settingsModal.setAttribute("aria-hidden", "false");
}

async function refreshAccountDeletionStatus(user = window.firebaseAuth?.currentUser) {
    const zone = document.getElementById("accountDangerZone");
    const status = document.getElementById("accountDeletionStatus");
    const deleteButton = document.getElementById("deleteAccountBtn");
    const cancelButton = document.getElementById("cancelAccountDeletionBtn");
    if (!zone || !status || !deleteButton || !cancelButton) return;

    if (!user || typeof window.getAccountDeletionStatus !== "function") {
        zone.hidden = true;
        return;
    }

    zone.hidden = false;
    status.textContent = "Checking account deletion status...";
    try {
        const deletion = await window.getAccountDeletionStatus(user.uid);
        if (!deletion?.scheduledFor) {
            status.textContent = "Your account is active and is not scheduled for deletion.";
            deleteButton.hidden = false;
            cancelButton.hidden = true;
            return;
        }

        const remainingDays = Math.max(0, Math.ceil((Date.parse(deletion.scheduledFor) - Date.now()) / (24 * 60 * 60 * 1000)));
        status.textContent = remainingDays > 0
            ? `Your account is scheduled for permanent deletion in ${remainingDays} ${remainingDays === 1 ? "day" : "days"}.`
            : "Your account deletion is due and will be processed shortly.";
        deleteButton.hidden = true;
        cancelButton.hidden = false;
    } catch (error) {
        console.error("Could not load account deletion status:", error);
        status.textContent = "Account deletion status is temporarily unavailable.";
    }
}

async function requestAccountDeletion() {
    const user = window.firebaseAuth?.currentUser;
    if (!user || typeof window.scheduleAccountDeletion !== "function") {
        showToast("Sign in to manage account deletion.", "warning");
        return;
    }
    if (!confirm("Schedule this account for permanent deletion in 10 days? You can cancel before then.")) return;

    const button = document.getElementById("deleteAccountBtn");
    try {
        button.disabled = true;
        await window.scheduleAccountDeletion(user.uid);
        showToast("Account deletion scheduled for 10 days from now.", "warning");
        await refreshAccountDeletionStatus(user);
    } catch (error) {
        console.error("Could not schedule account deletion:", error);
        showToast("Could not schedule account deletion. Try again.", "warning");
    } finally {
        button.disabled = false;
    }
}

async function cancelScheduledAccountDeletion() {
    const user = window.firebaseAuth?.currentUser;
    if (!user || typeof window.cancelAccountDeletion !== "function") return;

    const button = document.getElementById("cancelAccountDeletionBtn");
    try {
        button.disabled = true;
        await window.cancelAccountDeletion(user.uid);
        showToast("Account deletion cancelled.", "success");
        await refreshAccountDeletionStatus(user);
    } catch (error) {
        console.error("Could not cancel account deletion:", error);
        showToast("Could not cancel account deletion. Try again.", "warning");
    } finally {
        button.disabled = false;
    }
}

function closeSettings() {
    const settingsModal = document.getElementById("settingsModal");
    if (!settingsModal) return;

    settingsModal.classList.remove("show");
    settingsModal.setAttribute("aria-hidden", "true");
}

function applyTheme(theme) {
    document.body.classList.toggle("dark-mode", theme === "dark");
    updateThemeIcon();
}

function setupTheme() {
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme === "dark") {
        applyTheme("dark");
    }
}

function updateThemeIcon() {
    return;
}

function closeNoteMenus() {
    document.querySelectorAll(".note-dropdown.show").forEach(menu => {
        menu.classList.remove("show");
    });
}

window.openNewNoteView = openNewNoteView;
window.openNotesView = openNotesView;
window.applyNoteFilters = applyNoteFilters;
window.updateNavigationCounts = updateNavigationCounts;
window.closeNoteMenus = closeNoteMenus;
