# Supabase Storage setup for SnapNotes

## Configuration

This branch is independent of the preserved Cloudflare R2 branch (`feature/cloudflare-r2-storage`). Keep PR #59 unmerged as an R2 reference.

1. In Supabase Storage, create a **private** bucket with the exact case-sensitive name `Snapnotes-files`. Do not make it public.
2. In Vercel → SnapNotes → Settings → Environment Variables, configure:
   - `SUPABASE_URL`: Supabase project URL
   - `SUPABASE_SECRET_KEY`: Supabase secret API key (server-only)
   - `SUPABASE_STORAGE_BUCKET`: `Snapnotes-files`
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: existing Firebase Admin service account JSON, also used by the AI endpoint
3. Enable variables for **Preview** (and Production when ready). Redeploy the preview after adding variables.
4. Do not put any secret key in client JavaScript, GitHub, browser storage, or screenshots.

## Security and behavior

Firebase Auth is the only user login. Each Vercel API request verifies the Firebase ID token, then uses the Supabase secret key **only on the server**. Files are stored in a private bucket under `users/{firebaseUid}/attachments/{noteId}/{randomId}` and `users/{firebaseUid}/profile/avatar-{randomId}.{ext}`. Upload URLs and attachment download URLs expire. No Supabase login is required. The browser uploads directly to Supabase via a signed URL to avoid Vercel function upload size limits.

The backend checks the user namespace and file metadata. Attachment files are first stored in IndexedDB, so a failed upload remains on the device and can retry. The note metadata contains a Supabase object path, **not** an expiring download URL. Profile pictures are intentionally viewable by anyone who has their profile photo URL; note attachments are not public.

## Test before merging

- Confirm Vercel preview deploys successfully and GitHub checks pass.
- Sign in with an email account, upload a JPEG profile photo under 2 MB, refresh, and confirm it still loads.
- Create a note with a small PNG/PDF attachment; confirm `Synced across devices`, then open it from a second device.
- Turn off connectivity, attach a file, and confirm local retention and automatic retry when connectivity returns.
- Remove a synced attachment and verify it disappears from the note and Supabase bucket.
- Verify a different Firebase user cannot sign or delete another user's object.
- Test wrong bucket name, missing key, oversized file, and missing network to confirm useful errors.

## Migration scope

This release handles **new** Supabase uploads for both note attachments and profile photos. It does **not** transfer existing bytes from the inaccessible Firebase Storage bucket. Existing legacy Firebase download URLs are retained as read-only fallback if still accessible. Users may need to re-upload older attachments if their local copies remain available.

The free tier has finite storage, bandwidth and file limits. Monitor Supabase usage before increasing attachment size limits.
