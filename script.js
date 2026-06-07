// VARIABLES 

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
// EMPTY STATE
// =========================

function updateEmptyState() {
    const emptyMsg = document.getElementById("emptyState");
    const noteCount = document.querySelectorAll(".todoDiv").length;
    emptyMsg.style.display = noteCount === 0 ? "block" : "none";
}

// =========================
// ADD NOTE FUNCTION
// =========================

function addNote(
  savedText = null,
  savedTime = null,
  savedCategory = null, 
  savedPinned = false
)

 {

    // VALIDATION
    if (!savedText && inputValue.value.trim() === "") {
        alert("Sorry! You can't create empty notes!");
        return;
    }

    // CREATE NOTE CONTAINER
    const todoDiv = document.createElement("div");
    todoDiv.classList.add("todoDiv");
    

    // CATEGORY
    
    const category = savedCategory || categorySelect.value;
    todoDiv.classList.add("category-" + category);
    todoDiv.setAttribute("data-category", category);

    // CONTENT SECTION
    const contentDiv = document.createElement("div");
    contentDiv.classList.add("content");

    // NOTE TEXT
    const noteText = document.createElement("p");
    noteText.textContent = savedText || inputValue.value.trim();

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
    savedTime || `Created On: ${formattedDate} at ${formattedTime}`;
  timestamp.classList.add("timestamp");
    /*
    timestamp.textContent = savedTime || "Created on: " + now.toLocaleString();
    */
    

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
    let isPinned = savedPinned;

    // RESTORE PINNED NOTES
    if (savedPinned) {
        todoDiv.classList.add("pinned");
        pinBtn.textContent = "❌";
    }
    
   //MENU WRAPPER 
   
   // MENU WRAPPER (anchor for dropdown positioning)
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



/*
    // BUTTON CONTAINER
    const buttonContainer = document.createElement("div");
    buttonContainer.classList.add("buttonContainer");

    // EDIT BUTTON
    const editNoteBtn = document.createElement("button");
    editNoteBtn.textContent = "Edit";
    editNoteBtn.classList.add("editNoteBtn");

    // DELETE BUTTON
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.classList.add("deleteBtn");
    
    // PIN BUTTON 
    const pinBtn = document.createElement("button");
    pinBtn.textContent = " 📌 ";
    pinBtn.classList.add("pinBtn");
    
    // PIN STATE
let isPinned = savedPinned;

// RESTORE PINNED NOTES

if (savedPinned) {
    todoDiv.classList.add("pinned");
    pinBtn.textContent = "❌";
}

*/
    // EDIT FUNCTIONALITY (inline editing)
    editNoteBtn.addEventListener("click", function() {

        if (editNoteBtn.textContent === "Save") {

            // SAVE MODE — user is done editing
            const newText = editInput.value.trim();

            if (newText === "") {
                showToast("Note can't be empty!","warning");
                return;
            }

            noteText.textContent = newText;
            editInput.style.display = "none";
            noteText.style.display = "block";
            editNoteBtn.textContent = "Edit";

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
   // pin  button was declared here 

pinBtn.addEventListener("click", function () {
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



/*
    // APPEND NOTE TEXT AND EDIT INPUT TO CONTENT
    
    contentDiv.appendChild(noteText);
    contentDiv.appendChild(editInput);

    // APPEND FOOTER ITEMS
    
    footerDiv.appendChild(timestamp);
    footerDiv.appendChild(categoryLabel);

    // APPEND BUTTONS TO BUTTON CONTAINER
    
    buttonContainer.appendChild(pinBtn);
    buttonContainer.appendChild(editNoteBtn);
    buttonContainer.appendChild(deleteBtn);

    // APPEND BUTTON CONTAINER TO FOOTER
    footerDiv.appendChild(buttonContainer);

    // BUILD THE CARD
    todoDiv.appendChild(contentDiv);
    todoDiv.appendChild(footerDiv);

*/

    // ADD TO PAGE (prepend for new notes, append for loaded notes)
    
    if (savedPinned) {

    notesContainer.prepend(todoDiv);

} else if (savedText) {

    notesContainer.appendChild(todoDiv);

} else {

    notesContainer.prepend(todoDiv);
}
    
    /*
    if (savedText) {
        notesContainer.appendChild(todoDiv);
    } else {
        notesContainer.prepend(todoDiv);
    }
    */

    // CLEAR INPUT FIELD
    
    inputValue.value = "";
    categorySelect.value = "general";

    // SAVE NOTES (only for new notes, not loaded ones)
    if (!savedText) {
        saveNotes();
        showToast("Notes added", "success");
    }

    updateEmptyState();
    updateNotesCount();
}

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
            pinned:pinned
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
// NOTES COUNT DISPLAY
// =========================

function updateNotesCount() {
    const totalNotes = document.querySelectorAll(".todoDiv").length;
    notesCount.textContent = "Saved Notes: " + totalNotes;
}

// =========================
// TOAST NOTIFICATION
// =========================

// new Toast notification function 

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

// CLOSE DROPDOWN MENUS WHEN CLICKING OUTSIDE
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
