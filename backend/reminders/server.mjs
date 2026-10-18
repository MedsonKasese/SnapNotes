import admin from 'firebase-admin';
import webpush from 'web-push';
import { createReminderService, deliverDue } from './service.mjs';
import { createFirestoreReminderStore } from './firestore-store.mjs';

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required');
  const value = JSON.parse(raw);
  if (!value.project_id || !value.client_email || !value.private_key) throw new Error('Invalid Firebase service account configuration');
  return value;
}

const account = loadServiceAccount();
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(account), projectId: account.project_id });
const privateKey = process.env.VAPID_PRIVATE_KEY;
const publicKey = process.env.VAPID_PUBLIC_KEY;
const appOrigin = process.env.APP_ORIGIN;
if (!privateKey || !publicKey || !appOrigin) throw new Error('VAPID keys and APP_ORIGIN are required');
webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:admin@${new URL(appOrigin).hostname}`, publicKey, privateKey);
const store = createFirestoreReminderStore(admin.firestore(), admin.auth());
const server = createReminderService({ auth: admin.auth(), store, push: webpush, vapidPublicKey: publicKey, appOrigin });
let running = false;
let shuttingDown = false;
let activeWorker = Promise.resolve();
const runWorker = async () => {
  if (running || shuttingDown) return;
  running = true;
  activeWorker = deliverDue({ store, push: webpush, limit: 25 }).catch(() => { console.error('background reminder worker cycle failed'); }).finally(() => { running = false; });
  await activeWorker;
};
const timer = setInterval(runWorker, 20000);
timer.unref();
server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('SnapNotes background reminder service listening'));
const shutdown = () => { if (shuttingDown) return; shuttingDown = true; clearInterval(timer); server.close(() => { void activeWorker.finally(() => admin.app().delete().finally(() => process.exit(0))); }); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
