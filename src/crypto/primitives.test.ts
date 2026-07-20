import { describe, expect, it } from "vitest";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  bytesEqual,
  concat,
  fromHex,
  hkdfSha256,
  hmacSha256,
  toHex,
  utf8,
} from "./primitives";

/**
 * Known-answer tests against the published spec vectors. These are what make
 * "real crypto only" checkable rather than a claim.
 */

describe("HMAC-SHA256 KAT (RFC 4231)", () => {
  // RFC 4231 §4.2, Test Case 1.
  it("test case 1", async () => {
    const key = new Uint8Array(20).fill(0x0b);
    const data = utf8("Hi There");
    const mac = await hmacSha256(key, data);
    expect(toHex(mac)).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  // RFC 4231 §4.3, Test Case 2 ("Jefe" / "what do ya want for nothing?").
  it("test case 2", async () => {
    const mac = await hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?"));
    expect(toHex(mac)).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("HKDF-SHA256 KAT (RFC 5869)", () => {
  // RFC 5869 Appendix A.1, Test Case 1.
  it("test case 1 (with salt + info)", async () => {
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = fromHex("000102030405060708090a0b0c");
    const info = fromHex("f0f1f2f3f4f5f6f7f8f9");
    const okm = await hkdfSha256(ikm, salt, info, 42);
    expect(toHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  // RFC 5869 Appendix A.3, Test Case 3 (zero-length salt and info).
  it("test case 3 (empty salt + info)", async () => {
    const ikm = new Uint8Array(22).fill(0x0b);
    const okm = await hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), 42);
    expect(toHex(okm)).toBe(
      "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
    );
  });
});

describe("AES-256-GCM KAT (NIST CAVP gcmEncryptExtIV256)", () => {
  // NIST GCM test vector: 256-bit key, 96-bit IV, empty PT/AAD.
  it("empty plaintext / empty AAD produces the published tag", async () => {
    const key = fromHex("0000000000000000000000000000000000000000000000000000000000000000");
    const iv = fromHex("000000000000000000000000");
    const ct = await aesGcmEncrypt(key, iv, new Uint8Array(0), new Uint8Array(0));
    // ciphertext is empty; output is the 16-byte tag only.
    expect(toHex(ct)).toBe("530f8afbc74536b9a963b4f1c4cb738b");
  });

  it("round-trips and authenticates AAD", async () => {
    const key = new Uint8Array(32).fill(7);
    const iv = new Uint8Array(12).fill(9);
    const pt = utf8("burner phones, real crypto");
    const aad = utf8("header");
    const ct = await aesGcmEncrypt(key, iv, pt, aad);
    const back = await aesGcmDecrypt(key, iv, ct, aad);
    expect(bytesEqual(back, pt)).toBe(true);
  });

  it("rejects a tampered ciphertext (fail-closed)", async () => {
    const key = new Uint8Array(32).fill(7);
    const iv = new Uint8Array(12).fill(9);
    const ct = await aesGcmEncrypt(key, iv, utf8("intact"), utf8("header"));
    const forged = new Uint8Array(ct);
    forged[0] ^= 0x01;
    await expect(aesGcmDecrypt(key, iv, forged, utf8("header"))).rejects.toThrow();
  });

  it("rejects a tampered AAD (header binding)", async () => {
    const key = new Uint8Array(32).fill(7);
    const iv = new Uint8Array(12).fill(9);
    const ct = await aesGcmEncrypt(key, iv, utf8("intact"), utf8("header"));
    await expect(aesGcmDecrypt(key, iv, ct, utf8("HEADER"))).rejects.toThrow();
  });
});

describe("byte helpers", () => {
  it("hex round-trips", () => {
    const b = new Uint8Array([0, 1, 254, 255]);
    expect(toHex(b)).toBe("0001feff");
    expect(bytesEqual(fromHex("0001feff"), b)).toBe(true);
  });

  it("concat joins in order", () => {
    expect(toHex(concat(fromHex("aabb"), fromHex("cc")))).toBe("aabbcc");
  });
});
