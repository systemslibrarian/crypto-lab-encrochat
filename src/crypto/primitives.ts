/**
 * Low-level cryptographic primitives — thin, honest wrappers over the platform.
 *
 * Everything here is REAL crypto: HMAC-SHA256, HKDF-SHA256 and AES-256-GCM come
 * straight from the platform WebCrypto (`crypto.subtle`), which is the same
 * audited implementation the browser ships and Node exposes. X25519 comes from
 * the audited `@noble/curves`. Nothing is simulated. The known-answer tests in
 * `primitives.test.ts` and `x25519.test.ts` pin these against the RFC vectors.
 */

/**
 * WebCrypto wants a standalone `ArrayBuffer`. A `Uint8Array` can be a view into
 * a larger (or shared) buffer, so we copy into a fresh one to hand over a clean,
 * exactly-sized `ArrayBuffer`. Correctness over a micro-optimisation.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Cryptographically-secure random bytes from the platform CSPRNG. */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Constant-time-ish equality (length-independent short-circuit avoided). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, toBuffer(data));
  return new Uint8Array(sig);
}

/**
 * HKDF-SHA256 (RFC 5869): extract-then-expand. Returns `length` bytes of
 * output keying material.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toBuffer(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toBuffer(salt), info: toBuffer(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * AES-256-GCM AEAD encryption. Returns `ciphertext || 16-byte tag`. The tag
 * binds `aad` (the message header) so any tampering — including a network
 * adversary flipping a byte — makes decryption throw.
 */
export async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", toBuffer(key), "AES-GCM", false, [
    "encrypt",
  ]);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBuffer(iv), additionalData: toBuffer(aad), tagLength: 128 },
    cryptoKey,
    toBuffer(plaintext),
  );
  return new Uint8Array(ct);
}

/**
 * AES-256-GCM AEAD decryption. Throws if the tag does not verify (wrong key,
 * tampered ciphertext, or tampered header) — i.e. it is fail-closed.
 */
export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", toBuffer(key), "AES-GCM", false, [
    "decrypt",
  ]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBuffer(iv), additionalData: toBuffer(aad), tagLength: 128 },
    cryptoKey,
    toBuffer(ciphertext),
  );
  return new Uint8Array(pt);
}
