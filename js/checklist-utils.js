export function replaceChecklistMarker(value, index, complete) {
  const source = String(value || "");
  if (!Number.isInteger(index) || index < 0) return source;
  let markerIndex = 0;
  return source.replace(/[☐☑]/g, marker => {
    const currentIndex = markerIndex++;
    if (currentIndex !== index) return marker;
    return complete ? "☑" : "☐";
  });
}

export function renderInteractiveChecklist(container, noteId) {
  const documentRef = container?.ownerDocument;
  const NodeFilterRef = documentRef?.defaultView?.NodeFilter;
  if (!container || !documentRef?.createTreeWalker || !NodeFilterRef) return;

  const textNodes = [];
  const walker = documentRef.createTreeWalker(container, NodeFilterRef.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (/[☐☑]/.test(node.nodeValue || "")) textNodes.push(node);
  }

  let itemIndex = 0;
  for (const node of textNodes) {
    const source = node.nodeValue || "";
    const markerPattern = /([☐☑])([^\r\n]*)/g;
    const fragment = documentRef.createDocumentFragment();
    let cursor = 0;
    let match;

    while ((match = markerPattern.exec(source))) {
      if (match.index > cursor) fragment.appendChild(documentRef.createTextNode(source.slice(cursor, match.index)));

      const complete = match[1] === "☑";
      const taskText = match[2].trim();
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "checklist-checkbox";
      button.dataset.checklistToggle = "true";
      button.dataset.noteId = String(noteId || "");
      button.dataset.checklistIndex = String(itemIndex++);
      button.setAttribute("role", "checkbox");
      button.setAttribute("aria-checked", String(complete));
      button.setAttribute("aria-label", `${complete ? "Mark" : "Complete"} ${taskText || "task"} ${complete ? "as not complete" : ""}`.trim());
      button.title = complete ? "Mark as not complete" : "Mark as complete";
      const checkmark = documentRef.createElement("span");
      checkmark.className = "checklist-checkbox-mark";
      checkmark.setAttribute("aria-hidden", "true");
      checkmark.textContent = complete ? "✓" : "";
      button.appendChild(checkmark);

      const label = documentRef.createElement("span");
      label.className = "checklist-item-text";
      if (complete) label.classList.add("is-complete");
      label.textContent = match[2];
      fragment.append(button, label);
      cursor = markerPattern.lastIndex;
    }

    if (cursor < source.length) fragment.appendChild(documentRef.createTextNode(source.slice(cursor)));
    node.replaceWith(fragment);
  }
}

if (typeof window !== "undefined") {
  window.replaceChecklistMarker = replaceChecklistMarker;
  window.renderInteractiveChecklist = renderInteractiveChecklist;
}
