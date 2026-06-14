// =========================
// EMPTY STATE
// =========================

function updateEmptyState() {
    const emptyMsg = document.getElementById("emptyState");
    const noteCount = document.querySelectorAll(".todoDiv").length;
    emptyMsg.style.display = noteCount === 0 ? "block" : "none";
}

// =========================
// NOTES COUNT DISPLAY
// =========================

function updateNotesCount() {
    const totalNotes = document.querySelectorAll(".todoDiv").length;
    notesCount.textContent = "Saved Notes: " + totalNotes;
}

// =========================
// ADD NOTE FUNCTION
// =========================

function addNote(note = {}){
 // console.log("addNote called:", note);
  const {
        id = crypto.randomUUID(),
        text = inputValue.value.trim(),
        time = null,
        category = categorySelect.value,
        pinned = false
    } = note; 


    // VALIDATION
    if (!text) {
        showToast("Note can't be empty!", "warning");
        return;
    }
/*
    // NOTE LENGTH CHECKER FUNCTION
    function checkNoteLength() {
        if (inputValue.value.length > 200) {
            alert("Note can't be more than 200 characters long!");
            showToast("Note too long! Max 200 characters.", "warning");
            return;
        }
    }
    
  
*/
    // CREATE NOTE CONTAINER
    const todoDiv = document.createElement("div");
    todoDiv.classList.add("todoDiv");
    todoDiv.dataset.id = id;
    todoDiv.setAttribute("data-category", category);

    // CATEGORY
 

    // CONTENT SECTION
    const contentDiv = document.createElement("div");
    contentDiv.classList.add("content");

    // NOTE TEXT
    const noteText = document.createElement("p");
    noteText.textContent = text ;

    // CREATE EDIT INPUT (hidden by default)
    
    const editInput = document.createElement("input");
    editInput.type = "text";
    editInput.classList.add("editInput");
    editInput.style.display = "none";

    // TIMESTAMP
    const timestamp = document.createElement("small");
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

    timestamp.textContent =
        time || `Created: ${formattedDate} • ${formattedTime}`;
    timestamp.classList.add("timestamp");

    // FOOTER DIV
    
    const footerDiv = document.createElement("div");
    footerDiv.classList.add("footerDiv");

    // CATEGORY LABEL
    
    const categoryLabel = document.createElement("span");
    categoryLabel.textContent = category.charAt(0).toUpperCase() + category.slice(1);
    categoryLabel.classList.add("categoryLabel");
    
    //ACTION GROUP PIN AND KABAB BTN
    const actionsDiv = document.createElement("div");
    actionsDiv.classList.add("actionsDiv"); 
    
    // PIN BUTTON
    const pinBtn = document.createElement("button");
    pinBtn.textContent = " 📌 ";
    pinBtn.classList.add("pinBtn");

    // PIN STATE
    let isPinned = pinned;

    // RESTORE PINNED NOTES
    if (pinned) {
        todoDiv.classList.add("pinned");
        pinBtn.textContent = "❌";
    }
    
   //MENU WRAPPER 
   
  // MENU WRAPPER (For dropdown positioning)
const menuWrapper = document.createElement("div");
menuWrapper.classList.add("menu-wrapper");

// ELLIPSIS BUTTON (the ⋮ trigger)

const menuBtn = document.createElement("button");
menuBtn.classList.add("menu-btn");
menuBtn.innerHTML = "⋮";

// DROPDOWN MENU (hidden by default)

const dropdownMenu = document.createElement("div");
dropdownMenu.classList.add("dropdown-menu");

// ADD HERE SHARE DELETE AND EDIT BUTTONS

// SHARE BUTTON

const shareBtn = document.createElement("button");
shareBtn.textContent = " Share Note";
shareBtn.classList.add("dropdown-item");

// EDIT BUTTON

const editNoteBtn = document.createElement("button");
editNoteBtn.textContent = "Edit Note";
editNoteBtn.classList.add("dropdown-item");

// DELETE BUTTON

const deleteBtn = document.createElement("button");
deleteBtn.textContent = " Delete";
deleteBtn.classList.add("dropdown-item", "delete-item");


 // TOGGLE DROPDOWN MENU
 
menuBtn.addEventListener("click", function(event) {
    event.stopPropagation();
    
    // Close all other open menus first
    const allMenus = document.querySelectorAll(".dropdown-menu.show");
    allMenus.forEach(function(menu) {
        if (menu !== dropdownMenu) {
            menu.classList.remove("show");
        }
    });
    
    // Toggle this menu
    dropdownMenu.classList.toggle("show");
});

// SHARE FUNCTIONALITY
shareBtn.addEventListener("click", function() {
    const noteContent = noteText.textContent;
    
    // Close the dropdown after clicking
    dropdownMenu.classList.remove("show");
    
    // Try Web Share API first (works on mobile!)
    if (navigator.share) {
        navigator.share({
            title: "SnapNotes",
            text: noteContent, 
        }).then(function() {
            showToast("Note shared!", "success");
        }).catch(function(err) {
            // User cancelled — do nothing
        });
    } else {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(noteContent).then(function() {
            showToast("Note copied to clipboard!", "success");
        }).catch(function() {
            showToast("Could not share note", "warning");
        });
    }
});


    // EDIT FUNCTIONALITY (inline editing)
    editNoteBtn.addEventListener("click", function() {

        if (editNoteBtn.textContent === "Save") {

            // SAVE MODE — user is done editing
            const newText = editInput.value.trim();

            if (newText === "") {
                showToast("Note can't be empty!", "warning");
                return;
            }

            noteText.textContent = newText;
            editInput.style.display = "none";
            noteText.style.display = "block";
            editNoteBtn.textContent = "Edit";

            /*checkNoteLength();*/
            saveNotes();
            showToast("Note Updated", "update");

        } else {

            // EDIT MODE — user wants to edit
            noteText.style.display = "none";
            editInput.value = noteText.textContent;
            editInput.style.display = "block";
            editInput.focus();
            editNoteBtn.textContent = "Save";
        }

    });

    // ENTER KEY TO SAVE WHILE EDITING
    editInput.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
            editNoteBtn.click();
        }
        if (event.key === "Escape") {
            editInput.style.display = "none";
            noteText.style.display = "block";
            editNoteBtn.textContent = "Edit";
        }
    });

    // DELETE FUNCTIONALITY
    deleteBtn.addEventListener("click", function() {

        const confirmDelete = confirm(
            "Are you sure you want to delete this note?"
        );

        if (confirmDelete) {
            todoDiv.remove();
            saveNotes();
            showToast("Note Deleted", "delete");
            updateEmptyState();
            updateNotesCount();
        }

    });

    // PIN FUNCTIONALITY
    pinBtn.addEventListener("click", function() {
        isPinned = !isPinned;
        todoDiv.classList.toggle("pinned");

        if (isPinned) {
            pinBtn.textContent = "❌";
            notesContainer.prepend(todoDiv);
            showToast("Note Pinned", "update");
        } else {
            pinBtn.textContent = "📌";
            notesContainer.appendChild(todoDiv);
            showToast("Note Unpinned", "warning");
        }

        saveNotes();
    });
    
// APPEND NOTE TEXT AND EDIT INPUT TO CONTENT
contentDiv.appendChild(noteText);
contentDiv.appendChild(editInput);

// APPEND FOOTER ITEMS (order matters: left to right)
footerDiv.appendChild(timestamp);
footerDiv.appendChild(categoryLabel);

// APPEND PIN BUTTON
actionsDiv.appendChild(pinBtn);
actionsDiv.appendChild(menuWrapper);

// APPEND MENU TO NOTE CARD
dropdownMenu.appendChild(shareBtn);
dropdownMenu.appendChild(editNoteBtn);
dropdownMenu.appendChild(deleteBtn);
menuWrapper.appendChild(menuBtn);
menuWrapper.appendChild(dropdownMenu);

// BUILD THE CARD
todoDiv.appendChild(contentDiv);
todoDiv.appendChild(footerDiv);
footerDiv.appendChild(actionsDiv);


    // ADD TO PAGE (prepend for new notes, append for loaded notes)
    if (pinned) {
        notesContainer.prepend(todoDiv);
    } else if (text) {
        notesContainer.appendChild(todoDiv);
    } else {
        notesContainer.prepend(todoDiv);
    }
// ENABLE DRAG AND DROP
todoDiv.setAttribute("draggable", "true");

todoDiv.addEventListener("dragstart", function() {
    todoDiv.classList.add("dragging");
});

todoDiv.addEventListener("dragend", function() {
    todoDiv.classList.remove("dragging");
    
    // Remove drag-over from all notes
    const allNotes = document.querySelectorAll(".todoDiv");
    allNotes.forEach(function(note) {
        note.classList.remove("drag-over");
    });
    
    // Save the new order
    saveNotes();
});

todoDiv.addEventListener("dragover", function(event) {
    event.preventDefault();
});

todoDiv.addEventListener("dragenter", function(event) {
    event.preventDefault();
    const dragging = document.querySelector(".dragging");
    if (dragging !== todoDiv) {
        todoDiv.classList.add("drag-over");
    }
});

todoDiv.addEventListener("dragleave", function() {
    todoDiv.classList.remove("drag-over");
});

todoDiv.addEventListener("drop", function(event) {
    event.preventDefault();
    const dragging = document.querySelector(".dragging");
    
    if (dragging && dragging !== todoDiv) {
        // Insert the dragged note BEFORE this note
        notesContainer.insertBefore(dragging, todoDiv);
    }
    
    todoDiv.classList.remove("drag-over");
});


    // CLEAR INPUT FIELD
    inputValue.value = "";
    categorySelect.value = "general";

    // SAVE NOTES (only for new notes, not loaded ones)
    if (text) {
        saveNotes();
        showToast("Notes added", "success");
    }

    updateEmptyState();
    updateNotesCount();
}
