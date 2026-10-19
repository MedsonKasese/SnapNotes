import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthEmail,
  createAuthEmailHandler,
  createEmailRateLimiter,
  emailConfiguration
} from "../lib/auth-email.js";

const ENV = {
  RESEND_API_KEY: "re_test_secret",
  RESEND_FROM_EMAIL: "SnapNotes <auth@example.com>",
  SNAPNOTES_APP_URL: "https://snapnotesmw.vercel.app"
};
const APP_ORIGIN = "https://snapnotesmw.vercel.app";
const RESET_GENERIC = "If an eligible account exists, a password reset link will arrive shortly.";

function makeDb() {
  const documents = new Map();
  let tail = Promise.resolve();
  return {
    documents,
    collection(name) {
      return { doc: id => ({ path: `${name}/${id}` }) };
    },
    async runTransaction(callback) {
      let release;
      const previous = tail;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        return await callback({
          get: async ref => {
            const data = documents.get(ref.path);
            return { exists: data !== undefined, data: () => data && structuredClone(data) };
          },
          set: (ref, value) => documents.set(ref.path, structuredClone(value))
        });
      } finally {
        release();
      }
    }
  };
}

function makeUser(overrides = {}) {
  return {
    uid: "user-123",
    email: "person@example.com",
    displayName: "Pat",
    emailVerified: false,
    disabled: false,
    providerData: [{ providerId: "password" }],
    ...overrides
  };
}

function makeServices({ user = makeUser(), usersByEmail, authOverrides = {}, db = makeDb() } = {}) {
  const auth = {
    verifyIdToken: async token => {
      if (token !== "valid-token") throw Object.assign(new Error("invalid token"), { code: "auth/invalid-id-token" });
      return { uid: user.uid };
    },
    getUser: async uid => {
      if (uid !== user.uid) throw new Error("unexpected uid");
      return user;
    },
    getUserByEmail: async email => {
      if (usersByEmail instanceof Map && usersByEmail.has(email)) return usersByEmail.get(email);
      if (usersByEmail && Object.hasOwn(usersByEmail, email)) return usersByEmail[email];
      throw Object.assign(new Error("not found"), { code: "auth/user-not-found" });
    },
    generateEmailVerificationLink: async (email, settings) => `https://firebase.example/verify?email=${encodeURIComponent(email)}&continue=${encodeURIComponent(settings.url)}`,
    generatePasswordResetLink: async (email, settings) => `https://firebase.example/reset?email=${encodeURIComponent(email)}&continue=${encodeURIComponent(settings.url)}`,
    ...authOverrides
  };
  return { auth, db, getServices: async () => ({ auth, db }) };
}

function makeFetch({ ok = true, id = "resend-message-id", error = null } = {}) {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    if (error) throw error;
    return { ok, json: async () => ({ id }) };
  };
  return { fetchImpl, calls };
}

function makeLogger() {
  const calls = [];
  return { calls, error: (...args) => calls.push(args) };
}

async function invoke({ action = "reset-password", email = "person@example.com", body, method = "POST", headers = {}, ...options } = {}) {
  const services = options.services || makeServices(options);
  const { fetchImpl, calls: fetchCalls } = options.fetchHarness || makeFetch(options.fetchOptions);
  const logger = options.logger || makeLogger();
  const handler = createAuthEmailHandler({ getServices: services.getServices, env: options.env || ENV, fetchImpl, logger });
  const req = {
    method,
    headers: {
      origin: APP_ORIGIN,
      "content-type": "application/json",
      "x-vercel-forwarded-for": "203.0.113.1",
      ...(action === "verify-email" ? { authorization: "Bearer valid-token" } : {}),
      ...headers
    },
    body: body ?? (action === "verify-email" ? { action } : { action, email })
  };
  const response = {
    headers: {}, statusCode: undefined, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler(req, response);
  return { response, services, fetchCalls, logger, req };
}

test("email configuration accepts the expected production-shaped settings and normalizes the app URL", () => {
  assert.deepEqual(emailConfiguration(ENV), {
    appUrl: `${APP_ORIGIN}/`, origin: APP_ORIGIN,
    from: ENV.RESEND_FROM_EMAIL, apiKey: ENV.RESEND_API_KEY, globalLimit: 100
  });
  assert.equal(emailConfiguration({ ...ENV, AUTH_EMAIL_HOURLY_LIMIT: "7" }).globalLimit, 7);
});

test("email configuration rejects unsafe origins, sender values, missing credentials, and bad limits", () => {
  for (const SNAPNOTES_APP_URL of ["http://snapnotesmw.vercel.app", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?x=1", "not a url"]) {
    assert.throws(() => emailConfiguration({ ...ENV, SNAPNOTES_APP_URL }));
  }
  for (const patch of [
    { RESEND_API_KEY: "" },
    { RESEND_FROM_EMAIL: "not an address" },
    { RESEND_FROM_EMAIL: "SnapNotes <auth@example.com>\r\nBcc: attacker@example.com" },
    { AUTH_EMAIL_HOURLY_LIMIT: "0" },
    { AUTH_EMAIL_HOURLY_LIMIT: "1.5" }
  ]) assert.throws(() => emailConfiguration({ ...ENV, ...patch }));
});

test("auth email template escapes user-controlled names and links, and only permits HTTPS links", () => {
  const email = buildAuthEmail("verify-email", makeUser({ displayName: `<Pat & \"Friends\">'` }), "https://firebase.example/action?a=1&b=\"x\"");
  assert.deepEqual(email.to, ["person@example.com"]);
  assert.match(email.html, /&lt;Pat &amp; &quot;Friends&quot;&gt;&#39;/);
  assert.match(email.html, /a=1&amp;b=&quot;x&quot;/);
  assert.equal(email.text.includes(`<Pat & \"Friends\">'`), true);
  assert.throws(() => buildAuthEmail("reset-password", makeUser(), "http://firebase.example/action"), /Invalid Firebase action link/);
  assert.match(buildAuthEmail("reset-password", makeUser(), "https://firebase.example/reset").subject, /Reset/);
});

test("eligible password reset generates a Firebase reset link and sends it through Resend with Firebase settings", async () => {
  let generated;
  const services = makeServices({
    usersByEmail: { "person@example.com": makeUser() },
    authOverrides: { generatePasswordResetLink: async (email, settings) => {
      generated = { email, settings };
      return "https://firebase.example/reset?actionCode=private-code";
    } }
  });
  const result = await invoke({ services });
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.response.body, { ok: true, message: RESET_GENERIC });
  assert.deepEqual(generated, { email: "person@example.com", settings: { url: `${APP_ORIGIN}/`, handleCodeInApp: false } });
  const send = result.fetchCalls[0];
  assert.equal(send[0], "https://api.resend.com/emails");
  assert.equal(send[1].method, "POST");
  assert.equal(send[1].headers.Authorization, `Bearer ${ENV.RESEND_API_KEY}`);
  assert.equal(send[1].headers["Content-Type"], "application/json");
  assert.match(send[1].headers["Idempotency-Key"], /^auth-email\//);
  const payload = JSON.parse(send[1].body);
  assert.equal(payload.from, ENV.RESEND_FROM_EMAIL);
  assert.deepEqual(payload.to, ["person@example.com"]);
  assert.match(payload.subject, /Reset/);
  assert.match(payload.text, /https:\/\/firebase\.example\/reset/);
  assert.match(payload.html, /Reset password/);
});

test("verification sends only to the authenticated Firebase user, never a spoofed browser recipient", async () => {
  let generated;
  const services = makeServices({
    user: makeUser({ email: "real-owner@example.com" }),
    authOverrides: { generateEmailVerificationLink: async (email, settings) => {
      generated = { email, settings };
      return "https://firebase.example/verify?actionCode=private-code";
    } }
  });
  const result = await invoke({ action: "verify-email", services, body: { action: "verify-email", email: "victim@example.net", to: "attacker@example.org" } });
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.response.body, { ok: true });
  assert.deepEqual(JSON.parse(result.fetchCalls[0][1].body).to, ["real-owner@example.com"]);
  assert.deepEqual(generated, { email: "real-owner@example.com", settings: { url: `${APP_ORIGIN}/`, handleCodeInApp: false } });
  assert.equal(result.fetchCalls[0][1].body.includes("victim@example.net"), false);
  assert.equal(result.fetchCalls[0][1].body.includes("attacker@example.org"), false);
  assert.match(result.fetchCalls[0][1].body, /firebase\.example\/verify/);
});

test("verification rejects absent and invalid bearer tokens and skips already verified users", async () => {
  const absent = await invoke({ action: "verify-email", headers: { authorization: undefined } });
  assert.equal(absent.response.statusCode, 401);
  const invalid = await invoke({ action: "verify-email", headers: { authorization: "Bearer forged" } });
  assert.equal(invalid.response.statusCode, 401);
  assert.equal(invalid.fetchCalls.length, 0);
  const verified = await invoke({ action: "verify-email", user: makeUser({ emailVerified: true }) });
  assert.equal(verified.response.statusCode, 200);
  assert.deepEqual(verified.response.body, { ok: true });
  assert.equal(verified.fetchCalls.length, 0);
});

test("unknown, disabled, and social-only password reset requests have identical generic responses", async () => {
  const cases = [
    await invoke({ services: makeServices() }),
    await invoke({ services: makeServices({ usersByEmail: { "person@example.com": makeUser({ disabled: true }) } }) }),
    await invoke({ services: makeServices({ usersByEmail: { "person@example.com": makeUser({ providerData: [{ providerId: "google.com" }] }) } }) })
  ];
  for (const { response, fetchCalls } of cases) {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true, message: RESET_GENERIC });
    assert.equal(fetchCalls.length, 0);
  }
  assert.deepEqual(cases.map(item => item.response.body), [cases[0].response.body, cases[0].response.body, cases[0].response.body]);
});

test("verification disallows disabled and social-only identities", async () => {
  for (const user of [makeUser({ disabled: true }), makeUser({ providerData: [{ providerId: "google.com" }] })]) {
    const result = await invoke({ action: "verify-email", user });
    assert.equal(result.response.statusCode, 403);
    assert.equal(result.fetchCalls.length, 0);
  }
});

test("reset provider failures stay generic while verification provider failures return 503", async () => {
  const reset = await invoke({ services: makeServices({ usersByEmail: { "person@example.com": makeUser() } }), fetchOptions: { ok: false } });
  assert.equal(reset.response.statusCode, 200);
  assert.deepEqual(reset.response.body, { ok: true, message: RESET_GENERIC });
  const verify = await invoke({ action: "verify-email", fetchOptions: { error: new Error("private provider detail") } });
  assert.equal(verify.response.statusCode, 503);
  assert.match(verify.response.body.error, /Could not send/);
  for (const result of [reset, verify]) {
    const serializedLogs = JSON.stringify(result.logger.calls);
    for (const sensitive of ["person@example.com", "real-owner@example.com", "firebase.example", "private provider detail", ENV.RESEND_API_KEY]) {
      assert.equal(serializedLogs.includes(sensitive), false, `log leaked ${sensitive}`);
    }
  }
});

test("handler enforces method, exact origin, JSON content type, action, body shape, and trusted IP", async () => {
  const cases = [
    { options: { method: "GET" }, status: 405, header: "POST" },
    { options: { headers: { origin: "https://evil.example" } }, status: 403 },
    { options: { headers: { "content-type": "text/plain" } }, status: 415 },
    { options: { body: [] }, status: 400 },
    { options: { body: { action: "unknown" } }, status: 400 },
    { options: { body: { action: "reset-password", email: "bad" } }, status: 400 },
    { options: { body: { action: "reset-password", email: "a".repeat(255) + "@example.com" } }, status: 400 },
    { options: { headers: { "x-vercel-forwarded-for": undefined, "x-forwarded-for": "203.0.113.1" } }, status: 503 },
    { options: { headers: { "x-vercel-forwarded-for": "not-an-ip", "x-forwarded-for": "203.0.113.1" } }, status: 503 },
    { options: { body: { action: "reset-password", email: "person@example.com", padding: "x".repeat(1100) } }, status: 400 }
  ];
  for (const { options, status, header } of cases) {
    const result = await invoke(options);
    assert.equal(result.response.statusCode, status, JSON.stringify(options));
    if (header) assert.equal(result.response.headers.allow, header);
    assert.equal(result.response.headers["cache-control"], "no-store");
    assert.equal(result.fetchCalls.length, 0);
  }
  const invalidConfig = await invoke({ env: { ...ENV, RESEND_API_KEY: "" } });
  assert.equal(invalidConfig.response.statusCode, 503);
  assert.deepEqual(invalidConfig.response.body, { error: "Email requests are temporarily unavailable." });
});

test("rate limiter persists hashed IP and normalized recipient counters with one-hour thresholds and cooldowns", async () => {
  const db = makeDb();
  let time = 1_000_000;
  const limit = createEmailRateLimiter(db, () => time);
  assert.deepEqual(await limit({ ip: "203.0.113.2", recipient: "Person@example.com", globalLimit: 100 }), { allowed: true });
  assert.deepEqual(await limit({ ip: "203.0.113.2", recipient: "PERSON@example.com", globalLimit: 100 }), { allowed: false, scope: "ip", retryAfter: 10 });
  time += 10_000;
  assert.deepEqual(await limit({ ip: "203.0.113.2", recipient: "PERSON@example.com", globalLimit: 100 }), { allowed: false, scope: "recipient", retryAfter: 50 });
  time += 50_000;
  assert.deepEqual(await limit({ ip: "203.0.113.2", recipient: "PERSON@example.com", globalLimit: 100 }), { allowed: true });
  time += 60_000;
  assert.deepEqual(await limit({ ip: "203.0.113.2", recipient: "person@example.com", globalLimit: 100 }), { allowed: true });
  time += 60_000;
  assert.deepEqual(await limit({ ip: "203.0.113.2", recipient: "person@example.com", globalLimit: 100 }), { allowed: false, scope: "recipient", retryAfter: 3420 });
  assert.equal([...db.documents.keys()].every(key => key.startsWith("authEmailRateLimits/")), true);
  assert.equal([...db.documents.keys()].every(key => !key.includes("203.0.113.2") && !key.includes("person@example.com")), true);
});

test("rate limiter applies per-IP and global thresholds and returns useful Retry-After values", async () => {
  const db = makeDb();
  let time = 2_000_000;
  const limit = createEmailRateLimiter(db, () => time);
  for (let i = 0; i < 10; i++) {
    const result = await limit({ ip: "198.51.100.9", recipient: `person${i}@example.com`, globalLimit: 100 });
    assert.equal(result.allowed, true);
    time += 10_000;
  }
  assert.deepEqual(await limit({ ip: "198.51.100.9", recipient: "fresh@example.com", globalLimit: 100 }), { allowed: false, scope: "ip", retryAfter: 3500 });

  const globalDb = makeDb();
  let globalTime = 3_000_000;
  const globalLimiter = createEmailRateLimiter(globalDb, () => globalTime);
  assert.equal((await globalLimiter({ ip: "192.0.2.1", recipient: "one@example.com", globalLimit: 1 })).allowed, true);
  globalTime += 10_000;
  assert.deepEqual(await globalLimiter({ ip: "192.0.2.1", recipient: "two@example.com", globalLimit: 1 }), { allowed: false, scope: "global", retryAfter: 3590 });
});

test("concurrent rate-limit claims are serialized transactionally", async () => {
  const db = makeDb();
  const limit = createEmailRateLimiter(db, () => 4_000_000);
  const results = await Promise.all(Array.from({ length: 8 }, () => limit({ ip: "203.0.113.45", recipient: "same@example.com", globalLimit: 100 })));
  assert.equal(results.filter(result => result.allowed).length, 1);
  assert.equal(results.filter(result => !result.allowed && result.scope === "ip").length, 7);
});

test("recipient quotas are shared between verification and reset, with generic reset throttling", async () => {
  const db = makeDb();
  const originalNow = Date.now;
  let time = 5_000_000;
  Date.now = () => time;
  const sharedServices = makeServices({ db, user: makeUser({ email: "person@example.com" }), usersByEmail: { "person@example.com": makeUser() } });
  try {
    const responses = [];
    const steps = ["verify-email", "reset-password", "verify-email", "reset-password"];
    for (let i = 0; i < steps.length; i++) {
      const result = await invoke({
        action: steps[i], services: sharedServices,
        headers: { "x-vercel-forwarded-for": `203.0.113.${i + 1}` }
      });
      responses.push(result.response);
      if (i < steps.length - 1) time += 60_000;
    }
    assert.deepEqual(responses.map(response => response.statusCode), [200, 200, 200, 200]);
    assert.deepEqual(responses[3].body, { ok: true, message: RESET_GENERIC });
    assert.equal(responses[3].headers["retry-after"], undefined);
  } finally {
    Date.now = originalNow;
  }
});

test("IP throttling exposes Retry-After for verification and does not reveal reset throttling", async () => {
  const services = makeServices();
  const shared = { ...services, db: services.db };
  // Same IP is claimed by the first call; the next is blocked by its ten-second cooldown.
  const first = await invoke({ action: "verify-email", services: shared });
  assert.equal(first.response.statusCode, 200);
  const second = await invoke({ action: "verify-email", services: shared });
  assert.equal(second.response.statusCode, 429);
  assert.equal(second.response.headers["retry-after"], "10");
  const reset = await invoke({ services: shared });
  assert.equal(reset.response.statusCode, 429);
  assert.equal(reset.response.headers["retry-after"], "10");
});

test("origins sharing a Firebase project have isolated email quotas", async () => {
  const db = makeDb();
  const production = createEmailRateLimiter(db, () => 6_000_000, "https://snapnotesmw.vercel.app");
  const preview = createEmailRateLimiter(db, () => 6_000_000, "https://preview.example.com");
  const claim = { ip: "203.0.113.1", recipient: "same@example.com", globalLimit: 1 };
  assert.equal((await preview(claim)).allowed, true);
  assert.equal((await production(claim)).allowed, true);
  assert.equal(db.documents.size, 6);
  assert.equal((await preview(claim)).allowed, false);
  assert.equal((await production(claim)).allowed, false);
});
