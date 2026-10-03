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
    const themeToggle = document.getElementById("themeToggle");
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

    themeToggle.addEventListener("click", toggleTheme);

    menuToggle.addEventListener("click", openDrawer);
    closeMenu.addEventListener("click", closeDrawer);
    drawerBackdrop.addEventListener("click", closeDrawer);

    drawerNav.addEventListener("click", (event) => {
        const item = event.target.closest("[data-category]");
        if (!item) return;
        selectCategory(item.dataset.category);
        closeDrawer();
    });

    saveNoteBtn.addEventListener("click", saveEditorNote);
    addBtn.addEventListener("click", openNewNoteView);
    newNoteBtn.addEventListener("click", openNewNoteView);
    logoButton.addEventListener("click", openNewNoteView);

    editorCategory.addEventListener("click", toggleCategoryMenu);

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

function openNewNoteView() {
    document.getElementById("newNoteView").hidden = false;
    document.getElementById("notesView").hidden = true;
    document.getElementById("addBtn").hidden = true;
    document.getElementById("noteEditor").focus();
    closeSearchPanel();
    closeDrawer();
}

function openNotesView(category = activeCategory) {
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
    renderNotes(searchInput.value.trim(), activeCategory);
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
    renderNotes("", activeCategory);
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

function saveEditorNote() {
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
        category: selectedEditorCategory,
        pinned: false,
        time: `Created: ${formattedDate} • ${formattedTime}`,
        createdAt: now.toISOString()
    };

    window.notes.unshift(newNote);
    saveNotes();
    clearDraft();
    editor.innerHTML = "";
    renderNotes("", activeCategory);
    updateNavigationCounts();
    showToast("Note saved", "success");
    openNotesView("all");
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

    document.getElementById("notesCount").textContent =
        `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;

    document.querySelectorAll("[data-count-for]").forEach(element => {
        const category = element.dataset.countFor;
        const count = category === "all"
            ? notes.length
            : notes.filter(note => note.category === category).length;
        element.textContent = count;
    });
}

function setupTheme() {
    const themeToggle = document.getElementById("themeToggle");
    const savedTheme = localStorage.getItem("theme");

    if (savedTheme === "dark") {
        document.body.classList.add("dark-mode");
    }

    updateThemeIcon();
}

function toggleTheme() {
    document.body.classList.toggle("dark-mode");
    localStorage.setItem(
        "theme",
        document.body.classList.contains("dark-mode") ? "dark" : "light"
    );
    updateThemeIcon();
}

function updateThemeIcon() {
    const icon = document.querySelector("#themeToggle i");
    if (!icon) return;

    icon.className = document.body.classList.contains("dark-mode")
        ? "fa-solid fa-sun"
        : "fa-solid fa-moon";

    document.getElementById("themeToggle").setAttribute(
        "aria-label",
        document.body.classList.contains("dark-mode")
            ? "Switch to light theme"
            : "Switch to dark theme"
    );
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
