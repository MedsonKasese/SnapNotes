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
  const userId = () => window.firebaseAuth?.currentUser?.uid || null;
  function render() {
    const uid = userId();
    if (!uid) {
      status.textContent = "Sign in to view synchronization status.";
      last.textContent = "";
    } else if (!navigator.onLine) {
      status.textContent = "Offline — changes are stored locally until synchronization succeeds.";
    } else if (running) {
      status.textContent = "Synchronizing notes and pending attachments…";
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
    retry.disabled = !uid || !navigator.onLine || running;
  }
  window.addEventListener("snapnotes:sync-status", event => {
    const uid = userId();
    if (!uid || event.detail?.uid !== uid) return;
    if (event.detail.status === "synced") localStorage.setItem(key(uid), new Date().toISOString());
    render();
  });
  retry.addEventListener("click", async () => {
    const uid = userId();
    if (!uid || running || !navigator.onLine) return;
    running = true;
    render();
    try {
      const result = await window.syncToCloud?.(uid);
      if (result === false) status.textContent = "Cloud note sync did not complete. Please retry.";
      await window.retryPendingAttachmentUploads?.();
      await window.retryPendingAttachmentCleanup?.();
    } catch (error) {
      console.warn("Manual sync failed:", error);
      status.textContent = "Sync failed. Your local changes remain available.";
    } finally {
      running = false;
      render();
    }
  });
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  window.addEventListener("snapnotes:auth-changed", render);
  window.addEventListener("snapnotes:auth-ready", render);
  document.getElementById("settingsBtn")?.addEventListener("click", render);
  render();
})();
