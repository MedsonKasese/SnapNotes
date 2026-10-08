// =========================
// RECURRING REMINDERS
// =========================

const REMINDER_RECURRENCE_OPTIONS = {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    yearly: "Yearly"
};

function normalizeReminderRecurrence(value, anchorDate = null) {
    if (!value) return null;

    let frequency = "";
    let interval = 1;
    let anchorDay = null;
    let anchorMonth = null;

    if (typeof value === "string") {
        frequency = value.toLowerCase();
    } else {
        frequency = String(value.frequency || "").toLowerCase();
        interval = Number(value.interval) || 1;
        anchorDay = Number(value.anchorDay) || null;
        anchorMonth = Number(value.anchorMonth);
        if (!Number.isInteger(anchorMonth) || anchorMonth < 0 || anchorMonth > 11) {
            anchorMonth = null;
        }
    }

    if (!REMINDER_RECURRENCE_OPTIONS[frequency]) return null;

    interval = Math.max(1, Math.min(365, Math.floor(interval)));

    const anchor = anchorDate ? new Date(anchorDate) : null;
    if (anchor && !Number.isNaN(anchor.getTime())) {
        if (!anchorDay) anchorDay = anchor.getDate();
        if (frequency === "yearly" && anchorMonth === null) {
            anchorMonth = anchor.getMonth();
        }
    }

    const result = { frequency, interval };

    if (frequency === "monthly" || frequency === "yearly") {
        if (anchorDay) result.anchorDay = Math.max(1, Math.min(31, Math.floor(anchorDay)));
    }

    if (frequency === "yearly" && anchorMonth !== null) {
        result.anchorMonth = anchorMonth;
    }

    return result;
}

function getReminderRecurrenceLabel(value) {
    const recurrence = normalizeReminderRecurrence(value);
    if (!recurrence) return "";

    const unit = REMINDER_RECURRENCE_OPTIONS[recurrence.frequency].toLowerCase();
    return recurrence.interval === 1
        ? "Repeats " + unit
        : "Repeats every " + recurrence.interval + " " + unit;
}

function getDaysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
}

function addRecurringDate(date, recurrence) {
    const next = new Date(date.getTime());
    const normalized = normalizeReminderRecurrence(recurrence, date);
    if (!normalized) return null;

    if (normalized.frequency === "daily") {
        next.setDate(next.getDate() + normalized.interval);
        return next;
    }

    if (normalized.frequency === "weekly") {
        next.setDate(next.getDate() + (7 * normalized.interval));
        return next;
    }

    if (normalized.frequency === "monthly") {
        const anchorDay = normalized.anchorDay || date.getDate();
        next.setDate(1);
        next.setMonth(next.getMonth() + normalized.interval);
        next.setDate(Math.min(anchorDay, getDaysInMonth(next.getFullYear(), next.getMonth())));
        return next;
    }

    const anchorMonth = normalized.anchorMonth ?? date.getMonth();
    const anchorDay = normalized.anchorDay || date.getDate();
    next.setDate(1);
    next.setFullYear(next.getFullYear() + normalized.interval);
    next.setMonth(anchorMonth);
    next.setDate(Math.min(anchorDay, getDaysInMonth(next.getFullYear(), anchorMonth)));
    return next;
}

function getNextReminderAt(currentReminderAt, recurrence, fromTime = Date.now()) {
    const current = new Date(currentReminderAt);
    const normalized = normalizeReminderRecurrence(recurrence, current);

    if (!normalized || Number.isNaN(current.getTime())) return null;

    let next = addRecurringDate(current, normalized);
    let guard = 0;

    while (next && next.getTime() <= fromTime && guard < 1000) {
        next = addRecurringDate(next, normalized);
        guard++;
    }

    return next ? next.toISOString() : null;
}

function formatReminderDateTimeLocal(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    const pad = number => String(number).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
    ].join("-") + "T" + [
        pad(date.getHours()),
        pad(date.getMinutes())
    ].join(":");
}

function parseReminderDateTimeLocal(value) {
    if (!value) return null;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    return date.toISOString();
}

function hasRecurringReminder(value) {
    return Boolean(normalizeReminderRecurrence(value));
}

window.REMINDER_RECURRENCE_OPTIONS = REMINDER_RECURRENCE_OPTIONS;
window.normalizeReminderRecurrence = normalizeReminderRecurrence;
window.getReminderRecurrenceLabel = getReminderRecurrenceLabel;
window.getNextReminderAt = getNextReminderAt;
window.formatReminderDateTimeLocal = formatReminderDateTimeLocal;
window.parseReminderDateTimeLocal = parseReminderDateTimeLocal;
window.hasRecurringReminder = hasRecurringReminder;
