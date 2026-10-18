import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 1024 * 1024;
const MAX_REMINDERS = 2000;
const HASH = value => createHash('sha256').update(value).digest('hex');
const ALLOWED_PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com'];
const utilsContext = vm.createContext({ window: {}, Date, Intl, Map, Set, Math, Number, String, Object, Array, RegExp });
vm.runInContext(readFileSync(new URL('../../js/reminder-utils.js', import.meta.url), 'utf8'), utilsContext);
const completeReminder = utilsContext.window.getReminderCompletionState;
const normalizeRepeat = utilsContext.window.normalizeReminderRepeat;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id);
const cleanRepeat = (repeat, at) => {
  if (repeat == null) return null;
  const result = normalizeRepeat(repeat, at);
  if (!result || Object.keys(repeat).some(k => !['frequency', 'interval', 'timeZone', 'anchorAt'].includes(k))) throw new Error('invalid');
  return result;
};
const sourceOf = item => ({ reminderAt: item.reminderAt, reminderNotified: Boolean(item.reminderNotified), reminderRepeat: item.reminderRepeat ?? null, isPrivate: Boolean(item.isPrivate), privateUpdatedAt: item.isPrivate ? String(item.privateUpdatedAt || '') : '' });
const sourceKey = source => HASH(JSON.stringify(source));

export function isAllowedPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && url.port === '' && !url.username && !url.password && (ALLOWED_PUSH_HOSTS.some(root => host === root || (root === 'push.services.mozilla.com' && host.endsWith('.push.services.mozilla.com'))) || host.endsWith('.notify.windows.com'));
  } catch { return false; }
}

function validateSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isAllowedPushEndpoint(value.endpoint)) throw new Error('invalid');
  if (!value.keys || typeof value.keys.p256dh !== 'string' || value.keys.p256dh.length > 256 || typeof value.keys.auth !== 'string' || value.keys.auth.length > 128) throw new Error('invalid');
  return { endpoint: value.endpoint, expirationTime: Number.isFinite(value.expirationTime) ? value.expirationTime : null, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

function validateReminder(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || !validId(item.noteId) || item.isPrivate !== true && item.isPrivate !== false) throw new Error('invalid');
  const date = typeof item.reminderAt === 'string' ? Date.parse(item.reminderAt) : NaN;
  if (!Number.isFinite(date) || new Date(date).toISOString() !== item.reminderAt || typeof item.reminderNotified !== 'boolean') throw new Error('invalid');
  const reminderRepeat = cleanRepeat(item.reminderRepeat ?? null, item.reminderAt);
  if (item.isPrivate && (typeof item.privateUpdatedAt !== 'string' || item.privateUpdatedAt.length > 100)) throw new Error('invalid');
  return { noteId: item.noteId, ...sourceOf({ ...item, reminderRepeat }), reminderRepeat, reminderAt: new Date(date).toISOString(), reminderNotified: item.reminderNotified };
}

function decodePageNote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

async function canonicalNote(store, uid, revision, noteId, cache = null) {
  const key = `${uid}:${revision}`; let pages = cache?.get(key);
  if (!pages) { pages = await store.getLibraryPages(uid, revision); cache?.set(key, pages); }
  let found = null; for (const page of pages) for (const raw of page.notes || []) if (raw?.id === noteId) { found = decodePageNote(raw); break; }
  if (found && (await store.isNoteDeleted?.(uid, noteId) || (validId(found.conflictOf) && await store.isNoteDeleted?.(uid, found.conflictOf)))) return null;
  return found;
}

function assertCanonical(submitted, note) {
  if (!note || note.deletedAt || note.archived || Boolean(note.isPrivate) !== Boolean(submitted.isPrivate)) throw new Error('conflict');
  if (submitted.isPrivate) {
    if (String(note.updatedAt || '') !== submitted.privateUpdatedAt) throw new Error('conflict');
    return;
  }
  let normalizedAt = null;
  if (note.reminderAt) {
    const timestamp = Date.parse(note.reminderAt);
    if (!Number.isFinite(timestamp)) throw new Error('conflict');
    normalizedAt = new Date(timestamp).toISOString();
  }
  const submittedRepeat = submitted.reminderRepeat;
  if (normalizedAt !== submitted.reminderAt || Boolean(note.reminderNotified) !== submitted.reminderNotified || !same(cleanRepeat(note.reminderRepeat ?? null, note.reminderAt), submittedRepeat)) throw new Error('conflict');
}

export function createReminderService({ auth, store, push, vapidPublicKey = '', appOrigin, now = () => Date.now(), logger = console }) {
  const configuredOrigin = new URL(appOrigin || 'http://localhost');
  if (configuredOrigin.pathname !== '/' || configuredOrigin.search || configuredOrigin.hash || configuredOrigin.username || configuredOrigin.password) throw new Error('APP_ORIGIN must be a bare origin');
  const origin = configuredOrigin.origin;
  const respond = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': origin, 'vary': 'Origin', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS' }); res.end(JSON.stringify(body)); };
  async function body(req) {
    let raw = '', size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 }); raw += chunk; }
    try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
  }
  async function uidFor(req) {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!match || match[1].length > 8192) throw Object.assign(new Error('unauthorized'), { status: 401 });
    try { return (await auth.verifyIdToken(match[1], true)).uid; } catch { throw Object.assign(new Error('unauthorized'), { status: 401 }); }
  }
  async function handle(req, res) {
    const requestOrigin = req.headers.origin;
    if (requestOrigin && requestOrigin !== origin) return respond(res, 403, { error: 'forbidden' });
    if (req.method === 'OPTIONS') return respond(res, 204, {});
    const url = new URL(req.url, 'http://local');
    if (req.method === 'GET' && url.pathname === '/healthz') return respond(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/v1/config') return respond(res, 200, { vapidPublicKey });
    let uid;
    try { uid = await uidFor(req); } catch (e) { return respond(res, e.status || 401, { error: 'unauthorized' }); }
    try {
      if (!(req.method === 'DELETE' && (url.pathname === '/v1/subscriptions' || url.pathname === '/v1/reminders'))) {
        const account = await store.getAccount(uid);
        if (account?.tombstoned || account?.deleting) return respond(res, 403, { error: 'account_unavailable' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/subscriptions') {
        const payload = await body(req); if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('invalid'), { status: 400 }); const subscription = validateSubscription(payload.subscription);
        await store.putSubscription(uid, HASH(subscription.endpoint), { ...subscription, createdAt: now() });
        await store.resumePaused?.(uid, now());
        return respond(res, 201, { ok: true });
      }
      if (req.method === 'DELETE' && url.pathname === '/v1/subscriptions') {
        const payload = await body(req); if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !isAllowedPushEndpoint(payload.endpoint)) throw Object.assign(new Error('invalid'), { status: 400 });
        await store.deleteSubscription(uid, HASH(payload.endpoint)); return respond(res, 200, { ok: true });
      }
      if (url.pathname === '/v1/reminders' && req.method === 'GET') {
        const [reminders, subscriptions, accountState] = await Promise.all([store.listReminders(uid), store.listSubscriptions(uid), store.getAccount(uid)]);
        return respond(res, 200, { enabled: accountState?.backgroundRemindersEnabled !== false && subscriptions.length > 0, reminders: reminders.map(publicState) });
      }
      if (url.pathname === '/v1/reminders' && req.method === 'PUT') {
        const payload = await body(req);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('invalid'), { status: 400 });
        if (!Number.isSafeInteger(payload.revision) && (typeof payload.revision !== 'string' || payload.revision.length > 200)) throw Object.assign(new Error('invalid'), { status: 400 });
        if (!Array.isArray(payload.reminders) || payload.reminders.length > MAX_REMINDERS || !['preserve', 'replace', 'remove', undefined].includes(payload.privateMode)) throw Object.assign(new Error('invalid'), { status: 400 });
        const unique = new Map();
        for (const raw of payload.reminders) { const item = validateReminder(raw); if (unique.has(item.noteId)) throw Object.assign(new Error('invalid'), { status: 400 }); unique.set(item.noteId, item); }
        const mode = payload.privateMode || 'preserve';
        const effectiveReminders = [...unique.values()].filter(item => !item.isPrivate || mode === 'replace');
        const saved = await store.replaceReminders({ uid, revision: payload.revision, reminders: effectiveReminders, privateMode: mode, canonicalNote, assertCanonical, makeSchedule: (item, prior, timestamp) => scheduleDocument(item, prior, timestamp), now: now() });
        return respond(res, 200, { reminders: saved.map(publicState) });
      }
      if (url.pathname === '/v1/reminders' && req.method === 'DELETE') {
        await store.disableAccount(uid); return respond(res, 200, { ok: true, enabled: false, accountWide: true });
      }
      return respond(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e.status) return respond(res, e.status, { error: e.status === 413 ? 'too_large' : 'invalid_request' });
      if (e.message === 'invalid') return respond(res, 400, { error: 'invalid_request' });
      if (e.message === 'conflict') return respond(res, 409, { error: 'revision_or_note_conflict' });
      logger.error?.('background reminder request failed');
      return respond(res, 500, { error: 'server_error' });
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      logger.error?.('background reminder HTTP handler failed');
      if (!res.headersSent) respond(res, 500, { error: 'server_error' });
      else res.end();
    });
  });
  return server;
}

function publicState(reminder) {
  return { noteId: reminder.noteId, sourceReminderAt: reminder.sourceReminderAt, sourceReminderNotified: reminder.sourceReminderNotified, sourceReminderRepeat: reminder.sourceReminderRepeat ?? null, sourcePrivateUpdatedAt: reminder.sourcePrivateUpdatedAt || '', reminderAt: reminder.reminderAt, reminderNotified: Boolean(reminder.reminderNotified), reminderRepeat: reminder.reminderRepeat ?? null, isPrivate: Boolean(reminder.isPrivate) };
}

export function scheduleDocument(item, prior, now) {
  const source = sourceOf(item); const key = sourceKey(source);
  if (prior?.sourceKey === key && prior.reminderAt) return { ...prior, isPrivate: item.isPrivate };
  const completed = Boolean(item.reminderNotified);
  return { noteId: item.noteId, sourceKey: key, sourceReminderAt: item.reminderAt, sourceReminderNotified: item.reminderNotified, sourceReminderRepeat: item.reminderRepeat, sourcePrivateUpdatedAt: item.privateUpdatedAt || '', reminderAt: item.reminderAt, reminderNotified: item.reminderNotified, reminderRepeat: item.reminderRepeat, isPrivate: item.isPrivate, nextAttemptAt: completed ? Number.MAX_SAFE_INTEGER : Date.parse(item.reminderAt), completed, createdAt: now, attempts: 0, deliveredSubscriptionHashes: [] };
}

export async function deliverDue({ store, push, now = () => Date.now(), limit = 25, logger = console }) {
  const due = await store.queryDue(now(), Math.min(100, Math.max(1, limit)));
  let delivered = 0;
  for (const candidate of due) {
    const lease = randomUUID();
    const claimed = await store.claim(candidate.path, lease, now());
    if (!claimed) continue;
    try {
      const state = await store.readClaimed(candidate.path, lease);
      if (!state) continue;
      const account = await store.getAccount(state.uid);
      if (!account || account.tombstoned || account.deleting || account.backgroundRemindersEnabled === false || !account.activeLibraryRevision) { await store.deleteReminder(state.path, lease); continue; }
      const note = await canonicalNote(store, state.uid, account.activeLibraryRevision, state.noteId);
      const canonical = { noteId: state.noteId, isPrivate: state.isPrivate, reminderAt: state.sourceReminderAt, reminderNotified: state.sourceReminderNotified, reminderRepeat: state.sourceReminderRepeat, privateUpdatedAt: state.sourcePrivateUpdatedAt };
      try { assertCanonical(canonical, note); } catch { await store.deleteReminder(state.path, lease); continue; }
      const subs = await store.listSubscriptions(state.uid);
      if (!subs.length) { await store.pauseReminder(state.path, lease); continue; }
      let successfulThisRun = false;
      const already = new Set(state.deliveredSubscriptionHashes || []);
      let failures = 0;
      let cancelled = false;
      for (const sub of subs) {
        if (already.has(sub.hash)) continue;
        try {
          const latestAccount = await store.getAccount(state.uid);
          if (!latestAccount || latestAccount.tombstoned || latestAccount.deleting || latestAccount.backgroundRemindersEnabled === false || !latestAccount.activeLibraryRevision) {
            await store.deleteReminder(state.path, lease); cancelled = true; break;
          }
          const latestNote = await canonicalNote(store, state.uid, latestAccount.activeLibraryRevision, state.noteId);
          try { assertCanonical(canonical, latestNote); } catch { await store.deleteReminder(state.path, lease); cancelled = true; break; }
          const current = await store.readClaimed(state.path, lease);
          if (!current || current.completed || current.reminderNotified) { cancelled = true; break; }
          if (!(await store.listSubscriptions(state.uid)).some(value => value.hash === sub.hash)) continue;
          const finalAccount = await store.getAccount(state.uid);
          if (!finalAccount || finalAccount.tombstoned || finalAccount.deleting || finalAccount.backgroundRemindersEnabled === false || String(finalAccount.activeLibraryRevision) !== String(latestAccount.activeLibraryRevision)) { cancelled = true; break; }
          const finalNote = await canonicalNote(store, state.uid, finalAccount.activeLibraryRevision, state.noteId);
          try { assertCanonical(canonical, finalNote); } catch { await store.deleteReminder(state.path, lease); cancelled = true; break; }
          if (store.renewLease && !await store.renewLease(state.path, lease, now())) { cancelled = true; break; }
          await push.sendNotification(sub.data, JSON.stringify({ title: 'SnapNotes reminder', body: state.isPrivate ? 'You have a private note reminder.' : 'You have a note reminder.', data: { noteId: state.noteId } }), { timeout: 10000 });
          await store.markSubscriptionDelivered(state.path, lease, sub.hash); already.add(sub.hash); successfulThisRun = true;
        } catch (error) {
          const status = error?.statusCode || error?.status;
          if (status === 404 || status === 410) await store.deleteSubscription(state.uid, sub.hash);
          else failures++;
        }
      }
      if (cancelled) continue;
      if (!failures && (successfulThisRun || already.size > 0)) {
        const completion = completeReminder({ reminderAt: state.reminderAt, reminderRepeat: state.reminderRepeat }, now());
        if (completion.reminderNotified && !completion.reminderRepeat) await store.completeReminder(state.path, lease, completion, now());
        else await store.advanceReminder(state.path, lease, completion, now());
        delivered++;
      } else if (failures) await store.retryReminder(state.path, lease, now());
      else await store.pauseReminder(state.path, lease);
    } catch (error) {
      logger.error?.('background reminder delivery failed');
      await store.retryReminder(candidate.path, lease, now()).catch(() => {});
    }
  }
  return delivered;
}
