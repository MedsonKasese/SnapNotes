import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../js/reminder-utils.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(source, { window, Intl, Date, Set, Map, Number, String, Math });
const { normalizeReminderRepeat, getNextReminderOccurrence, formatReminderRepeat,
  getReminderCompletionState, formatReminderDateTimeLocal, parseReminderDateTimeLocal } = window;
const sameJson = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

const repeat = (frequency, interval, timeZone = "UTC", anchorAt = "2024-01-01T09:00:00.000Z") =>
  ({ frequency, interval, timeZone, anchorAt });

test("classic-script legacy one-time helpers remain available", () => {
  assert.equal(typeof formatReminderDateTimeLocal, "function");
  assert.equal(typeof parseReminderDateTimeLocal, "function");
  assert.equal(parseReminderDateTimeLocal("2025-02-03T04:05:00Z"), "2025-02-03T04:05:00.000Z");
  assert.match(formatReminderDateTimeLocal("2025-02-03T04:05:00Z"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test("normalization accepts valid data and rejects malformed recurrence settings", () => {
  sameJson(normalizeReminderRepeat(repeat("weekly", 2)), { ...repeat("weekly", 2), anchorAt: "2024-01-01T09:00:00.000Z" });
  assert.equal(normalizeReminderRepeat(null), null);
  assert.equal(normalizeReminderRepeat({ ...repeat("daily", 1), frequency: "yearly" }), null);
  assert.equal(normalizeReminderRepeat({ ...repeat("daily", 1), interval: 0 }), null);
  assert.equal(normalizeReminderRepeat({ ...repeat("daily", 1), interval: 366 }), null);
  assert.equal(normalizeReminderRepeat({ ...repeat("daily", 1), interval: 1.5 }), null);
  assert.equal(normalizeReminderRepeat({ ...repeat("daily", 1), timeZone: "Mars/Olympus" }), null);
  assert.equal(normalizeReminderRepeat({ ...repeat("daily", 1), anchorAt: "not-a-date" }), null);
  sameJson(normalizeReminderRepeat({ frequency: "daily", interval: 1, timeZone: "UTC" }, "2024-01-01T09:00:00Z"), { ...repeat("daily", 1), anchorAt: "2024-01-01T09:00:00.000Z" });
});

test("daily, weekly, and monthly recurrences honor custom intervals and strict future ordering", () => {
  assert.equal(getNextReminderOccurrence("2024-01-01T09:00:00Z", repeat("daily", 1), Date.parse("2024-01-01T09:00:00Z")), "2024-01-02T09:00:00.000Z");
  assert.equal(getNextReminderOccurrence("2024-01-01T09:00:00Z", repeat("weekly", 2), Date.parse("2024-01-08T10:00:00Z")), "2024-01-15T09:00:00.000Z");
  assert.equal(getNextReminderOccurrence("2024-01-01T09:00:00Z", repeat("daily", 3), Date.parse("2024-01-05T12:00:00Z")), "2024-01-07T09:00:00.000Z");
  assert.equal(formatReminderRepeat(repeat("daily", 1)), "Every day");
  assert.equal(formatReminderRepeat(repeat("weekly", 2)), "Every 2 weeks");
});

test("monthly recurrence clamps short months without losing the original anchor day", () => {
  const monthly = repeat("monthly", 1, "UTC", "2024-01-31T09:00:00Z");
  assert.equal(getNextReminderOccurrence("2024-01-31T09:00:00Z", monthly, Date.parse("2024-02-29T10:00:00Z")), "2024-03-31T09:00:00.000Z");
  const everyOther = repeat("monthly", 2, "UTC", "2024-01-31T09:00:00Z");
  assert.equal(getNextReminderOccurrence("2024-01-31T09:00:00Z", everyOther, Date.parse("2024-02-01T00:00:00Z")), "2024-03-31T09:00:00.000Z");
});

test("daily recurrence preserves wall-clock time through spring and fall DST changes", () => {
  const spring = repeat("daily", 1, "America/New_York", "2025-03-08T14:00:00Z");
  assert.equal(getNextReminderOccurrence("2025-03-08T14:00:00Z", spring, Date.parse("2025-03-08T15:00:00Z")), "2025-03-09T13:00:00.000Z");
  const fall = repeat("daily", 1, "America/New_York", "2025-11-01T13:00:00Z");
  assert.equal(getNextReminderOccurrence("2025-11-01T13:00:00Z", fall, Date.parse("2025-11-01T14:00:00Z")), "2025-11-02T14:00:00.000Z");
});

test("DST gaps shift nonexistent wall times by the gap and repeated hours choose the earlier instant", () => {
  const spring = repeat("daily", 1, "America/New_York", "2025-03-08T07:30:00Z"); // 02:30 EST
  const shifted = getNextReminderOccurrence("2025-03-08T07:30:00Z", spring, Date.parse("2025-03-08T08:00:00Z"));
  assert.equal(shifted, "2025-03-09T07:30:00.000Z"); // 03:30 EDT
  assert.equal(getNextReminderOccurrence(shifted, spring, Date.parse("2025-03-09T08:00:00Z")), "2025-03-10T06:30:00.000Z"); // back to 02:30 EDT
  const fall = repeat("daily", 1, "America/New_York", "2025-11-01T05:30:00Z"); // 01:30 EDT
  assert.equal(getNextReminderOccurrence("2025-11-01T05:30:00Z", fall, Date.parse("2025-11-02T00:00:00Z")), "2025-11-02T05:30:00.000Z");
});

test("years-overdue reminders skip directly to the next future occurrence", () => {
  const old = repeat("daily", 1, "UTC", "2000-01-01T09:00:00Z");
  assert.equal(getNextReminderOccurrence("2000-01-01T09:00:00Z", old, Date.parse("2025-01-10T12:00:00Z")), "2025-01-11T09:00:00.000Z");
});

test("completion state advances recurring reminders, while one-time reminders are notified", () => {
  const note = { reminderAt: "2024-01-01T09:00:00Z", reminderRepeat: repeat("daily", 1) };
  sameJson(getReminderCompletionState(note, Date.parse("2024-01-01T10:00:00Z")), {
    reminderAt: "2024-01-02T09:00:00.000Z", reminderNotified: false
  });
  sameJson(getReminderCompletionState({ reminderAt: note.reminderAt }, Date.parse("2024-01-01T10:00:00Z")), {
    reminderAt: note.reminderAt, reminderNotified: true
  });
});
