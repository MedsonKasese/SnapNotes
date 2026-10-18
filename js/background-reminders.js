import { BACKGROUND_REMINDER_API } from "./background-reminder-config.js";
import { projectReminderMetadata, scheduleMatches, vapidBytes } from "./background-reminder-utils.js";

let user = null;
let generation = 0;
let enabled = false;
let includePrivate = false;
let states = new Map();
let statesLoaded = false;
let revision = null;
let cloudNotes = [];
let busy = false;
let enrolling = false;
let queued = false;
let privateModeOverride = null;
let lastRefresh = 0;
let refreshTask = null;
let message = "";
const key = (uid, suffix) => `SnapNotesBackgroundReminders:${uid}:${suffix}`;
function read(uid, suffix) { try { return localStorage.getItem(key(uid, suffix)) === "true"; } catch { return false; } }
function remember(uid, suffix, value) { try { localStorage.setItem(key(uid, suffix), String(Boolean(value))); } catch { /* Memory-only consent is safe. */ } }
function current(uid, epoch) { return Boolean(user?.uid === uid && generation === epoch && window.firebaseAuth?.currentUser?.uid === uid); }
function apiOrigin() {
    if (!BACKGROUND_REMINDER_API) return null;
    const url = new URL(BACKGROUND_REMINDER_API);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("Background reminder service must be an HTTPS origin.");
    }
    return url.origin;
}
async function request(path, { method = "GET", body, account = user } = {}) {
    const origin = apiOrigin();
    if (!origin) throw new Error("Background reminder hosting is not configured yet.");
    if (!account) throw new Error("Sign in before enabling background reminders.");
    const token = await account.getIdToken();
    const response = await fetch(`${origin}/v1/${path}`, {
        method, mode: "cors", credentials: "omit", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(response.status === 409
        ? "Cloud notes changed. Sync again to update background reminders."
        : "Background reminders could not connect. Check your connection and retry.");
    return response.status === 204 ? {} : response.json();
}
function render() {
    const status = document.getElementById("backgroundReminderStatus");
    const enable = document.getElementById("enableBackgroundReminders");
    const disable = document.getElementById("disableBackgroundReminders");
    const privateInput = document.getElementById("backgroundPrivateReminders");
    if (!status) return;
    status.textContent = message || (!BACKGROUND_REMINDER_API ? "Hosting is not configured. Reminders currently work while the app is open."
        : !user ? "Sign in to enable background reminders."
            : enabled ? "Background reminders are enabled for this account. Only synced schedules can be delivered."
                : "Background reminders are off. Reminders work while the app is open.");
    enable.disabled = busy || enrolling || !user || !BACKGROUND_REMINDER_API;
    enable.textContent = enabled ? "Enable on this device / retry sync" : "Enable on this device";
    disable.disabled = busy || enrolling || !user || !BACKGROUND_REMINDER_API;
    privateInput.disabled = busy || enrolling || !enabled;
    privateInput.checked = includePrivate;
}
function accept(response) {
    states = new Map((response.reminders || []).map(state => [state.noteId, state]));
    statesLoaded = true;
    if (typeof response.enabled === "boolean") {
        enabled = response.enabled;
        remember(user.uid, "enabled", enabled);
    }
}
async function reconcile(uid, epoch) {
    if (window.snapNotesDataUid !== uid) return;
    let changed = false;
    for (const raw of window.notes || []) {
        if (!current(uid, epoch) || window.snapNotesDataUid !== uid) return;
        if (raw.deletedAt || raw.archived) continue;
        if (raw.isPrivate && !window.isPrivateNotesUnlocked?.()) continue;
        const note = raw.isPrivate ? window.getReadablePrivateNote?.(raw) : raw;
        const state = states.get(raw.id);
        if (!state || !scheduleMatches(note, state, true) || scheduleMatches(note, state, false)) continue;
        // An edited ciphertext must never be overwritten by an older server projection.
        if (raw.isPrivate && state.sourcePrivateUpdatedAt !== raw.updatedAt) continue;
        const completion = { reminderAt: state.reminderAt, reminderNotified: Boolean(state.reminderNotified) };
        if (raw.isPrivate) changed = Boolean(await window.markPrivateReminderNotified?.(raw.id, completion)) || changed;
        else { Object.assign(raw, completion, { updatedAt: new Date().toISOString() }); changed = true; }
    }
    if (changed && current(uid, epoch)) {
        await window.saveNotes?.();
        if (current(uid, epoch)) window.renderNotes?.();
    }
}
async function refresh(force = false) {
    if (!user || !BACKGROUND_REMINDER_API) return;
    if (refreshTask) return refreshTask;
    if (!force && Date.now() - lastRefresh < 60000) return;
    const uid = user.uid, epoch = generation;
    refreshTask = (async () => {
        try {
            const result = await request("reminders");
            if (!current(uid, epoch)) return;
            accept(result);
            await reconcile(uid, epoch);
            lastRefresh = Date.now();
            message = "";
        } catch (error) {
            if (current(uid, epoch)) message = `${error.message} Existing server schedules remain active until disabled.`;
        } finally { if (current(uid, epoch)) render(); }
    })();
    const task = refreshTask;
    try { await task; } finally { if (refreshTask === task) refreshTask = null; }
}
async function publish() {
    if (busy) { queued = true; return; }
    if (!enabled || !revision || !user) return;
    busy = true;
    const uid = user.uid, epoch = generation;
    const snapshotRevision = revision;
    const unlocked = Boolean(window.isPrivateNotesUnlocked?.());
    const privateMode = privateModeOverride || (includePrivate && unlocked ? "replace" : "preserve");
    privateModeOverride = null;
    render();
    try {
        // Use the exact committed cloud snapshot, not edits that have not synced yet.
        const metadata = projectReminderMetadata(cloudNotes, {
            includePrivate: includePrivate && privateMode !== "remove", unlocked,
            readPrivate: raw => {
                const live = window.notes?.find(note => note.id === raw.id);
                return live?.updatedAt === raw.updatedAt ? window.getReadablePrivateNote?.(live) : null;
            }
        });
        const response = await request("reminders", {
            method: "PUT", body: { revision: snapshotRevision, privateMode, reminders: metadata }
        });
        if (!current(uid, epoch)) return;
        accept(response);
        if (privateMode === "remove") remember(uid, "removePrivatePending", false);
        await reconcile(uid, epoch);
        message = privateMode === "preserve" && includePrivate && !unlocked
            ? "Synced regular reminders. Unlock Private Notes to update their background schedules."
            : "Background reminder schedules synced. Delivery still depends on browser and device settings.";
    } catch (error) {
        if (current(uid, epoch)) {
            if (privateMode === "remove") privateModeOverride = "remove";
            message = `${error.message} Changes are not scheduled until the next successful sync.`;
        }
    } finally {
        busy = false;
        render();
        if (queued) { queued = false; void publish(); }
    }
}
async function enableOnDevice() {
    if (!user || busy || enrolling) return;
    enrolling = true;
    render();
    const uid = user.uid, epoch = generation;
    let subscription;
    let registered = false;
    let existingSubscription = false;
    try {
        if (!("Notification" in window) || !("PushManager" in window) || !navigator.serviceWorker) {
            throw new Error("This browser does not support Web Push. On iPhone or iPad, install SnapNotes to the Home Screen first.");
        }
        // Permission must be requested directly from this click, before network awaits.
        if (await Notification.requestPermission() !== "granted") throw new Error("Allow notifications in your browser settings, then retry.");
        const origin = apiOrigin();
        const response = await fetch(`${origin}/v1/config`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("Background reminder hosting is unavailable.");
        const config = await response.json();
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) throw new Error("Reload SnapNotes once so its service worker is ready, then retry.");
        subscription = await registration.pushManager.getSubscription();
        existingSubscription = Boolean(subscription);
        subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(config.vapidPublicKey) });
        if (!current(uid, epoch)) { if (!existingSubscription) await subscription.unsubscribe(); return; }
        await request("subscriptions", { method: "POST", body: { subscription: subscription.toJSON() } });
        registered = true;
        if (!current(uid, epoch)) { await subscription.unsubscribe(); return; }
        enabled = true;
        remember(uid, "enabled", true);
        await refresh(true);
        const synced = await window.syncToCloud?.(uid);
        if (!synced) message = "Device enabled, but schedules are pending cloud sync. Reconnect and retry.";
        else await publish();
    } catch (error) {
        if (subscription && !registered && !existingSubscription) await subscription.unsubscribe().catch(() => {});
        if (current(uid, epoch)) message = error.message;
    } finally { enrolling = false; render(); }
}
async function disableAll() {
    if (!user || busy) return;
    busy = true;
    render();
    const uid = user.uid, epoch = generation;
    try {
        await request("reminders", { method: "DELETE" });
        if (!current(uid, epoch)) return;
        enabled = false;
        includePrivate = false;
        states.clear();
        remember(uid, "enabled", false);
        remember(uid, "private", false);
        remember(uid, "removePrivatePending", false);
        const registration = await navigator.serviceWorker?.getRegistration?.();
        await (await registration?.pushManager?.getSubscription?.())?.unsubscribe();
        message = "Background reminders disabled on all devices for this account.";
    } catch (error) { if (current(uid, epoch)) message = `${error.message} Background schedules may still be active; retry disabling.`; }
    finally { busy = false; render(); }
}
async function changePrivateConsent(event) {
    includePrivate = event.target.checked;
    remember(user.uid, "private", includePrivate);
    remember(user.uid, "removePrivatePending", !includePrivate);
    privateModeOverride = includePrivate ? null : "remove";
    if (includePrivate && !window.isPrivateNotesUnlocked?.()) {
        message = "Unlock Private Notes, then retry sync to share their reminder times and repeat settings. Contents stay encrypted.";
        render();
        return;
    }
    if (!revision) {
        message = "Private schedule changes are pending cloud sync. Existing background reminders may continue; retry sync or disable all devices.";
        render();
        return;
    }
    await publish();
}
async function changeAccount(nextUser) {
    const previous = user;
    const switched = previous && previous.uid !== nextUser?.uid;
    generation++;
    user = nextUser || null;
    enabled = user ? read(user.uid, "enabled") : false;
    includePrivate = user ? read(user.uid, "private") : false;
    states = new Map();
    statesLoaded = false;
    // A pending request for the previous identity must not block this account's
    // own refresh. Its generation guard discards its eventual response.
    refreshTask = null;
    revision = null;
    cloudNotes = [];
    lastRefresh = 0;
    message = "";
    privateModeOverride = user && read(user.uid, "removePrivatePending") ? "remove" : null;
    render();
    if (switched) {
        // Unsubscribe first: even if the old token is revoked, shared-device pushes stop.
        const registration = await navigator.serviceWorker?.getRegistration?.();
        const subscription = await registration?.pushManager?.getSubscription?.();
        if (subscription) {
            await subscription.unsubscribe();
            await request("subscriptions", { method: "DELETE", body: { endpoint: subscription.endpoint }, account: previous }).catch(() => {});
        }
    }
    await refresh(true);
}
window.shouldManageBackgroundReminder = note => {
    if (!enabled || !user || window.snapNotesDataUid !== user.uid) return false;
    const state = states.get(note.id);
    // Persisted opt-in suppresses duplicate foreground delivery during offline startup.
    if (!statesLoaded) return !note.isPrivate || includePrivate;
    return Boolean(state && (scheduleMatches(note, state, true) || scheduleMatches(note, state, false)));
};
window.prepareBackgroundReminderCheck = () => refresh();
window.addEventListener("snapnotes:auth-changed", event => { void changeAccount(event.detail?.user).catch(() => { message = "Could not refresh background reminders. Retry from Settings."; render(); }); });
window.addEventListener("snapnotes:library-committed", event => {
    if (event.detail?.uid !== user?.uid) return;
    revision = event.detail.revision;
    cloudNotes = event.detail.notes;
    void publish();
});
window.addEventListener("snapnotes:private-unlocked", () => { void refresh(true).then(() => publish()); });
window.addEventListener("online", () => { void refresh(true).then(() => publish()); });
document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("enableBackgroundReminders")?.addEventListener("click", enableOnDevice);
    document.getElementById("disableBackgroundReminders")?.addEventListener("click", disableAll);
    document.getElementById("backgroundPrivateReminders")?.addEventListener("change", changePrivateConsent);
    render();
});
if (window.firebaseAuth?.currentUser) void changeAccount(window.firebaseAuth.currentUser);
