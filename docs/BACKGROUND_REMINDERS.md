# Background reminders service

This service is an opt-in, always-on Node web service for sending Web Push reminders when the SnapNotes app is not open. The source notes and note content remain in Firebase; only reminder scheduling metadata, a Firebase UID, and push subscription endpoint/keys are stored in server-only Firestore subcollections. Notification text is generic and does not contain note titles or bodies.

## Deployment status

`render.yaml` is a deployment blueprint, not a deployment. No Render service or Firebase account changes are made by this repository. The browser API URL is empty, so this integration makes no reminder-service requests until configured. The blueprint disables automatic deployments and selects an always-on paid compute plan; review its current charges before importing or creating anything. [Render free web services sleep after 15 minutes without inbound traffic](https://render.com/docs/free), so they cannot reliably run this periodic worker.

## Required Render environment

- `APP_ORIGIN`: exact HTTPS origin of the deployed SnapNotes app, e.g. `https://notes.example.com` (scheme and host, no path). CORS is exact-origin only.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: JSON contents of a Firebase service account for the same Firebase project as the app. Give it only the Firebase Auth/Firestore server privileges it needs; Admin SDK credentials bypass Firestore client rules. Store it as a Render secret, never in source control.
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`: matching VAPID pair. After `npm ci`, generate locally with `./node_modules/.bin/web-push generate-vapid-keys --json`; store both in Render. The public key is served by `/v1/config`; never expose the private key or commit generated keys.
- `VAPID_SUBJECT`: contact URI, preferably `mailto:you@example.com`.
- Render provides `PORT` automatically. `NODE_VERSION` is set to 22 in the blueprint, matching the locked dependencies and CI.

The Firebase Admin service verifies every bearer token with `verifyIdToken(token, true)` and checks both account deletion processing state and `accountDeletionTombstones/{uid}`. It is not deployed or configured by merely adding `render.yaml`.

## Setup after review

1. Review and merge the code separately from deployment. Run `npm ci && npm test` on Node 22 or newer. Tests use local HTTP and in-memory stores, not live Firebase or push credentials.
2. Prepare the server-only environment values above. In the same Firebase project, use the Firestore console's single-field index settings to enable an **ascending collection-group index** for collection ID `backgroundReminders`, field `nextAttemptAt`. This is required for the due-reminder query. Keep existing indexes and owner-only client rules unchanged; the new server subcollections have no client access.
3. Only when deployment and its costs are approved, create the Render web service from `render.yaml`, or manually select Node, repository root, build command `npm ci`, start command `node backend/reminders/server.mjs`, and health path `/healthz`. Use an always-on plan. Set the exact app origin and all server secrets. The blueprint's `autoDeployTrigger: "off"` leaves later deployments manual; see [Render's Blueprint specification](https://render.com/docs/blueprint-spec).
4. Check `/healthz` and `/v1/config`. The health endpoint checks process liveness, not Firebase/index connectivity. Verify worker logs and a controlled test account before relying on delivery.
5. Set only `BACKGROUND_REMINDER_API` in `js/background-reminder-config.js` to the service's HTTPS **origin**, without a path, and deploy that frontend change through the app's normal reviewed workflow. Firebase credentials and VAPID private keys never belong in browser code. The API URL is a trusted maintainer setting because Firebase ID tokens are sent to it.
6. Sign in, finish cloud sync, and choose **Settings → Background reminders → Enable on this device**. Permission is requested from that click. Wait for the successful schedule-sync status before closing the PWA. Opt in separately to private schedule sharing and unlock Private Notes once to publish their schedules. Locked clients preserve existing private schedules rather than erasing them.
7. Test a one-time and recurring reminder with the PWA closed, click through to the note, reopen and confirm completion/next occurrence, then test device sign-out and account-wide disable. Real push delivery and Firebase Admin connectivity require this later staging check; they have not been exercised by the local regression suite.

Changing a reminder offline does not update the server until cloud and schedule sync both succeed. Private publishing consent is stored per account **on each browser**. Unchecking its Settings option removes current private schedules after successful sync, but another previously opted-in browser can publish them again; turn sharing off there too, or use **Disable on all devices** for durable account-wide background opt-out. A failed removal remains pending and the UI warns that existing server schedules may continue.

## HTTP protocol

All authenticated endpoints require `Authorization: Bearer <Firebase ID token>`. The service derives UID only from the verified token; it ignores client-supplied UID. JSON request bodies are capped at 1 MiB. Errors intentionally omit provider/credential details.

| Method/path | Auth | Behavior |
|---|---|---|
| `GET /healthz` | Public | Liveness check `{ "ok": true }` |
| `GET /v1/config` | Public | Returns `{ "vapidPublicKey": "..." }` |
| `POST /v1/subscriptions` | Required | Body `{ "subscription": PushSubscriptionJSON }`; endpoint HTTPS hosts are restricted to known push providers; endpoint doc ID is SHA-256 of endpoint. |
| `DELETE /v1/subscriptions` | Required | Body `{ "endpoint": "..." }`; removes only that browser/device subscription. |
| `GET /v1/reminders` | Required | Returns `{ "enabled": boolean, "reminders": [...] }`. `enabled` is account-wide and true when any subscription exists. |
| `PUT /v1/reminders` | Required | Replaces the caller's metadata snapshot after validating active library revision and canonical note fields. |
| `DELETE /v1/reminders` | Required | **Account-wide** opt-out: removes all account subscriptions and schedules on all devices. Use `DELETE /v1/subscriptions` for a single device. |

### Snapshot request

`PUT /v1/reminders` accepts:

```json
{
  "revision": "activeLibraryRevision",
  "privateMode": "preserve",
  "reminders": [
    {
      "noteId": "note-123",
      "reminderAt": "2030-01-01T12:00:00.000Z",
      "reminderNotified": false,
      "reminderRepeat": { "frequency": "weekly", "interval": 1, "timeZone": "America/New_York", "anchorAt": "2030-01-01T12:00:00.000Z" },
      "isPrivate": false
    }
  ]
}
```

The full list is capped at 2,000 unique notes. Only schedule metadata is accepted; title, text, attachments, and arbitrary payload data are not stored. Public metadata must match the selected active library page snapshot. Private entries additionally require `privateUpdatedAt` equal to the canonical encrypted note's `updatedAt`; the backend cannot decrypt private fields. IDs are treated as opaque strings and stored under SHA-256 IDs.

`privateMode` controls device visibility and must reflect explicit UI consent:

- `preserve` (default): ignores incoming private entries and retains previously stored private schedules, including when the client is locked or cannot see them.
- `replace`: accepts private schedule entries included in the complete snapshot; use only when the user explicitly opted in and private data is unlocked.
- `remove`: omits all private schedules, an explicit account-wide removal action.

Private publishing consent belongs to the browser, while published schedules and subscribed delivery devices belong to the account. The UI describes this distinction and account-wide removal explicitly. To stop notifications across the account, call `DELETE /v1/reminders`; stale schedule PUTs cannot override that opt-out. A later explicit device enrollment can re-enable the account. To sign out/unregister only the current browser, delete that browser subscription.

### GET response and reconciliation

Each item returns:

```json
{
  "noteId": "note-123",
  "sourceReminderAt": "2030-01-01T12:00:00.000Z",
  "sourceReminderNotified": false,
  "sourceReminderRepeat": null,
  "sourcePrivateUpdatedAt": "",
  "reminderAt": "2030-01-08T12:00:00.000Z",
  "reminderNotified": false,
  "reminderRepeat": null,
  "isPrivate": false
}
```

`source*` records the canonical metadata that created the server schedule; unprefixed `reminder*` is effective worker state. After cloud sync, a client should GET state and compare the source fields to the note snapshot before reconciling effective state, then PUT a complete metadata snapshot using the latest committed `activeLibraryRevision`. A worker's source key remains stable for an unchanged source; same-key snapshot writes retain successful-delivery ledgers and leases. An unrelated library revision change does not itself invalidate a schedule: the worker validates the latest active canonical note against the stored source fields. A deleted, archived, changed, or missing note cancels its scheduled notification.

## Worker and delivery behavior

A bounded worker cycle runs every 20 seconds in the same Render process as the HTTP server. Due documents are queried through a Firestore collection-group query on `nextAttemptAt`, leased transactionally to prevent concurrent workers, and processed in small batches. Firestore collection-group queries may prompt for a single-field collection-group index on `nextAttemptAt`; create the index if the Firebase console reports one missing. The worker checks account tombstones/deletion status and active-library note existence/source metadata immediately before delivery.

Every push uses one generic title and body; private reminders use a distinct generic body, never note content. The browser's service worker resolves the note ID internally; the notification contains no external URL. Successful subscription deliveries are persisted before retrying other devices, so a transient failure retries only undelivered devices. 404/410 push responses remove expired subscriptions. Failures use bounded exponential retry. A one-time reminder is retained as completed so a later metadata upload does not re-arm it; recurring reminders use the app's `js/reminder-utils.js` recurrence calculation for catch-up behavior.

Delivery is **at least once**, not exactly once: a process crash after the push provider accepts a message but before Firestore records success may cause a duplicate. The stable notification tag replaces a still-visible notification for the same note, but cannot undo an alert already seen. A push already accepted by a provider cannot be recalled by disable, note deletion, or account deletion; lease and account checks prevent subsequent dispatches after cancellation is observed. Retries can delay recurrence catch-up when a device remains unreachable.

Firestore rules default to deny for the server-owned `pushSubscriptions`, `backgroundReminders`, and `backgroundReminderControl` subcollections. The Admin SDK uses server credentials and is not governed by those client rules.

## Browser/platform caveats

Web Push support depends on the browser, operating system, permission settings, and service-worker support. Users must explicitly grant notification permission. iOS/iPadOS web push requires an installed Home Screen web app on supported OS versions; ordinary browser tabs do not reliably receive background notifications. Battery-saving modes, force-quit behavior, vendor push quotas, network availability, and provider expiration can delay or suppress notifications. This service improves availability while the app is closed; it cannot promise delivery time or bypass OS/browser limits.
