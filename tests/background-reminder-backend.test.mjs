import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderService, deliverDue, isAllowedPushEndpoint, scheduleDocument } from '../backend/reminders/service.mjs';

class FakeStore {
  constructor() { this.subs = new Map(); this.reminders = new Map(); this.notes = new Map(); this.revision = 'r1'; this.account = { activeLibraryRevision: 'r1' }; this.disabled = false; this.locked = false; }
  async putSubscription(uid, hash, data) { this.subs.set(hash, data); }
  async deleteSubscription(uid, hash) { this.subs.delete(hash); }
  async listSubscriptions() { return [...this.subs].map(([hash, data]) => ({ hash, data })); }
  async listReminders() { return [...this.reminders.values()]; }
  async getLibraryPages() { return [{ notes: [...this.notes.values()] }]; }
  async replaceReminders(args) {
    if (String(args.revision) !== this.revision) throw new Error('conflict');
    for (const item of args.reminders) args.assertCanonical(item, this.notes.get(item.noteId));
    const incoming = new Map(args.reminders.map(item => [item.noteId, item]));
    const next = new Map();
    if (args.privateMode === 'preserve') for (const [id, prior] of this.reminders) if (prior.isPrivate && !incoming.has(id)) next.set(id, prior);
    for (const [id, item] of incoming) next.set(id, { ...args.makeSchedule(item, this.reminders.get(id), args.now), uid: args.uid, revision: String(args.revision), path: `users/${args.uid}/backgroundReminders/${id}` });
    this.reminders = next;
    return [...next.values()];
  }
  async disableAccount() { this.subs.clear(); this.reminders.clear(); this.disabled = true; }
  async queryDue() { return [...this.reminders.values()].filter(x => x.nextAttemptAt <= Date.now()).map(x => ({ ...x, path: x.path })); }
  async claim(path, token) { const x = [...this.reminders.values()].find(y => y.path === path); if (!x || x.leaseToken) return false; x.leaseToken = token; return true; }
  async readClaimed(path, token) { const x = [...this.reminders.values()].find(y => y.path === path); return x?.leaseToken === token ? x : null; }
  async getAccount() { return this.account; }
  async deleteReminder(path) { for (const [k, x] of this.reminders) if (x.path === path) this.reminders.delete(k); }
  async markSubscriptionDelivered(path, token, hash) { const x = [...this.reminders.values()].find(y => y.path === path); if (x.leaseToken === token) x.deliveredSubscriptionHashes = [...new Set([...(x.deliveredSubscriptionHashes || []), hash])]; }
  async advanceReminder(path, token, completion) { const x = [...this.reminders.values()].find(y => y.path === path); x.reminderAt = completion.reminderAt; x.reminderNotified = completion.reminderNotified; x.nextAttemptAt = Date.parse(completion.reminderAt); x.deliveredSubscriptionHashes = []; x.leaseToken = null; }
  async completeReminder(path, token, completion) { const x = [...this.reminders.values()].find(y => y.path === path); x.completed = true; x.leaseToken = null; }
  async retryReminder(path, token, now) { const x = [...this.reminders.values()].find(y => y.path === path); x.nextAttemptAt = now + 30000; x.leaseToken = null; }
  async pauseReminder(path, token) { const x = [...this.reminders.values()].find(y => y.path === path); x.nextAttemptAt = Number.MAX_SAFE_INTEGER; x.leaseToken = null; }
}

const bearer = { authorization: 'Bearer valid' };
async function setup() {
  const store = new FakeStore();
  const server = createReminderService({ auth: { async verifyIdToken(token, revoked) { assert.equal(revoked, true); if (token !== 'valid') throw new Error('bad'); return { uid: 'u1' }; } }, store, push: { async sendNotification() {} }, vapidPublicKey: 'public', appOrigin: 'https://app.example' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, store, base, close: () => new Promise(resolve => server.close(resolve)) };
}
const note = (id, props = {}) => ({ id, reminderAt: '2030-01-01T12:00:00.000Z', reminderNotified: false, reminderRepeat: null, archived: false, isPrivate: false, ...props });
const subscription = endpoint => ({ endpoint, keys: { p256dh: 'encoded-key', auth: 'encoded-auth' } });

test('push endpoints are limited to known HTTPS providers and standard port', () => {
  assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(isAllowedPushEndpoint('https://push.services.mozilla.com/wpush/v2/abc'), true);
  assert.equal(isAllowedPushEndpoint('https://one.notify.windows.com/wpush/v2/abc'), true);
  for (const value of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x', 'https://127.0.0.1/x']) assert.equal(isAllowedPushEndpoint(value), false, value);
});

test('a notified one-time source is retained as completed, not re-armed by a later snapshot', () => {
  const state = scheduleDocument({ noteId: 'n', reminderAt: '2020-01-01T00:00:00.000Z', reminderNotified: true, reminderRepeat: null, isPrivate: false }, null, Date.now());
  assert.equal(state.completed, true);
  assert.equal(state.nextAttemptAt, Number.MAX_SAFE_INTEGER);
});

test('public health/config, exact-origin CORS, and revoked-token auth', async t => {
  const env = await setup(); t.after(env.close);
  let response = await fetch(`${env.base}/healthz`); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  response = await fetch(`${env.base}/v1/config`); assert.equal((await response.json()).vapidPublicKey, 'public');
  response = await fetch(`${env.base}/v1/reminders`, { headers: { ...bearer, origin: 'https://evil.example' } }); assert.equal(response.status, 403);
  response = await fetch(`${env.base}/v1/reminders`, { headers: { authorization: 'Bearer revoked' } }); assert.equal(response.status, 401);
  response = await fetch(`${env.base}/v1/reminders`, { headers: bearer }); assert.equal(response.status, 200);
});

test('deletion tombstones block new subscriptions but allow account cleanup', async t => {
  const env = await setup(); t.after(env.close); env.store.account.tombstoned = true;
  let response = await fetch(`${env.base}/v1/subscriptions`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subscription('https://fcm.googleapis.com/fcm/send/x') }) });
  assert.equal(response.status, 403);
  response = await fetch(`${env.base}/v1/reminders`, { method: 'DELETE', headers: bearer }); assert.equal(response.status, 200);
});

test('subscription endpoint rejects SSRF, stores only endpoint hash; account disable is all-devices', async t => {
  const env = await setup(); t.after(env.close);
  let response = await fetch(`${env.base}/v1/subscriptions`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subscription('https://evil.example/x') }) });
  assert.equal(response.status, 400); assert.equal(env.store.subs.size, 0);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/sample';
  response = await fetch(`${env.base}/v1/subscriptions`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subscription(endpoint) }) });
  assert.equal(response.status, 201); assert.equal(env.store.subs.size, 1);
  response = await fetch(`${env.base}/v1/reminders`, { method: 'DELETE', headers: bearer });
  assert.equal(response.status, 200); assert.equal(env.store.subs.size, 0); assert.equal(env.store.disabled, true);
});

test('PUT validates active revision/canonical note, preserves private schedules by default, and returns source/effective metadata', async t => {
  const env = await setup(); t.after(env.close);
  env.store.notes.set('public-1', note('public-1'));
  env.store.notes.set('private-1', note('private-1', { isPrivate: true, updatedAt: 'v1' }));
  const post = (body) => fetch(`${env.base}/v1/reminders`, { method: 'PUT', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let response = await post({ revision: 'wrong', reminders: [] }); assert.equal(response.status, 409);
  response = await post({ revision: 'r1', privateMode: 'replace', reminders: [
    { noteId: 'public-1', reminderAt: '2030-01-01T12:00:00.000Z', reminderNotified: false, reminderRepeat: null, isPrivate: false },
    { noteId: 'private-1', reminderAt: '2030-01-01T12:00:00.000Z', reminderNotified: false, reminderRepeat: null, isPrivate: true, privateUpdatedAt: 'v1' }
  ] });
  assert.equal(response.status, 200); assert.equal(env.store.reminders.size, 2);
  response = await post({ revision: 'r1', privateMode: 'preserve', reminders: [] }); assert.equal(response.status, 200); assert.equal(env.store.reminders.size, 1); assert.equal([...env.store.reminders.values()][0].isPrivate, true);
  const get = await fetch(`${env.base}/v1/reminders`, { headers: bearer }); const state = await get.json();
  assert.equal(state.reminders[0].sourceReminderAt, '2030-01-01T12:00:00.000Z');
  response = await post({ revision: 'r1', reminders: Array(2001).fill({}) }); assert.equal(response.status, 400);
});

test('worker keeps current active library revision, persists per-subscription success, and retries only failed devices', async () => {
  const store = new FakeStore();
  store.account.activeLibraryRevision = 'r2'; store.revision = 'r2';
  store.notes.set('n1', note('n1', { reminderAt: '2020-01-01T00:00:00.000Z' }));
  const at = '2020-01-01T00:00:00.000Z';
  const item = { noteId: 'n1', reminderAt: at, reminderNotified: false, reminderRepeat: null, isPrivate: false };
  const source = { reminderAt: at, reminderNotified: false, reminderRepeat: null, isPrivate: false, privateUpdatedAt: '' };
  store.reminders.set('n1', { ...item, sourceReminderAt: at, sourceReminderNotified: false, sourceReminderRepeat: null, sourcePrivateUpdatedAt: '', sourceKey: 'source', nextAttemptAt: 1, uid: 'u1', revision: 'r1', path: 'users/u1/backgroundReminders/n1', deliveredSubscriptionHashes: [] });
  store.subs.set('good', { endpoint: 'https://fcm.googleapis.com/x', keys: {} }); store.subs.set('flaky', { endpoint: 'https://fcm.googleapis.com/y', keys: {} });
  let calls = [];
  let sent = 0;
  const push = { async sendNotification(sub, payload) { calls.push(JSON.parse(payload)); if (sub.endpoint.endsWith('/y') && sent++ === 0) throw new Error('transient'); } };
  await deliverDue({ store, push, now: () => Date.now(), limit: 10 });
  let current = store.reminders.get('n1'); assert.deepEqual(current.deliveredSubscriptionHashes, ['good']); assert.ok(current.nextAttemptAt > Date.now()); assert.equal(calls[0].body, 'You have a note reminder.'); assert.equal(calls[0].data.noteId, 'n1'); assert.equal('url' in calls[0].data, false);
  current.nextAttemptAt = 1;
  await deliverDue({ store, push, now: () => Date.now(), limit: 10 });
  current = store.reminders.get('n1'); assert.equal(current.completed, true); assert.equal(calls.length, 3, 'the already delivered endpoint is not sent twice');
});

function seedDue(store, props = {}) {
  const at = '2020-01-01T09:00:00.000Z';
  const raw = note('n', { reminderAt: at, ...props });
  store.notes.set('n', raw);
  const item = { noteId: 'n', reminderAt: at, reminderNotified: false, reminderRepeat: props.reminderRepeat || null, isPrivate: Boolean(props.isPrivate), privateUpdatedAt: props.updatedAt || '' };
  store.reminders.set('n', { ...scheduleDocument(item, null, 1), uid: 'u1', revision: 'r1', path: 'users/u1/backgroundReminders/n' });
  store.subs.set('device', { endpoint: 'https://fcm.googleapis.com/fcm/send/device', keys: {} });
}

test('private recurring delivery uses generic payloads and catches up directly to the next future occurrence', async () => {
  const store = new FakeStore();
  seedDue(store, { isPrivate: true, updatedAt: 'encrypted-v1', title: 'Secret title', text: 'Secret content', reminderRepeat: { frequency: 'daily', interval: 1, timeZone: 'UTC', anchorAt: '2020-01-01T09:00:00.000Z' } });
  let sent;
  const now = Date.parse('2026-10-18T09:00:00.000Z');
  await deliverDue({ store, now: () => now, push: { async sendNotification(sub, payload, options) { sent = payload; assert.equal(options.timeout, 10000); } } });
  assert.equal(JSON.parse(sent).body, 'You have a private note reminder.');
  assert.ok(!sent.includes('Secret'));
  assert.equal(store.reminders.get('n').reminderAt, '2026-10-19T09:00:00.000Z');
  assert.equal(store.reminders.get('n').reminderNotified, false);
});

test('expired push subscriptions are removed and undelivered reminders pause instead of spinning', async () => {
  const store = new FakeStore(); seedDue(store);
  await deliverDue({ store, push: { async sendNotification() { throw Object.assign(new Error('expired'), { statusCode: 410 }); } } });
  assert.equal(store.subs.size, 0);
  assert.equal(store.reminders.get('n').nextAttemptAt, Number.MAX_SAFE_INTEGER);
  assert.notEqual(store.reminders.get('n').completed, true);
});

test('account opt-out cancels claimed reminders before any external dispatch', async () => {
  const store = new FakeStore(); seedDue(store);
  store.account.backgroundRemindersEnabled = false;
  let sends = 0;
  await deliverDue({ store, push: { async sendNotification() { sends++; } } });
  assert.equal(sends, 0);
  assert.equal(store.reminders.size, 0);
});

test('malformed null payloads return client errors rather than server failures', async t => {
  const env = await setup(); t.after(env.close);
  for (const [path, method] of [['/v1/subscriptions', 'POST'], ['/v1/subscriptions', 'DELETE'], ['/v1/reminders', 'PUT']]) {
    const response = await fetch(`${env.base}${path}`, { method, headers: { ...bearer, 'content-type': 'application/json' }, body: 'null' });
    assert.equal(response.status, 400);
  }
});
