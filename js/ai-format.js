function markdownHeadingText(line) {
    const match = String(line || "").trim().match(/^#{1,6}\s*(.*?)\s*#*$/);
    return match?.[1]?.trim() || "";
}

function normalizeAskMyNotesResult(value, preservedTitle = "") {
    let text = String(value || "").replace(/\r\n?/g, "\n").trim();
    if (!text) return "";

    text = text.replace(/^```(?:markdown|md|text)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const lines = text.split("\n");
    const title = String(preservedTitle || "").trim();
    const bodyLines = lines.slice();
    const firstIndex = bodyLines.findIndex(line => line.trim());

    if (firstIndex >= 0 && /^(?:#\s*)?snapnotes$/i.test(bodyLines[firstIndex].trim())) {
        bodyLines.splice(firstIndex, 1);
    }

    // The first Markdown heading is the AI's editable title. Normalize any
    // heading level to SnapNotes' required `## Title` format. If the model
    // follows the older body-only contract, retain the editor's title.
    const titleIndex = bodyLines.findIndex(line => line.trim());
    const returnedTitle = titleIndex >= 0 ? markdownHeadingText(bodyLines[titleIndex]) : "";
    const finalTitle = returnedTitle || title;
    if (returnedTitle) bodyLines.splice(titleIndex, 1);

    const body = bodyLines.join("\n").trim();
    return finalTitle ? `## ${finalTitle}${body ? `\n\n${body}` : ""}` : body;
}

window.normalizeAskMyNotesResult = normalizeAskMyNotesResult;
