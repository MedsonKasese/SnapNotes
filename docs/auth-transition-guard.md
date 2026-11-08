# Local-first account transitions

Signing in, signing out, restoring a Firebase session, or switching accounts does not by itself load, merge, upload, reassign, overwrite, or delete the active note library. The auth observer only changes in-memory library ownership state; when leaving an account-bound library, it restores a locally saved library snapshot in memory. That path reads local storage/IndexedDB but does not write note storage, Firestore, attachments, or deletion markers. If a local snapshot cannot be read, the transition fails closed to an empty in-memory library rather than displaying the previous account's notes.

A device-local library remains local after sign-in. PWA note saves and reconnect retries are blocked from Firestore unless the active library UID exactly matches the signed-in Firebase UID. Attachment retries no longer run from the auth-change event and are blocked unless both the active library and the stored attachment owner match the current account; legacy or mismatched files are not claimed automatically. Shared localStorage note/folder snapshots are read or replaced only when their recorded library owner matches, while each library's durable IndexedDB snapshot remains separate.

## Starting the existing PWA sync

The Sync Center is the explicit entry point for first-time account sync. It waits for the local-library load, requires a matching durable local backup, checks account-deletion status, and warns that the existing PWA flow may combine device and cloud notes, sync saved note-deletion markers, and retry pending attachment uploads or cleanup. Cancelling or failing a preflight leaves the device library in local mode. This guard does not redesign the PWA's sync writer or change its established full-snapshot semantics.

## Private Notes and Mobile preview

The PWA's existing full-snapshot format still includes its encrypted Private Notes records. This change deliberately does not filter, migrate, or rewrite those records because changing the snapshot could overwrite existing cloud data. Mobile's new cloud preview filters Private Notes from what it displays and never writes the preview back. Mobile must not become a Firestore writer until Private Notes separation and a safe cross-platform conflict/migration design are addressed in a later phase.

No live Firestore rules, account data, Firebase settings, Supabase/Vercel settings, or deployments were changed as part of this code change. The live Firebase Console rules and production revision completeness still require owner verification before any later sync-write phase.
