// Only this allowlist may leave the browser. Never spread a readable note here.
function repeatKey(repeat) {
    if (!repeat) return null;
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(repeat.anchorAt || "")
        ? repeat.anchorAt : instant(repeat.anchorAt);
    return [repeat.frequency, repeat.interval, repeat.timeZone, anchor];
}
function instant(value) {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
export function scheduleMatches(note, state, source = true) {
    if (!note || !state || note.id !== state.noteId || Boolean(note.isPrivate) !== Boolean(state.isPrivate)) return false;
    const at = source ? state.sourceReminderAt : state.reminderAt;
    const notified = source ? state.sourceReminderNotified : state.reminderNotified;
    const repeat = source ? state.sourceReminderRepeat : state.reminderRepeat;
    return instant(note.reminderAt) === instant(at)
        && Boolean(note.reminderNotified) === Boolean(notified)
        && JSON.stringify(repeatKey(note.reminderRepeat)) === JSON.stringify(repeatKey(repeat));
}
export function projectReminderMetadata(notes, { includePrivate = false, unlocked = false, readPrivate = note => note } = {}) {
    const result = [];
    for (const raw of notes || []) {
        if (!raw?.id || raw.deletedAt || raw.archived) continue;
        if (raw.isPrivate && (!includePrivate || !unlocked)) continue;
        const note = raw.isPrivate ? readPrivate(raw) : raw;
        if (!note?.reminderAt || !instant(note.reminderAt)) continue;
        const repeat = note.reminderRepeat;
        result.push({
            noteId: raw.id,
            reminderAt: instant(note.reminderAt),
            reminderNotified: Boolean(note.reminderNotified),
            reminderRepeat: repeat ? {
                frequency: repeat.frequency, interval: repeat.interval,
                timeZone: repeat.timeZone, anchorAt: repeat.anchorAt
            } : null,
            isPrivate: Boolean(raw.isPrivate),
            ...(raw.isPrivate ? { privateUpdatedAt: raw.updatedAt || "" } : {})
        });
    }
    return result;
}
export function vapidBytes(value) {
    const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0));
}
