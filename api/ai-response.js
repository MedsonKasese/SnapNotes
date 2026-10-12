// Gemini may return a JSON object, a fenced JSON object, or JSON encoded as a string.
// Never render an unparsed provider object as the user-facing answer.
export function parseNoteSearchResponse(raw) {
  let value = raw;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (typeof value === "string") {
      const text = value.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/i, "");
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("Gemini returned invalid JSON for the note search.");
      }
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (typeof value.answer !== "string" || !value.answer.trim()) {
        throw new Error("Gemini returned a response without an answer.");
      }
      if (value.sources !== undefined && !Array.isArray(value.sources)) {
        throw new Error("Gemini returned invalid note sources.");
      }
      return { answer: value.answer.trim(), sources: value.sources || [] };
    }
    throw new Error("Gemini returned an unexpected note search response.");
  }
  throw new Error("Gemini returned a nested response that could not be parsed.");
}
