// =========================
// RECURRING REMINDERS
// =========================

const REMINDER_RECURRENCE_OPTIONS = {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    yearly: "Yearly"
};

function normalizeReminderRecurrence(value) {
    if (!value) return null;

    if (typeof value === "string") {
        return REMINDER_RECURRENCE_OPTIONS[value]
            ? { frequency: value, interval: 1 }
            : null;
    }

    const frequency = String(value.frequency || "").toLowerCase();
    if (!REMINDER_RECURRENCE_OPTIONS[frequency]) return null;

    const interval = Math.max(1, Math.min(365, Number(value.interval) || 1));
    return { frequency, interval };
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
    const normalized = normalizeReminderRecurrence(recurrence);
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
        const originalDay = next.getDate();
        next.setDate(1);
        next.setMonth(next.getMonth() + normalized.interval);
        next.setDate(Math.min(originalDay, getDaysInMonth(next.getFullYear(), next.getMonth())));
        return next;
    }

    const originalMonth = next.getMonth();
    const originalDay = next.getDate();
    next.setDate(1);
    next.setFullYear(next.getFullYear() + normalized.interval);
    next.setMonth(originalMonth);
    next.setDate(Math.min(originalDay, getDaysInMonth(next.getFullYear(), originalMonth)));
    return next;
}

function getNextReminderAt(currentReminderAt, recurrence, fromTime = Date.now()) {
    const normalized = normalizeReminderRecurrence(recurrence);
    const current = new Date(currentReminderAt);

    if (!normalized || Number.isNaN(current.getTime())) return null;

    let next = addRecurringDate(current, normalized);
    let guard = 0;
    while (next && next.getTime() <= fromTime && guard < 1000) {
        next = addRecurringDate(next, normalized);
        guard++;
    }

    return next ? next.toISOString() : null;
}

function hasRecurringReminder(value) {
    return Boolean(normalizeReminderRecurrence(value));
}

window.REMINDER_RECURRENCE_OPTIONS = REMINDER_RECURRENCE_OPTIONS;
window.normalizeReminderRecurrence = normalizeReminderRecurrence;
window.getReminderRecurrenceLabel = getReminderRecurrenceLabel;
window.getNextReminderAt = getNextReminderAt;
window.hasRecurringReminder = hasRecurringReminder;
