const STORAGE_KEY = "SnapNotesPrivatePasskey";
const PASSKEY_VERSION = 1;
const WRAP_INFO = new TextEncoder().encode("SnapNotes private notes passkey wrapping key v1");

function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
}

function credentialOptions(record, challenge) {
    return {
        challenge,
        rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: base64ToBytes(record.credentialId) }],
        userVerification: "required",
        timeout: 60000,
        extensions: { prf: { eval: { first: base64ToBytes(record.prfSalt) } } }
    };
}

function prfBytesFrom(credential) {
    const result = credential?.getClientExtensionResults?.()?.prf?.results?.first;
    if (!result) throw new Error("This passkey does not support the required secure key operation.");
    return result instanceof ArrayBuffer
        ? new Uint8Array(result)
        : ArrayBuffer.isView(result)
            ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
            : new Uint8Array(result);
}

async function deriveWrappingKey(prfOutput, salt, usages) {
    const material = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: WRAP_INFO },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        usages
    );
}

function requirePasskeySupport() {
    if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential || !navigator.credentials || !crypto?.subtle) {
        throw new Error("Passkeys require a secure browser with platform-authenticator support. You can still use your password.");
    }
}

export function canUsePrivatePasskey() {
    return Boolean(globalThis.isSecureContext && globalThis.PublicKeyCredential && navigator.credentials && crypto?.subtle);
}

export function hasPrivatePasskey(storage = globalThis.localStorage) {
    try {
        const record = JSON.parse(storage?.getItem(STORAGE_KEY) || "null");
        return record?.version === PASSKEY_VERSION && typeof record.credentialId === "string" &&
            typeof record.prfSalt === "string" && typeof record.iv === "string" && typeof record.wrappedKey === "string";
    } catch {
        return false;
    }
}

export function removePrivatePasskey(storage = globalThis.localStorage) {
    storage?.removeItem(STORAGE_KEY);
}

export async function registerPrivatePasskey(privateKey, storage = globalThis.localStorage) {
    requirePasskeySupport();
    if (!privateKey?.extractable) throw new Error("The private-note key cannot be protected by this passkey. Unlock with your password and try again.");

    const challenge = randomBytes(32);
    const userId = randomBytes(32);
    const credential = await navigator.credentials.create({
        publicKey: {
            challenge,
            rp: { id: location.hostname, name: "SnapNotes" },
            user: { id: userId, name: "private-notes", displayName: "SnapNotes Private Notes" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
            authenticatorSelection: {
                authenticatorAttachment: "platform",
                residentKey: "preferred",
                userVerification: "required"
            },
            attestation: "none",
            timeout: 60000,
            extensions: { prf: {} }
        }
    });
    if (!credential?.rawId) throw new Error("The browser did not create a passkey.");
    if (credential.getClientExtensionResults?.()?.prf?.enabled !== true) {
        throw new Error("This device's passkey does not support secure private-note unlocking. Your password remains available.");
    }

    const prfSalt = randomBytes(32);
    const assertion = await navigator.credentials.get({
        publicKey: credentialOptions({ credentialId: bytesToBase64(new Uint8Array(credential.rawId)), prfSalt: bytesToBase64(prfSalt) }, randomBytes(32))
    });
    const prfOutput = prfBytesFrom(assertion);
    const wrappingKey = await deriveWrappingKey(prfOutput, prfSalt, ["wrapKey", "unwrapKey"]);
    const iv = randomBytes(12);
    const wrappedKey = await crypto.subtle.wrapKey("raw", privateKey, wrappingKey, { name: "AES-GCM", iv });

    const record = {
        version: PASSKEY_VERSION,
        credentialId: bytesToBase64(new Uint8Array(credential.rawId)),
        prfSalt: bytesToBase64(prfSalt),
        iv: bytesToBase64(iv),
        wrappedKey: bytesToBase64(new Uint8Array(wrappedKey))
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
    prfOutput.fill(0);
    return true;
}

export async function unlockPrivateKeyWithPasskey(storage = globalThis.localStorage) {
    requirePasskeySupport();
    let record;
    try {
        record = JSON.parse(storage?.getItem(STORAGE_KEY) || "null");
    } catch {
        record = null;
    }
    if (!record || record.version !== PASSKEY_VERSION || !record.credentialId || !record.prfSalt || !record.iv || !record.wrappedKey) {
        throw new Error("No passkey is set up on this device.");
    }

    const assertion = await navigator.credentials.get({
        publicKey: credentialOptions(record, randomBytes(32))
    });
    const prfOutput = prfBytesFrom(assertion);
    const salt = base64ToBytes(record.prfSalt);
    const wrappingKey = await deriveWrappingKey(prfOutput, salt, ["wrapKey", "unwrapKey"]);
    try {
        const key = await crypto.subtle.unwrapKey(
            "raw",
            base64ToBytes(record.wrappedKey),
            wrappingKey,
            { name: "AES-GCM", iv: base64ToBytes(record.iv) },
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );
        prfOutput.fill(0);
        return key;
    } catch (error) {
        prfOutput.fill(0);
        throw new Error("This passkey could not unlock the private notes on this device.", { cause: error });
    }
}
