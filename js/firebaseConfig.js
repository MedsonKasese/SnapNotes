import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { getFirestore, collection, getDocs } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBERoeYLfG93LGYleo7GW0mxeOMYF1F2b8",
  authDomain: "snapnotes-uid2002.firebaseapp.com",
  projectId: "snapnotes-uid2002",
  storageBucket: "snapnotes-uid2002.firebasestorage.app",
  messagingSenderId: "398214917269",
  appId: "1:398214917269:web:ba3f293f8b13bdd966ff9c"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Expose to window for global access by non-module scripts if needed
window.firebaseAuth = auth;

export { app, auth, db, collection, getDocs };