# Ask My Notes setup

Ask My Notes is a server-side Gemini integration. The static frontend stays vanilla HTML/CSS/JavaScript; Vercel runs `api/ai.js` as a Node.js serverless function.

## Vercel environment variables

Set these in each deployment environment where you want AI enabled:

- `GEMINI_API_KEY`: Gemini API key.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the full Firebase service-account JSON object as one environment-variable value. It must belong to the same Firebase project used by the frontend authentication config.

Never place either secret in browser JavaScript, commit them, or share them in issues or chat. Redeploy after changing environment variables.

## Privacy and behaviour

- Users must be signed in. The server verifies the Firebase ID token with Firebase Admin.
- The UI asks for consent before sending note text to Google Gemini.
- The feature is intended to exclude private, archived, and trashed notes. The server also rejects a note explicitly marked `isPrivate: true`.
- Improve results are previewed and are not written into the editor until the user chooses Apply. The user must still save the note.
- Search returns an answer and source excerpts from the eligible notes provided by the browser.
- This is an initial implementation. Client-provided note metadata is not a substitute for server-side database authorization; do not treat the endpoint as a security boundary for arbitrary user-supplied notes. Never submit private content.

Google API quotas and free-tier terms can change. Review the current Gemini API terms and pricing before relying on a free quota.
