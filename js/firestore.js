import { app } from "./firebaseConfig.js";

import {
    getFirestore,
    collection,
    addDoc,
    getDocs
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const db = getFirestore(app);

export async function saveNoteToFirestore(uid, note) {

    try {

        await addDoc(
            collection(db, "users", uid, "notes"),
            note
        );

        console.log("Note saved to Firestore");

    } catch (error) {

        console.error(error);

    }

}

export { db, getDocs, collection };