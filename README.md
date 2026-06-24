# SnapNotes

**Save Your Mind.**

SnapNotes is a modern, feature-rich note-taking web application meticulously crafted with vanilla HTML, CSS, and JavaScript. Designed for simplicity and efficiency, it provides a seamless experience for organizing your thoughts and tasks without the overhead of external frameworks or libraries.

**View Live:** [https://snap-notes-plus.vercel.app](https://snapnotesmw.vercel.app)

## Features

SnapNotes offers a comprehensive set of features to enhance your note-taking experience:

| Feature | Description |
|---|---|
| **localStorage Persistence** | Notes are automatically saved and retrieved from your browser's local storage, ensuring your data persists across sessions. |
| **Persistent Timestamps** | Each note displays its creation date and time, formatted as "Created On: DD Month YYYY at HH:MM AM/PM", for easy tracking. |
| **Dark Mode with Theme Memory** | Toggle between light and dark themes. Your preference is saved in local storage and applied automatically on subsequent visits. |
| **Inline Editing** | Edit notes directly within their cards. Press `Enter` to save changes or `Escape` to cancel, eliminating disruptive pop-up prompts. |
| **Delete Confirmation Dialog** | A clear confirmation dialog prevents accidental deletion of notes. |
| **Toast Notifications** | Receive subtle, type-based (success, warning, delete, update) toast notifications for all key actions, providing immediate feedback. |
| **Real-time Search/Filter** | Instantly search and filter your notes as you type, making it easy to find specific information quickly. |
| **Category System** | Organize notes into predefined categories: General, Work, Personal, Ideas, and Important. |
| **Color-Coded Borders** | Each category is visually distinguished with a unique color-coded border for quick identification. |
| **Category Filtering Dropdown** | Filter notes by category using a convenient dropdown menu. |
| **Pin/Unpin Notes** | Pin important notes to the top of your list for easy access; unpinned notes return to their original position. |
| **Character Limit with Live Counter** | Notes are limited to 200 characters, with a live counter to help you stay concise. |
| **Empty State Message** | A friendly message is displayed when no notes exist, guiding new users. |
| **Note Counter Display** | Keep track of your total number of notes with a clear counter display. |
| **Fade-in Animations** | Enjoy a smooth user experience with subtle fade-in animations when notes are added or updated. |
| **Ellipsis Menu (⋮)** | Each note card features a discreet ellipsis (⋮) button, revealing a dropdown with Share, Edit, and Delete options for a cleaner UI. |
| **Share Functionality** | Share your notes effortlessly. On mobile devices, this utilizes the native Web Share API; otherwise, it provides a clipboard copy as a fallback. |
| **Drag and Drop Reordering** | Reorder your notes by dragging and dropping them into your preferred position. Supports both desktop (mouse) and mobile (touch) interactions. |
| **Modular Code Structure** | The application is built with a clean, modular code structure (`storage.js`, `notes.js`, `app.js`), promoting maintainability and scalability. |

## Tech Stack

SnapNotes is built using fundamental web technologies, demonstrating the power of vanilla development:

- **HTML5**: For semantic structure and content organization.
- **CSS3**: For styling, responsive design, and dynamic visual effects, including custom properties and animations.
- **JavaScript (ES6+)**: For all application logic, DOM manipulation, local storage management, and interactive features.

## How to Use

Getting started with SnapNotes is straightforward:

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/MedsonKasese/SnapNotes.git
    ```
2.  **Navigate to the project directory:**
    ```bash
    cd SnapNotes
    ```
3.  **Open `index.html`:** Simply open the `index.html` file in your preferred web browser.

No build tools, no dependencies, and no complex setup required. Just open and start taking notes!

## Author

**Medson Kasese**

This project was developed by Medson Kasese, showcasing a commitment to clean code and robust vanilla JavaScript development.

## License

This project is licensed under the [MIT License](LICENSE).
