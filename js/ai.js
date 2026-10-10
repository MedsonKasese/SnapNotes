(() => {
  const dialog = document.getElementById("askMyNotesDialog");
  const editor = document.getElementById("noteEditor");
  const editorButton = document.getElementById("askMyNotesBtn");
  if (!dialog || !editor || !editorButton) return;

  const promptInput = document.getElementById("askMyNotesPrompt");
  const improveButton = document.getElementById("askMyNotesImprove");
  const searchButton = document.getElementById("askMyNotesSearch");
  const status = document.getElementById("askMyNotesStatus");
  const resultPanel = document.getElementById("askMyNotesResult");
  const resultText = document.getElementById("askMyNotesResultText");
  const answerPanel = document.getElementById("askMyNotesAnswer");
  const answerText = document.getElementById("askMyNotesAnswerText");
  const sources = document.getElementById("askMyNotesSources");
  const applyButton = document.getElementById("askMyNotesApply");
  const copyButton = document.getElementById("askMyNotesCopy");
  let lastImprovement = "";
  let lastAction = "";
  let busy = false;

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle("is-error", error);
  }

  function openDialog(action = "improve") {
    if (!window.firebaseAuth?.currentUser) {
      window.showToast?.("Sign in to use Ask My Notes.", "warning");
      document.getElementById("loginBtn")?.click();
      return;
    }
    lastAction = action;
    promptInput.value = action === "improve"
      ? "Improve the wording and organise this note while preserving my meaning."
      : "";
    resultPanel.hidden = true;
    answerPanel.hidden = true;
    setStatus("Your note content is sent to Google Gemini only after you confirm.");
    dialog.hidden = false;
    dialog.setAttribute("aria-hidden", "false");
    promptInput.focus();
  }

  function closeDialog() {
    dialog.hidden = true;
    dialog.setAttribute("aria-hidden", "true");
  }

  function readEditorTitleAndBody() {
    const lines = editor.innerText.replace(/\r/g, "").split("\n");
    const firstIndex = lines.findIndex(line => line.trim());
    if (firstIndex < 0) return { title: "", body: "" };

    const firstLine = lines[firstIndex].trim();
    const titleMatch = firstLine.match(/^##\s*(.*?)\s*#*$/);
    if (!titleMatch || !titleMatch[1].trim()) {
      return { title: "", body: lines.join("\n").trim().slice(0, 1500) };
    }

    return {
      title: titleMatch[1].trim(),
      body: lines.slice(firstIndex + 1).join("\n").trim().slice(0, 1500)
    };
  }

  function getEligibleNotes() {
    return (Array.isArray(window.notes) ? window.notes : [])
      .filter(note => note && note.isPrivate !== true && !note.deletedAt && !note.archived &&
        !note.syncConflict && typeof note.text === "string")
      .slice(0, 8)
      .map(note => ({
        id: String(note.id || ""),
        title: String(note.title || "Untitled note"),
        text: String(note.text).slice(0, 1500),
        category: String(note.category || ""),
        tags: Array.isArray(note.tags) ? note.tags.slice(0, 10) : []
      }));
  }

  async function requestAI(action) {
    if (busy) return;
    const user = window.firebaseAuth?.currentUser;
    if (!user) {
      window.showToast?.("Sign in to use Ask My Notes.", "warning");
      closeDialog();
      document.getElementById("loginBtn")?.click();
      return;
    }
    const prompt = promptInput.value.trim();
    if (!prompt) {
      setStatus("Enter an instruction or question first.", true);
      promptInput.focus();
      return;
    }
    const noteParts = readEditorTitleAndBody();
    const text = noteParts.body || editor.innerText.trim().slice(0, 1500);
    if (action === "improve" && !text) {
      setStatus("Write something in the editor before asking AI to improve it.", true);
      return;
    }
    const eligibleNotes = getEligibleNotes();
    if (action === "search" && !eligibleNotes.length) {
      setStatus("No eligible regular notes are available. Private, archived and trashed notes are excluded.", true);
      return;
    }

    const consentText = action === "improve"
      ? "Send the current note text to Google Gemini to improve it? Do not continue if this note contains private or sensitive information. Private notes are excluded from this feature."
      : "Send up to 8 regular notes (excluding private, archived and trashed notes) to Google Gemini to answer your question? Google may process submitted content under its API terms.";
    if (!window.confirm(consentText)) return;

    busy = true;
    improveButton.disabled = true;
    searchButton.disabled = true;
    setStatus("Working…");
    resultPanel.hidden = true;
    answerPanel.hidden = true;
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(action === "improve"
          ? { action, prompt, note: { title: noteParts.title, text } }
          : { action, prompt })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "The AI request failed. Please try again.");
      if (action === "improve") {
        lastImprovement = window.normalizeAskMyNotesResult(payload.result, noteParts.title);
        if (!lastImprovement) throw new Error("The AI returned an empty result.");
        resultText.textContent = lastImprovement;
        resultPanel.hidden = false;
      } else {
        answerText.textContent = String(payload.answer || "No answer found.");
        sources.replaceChildren();
        (Array.isArray(payload.sources) ? payload.sources : []).forEach(source => {
          const item = document.createElement("li");
          const title = document.createElement("strong");
          title.textContent = source.title || "Untitled note";
          const excerpt = document.createElement("p");
          excerpt.textContent = source.excerpt || "";
          item.append(title, excerpt);
          sources.append(item);
        });
        answerPanel.hidden = false;
      }
      lastAction = action;
      setStatus("Done. Review the result before applying or copying it.");
    } catch (error) {
      setStatus(error.message || "AI request failed. Check your connection and try again.", true);
    } finally {
      busy = false;
      improveButton.disabled = false;
      searchButton.disabled = false;
    }
  }

  editorButton.addEventListener("click", () => openDialog("improve"));
  document.getElementById("askMyNotesClose")?.addEventListener("click", closeDialog);
  dialog.addEventListener("click", event => { if (event.target === dialog) closeDialog(); });
  improveButton.addEventListener("click", () => requestAI("improve"));
  searchButton.addEventListener("click", () => requestAI("search"));
  applyButton.addEventListener("click", () => {
    if (!lastImprovement) return;
    // Re-normalise before applying so an edited preview can never turn a
    // Markdown H1 into an untitled SnapNotes note.
    editor.textContent = window.normalizeAskMyNotesResult(lastImprovement, readEditorTitleAndBody().title);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    editor.focus();
    setStatus("Improvement applied to the editor. Save the note to keep it.");
    resultPanel.hidden = true;
  });
  copyButton.addEventListener("click", async () => {
    if (!lastImprovement) return;
    try {
      await navigator.clipboard.writeText(lastImprovement);
      setStatus("Improved note copied.");
    } catch {
      setStatus("Clipboard access failed. Select the result text and copy it manually.", true);
    }
  });
})();
