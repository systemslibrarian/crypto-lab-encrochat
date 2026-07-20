/**
 * X25519 Diffie–Hellman (RFC 7748), the elliptic-curve key agreement the
 * Double Ratchet uses for its asymmetric ("DH") step. Backed by the audited
 * `@noble/curves`; pinned against the RFC 7748 test vectors in `x25519.test.ts`.
 */
import { x25519 } from "@noble/curves/ed25519";
import { randomBytes } from "./primitives";

export interface KeyPair {
  readonly privateKey: Uint8Array; // 32 bytes
  readonly publicKey: Uint8Array; // 32 bytes
}

/**
 * Generate an X25519 key pair. A seed may be supplied for deterministic tests
 * and the reproducible demo transcript; production code would always let it
 * draw from the CSPRNG.
 */
export function generateKeyPair(seed?: Uint8Array): KeyPair {
  const privateKey = seed ? Uint8Array.from(seed) : randomBytes(32);
  if (privateKey.length !== 32) throw new Error("X25519 private key must be 32 bytes");
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Compute the shared secret X25519(our private key, their public key). */
export function dh(ourKey: KeyPair, theirPublic: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(ourKey.privateKey, theirPublic);
}
