import { app } from "./firebaseConfig.js";

import {
    getAuth,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

const auth = getAuth(app);

// ELEMENTS

const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");

const signupBtn = document.getElementById("signupBtn");
const signinBtn = document.getElementById("signinBtn");

const loginBtn = document.getElementById("loginBtn");
const userStatus = document.getElementById("userStatus");

const authModal = document.getElementById("authModal");

// =========================
// SIGN UP
// =========================

signupBtn.addEventListener("click", async function () {

    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
  
  // Prevent making a network request if fields are completely empty (Bug Prevention)
    if (!email || !password) {
        window.showToast("Please fill out both email and password fields.", "warning");
        return;
    } 
    try {

        await createUserWithEmailAndPassword(
            auth,
            email,
            password
        );

        window.showToast(
            "Account created successfully!",
            "success"
        );

        authModal.classList.remove("show");

        emailInput.value = "";
        passwordInput.value = "";

    } catch (error) {
       // Intercept the specific Firebase Auth error code
    if (error.code === 'auth/email-already-in-use') {
     
window.showToast("Email address already in use.", "warning" );

    }
} 
});

// =========================
// SIGN IN
// =========================

signinBtn.addEventListener("click", async function () {

    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
  // Prevent making a network request if fields are completely empty (Bug Prevention)
    if (!email || !password) {
        window.showToast("Please enter both email and password.", "warning");
        return;
    } 
        
    try {

        await signInWithEmailAndPassword(
            auth,
            email,
            password
        );

        window.showToast(
            "Welcome back!",
            "success"
        );

        authModal.classList.remove("show");

        emailInput.value = "";
        passwordInput.value = "";

    } catch (error) {

 // Intercept the specific Firebase Auth error code
    if (
      error.code === 'auth/invalid-credential'|| error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
     
window.showToast("Invalid email or password.Please try again.", "warning");
} 
else if( error.code === 'auth/user-disabled'){
  window.showToast("Account disabled.Please Contact support.", "warning");
}
else {
  window.showToast("An expected error occurred.Please try again later.", "error ")
}
} 
});

// =========================
// LOGIN / LOGOUT BUTTON
// =========================

loginBtn.addEventListener("click", async function () {

    if (auth.currentUser) {

        await signOut(auth);

        window.showToast(
            "Logged Out",
            "warning"
        );

    } else {

        authModal.classList.add("show");

    }

});

// =========================
// AUTH STATE LISTENER
// =========================

onAuthStateChanged(auth, function (user) {

    if (user) {

        userStatus.textContent =` Welcome! ${user.email.split('@')[0]} `;
        loginBtn.textContent = "Logout";

    } else {

        userStatus.textContent = "Guest User";
        loginBtn.textContent = "Sign In";

    }

});