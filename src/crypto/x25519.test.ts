import { describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { fromHex, toHex } from "./primitives";
import { dh, generateKeyPair } from "./x25519";

/**
 * RFC 7748 §5.2 known-answer tests for X25519, plus the wrapper's DH agreement.
 */
describe("X25519 KAT (RFC 7748 §5.2)", () => {
  it("first test vector", () => {
    const k = fromHex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4");
    const u = fromHex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c");
    const out = x25519.getSharedSecret(k, u);
    expect(toHex(out)).toBe(
      "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
    );
  });

  it("second test vector", () => {
    const k = fromHex("4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d");
    const u = fromHex("e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493");
    const out = x25519.getSharedSecret(k, u);
    expect(toHex(out)).toBe(
      "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957",
    );
  });
});

describe("X25519 DH agreement", () => {
  it("derives the published Alice/Bob keys and shared secret through the wrappers (RFC 7748 §6.1)", () => {
    const aliceSeed = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
    const bobSeed = fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
    const before = [toHex(aliceSeed), toHex(bobSeed)];
    const alice = generateKeyPair(aliceSeed);
    const bob = generateKeyPair(bobSeed);
    expect(toHex(alice.publicKey)).toBe("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    expect(toHex(bob.publicKey)).toBe("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    const shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
    expect(toHex(dh(alice, bob.publicKey))).toBe(shared);
    expect(toHex(dh(bob, alice.publicKey))).toBe(shared);
    expect([toHex(aliceSeed), toHex(bobSeed)]).toEqual(before);
    expect([toHex(alice.privateKey), toHex(bob.privateKey)]).toEqual(before);
  });

  it("rejects malformed secret and peer key lengths", () => {
    const alice = generateKeyPair(new Uint8Array(32).fill(3));
    for (const length of [0, 31, 33]) {
      expect(() => generateKeyPair(new Uint8Array(length))).toThrow();
      expect(() => dh(alice, new Uint8Array(length))).toThrow();
    }
  });

  it("retains low-order peer rejection without damaging a subsequent valid agreement", () => {
    const alice = generateKeyPair(fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"));
    const before = [toHex(alice.privateKey), toHex(alice.publicKey)];
    // RFC 7748 §6.1 permits rejecting the all-zero shared secret. Noble
    // rejects low-order peers; do not turn that failure into ratchet key data.
    for (const u of [0, 1]) {
      const lowOrder = new Uint8Array(32);
      lowOrder[0] = u;
      expect(() => dh(alice, lowOrder)).toThrow();
    }
    const bobPublic = fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    expect(toHex(dh(alice, bobPublic))).toBe("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
    expect([toHex(alice.privateKey), toHex(alice.publicKey)]).toEqual(before);
  });

  it("both parties derive the same shared secret", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(toHex(dh(a, b.publicKey))).toBe(toHex(dh(b, a.publicKey)));
  });

  it("is deterministic from a seed", () => {
    const seed = new Uint8Array(32).fill(3);
    expect(toHex(generateKeyPair(seed).publicKey)).toBe(
      toHex(generateKeyPair(seed).publicKey),
    );
  });
});
