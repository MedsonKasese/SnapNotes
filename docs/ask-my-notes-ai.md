# Ask My Notes setup

Ask My Notes is a server-side Gemini integration. The static frontend stays vanilla HTML/CSS/JavaScript; Vercel runs `api/ai.js` as a Node.js serverless function.

## Vercel environment variables

Set these in each deployment environment where you want AI enabled:

- `GEMINI_API_KEY`: Gemini API key.
- `GEMINI_MODEL` (optional): model ID available to your Gemini API key. Defaults to `gemini-3.5-flash-lite`; if Google changes model availability, set this to a currently supported model and redeploy.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the full Firebase service-account JSON object as one environment-variable value. It must belong to the same Firebase project used by the frontend authentication config.

Never place either secret in browser JavaScript, commit them, or share them in issues or chat. Redeploy after changing environment variables.

## Privacy and behaviour

- Users must be signed in. The server verifies the Firebase ID token with Firebase Admin.
- The UI asks for consent before sending note text to Google Gemini.
- The feature is intended to exclude private, archived, and trashed notes. The server also rejects a note explicitly marked `isPrivate: true`.
- Improve results are previewed and are not written into the editor until the user chooses Apply. The user must still save the note.
- When applying an improvement, the first Markdown heading is normalised to SnapNotes' `## Title` convention so a Gemini `# Title` response is saved as a titled note instead of `Untitled`. Other headings in the note body are preserved.
- Search returns an answer and source excerpts from the eligible notes provided by the browser.
- This is an initial implementation. Client-provided note metadata is not a substitute for server-side database authorization; do not treat the endpoint as a security boundary for arbitrary user-supplied notes. Never submit private content.

If the endpoint returns a model-unavailable error, check the Vercel function logs for Google's provider message and confirm the model is available to the configured API key. You can change `GEMINI_MODEL` in Vercel without editing application code, then redeploy.

Google API quotas, model availability, and free-tier terms can change. Review the current Gemini API model list, terms, and pricing before relying on a particular model or free quota.
