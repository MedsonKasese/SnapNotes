import { auth } from "./firebaseConfig.js";
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { loadFromCloud } from "./firestore.js";

const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const signupBtn = document.getElementById("signupBtn");
const signinBtn = document.getElementById("signinBtn");
const loginBtn = document.getElementById("loginBtn");
const userAvatar = document.getElementById("userAvatar");
const authModal = document.getElementById("authModal");
const closeModalBtn = document.getElementById("closeModalBtn");

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
    const password = passwordInput.value;

    if (!email || !password) {
        window.showToast("Please fill out all fields.", "warning");
        return;
    }

    try {
        await signInWithEmailAndPassword(auth, email, password);
        window.showToast(`Welcome, ${email.split("@")[0]}!`, "success");
        closeModal();
    } catch (error) {
        handleAuthError(error);
    }
});

loginBtn.addEventListener("click", openAuthModal);

userAvatar.addEventListener("click", () => {
    const user = auth.currentUser;
    if (!user) return;

    if (!confirm(`Log out ${user.email}?`)) return;

    signOut(auth)
        .then(() => {
            window.notes = [];
            localStorage.removeItem("SnapNotes");
            window.renderNotes("", "all");
            if (typeof window.updateNavigationCounts === "function") {
                window.updateNavigationCounts();
            }
            window.showToast("Logged out", "warning");
        })
        .catch(error => {
            console.error("Logout failed:", error);
            window.showToast("Could not log out. Try again.", "warning");
        });
});

closeModalBtn.addEventListener("click", closeModal);

authModal.addEventListener("click", event => {
    if (event.target === authModal) closeModal();
});

function openAuthModal() {
    authModal.classList.add("show");
    authModal.setAttribute("aria-hidden", "false");
    emailInput.focus();
}

function closeModal() {
    authModal.classList.remove("show");
    authModal.setAttribute("aria-hidden", "true");
    emailInput.value = "";
    passwordInput.value = "";
}

onAuthStateChanged(auth, user => {
    if (user) {
        const initials = user.email
            ? user.email.substring(0, 2).toUpperCase()
            : "U";

        userAvatar.textContent = initials;
        userAvatar.title = `Signed in as ${user.email || "user" }`;
        userAvatar.hidden = false;
        loginBtn.hidden = true;

        loadFromCloud(user.uid);
    } else {
        userAvatar.hidden = true;
        loginBtn.hidden = false;
        loginBtn.querySelector("span").textContent = "Sign In";
    }
});

function handleAuthError(error) {
    let message = "Something went wrong. Please try again.";

    if (error.code === "auth/email-already-in-use") {
        message = "Email address already in use.";
    } else if (error.code === "auth/invalid-credential") {
        message = "Invalid email or password.";
    } else if (error.code === "auth/user-disabled") {
        message = "This account has been disabled.";
    } else if (error.code === "auth/weak-password") {
        message = "Password must be at least 6 characters.";
    } else if (error.code === "auth/invalid-email") {
        message = "Please enter a valid email address.";
    } else if (error.code === "auth/network-request-failed") {
        message = "Network error. Check your connection.";
    } else if (error.code === "auth/too-many-requests") {
        message = "Too many attempts. Please try again later.";
    }

    window.showToast(message, "warning");
}
