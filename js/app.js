// =========================
// INITIALIZATION
// =========================

document.addEventListener("DOMContentLoaded", () => {
    // Load notes from storage
    loadNotes();

    // Event Listeners
    setupEventListeners();
    setupTheme();
});

function setupEventListeners() {
    const textInput = document.getElementById("textInput");
    const searchInput = document.getElementById("searchInput");
    const categoryFilter = document.getElementById("categoryFilter");
    const themeToggle = document.getElementById("themeToggle");

    // Add Note on Enter
    textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addNote();
    });

    // Search & Filter
    searchInput.addEventListener("input", () => {
        renderNotes(searchInput.value, categoryFilter.value);
    });

    categoryFilter.addEventListener("change", () => {
        renderNotes(searchInput.value, categoryFilter.value);
    });

    // Theme Toggle
    themeToggle.addEventListener("click", toggleTheme);

    // Global Click to close menus
    document.addEventListener("click", () => {
        document.querySelectorAll(".dropdown-menu.show").forEach(menu => {
            menu.classList.remove("show");
        });
    });

    // CHARACTER COUNT
    textInput.addEventListener('input', () => {
        const length = textInput.value.length;
        document.getElementById('charCount').textContent = length + ' / 200';
        
        if (length >= 200) {
            document.getElementById('charCount').style.color = 'red';
        } else {
            document.getElementById('charCount').style.color = '#888';
        }
    });
}

// =========================
// THEME MANAGEMENT
// =========================

function setupTheme() {
    const themeToggle = document.getElementById("themeToggle");
    if (localStorage.getItem("theme") === "dark") {
        document.body.classList.add("dark-mode");
        themeToggle.textContent = "☀️";
    } else {
        themeToggle.textContent = "🌙";
    }
}

function toggleTheme() {
    const themeToggle = document.getElementById("themeToggle");
    document.body.classList.toggle("dark-mode");

    if (document.body.classList.contains("dark-mode")) {
        localStorage.setItem("theme", "dark");
        themeToggle.textContent = "☀️";
    } else {
        localStorage.setItem("theme", "light");
        themeToggle.textContent = "🌙";
    }
}
