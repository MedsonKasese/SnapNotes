// =========================
// CENTRALIZED STATE
// =========================

let notes = [];
window.notes = notes;

// =========================
// SAVE NOTES TO LOCALSTORAGE + CLOUD
// =========================

async function saveNotes() {
    const notesSnapshot = Array.isArray(window.notes) ? [...window.notes] : [];

    // Always persist locally first. This makes saves resilient to offline use.
    localStorage.setItem("SnapNotes", JSON.stringify(notesSnapshot));

    const cloudEnabled = Boolean(window.firebaseAuth?.currentUser);
    if (!cloudEnabled || typeof window.syncToCloud !== "function") {
        return { synced: false, cloudEnabled };
    }

    try {
        const synced = await window.syncToCloud();
        return { synced: synced === true, cloudEnabled: true };
    } catch (error) {
        console.error("Cloud save failed after local save:", error);
        return { synced: false, cloudEnabled: true };
    }
}

// =========================
// LOAD NOTES FROM LOCALSTORAGE
// =========================

function loadNotes() {
    const savedNotes = localStorage.getItem("SnapNotes");

    if (savedNotes) {
        try {
            window.notes = JSON.parse(savedNotes);
            renderNotes();
            window.checkDueReminders?.();
        } catch (e) {
            console.error("Failed to parse notes from local storage", e);
            window.notes = [];
        }
    }
}

// =========================
// TOAST NOTIFICATION
// =========================

let toastTimeout;

function showToast(message, type = "default") {
    const toast = document.getElementById("toast");
    if (!toast) return;

    clearTimeout(toastTimeout);
    toast.textContent = message;
    toast.className = "";
    toast.classList.add(type);
    toast.style.opacity = "1";

    toastTimeout = setTimeout(function () {
        toast.style.opacity = "0";
    }, 2000);
}

// Expose to window for other scripts
window.showToast = showToast;
window.saveNotes = saveNotes;
window.loadNotes = loadNotes;
