// =========================
// RENDER NOTES
// =========================

function renderNotes(filterText = "", filterCategory = "all") {
    const notesContainer = document.getElementById("notesContainer");
    if (!notesContainer) return;

    notesContainer.innerHTML = "";

    const filteredNotes = window.notes.filter(note => {
        const matchesSearch = note.text.toLowerCase().includes(filterText.toLowerCase());
        const matchesCategory = filterCategory === "all" || note.category === filterCategory;
        return matchesSearch && matchesCategory;
    });

    // Sort: Pinned first, then by creation date (newest first)
    filteredNotes.sort((a, b) => {
        if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

    filteredNotes.forEach(note => {
        const noteElement = createNoteElement(note);
        notesContainer.appendChild(noteElement);
    });

    updateEmptyState();
    updateNotesCount();
}

// =========================
// CREATE NOTE ELEMENT (DOM)
// =========================

function createNoteElement(note) {
    const todoDiv = document.createElement("div");
    todoDiv.classList.add("todoDiv");
    todoDiv.dataset.id = note.id;
    todoDiv.setAttribute("data-category", note.category);
    if (note.pinned) todoDiv.classList.add("pinned");

    // Content
    const contentDiv = document.createElement("div");
    contentDiv.classList.add("content");

    const noteText = document.createElement("p");
    noteText.textContent = note.text;
    
    const editInput = document.createElement("input");
    editInput.type = "text";
    editInput.classList.add("editInput");
    editInput.style.display = "none";
    editInput.value = note.text;

    contentDiv.appendChild(noteText);
    contentDiv.appendChild(editInput);

    // Footer
    const footerDiv = document.createElement("div");
    footerDiv.classList.add("footerDiv");

    // Left Section (Timestamp & Category)
    const leftSection = document.createElement("div");
    leftSection.classList.add("footer-left");

    const timestamp = document.createElement("small");
    timestamp.classList.add("timestamp");
    timestamp.textContent = note.time || "No date";

    const categoryLabel = document.createElement("span");
    categoryLabel.classList.add("categoryLabel");
    categoryLabel.textContent = note.category.charAt(0).toUpperCase() + note.category.slice(1);

    leftSection.appendChild(timestamp);
    leftSection.appendChild(categoryLabel);

    // Right Section (Pin & Actions)
    const rightSection = document.createElement("div");
    rightSection.classList.add("footer-right");

    const pinBtn = document.createElement("button");
    pinBtn.classList.add("pinBtn");
    pinBtn.textContent = note.pinned ? "📍 " : "📌";
    pinBtn.onclick = () => togglePin(note.id);

    const menuWrapper = document.createElement("div");
    menuWrapper.classList.add("menu-wrapper");

    const menuBtn = document.createElement("button");
    menuBtn.classList.add("menu-btn");
    menuBtn.innerHTML = "⋮";
    menuBtn.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.remove("show"));
        dropdownMenu.classList.toggle("show");
    };
    menuBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            dropdownMenu.classList.toggle('show');
        }
        if (e.key === 'Escape') dropdownMenu.classList.remove('show');
    });

    const dropdownMenu = document.createElement("div");
    dropdownMenu.classList.add("dropdown-menu");

    const shareBtn = createDropdownItem("Share Note", () => shareNote(note.text, note.time));
    const editBtn = createDropdownItem("Edit Note", () => {
        noteText.style.display = "none";
        editInput.style.display = "block";
        editInput.focus();
        dropdownMenu.classList.remove("show");
    });
    const deleteBtn = createDropdownItem("Delete", () => deleteNote(note.id), "delete-item");

    dropdownMenu.appendChild(shareBtn);
    dropdownMenu.appendChild(editBtn);
    dropdownMenu.appendChild(deleteBtn);

    menuWrapper.appendChild(menuBtn);
    menuWrapper.appendChild(dropdownMenu);

    rightSection.appendChild(pinBtn);
    rightSection.appendChild(menuWrapper);

    footerDiv.appendChild(leftSection);
    footerDiv.appendChild(rightSection);

    todoDiv.appendChild(contentDiv);
    todoDiv.appendChild(footerDiv);

    // Inline Edit Logic
    editInput.onkeydown = (e) => {
        if (e.key === "Enter") {
            updateNoteText(note.id, editInput.value);
        } else if (e.key === "Escape") {
            renderNotes();
        }
    };

    return todoDiv;
}

function createDropdownItem(text, onClick, extraClass = "") {
    const btn = document.createElement("button");
    btn.classList.add("dropdown-item");
    if (extraClass) btn.classList.add(extraClass);
    btn.textContent = text;
    btn.onclick = onClick;
    return btn;
}

// =========================
// NOTE ACTIONS
// =========================

function addNote() {
    const input = document.getElementById("textInput");
    const category = document.getElementById("categorySelect").value;
    const text = input.value.trim();

    if (!text) {
        showToast("Note can't be empty!", "warning");
        return;
    }

    const now = new Date();
    const formattedDate = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const formattedTime = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

    const newNote = {
        id: crypto.randomUUID(),
        text: text,
        category: category,
        pinned: false,
        time: `Created: ${formattedDate} • ${formattedTime}`,
        createdAt: now.toISOString()
    };

    window.notes.push(newNote);
    input.value = "";
    saveNotes();
    renderNotes();
    showToast("Note added", "success");
}

function deleteNote(id) {
    if (confirm("Are you sure you want to delete this note?")) {
        window.notes = window.notes.filter(n => n.id !== id);
        saveNotes();
        renderNotes();
        showToast("Note Deleted", "delete");
    }
}

function togglePin(id) {
    const note = window.notes.find(n => n.id === id);
    if (note) {
        note.pinned = !note.pinned;
        saveNotes();
        renderNotes();
        showToast(note.pinned ? "Note Pinned" : "Note Unpinned", note.pinned ? "update" : "warning");
    }
}

function updateNoteText(id, newText) {
    const note = window.notes.find(n => n.id === id);
    if (note && newText.trim()) {
        note.text = newText.trim();
        saveNotes();
        renderNotes();
        showToast("Note Updated", "update");
    } else {
        renderNotes();
    }
}

async function shareNote(text, time) {
    const shareTemplate = document.getElementById("shareTemplate");
    const shareContent = document.getElementById("shareContent");
    const shareTimestamp = document.getElementById("shareTimestamp");

    if (!shareTemplate || !shareContent || !shareTimestamp) {
        // Fallback to text sharing if template is missing
        fallbackShare(text);
        return;
    }

    // Set content for image generation
    shareContent.textContent = text;
    shareTimestamp.textContent = time;

    try {
        showToast("Generating image...", "default");
        
        // Generate canvas from template
        const canvas = await html2canvas(shareTemplate, {
            backgroundColor: "#ffffff",
            scale: 2, // Higher quality
            logging: false,
            useCORS: true
        });

        // Convert to Blob
        canvas.toBlob(async (blob) => {
            if (!blob) {
                fallbackShare(text);
                return;
            }

            const file = new File([blob], "SnapNote.png", { type: "image/png" });

            // Check if Web Share API supports files
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: 'SnapNotes',
                        text: text
                    });
                    showToast("Note shared as image!", "success");
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        fallbackShare(text);
                    }
                }
            } else {
                // Fallback to text sharing if file sharing is not supported
                fallbackShare(text);
            }
        }, "image/png");

    } catch (error) {
        console.error("Error generating image:", error);
        fallbackShare(text);
    }
}

function fallbackShare(text) {
    if (navigator.share) {
        navigator.share({ title: "SnapNotes", text: text })
            .then(() => showToast("Note shared!", "success"))
            .catch(() => {});
    } else {
        navigator.clipboard.writeText(text)
            .then(() => showToast("Note copied to clipboard!", "success"))
            .catch(() => showToast("Could not share note", "warning"));
    }
}

// =========================
// UI HELPERS
// =========================

function updateEmptyState() {
    const emptyMsg = document.getElementById("emptyState");
    if (emptyMsg) emptyMsg.style.display = window.notes.length === 0 ? "block" : "none";
}

function updateNotesCount() {
    const countEl = document.getElementById("notesCount");
    if (countEl) countEl.textContent = "Saved Notes: " + window.notes.length;
}

// Expose to window
window.addNote = addNote;
window.renderNotes = renderNotes;
window.shareNote = shareNote;
window.updateEmptyState = updateEmptyState;
window.updateNotesCount = updateNotesCount;
