// =========================
// MAINTENANCE MODE
// =========================

const maintenanceOverlay = document.getElementById("maintenanceOverlay");
const maintenanceBtn = document.getElementById("maintenanceBtn");

maintenanceBtn.addEventListener("click", function() {
    window.close();
    // Fallback if window.close() doesn't work
    window.location.href = "about:blank";
});

// =========================
// VARIABLES
// =========================

const inputValue = document.getElementById("textInput");
const notesContainer = document.getElementById("notesContainer");
const toast = document.getElementById("toast");
const notesCount = document.getElementById("notesCount");
const searchInput = document.getElementById("searchInput");
const categorySelect = document.getElementById("categorySelect");
const categoryFilter = document.getElementById("categoryFilter");

let toastTimeout;

// =========================
// ENTER KEY FUNCTIONALITY
// =========================

inputValue.addEventListener("keydown", function(event) {
    if (event.key === "Enter") {
        addNote();
    }
});

// =========================
// WORD COUNT
// =========================

inputValue.addEventListener("input", function() {
    const count = inputValue.value.length;
    const charCount = document.getElementById("charCount");
    if (charCount) {
        charCount.textContent = count + "/200 characters";

        if (count > 200) {
            charCount.style.color = "red";
        } else {
            charCount.style.color = "#888";
        }
    }
});

// =========================
// DARK MODE TOGGLE
// =========================

const toggleBtn = document.getElementById("themeToggle");

if (localStorage.getItem("theme") === "dark") {
    document.body.classList.add("dark-mode");
    toggleBtn.textContent = "\u2600\uFE0F";
} else {
    toggleBtn.textContent = "\uD83C\uDF19";
}

toggleBtn.addEventListener("click", function() {
    document.body.classList.toggle("dark-mode");

    if (document.body.classList.contains("dark-mode")) {
        localStorage.setItem("theme", "dark");
        toggleBtn.textContent = "\u2600\uFE0F";
    } else {
        localStorage.setItem("theme", "light");
        toggleBtn.textContent = "\uD83C\uDF19";
    }
});

// =========================
// SEARCH FUNCTIONALITY
// =========================

searchInput.addEventListener("input", function() {

    const searchText = searchInput.value.toLowerCase();

    const allNotes = document.querySelectorAll(".todoDiv");

    allNotes.forEach(function(note) {

        const noteContent = note.querySelector("p").textContent.toLowerCase();

        if (noteContent.includes(searchText)) {
            note.style.display = "flex";
        } else {
            note.style.display = "none";
        }

    });

});

// =========================
// FILTER FUNCTIONALITY
// =========================

categoryFilter.addEventListener("change", function() {

    const selected = categoryFilter.value;
    const allNotes = document.querySelectorAll(".todoDiv");

    allNotes.forEach(function(note) {

        if (selected === "all") {
            note.style.display = "flex";
        } else if (note.getAttribute("data-category") === selected) {
            note.style.display = "flex";
        } else {
            note.style.display = "none";
        }

    });

});

// =========================
// CLOSE DROPDOWN MENUS WHEN CLICKING OUTSIDE
// =========================

document.addEventListener("click", function() {
    const allMenus = document.querySelectorAll(".dropdown-menu.show");
    allMenus.forEach(function(menu) {
        menu.classList.remove("show");
    });
});

// =========================
// INITIALIZE APP
// =========================

loadNotes();
updateEmptyState();
updateNotesCount();
