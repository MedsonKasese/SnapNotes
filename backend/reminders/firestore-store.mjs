import { FieldValue } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'node:crypto';

const userRef = (db, uid) => db.collection('users').doc(uid);
const reminderCollection = (db, uid) => userRef(db, uid).collection('backgroundReminders');
const subscriptionCollection = (db, uid) => userRef(db, uid).collection('pushSubscriptions');
const noteDocId = id => createHash('sha256').update(id).digest('hex');
const SNAPSHOT_LIMIT = 2000;

export function createFirestoreReminderStore(db, auth) {
  return {
    async putSubscription(uid, hash, data) {
      const user = userRef(db, uid), tomb = db.collection('accountDeletionTombstones').doc(uid), control = user.collection('backgroundReminderControl').doc('state');
      await db.runTransaction(async tx => {
        const [accountSnap, tombSnap, stateSnap] = await Promise.all([tx.get(user), tx.get(tomb), tx.get(control)]);
        if (!accountSnap.exists || tombSnap.exists || accountSnap.data()?.accountDeletion?.status === 'processing') throw new Error('conflict');
        const state = stateSnap.exists ? stateSnap.data() : { enabled: true, generation: 0 };
        const generation = (Number(state.generation) || 0) + (state.enabled === false ? 1 : 0);
        tx.set(control, { enabled: true, generation, updatedAt: Date.now() });
        tx.set(subscriptionCollection(db, uid).doc(hash), data, { merge: true });
      });
    },
    async deleteSubscription(uid, hash) { await subscriptionCollection(db, uid).doc(hash).delete(); },
    async listSubscriptions(uid) {
      const snap = await subscriptionCollection(db, uid).get();
      return snap.docs.map(doc => ({ hash: doc.id, data: doc.data() }));
    },
    async listReminders(uid) {
      const snap = await reminderCollection(db, uid).get(); return snap.docs.map(doc => ({ ...doc.data(), path: doc.ref.path }));
    },
    async getLibraryPages(uid, revision) {
      const snap = await userRef(db, uid).collection('libraries').doc(String(revision)).collection('pages').get();
      return snap.docs.map(doc => doc.data());
    },
    async getAccount(uid) {
      const controlRef = userRef(db, uid).collection('backgroundReminderControl').doc('state');
      const [user, tombstone, control] = await Promise.all([userRef(db, uid).get(), db.collection('accountDeletionTombstones').doc(uid).get(), controlRef.get()]);
      if (!user.exists) return tombstone.exists ? { tombstoned: true, backgroundRemindersEnabled: false } : null;
      const data = user.data();
      return { ...data, tombstoned: tombstone.exists, deleting: data.accountDeletion?.status === 'processing', backgroundRemindersEnabled: control.exists ? control.data().enabled !== false : true };
    },
    async resumePaused(uid, now) {
      const snap = await reminderCollection(db, uid).where('paused', '==', true).get();
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = db.batch(); for (const doc of snap.docs.slice(i, i + 400)) batch.update(doc.ref, { paused: false, nextAttemptAt: Math.min(Number(doc.data().nextAttemptAt) || now, now) }); await batch.commit();
      }
    },
    async replaceReminders({ uid, revision, reminders, privateMode, canonicalNote, assertCanonical, makeSchedule, now }) {
      const user = userRef(db, uid);
      const collection = reminderCollection(db, uid);
      const controlRef = user.collection('backgroundReminderControl').doc('state');
      const lockRef = user.collection('backgroundReminderControl').doc('sync');
      const tombRef = db.collection('accountDeletionTombstones').doc(uid);
      const pagesCache = new Map();
      let generation = 0;
      const lock = randomUUID();
      await db.runTransaction(async tx => {
        const [accountSnap, tombstoneSnap, currentSnap, lockSnap, controlSnap] = await Promise.all([tx.get(user), tx.get(tombRef), tx.get(collection), tx.get(lockRef), tx.get(controlRef)]);
        if (!accountSnap.exists || tombstoneSnap.exists || accountSnap.data()?.accountDeletion?.status === 'processing' || String(accountSnap.data()?.activeLibraryRevision || '') !== String(revision) || controlSnap.exists && controlSnap.data().enabled === false) throw new Error('conflict');
        generation = controlSnap.exists ? Number(controlSnap.data().generation) || 0 : 0;
        if (lockSnap.exists && Number(lockSnap.data().expiresAt) > now) throw new Error('conflict');
        tx.set(lockRef, { token: lock, expiresAt: now + 120000 });
      });
      try {
        const account = await user.get();
        if (!account.exists || String(account.data()?.activeLibraryRevision || '') !== String(revision)) throw new Error('conflict');
        const existing = await collection.get();
        const oldById = new Map(existing.docs.map(doc => [doc.id, doc.data()]));
        const reconciled = [];
        for (const item of reminders) {
          const note = await canonicalNote(this, uid, revision, item.noteId, pagesCache);
          const prior = oldById.get(noteDocId(item.noteId));
          try { assertCanonical(item, note); reconciled.push({ item, prior, keep: false }); }
          catch (error) {
            if (!prior) throw error;
            const source = { noteId: item.noteId, isPrivate: prior.isPrivate, reminderAt: prior.sourceReminderAt, reminderNotified: prior.sourceReminderNotified, reminderRepeat: prior.sourceReminderRepeat, privateUpdatedAt: prior.sourcePrivateUpdatedAt };
            assertCanonical(source, note);
            if (item.isPrivate !== prior.isPrivate || item.reminderAt !== prior.reminderAt || item.reminderNotified !== prior.reminderNotified || JSON.stringify(item.reminderRepeat ?? null) !== JSON.stringify(prior.reminderRepeat ?? null) || item.isPrivate && item.privateUpdatedAt !== prior.sourcePrivateUpdatedAt) throw error;
            reconciled.push({ item, prior, keep: true });
          }
        }
        const incoming = new Map(reconciled.map(entry => [noteDocId(entry.item.noteId), entry]));
        const resulting = [];
        if (privateMode === 'preserve') {
          for (const doc of existing.docs) if (doc.data().isPrivate && !incoming.has(doc.id)) resulting.push(doc.data());
        }
        for (const [id, entry] of incoming) {
          const { item, prior, keep } = entry;
          const data = keep ? prior : makeSchedule(item, prior, now);
          resulting.push({ ...data, noteId: item.noteId, revision: String(revision), uid, updatedAt: now });
        }
        if (resulting.length > SNAPSHOT_LIMIT) throw new Error('invalid');
        const ids = new Set(resulting.map(item => noteDocId(item.noteId)));
        for (const doc of existing.docs.filter(doc => !ids.has(doc.id))) await db.runTransaction(async tx => {
          const [accountSnap, tombSnap, controlSnap, lockSnap, fresh] = await Promise.all([tx.get(user), tx.get(tombRef), tx.get(controlRef), tx.get(lockRef), tx.get(doc.ref)]);
          if (!accountSnap.exists || tombSnap.exists || accountSnap.data()?.accountDeletion?.status === 'processing' || String(accountSnap.data()?.activeLibraryRevision || '') !== String(revision) || controlSnap.exists && (controlSnap.data().enabled === false || (Number(controlSnap.data().generation) || 0) !== generation) || lockSnap.data()?.token !== lock) throw new Error('conflict');
          if (fresh.exists) tx.delete(doc.ref);
        });
        for (const item of resulting) {
          const id = noteDocId(item.noteId); const ref = collection.doc(id);
          await db.runTransaction(async tx => {
            const [accountSnap, tombSnap, controlSnap, lockSnap, fresh] = await Promise.all([tx.get(user), tx.get(tombRef), tx.get(controlRef), tx.get(lockRef), tx.get(ref)]);
            if (!accountSnap.exists || tombSnap.exists || accountSnap.data()?.accountDeletion?.status === 'processing' || String(accountSnap.data()?.activeLibraryRevision || '') !== String(revision) || controlSnap.exists && (controlSnap.data().enabled === false || (Number(controlSnap.data().generation) || 0) !== generation) || lockSnap.data()?.token !== lock) throw new Error('conflict');
            let data = item;
            if (fresh.exists && item.sourceKey && fresh.data().sourceKey === item.sourceKey) data = { ...fresh.data(), revision: String(revision), uid, updatedAt: now };
            data = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
            tx.set(ref, data);
          });
        }
        const [latest, tombstone, control] = await Promise.all([user.get(), tombRef.get(), controlRef.get()]);
        if (!latest.exists || tombstone.exists || latest.data()?.accountDeletion?.status === 'processing' || String(latest.data()?.activeLibraryRevision || '') !== String(revision) || control.exists && (control.data().enabled === false || (Number(control.data().generation) || 0) !== generation)) throw new Error('conflict');
        return (await collection.get()).docs.map(doc => doc.data());
      } finally {
        await db.runTransaction(async tx => { const snap = await tx.get(lockRef); if (snap.exists && snap.data().token === lock) tx.delete(lockRef); }).catch(() => {});
      }
    },
    async disableAccount(uid) {
      const control = userRef(db, uid).collection('backgroundReminderControl').doc('state');
      let generation;
      await db.runTransaction(async tx => { const snap = await tx.get(control); generation = (Number(snap.data()?.generation) || 0) + 1; tx.set(control, { enabled: false, generation, disabledAt: Date.now() }); });
      for (const collection of [subscriptionCollection(db, uid), reminderCollection(db, uid)]) {
        const snap = await collection.get();
        for (const doc of snap.docs) await db.runTransaction(async tx => {
          const [stateSnap, fresh] = await Promise.all([tx.get(control), tx.get(doc.ref)]);
          if (stateSnap.exists && stateSnap.data().enabled === false && (Number(stateSnap.data().generation) || 0) === generation && fresh.exists) tx.delete(doc.ref);
        });
      }
    },
    async queryDue(now, limit) {
      const snap = await db.collectionGroup('backgroundReminders').where('nextAttemptAt', '<=', now).orderBy('nextAttemptAt').limit(limit).get();
      return snap.docs.filter(d => d.ref.parent.parent?.parent?.id === 'users').map(d => ({ path: d.ref.path, ...d.data() }));
    },
    async claim(path, lease, now) {
      const ref = db.doc(path);
      return db.runTransaction(async tx => {
        const snap = await tx.get(ref); if (!snap.exists) return false;
        const data = snap.data();
        if (data.completed || Number(data.nextAttemptAt) > now || Number(data.leaseUntil) > now) return false;
        tx.update(ref, { leaseToken: lease, leaseUntil: now + 60000 }); return true;
      });
    },
    async readClaimed(path, lease) {
      const snap = await db.doc(path).get(); if (!snap.exists || snap.data().leaseToken !== lease) return null;
      const data = snap.data(); const parts = path.split('/');
      return { ...data, path, uid: parts[1], noteId: data.noteId };
    },
    async markSubscriptionDelivered(path, lease, hash) {
      await db.runTransaction(async tx => { const ref = db.doc(path); const snap = await tx.get(ref); if (!snap.exists || snap.data().leaseToken !== lease) return; const values = new Set(snap.data().deliveredSubscriptionHashes || []); values.add(hash); tx.update(ref, { deliveredSubscriptionHashes: [...values] }); });
    },
    async deleteReminder(path, lease) {
      const ref = db.doc(path);
      await db.runTransaction(async tx => { const snap = await tx.get(ref); if (snap.exists && typeof lease === 'string' && snap.data().leaseToken === lease) tx.delete(ref); });
    },
    async renewLease(path, lease, now) {
      const ref = db.doc(path); return db.runTransaction(async tx => { const snap = await tx.get(ref); if (!snap.exists || snap.data().leaseToken !== lease || Number(snap.data().leaseUntil) <= now) return false; tx.update(ref, { leaseUntil: now + 60000 }); return true; });
    },
    async isNoteDeleted(uid, noteId) { return (await userRef(db, uid).collection('deletedNotes').doc(encodeURIComponent(noteId)).get()).exists; },
    async pauseReminder(path, lease) { await this._updateLease(path, lease, { nextAttemptAt: Number.MAX_SAFE_INTEGER, paused: true, leaseUntil: 0, leaseToken: FieldValue.delete() }); },
    async advanceReminder(path, lease, completion, now) { await this._updateLease(path, lease, { reminderAt: completion.reminderAt, reminderNotified: completion.reminderNotified, nextAttemptAt: Date.parse(completion.reminderAt), attempts: 0, deliveredSubscriptionHashes: [], leaseUntil: 0, leaseToken: FieldValue.delete(), lastDeliveredAt: now }); },
    async completeReminder(path, lease, completion, now) { await this._updateLease(path, lease, { reminderAt: completion.reminderAt, reminderNotified: true, nextAttemptAt: Number.MAX_SAFE_INTEGER, completed: true, leaseUntil: 0, leaseToken: FieldValue.delete(), lastDeliveredAt: now }); },
    async retryReminder(path, lease, now) {
      const snap = await db.doc(path).get(); if (!snap.exists || snap.data().leaseToken !== lease) return;
      const tries = Math.min(20, Number(snap.data().attempts || 0) + 1); const delay = Math.min(6 * 3600000, 30000 * (2 ** Math.min(tries, 10)));
      await this._updateLease(path, lease, { attempts: tries, nextAttemptAt: now + delay, leaseUntil: 0, leaseToken: FieldValue.delete() });
    },
    async _updateLease(path, lease, values) { await db.runTransaction(async tx => { const ref = db.doc(path); const snap = await tx.get(ref); if (snap.exists && snap.data().leaseToken === lease) tx.update(ref, values); }); }
  };
}
