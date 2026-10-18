// Reminder date conversion and recurrence helpers. Kept as a classic browser script.
function formatReminderDateTimeLocal(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = number => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function parseReminderDateTimeLocal(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const REMINDER_FREQUENCIES = new Set(["daily", "weekly", "monthly"]);
const REMINDER_ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i;
const reminderFormatterCache = new Map();

function reminderInstant(value) {
    if (typeof value !== "string" || !REMINDER_ISO_RE.test(value)) return null;
    if (!reminderUtcDateParts(value.slice(0, 10))) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function reminderFormatter(timeZone) {
    if (!reminderFormatterCache.has(timeZone)) {
        reminderFormatterCache.set(timeZone, new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
            timeZone, year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
        }));
    }
    return reminderFormatterCache.get(timeZone);
}

function reminderZonedParts(timestamp, timeZone) {
    const values = {};
    for (const part of reminderFormatter(timeZone).formatToParts(new Date(timestamp))) {
        if (part.type !== "literal") values[part.type] = Number(part.value);
    }
    return { year: values.year, month: values.month, day: values.day,
        hour: values.hour, minute: values.minute, second: values.second };
}

function reminderUtcDateParts(dateString) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
    return { year, month, day };
}

function reminderAnchorParts(anchorAt, timeZone) {
    if (typeof anchorAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(anchorAt)) {
        return reminderUtcDateParts(anchorAt);
    }
    const timestamp = reminderInstant(anchorAt);
    return timestamp === null ? null : reminderZonedParts(timestamp, timeZone);
}

function normalizeReminderRepeat(value, reminderAt) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !REMINDER_FREQUENCIES.has(value.frequency)) return null;
    if (!Number.isInteger(value.interval) || value.interval < 1 || value.interval > 365) return null;
    if (typeof value.timeZone !== "string" || !value.timeZone.trim()) return null;
    const timeZone = value.timeZone.trim();
    try { reminderFormatter(timeZone); } catch { return null; }
    const anchorAt = value.anchorAt ?? reminderAt;
    if (typeof anchorAt !== "string" || !REMINDER_ISO_RE.test(anchorAt)) return null;
    const dateOnlyAnchor = /^\d{4}-\d{2}-\d{2}$/.test(anchorAt);
    const anchorTimestamp = dateOnlyAnchor ? null : reminderInstant(anchorAt);
    const anchorParts = reminderAnchorParts(anchorAt, timeZone);
    if (anchorParts === null || (anchorTimestamp === null && !dateOnlyAnchor)) return null;
    const normalizedAnchor = anchorTimestamp === null ? anchorAt : new Date(anchorTimestamp).toISOString();
    return { frequency: value.frequency, interval: value.interval, timeZone, anchorAt: normalizedAnchor };
}

function reminderCivilTimestamp(parts) {
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
}

function reminderLocalToInstant(parts, timeZone) {
    const target = reminderCivilTimestamp(parts);
    const offsets = new Set();
    for (let hours = -48; hours <= 48; hours += 6) {
        const sample = target + hours * 3600000;
        const local = reminderZonedParts(sample, timeZone);
        offsets.add(reminderCivilTimestamp(local) - Math.floor(sample / 1000) * 1000);
    }
    const candidates = [];
    for (const offset of offsets) {
        const instant = target - offset;
        const actual = reminderZonedParts(instant, timeZone);
        if (reminderCivilTimestamp(actual) === target) candidates.push(instant);
    }
    if (candidates.length) return Math.min(...candidates);
    // Shift nonexistent spring-forward wall times by the DST gap, preserving minutes.
    const after = [];
    for (const offset of offsets) {
        const instant = target - offset;
        const actual = reminderZonedParts(instant, timeZone);
        const localValue = reminderCivilTimestamp(actual);
        if (localValue > target) after.push({ instant, delta: localValue - target });
    }
    if (after.length) return after.sort((a, b) => a.delta - b.delta || a.instant - b.instant)[0].instant;
    return target;
}

function reminderDateAtIndex(anchor, frequency, interval, index) {
    if (frequency === "monthly") {
        const monthIndex = anchor.year * 12 + anchor.month - 1 + interval * index;
        const year = Math.floor(monthIndex / 12), month = ((monthIndex % 12) + 12) % 12 + 1;
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        return { year, month, day: Math.min(anchor.day, lastDay) };
    }
    const step = interval * (frequency === "weekly" ? 7 : 1) * index;
    const date = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day + step));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function getNextReminderOccurrence(reminderAt, repeat, now = Date.now()) {
    const start = reminderInstant(reminderAt);
    const normalized = normalizeReminderRepeat(repeat, reminderAt);
    if (start === null || !normalized) return null;
    const nowTimestamp = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(nowTimestamp)) return null;
    const anchor = reminderAnchorParts(normalized.anchorAt, normalized.timeZone);
    if (!anchor) return null;
    const anchorTimestamp = reminderInstant(normalized.anchorAt);
    const clock = reminderZonedParts(anchorTimestamp === null ? start : anchorTimestamp, normalized.timeZone);
    const localNow = reminderZonedParts(nowTimestamp, normalized.timeZone);
    const localDay = p => Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
    let index = 0;
    if (normalized.frequency === "monthly") {
        const monthDelta = (localNow.year - anchor.year) * 12 + localNow.month - anchor.month;
        index = Math.max(0, Math.floor(monthDelta / normalized.interval) - 1);
    } else {
        const days = localDay(localNow) - localDay(anchor);
        const period = normalized.interval * (normalized.frequency === "weekly" ? 7 : 1);
        index = Math.max(0, Math.floor(days / period) - 1);
    }
    // Calendar-based estimation makes catch-up constant-time even for very old reminders.
    for (let attempts = 0; attempts < 5; attempts++, index++) {
        const date = reminderDateAtIndex(anchor, normalized.frequency, normalized.interval, index);
        const occurrence = reminderLocalToInstant({ ...date, hour: clock.hour, minute: clock.minute, second: 0 }, normalized.timeZone);
        if (occurrence > nowTimestamp) return new Date(occurrence).toISOString();
    }
    return null;
}

function formatReminderRepeat(repeat) {
    const normalized = normalizeReminderRepeat(repeat, repeat && repeat.anchorAt);
    if (!normalized) return "";
    const unit = normalized.frequency === "daily" ? "day" : normalized.frequency === "weekly" ? "week" : "month";
    return `Every ${normalized.interval === 1 ? "" : `${normalized.interval} `}${unit}${normalized.interval === 1 ? "" : "s"}`;
}

function getReminderCompletionState(note, now = Date.now()) {
    const current = note && typeof note === "object" ? note : {};
    const repeat = normalizeReminderRepeat(current.reminderRepeat, current.reminderAt);
    const next = repeat ? getNextReminderOccurrence(current.reminderAt, repeat, now) : null;
    return { reminderAt: next || current.reminderAt || null, reminderNotified: !next };
}

window.formatReminderDateTimeLocal = formatReminderDateTimeLocal;
window.parseReminderDateTimeLocal = parseReminderDateTimeLocal;
window.normalizeReminderRepeat = normalizeReminderRepeat;
window.getNextReminderOccurrence = getNextReminderOccurrence;
window.formatReminderRepeat = formatReminderRepeat;
window.getReminderCompletionState = getReminderCompletionState;
