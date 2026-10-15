export const SNAPNOTES_DRAFTS_KEY = "SnapNotesDrafts";
export const SNAPNOTES_LEGACY_DRAFT_KEY = "SnapNotesDraft";

function makeDraftId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function legacyDraftId(draft) {
  const source = `${draft.savedAt || ""}\u0000${draft.content}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy-${(hash >>> 0).toString(36)}`;
}

export function readDrafts(storage = globalThis.localStorage) {
  if (!storage) return [];
  try {
    const value = JSON.parse(storage.getItem(SNAPNOTES_DRAFTS_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(draft => draft && typeof draft === "object" && typeof draft.content === "string")
      .map(draft => ({ ...draft, id: String(draft.id || makeDraftId()) }));
  } catch {
    return [];
  }
}

export function writeDrafts(drafts, storage = globalThis.localStorage) {
  if (!storage) return [];
  const validDrafts = (Array.isArray(drafts) ? drafts : [])
    .filter(draft => draft && typeof draft === "object" && typeof draft.content === "string")
    .map(draft => ({ ...draft, id: String(draft.id || makeDraftId()) }));
  storage.setItem(SNAPNOTES_DRAFTS_KEY, JSON.stringify(validDrafts));
  return validDrafts;
}

export function upsertDraft(draft, storage = globalThis.localStorage) {
  if (!draft || typeof draft !== "object" || typeof draft.content !== "string") {
    throw new TypeError("A draft must include its editor content.");
  }
  const normalized = { ...draft, id: String(draft.id || makeDraftId()) };
  const drafts = readDrafts(storage);
  const index = drafts.findIndex(item => item.id === normalized.id);
  if (index === -1) drafts.unshift(normalized);
  else drafts[index] = normalized;
  writeDrafts(drafts, storage);
  return normalized;
}

export function removeDraft(id, storage = globalThis.localStorage) {
  const drafts = readDrafts(storage).filter(draft => draft.id !== String(id));
  writeDrafts(drafts, storage);
  return drafts;
}

export function migrateLegacyDraft(storage = globalThis.localStorage) {
  if (!storage) return [];
  const legacy = storage.getItem(SNAPNOTES_LEGACY_DRAFT_KEY);
  if (!legacy) return readDrafts(storage);

  try {
    const draft = JSON.parse(legacy);
    if (draft && typeof draft.content === "string" && draft.content.trim()) {
      upsertDraft({
        ...draft,
        id: draft.id || legacyDraftId(draft),
        text: typeof draft.text === "string" ? draft.text : "",
        savedAt: draft.savedAt || new Date().toISOString()
      }, storage);
    }
  } finally {
    storage.removeItem(SNAPNOTES_LEGACY_DRAFT_KEY);
  }

  return readDrafts(storage);
}

if (typeof window !== "undefined") {
  window.SnapNotesDrafts = {
    read: readDrafts,
    write: writeDrafts,
    upsert: upsertDraft,
    remove: removeDraft,
    migrateLegacy: migrateLegacyDraft
  };
}
