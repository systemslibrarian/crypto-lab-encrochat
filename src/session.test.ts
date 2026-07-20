import { describe, expect, it } from "vitest";
import { Session } from "./session";

/**
 * Session-level guarantees the review flagged as release blockers: fresh random
 * key material every session (no key/IV reuse), a reproducible transcript ONLY
 * in opt-in deterministic mode, and verdicts that follow observed evidence.
 */

describe("fresh production sessions never reuse key material", () => {
  it("500 default sessions encrypt the same plaintext to 500 distinct packets", async () => {
    // AES-GCM is deterministic in (key, IV, plaintext): identical output would
    // mean a repeated (key, IV). Distinct output across sessions proves freshness.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const s = await Session.create();
      const e = await s.send("alice", "identical plaintext");
      seen.add(e.wire.packetHex);
    }
    expect(seen.size).toBe(500);
  }, 30_000);

  it("two default sessions differ; two deterministic sessions match", async () => {
    const a = await Session.create();
    const b = await Session.create();
    const ea = await a.send("alice", "hi");
    const eb = await b.send("alice", "hi");
    expect(ea.wire.packetHex).not.toBe(eb.wire.packetHex);

    const d1 = await Session.create({ deterministic: true });
    const d2 = await Session.create({ deterministic: true });
    const e1 = await d1.send("alice", "hi");
    const e2 = await d2.send("alice", "hi");
    expect(e1.wire.packetHex).toBe(e2.wire.packetHex);
  });
});

describe("wire view reports the full packet", () => {
  it("total bytes equal header + ciphertext body + tag", async () => {
    const s = await Session.create();
    const e = await s.send("alice", "count my bytes");
    expect(e.wire.headerBytes).toBe(40);
    expect(e.wire.tagBytes).toBe(16);
    expect(e.wire.totalBytes).toBe(e.wire.headerBytes + e.wire.bodyBytes + e.wire.tagBytes);
    // The rendered header/body/tag hex reassemble to the whole packet.
    expect(e.wire.headerHex + e.wire.bodyHex + e.wire.tagHex).toBe(e.wire.packetHex);
  });
});

describe("verdict follows evidence", () => {
  it("is untested before any message, sound after a verified one", async () => {
    const s = await Session.create();
    expect(s.verdict().encryption).toBe("untested");
    expect(s.verdict().systemSignal).toBe("neutral");

    await s.send("alice", "now there is evidence");
    expect(s.verdict().encryption).toBe("sound");
    expect(s.verdict().systemSignal).toBe("ok");
  });

  it("flips to alarm the moment an implant is deployed", async () => {
    const s = await Session.create();
    await s.send("alice", "clean so far");
    expect(s.verdict().systemSignal).toBe("ok");
    s.setImplant(true);
    const v = s.verdict();
    expect(v.encryption).toBe("sound"); // encryption still genuinely sound
    expect(v.system).toBe("compromised"); // ...but the system is not
    expect(v.systemSignal).toBe("alarm");
  });
});
