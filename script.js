        // VARIABLES

        const inputValue = document.getElementById("textInput");
        const notesContainer = document.getElementById("notesContainer");
        
         // ADD NOTE FUNCTION

        function addNote( savedText = null) {

            // VALIDATION

            if (!savedText && inputValue.value.trim() === "") {
                alert("Sorry, you can't create empty notes!");
                return;
            }


            // CREATE NOTE CONTAINER

            const todoDiv = document.createElement("div");
            todoDiv.classList.add("todoDiv");


            // CONTENT SECTION

            const contentDiv = document.createElement("div");
            contentDiv.classList.add("content");


            // NOTE TEXT

            const noteText = document.createElement("p");
            noteText.textContent = savedText || inputValue.value.trim();


            // TIMESTAMP

            const timestamp = document.createElement("small");

            const now = new Date();

            timestamp.textContent = `created on :   ${now.toLocaleString()}`; //previous now. LocaleString();
            
            timestamp.classList.add("timestamp");


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


            // EDIT FUNCTIONALITY

            editNoteBtn.addEventListener("click", function () {

                const updatedText = prompt(
                    "Edit your note:",
                    noteText.textContent
                );

                if (
                    updatedText !== null &&
                    updatedText.trim() !== ""
                ) {
                    noteText.textContent = updatedText;
                   
                    saveNotes();
                    showToast("Notes Updated")
                }

            });


            // DELETE FUNCTIONALITY

            deleteBtn.addEventListener("click", function () {

                todoDiv.remove();
               
                   
                saveNotes();
                showToast("Notes Deleted")
    

            });


            // APPEND CONTENT

            contentDiv.appendChild(noteText);
            contentDiv.appendChild(timestamp);


            // APPEND BUTTONS

            buttonContainer.appendChild(editNoteBtn);
            buttonContainer.appendChild(deleteBtn);


            // APPEND EVERYTHING

            todoDiv.appendChild(contentDiv);
            todoDiv.appendChild(buttonContainer);

            notesContainer.appendChild(todoDiv);


            // CLEAR INPUT

            inputValue.value = "";
           
           if(!savedText){
               saveNotes();
               showToast("Notes Added");
               
         } 
        }
        
     // LOCALSTORAGE logic 
     //this will save notes to localStorage 
      // notes will persist on refresh 
      
     function saveNotes(){
        const allNotes = [];
        const noteDivs = document.querySelectorAll(".todoDiv p");
        
      //update required here to 
      // persist timestamp 
      // koma ndikufuna kugona lol 
      
          noteDivs.forEach(function(p){
                allNotes.push(p.textContent);
                 });
                 
            localStorage.setItem("SnapNotes", JSON.stringify(allNotes));
             }
             
             
   function loadNotes(){
    const savedNotes = localStorage.getItem("SnapNotes");
    if(savedNotes === null){
        return;
    }
    
        const notesArray = JSON.parse(savedNotes);

    notesArray.forEach(function(note){

        addNote(note);
       //  showToast("Notes Added");
        

    });
        
} 

  // TOAST   NOTIFICATION        
const toast = document.getElementById("toast");


function showToast(message){

    toast.textContent = message;

    toast.style.opacity = "1";

    setTimeout(function(){

        toast.style.opacity = "0";

    }, 2000);

}
             
      
      loadNotes();
      
