import { describe, expect, it } from "vitest";
import { assessSystem, Implant } from "./implant";
import { Session } from "../session";
import { toHex, utf8 } from "../crypto/primitives";

/**
 * The lab's thesis, made executable: with the endpoint compromised, the
 * plaintext is read even though the encryption is fully sound.
 */

describe("Implant reads plaintext without touching the crypto", () => {
  it("captures composed and delivered plaintext at the endpoints", () => {
    const implant = new Implant();
    implant.captureOutbound("alice", "burner acquired");
    implant.captureInbound("bob", "burner acquired");
    const caps = implant.captures();
    expect(caps).toHaveLength(2);
    expect(caps[0]).toMatchObject({ point: "pre-encryption", plaintext: "burner acquired" });
    expect(caps[1]).toMatchObject({ point: "post-decryption", plaintext: "burner acquired" });
  });
});

describe("End-to-end: encryption sound, endpoint compromised", () => {
  it("delivers correctly on the wire AND leaks plaintext at the device", async () => {
    const session = await Session.create();
    session.setImplant(true);

    const event = await session.send("alice", "the shipment is on the water");

    // The crypto did its job: the recipient's real ratchet verified and decrypted.
    expect(event.verified).toBe(true);
    expect(event.delivered).toBe("the shipment is on the water");
    // The wire an on-path adversary sees is opaque and does not contain the text.
    expect(event.wire.ciphertextHex).not.toContain(toHex(utf8("the shipment is on the water")));
    // Yet the implant harvested the plaintext at both endpoints — before encrypt,
    // after decrypt — having never seen a key or a ciphertext.
    const leaked = event.captures.map((c) => c.plaintext);
    expect(leaked).toContain("the shipment is on the water");
    expect(session.implant.transcript()).toContain("the shipment is on the water");
  });

  it("leaks nothing when the endpoint is clean", async () => {
    const session = await Session.create();
    session.setImplant(false);
    const event = await session.send("alice", "nothing to see");
    expect(event.verified).toBe(true);
    expect(event.captures).toHaveLength(0);
    expect(session.implant.captures()).toHaveLength(0);
  });
});

describe("The on-path network adversary gets nothing", () => {
  it("a keyless wiretap fails to decrypt the ciphertext", async () => {
    const session = await Session.create();
    await session.send("alice", "safehouse at nine");
    const tap = await session.wiretapAttempt();
    expect(tap.ok).toBe(false);
    expect(tap.reason).toMatch(/authentication failed/i);
  });

  it("a tampered ciphertext is rejected (integrity, not just secrecy)", async () => {
    const session = await Session.create();
    const tamper = await session.tamperAttempt();
    expect(tamper.rejected).toBe(true);
    expect(tamper.reason).toMatch(/rejected/i);
  });
});

describe("Verdict separation tracks system integrity, not the raw crypto result", () => {
  it("sound encryption + clean endpoint = system sound", () => {
    const v = assessSystem({ encryptionSound: true, endpointCompromised: false });
    expect(v).toMatchObject({ encryption: "sound", endpoint: "sound", system: "sound" });
    expect(v.systemSignal).toBe("ok");
  });

  it("sound encryption + compromised endpoint = system COMPROMISED (alarm)", () => {
    const v = assessSystem({ encryptionSound: true, endpointCompromised: true });
    // Encryption is genuinely sound...
    expect(v.encryption).toBe("sound");
    // ...but the system verdict — the one that matters — is compromised.
    expect(v.system).toBe("compromised");
    expect(v.systemSignal).toBe("alarm");
    expect(v.headline).toMatch(/endpoint did not/i);
  });

  it("the weakest link decides: broken encryption is also system-compromised", () => {
    const v = assessSystem({ encryptionSound: false, endpointCompromised: false });
    expect(v.system).toBe("compromised");
  });
});
