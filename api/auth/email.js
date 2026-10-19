import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createAuthEmailHandler } from "../../lib/auth-email.js";

function getServices() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Firebase server credentials are missing.");
  const app = getApps()[0] || initializeApp({ credential: cert(JSON.parse(raw)) });
  return { auth: getAuth(app), db: getFirestore(app) };
}

export default createAuthEmailHandler({ getServices });
