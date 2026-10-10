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

    if (title) {
        const repeatedTitleIndex = bodyLines.findIndex(line => {
            const plain = line.trim().replace(/^title\s*:\s*/i, "").trim();
            return plain.toLowerCase() === title.toLowerCase() ||
                markdownHeadingText(line).toLowerCase() === title.toLowerCase();
        });
        if (repeatedTitleIndex >= 0) bodyLines.splice(repeatedTitleIndex, 1);

        const leadingHeadingIndex = bodyLines.findIndex(line => line.trim());
        if (leadingHeadingIndex >= 0 && /^#{1,6}\s*/.test(bodyLines[leadingHeadingIndex].trim())) {
            bodyLines.splice(leadingHeadingIndex, 1);
        }
    }

    const finalTitle = title || (() => {
        const index = bodyLines.findIndex(line => line.trim());
        return index >= 0 ? markdownHeadingText(bodyLines[index]) : "";
    })();
    if (!title && finalTitle) {
        const index = bodyLines.findIndex(line => line.trim());
        bodyLines.splice(index, 1);
    }

    const body = bodyLines.join("\n").trim();
    return finalTitle ? `## ${finalTitle}${body ? `\n\n${body}` : ""}` : body;
}

window.normalizeAskMyNotesResult = normalizeAskMyNotesResult;
