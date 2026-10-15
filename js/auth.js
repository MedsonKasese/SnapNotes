import { auth } from "./firebaseConfig.js";
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signInWithPopup,
    GoogleAuthProvider,
    setPersistence,
    browserLocalPersistence,
    sendEmailVerification,
    sendPasswordResetEmail,
    signOut,
    updateProfile,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { getAccountDeletionStatus, loadFromCloud } from "./firestore.js";
import { mergeNotes } from "./note-sync.js";

const signupFullName = document.getElementById("signupFullName");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const togglePasswordBtn = document.getElementById("togglePasswordBtn");
const resetPasswordBtn = document.getElementById("resetPasswordBtn");
const signupBtn = document.getElementById("signupBtn");
const signinBtn = document.getElementById("signinBtn");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const resendVerificationBtn = document.getElementById("resendVerificationBtn");
const verificationStatus = document.getElementById("verificationStatus");
const loginBtn = document.getElementById("loginBtn");
const userAvatar = document.getElementById("userAvatar");
const userAvatarImage = document.getElementById("userAvatarImage");
const userAvatarInitials = document.getElementById("userAvatarInitials");
const authModal = document.getElementById("authModal");
const closeModalBtn = document.getElementById("closeModalBtn");
let observedAuthUid;


const profileModal = document.getElementById("profileEditModal");
const profileNameInput = document.getElementById("profileNameInput");
const profilePhotoInput = document.getElementById("profilePhotoInput");
const profileFeedback = document.getElementById("profileEditFeedback");
const profileSaveBtn = document.getElementById("profileSaveBtn");
let profileBusy = false;

function refreshProfileUI(user) {
    if (!user) return;
    const initials = user.displayName
        ? user.displayName.trim().split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase()
        : (user.email || "U").slice(0, 2).toUpperCase();
    if (userAvatarInitials) {
        userAvatarInitials.textContent = initials;
        userAvatarInitials.hidden = Boolean(user.photoURL);
    }
    if (userAvatarImage) {
        userAvatarImage.hidden = !user.photoURL;
        userAvatarImage.src = user.photoURL || "";
        userAvatarImage.alt = (user.displayName || "Account") + " profile picture";
    }
    if (userAvatar) userAvatar.title = "Signed in as " + (user.displayName || user.email);
    window.dispatchEvent(new CustomEvent("snapnotes:profile-updated"));
}
window.openSnapNotesProfileEditor = () => {
    const user = auth.currentUser;
    if (!user || !profileModal) return;
    profileNameInput.value = user.displayName || "";
    profilePhotoInput.value = "";
    profileFeedback.textContent = "";
    profileModal.classList.add("show");
    profileModal.setAttribute("aria-hidden", "false");
    profileNameInput.focus();
};
function closeProfileEditor() {
    if (profileBusy) return;
    profileModal.classList.remove("show");
    profileModal.setAttribute("aria-hidden", "true");
}
document.getElementById("profileCancelBtn")?.addEventListener("click", closeProfileEditor);
profileModal?.addEventListener("click", event => { if (event.target === profileModal) closeProfileEditor(); });
profileSaveBtn?.addEventListener("click", async () => {
    if (profileBusy) return;
    const user = auth.currentUser;
    if (!user) return;
    if (!user.providerData?.some(provider => provider.providerId === "password")) {
        profileFeedback.textContent = "Profile editing here is available for email accounts.";
        return;
    }
    const name = profileNameInput.value.trim().replace(/\s+/g, " ");
    const photo = profilePhotoInput.files?.[0];
    if (!name) { profileFeedback.textContent = "Enter your full name."; return; }
    if (photo && (!["image/jpeg", "image/png", "image/webp"].includes(photo.type) || photo.size > 2 * 1024 * 1024)) {
        profileFeedback.textContent = "Choose a JPEG, PNG or WebP photo smaller than 2 MB.";
        return;
    }
    profileBusy = true;
    profileSaveBtn.disabled = true;
    profileFeedback.textContent = photo ? "Uploading profile photo…" : "Saving profile…";
    try {
        let photoURL = user.photoURL;
        const previousPhotoURL = photoURL;
        let newAvatarKey = null;
        if (photo) {
            const token = await user.getIdToken();
            const api = async (path, payload) => {
                const response = await fetch("/api/storage/" + path, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
                    body: JSON.stringify(payload)
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.error || "Photo storage request failed.");
                return result;
            };
            profileFeedback.textContent = "Preparing profile photo upload…";
            const signed = await api("sign-upload", {
                purpose: "avatar", contentType: photo.type, size: photo.size
            });
            profileFeedback.textContent = "Uploading profile photo…";
            const uploaded = await fetch(signed.uploadUrl, {
                method: "PUT", headers: { "Content-Type": photo.type, "x-upsert": "false" }, body: photo
            });
            if (!uploaded.ok) throw new Error("Photo upload failed (HTTP " + uploaded.status + ").");
            await api("complete-upload", {
                purpose: "avatar", objectKey: signed.objectKey,
                expectedSize: photo.size, contentType: photo.type
            });
            newAvatarKey = signed.objectKey;
            const avatar = new URL("/api/storage/avatar", window.location.origin);
            avatar.searchParams.set("uid", user.uid);
            avatar.searchParams.set("key", newAvatarKey);
            photoURL = avatar.toString();
        }
        await updateProfile(user, { displayName: name, photoURL });
        refreshProfileUI(user);
        if (newAvatarKey && previousPhotoURL) {
            try {
                const previous = new URL(previousPhotoURL);
                const previousKey = previous.pathname === "/api/storage/avatar" ? previous.searchParams.get("key") : null;
                if (previousKey && previousKey !== newAvatarKey) {
                    const token = await user.getIdToken();
                    await fetch("/api/storage/delete-object", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
                        body: JSON.stringify({ purpose: "avatar", objectKey: previousKey })
                    });
                }
            } catch (error) { console.warn("Previous profile photo cleanup failed:", error); }
        }
        profileFeedback.textContent = "Profile updated.";
        window.showToast?.("Account details updated.", "success");
        profileBusy = false;
        closeProfileEditor();
    } catch (error) {
        profileFeedback.textContent = !navigator.onLine
            ? "You're offline. Reconnect and retry the profile photo."
            : error?.message || "Could not update your profile. Please retry.";
        console.error("Profile update failed:", error);
    } finally {
        profileBusy = false;
        profileSaveBtn.disabled = false;
    }
});

function accountCacheKey(uid) {
    return `SnapNotesAccount:${uid}`;
}

async function restoreAccountCache(user, includeLocalCache = false) {
    if (!user?.uid) return;
    if (localStorage.getItem(`SnapNotesAccountCleanupPending:${user.uid}`) === "true") {
        void clearLocalAccountDataForDeletion(user);
        return;
    }
    const raw = localStorage.getItem(accountCacheKey(user.uid));
    let cached = null;
    try {
        cached = raw ? JSON.parse(raw) : null;
    } catch (error) {
        localStorage.removeItem(accountCacheKey(user.uid));
        console.warn("Could not restore the local account cache:", error);
    }

    let localCache = null;
    if (includeLocalCache) {
        try { localCache = JSON.parse(localStorage.getItem("SnapNotesLocalCache") || "null"); } catch {}
        try {
            const durableLocal = await window.readLocalLibrary?.("local");
            if (Array.isArray(durableLocal?.notes) && Number(durableLocal.savedAt) > (Date.parse(localCache?.savedAt || "") || 0)) {
                localCache = { notes: durableLocal.notes, folders: durableLocal.folders || [], savedAt: new Date(durableLocal.savedAt).toISOString() };
            }
        } catch (error) {
            console.warn("Could not recover the signed-out local library:", error);
        }
    }

    const localNotes = includeLocalCache && Array.isArray(localCache?.notes) ? localCache.notes : [];
    const accountNotes = Array.isArray(cached?.notes) ? cached.notes : [];
    const notes = mergeNotes(localNotes, accountNotes);
    const folderMap = new Map();
    [...(includeLocalCache && Array.isArray(localCache?.folders) ? localCache.folders : []),
        ...(Array.isArray(cached?.folders) ? cached.folders : [])].forEach(folder => {
        if (!folder?.id) return;
        const existing = folderMap.get(folder.id);
        const existingTime = Date.parse(existing?.updatedAt || existing?.createdAt || "") || 0;
        const incomingTime = Date.parse(folder.updatedAt || folder.createdAt || "") || 0;
        if (!existing || incomingTime > existingTime) folderMap.set(folder.id, folder);
    });
    const folders = [...folderMap.values()].slice(0, 20);
    if (!notes.length && !folders.length) {
        const localReady = window.loadNotes?.();
        if (localReady) await localReady;
        return;
    }

    const savedAt = Date.now();
    window.notes = notes;
    await window.persistLocalLibrary?.(user.uid, notes, folders, savedAt);
    window.loadFolders?.();
    const localReady = window.loadNotes?.();
    if (localReady) await localReady;
    const attachmentIds = attachmentIdsForAccount(user.uid);
    void window.tagLegacyAttachmentFilesForUser?.(user.uid, attachmentIds).catch(error => {
        console.warn("Could not migrate account-cache attachment ownership:", error);
    });
}

function cacheAccountBeforeSignOut(user) {
    if (!user?.uid) return;
    const notes = Array.isArray(window.notes) ? window.notes : [];
    const folders = Array.isArray(window.getFolders?.()) ? window.getFolders() : [];
    const savedAt = Date.now();
    try {
        localStorage.setItem(accountCacheKey(user.uid), JSON.stringify({ notes, folders, savedAt: new Date(savedAt).toISOString() }));
    } catch (error) {
        console.warn("Could not cache the account library in localStorage:", error);
    }
    void window.persistLocalLibrary?.(user.uid, notes, folders, savedAt);
}

function attachmentIdsForAccount(uid) {
    const notes = [];
    if (window.snapNotesDataUid === uid && Array.isArray(window.notes)) notes.push(...window.notes);
    try {
        const cached = JSON.parse(localStorage.getItem(accountCacheKey(uid)) || "null");
        if (Array.isArray(cached?.notes)) notes.push(...cached.notes);
    } catch {}

    const ids = new Set();
    for (const note of notes) {
        let readable = null;
        try { readable = window.getReadablePrivateNote?.(note); } catch {}
        for (const attachments of [note?.attachments, readable?.attachments]) {
            if (!Array.isArray(attachments)) continue;
            for (const attachment of attachments) if (typeof attachment?.id === "string") ids.add(attachment.id);
        }
    }
    return [...ids];
}

function queuedAttachmentIdsForAccount(uid) {
    try {
        const queue = JSON.parse(localStorage.getItem("SnapNotesAttachmentCleanup") || "[]");
        if (!Array.isArray(queue)) return [];
        const prefix = `users/${uid}/`;
        return queue.filter(item => item?.uid === uid ||
            (typeof item?.storagePath === "string" && item.storagePath.startsWith(prefix)))
            .map(item => item?.id)
            .filter(id => typeof id === "string");
    } catch {
        return [];
    }
}

async function clearLocalAccountDataForDeletion(user) {
    const uid = user?.uid;
    if (!uid || localStorage.getItem(`SnapNotesAccountCleanupDone:${uid}`) === "true") return;
    const idsKey = `SnapNotesAccountAttachmentIds:${uid}`;
    let attachmentIds = [];
    try {
        attachmentIds = JSON.parse(localStorage.getItem(idsKey) || "[]");
        if (!Array.isArray(attachmentIds)) attachmentIds = [];
    } catch { attachmentIds = []; }
    attachmentIds = [...new Set([
        ...attachmentIds,
        ...attachmentIdsForAccount(uid),
        ...queuedAttachmentIdsForAccount(uid)
    ])];
    let attachmentCleanupComplete = false;
    let localLibraryCleanupComplete = false;
    let attachmentIdsPersisted = false;
    try {
        localStorage.setItem(idsKey, JSON.stringify(attachmentIds));
        attachmentIdsPersisted = true;
    } catch {
        // Free the duplicate active-account cache before retrying the small ID-only record.
        localStorage.removeItem("SnapNotes");
        localStorage.removeItem("SnapNotesFolders");
        try {
            localStorage.setItem(idsKey, JSON.stringify(attachmentIds));
            attachmentIdsPersisted = true;
        } catch {}
    }
    try {
        if (typeof window.deleteLocalAttachmentFilesForUser !== "function") {
            throw new Error("Local attachment cleanup is unavailable.");
        }
        await window.deleteLocalAttachmentFilesForUser(uid, attachmentIds);
        attachmentCleanupComplete = true;
        localStorage.removeItem(idsKey);
        localStorage.removeItem(`SnapNotesAccountCleanupPending:${uid}`);
    } catch (error) {
        console.warn("Could not remove all local attachment blobs for the deleted account:", error);
    }

    try {
        if (typeof window.deleteLocalLibrarySnapshot === "function") {
            await window.deleteLocalLibrarySnapshot(uid);
        }
        await window.clearAccountPermanentNoteDeletions?.(uid);
        localLibraryCleanupComplete = true;
    } catch (error) {
        console.warn("Could not remove the durable local library for the deleted account:", error);
    }

    if ((attachmentCleanupComplete || attachmentIdsPersisted) && localLibraryCleanupComplete) {
        localStorage.removeItem(accountCacheKey(uid));
    } else {
        try { localStorage.setItem(`SnapNotesAccountCleanupPending:${uid}`, "true"); } catch {}
    }
    if (attachmentCleanupComplete || attachmentIdsPersisted) {
        window.clearAttachmentCleanupQueueForUser?.(uid);
    }
    localStorage.removeItem(`SnapNotesAccountDeletion:${uid}`);
    if (window.snapNotesDataUid === uid) {
        window.notes = [];
        window.snapNotesDataUid = null;
        localStorage.removeItem("SnapNotes");
        localStorage.removeItem("SnapNotesFolders");
        localStorage.removeItem("SnapNotesSavedAt");
        window.loadFolders?.();
        window.renderNotes?.("", "all");
        window.updateNavigationCounts?.();
    }
    if (attachmentCleanupComplete && localLibraryCleanupComplete) {
        localStorage.setItem(`SnapNotesAccountCleanupDone:${uid}`, "true");
    }
}
window.clearLocalAccountDataForDeletion = clearLocalAccountDataForDeletion;

async function retryPendingLocalAttachmentCleanup() {
    if (typeof window.deleteLocalAttachmentFilesForUser !== "function") return;
    const pendingPrefix = "SnapNotesAccountCleanupPending:";
    const pendingUids = Object.keys(localStorage)
        .filter(key => key.startsWith(pendingPrefix))
        .map(key => key.slice(pendingPrefix.length))
        .filter(Boolean);
    for (const uid of pendingUids) {
        await clearLocalAccountDataForDeletion({ uid });
    }

    const prefix = "SnapNotesAccountAttachmentIds:";
    const keys = Object.keys(localStorage).filter(key => key.startsWith(prefix));
    for (const key of keys) {
        const uid = key.slice(prefix.length);
        if (!uid) continue;
        try {
            await clearLocalAccountDataForDeletion({ uid });
        } catch (error) {
            console.warn("Will retry local attachment cleanup for a deleted account:", error);
        }
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void retryPendingLocalAttachmentCleanup());
} else {
    void retryPendingLocalAttachmentCleanup();
}

// Keep Firebase Auth persistent across page reloads and PWA sessions.
const authPersistenceReady = setPersistence(auth, browserLocalPersistence).catch(error => {
    console.warn("Could not enable persistent authentication:", error);
});

togglePasswordBtn?.addEventListener("click", () => {
    const isVisible = passwordInput.type === "text";
    passwordInput.type = isVisible ? "password" : "text";
    togglePasswordBtn.setAttribute("aria-pressed", String(!isVisible));
    togglePasswordBtn.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
    togglePasswordBtn.innerHTML = `<i class="fa-regular fa-${isVisible ? "eye" : "eye-slash"}" aria-hidden="true"></i>`;
    passwordInput.focus();
});

resetPasswordBtn?.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    if (!email) {
        window.showToast("Enter your email address first.", "warning");
        emailInput.focus();
        return;
    }

    try {
        resetPasswordBtn.disabled = true;
        await sendPasswordResetEmail(auth, email);
        window.showToast("Password reset link sent. Check your email.", "success");
    } catch (error) {
        if (error.code === "auth/user-not-found") {
            window.showToast("No account was found for that email address.", "warning");
        } else {
            handleAuthError(error);
        }
    } finally {
        resetPasswordBtn.disabled = false;
    }
});

signupBtn.addEventListener("click", async () => {
    if (signupFullName.hidden) { signupFullName.hidden = false; signupBtn.textContent = "Register with email"; signupFullName.focus(); return; }
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const fullName = signupFullName.value.trim().replace(/\s+/g, " ");

    if (!fullName || !email || !password) {
        window.showToast("Please fill out all fields.", "warning");
        return;
    }

    try {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(credential.user, { displayName: fullName });
        refreshProfileUI(credential.user);
        await sendEmailVerification(credential.user);
        showVerificationState(credential.user);
        window.showToast("Verification email sent. Check your inbox.", "success");
    } catch (error) {
        handleAuthError(error);
    }
});

signinBtn.addEventListener("click", async () => {
    signupFullName.hidden = true;
    signupBtn.textContent = "Create Account";
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
        googleSignInBtn.disabled = true;
        await authPersistenceReady;

        // SnapNotes is hosted on Vercel while Firebase Auth uses the
        // firebaseapp.com auth domain. Redirect sign-in can fail in browsers
        // that block third-party storage. Popup sign-in avoids that dependency
        // and returns the signed-in credential directly.
        const credential = await signInWithPopup(auth, provider);

        if (credential?.user) {
            window.showToast("Signed in with Google", "success");
            closeModal();
        }
    } catch (error) {
        handleAuthError(error);
    } finally {
        googleSignInBtn.disabled = false;
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

    const isGoogleUser = user.providerData?.some(provider => provider.providerId === "google.com");
    const accountName = user.displayName || (user.email ? user.email.split("@")[0] : "this account");

    if (!confirm(`Log out ${accountName}?`)) return;

    cacheAccountBeforeSignOut(user);
    signOut(auth)
        .then(() => {
            window.notes = [];
            localStorage.removeItem("SnapNotes");
            localStorage.removeItem("SnapNotesFolders");
            window.loadFolders?.();
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
    signupFullName.value = "";
    signupFullName.hidden = true;
    signupBtn.textContent = "Create Account";
    passwordInput.value = "";
    passwordInput.type = "password";
    togglePasswordBtn?.setAttribute("aria-pressed", "false");
    togglePasswordBtn?.setAttribute("aria-label", "Show password");
    if (togglePasswordBtn) {
        togglePasswordBtn.innerHTML = '<i class="fa-regular fa-eye" aria-hidden="true"></i>';
    }
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

async function reportScheduledAccountDeletion(user) {
    try {
        const deletion = await getAccountDeletionStatus(user.uid);
        if (auth.currentUser?.uid !== user.uid || !deletion?.scheduledFor) return;
        if (Date.parse(deletion.scheduledFor) <= Date.now()) {
            if (deletion.status === "processing") await clearLocalAccountDataForDeletion(user);
            window.showToast?.(deletion.status === "processing"
                ? "Your account deletion is being securely processed."
                : "Your scheduled account deletion is due and will be processed by the server.", "warning");
        }
    } catch (error) {
        if (auth.currentUser?.uid === user.uid) console.warn("Could not check scheduled account deletion:", error);
    }
}

function resetNoteStateForAuthTransition(nextUid, user) {
    const previousUid = observedAuthUid;
    if (previousUid === nextUid) return;
    if (previousUid === undefined && !nextUid) {
        observedAuthUid = null;
        window.snapNotesDataUid = null;
        return;
    }

    if ((previousUid === null || previousUid === undefined) && nextUid) {
        let localNotes = Array.isArray(window.notes) ? window.notes : [];
        let localFolders = Array.isArray(window.getFolders?.()) ? window.getFolders() : [];
        try {
            const storedNotes = JSON.parse(localStorage.getItem("SnapNotes") || "null");
            if (Array.isArray(storedNotes) && (!localNotes.length || Number(localStorage.getItem("SnapNotesSavedAt")) > 0)) localNotes = storedNotes;
            const storedFolders = JSON.parse(localStorage.getItem("SnapNotesFolders") || "null");
            if (Array.isArray(storedFolders)) localFolders = storedFolders;
        } catch {}
        const savedAt = Number(localStorage.getItem("SnapNotesSavedAt")) || Date.now();
        localStorage.setItem("SnapNotesLocalCache", JSON.stringify({
            notes: localNotes,
            folders: localFolders,
            savedAt: new Date(savedAt).toISOString()
        }));
        void window.persistLocalLibrary?.("local", localNotes, localFolders, savedAt);
    }

    if (previousUid && localStorage.getItem(`SnapNotesAccountCleanupDone:${previousUid}`) !== "true") {
        cacheAccountBeforeSignOut({ uid: previousUid });
    } else if (previousUid) {
        localStorage.removeItem(accountCacheKey(previousUid));
    }
    window.clearPrivateUnlock?.();
    window.notes = [];
    localStorage.removeItem("SnapNotes");
    localStorage.removeItem("SnapNotesFolders");
    localStorage.removeItem("SnapNotesSavedAt");
    window.snapNotesDataUid = nextUid || null;
    observedAuthUid = nextUid;

    if (user) {
        window.localNotesReady = restoreAccountCache(user, previousUid === null || previousUid === undefined);
    } else {
        try {
            const localCache = JSON.parse(localStorage.getItem("SnapNotesLocalCache") || "null");
            if (Array.isArray(localCache?.notes)) localStorage.setItem("SnapNotes", JSON.stringify(localCache.notes));
            if (Array.isArray(localCache?.folders)) localStorage.setItem("SnapNotesFolders", JSON.stringify(localCache.folders));
            if (localCache?.savedAt) localStorage.setItem("SnapNotesSavedAt", String(Date.parse(localCache.savedAt) || Date.now()));
        } catch (error) {
            console.warn("Could not restore signed-out local notes:", error);
        }
        window.localNotesReady = window.loadNotes?.();
        window.loadFolders?.();
        window.updateNavigationCounts?.();
    }
}

onAuthStateChanged(auth, async user => {
    resetNoteStateForAuthTransition(user?.uid || null, user);
    window.dispatchEvent(new CustomEvent("snapnotes:auth-changed", { detail: { user } }));
    resetGoogleButton();

    if (user) {
        reportScheduledAccountDeletion(user);
        const initials = user.displayName
            ? user.displayName.trim().split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase()
            : user.email
                ? user.email.substring(0, 2).toUpperCase()
                : "U";

        if (userAvatarInitials) {
            userAvatarInitials.textContent = initials;
            userAvatarInitials.hidden = Boolean(user.photoURL);
        }

        if (userAvatarImage) {
            userAvatarImage.hidden = !user.photoURL;
            userAvatarImage.src = user.photoURL || "";
            userAvatarImage.alt = user.displayName
                ? `${user.displayName} profile picture`
                : "Profile picture";
        }

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

        await window.localNotesReady;
        if (auth.currentUser?.uid === user.uid) await loadFromCloud(user.uid);
    } else {
        userAvatar.hidden = true;
        if (userAvatarImage) {
            userAvatarImage.hidden = true;
            userAvatarImage.removeAttribute("src");
        }
        if (userAvatarInitials) userAvatarInitials.hidden = false;
        loginBtn.hidden = false;
        loginBtn.querySelector("span").textContent = "Sign In";
        clearVerificationState();
    }
});

function resetGoogleButton() {
    googleSignInBtn.disabled = false;
    googleSignInBtn.innerHTML = '<i class="fa-brands fa-google" aria-hidden="true"></i> Continue with Google';
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
    }else if(error.code === "auth/internal-error"){
       message = "An internal error occured. please try again later."
    } else if (error.code) {
        message = `Google sign-in failed (${error.code}). Check Firebase Authentication settings.`;
    }

    window.showToast(message, "warning");
}

/* Security Center uses the active Firebase session; no passwords are stored locally. */
const securitySummary = document.getElementById("securityCenterSummary");
const securityFeedback = document.getElementById("securityCenterFeedback");
const securityVerify = document.getElementById("securityVerifyBtn");
const securityReset = document.getElementById("securityResetBtn");
const securityRefresh = document.getElementById("securityRefreshBtn");
let securityBusy = false;

function securityMessage(message) {
    if (securityFeedback) securityFeedback.textContent = message;
}

async function refreshSecurityCenter(forceReload = false) {
    if (!securitySummary) return;
    const user = auth.currentUser;
    if (!user) {
        securitySummary.textContent = "Local mode: no cloud account is signed in. Notes on this device are not protected by a SnapNotes account password.";
        securityVerify.hidden = true;
        securityReset.hidden = true;
        return;
    }
    if (forceReload) {
        try { await user.reload(); }
        catch (error) { securityMessage("Could not refresh account status. Check your connection."); }
    }
    const google = user.providerData?.some(provider => provider.providerId === "google.com");
    const password = user.providerData?.some(provider => provider.providerId === "password");
    securitySummary.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = google ? "Google sign-in" : password ? "Email and password" : "Connected account";
    const email = document.createElement("span");
    email.textContent = user.email || "No email address available";
    const verification = document.createElement("span");
    verification.textContent = user.emailVerified ? "Email verified" : "Email not verified";
    const explanation = document.createElement("small");
    explanation.textContent = google && !password
        ? "Your Google account manages your password and sign-in security. Review it in Google Account settings."
        : "Keep your email accessible for account recovery. Password reset links are sent by Firebase Authentication.";
    securitySummary.append(heading, email, verification, explanation);
    securityVerify.hidden = Boolean(user.emailVerified || !user.email);
    securityReset.hidden = !password || !user.email;
}
window.refreshSecurityCenter = refreshSecurityCenter;

securityRefresh?.addEventListener("click", async () => {
    if (securityBusy) return;
    securityBusy = true;
    securityRefresh.disabled = true;
    securityMessage("Checking account status…");
    try { await refreshSecurityCenter(true); if (auth.currentUser) securityMessage("Security status updated."); }
    finally { securityBusy = false; securityRefresh.disabled = false; }
});
securityVerify?.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user || user.emailVerified || securityBusy) return;
    securityBusy = true;
    securityVerify.disabled = true;
    securityMessage("Sending verification email…");
    try {
        await sendEmailVerification(user);
        securityMessage("Verification email sent. Check your inbox and spam folder.");
    } catch (error) {
        securityMessage(error.code === "auth/too-many-requests" ? "Too many attempts. Try again later." : "Could not send verification email. Try again later.");
    } finally { securityBusy = false; securityVerify.disabled = false; }
});
securityReset?.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user?.email || securityBusy || !user.providerData?.some(p => p.providerId === "password")) return;
    securityBusy = true;
    securityReset.disabled = true;
    securityMessage("Sending password reset link…");
    try {
        await sendPasswordResetEmail(auth, user.email);
        securityMessage("Password reset link sent. Check your inbox.");
    } catch (error) {
        securityMessage(error.code === "auth/too-many-requests" ? "Too many attempts. Try again later." : "Could not send the password reset link.");
    } finally { securityBusy = false; securityReset.disabled = false; }
});
