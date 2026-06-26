import { auth } from "./firebaseConfig.js";
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { loadFromCloud } from "./firestore.js";

// ELEMENTS
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const signupBtn = document.getElementById("signupBtn");
const signinBtn = document.getElementById("signinBtn");
const loginBtn = document.getElementById("loginBtn");
const userAvatar = document.getElementById("userAvatar");
const authModal = document.getElementById("authModal");
const closeModalBtn = document.getElementById("closeModalBtn");

// =========================
// AUTH ACTIONS
// =========================

signupBtn.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
        window.showToast("Please fill out all fields.", "warning");
        return;
    }

    try {
        await createUserWithEmailAndPassword(auth, email, password);
        window.showToast("Account created!", "success");
        closeModal();
    } catch (error) {
        handleAuthError(error);
    }
});

signinBtn.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();

    if (!email || !password) {
        window.showToast("Please fill out all fields.", "warning");
        return;
    }

    try {
        await signInWithEmailAndPassword(auth, email, password);
        window.showToast(`Welcome! ${user.email.split('@')[0]} `, "success");
        closeModal();
    } catch (error) {
        handleAuthError(error);
    }
});

loginBtn.addEventListener("click", () => {
    authModal.classList.add("show");
});

userAvatar.addEventListener("click", () => {
    if (confirm("Are you sure you want to log out?")) {
        signOut(auth).then(() => {
            // Clear local notes and storage on logout
            window.notes = [];
            localStorage.removeItem("SnapNotes");
            window.renderNotes();
            window.showToast("Logged Out", "warning");
        });
    }
});

closeModalBtn.addEventListener("click", closeModal);

function closeModal() {
    authModal.classList.remove("show");
    emailInput.value = "";
    passwordInput.value = "";
}

// =========================
// AUTH STATE LISTENER
// =========================

onAuthStateChanged(auth, (user) => {
    if (user) {
        const initials = user.email.substring(0, 2).toUpperCase();
        userAvatar.textContent = initials;
        userAvatar.style.display = "flex";
        loginBtn.style.display = "none";
        
        // Load notes from cloud upon login
        loadFromCloud(user.uid);
    } else {
        userAvatar.style.display = "none";
        loginBtn.style.display = "block";
        loginBtn.textContent = "Sign In";
    }
});

function handleAuthError(error) {
    let message = "An error occurred.";
    if (error.code === 'auth/email-already-in-use') message = "Email address already in use.";
    else if (error.code === 'auth/invalid-credential') message = "Invalid email or password.";
    else if (error.code === 'auth/user-disabled') message = "Account disabled.Please Contact Support";
    else if (error.code === 'auth/weak-password') message = "Password must be at least 6 characters.";
    else if (error.code === 'auth/invalid-email') message = "Please enter a valid email address.";
    else if (error.code === 'auth/network-request-failed') message = " Network error. Check your connection.";
    else if (error.code === 'auth/too-main-requests') message = "Too main attempts. Please try again later.";
    
    window.showToast(message, "warning");
}
