const EMAIL_ACTION_ENDPOINT = "/api/auth/email";
const RESET_SUCCESS_MESSAGE = "If an eligible account exists, a password reset link will arrive shortly.";
const GENERIC_ERROR_MESSAGE = "Email request failed. Please try again.";

async function postEmailAction(payload, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
        response = await fetch(EMAIL_ACTION_ENDPOINT, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        });
    } catch {
        throw new Error("Network error. Check your connection and try again.");
    }

    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok !== true) {
        const message = typeof result?.error === "string" && result.error.trim()
            ? result.error.trim()
            : GENERIC_ERROR_MESSAGE;
        const error = new Error(message);
        error.status = response.status;
        if (response.status === 429) error.retryAfter = response.headers?.get?.("Retry-After") || null;
        throw error;
    }
    return result;
}

export async function requestVerificationEmail(user) {
    if (!user || typeof user.getIdToken !== "function") {
        throw new Error("Sign in to request a verification email.");
    }
    let token;
    try {
        token = await user.getIdToken();
    } catch {
        throw new Error("Could not authenticate the verification email request. Please try again.");
    }
    if (typeof token !== "string" || !token.trim()) {
        throw new Error("Could not authenticate the verification email request. Please try again.");
    }
    return postEmailAction({ action: "verify-email" }, token);
}

export function requestPasswordResetEmail(email) {
    const address = typeof email === "string" ? email.trim() : "";
    if (!address) throw new Error("Enter your email address first.");
    return postEmailAction({ action: "reset-password", email: address });
}

export { RESET_SUCCESS_MESSAGE };
