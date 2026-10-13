# Configure Cloudflare R2 for SnapNotes

This first version moves note attachments and email-account profile photo uploads to a private Cloudflare R2 bucket. Firebase Authentication remains the identity provider; Firestore continues to store note metadata. The browser never receives the R2 account access key or secret.

## 1. Create a private bucket and scoped token

1. In Cloudflare, open **R2 Object Storage** and create a bucket for SnapNotes. Keep the bucket private; do not enable public bucket access.
2. Create an R2 API token with object read/write access restricted to this bucket only. Copy the Access Key ID and Secret Access Key immediately and keep them private.
3. Note your Cloudflare Account ID and the exact bucket name.
4. In the bucket's CORS settings, add a rule similar to the following. Replace the origins with the exact production domain and any preview/local origins you actually use.

```json
[
  {
    "AllowedOrigins": [
      "https://snapnotesmw.vercel.app",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": [
      "Content-Type",
      "x-amz-meta-owner",
      "x-amz-meta-purpose"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

If you use Vercel Preview deployments, add the exact preview origins you test from. Do not use a broad wildcard origin unless you have a deliberate reason.

## 2. Configure Vercel environment variables

Add these variables in **Vercel → SnapNotes project → Settings → Environment Variables**. Enable them for Production, Preview, and Development as appropriate, then redeploy.

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_BUCKET_NAME` | Exact private R2 bucket name |
| `R2_ACCESS_KEY_ID` | Access Key ID for the bucket-scoped token |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key for that token |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Firebase Admin service-account JSON used by the server-side AI endpoint |

The Firebase Admin credential is already used by the server-side AI endpoint; do not create a second service account just for R2 unless you have a separate operational reason. Keep all secrets server-side. Never add these values to client JavaScript, HTML, GitHub commits, or variables prefixed with `NEXT_PUBLIC_` or `VITE_`.

## 3. How the integration works

- The client requests an upload URL with its Firebase ID token.
- The API verifies the token and restricts the object key to that user's attachment or avatar namespace.
- The browser uploads directly to R2 using a short-lived, single-object presigned URL.
- The completion endpoint checks the real stored size, MIME type, and signed object metadata before the app marks the file as synced.
- Attachments stay in IndexedDB as the local-first copy. Firestore stores object keys and metadata, not long-lived signed download URLs.
- Attachment downloads receive a short-lived signed URL after authentication and ownership checks.
- Profile photo URLs go through a narrow avatar endpoint. Profile pictures are intentionally viewable anywhere the user's profile is displayed; the R2 bucket itself remains private.

Presigned URLs are bearer tokens. Treat them as sensitive and keep their expiry short.

## 4. Important limitations and migration notes

- This integration enables new uploads to R2; it does not automatically recover old Firebase Storage objects that are no longer readable on the Spark plan.
- Existing legacy attachment metadata is retained for backwards compatibility. Old Firebase Storage URLs may still fail until those files can be recovered or re-uploaded.
- The current note editor limit remains 10 MB per attachment and five attachments per note. Profile photos remain limited to 2 MB.
- Cloud storage quota or provider errors should leave local attachment bytes in IndexedDB so the user can retry.
- The first version does not automatically migrate bytes from Firebase Storage. Test a new attachment and profile photo in a Vercel Preview deployment before merging, and inspect API logs without logging file contents or credentials.
