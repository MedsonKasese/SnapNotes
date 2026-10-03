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

    // Local storage is updated immediately so the edit survives a refresh
    // even if the network is unavailable.
    localStorage.setItem("SnapNotes", JSON.stringify(notesSnapshot));

    // If the user is signed in, wait for Firestore persistence to finish.
    // The previous implementation started the async sync without awaiting it,
    // which could make a later cloud load restore the old version of a note.
    if (typeof window.syncToCloud === "function") {
        try {
            await window.syncToCloud();
        } catch (error) {
            console.error("Cloud save failed after local save:", error);
        }
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
