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
| Private Notes | Encrypt note content and metadata with a passphrase-derived AES-GCM key. Supported attachments are encrypted on-device before storage; legacy files that cannot be migrated are flagged for re-attachment. Lock immediately, after 1 or 5 minutes, or when the app closes; supported devices can also unlock locally with a passkey or biometric. |
| Attachments | Store supported images, PDFs, and text files locally first; signed-in users can sync them through private Supabase Storage. Private-note attachment bytes are encrypted on-device during migration and before sync. |
| Cloud sync | Sync notes and folders across signed-in devices. The library is written in bounded Firestore pages rather than one unbounded account document. |
| Ask My Notes | Search eligible regular notes with the configured Gemini API; private, archived, trashed, and conflict-copy notes are excluded. Answers include links to their source notes. |
| Account security | Edit account profile details, schedule account deletion with a 10-day cancellation window, and manage sign-in security. |
| Local-first use | Notes are saved locally first, mirrored to IndexedDB and localStorage, and queued for cloud sync when offline. The app requests persistent browser storage where supported, while keeping a localStorage fallback. |

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
| `RESEND_API_KEY` | Server-only Resend key for account verification and password-reset emails. |
| `RESEND_FROM_EMAIL` | Sender address on a Resend-verified domain, optionally `SnapNotes <auth@example.com>`. |
| `SNAPNOTES_APP_URL` | Exact HTTPS app origin for authentication email requests and Firebase return links. |
| `AUTH_EMAIL_HOURLY_LIMIT` | Optional deployment-wide authentication email request budget; defaults to `100`. |

See [Supabase Storage setup](docs/SUPABASE_STORAGE.md) for bucket, authorization, and deployment details, and [Firestore sync setup](docs/FIRESTORE_SYNC.md) for the owner-only rules needed by paged cloud libraries. Vercel Cron invokes the account-deletion worker daily at 00:00 UTC to remain compatible with Hobby. Hobby timing may drift by up to 59 minutes, so processing can begin about 25 hours after the 10-day grace-period deadline in the worst case. Failed or large storage cleanups continue in retryable daily batches; each run handles one eligible account.

**Authentication emails:** verification and password-reset delivery use Resend, while Firebase continues to handle sign-in and secure action links. Configure the required variables and verified sender **before merging/deploying this change**; there is no Firebase-delivery fallback. See [Resend authentication email setup](docs/RESEND_AUTH_EMAIL.md) for rollout, rate limits, Firestore TTL cleanup, and live checks.

**Local-device limitation:** the server cannot erase browser storage on devices that are offline or never open the app again. When a signed-in device observes that deletion processing has started, SnapNotes clears its matching account cache and UID-tagged IndexedDB attachment blobs; referenced legacy blobs are migrated or removed by attachment ID. Unreferenced legacy attachment orphans and caches on other offline devices may remain locally until those devices are used and cleaned manually.

## Tech stack

- HTML5, CSS3, and JavaScript ES modules
- Firebase Authentication and Firestore
- Vercel serverless API routes
- Supabase private Storage for attachments and profile photos
- Gemini API for Ask My Notes

## License

This project is licensed under the [MIT License](LICENSE).
