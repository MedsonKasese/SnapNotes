# Verification and password-reset emails with Resend

SnapNotes uses Resend to deliver both account-verification and password-reset emails. Firebase still creates, validates, expires, and consumes the secure action links, and its hosted action page handles verification and choosing a new password. Google sign-in is unchanged. No Firebase email-delivery fallback is used.

## Configure before deploying this change

The email flows need these **server-only** Vercel environment variables. Do not commit real values or put them in browser JavaScript.

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | A Resend API key with email sending permission; restrict it to your sending domain where possible. |
| `RESEND_FROM_EMAIL` | A sender on a domain verified in Resend, for example `SnapNotes <auth@example.com>`. The example address is a placeholder, not a working sender. |
| `SNAPNOTES_APP_URL` | The exact HTTPS origin of this deployment, for example `https://snapnotesmw.vercel.app` (no path, query, or fragment). Used for origin checks and the return-to-app link. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Firebase Admin service account JSON for the same project used by `js/firebaseConfig.js`. Its identity must be authorized for Firebase Authentication and Firestore transactions. |
| `AUTH_EMAIL_HOURLY_LIMIT` | Optional deployment-wide request budget; defaults to `100`. Use a positive integer appropriate for your traffic and Resend quota. |

Verify your sending domain in Resend and publish its required DNS records. Ensure the app hostname is listed under Firebase Authentication's **Authorized domains**. Keep Firebase's email/password provider enabled and the default hosted email-action handler configured. Custom Firebase action handlers, if already configured, must continue to support both modes.

Set variables separately for Production and Preview. A preview must use its own exact origin and an authorized Firebase domain. Never change the production origin merely to test a preview. Redeploy after changing environment variables. Missing or invalid configuration fails closed; sign-in itself still uses Firebase, but verification and reset delivery will not work until configuration is ready.

## What the endpoint does

`POST /api/auth/email` accepts JSON and only requests from the configured app origin:

- `{ "action": "verify-email" }` requires a Firebase ID token in `Authorization: Bearer …`. The server checks revocation and reads the current Firebase user. It sends only to that user's email, not any supplied recipient. Already-verified accounts do not receive another message.
- `{ "action": "reset-password", "email": "user@example.com" }` does not require sign-in. Responses use the same generic message for existing, missing, disabled, and Google-only accounts. Only enabled accounts with a password provider receive a reset message. Delivery failures also retain the generic response, avoiding an account-existence oracle; operators should monitor the sanitized server error signal.

Action links, provider responses, recipients and API keys are never returned to the browser or written to application logs. Both HTML and plain-text templates are included, with user-provided names escaped in HTML. No note contents are sent to Resend. Resend receives the recipient and Firebase action link needed to deliver the requested email.

## Abuse controls and privacy

Firestore transactions in the server-only `authEmailRateLimits` collection enforce quotas across serverless instances. Counter IDs are namespaced by the configured app origin, so a preview sharing the Firebase project does not consume production's counters. Multiple origins still share the provider account's overall sending quota:

- Per connecting IP: 10 admitted requests per rolling hour, at least 10 seconds apart.
- Per normalized email: 3 admitted requests per rolling hour, at least 60 seconds apart, shared between verification and resets.
- Per deployment: 100 admitted requests per rolling hour by default, configurable above.

Counters are claimed before generating links or contacting Resend. Failed deliveries consume the allowance; wait at least a minute before retrying. Recipient-limited reset requests retain the generic success response. Other throttled requests receive `429` and `Retry-After`. These are request quotas rather than exact sent-email counts, so reset requests for unknown addresses also consume admitted quota.

The endpoint relies on Vercel's trusted `x-vercel-forwarded-for` header, not client-supplied `x-forwarded-for`. Missing or invalid trusted IP metadata fails closed. Non-Vercel hosting needs an explicitly trusted IP adapter before use. Browser origin validation is an additional guard, not bot authentication; direct clients can forge `Origin`. Consider a Vercel Firewall rate rule or bot challenge for heavy public traffic. A distributed attacker can exhaust the global request budget and temporarily prevent emails; the finite budget deliberately caps downstream sending costs.

IP addresses and normalized emails are stored only as SHA-256-derived document IDs. Hashing is pseudonymization, not anonymization. Counter documents contain no raw email, IP, action link or token. Each subject reuses one document and each write updates `expiresAt`. **Enable a Firestore TTL policy on `authEmailRateLimits.expiresAt`** to clean up inactive subjects; until enabled, unique-subject documents remain and may accumulate. Existing rules deny all client access; the included explicit deny documents that intent. Do not grant client reads or writes to this collection.

## Review and test before merging

Run `npm test` for mocked behavior and regression tests. These tests do not contact Resend, Firebase, or send live email. A plain static Python server cannot execute this API route; use a configured Vercel preview for end-to-end testing.

1. Configure a preview and verified sender, then create a test email/password account. Confirm one branded verification email arrives, its link verifies the account, and returning to SnapNotes allows sign-in. Firebase may require signing in again to refresh verification state.
2. Request another verification email before verification; confirm the busy state and cooldown. Attempting again immediately should not deliver a duplicate. After verification, no further verification email should be sent.
3. Sign out, request a password reset, and confirm its hosted Firebase page accepts a new password. Confirm the new password works and the old one does not. Test reused and expired links; Firebase should reject them.
4. Request a reset for an unused address and a Google-only account. Confirm the same generic UI response and no reset email. Confirm Google sign-in still works.
5. Misconfigure the sender in the preview only. Verification should show that delivery failed without claiming account creation failed. Reset should remain generic. Check sanitized server logs and the Resend dashboard for diagnosis, without exposing action links in logs.
6. Test throttling, cross-origin rejection, and unsigned verification requests. Confirm `Cache-Control: no-store` and that the service worker does not cache the API route.

The code PR does not set environment variables, modify DNS, enable TTL, deploy production, or send a real email. Finish the configuration and live checks before merging; otherwise this change intentionally has no fallback delivery route.

Official references: [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email), [Firebase custom email action links](https://firebase.google.com/docs/auth/admin/email-action-links), and [Vercel request headers](https://vercel.com/docs/headers/request-headers).
