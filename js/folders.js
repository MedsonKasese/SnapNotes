// =========================
// NOTE FOLDERS
// =========================

const FOLDERS_KEY = "SnapNotesFolders";
const MAX_FOLDERS = 20;
const MAX_FOLDER_NAME = 32;
const FOLDER_ICONS = {
    folder: "fa-regular fa-folder",
    book: "fa-solid fa-book",
    flask: "fa-solid fa-flask",
    code: "fa-solid fa-code",
    lightbulb: "fa-regular fa-lightbulb",
    briefcase: "fa-solid fa-briefcase",
    heart: "fa-solid fa-heart",
    star: "fa-solid fa-star",
    cloud: "fa-solid fa-cloud"
};
const FOLDER_COLORS = {
    green: "#5b8c43",
    blue: "#4b78b5",
    purple: "#8561ad",
    orange: "#c77a32",
    rose: "#bb5e73",
    teal: "#3b8983"
};

let folders = [];
let foldersExpanded = false;

function normaliseFolder(folder) {
    if (!folder || typeof folder !== "object" || !folder.id) return null;
    const name = String(folder.name || "").trim().replace(/\s+/g, " ").slice(0, MAX_FOLDER_NAME);
    if (!name) return null;
    return {
        id: String(folder.id),
        name,
        icon: Object.hasOwn(FOLDER_ICONS, folder.icon) ? folder.icon : "folder",
        color: Object.hasOwn(FOLDER_COLORS, folder.color) ? folder.color : "",
        createdAt: folder.createdAt || new Date().toISOString(),
        updatedAt: folder.updatedAt || folder.createdAt || new Date().toISOString()
    };
}

function loadFolders() {
    foldersExpanded = false;
    try {
        const saved = JSON.parse(localStorage.getItem(FOLDERS_KEY) || "[]");
        folders = Array.isArray(saved) ? saved.map(normaliseFolder).filter(Boolean).slice(0, MAX_FOLDERS) : [];
    } catch {
        folders = [];
    }
    renderFolderNavigation();
    return folders;
}

function saveFolders() {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
    const libraryId = window.snapNotesDataUid !== undefined
        ? window.snapNotesDataUid || "local"
        : window.firebaseAuth?.currentUser?.uid || "local";
    void window.persistLocalLibrary?.(
        libraryId,
        Array.isArray(window.notes) ? window.notes : [],
        folders,
        Date.now()
    );
    window.dispatchEvent(new CustomEvent("snapnotes:folders-changed", {
        detail: { folders: structuredClone(folders) }
    }));
}

function getFolders() {
    return folders;
}

function getFolderById(id) {
    return folders.find(folder => folder.id === id) || null;
}

function getFolderNoteCount(id) {
    return (Array.isArray(window.notes) ? window.notes : [])
        .filter(note => note.folderId === id && !note.deletedAt && !note.archived && !note.isPrivate)
        .length;
}

function renderFolderNavigation() {
    const list = document.getElementById("folderNavList");
    const empty = document.getElementById("folderNavEmpty");
    const divider = document.getElementById("folderNavDivider");
    const viewAll = document.getElementById("folderNavViewAll");
    if (!list) return;

    list.innerHTML = "";
    if (!folders.length) {
        if (empty) empty.hidden = false;
        if (divider) divider.hidden = true;
        if (viewAll) viewAll.hidden = true;
        return;
    }

    if (empty) empty.hidden = true;
    if (divider) divider.hidden = false;

    folders.forEach((folder, index) => {
        const item = document.createElement("div");
        item.className = "folder-nav-row";
        item.dataset.folderId = folder.id;
        item.hidden = !foldersExpanded && index >= 3;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "drawer-item folder-nav-item";
        button.dataset.folderId = folder.id;
        button.setAttribute("aria-label", `Open folder ${folder.name}`);
        button.innerHTML = '<i aria-hidden="true"></i><span class="folder-nav-name"></span><span class="drawer-count folder-nav-count"></span>';
        button.querySelector("i").className = FOLDER_ICONS[folder.icon] || FOLDER_ICONS.folder;
        if (FOLDER_COLORS[folder.color]) button.style.setProperty("--folder-accent", FOLDER_COLORS[folder.color]);
        button.querySelector(".folder-nav-name").textContent = folder.name;
        button.querySelector(".folder-nav-count").textContent = getFolderNoteCount(folder.id);

        button.addEventListener("click", () => window.openFolderView?.(folder.id));

        const manage = document.createElement("button");
        manage.type = "button";
        manage.className = "folder-manage-button";
        manage.setAttribute("aria-label", `Manage ${folder.name}`);
        manage.title = "Folder options";
        manage.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
        manage.addEventListener("click", event => {
            event.stopPropagation();
            manageFolder(folder.id);
        });

        item.append(button, manage);
        list.appendChild(item);
    });

    if (viewAll) {
        viewAll.hidden = folders.length <= 3;
        viewAll.textContent = foldersExpanded ? "Show fewer" : `View all folders (${folders.length})`;
        viewAll.setAttribute("aria-expanded", String(foldersExpanded));
        viewAll.onclick = toggleFolderNavigation;
    }

    updateFolderActiveState();
}

function toggleFolderNavigation() {
    if (folders.length <= 3) return;
    foldersExpanded = !foldersExpanded;
    renderFolderNavigation();
}

function updateFolderActiveState() {
    document.querySelectorAll(".folder-nav-item").forEach(item => {
        item.classList.toggle("active", window.activeFolderId === item.dataset.folderId);
    });
}

function createFolder() {
    if (folders.length >= MAX_FOLDERS) {
        window.showToast?.(`You can create up to ${MAX_FOLDERS} folders.`, "warning");
        return;
    }

    const value = prompt("Folder name:");
    if (value === null) return;

    const name = value.trim().replace(/\s+/g, " ").slice(0, MAX_FOLDER_NAME);
    if (!name) {
        window.showToast?.("Enter a folder name.", "warning");
        return;
    }

    if (folders.some(folder => folder.name.toLowerCase() === name.toLowerCase())) {
        window.showToast?.("A folder with that name already exists.", "warning");
        return;
    }

    const now = new Date().toISOString();
    folders.push({
        id: crypto.randomUUID(),
        name,
        icon: "folder",
        color: "",
        createdAt: now,
        updatedAt: now
    });
    saveFolders();
    renderFolderNavigation();
    window.syncToCloud?.();
    window.showToast?.("Folder created", "success");
}

function renameFolder(id) {
    const folder = getFolderById(id);
    if (!folder) return;

    const value = prompt("Rename folder:", folder.name);
    if (value === null) return;

    const name = value.trim().replace(/\s+/g, " ").slice(0, MAX_FOLDER_NAME);
    if (!name) {
        window.showToast?.("Enter a folder name.", "warning");
        return;
    }

    if (folders.some(item => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) {
        window.showToast?.("A folder with that name already exists.", "warning");
        return;
    }

    folder.name = name;
    folder.updatedAt = new Date().toISOString();
    saveFolders();
    renderFolderNavigation();
    window.syncToCloud?.();
    window.updateNavigationCounts?.();
    window.showToast?.("Folder renamed", "success");
}

function customizeFolder(id) {
    const folder = getFolderById(id);
    if (!folder) return;

    const iconChoices = Object.keys(FOLDER_ICONS).join(", ");
    const iconValue = prompt(`Choose an icon (${iconChoices}):`, folder.icon || "folder");
    if (iconValue === null) return;
    const icon = iconValue.trim().toLowerCase();
    if (!Object.hasOwn(FOLDER_ICONS, icon)) {
        window.showToast?.(`Choose one of these icons: ${iconChoices}.`, "warning");
        return;
    }

    const colorChoices = `none, ${Object.keys(FOLDER_COLORS).join(", ")}`;
    const colorValue = prompt(`Choose a color (${colorChoices}):`, folder.color || "none");
    if (colorValue === null) return;
    const color = colorValue.trim().toLowerCase();
    if (color !== "none" && !Object.hasOwn(FOLDER_COLORS, color)) {
        window.showToast?.(`Choose one of these colors: ${colorChoices}.`, "warning");
        return;
    }

    folder.icon = icon;
    folder.color = color === "none" ? "" : color;
    folder.updatedAt = new Date().toISOString();
    saveFolders();
    renderFolderNavigation();
    window.syncToCloud?.();
    window.showToast?.("Folder appearance updated", "success");
}

async function deleteFolder(id) {
    const folder = getFolderById(id);
    if (!folder) return;

    const count = getFolderNoteCount(id);
    const confirmed = confirm(
        count
            ? `Delete "${folder.name}"? The ${count} note(s) inside will stay in SnapNotes but become unfiled.`
            : `Delete "${folder.name}"?`
    );
    if (!confirmed) return;

    (window.notes || []).forEach(note => {
        if (note.folderId === id) note.folderId = null;
    });

    folders = folders.filter(item => item.id !== id);
    saveFolders();
    localStorage.setItem("SnapNotes", JSON.stringify(window.notes || []));
    window.activeFolderId = null;
    await window.saveNotes?.();
    renderFolderNavigation();
    window.renderNotes?.();
    window.updateNavigationCounts?.();
    window.showToast?.("Folder deleted", "success");
}

function manageFolder(id) {
    const folder = getFolderById(id);
    if (!folder) return;

    const action = prompt(`Folder: ${folder.name}\n\nType "rename", "customize" or "delete".`, "rename");
    if (!action) return;

    const choice = action.trim().toLowerCase();
    if (choice === "rename") renameFolder(id);
    else if (choice === "customize") customizeFolder(id);
    else if (choice === "delete") deleteFolder(id);
    else window.showToast?.("Choose rename, customize or delete.", "warning");
}

async function moveNoteToFolder(noteId) {
    const note = (window.notes || []).find(item => item.id === noteId);
    if (!note || note.deletedAt || note.isPrivate) return;

    if (!folders.length) {
        window.showToast?.("Create a folder first.", "warning");
        return;
    }

    const choices = folders.map((folder, index) => `${index + 1}. ${folder.name}`).join("\n");
    const current = note.folderId ? getFolderById(note.folderId)?.name : "No folder";
    const value = prompt(`Move "${note.title || "Untitled note"}"\nCurrent: ${current}\n\n${choices}\n\nEnter a folder number, or 0 to remove from its folder:`);
    if (value === null) return;

    const index = Number.parseInt(value, 10);
    if (index === 0) {
        note.folderId = null;
    } else if (Number.isInteger(index) && index >= 1 && index <= folders.length) {
        note.folderId = folders[index - 1].id;
    } else {
        window.showToast?.("Choose a valid folder number.", "warning");
        return;
    }

    note.updatedAt = new Date().toISOString();
    await window.saveNotes?.();
    window.renderNotes?.();
    renderFolderNavigation();
    window.updateNavigationCounts?.();
    window.showToast?.(index === 0 ? "Note removed from folder" : `Moved to ${folders[index - 1].name}`, "success");
}

function clearFolderAssignments(folderId) {
    (window.notes || []).forEach(note => {
        if (note.folderId === folderId) delete note.folderId;
    });
}

window.loadFolders = loadFolders;
window.getFolders = getFolders;
window.getFolderById = getFolderById;
window.createFolder = createFolder;
window.renameFolder = renameFolder;
window.customizeFolder = customizeFolder;
window.deleteFolder = deleteFolder;
window.manageFolder = manageFolder;
window.moveNoteToFolder = moveNoteToFolder;
window.renderFolderNavigation = renderFolderNavigation;
window.toggleFolderNavigation = toggleFolderNavigation;
window.updateFolderActiveState = updateFolderActiveState;
window.clearFolderAssignments = clearFolderAssignments;
