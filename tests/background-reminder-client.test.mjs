import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const backgroundUtilsSource = await readFile(new URL("js/background-reminder-utils.js", root), "utf8");

function loadBackgroundUtils() {
  const source = backgroundUtilsSource.replaceAll("export function ", "function ")
    + "\nglobalThis.backgroundUtils = { projectReminderMetadata, scheduleMatches };\n";
  const context = vm.createContext({ Date, JSON, Uint8Array, atob });
  vm.runInContext(source, context, { filename: "background-reminder-utils.js" });
  return context.backgroundUtils;
}

function appHarness(notes, extraWindow = {}, extra = {}) {
  const appSource = extra.appSource;
  const reminderUtilsSource = extra.reminderUtilsSource;
  const events = { shown: [], alerts: [], saves: 0, renders: 0 };
  const window = {
    notes,
    addEventListener() {},
    ...(extra.Notification ? { Notification: extra.Notification } : {}),
    ...extraWindow
  };
  const context = vm.createContext({
    window,
    Date,
    Intl,
    console,
    document: { addEventListener() {} },
    navigator: extra.navigator || {},
    ...(extra.Notification ? { Notification: extra.Notification } : {}),
    showToast: message => events.alerts.push(message),
    saveNotes: async () => { events.saves++; },
    renderNotes: () => { events.renders++; }
  });
  vm.runInContext(reminderUtilsSource, context, { filename: "reminder-utils.js" });
  vm.runInContext(appSource, context, { filename: "app.js" });
  return { window, events };
}

async function loadAppSources() {
  return {
    appSource: await readFile(new URL("js/app.js", root), "utf8"),
    reminderUtilsSource: await readFile(new URL("js/reminder-utils.js", root), "utf8")
  };
}

function backgroundClientHarness({ fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ enabled: false, reminders: [] }) }), navigatorImpl = {} } = {}) {
  const listeners = new Map();
  const documentListeners = new Map();
  const elements = new Map();
  const requests = [];
  let permissionRequests = 0;
  const window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    firebaseAuth: { currentUser: null },
    notes: [],
    snapNotesDataUid: null
  };
  const document = {
    addEventListener: (name, callback) => documentListeners.set(name, callback),
    getElementById(id) {
      if (!elements.has(id)) {
        const handlers = {};
        elements.set(id, { disabled: false, checked: false, textContent: "", handlers, addEventListener(name, callback) { handlers[name] = callback; } });
      }
      return elements.get(id);
    }
  };
  const trackedFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return fetchImpl(url, options);
  };
  const source = (awaitReadSource);
  const moduleSource = source
    .replace(/^import \{ BACKGROUND_REMINDER_API \} from .*;\n/m, 'const BACKGROUND_REMINDER_API = "https://reminders.example";\n')
    .replace(/^import \{ projectReminderMetadata, scheduleMatches, vapidBytes \} from .*;\n/m, "")
    .replace("export function ", "function ");
  const utilitySource = backgroundUtilsSource.replaceAll("export function ", "function ");
  const context = vm.createContext({
    window, document, navigator: navigatorImpl, fetch: trackedFetch, URL, Date, JSON, Map, Boolean,
    AbortSignal, Uint8Array, atob, localStorage: { getItem: () => null, setItem() {} },
    Notification: { requestPermission: async () => { permissionRequests++; return "granted"; } },
    console
  });
  vm.runInContext(`${utilitySource}\n${moduleSource}`, context, { filename: "background-reminders.js" });
  documentListeners.get("DOMContentLoaded")?.();
  return { window, listeners, elements, requests, documentListeners, permissionRequests: () => permissionRequests };
}

// Read module source once before creating VM harnesses. Keeping the imports transformed in
// memory means this test exercises browser code without changing production module boundaries.
const awaitReadSource = await readFile(new URL("js/background-reminders.js", root), "utf8");

test("metadata projection sends only allowlisted schedule fields and omits private/deleted/archived notes unless explicitly unlocked", () => {
  const { projectReminderMetadata } = loadBackgroundUtils();
  const secret = "TOP SECRET: doctor appointment";
  const notes = [
    { id: "public", title: secret, text: secret, reminderAt: "2026-10-18T10:00:00-04:00", reminderRepeat: { frequency: "weekly", interval: 2, timeZone: "America/New_York", anchorAt: "2026-10-18", extraSecret: secret } },
    { id: "private", isPrivate: true, title: secret, text: secret, updatedAt: "cipher-v3", reminderAt: "2026-10-19T09:00:00Z" },
    { id: "deleted", deletedAt: "2026-10-18", reminderAt: "2026-10-19T09:00:00Z" },
    { id: "archived", archived: true, reminderAt: "2026-10-19T09:00:00Z" },
    { id: "no-schedule", title: secret }
  ];
  const lockedOrOptedOut = projectReminderMetadata(notes, { includePrivate: true, unlocked: false });
  assert.deepEqual(JSON.parse(JSON.stringify(lockedOrOptedOut)), [{
    noteId: "public", reminderAt: "2026-10-18T14:00:00.000Z", reminderNotified: false,
    reminderRepeat: { frequency: "weekly", interval: 2, timeZone: "America/New_York", anchorAt: "2026-10-18" }, isPrivate: false
  }]);

  const optedOut = projectReminderMetadata(notes, { includePrivate: false, unlocked: true });
  assert.equal(optedOut.length, 1, "private metadata is not projected without consent");
  const unlocked = projectReminderMetadata(notes, {
    includePrivate: true, unlocked: true,
    readPrivate: raw => ({ ...raw, title: secret, text: secret, reminderAt: "2026-10-19T09:00:00Z", reminderRepeat: { frequency: "daily", interval: 1 } })
  });
  const serialized = JSON.stringify(unlocked);
  assert.equal(unlocked.length, 2);
  assert.ok(!serialized.includes(secret), "note content must never be serialized to the reminder service");
  assert.ok(!serialized.includes("deleted"));
  assert.ok(!serialized.includes("archived"));
  assert.deepEqual(Object.keys(unlocked[1]).sort(), ["isPrivate", "noteId", "privateUpdatedAt", "reminderAt", "reminderNotified", "reminderRepeat"].sort());
});

test("schedule matching distinguishes source from effective schedule and normalizes instants and recurrence anchors", () => {
  const { scheduleMatches } = loadBackgroundUtils();
  const note = {
    id: "repeat", isPrivate: false, reminderAt: "2026-10-19T11:00:00-04:00", reminderNotified: false,
    reminderRepeat: { frequency: "weekly", interval: 2, timeZone: "America/New_York", anchorAt: "2026-10-12T09:00:00-04:00" }
  };
  const state = {
    noteId: "repeat", isPrivate: false,
    sourceReminderAt: "2026-10-19T15:00:00.000Z", sourceReminderNotified: false,
    sourceReminderRepeat: { frequency: "weekly", interval: 2, timeZone: "America/New_York", anchorAt: "2026-10-12T13:00:00Z" },
    reminderAt: "2026-10-20T09:00:00Z", reminderNotified: false,
    reminderRepeat: { frequency: "weekly", interval: 2, timeZone: "America/New_York", anchorAt: "2026-10-12T13:00:00.000Z" }
  };
  assert.equal(scheduleMatches(note, state, true), true, "source datetimes and recurrence anchors normalize to equivalent instants");
  assert.equal(scheduleMatches(note, state, false), false, "the current note schedule differs from the effective next delivery");
  note.reminderAt = "2026-10-20T09:00:00+00:00";
  assert.equal(scheduleMatches(note, state, false), true, "equivalent effective ISO dates match");
  note.reminderRepeat = { ...note.reminderRepeat, interval: 3 };
  assert.equal(scheduleMatches(note, state, false), false, "a recurrence change invalidates the match");
});

test("foreground reminder checker skips schedules managed by the background client", async () => {
  const sources = await loadAppSources();
  const note = { id: "managed", title: "Do not duplicate", reminderAt: "2020-01-01T00:00:00Z" };
  let shouldManageCalls = 0;
  const app = appHarness([note], { shouldManageBackgroundReminder: () => { shouldManageCalls++; return true; } }, {
    ...sources,
    Notification: { permission: "granted" },
    navigator: { serviceWorker: { getRegistration: async () => ({ showNotification: async () => { throw new Error("must not show a duplicate"); } }) } }
  });
  await app.window.checkDueReminders();
  assert.equal(shouldManageCalls, 1);
  assert.equal(app.events.alerts.length, 0);
  assert.equal(app.events.saves, 0);
  assert.equal(note.reminderNotified, undefined);
});

test("foreground private reminder notification uses generic title and body, never note content", async () => {
  const sources = await loadAppSources();
  const secret = "TOP SECRET: therapy appointment";
  const raw = { id: "private-id", isPrivate: true, reminderAt: null, updatedAt: "ciphertext" };
  let notification;
  const app = appHarness([raw], {
    isPrivateNotesUnlocked: () => true,
    getReadablePrivateNote: () => ({ ...raw, title: secret, text: secret, reminderAt: "2020-01-01T00:00:00Z" }),
    shouldManageBackgroundReminder: () => false,
    markPrivateReminderNotified: async () => true
  }, {
    ...sources,
    Notification: { permission: "granted" },
    navigator: { serviceWorker: { getRegistration: async () => ({ showNotification: async (title, options) => { notification = { title, options }; } }) } }
  });
  await app.window.checkDueReminders();
  assert.equal(notification.title, "SnapNotes reminder");
  assert.equal(notification.options.body, "You have a private note reminder.");
  assert.ok(!JSON.stringify(notification).includes(secret));
  assert.deepEqual(JSON.parse(JSON.stringify(notification.options.data)), { noteId: "private-id" });
});

test("browser client does not request notification permission on startup and sends API requests only to the configured origin", async () => {
  const client = backgroundClientHarness({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, reminders: [{ noteId: "managed-note", isPrivate: false, sourceReminderAt: "2026-10-19T09:00:00Z", sourceReminderNotified: false, sourceReminderRepeat: null, reminderAt: "2026-10-19T09:00:00Z", reminderNotified: false, reminderRepeat: null }] }) }) });
  client.window.firebaseAuth.currentUser = null;
  assert.equal(client.requests.length, 0);
  assert.equal(client.permissionRequests(), 0, "startup must not trigger a permission prompt");
  assert.equal(client.elements.get("enableBackgroundReminders").disabled, true);
  assert.ok(client.listeners.has("snapnotes:auth-changed"));
  // Verify the exact origin, path, and privacy-conscious fetch options on authenticated refresh.
  client.window.firebaseAuth.currentUser = { uid: "account-1", getIdToken: async () => "test-token" };
  client.window.snapNotesDataUid = "account-1";
  client.listeners.get("snapnotes:auth-changed")({ detail: { user: client.window.firebaseAuth.currentUser } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0].url, "https://reminders.example/v1/reminders");
  assert.equal(client.requests[0].options.mode, "cors");
  assert.equal(client.requests[0].options.credentials, "omit");
  assert.equal(client.requests[0].options.cache, "no-store");
  assert.equal(client.window.shouldManageBackgroundReminder({ id: "managed-note", isPrivate: false, reminderAt: "2026-10-19T09:00:00Z", reminderNotified: false, reminderRepeat: null }), true,
    "the synchronized schedule suppresses duplicate foreground delivery");
});

test("stale account refresh responses are discarded after an account switch", async () => {
  let releaseA;
  const pendingA = new Promise(resolve => { releaseA = resolve; });
  const client = backgroundClientHarness({ fetchImpl: async (url, options) => {
    const token = options.headers.Authorization;
    if (token === "Bearer token-A") return pendingA;
    return { ok: true, status: 200, json: async () => ({ enabled: true, reminders: [] }) };
  } });
  const userA = { uid: "account-A", getIdToken: async () => "token-A" };
  const userB = { uid: "account-B", getIdToken: async () => "token-B" };
  client.window.firebaseAuth.currentUser = userA;
  client.window.snapNotesDataUid = "account-A";
  client.listeners.get("snapnotes:auth-changed")({ detail: { user: userA } });
  await new Promise(resolve => setTimeout(resolve, 0));

  client.window.firebaseAuth.currentUser = userB;
  client.window.snapNotesDataUid = "account-B";
  client.listeners.get("snapnotes:auth-changed")({ detail: { user: userB } });
  await new Promise(resolve => setTimeout(resolve, 0));
  releaseA({ ok: true, status: 200, json: async () => ({ enabled: true, reminders: [{ noteId: "account-A-private-id", isPrivate: true, reminderAt: "2026-10-20T09:00:00Z" }] }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(client.window.shouldManageBackgroundReminder({ id: "account-A-private-id", isPrivate: true }), false,
    "a delayed response for the previous identity must not repopulate current account state");
  assert.ok(client.requests.some(request => request.options.headers.Authorization === "Bearer token-B"),
    "the new account must start its own refresh instead of reusing the previous account's request");
  assert.ok(client.requests.every(request => request.url.startsWith("https://reminders.example/")));
});

test("service-worker push handler ignores untrusted title, body, and URL and displays generic safe copy", async () => {
  const handlers = new Map();
  let shown;
  const self = {
    addEventListener: (name, callback) => handlers.set(name, callback),
    registration: { showNotification: async (title, options) => { shown = { title, options }; } }
  };
  const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { self, URL, fetch, caches: {}, Response, console });
  const secret = "TOP SECRET: private note contents";
  let waited;
  handlers.get("push")({ data: { json: () => ({ data: { noteId: "private-note-1" }, title: secret, body: secret, url: "https://attacker.invalid/" }) }, waitUntil: promise => { waited = promise; } });
  await waited;
  assert.equal(shown.title, "SnapNotes reminder");
  assert.equal(shown.options.body, "You have a note reminder. Open SnapNotes to view it.");
  assert.deepEqual(JSON.parse(JSON.stringify(shown.options.data)), { noteId: "private-note-1" });
  assert.ok(!JSON.stringify(shown).includes(secret));
  assert.ok(!JSON.stringify(shown).includes("attacker.invalid"));
});

test("server completion does not mutate the previous account's still-loaded library", async () => {
  const at = "2020-01-01T00:00:00.000Z";
  const client = backgroundClientHarness({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, reminders: [{
    noteId: "shared-import-id", isPrivate: false, sourceReminderAt: at, sourceReminderNotified: false,
    sourceReminderRepeat: null, reminderAt: at, reminderNotified: true, reminderRepeat: null
  }] }) }) });
  const oldNote = { id: "shared-import-id", reminderAt: at, reminderNotified: false };
  client.window.notes = [oldNote];
  client.window.snapNotesDataUid = "previous-account";
  let saves = 0;
  client.window.saveNotes = async () => { saves++; };
  const nextUser = { uid: "new-account", getIdToken: async () => "new-token" };
  client.window.firebaseAuth.currentUser = nextUser;
  client.listeners.get("snapnotes:auth-changed")({ detail: { user: nextUser } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(oldNote.reminderNotified, false);
  assert.equal(saves, 0);
});

test("an enabled account with no server schedule still allows foreground reminders", async () => {
  const client = backgroundClientHarness({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, reminders: [] }) }) });
  const account = { uid: "account", getIdToken: async () => "token" };
  client.window.firebaseAuth.currentUser = account;
  client.window.snapNotesDataUid = account.uid;
  client.listeners.get("snapnotes:auth-changed")({ detail: { user: account } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(client.window.shouldManageBackgroundReminder({ id: "new-local-note", reminderAt: "2020-01-01T00:00:00.000Z" }), false);
});

test("explicit enable subscribes this device and publishes metadata only; disable removes all account schedules", async () => {
  let subscribed = 0, unsubscribed = 0, active = false;
  const endpoint = "https://fcm.googleapis.com/fcm/send/test";
  const subscription = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: "key", auth: "auth" } }), unsubscribe: async () => { unsubscribed++; return true; } };
  const client = backgroundClientHarness({
    navigatorImpl: { serviceWorker: { getRegistration: async () => ({ pushManager: {
      getSubscription: async () => null,
      subscribe: async options => { subscribed++; assert.equal(options.userVisibleOnly, true); return subscription; }
    } }) } },
    fetchImpl: async (url, options = {}) => {
      let body = {};
      if (url.endsWith("/config")) body = { vapidPublicKey: "AQID" };
      else if (url.endsWith("/subscriptions") && options.method === "POST") active = true;
      else if (url.endsWith("/reminders") && options.method === "DELETE") { active = false; body = { enabled: false }; }
      else if (url.endsWith("/reminders") && options.method === "PUT") body = { reminders: [] };
      else body = { enabled: active, reminders: [] };
      return { ok: true, status: 200, json: async () => body };
    }
  });
  client.window.Notification = {};
  client.window.PushManager = {};
  const account = { uid: "account", getIdToken: async () => "token" };
  client.window.firebaseAuth.currentUser = account;
  client.window.snapNotesDataUid = account.uid;
  const note = { id: "note", reminderAt: "2030-01-01T09:00:00.000Z", title: "Never upload this title", text: "Never upload this body" };
  client.window.notes = [note];
  client.window.syncToCloud = async () => {
    client.listeners.get("snapnotes:library-committed")({ detail: { uid: account.uid, revision: "r1", notes: [note] } });
    return true;
  };
  client.listeners.get("snapnotes:auth-changed")({ detail: { user: account } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(client.permissionRequests(), 0);
  await client.elements.get("enableBackgroundReminders").handlers.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(client.permissionRequests(), 1);
  assert.equal(subscribed, 1);
  const put = client.requests.find(request => request.options.method === "PUT");
  assert.ok(put);
  assert.equal(JSON.parse(put.options.body).revision, "r1");
  assert.ok(!put.options.body.includes(note.title));
  assert.ok(!put.options.body.includes(note.text));
  await client.elements.get("disableBackgroundReminders").handlers.click();
  assert.ok(client.requests.some(request => request.url.endsWith("/reminders") && request.options.method === "DELETE"));
  assert.equal(client.window.shouldManageBackgroundReminder(note), false);
  assert.equal(unsubscribed, 0, "no existing subscription was returned by this test's getSubscription stub");
});
