import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFirestoreReminderStore } from '../backend/reminders/firestore-store.mjs';

class MemoryFirestore {
  data = new Map();
  collection(path) { return new CollectionRef(this, path); }
  doc(path) { return new DocRef(this, path); }
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: ref => ref.get(),
      set: (ref, value, options) => writes.push(() => ref.set(value, options)),
      update: (ref, value) => writes.push(() => ref.update(value)),
      delete: ref => writes.push(() => ref.delete())
    };
    const result = await fn(tx); for (const apply of writes) await apply(); return result;
  }
  batch() {
    const writes = [];
    return { delete: ref => writes.push(() => ref.delete()), update: (ref, value) => writes.push(() => ref.update(value)), commit: async () => { for (const apply of writes) await apply(); } };
  }
  collectionGroup(name) { return new CollectionRef(this, `__group__/${name}`); }
}
class DocRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').at(-1); }
  collection(name) { return new CollectionRef(this.db, `${this.path}/${name}`); }
  async get() { const value = this.db.data.get(this.path); return { exists: value !== undefined, id: this.id, ref: this, data: () => value && structuredClone(value) }; }
  async set(value, options = {}) { this.db.data.set(this.path, options.merge ? { ...(this.db.data.get(this.path) || {}), ...structuredClone(value) } : structuredClone(value)); }
  async update(value) { if (!this.db.data.has(this.path)) throw new Error('missing'); this.db.data.set(this.path, { ...this.db.data.get(this.path), ...structuredClone(value) }); }
  async delete() { this.db.data.delete(this.path); }
}
class CollectionRef {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new DocRef(this.db, `${this.path}/${id}`); }
  where() { return this; } orderBy() { return this; } limit() { return this; }
  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.db.data.entries()].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(([path, value]) => ({ id: path.split('/').at(-1), ref: new DocRef(this.db, path), data: () => structuredClone(value) }));
    return { docs, size: docs.length };
  }
}

const hashId = id => createHash('sha256').update(id).digest('hex');
const source = { noteId: 'note', sourceKey: 'stable-source', sourceReminderAt: '2030-01-01T00:00:00.000Z', sourceReminderNotified: false, sourceReminderRepeat: null, sourcePrivateUpdatedAt: '', reminderAt: '2030-01-02T00:00:00.000Z', reminderNotified: false, reminderRepeat: null, isPrivate: false, nextAttemptAt: 1, completed: false, attempts: 4, deliveredSubscriptionHashes: ['a', 'b'], leaseToken: 'worker-lease', leaseUntil: 999999, workerExtra: { retained: true } };
function setup() { const db = new MemoryFirestore(); const store = createFirestoreReminderStore(db, {}); return { db, store }; }
function seedUser(db) { db.data.set('users/u', { activeLibraryRevision: 'r1' }); }

test('same-source PUT preserves the entire fresh worker-advanced effective state, lease, and delivery ledger', async () => {
  const { db, store } = setup(); seedUser(db);
  const ref = db.doc(`users/u/backgroundReminders/${hashId('note')}`); await ref.set(source);
  const saved = await store.replaceReminders({
    uid: 'u', revision: 'r1', reminders: [{ noteId: 'note', reminderAt: source.sourceReminderAt, reminderNotified: false, reminderRepeat: null, isPrivate: false }],
    privateMode: 'replace', canonicalNote: async () => ({}), assertCanonical: () => {}, makeSchedule: () => ({ ...source, reminderAt: source.sourceReminderAt, deliveredSubscriptionHashes: [], attempts: 0 }), now: 77
  });
  assert.equal(saved[0].reminderAt, source.reminderAt);
  assert.deepEqual(saved[0].deliveredSubscriptionHashes, ['a', 'b']);
  assert.equal(saved[0].attempts, 4); assert.equal(saved[0].leaseToken, 'worker-lease'); assert.equal(saved[0].leaseUntil, 999999);
  assert.deepEqual(saved[0].workerExtra, { retained: true });
  assert.equal(saved[0].revision, 'r1'); assert.equal(saved[0].updatedAt, 77);
});

test('disable generation prevents a stale snapshot from writing after account-wide opt-out', async () => {
  const { db, store } = setup(); seedUser(db);
  const ref = db.doc(`users/u/backgroundReminders/${hashId('note')}`); await ref.set(source);
  let didDisable = false;
  await assert.rejects(store.replaceReminders({
    uid: 'u', revision: 'r1', reminders: [{ noteId: 'note', reminderAt: source.sourceReminderAt, reminderNotified: false, reminderRepeat: null, isPrivate: false }],
    privateMode: 'replace', canonicalNote: async () => { if (!didDisable) { didDisable = true; await store.disableAccount('u'); } return {}; },
    assertCanonical: () => {}, makeSchedule: () => ({ ...source }), now: 77
  }), /conflict/);
  assert.equal((await store.getAccount('u')).backgroundRemindersEnabled, false);
  assert.equal((await store.listReminders('u')).length, 0);
});

test('conditional worker deletion cannot remove a replacement with a newer lease token', async () => {
  const { db, store } = setup();
  const ref = db.doc('users/u/backgroundReminders/r'); await ref.set({ leaseToken: 'new-worker', noteId: 'replacement' });
  await store.deleteReminder(ref.path, 'stale-worker');
  assert.equal((await ref.get()).exists, true);
  await store.deleteReminder(ref.path, 'new-worker');
  assert.equal((await ref.get()).exists, false);
});
