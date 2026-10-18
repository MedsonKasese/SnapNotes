import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { upsertDraft, readDrafts } from "../js/drafts.js";

const appSource = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
const utilsSource = await readFile(new URL("../js/reminder-utils.js", import.meta.url), "utf8");

function setup(notes, options = {}) {
  let now = Date.parse("2026-10-18T09:00:00Z");
  class Clock extends Date { static now() { return now; } }
  const events = { alerts: [], saves: 0, renders: 0 };
  const window = { notes, addEventListener() {}, ...options.window };
  const context = vm.createContext({
    window, Date: Clock, Intl, console,
    document: { addEventListener() {} },
    navigator: options.navigator || {},
    ...(options.Notification ? { Notification: options.Notification } : {}),
    showToast: message => events.alerts.push(message),
    saveNotes: async () => { events.saves++; },
    renderNotes: () => { events.renders++; }
  });
  vm.runInContext(utilsSource, context);
  vm.runInContext(appSource, context);
  return { window, events, advance: value => { now = Date.parse(value); } };
}

const daily = { frequency: "daily", interval: 1, timeZone: "UTC", anchorAt: "2026-10-17T09:00:00Z" };

test("one-time reminders notify once and persist their completed state", async () => {
  const note = { id: "once", reminderAt: "2026-10-17T09:00:00Z" };
  const app = setup([note]);
  await app.window.checkDueReminders();
  await app.window.checkDueReminders();
  assert.equal(app.events.alerts.length, 1);
  assert.equal(note.reminderNotified, true);
  assert.equal(app.events.saves, 1);
});

test("daily reminders skip missed occurrences then notify again on the next day", async () => {
  const note = { id: "daily", title: "Bible study", reminderAt: daily.anchorAt, reminderRepeat: daily };
  const app = setup([note]);
  await app.window.checkDueReminders();
  assert.equal(app.events.alerts.length, 1);
  assert.equal(note.reminderAt, "2026-10-19T09:00:00.000Z");
  assert.equal(note.reminderNotified, false);
  assert.ok(note.updatedAt);
  await app.window.checkDueReminders();
  assert.equal(app.events.alerts.length, 1);
  app.advance("2026-10-19T09:00:00Z");
  await app.window.checkDueReminders();
  assert.equal(app.events.alerts.length, 2);
  assert.equal(note.reminderAt, "2026-10-20T09:00:00.000Z");
});

test("future, deleted, invalid, already-notified and locked private reminders are skipped", async () => {
  const app = setup([
    { reminderAt: "2026-10-19T09:00:00Z" },
    { reminderAt: daily.anchorAt, deletedAt: "2026-10-18" },
    { reminderAt: "invalid" },
    { reminderAt: daily.anchorAt, reminderNotified: true },
    { reminderAt: daily.anchorAt, isPrivate: true }
  ]);
  await app.window.checkDueReminders();
  assert.equal(app.events.alerts.length, 0);
  assert.equal(app.events.saves, 0);
});

test("private recurring reminders advance through encrypted-state updater only", async () => {
  const raw = { id: "private", isPrivate: true, reminderAt: null };
  let completion;
  const app = setup([raw], { window: {
    isPrivateNotesUnlocked: () => true,
    getReadablePrivateNote: () => ({ ...raw, reminderAt: daily.anchorAt, reminderRepeat: daily }),
    markPrivateReminderNotified: async (id, state) => { assert.equal(id, "private"); completion = state; return true; }
  } });
  await app.window.checkDueReminders();
  assert.equal(completion.reminderAt, "2026-10-19T09:00:00.000Z");
  assert.equal(completion.reminderNotified, false);
  assert.equal(raw.reminderAt, null);
  assert.equal(app.events.saves, 1);
});

test("overlapping asynchronous checks do not deliver the same occurrence twice", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let shown = 0;
  const note = { id: "daily", reminderAt: daily.anchorAt, reminderRepeat: daily };
  const app = setup([note], {
    window: { Notification: {} },
    Notification: { permission: "granted" },
    navigator: { serviceWorker: { getRegistration: async () => { await pending; return { showNotification: async () => { shown++; } }; } } }
  });
  const first = app.window.checkDueReminders();
  await app.window.checkDueReminders();
  release();
  await first;
  assert.equal(shown, 1);
  assert.equal(app.events.saves, 1);
});

test("notification permission without a registered worker falls back without hanging", async () => {
  const app = setup([{ reminderAt: daily.anchorAt }], {
    window: { Notification: {} }, Notification: { permission: "granted" },
    navigator: { serviceWorker: { getRegistration: async () => undefined } }
  });
  await app.window.checkDueReminders();
  assert.equal(app.events.alerts.length, 1);
  assert.equal(app.events.saves, 1);
});

test("draft storage round-trips repeat schedules", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  upsertDraft({ id: "study", content: "Study", reminderAt: daily.anchorAt, reminderRepeat: daily }, storage);
  assert.deepEqual(readDrafts(storage)[0].reminderRepeat, daily);
});
