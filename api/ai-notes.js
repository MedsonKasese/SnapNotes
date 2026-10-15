export const MAX_NOTE_COUNT = 8;
export const MAX_NOTE_CHARS = 1500;

export function safeNotes(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(note =>
    note && typeof note === "object" && !Array.isArray(note) &&
    note.isPrivate !== true && !note.deletedAt && !note.archived && !note.syncConflict &&
    typeof note.text === "string"
  ).slice(0, MAX_NOTE_COUNT).map(note => ({
    id: String(note.id || "").slice(0, 120),
    title: String(note.title || "Untitled note").slice(0, 180),
    text: note.text.slice(0, MAX_NOTE_CHARS),
    category: String(note.category || "").slice(0, 40),
    tags: Array.isArray(note.tags) ? note.tags.slice(0, 10).map(tag => String(tag).slice(0, 40)) : []
  }));
}
