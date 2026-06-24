// =========================
// CENTRALIZED STATE
// =========================

let notes = [];
window.notes = notes ;

// =========================
// SAVE NOTES TO LOCALSTORAGE
// =========================

function saveNotes() {
    localStorage.setItem("SnapNotes", JSON.stringify(window.notes));
    
    // Check if user is logged in for Firestore sync (Phase 3)
    if (typeof syncToCloud === 'function') {
        syncToCloud();
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

// Expose to window for other modules
window.showToast = showToast;
window.saveNotes = saveNotes;
window.loadNotes = loadNotes;
