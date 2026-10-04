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
let selectedEditorCategory = "general";
let clockTimer = null;
let draftTimer = null;
const DRAFT_KEY = "SnapNotesDraft";

document.addEventListener("DOMContentLoaded", () => {
    loadNotes();
    setupEventListeners();
    restoreDraft();
    setupTheme();
    setupTimestamp();
    openNewNoteView();
    updateNavigationCounts();
});

function setupEventListeners() {
    const searchInput = document.getElementById("searchInput");
    const categoryFilter = document.getElementById("categoryFilter");
    const settingsBtn = document.getElementById("settingsBtn");
    const settingsModal = document.getElementById("settingsModal");
    const closeSettingsBtn = document.getElementById("closeSettingsBtn");
    const signOutSettingsBtn = document.getElementById("signOutSettingsBtn");
    const settingsTheme = document.getElementById("settingsTheme");
    const confirmDeleteSetting = document.getElementById("confirmDeleteSetting");
    const settingsAccount = document.getElementById("settingsAccount");
    document.getElementById("closeDetailBtn").addEventListener("click", closeNoteDetail);
    document.getElementById("detailEditBtn").addEventListener("click", () => {
        const detail = document.getElementById("noteDetailView");
        const id = detail.dataset.noteId;
        closeNoteDetail();
        const card = document.querySelector(".note-card[data-id=\"" + id + "\"]");
        const note = window.notes.find(item => item.id === id);
        if (card && note) window.startNoteEditing?.(card, note);
    });
    const openSearch = document.getElementById("openSearch");
    const closeSearch = document.getElementById("closeSearch");
    const menuToggle = document.getElementById("menuToggle");
    const closeMenu = document.getElementById("closeMenu");
    const drawerBackdrop = document.getElementById("drawerBackdrop");
    const saveNoteBtn = document.getElementById("saveNoteBtn");
    const addBtn = document.getElementById("addBtn");
    const newNoteBtn = document.getElementById("newNoteBtn");
    const logoButton = document.getElementById("logoButton");
    const editorCategory = document.getElementById("editorCategory");
    const drawerNav = document.getElementById("drawerNav");
    const categoryMenu = document.getElementById("categoryMenu");
    const exportNotesBtn = document.getElementById("exportNotesBtn");
    const importNotesBtn = document.getElementById("importNotesBtn");
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
    settingsTheme.addEventListener("change", () => {
        applyTheme(settingsTheme.value);
        localStorage.setItem("theme", settingsTheme.value);
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

    exportNotesBtn.addEventListener("click", exportNotes);
    importNotesBtn.addEventListener("click", () => importNotesInput.click());
    importNotesInput.addEventListener("change", importNotes);
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
            closeDrawer();
            closeCategoryMenu();
            closeNoteMenus();
        }
    });

    document.getElementById("noteEditor").addEventListener("input", scheduleDraftSave);

    document.getElementById("noteEditor").addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            saveEditorNote();
        }
    });
}

function openNoteDetail(id) {
    const note = window.notes.find(item => item.id === id);
    if (!note) return;
    const detail = document.getElementById("noteDetailView");
    detail.dataset.noteId = id;
    document.getElementById("detailTitle").textContent = note.title || "Untitled note";
    document.getElementById("detailMeta").textContent = (CATEGORIES[note.category] || "General") + " • " + (note.time || "");
    const content = document.getElementById("detailContent");
    content.innerHTML = typeof window.sanitizeNoteHtml === "function" ? window.sanitizeNoteHtml(note.html || "") : "";
    if (!content.innerHTML) content.textContent = note.text || "";
    document.getElementById("newNoteView").hidden = true;
    document.getElementById("notesView").hidden = true;
    detail.hidden = false;
    document.getElementById("addBtn").hidden = true;
}

function closeNoteDetail() {
    document.getElementById("noteDetailView").hidden = true;
    document.getElementById("notesView").hidden = false;
    document.getElementById("addBtn").hidden = false;
    applyNoteFilters();
}

function openNewNoteView() {
    document.getElementById("newNoteView").hidden = false;
    document.getElementById("notesView").hidden = true;
    document.getElementById("addBtn").hidden = true;
    document.getElementById("noteEditor").focus();
    closeSearchPanel();
    closeDrawer();
}

function openNotesView(category = activeCategory) {
    activeView = "all";
    activeCategory = category;
    document.getElementById("categoryFilter").value = category;
    document.getElementById("newNoteView").hidden = true;
    document.getElementById("notesView").hidden = false;
    document.getElementById("addBtn").hidden = false;

    const title = category === "all" ? "All notes" : CATEGORIES[category];
    document.getElementById("notesViewTitle").textContent = title;
    document.getElementById("notesViewEyebrow").textContent = category === "all" ? "Your notes" : "Category";

    applyNoteFilters();
}

function selectView(view) {
    activeView = view;
    document.querySelectorAll(".drawer-item").forEach(item => {
        item.classList.toggle("active", item.dataset.view === view);
    });
    document.getElementById("categoryFilter").value = "all";
    document.getElementById("newNoteView").hidden = true;
    document.getElementById("notesView").hidden = false;
    document.getElementById("addBtn").hidden = view !== "all";
    document.getElementById("notesViewTitle").textContent = view === "archive" ? "Archived" : "Trash";
    document.getElementById("notesViewEyebrow").textContent = "Library";
    applyNoteFilters();
}

function selectCategory(category) {
    activeCategory = category;
    document.getElementById("categoryFilter").value = category;
    document.querySelectorAll(".drawer-item").forEach(item => {
        item.classList.toggle("active", item.dataset.category === category);
    });
    openNotesView(category);
}

function applyNoteFilters() {
    const searchInput = document.getElementById("searchInput");
    const categoryFilter = document.getElementById("categoryFilter");

    activeCategory = categoryFilter.value;
    renderNotes(searchInput.value.trim(), activeCategory, activeView);
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
        setDraftStatus("Draft restored");
    } catch (error) {
        localStorage.removeItem(DRAFT_KEY);
        console.error("Failed to restore SnapNotes draft:", error);
    }
}

function clearDraft() {
    clearTimeout(draftTimer);
    localStorage.removeItem(DRAFT_KEY);
    setDraftStatus("Drafts save automatically");
}

function setDraftStatus(message) {
    const status = document.getElementById("draftStatus");
    if (status) status.querySelector("span").textContent = message;
}

async function saveEditorNote() {
    const editor = document.getElementById("noteEditor");
    const rawText = editor.innerText.replace(/\r/g, "").trim();

    if (!rawText) {
        showToast("Write something before saving.", "warning");
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
        html: sanitizeNoteHtml(editor.innerHTML),
        category: selectedEditorCategory,
        pinned: false,
        time: `Created: ${formattedDate} • ${formattedTime}`,
        createdAt: now.toISOString()
    };

    window.notes.unshift(newNote);
    window.recordCreatedNoteHistory?.(newNote.id);

    const cloudSynced = await saveNotes();
    clearDraft();
    editor.innerHTML = "";
    renderNotes("", activeCategory);
    updateNavigationCounts();

    if (cloudSynced) {
        showToast("Note saved and synced", "success");
    } else {
        showToast("Note saved locally. Cloud sync pending.", "warning");
    }

    openNotesView("all");
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
                notes
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

        if (!Array.isArray(imported)) {
            throw new Error("Invalid SnapNotes export.");
        }

        const existingIds = new Set((window.notes || []).map(note => note.id));
        const normalized = imported
            .filter(note => note && typeof note === "object")
            .map(note => ({
                id: existingIds.has(note.id) ? crypto.randomUUID() : (note.id || crypto.randomUUID()),
                title: String(note.title || ""),
                text: String(note.text || ""),
                html: typeof note.html === "string" ? note.html : "",
                category: CATEGORIES[note.category] ? note.category : "general",
                pinned: Boolean(note.pinned),
                archived: Boolean(note.archived),
                deletedAt: note.deletedAt || null,
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
    const currentCount = activeNotes.filter(note => !note.archived).length;

    document.getElementById("notesCount").textContent =
        `${currentCount} ${currentCount === 1 ? "note" : "notes"}`;

    document.querySelectorAll("[data-count-for]").forEach(element => {
        const key = element.dataset.countFor;
        let count = 0;

        if (key === "all") count = activeNotes.filter(note => !note.archived).length;
        else if (key === "archive") count = activeNotes.filter(note => note.archived).length;
        else if (key === "trash") count = notes.filter(note => note.deletedAt).length;
        else count = activeNotes.filter(note => !note.archived && note.category === key).length;

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
        settingsAccount.textContent = user
            ? (user.displayName || user.email || "Signed in")
            : "Using SnapNotes locally";
    }

    if (settingsTheme) {
        settingsTheme.value = localStorage.getItem("theme") === "dark" ? "dark" : "light";
    }

    if (confirmDeleteSetting) {
        confirmDeleteSetting.checked =
            localStorage.getItem("SnapNotesConfirmDelete") !== "false";
    }

    settingsModal.classList.add("show");
    settingsModal.setAttribute("aria-hidden", "false");
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
window.openNoteDetail = openNoteDetail;
window.applyNoteFilters = applyNoteFilters;
window.updateNavigationCounts = updateNavigationCounts;
window.closeNoteMenus = closeNoteMenus;
