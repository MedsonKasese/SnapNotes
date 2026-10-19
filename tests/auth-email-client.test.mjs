import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  requestPasswordResetEmail,
  requestVerificationEmail,
  RESET_SUCCESS_MESSAGE
} from "../js/auth-email.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("verification email request sends an authenticated action without a client recipient", async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const result = await requestVerificationEmail({
    email: "person@example.test",
    getIdToken: async () => "firebase-id-token"
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(request.url, "/api/auth/email");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer firebase-id-token");
  assert.deepEqual(JSON.parse(request.options.body), { action: "verify-email" });
});

test("password reset request sends the supplied email with no bearer credential", async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const result = await requestPasswordResetEmail(" person@example.test ");

  assert.deepEqual(result, { ok: true });
  assert.equal(request.url, "/api/auth/email");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(request.options.body), {
    action: "reset-password",
    email: "person@example.test"
  });
  assert.equal(RESET_SUCCESS_MESSAGE, "If an eligible account exists, a password reset link will arrive shortly.");
});

test("backend safe error text and Retry-After are surfaced on throttling", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Please wait before trying again." }), {
    status: 429,
    headers: { "Retry-After": "30" }
  });

  await assert.rejects(requestPasswordResetEmail("person@example.test"), error => {
    assert.equal(error.message, "Please wait before trying again.");
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, "30");
    return true;
  });
});

test("network failures return a safe user-facing error", async () => {
  globalThis.fetch = async () => { throw new TypeError("private transport details"); };

  await assert.rejects(requestPasswordResetEmail("person@example.test"), error => {
    assert.equal(error.message, "Network error. Check your connection and try again.");
    assert.equal(error.message.includes("private transport details"), false);
    return true;
  });
});

test("auth UI delegates email sending to the hosted action endpoint without misleading sent claims", async () => {
  const source = await readFile(new URL("../js/auth.js", import.meta.url), "utf8");
  assert.match(source, /requestVerificationEmail\(credential\.user\)/);
  assert.match(source, /requestVerificationEmail\(user\)/);
  assert.match(source, /requestPasswordResetEmail\(email\)/);
  assert.match(source, /requestPasswordResetEmail\(user\.email\)/);
  assert.doesNotMatch(source, /sendEmailVerification|sendPasswordResetEmail/);
  assert.match(source, /To verify your account, request a verification email below/);
  assert.doesNotMatch(source, /A verification link was sent to/);
  assert.match(source, /Your account was created, but the verification email was not sent\. Use Resend verification email to try again\./);
  assert.match(source, /If an eligible account exists, a password reset link will arrive shortly\./);
  assert.match(source, /if \(signupBusy\) return/);
  assert.match(source, /signupBusy = false;\s+signupBtn\.disabled = false;/);
  assert.match(source, /resendVerificationBtn\.disabled = true;/);
  assert.match(source, /finally \{\s+resendVerificationBtn\.disabled = false;/);
});
