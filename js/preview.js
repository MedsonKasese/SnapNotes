/* Preivew,js
   Wires up the Write / Preview toggle that already exists in
   index.html (#writeTabBtn, #previewTabBtn, #noteEditor,
   #notePreview) and keeps the rendered pane in sync with whatever
   is currently in the editor.

   Pipeline:  contentEditable HTML  ->  markdown  ->  safe HTML

   Why go through markdown instead of just printing the editor's
   HTML? Because that is the format SnapNotes already speaks:
   notes.js renders inline markdown patterns into the saved HTML,
   app.js treats a leading "## " as the title, and the Markdown
   export writes "text" straight out. Converting to markdown first
   means the preview shows exactly what a saved / exported /
   shared note will look like, including markdown the author typed
   literally ( **bold**, - lists, ☐ checklists, > quotes ...).

   Everything here is additive: it does not touch saveEditorNote(),
   the draft autosave, the note cards or any storage key.
   ========================================================== */
(function (global, document) {
    "use strict";

    var MD = global.SnapNotesMarkdown;
    var MODE_KEY = "SnapNotesEditorMode"; // remembers the last tab used
    var RENDER_DELAY = 140;               // ms of quiet typing before re-rendering

    var mode = "write";
    var renderTimer = null;
    var lastSource = null;
    var bound = false;

    /* ------------------------------------------------------
       Element lookups (done lazily so script order never matters)
       ------------------------------------------------------ */
    function editorEl() { return document.getElementById("noteEditor"); }
    function previewEl() { return document.getElementById("notePreview"); }
    function writeBtn() { return document.getElementById("writeTabBtn"); }
    function previewBtn() { return document.getElementById("previewTabBtn"); }

    /* ------------------------------------------------------
       Reading the editor
       ------------------------------------------------------ */
    /* Returns the note as markdown. Falls back to the plain text of
       the editor if the conversion produces nothing, so a preview is
       never blanked out while the user is mid-keystroke. */
    function readMarkdown() {
        var editor = editorEl();
        if (!editor) return "";

        var markdown = "";
        try {
            markdown = MD.htmlToMarkdown(editor.innerHTML);
        } catch (error) {
            console.warn("SnapNotes preview: falling back to plain text", error);
            markdown = editor.textContent || "";
        }

        if (!markdown || !markdown.trim()) {
            markdown = editor.textContent || "";
        }

        return markdown.replace(/\r\n?/g, "\n");
    }

    /* ------------------------------------------------------
       Rendering
       ------------------------------------------------------ */
    function renderPreview(force) {
        var preview = previewEl();
        if (!preview) return;

        var source = readMarkdown();

        /* The editor fires "input" for caret moves too (and IME
           composition), so skip work when the markdown is unchanged. */
        if (!force && source === lastSource) return;
        lastSource = source;

        var body = "";
        try {
            body = MD.render(source);
        } catch (error) {
            console.error("SnapNotes preview: markdown could not be rendered", error);
            body = "";
        }

        /* Exposed so other modules can tell generated output apart
           from authored HTML and reuse the exact source that was
           rendered (e.g. "copy as markdown"). */
        preview.setAttribute("data-md-source", source);

        if (!body.trim()) {
            preview.innerHTML = emptyStateMarkup();
            preview.classList.add("is-empty");
            return;
        }

        preview.classList.remove("is-empty");
        preview.innerHTML = bannerMarkup(source) + '<div class="md-body">' + body + "</div>";
    }

    function emptyStateMarkup() {
        return '<div class="preview-empty">' +
            '<i class="fa-regular fa-eye" aria-hidden="true"></i>' +
            "<p>Nothing to preview yet.</p>" +
            "<span>Start typing on the <strong>Write</strong> tab and the rendered note appears here.</span>" +
            "</div>";
    }

    function bannerMarkup(source) {
        var words = source.split(/\s+/).filter(Boolean).length;
        var minutes = Math.max(1, Math.round(words / 200));

        return '<div class="preview-banner">' +
            '<span class="preview-badge"><i class="fa-solid fa-eye" aria-hidden="true"></i>Preview</span>' +
            '<span class="preview-stats">' + words + " word" + (words === 1 ? "" : "s") +
            " &middot; " + minutes + " min read</span>" +
            "</div>";
    }

    function schedulePreview() {
        if (mode !== "preview") return;
        clearTimeout(renderTimer);
        renderTimer = setTimeout(function () { renderPreview(false); }, RENDER_DELAY);
    }

    /* ------------------------------------------------------
       Mode switching
       ------------------------------------------------------ */
    function setMode(next, options) {
        var settings = options || {};
        mode = next === "preview" ? "preview" : "write";

        var editor = editorEl();
        var preview = previewEl();
        var isPreview = mode === "preview";

        /* The `hidden` attribute is the single source of truth for
           which pane is visible (styles/styles.css makes it
           authoritative with .note-preview[hidden] { display: none }). */
        if (editor) editor.hidden = isPreview;
        if (preview) preview.hidden = !isPreview;

        /* Lets CSS hide the formatting toolbar and adjust the
           editor footer while previewing. */
        document.body.classList.toggle("editor-preview-mode", isPreview);

        var write = writeBtn();
        var previewButton = previewBtn();
        if (write) {
            write.classList.toggle("active", !isPreview);
            write.setAttribute("aria-pressed", String(!isPreview));
        }
        if (previewButton) {
            previewButton.classList.toggle("active", isPreview);
            previewButton.setAttribute("aria-pressed", String(isPreview));
        }

        if (isPreview) {
            renderPreview(true); // always fresh when the tab is opened
        } else if (!settings.silent) {
            /* Returning to Write hands focus back to the caret so the
               user can keep typing immediately. */
            if (editor) editor.focus();
        }

        try {
            localStorage.setItem(MODE_KEY, mode);
        } catch (error) { /* private mode: not worth interrupting the user */ }

        return mode;
    }

    function toggleMode() {
        return setMode(mode === "preview" ? "write" : "preview");
    }

    /* Called when a new note is started: back to Write, empty preview. */
    function reset() {
        lastSource = null;
        clearTimeout(renderTimer);
        setMode("write", { silent: true });
        renderPreview(true);
    }

    /* ------------------------------------------------------
       Wiring
       ------------------------------------------------------ */
    function bind() {
        if (bound) return;
        bound = true;

        var write = writeBtn();
        var previewButton = previewBtn();
        var editor = editorEl();

        if (write) write.addEventListener("click", function () { setMode("write"); });
        if (previewButton) previewButton.addEventListener("click", function () { setMode("preview"); });

        /* Keep the pane current while the author types. Listening on
           the section (not just the editor) also catches paste and
           programmatic draft restores. */
        if (editor) {
            editor.addEventListener("input", schedulePreview);
            editor.addEventListener("paste", function () {
                /* paste fires before the DOM is updated, so wait a tick */
                setTimeout(schedulePreview, 0);
            });
        }

        /* Ctrl/Cmd + Shift + P flips between Write and Preview,
           matching the Ctrl+K / Ctrl+N shortcuts app.js already owns. */
        document.addEventListener("keydown", function (event) {
            var modifier = event.ctrlKey || event.metaKey;
            if (modifier && event.shiftKey && event.key.toLowerCase() === "p") {
                event.preventDefault();
                toggleMode();
            }
        });
    }

    function init() {
        if (!MD) {
            /* markdown.js failed to load: leave the app fully usable
               and explain the Preview tab instead of doing nothing. */
            var button = previewBtn();
            if (button) {
                button.disabled = true;
                button.title = "Preview unavailable: js/markdown.js did not load";
            }
            console.error("SnapNotes preview: js/markdown.js is required for the Preview tab.");
            return;
        }

        bind();

        var saved = null;
        try { saved = localStorage.getItem(MODE_KEY); } catch (error) { saved = null; }

        setMode(saved === "preview" ? "preview" : "write", { silent: true });
        renderPreview(true);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    global.SnapNotesPreview = {
        setMode: setMode,
        toggle: toggleMode,
        reset: reset,
        refresh: function () { return renderPreview(true); },
        getMode: function () { return mode; },
        markdown: readMarkdown
    };
})(window, document);
