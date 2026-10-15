function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function encryptPrivateAttachment(blob, key, cryptoProvider = globalThis.crypto) {
  if (!blob?.arrayBuffer || !key || !cryptoProvider?.subtle) {
    throw new Error("Private attachment encryption is unavailable.");
  }
  const iv = cryptoProvider.getRandomValues(new Uint8Array(12));
  const ciphertext = await cryptoProvider.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    await blob.arrayBuffer()
  );
  return {
    blob: new Blob([ciphertext], { type: blob.type || "application/octet-stream" }),
    iv: bytesToBase64(iv)
  };
}

export async function decryptPrivateAttachment(blob, key, iv, type = "application/octet-stream", cryptoProvider = globalThis.crypto) {
  if (!blob?.arrayBuffer || !key || !iv || !cryptoProvider?.subtle) {
    throw new Error("Private attachment is locked or incomplete.");
  }
  const plaintext = await cryptoProvider.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    await blob.arrayBuffer()
  );
  return new Blob([plaintext], { type: String(type || "application/octet-stream") });
}
