import { describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
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
