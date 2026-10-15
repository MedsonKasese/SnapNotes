# Firestore sync and security rules

SnapNotes stores an account's active library as bounded page documents under `users/{uid}/libraries/{revision}/pages/{pageId}`. The account document stores only the active revision pointer and sync metadata. The app still reads legacy `notes` and `folders` fields during migration, then removes them when the first paged revision commits.

No Firestore rules file or Firebase deployment config existed in this repository when this change was made, so rules managed in the Firebase Console are not overwritten. Merge equivalent owner-only conditions into the existing ruleset before deploying paged sync. The rules must allow a signed-in owner to read their root account document, write only while deletion is not processing, and access their own library pages. They must also let that owner read (but never write) the short-lived deletion tombstone. The following is an example for projects whose only Firestore data is this user's library:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner(uid) {
      return request.auth != null && request.auth.uid == uid;
    }

    function isDeletionProcessing(uid) {
      let userPath = /databases/$(database)/documents/users/$(uid);
      return exists(userPath) &&
        (get(userPath).data.get('accountDeletion', {}) is map) &&
        get(userPath).data.get('accountDeletion', {}).get('status', '') == 'processing';
    }

    function hasDeletionTombstone(uid) {
      return exists(/databases/$(database)/documents/accountDeletionTombstones/$(uid));
    }

    match /users/{uid} {
      allow read: if isOwner(uid) && !hasDeletionTombstone(uid);
      allow create, update, delete: if isOwner(uid) &&
        !isDeletionProcessing(uid) && !hasDeletionTombstone(uid);

      match /libraries/{revision}/pages/{pageId} {
        allow read, write: if isOwner(uid) &&
          !isDeletionProcessing(uid) && !hasDeletionTombstone(uid);
      }

      match /deletedNotes/{noteId} {
        allow read: if isOwner(uid) &&
          !isDeletionProcessing(uid) && !hasDeletionTombstone(uid);
        allow create: if isOwner(uid) &&
          !isDeletionProcessing(uid) && !hasDeletionTombstone(uid) &&
          request.resource.data.keys().hasOnly(['noteId', 'deletedAt']) &&
          request.resource.data.noteId is string;
        allow update, delete: if false;
      }
    }

    match /accountDeletionTombstones/{uid} {
      allow get: if isOwner(uid);
      allow list, create, update, delete: if false;
    }
  }
}
```

The scheduled deletion worker uses Firebase Admin, so it bypasses client rules. Once it has removed the user's storage objects, it writes an Admin-only tombstone, deletes the Firebase Auth user, and recursively deletes the user's Firestore data. The tombstone blocks a still-valid ID token from recreating data after deletion; it contains only deletion timestamps, expires after 24 hours, and is purged on a subsequent daily worker run (so it may remain longer than 24 hours). This exceeds a Firebase ID token's lifetime. The user document's `processing` status also blocks client writes during the cleanup phase. Ensure no existing, more-permissive overlapping `allow` rule overrides these restrictions; merge into the project's active rules rather than replacing project rules blindly.

Each page targets at most 450 KiB of serialized JSON, safely below Firestore's 1 MiB document ceiling. A single oversized note is left local and reported as pending instead of being split or silently truncated. Sync stages immutable revision pages and changes the active pointer in a transaction. Note versions merge into the canonical note history: a longer shared edit-history lineage takes precedence over skewed device timestamps, and the alternate content is retained as a history entry instead of a duplicate conflict note. If another device commits first, the client reloads and retries from the new library revision.

Permanent note deletion uses immutable ID-only markers at `users/{uid}/deletedNotes/{encodedNoteId}`. The marker contains only `noteId` and `deletedAt`—not note content—and is retained so a device that reconnects after a long offline period cannot recreate the deleted note. The user's `deletedNotesVersion` increments transactionally with marker creation; library sync compares that version before switching the active page revision, preventing a concurrent sync from winning a race against a permanent delete. After committing the filtered revision, the old page documents are deleted. Failed page cleanup remains listed in `inactiveLibraryRevisions` and is retried by later syncs. Configure rules to allow owner reads and creates for these markers, while denying updates and deletes.
