# SnapNotes 

**Save Your Mind.**

SnapNotes is a modern, feature-rich note-taking web application built entirely with vanilla HTML, CSS, and JavaScript. No frameworks, no libraries — just clean, hand-written code.

---

## Features

| Feature | Description |
|---------|-------------|
| **Create & Delete Notes** | Add notes instantly and delete with confirmation |
| **Inline Editing** | Edit notes directly inside the card — no popups |
| **Persistent Storage** | Notes survive page refresh using localStorage |
| **Dark Mode** | Toggle between light and dark themes (remembered across sessions) |
| **Categories** | Organize notes by category: General, Work, Personal, Ideas, Important |
| **Category Filtering** | Filter notes by category with a dropdown |
| **Color-Coded Borders** | Each category has a unique color for quick visual identification |
| **Pin Notes** | Pin important notes to the top of the list |
| **Search** | Instantly search through all notes by content |
| **Character Limit** | Live character counter with 200-character max |
| **Timestamps** | Each note displays its original creation date and time |
| **Toast Notifications** | Contextual feedback messages for every action |
| **Keyboard Shortcuts** | Enter to add/save, Escape to cancel editing |
| **Responsive Design** | Works on desktop and mobile devices |
| **Animations** | Smooth fade-in animations when notes are added |

---

## Technologies Used

- **HTML5** — Semantic structure
- **CSS3** — Custom properties (variables), Flexbox, animations, media queries
- **JavaScript (ES6)** — DOM manipulation, localStorage API, event handling

---

## How to Run

1. Clone this repository:
   ```bash
   git clone https://github.com/MedsonKasese/SnapNotes.git
   ```

2. Open `index.html` in your browser.

That's it. No build tools, no dependencies, no setup required.

---

## Project Structure

```
SnapNotes/
├── index.html      # App structure and layout
├── styles.css      # All styling including dark mode and responsive design
├── script.js       # App logic, localStorage, and event handling
├── LICENSE         # MIT License
└── README.md       # This file
```

---

## What I Learned

Building SnapNotes taught me:

- How to use **localStorage** to persist data across sessions
- How to implement **inline editing** without browser prompts
- How to build a **dark mode** toggle with CSS variables
- How to structure a growing JavaScript project with clean code organization
- How to handle **DOM manipulation** at scale (creating, appending, removing elements)
- How to implement **search and filter** functionality from scratch
- The importance of **user experience** — confirmations, keyboard shortcuts, and visual feedback

---

## Future Improvements

- [ ] Export notes as .txt or .json file
- [ ] Drag-and-drop to reorder notes
- [ ] Undo delete with timed toast
- [ ] Sort notes (by date, alphabetical, category)
- [ ] Smooth delete animation (fade out)
- [ ] Multi-select and bulk delete

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Author

**Medson Kasese**

Built with determination and vanilla JavaScript. No frameworks needed.
