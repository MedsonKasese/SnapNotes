import { db, collection, getDocs } from "./firebaseConfig.js";
import { 
    doc, 
    setDoc, 
    deleteDoc, 
    getDoc 
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

// =========================
// CLOUD SYNC LOGIC
// =========================

/**
 * Syncs the current local 'notes' array to Firestore for the logged-in user.
 */
export async function syncToCloud() {
    const auth = window.firebaseAuth; // Assuming auth is exposed or accessible
    if (!auth || !auth.currentUser) return;

    const uid = auth.currentUser.uid;
    try {
        const userDocRef = doc(db, "users", uid);
        await setDoc(userDocRef, { 
             notes: window.notes,
             lastSynced: new Date().toISOString()
        }, { merge: true });

        console.log("Cloud sync successful");
    } catch (error) {
        console.error("Cloud sync failed:", error);
    }
}

/**
 * Loads notes from Firestore and merges them with local storage.
 */
export async function loadFromCloud(uid) {
    try {
        const userDocRef = doc(db, "users", uid);
        const docSnap = await getDoc(userDocRef);

        if (docSnap.exists()) {
            const cloudData = docSnap.data();
            if (cloudData.notes) {
                // Simple merge: Cloud wins for this implementation
                window.notes = cloudData.notes;
                localStorage.setItem("SnapNotes", JSON.stringify(window.notes));
                window.renderNotes();
                window.showToast("Notes synced from cloud", "success");
            }
        }
    } catch (error) {
        console.error("Failed to load from cloud:", error);
    }
}

window.syncToCloud = syncToCloud;
