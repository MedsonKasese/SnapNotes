# SnapNotes

**Save Your Mind.**

SnapNotes is a vanilla HTML, CSS, and JavaScript note-taking app for capturing and organizing notes. It supports local browser storage and, when configured and signed in, Firebase-based cloud sync.

**Live app:** [snapnotesmw.vercel.app](https://snapnotesmw.vercel.app)

## Features

| Feature | Description |
|---|---|
| Notes and formatting | Create and edit notes with formatted text; each note is limited to **1,500 characters**. |
| Search and organization | Search notes, filter by category, tags, pinned state, archive, Trash, and folders. |
| Reminders | Set one-time reminders, with browser/service-worker notifications where supported. |
| Private Notes | Protect private note content and metadata with a passphrase-derived AES-GCM key. The passphrase stays in the browser and cannot be recovered. |
| Attachments | Store supported images, PDFs, and text files locally first; signed-in users can sync them through private Supabase Storage. |
| Cloud sync | Sync notes and folders across signed-in devices. The library is written in bounded Firestore pages rather than one unbounded account document. |
| Ask My Notes | Search eligible regular notes with the configured Gemini API; private, archived, trashed, and conflict-copy notes are excluded. |
| Account security | Edit account profile details, schedule account deletion with a 10-day cancellation window, and manage sign-in security. |
| Local-first use | Notes are saved in browser storage when signed out or offline. |

## Local development

Serve the repository over HTTP so browser modules load correctly:

```bash
git clone https://github.com/MedsonKasese/SnapNotes.git
cd SnapNotes
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Basic note editing works locally. Firebase sign-in/cloud sync and server endpoints (Ask My Notes, Supabase attachments, and scheduled account deletion) require a deployment with the server-side configuration below; a static Python server does not run the Vercel API routes.

Run the automated Node regression suite with:

```bash
npm test
```

Node.js 20 or newer is required. The Node tests use the built-in test runner; application dependencies are needed when running the API routes in a deployment environment.

## Deployment configuration

The browser Firebase configuration is in `js/firebaseConfig.js`. Server credentials must be configured as Vercel environment variables and must never be placed in client-side files or committed to Git:

| Variable | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin credentials for server-side AI, Storage authorization, and scheduled account cleanup. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SECRET_KEY` | Server-only Supabase secret API key. |
| `SUPABASE_STORAGE_BUCKET` | Private bucket name; defaults to `Snapnotes-files`. |
| `GEMINI_API_KEY` | Enables Ask My Notes. |
| `GEMINI_MODEL` | Optional Gemini model override. |
| `CRON_SECRET` | Random Vercel Cron bearer secret; required to authorize scheduled account deletion. Use at least 16 random characters and enable it for Production. |

See [Supabase Storage setup](docs/SUPABASE_STORAGE.md) for bucket, authorization, and deployment details, and [Firestore sync setup](docs/FIRESTORE_SYNC.md) for the owner-only rules needed by paged cloud libraries. Vercel Cron invokes the account-deletion worker hourly from the Production deployment; it retries failures and removes the user's Firebase Auth identity, Firestore data/subcollections, and Supabase objects after the scheduled grace period.

**Local-device limitation:** the server cannot erase browser storage on devices that are offline or never open the app again. When a signed-in device observes that deletion processing has started, SnapNotes clears its matching account cache and UID-tagged IndexedDB attachment blobs; referenced legacy blobs are migrated or removed by attachment ID. Unreferenced legacy attachment orphans and caches on other offline devices may remain locally until those devices are used and cleaned manually.

## Tech stack

- HTML5, CSS3, and JavaScript ES modules
- Firebase Authentication and Firestore
- Vercel serverless API routes
- Supabase private Storage for attachments and profile photos
- Gemini API for Ask My Notes

## License

This project is licensed under the [MIT License](LICENSE).
