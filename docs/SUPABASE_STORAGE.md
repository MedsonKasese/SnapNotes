# Supabase Storage setup for SnapNotes

## Configuration

This branch is independent of the preserved Cloudflare R2 branch (`feature/cloudflare-r2-storage`). Keep PR #59 unmerged as an R2 reference.

1. In Supabase Storage, create a **private** bucket with the exact case-sensitive name `Snapnotes-files`. Do not make it public.
2. In Vercel → SnapNotes → Settings → Environment Variables, configure:
   - `SUPABASE_URL`: Supabase project URL
   - `SUPABASE_SECRET_KEY`: Supabase secret API key (server-only)
   - `SUPABASE_STORAGE_BUCKET`: `Snapnotes-files`
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: existing Firebase Admin service account JSON, also used by the AI endpoint
   - `CRON_SECRET`: a random bearer secret of at least 16 characters for Vercel Cron; enable it for Production
3. Enable variables for **Preview** (and Production when ready). Redeploy the preview after adding variables.
4. Do not put any secret key in client JavaScript, GitHub, browser storage, or screenshots.

## Security and behavior

Firebase Auth is the only user login. Each Vercel API request verifies the Firebase ID token, then uses the Supabase secret key **only on the server**. Files are stored in a private bucket under `users/{firebaseUid}/attachments/{noteId}/{randomId}` and `users/{firebaseUid}/profile/avatar-{randomId}.{ext}`. Upload URLs and attachment download URLs expire. No Supabase login is required. The browser uploads directly to Supabase via a signed URL to avoid Vercel function upload size limits.

The backend checks the user namespace and file metadata. Regular attachment files are first stored in IndexedDB, so a failed upload remains on the device and can retry. For Private Notes, the browser encrypts attachment bytes with the passphrase-derived AES-GCM key before storing or uploading them; decryption happens only after the private note is unlocked. Moving a note back to the regular library decrypts its files into regular attachment copies.

Existing private attachments are migrated when Private Notes is unlocked if their file bytes can be safely retrieved. Supported older Supabase objects are queued for deletion after migration. Legacy download URLs that cannot be safely replaced are surfaced in the note detail and need to be removed/re-attached before relying on private attachment protection. Failed deletion of an older cloud copy is reported and queued for retry. The note metadata contains a Supabase object path, **not** an expiring download URL. Profile pictures are intentionally viewable by anyone who has their profile photo URL; note attachments are not public.

## Scheduled account deletion

`vercel.json` schedules `/api/cron/delete-scheduled-accounts` daily at 00:00 UTC, which is compatible with Vercel Hobby. Hobby Cron timing may drift by up to 59 minutes, so account processing can begin about 25 hours after the 10-day grace-period deadline in the worst case. Vercel sends `Authorization: Bearer <CRON_SECRET>`; the endpoint rejects requests if the secret is missing or does not match. The worker claims deletion atomically, removes user objects from the private bucket in retryable batches, deletes the Firebase Auth user, and recursively deletes the user's Firestore document and subcollections. Each invocation handles one eligible account; large storage cleanups continue in daily batches. Configure `CRON_SECRET` in Vercel before relying on scheduled deletion and redeploy after changing the cron configuration. See [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs), [Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), and [Cron security](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

Browser-local caches cannot be removed remotely while a device is offline. A device that observes the worker's `processing` status clears its matching account cache and UID-tagged IndexedDB blobs; referenced legacy blobs are migrated or deleted by their attachment IDs. Unreferenced legacy orphans and data on other offline devices may remain until those devices are opened and cleaned.

The paged cloud library also requires owner-only Firestore access to `users/{uid}/libraries/{revision}/pages/{pageId}`. See [Firestore sync setup](FIRESTORE_SYNC.md) and merge its rule into the Firebase project's existing rules before deploying the paged sync.

## Test before merging

- Confirm Vercel preview deploys successfully and GitHub checks pass.
- Sign in with an email account, upload a JPEG profile photo under 2 MB, refresh, and confirm it still loads.
- Create a note with a small PNG/PDF attachment; confirm `Synced across devices`, then open it from a second device.
- Turn off connectivity, attach a file, and confirm local retention and automatic retry when connectivity returns.
- Move a note with an attachment into Private, confirm its IndexedDB/cloud bytes are ciphertext, unlock it, and verify the file opens; then move it back and confirm the restored file opens.
- Test all four Private Notes lock choices and confirm unsupported legacy attachment URLs are clearly flagged.
- Remove a synced attachment and verify it disappears from the note and Supabase bucket.
- Verify a different Firebase user cannot sign or delete another user's object.
- Test wrong bucket name, missing key, oversized file, and missing network to confirm useful errors.

## Migration scope

This release handles **new** Supabase uploads for both note attachments and profile photos. It does **not** transfer existing bytes from the inaccessible Firebase Storage bucket. Existing legacy Firebase download URLs are retained as read-only fallback if still accessible. Users may need to re-upload older attachments if their local copies remain available.

The free tier has finite storage, bandwidth and file limits. Monitor Supabase usage before increasing attachment size limits.
