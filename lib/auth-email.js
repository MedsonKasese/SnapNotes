import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

const HOUR = 60 * 60 * 1000;
const GENERIC_RESET = "If an eligible account exists, a password reset link will arrive shortly.";
const emailPattern = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

function httpError(status, message, retryAfter) {
  return Object.assign(new Error(message), { status, retryAfter });
}

export function emailConfiguration(env) {
  const app = new URL(env.SNAPNOTES_APP_URL || "invalid:");
  if (app.protocol !== "https:" || app.username || app.password || app.search || app.hash || app.pathname !== "/") {
    throw new Error("Invalid email application URL configuration.");
  }
  const from = env.RESEND_FROM_EMAIL || "";
  const address = from.match(/<([^<>]+)>$/)?.[1] || from;
  if (!env.RESEND_API_KEY || /[\r\n]/.test(from) || !emailPattern.test(address)) {
    throw new Error("Missing email delivery configuration.");
  }
  const globalLimit = Number(env.AUTH_EMAIL_HOURLY_LIMIT || 100);
  if (!Number.isSafeInteger(globalLimit) || globalLimit < 1) throw new Error("Invalid email rate configuration.");
  return { appUrl: app.origin + "/", origin: app.origin, from, apiKey: env.RESEND_API_KEY, globalLimit };
}

export function buildAuthEmail(action, user, link) {
  const verify = action === "verify-email";
  const title = verify ? "Verify your SnapNotes email" : "Reset your SnapNotes password";
  const instruction = verify
    ? "Confirm your email address to finish setting up your SnapNotes account."
    : "A password reset was requested for your SnapNotes account. Use the link below to choose a new password.";
  // Firebase generates this URL. Never accept a link or recipient from the browser.
  const url = new URL(link);
  if (url.protocol !== "https:") throw new Error("Invalid Firebase action link.");
  const greeting = user.displayName ? `Hello ${String(user.displayName).slice(0, 100)},` : "Hello,";
  const ignore = verify
    ? "If you did not create this account, you can ignore this email."
    : "If you did not request this, ignore this email. Your password will not change unless you complete the reset.";
  return {
    to: [user.email],
    subject: title,
    text: `${greeting}\n\n${instruction}\n\n${link}\n\n${ignore}\n\nSnapNotes — Save Your Mind.`,
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#17212b;max-width:560px;margin:32px auto;padding:24px"><h1>SnapNotes</h1><h2>${title}</h2><p>${escapeHtml(greeting)}</p><p>${instruction}</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:#315be8;color:white;padding:12px 20px;border-radius:8px">${verify ? "Verify email" : "Reset password"}</a></p><p>If the button does not work, copy this link into your browser:</p><p style="word-break:break-all">${escapeHtml(link)}</p><p>${ignore}</p><hr><p>SnapNotes — Save Your Mind.</p></body></html>`
  };
}

// All counters are claimed in one transaction, across warm/cold serverless instances.
// One document per subject; reset its rolling window in-place (no unbounded history).
export function createEmailRateLimiter(db, now = Date.now, namespace = "default") {
  const prefix = hash(namespace);
  return async ({ ip, recipient, globalLimit }) => {
    const time = now();
    const limits = [
      { key: `ip-${hash(ip)}`, max: 10, cooldown: 10_000, scope: "ip" },
      { key: `recipient-${hash(recipient.toLowerCase())}`, max: 3, cooldown: 60_000, scope: "recipient" },
      { key: "global", max: globalLimit, cooldown: 0, scope: "global" }
    ];
    return db.runTransaction(async transaction => {
      const refs = limits.map(limit => db.collection("authEmailRateLimits").doc(`${prefix}-${limit.key}`));
      const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
      const counters = snapshots.map(snapshot => snapshot.exists ? snapshot.data() : {});
      for (let index = 0; index < limits.length; index++) {
        const { max, cooldown, scope } = limits[index];
        const counter = counters[index];
        const active = Number.isFinite(counter.startedAt) && time - counter.startedAt < HOUR;
        const remaining = active && counter.count >= max ? counter.startedAt + HOUR - time : 0;
        const wait = Math.max(remaining, (counter.lastAt ?? -Infinity) + cooldown - time);
        if (wait > 0) return { allowed: false, scope, retryAfter: Math.max(1, Math.ceil(wait / 1000)) };
      }
      refs.forEach((ref, index) => {
        const counter = counters[index];
        const active = Number.isFinite(counter.startedAt) && time - counter.startedAt < HOUR;
        transaction.set(ref, {
          startedAt: active ? counter.startedAt : time,
          count: (active ? counter.count : 0) + 1,
          lastAt: time,
          // Optional Firestore TTL policy may remove inactive hashed counters.
          expiresAt: new Date(time + 2 * HOUR)
        });
      });
      return { allowed: true };
    });
  };
}

export function createAuthEmailHandler({ getServices, env = process.env, fetchImpl = fetch, logger = console }) {
  return async function handler(req, res) {
    const send = (status, body) => res.status(status).json(body);
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(405, { error: "Method not allowed." });
    }
    let action;
    try {
      const config = emailConfiguration(env);
      if (req.headers.origin !== config.origin) throw httpError(403, "This email request is not allowed.");
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
        throw httpError(415, "Send a JSON email request.");
      }
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || JSON.stringify(body).length > 1024) {
        throw httpError(400, "Invalid email request.");
      }
      action = body.action;
      if (!["verify-email", "reset-password"].includes(action)) throw httpError(400, "Invalid email action.");
      // Vercel overwrites this header with the connecting client's IP. Never trust
      // x-forwarded-for, a body field, or a client-chosen IP for these quotas.
      const ip = req.headers["x-vercel-forwarded-for"];
      if (typeof ip !== "string" || !isIP(ip)) throw httpError(503, "Email requests are temporarily unavailable.");
      const { auth, db } = await getServices();
      let user;
      let recipient;
      if (action === "verify-email") {
        const token = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
        if (!token) throw httpError(401, "Sign in to request a verification email.");
        try {
          const identity = await auth.verifyIdToken(token, true);
          user = await auth.getUser(identity.uid);
        } catch {
          throw httpError(401, "Your sign-in session expired. Sign in and retry.");
        }
        if (user.disabled || !user.email || !user.providerData?.some(provider => provider.providerId === "password")) {
          throw httpError(403, "This account cannot request a verification email.");
        }
        if (user.emailVerified) return send(200, { ok: true });
        recipient = user.email;
      } else {
        recipient = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (recipient.length > 254 || !emailPattern.test(recipient)) throw httpError(400, "Enter a valid email address.");
      }
      const allowance = await createEmailRateLimiter(db, Date.now, config.origin)({ ip, recipient, globalLimit: config.globalLimit });
      if (!allowance.allowed) {
        if (action === "reset-password" && allowance.scope === "recipient") {
          return send(200, { ok: true, message: GENERIC_RESET });
        }
        throw httpError(429, "Please wait before requesting another email.", allowance.retryAfter);
      }
      // After quotas, reset responses are deliberately identical, including provider
      // outages, so neither existence nor account provider is exposed in a response.
      try {
        if (action === "reset-password") {
          try { user = await auth.getUserByEmail(recipient); }
          catch (error) { if (error.code !== "auth/user-not-found") throw error; }
          if (!user || user.disabled || !user.providerData?.some(provider => provider.providerId === "password")) {
            return send(200, { ok: true, message: GENERIC_RESET });
          }
        }
        const settings = { url: config.appUrl, handleCodeInApp: false };
        const link = action === "verify-email"
          ? await auth.generateEmailVerificationLink(user.email, settings)
          : await auth.generatePasswordResetLink(user.email, settings);
        const email = buildAuthEmail(action, user, link);
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `auth-email/${randomUUID()}`
          },
          body: JSON.stringify({ from: config.from, ...email }),
          signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) throw new Error("Email provider rejected request.");
        const result = await response.json();
        if (typeof result.id !== "string" || !result.id) throw new Error("Email provider response was invalid.");
      } catch {
        // Do not log Firebase links/codes, API keys, email addresses or provider bodies.
        logger.error("Authentication email delivery failed.", { action });
        if (action === "verify-email") throw httpError(503, "Could not send the verification email. Please wait a minute and retry.");
      }
      return send(200, action === "reset-password" ? { ok: true, message: GENERIC_RESET } : { ok: true });
    } catch (error) {
      if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
      if (!error.status) logger.error("Authentication email service unavailable.");
      return send(error.status || 503, { error: error.status ? error.message : "Email requests are temporarily unavailable." });
    }
  };
}
