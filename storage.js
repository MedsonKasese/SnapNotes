// =========================
// SAVE NOTES TO LOCALSTORAGE
// =========================

function saveNotes() {

    const allNotes = [];
    const noteDivs = document.querySelectorAll(".todoDiv");

    noteDivs.forEach(function(div) {
        const text = div.querySelector("p").textContent;
        const time = div.querySelector(".timestamp").textContent;
        const category = div.getAttribute("data-category");
        const pinned = div.classList.contains("pinned");

        allNotes.push({
            text: text,
            time: time,
            category: category,
            pinned: pinned
        });
    });

    localStorage.setItem("SnapNotes", JSON.stringify(allNotes));
}

// =========================
// LOAD NOTES FROM LOCALSTORAGE
// =========================

function loadNotes() {

    const savedNotes = localStorage.getItem("SnapNotes");

    if (savedNotes === null) {
        return;
    }

    const notesArray = JSON.parse(savedNotes);

    notesArray.forEach(function(note) {
        addNote(
            note.text,
            note.time,
            note.category || "general",
            note.pinned
        );
    });
}

// =========================
// TOAST NOTIFICATION
// =========================

function showToast(message, type = "default") {
    clearTimeout(toastTimeout);

    toast.textContent = message;

    // RESET CLASSES
    toast.className = "";

    // ADD TYPE CLASS
    toast.classList.add(type);

    // SHOW TOAST
    toast.style.opacity = "1";

    toastTimeout = setTimeout(function () {
        toast.style.opacity = "0";
    }, 2000);
}
