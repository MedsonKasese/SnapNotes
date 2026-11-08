// Sync Center shows confirmed cloud note sync separately from local attachment uploads.
(() => {
  const status = document.getElementById("syncCenterStatus");
  const last = document.getElementById("syncCenterLast");
  const retry = document.getElementById("syncCenterRetry");
  if (!status || !last || !retry) return;
  const key = uid => "SnapNotesLastCloudSync:" + uid;
  const pending = uid => localStorage.getItem("SnapNotesSyncPending:" + uid) === "true" ||
    localStorage.getItem("SnapNotesSyncPending") === "true";
  let running = false;
  let syncError = "";
  const userId = () => window.firebaseAuth?.currentUser?.uid || null;
  async function localLibraryHasVerifiedBackup() {
    if (!window.localNotesReady || typeof window.localNotesReady.then !== "function") return false;
    try { await window.localNotesReady; } catch { return false; }
    const notes = Array.isArray(window.notes) ? window.notes : [];
    const folders = Array.isArray(window.getFolders?.()) ? window.getFolders() : [];
    if (!notes.length && !folders.length) return true;
    const matches = snapshot => Array.isArray(snapshot?.notes) && Array.isArray(snapshot?.folders) &&
      JSON.stringify(snapshot.notes) === JSON.stringify(notes) &&
      JSON.stringify(snapshot.folders) === JSON.stringify(folders);
    try {
      const durable = await window.readLocalLibrary?.("local");
      if (matches(durable)) return true;
    } catch {}
    try {
      const cached = JSON.parse(localStorage.getItem("SnapNotesLocalCache") || "null");
      return matches(cached);
    } catch {
      return false;
    }
  }
  function render() {
    const uid = userId();
    if (!uid) {
      status.textContent = "Sign in to view synchronization status.";
      last.textContent = "";
    } else if (!navigator.onLine) {
      status.textContent = "Offline — changes are stored locally until synchronization succeeds.";
    } else if (running) {
      status.textContent = "Synchronizing notes and pending attachments…";
    } else if (syncError) {
      status.textContent = syncError;
    } else if (window.snapNotesDataUid !== uid) {
      status.textContent = "Device notes remain local. Start the existing PWA cloud sync only when you intend to sync them with this account.";
    } else if (pending(uid)) {
      status.textContent = "Pending cloud changes — not everything is synced yet.";
    } else if (localStorage.getItem(key(uid))) {
      status.textContent = "Last cloud note synchronization succeeded.";
    } else {
      status.textContent = "Cloud sync not yet confirmed in this browser.";
    }
    if (uid) {
      const date = localStorage.getItem(key(uid));
      last.textContent = date ? "Last confirmed note sync: " + new Date(date).toLocaleString() : "No confirmed sync recorded yet.";
    }
    const confirmedSync = uid && localStorage.getItem(key(uid));
    const needsSync = uid && (window.snapNotesDataUid !== uid || pending(uid) || Boolean(syncError) || !confirmedSync);
    retry.disabled = !uid || !navigator.onLine || running || !needsSync;
    retry.textContent = window.snapNotesDataUid !== uid ? "Start cloud sync" : "Sync now";
  }
  window.addEventListener("snapnotes:sync-status", event => {
    const uid = userId();
    if (!uid || event.detail?.uid !== uid) return;
    if (event.detail.status === "synced") {
      syncError = "";
      localStorage.setItem(key(uid), new Date().toISOString());
    }
    render();
  });
  retry.addEventListener("click", async () => {
    const uid = userId();
    if (!uid || running || !navigator.onLine) return;
    const startingCloudLibrary = window.snapNotesDataUid !== uid;
    if (startingCloudLibrary) {
      if (!await localLibraryHasVerifiedBackup()) {
        syncError = "A complete local backup could not be verified. Cloud sync was not started; device notes remain local.";
        render();
        return;
      }
      if (typeof window.getAccountDeletionStatus !== "function") {
        syncError = "Account status could not be verified. Cloud sync was not started; device notes remain local.";
        render();
        return;
      }
      let deletionStatus;
      try {
        deletionStatus = await window.getAccountDeletionStatus(uid);
      } catch {
        syncError = "Account status could not be verified. Cloud sync was not started; device notes remain local.";
        render();
        return;
      }
      if (deletionStatus?.tombstone || deletionStatus?.status === "processing") {
        syncError = "Account deletion is being processed. Cloud sync was not started; device notes remain local.";
        render();
        return;
      }
      const confirmed = window.confirm?.(
        "Start the existing PWA cloud sync for this account? It may merge this device's notes with cloud notes, sync saved note-deletion markers, and retry pending attachment uploads or cleanup. The PWA full snapshot still includes Private Notes. Continue only if that is intended."
      );
      if (!confirmed) return;
    }
    running = true;
    syncError = "";
    render();
    try {
      if (startingCloudLibrary) {
        const previousLibraryUid = window.snapNotesDataUid;
        window.snapNotesDataUid = uid;
        await window.loadFromCloud?.(uid);
        if (!window.isCloudLibraryReady?.(uid)) {
          window.snapNotesDataUid = previousLibraryUid || "local";
          syncError = "The cloud library could not be verified. Device notes remain local; please retry.";
        }
      } else {
        const result = await window.syncToCloud?.(uid);
        if (result === false) syncError = "Cloud note sync did not complete. Please retry.";
        await window.retryPendingAttachmentUploads?.();
        await window.retryPendingAttachmentCleanup?.();
      }
    } catch (error) {
      console.warn("Manual sync failed:", error);
      if (startingCloudLibrary && window.snapNotesDataUid === uid && !window.isCloudLibraryReady?.(uid)) {
        window.snapNotesDataUid = "local";
      }
      syncError = "Sync failed. Your local changes remain available.";
    } finally {
      running = false;
      render();
    }
  });
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  window.addEventListener("snapnotes:auth-changed", () => { syncError = ""; render(); });
  window.addEventListener("snapnotes:auth-ready", render);
  document.getElementById("settingsBtn")?.addEventListener("click", render);
  render();
})();
