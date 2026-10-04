import { auth } from "./firebaseConfig.js";
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    GoogleAuthProvider,
    sendEmailVerification,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { loadFromCloud } from "./firestore.js";

const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const signupBtn = document.getElementById("signupBtn");
const signinBtn = document.getElementById("signinBtn");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const resendVerificationBtn = document.getElementById("resendVerificationBtn");
const verificationStatus = document.getElementById("verificationStatus");
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
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        await sendEmailVerification(credential.user);
        showVerificationState(credential.user);
        window.showToast("Verification email sent. Check your inbox.", "success");
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
        const credential = await signInWithEmailAndPassword(auth, email, password);
        const user = credential.user;

        if (!user.emailVerified) {
            showVerificationState(user);
            window.showToast("Please verify your email before continuing.", "warning");
            return;
        }

        window.showToast(`Welcome, ${email.split("@")[0]}!`, "success");
        closeModal();
    } catch (error) {
        handleAuthError(error);
    }
});

googleSignInBtn.addEventListener("click", async () => {
    const provider = new GoogleAuthProvider();

    try {
        setGoogleLoading(true);

        // Redirect is more reliable for Android/mobile browsers and installed PWAs.
        // Desktop browsers keep the popup experience.
        if (isMobileAuthEnvironment()) {
            await signInWithRedirect(auth, provider);
            return;
        }

        await signInWithPopup(auth, provider);
        window.showToast("Signed in with Google", "success");
        closeModal();
    } catch (error) {
        setGoogleLoading(false);
        handleAuthError(error);
    }
});

resendVerificationBtn.addEventListener("click", async () => {
    const user = auth.currentUser;

    if (!user || user.emailVerified) {
        window.showToast("Your email is already verified.", "success");
        return;
    }

    try {
        await sendEmailVerification(user);
        window.showToast("Verification email resent. Check your inbox.", "success");
    } catch (error) {
        if (error.code === "auth/too-many-requests") {
            window.showToast("Please wait before requesting another email.", "warning");
            return;
        }

        handleAuthError(error);
    }
});

loginBtn.addEventListener("click", openAuthModal);

userAvatar.addEventListener("click", () => {
    const user = auth.currentUser;
    if (!user) return;

    const accountName = user.email ? user.email.split("@")[0] : "this account";

    if (!confirm(`Log out ${accountName}?`)) return;

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

    const user = auth.currentUser;

    if (user && !user.emailVerified) {
        showVerificationState(user);
    } else {
        clearVerificationState();
        emailInput.focus();
    }
}

function closeModal() {
    authModal.classList.remove("show");
    authModal.setAttribute("aria-hidden", "true");
    emailInput.value = "";
    passwordInput.value = "";
    clearVerificationState();
}

function showVerificationState(user) {
    if (!user?.email) return;

    verificationStatus.hidden = false;
    resendVerificationBtn.hidden = false;
    verificationStatus.textContent =
        `A verification link was sent to ${user.email}. Open it, then return to SnapNotes.`;

    emailInput.focus();
}

function clearVerificationState() {
    verificationStatus.hidden = true;
    resendVerificationBtn.hidden = true;
    verificationStatus.textContent = "";
}

function isMobileAuthEnvironment() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        window.matchMedia("(display-mode: standalone)").matches;
}

getRedirectResult(auth)
    .then(result => {
        if (!result?.user) return;

        setGoogleLoading(false);
        window.showToast("Signed in with Google", "success");
        closeModal();
    })
.catch(error => {
        setGoogleLoading(false);
        handleAuthError(error);
    });

onAuthStateChanged(auth, user => {
    setGoogleLoading(false);

    if (user) {
        const initials = user.displayName
            ? user.displayName.slice(0, 2).toUpperCase()
            : user.email
                ? user.email.substring(0, 2).toUpperCase()
                : "U";

        userAvatar.textContent = initials;
        userAvatar.title = `Signed in as ${user.displayName || user.email || "user"}`;
        userAvatar.hidden = false;
        loginBtn.hidden = true;

        if (
            !user.emailVerified &&
            user.providerData.length > 0 &&
            user.providerData.every(provider => provider.providerId === "password")
        ) {
            showVerificationState(user);
        } else {
            clearVerificationState();
        }

        loadFromCloud(user.uid);
    } else {
        userAvatar.hidden = true;
        loginBtn.hidden = false;
        loginBtn.querySelector("span").textContent = "Sign In";
        clearVerificationState();
    }
});

function setGoogleLoading(loading) {
    googleSignInBtn.disabled = loading;
    googleSignInBtn.innerHTML = loading
        ? '<i class="fa-solid fa-spinner fa-spin"></i> Completing Google sign-in...'
        : '<i class="fa-brands fa-google"></i> Continue with Google';
}

function handleAuthError(error) {
    console.error("Authentication error:", error);

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
    } else if (error.code === "auth/popup-closed-by-user") {
        message = "Google sign-in was cancelled.";
    } else if (error.code === "auth/popup-blocked") {
        message = "Google sign-in popup was blocked. Please allow popups and try again.";
    } else if (error.code === "auth/unauthorized-domain") {
        message = "This SnapNotes domain is not authorized for Google sign-in in Firebase.";
    } else if (error.code === "auth/operation-not-allowed") {
        message = "Google sign-in is not enabled in the Firebase project.";
    } else if (error.code === "auth/account-exists-with-different-credential") {
        message = "An account already exists with this email using another sign-in method.";
    } else if (error.code) {
        message = `Google sign-in failed (${error.code}). Check Firebase Authentication settings.`;
    }

    window.showToast(message, "warning");
}