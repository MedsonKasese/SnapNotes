// =========================
// NOTE FOLDERS
// =========================

const FOLDERS_KEY = "SnapNotesFolders";
const MAX_FOLDERS = 20;
const MAX_FOLDER_NAME = 32;

let folders = [];

function normaliseFolder(folder) {
    if (!folder || typeof folder !== "object" || !folder.id) return null;
    const name = String(folder.name || "").trim().replace(/\s+/g, " ").slice(0, MAX_FOLDER_NAME);
    if (!name) return null;
    return {
        id: String(folder.id),
        name,
        createdAt: folder.createdAt || new Date().toISOString(),
        updatedAt: folder.updatedAt || folder.createdAt || new Date().toISOString()
    };
}

function loadFolders() {
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
    if (!list) return;

    list.innerHTML = "";
    if (!folders.length) {
        if (empty) empty.hidden = false;
        return;
    }

    if (empty) empty.hidden = true;

    folders.forEach(folder => {
        const item = document.createElement("div");
        item.className = "folder-nav-row";
        item.dataset.folderId = folder.id;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "drawer-item folder-nav-item";
        button.dataset.folderId = folder.id;
        button.setAttribute("aria-label", `Open folder ${folder.name}`);
        button.innerHTML = '<i class="fa-regular fa-folder"></i><span class="folder-nav-name"></span><span class="drawer-count folder-nav-count"></span>';
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

    updateFolderActiveState();
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

    const action = prompt(`Folder: ${folder.name}\n\nType "rename" or "delete".`, "rename");
    if (!action) return;

    const choice = action.trim().toLowerCase();
    if (choice === "rename") renameFolder(id);
    else if (choice === "delete") deleteFolder(id);
    else window.showToast?.("Choose rename or delete.", "warning");
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
window.deleteFolder = deleteFolder;
window.manageFolder = manageFolder;
window.moveNoteToFolder = moveNoteToFolder;
window.renderFolderNavigation = renderFolderNavigation;
window.updateFolderActiveState = updateFolderActiveState;
window.clearFolderAssignments = clearFolderAssignments;
