function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function subtitleLine(line) {
  const match = String(line).trim().match(/^\*\*(.+?)\*\*$/);
  return match?.[1]?.trim() || "";
}

export function renderSubtitleMarkdownText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => {
      const subtitle = subtitleLine(line);
      return subtitle
        ? `<h3 class="note-subtitle">${escapeHtml(subtitle)}</h3>`
        : escapeHtml(line);
    })
    .join("<br>");
}

export function formatSubtitleMarkdownInHtml(value, documentRef = globalThis.document) {
  const html = String(value || "");
  if (!documentRef?.createElement) return html;

  const root = documentRef.createElement("div");
  root.innerHTML = html;

  const blocks = [...root.querySelectorAll("div, p")].reverse();
  blocks.forEach(block => {
    if (block.querySelector("div, p, h3")) return;
    const subtitle = subtitleLine(block.textContent || "");
    if (!subtitle) return;
    const heading = documentRef.createElement("h3");
    heading.className = "note-subtitle";
    heading.textContent = subtitle;
    block.replaceWith(heading);
  });

  [...root.childNodes].forEach(node => {
    if (node.nodeType !== 3) return;
    const lines = node.textContent.replace(/\r\n?/g, "\n").split("\n");
    if (!lines.some(line => subtitleLine(line))) return;
    const fragment = documentRef.createDocumentFragment();
    lines.forEach((line, index) => {
      const subtitle = subtitleLine(line);
      if (subtitle) {
        const heading = documentRef.createElement("h3");
        heading.className = "note-subtitle";
        heading.textContent = subtitle;
        fragment.appendChild(heading);
      } else if (line) {
        fragment.appendChild(documentRef.createTextNode(line));
      }
      if (index < lines.length - 1 && !subtitle) fragment.appendChild(documentRef.createElement("br"));
    });
    node.replaceWith(fragment);
  });

  return root.innerHTML;
}

if (typeof window !== "undefined") {
  window.renderSubtitleMarkdownText = renderSubtitleMarkdownText;
  window.formatSubtitleMarkdownInHtml = formatSubtitleMarkdownInHtml;
}
