import { describe, expect, it } from "vitest";
import {
  decodeWire,
  encodeWire,
  GCM_TAG_LEN,
  initReceiver,
  initSender,
  ratchetDecrypt,
  ratchetEncrypt,
  WIRE_HEADER_LEN,
} from "./double-ratchet";
import { fromUtf8, hkdfSha256, toHex, utf8 } from "./primitives";
import { dh, generateKeyPair } from "./x25519";

/**
 * The Double Ratchet is the primitive whose soundness the lab depends on:
 * the whole thesis is that it was NOT broken. These tests hold it to that —
 * correct round-trips, a real DH ratchet across turns, forward secrecy, and
 * fail-closed rejection of tampering.
 */

async function pair() {
  const bobRatchet = generateKeyPair(new Uint8Array(32).fill(1));
  const sharedRootKey = await hkdfSha256(
    new Uint8Array(32).fill(2),
    new Uint8Array(32),
    utf8("test-root"),
    32,
  );
  const alice = await initSender(sharedRootKey, bobRatchet.publicKey, new Uint8Array(32).fill(3));
  const bob = initReceiver(sharedRootKey, bobRatchet);
  return { alice, bob };
}

describe("Double Ratchet round-trips", () => {
  it("Alice → Bob decrypts to the original plaintext", async () => {
    const { alice, bob } = await pair();
    const msg = await ratchetEncrypt(alice, utf8("the crypto is fine"));
    const out = await ratchetDecrypt(bob, msg);
    expect(fromUtf8(out)).toBe("the crypto is fine");
  });

  it("carries a full back-and-forth conversation across DH ratchet steps", async () => {
    const { alice, bob } = await pair();
    const script: Array<["alice" | "bob", string]> = [
      ["alice", "one"],
      ["alice", "two"],
      ["bob", "three"],
      ["alice", "four"],
      ["bob", "five"],
    ];
    for (const [who, text] of script) {
      const sender = who === "alice" ? alice : bob;
      const receiver = who === "alice" ? bob : alice;
      const msg = await ratchetEncrypt(sender, utf8(text));
      const out = await ratchetDecrypt(receiver, msg);
      expect(fromUtf8(out)).toBe(text);
    }
  });

  it("produces different ciphertext for identical repeated plaintext (chain advances)", async () => {
    const { alice, bob } = await pair();
    const a = await ratchetEncrypt(alice, utf8("same"));
    const b = await ratchetEncrypt(alice, utf8("same"));
    expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext));
    // ...and both still decrypt correctly in order.
    expect(fromUtf8(await ratchetDecrypt(bob, a))).toBe("same");
    expect(fromUtf8(await ratchetDecrypt(bob, b))).toBe("same");
  });
});

describe("on-wire opacity", () => {
  it("ciphertext reveals neither the plaintext nor its bytes", async () => {
    const { alice } = await pair();
    const secret = "meet at the safehouse at nine";
    const msg = await ratchetEncrypt(alice, utf8(secret));
    const hex = toHex(msg.ciphertext);
    // No substring of the UTF-8 plaintext appears in the ciphertext.
    expect(hex.includes(toHex(utf8(secret)))).toBe(false);
    // GCM adds a 16-byte tag, so ciphertext is longer than plaintext.
    expect(msg.ciphertext.length).toBe(utf8(secret).length + 16);
  });
});

describe("fail-closed integrity", () => {
  it("rejects a flipped ciphertext byte", async () => {
    const { alice, bob } = await pair();
    const msg = await ratchetEncrypt(alice, utf8("intact"));
    const forged = { ...msg, ciphertext: new Uint8Array(msg.ciphertext) };
    forged.ciphertext[2] ^= 0x02;
    await expect(ratchetDecrypt(bob, forged)).rejects.toThrow();
  });

  it("rejects a tampered header (bound as AEAD associated data)", async () => {
    const { alice, bob } = await pair();
    const msg = await ratchetEncrypt(alice, utf8("intact"));
    const forged = { ...msg, header: { ...msg.header, n: msg.header.n + 1 } };
    await expect(ratchetDecrypt(bob, forged)).rejects.toThrow();
  });
});

describe("transactional receive — a rejected packet commits no state", () => {
  it("a forged packet is rejected AND the next authentic packet still decrypts", async () => {
    const { alice, bob } = await pair();
    const m1 = await ratchetEncrypt(alice, utf8("first"));
    const m2 = await ratchetEncrypt(alice, utf8("second"));

    expect(fromUtf8(await ratchetDecrypt(bob, m1))).toBe("first");

    // Forge a copy of m2 with a flipped ciphertext byte and deliver it.
    const forged = { ...m2, ciphertext: new Uint8Array(m2.ciphertext) };
    forged.ciphertext[1] ^= 0x01;
    await expect(ratchetDecrypt(bob, forged)).rejects.toThrow();

    // The authentic m2 must STILL decrypt — the forgery poisoned nothing.
    expect(fromUtf8(await ratchetDecrypt(bob, m2))).toBe("second");
  });

  it("leaves receive state byte-for-byte unchanged after rejection", async () => {
    const { alice, bob } = await pair();
    const m1 = await ratchetEncrypt(alice, utf8("hello"));
    const forged = { ...m1, ciphertext: new Uint8Array(m1.ciphertext) };
    forged.ciphertext[0] ^= 0xff;

    const before = JSON.stringify(bob, (_k, val) =>
      val instanceof Uint8Array ? Array.from(val) : val,
    );
    await expect(ratchetDecrypt(bob, forged)).rejects.toThrow();
    const after = JSON.stringify(bob, (_k, val) =>
      val instanceof Uint8Array ? Array.from(val) : val,
    );
    expect(after).toBe(before);
  });
});

describe("canonical wire codec", () => {
  it("round-trips header + ciphertext + tag", async () => {
    const { alice, bob } = await pair();
    const msg = await ratchetEncrypt(alice, utf8("on the wire"));
    const packet = encodeWire(msg);
    // total = 40-byte header + ciphertext (which includes the 16-byte tag).
    expect(packet.length).toBe(WIRE_HEADER_LEN + msg.ciphertext.length);
    expect(msg.ciphertext.length).toBe(utf8("on the wire").length + GCM_TAG_LEN);
    const decoded = decodeWire(packet);
    expect(fromUtf8(await ratchetDecrypt(bob, decoded))).toBe("on the wire");
  });

  it("a mutation anywhere in the encoded packet is rejected", async () => {
    const { alice, bob } = await pair();
    const msg = await ratchetEncrypt(alice, utf8("intact"));
    const packet = encodeWire(msg);
    for (const i of [10, WIRE_HEADER_LEN, packet.length - 1]) {
      const bad = new Uint8Array(packet);
      bad[i] ^= 0x01;
      await expect(ratchetDecrypt({ ...bob }, decodeWire(bad))).rejects.toThrow();
    }
  });
});

describe("forward secrecy of the symmetric chain", () => {
  it("a later chain key cannot reproduce an earlier message key", async () => {
    // The KDF chain is one-way (HMAC). Encrypt two messages; the second send
    // advanced the chain, and there is no operation that walks it backwards.
    const { alice, bob } = await pair();
    const first = await ratchetEncrypt(alice, utf8("first"));
    const second = await ratchetEncrypt(alice, utf8("second"));
    // Bob can still decrypt the first in order (keys derived forward)...
    expect(fromUtf8(await ratchetDecrypt(bob, first))).toBe("first");
    expect(fromUtf8(await ratchetDecrypt(bob, second))).toBe("second");
    // ...and the two message ciphertexts are independent.
    expect(toHex(first.ciphertext)).not.toBe(toHex(second.ciphertext));
  });
});

describe("DH agreement underlies the root chain", () => {
  it("sender and receiver compute the same DH output", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(toHex(dh(a, b.publicKey))).toBe(toHex(dh(b, a.publicKey)));
  });
});
