import { expect, test, type Page } from "@playwright/test";

/**
 * FUNCTIONAL gate — the claims the page makes, asserted against the page's own
 * rendered output rather than against strings copied out of the source.
 *
 * Everything here runs against the production `vite preview` build, so the
 * verdicts, byte counters and failure paths asserted are the ones that ship.
 * Wherever possible a claim is checked for INTERNAL CONSISTENCY (the byte
 * segments summing to the announced total, the verdict counter matching the
 * number of messages actually on screen, the flipped-byte index landing past the
 * header length the wire pane itself reports) so the assertions cannot be
 * satisfied by hardcoded copy.
 *
 * The a11y spec next door owns WCAG; this file owns behaviour.
 */

const HEADER_BYTES = 40; // dh(32) || pn(4) || n(4)
const TAG_BYTES = 16; // AES-GCM tag

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById("app")?.getAttribute("aria-busy") !== "true",
  );
}

async function boot(page: Page): Promise<void> {
  await page.goto(".");
  await page.waitForSelector(".cl-hero-title");
  await settle(page);
}

async function openDisclosures(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll("details").forEach((d) => ((d as HTMLDetailsElement).open = true));
  });
}

async function sendCustom(page: Page, text: string): Promise<void> {
  await page.fill("#custom-msg", text);
  await page.getByRole("button", { name: /encrypt & send/i }).click();
  await settle(page);
}

async function sendScript(page: Page, count: number): Promise<void> {
  const btn = page.getByRole("button", { name: /send next message/i });
  for (let i = 0; i < count; i++) {
    await btn.click();
    await settle(page);
  }
}

interface Wire {
  /** From the meta strip: `dh …`, `pn`, `n`, `total N B`. */
  readonly pn: number;
  readonly n: number;
  readonly totalBytes: number;
  /** Byte counts parsed out of each segment's own label. */
  readonly headerBytes: number;
  readonly bodyBytes: number;
  readonly tagBytes: number;
  readonly headerHex: string;
  readonly bodyHex: string;
  readonly tagHex: string;
  /** The Exhibit B mirror sentence, which restates the same four numbers. */
  readonly mirror: string;
}

async function readWire(page: Page): Promise<Wire> {
  return page.evaluate(() => {
    const bold = [...document.querySelectorAll(".wire-meta b")].map((b) => b.textContent ?? "");
    const segs = [...document.querySelectorAll(".wire-seg")].map((s) => ({
      label: s.querySelector(".seg-label")?.textContent ?? "",
      hex: s.querySelector(".seg-hex")?.textContent ?? "",
    }));
    const bytesIn = (label: string): number => Number((label.match(/(\d+)\s*B/) ?? [])[1]);
    return {
      pn: Number(bold[1]),
      n: Number(bold[2]),
      totalBytes: Number((bold[3].match(/(\d+)/) ?? [])[1]),
      headerBytes: bytesIn(segs[0]?.label ?? ""),
      bodyBytes: bytesIn(segs[1]?.label ?? ""),
      tagBytes: bytesIn(segs[2]?.label ?? ""),
      headerHex: segs[0]?.hex ?? "",
      bodyHex: segs[1]?.hex ?? "",
      tagHex: segs[2]?.hex ?? "",
      mirror:
        [...document.querySelectorAll("p.hint")]
          .map((p) => p.textContent ?? "")
          .find((t) => /Latest packet/.test(t)) ?? "",
    };
  });
}

interface Verdicts {
  readonly encClass: string;
  readonly encStatus: string;
  readonly encNote: string;
  readonly endpointClass: string;
  readonly endpointStatus: string;
  readonly endpointNote: string;
  readonly systemClass: string;
  readonly systemTitle: string;
  readonly systemBody: string;
}

async function readVerdicts(page: Page): Promise<Verdicts> {
  return page.evaluate(() => {
    const v = [...document.querySelectorAll(".verdict")];
    const t = (root: Element | undefined, sel: string): string =>
      root?.querySelector(sel)?.textContent?.trim() ?? "";
    return {
      encClass: v[0]?.className ?? "",
      encStatus: t(v[0], ".v-status"),
      encNote: t(v[0], ".v-note"),
      endpointClass: v[1]?.className ?? "",
      endpointStatus: t(v[1], ".v-status"),
      endpointNote: t(v[1], ".v-note"),
      systemClass: document.querySelector(".system-verdict")?.className ?? "",
      systemTitle: t(document.body, ".sv-title"),
      systemBody: t(document.body, ".sv-body"),
    };
  });
}

const bubbleCount = (page: Page): Promise<number> => page.locator(".bubble").count();

/* ── The wire counters ────────────────────────────────────────────────────── */

test("the wire's byte counters are internally consistent and match the plaintext", async ({
  page,
}) => {
  await boot(page);

  // Two payloads: pure ASCII, and one whose UTF-8 length exceeds its JS length,
  // so a byte counter that secretly counted characters would be caught.
  for (const text of ["logistics for tonight", "héllo € ✓"]) {
    await sendCustom(page, text);
    const w = await readWire(page);
    const utf8Len = Buffer.byteLength(text, "utf8");

    // Segment labels agree with the codec's fixed lengths...
    expect(w.headerBytes, `header length for "${text}"`).toBe(HEADER_BYTES);
    expect(w.tagBytes, `tag length for "${text}"`).toBe(TAG_BYTES);
    // ...and AES-GCM is length-preserving, so the body IS the plaintext length.
    expect(w.bodyBytes, `ciphertext length for "${text}"`).toBe(utf8Len);
    // The parts sum to the announced whole.
    expect(w.headerBytes + w.bodyBytes + w.tagBytes, `total for "${text}"`).toBe(w.totalBytes);

    // Every rendered hex run is real hex, two characters per announced byte.
    expect(w.headerHex).toMatch(/^[0-9a-f]+$/);
    expect(w.bodyHex).toMatch(/^[0-9a-f]+$/);
    expect(w.tagHex).toMatch(/^[0-9a-f]+$/);
    expect(w.headerHex.length).toBe(w.headerBytes * 2);
    expect(w.bodyHex.length).toBe(w.bodyBytes * 2);
    expect(w.tagHex.length).toBe(w.tagBytes * 2);

    // Exhibit B restates the same numbers; they must not drift from Exhibit A.
    expect(w.mirror).toContain(
      `Latest packet: ${w.totalBytes} bytes (header ${w.headerBytes} + ciphertext ${w.bodyBytes} + tag ${w.tagBytes})`,
    );
  }
});

test("the wire is opaque: plaintext never appears in the packet, and a repeated message never repeats its ciphertext", async ({
  page,
}) => {
  await boot(page);
  const secret = "meet at the usual place";
  const secretHex = Buffer.from(secret, "utf8").toString("hex");

  await sendCustom(page, secret);
  const first = await readWire(page);
  const packetHex = first.headerHex + first.bodyHex + first.tagHex;
  expect(packetHex).not.toContain(secretHex);
  // Nor any 4-byte window of it — a partially leaking cipher would still fail.
  for (let i = 0; i + 8 <= secretHex.length; i += 2) {
    expect(packetHex, `plaintext window at byte ${i / 2}`).not.toContain(
      secretHex.slice(i, i + 8),
    );
  }

  // "A fresh key per message": the identical plaintext, re-sent, is a different
  // ciphertext and a different tag. Same length, different bytes.
  await sendCustom(page, secret);
  const second = await readWire(page);
  expect(second.bodyBytes).toBe(first.bodyBytes);
  expect(second.bodyHex).not.toBe(first.bodyHex);
  expect(second.tagHex).not.toBe(first.tagHex);
});

/* ── The ratchet strip ────────────────────────────────────────────────────── */

test("the ratchet strip turns once per message, with a distinct key each time, and matches the wire header", async ({
  page,
}) => {
  await boot(page);

  // Step the script one message at a time, capturing the wire after each so the
  // strip's DH/chain label can be checked against the header it produced.
  const wires: Wire[] = [];
  for (let i = 0; i < 4; i++) {
    await sendScript(page, 1);
    wires.push(await readWire(page));
  }

  const chips = await page.evaluate(() =>
    [...document.querySelectorAll(".rk-chip")].map((c) => ({
      who: c.querySelector(".rk-n")?.textContent ?? "",
      fp: c.querySelector(".rk-fp")?.textContent ?? "",
      tag: c.querySelector(".rk-tag")?.textContent ?? "",
    })),
  );

  // One chip per message actually rendered in the conversation.
  expect(chips.length).toBe(await bubbleCount(page));
  expect(chips.length).toBe(4);

  // A fresh key per message: every chain-key fingerprint is distinct.
  const fps = chips.map((c) => c.fp);
  expect(new Set(fps).size).toBe(fps.length);
  for (const fp of fps) expect(fp).toMatch(/^[0-9a-f]{6}$/);

  // The scripted exchange is A, A, B, A — and the second message, being Alice's
  // second in a row, advances the symmetric chain only (README's `chain +1`).
  expect(chips.map((c) => c.who.slice(0, 1))).toEqual(["A", "A", "B", "A"]);
  expect(chips[0].tag).toMatch(/DH step/);
  expect(chips[1].tag).toMatch(/chain \+1/);
  expect(chips[1].who).toMatch(/msg 1$/); // n advanced within the same chain
  expect(chips[2].tag).toMatch(/DH step/); // direction changed → new DH ratchet

  // Each chip's message number is the `n` that message's own header advertised.
  for (let i = 0; i < chips.length; i++) {
    expect(chips[i].who, `chip ${i} vs header n`).toMatch(new RegExp(`msg ${wires[i].n}$`));
  }

  // The strip's label is not decoration: a `chain +1` message reuses the
  // sender's ratchet public key, a `⟳ DH step` message carries a new one.
  const dhOf = (w: Wire): string => w.headerHex.slice(0, 64);
  expect(dhOf(wires[1])).toBe(dhOf(wires[0])); // chain +1 → same DH key
  expect(dhOf(wires[2])).not.toBe(dhOf(wires[1])); // DH step → new DH key
  expect(dhOf(wires[3])).not.toBe(dhOf(wires[2])); // DH step → new DH key
  // And `pn` (previous chain length) records the chain Alice closed: two.
  expect(wires[3].pn).toBe(2);
});

/* ── The verdicts ─────────────────────────────────────────────────────────── */

test("the encryption verdict counts the messages actually on screen", async ({ page }) => {
  await boot(page);

  const before = await readVerdicts(page);
  expect(before.encClass).toContain("state-untested");
  expect(before.encStatus).toContain("NOT YET TESTED");
  expect(before.systemClass).toContain("state-neutral");
  expect(before.systemTitle).toBe("AWAITING EVIDENCE");

  await sendCustom(page, "first");
  const one = await readVerdicts(page);
  expect(one.encStatus).toContain("SOUND");
  expect(one.encNote).toMatch(/^1 of 1 message authenticated/);

  await sendScript(page, 4);
  const total = await bubbleCount(page);
  expect(total).toBe(5);

  const after = await readVerdicts(page);
  expect(after.encClass).toContain("state-ok");
  // The counter is not merely present: both halves equal the rendered message
  // count, so every message on screen authenticated at the recipient.
  const m = after.encNote.match(/^(\d+) of (\d+) messages? authenticated/);
  expect(m, `unparsable verdict note: ${after.encNote}`).not.toBeNull();
  expect(Number(m![1])).toBe(total);
  expect(Number(m![2])).toBe(total);
  expect(after.systemClass).toContain("state-ok");
  expect(after.systemTitle).toBe("SECURE UNDER THIS LAB'S ASSUMPTIONS");
  expect(after.systemBody).toMatch(/Every delivered message authenticated/);
  await expect(page.locator(".error-status")).toHaveText("");
});

test("the two axes stay independent: an implant flips the system verdict while encryption stays sound", async ({
  page,
}) => {
  await boot(page);
  await sendCustom(page, "before the implant");
  const clean = await readVerdicts(page);
  expect(clean.endpointClass).toContain("state-ok");
  expect(clean.systemClass).toContain("state-ok");

  await page.locator(".switch").click();
  await settle(page);
  await expect(page.locator(".switch")).toHaveAttribute("aria-pressed", "true");

  const armed = await readVerdicts(page);
  // Encryption is untouched — the implant never attacks the cipher...
  expect(armed.encStatus).toContain("SOUND");
  expect(armed.encClass).toContain("state-ok");
  // ...but the endpoint and the system verdict both go to alarm.
  expect(armed.endpointStatus).toContain("COMPROMISED");
  expect(armed.endpointClass).toContain("state-alarm");
  expect(armed.systemClass).toContain("state-alarm");
  expect(armed.systemTitle).toBe("SYSTEM COMPROMISED");
  expect(armed.systemBody).toMatch(/Encryption held; the endpoint did not/);
  expect(armed.endpointNote).toMatch(/never needed a key/i);
});

test("the banner never claims the encryption held before a single tag has verified", async ({
  page,
}) => {
  // Regression: deploying the implant on a fresh page printed "Encryption held"
  // beside an encryption panel reading NOT YET TESTED.
  await boot(page);
  await page.locator(".switch").click();
  await settle(page);

  expect(await bubbleCount(page)).toBe(0);
  const v = await readVerdicts(page);
  expect(v.encStatus).toContain("NOT YET TESTED");
  expect(v.systemTitle).toBe("SYSTEM COMPROMISED");
  expect(v.systemClass).toContain("state-alarm");
  expect(v.systemBody).not.toMatch(/encryption held/i);
  expect(v.systemBody).toMatch(/untested/i);

  // And once a message does authenticate, the claim becomes available.
  await sendCustom(page, "now there is evidence");
  const after = await readVerdicts(page);
  expect(after.encStatus).toContain("SOUND");
  expect(after.systemBody).toMatch(/Encryption held/);
});

/* ── The endpoint pivot ───────────────────────────────────────────────────── */

test("the implant harvests plaintext at both ends while the wire is byte-for-byte unchanged", async ({
  page,
}) => {
  await boot(page);
  const payload = "handsets ready tonight";

  await sendCustom(page, payload);
  const cleanWire = await readWire(page);
  expect(await page.locator(".capture-list li").count()).toBe(0);

  await page.locator(".switch").click();
  await settle(page);
  await sendCustom(page, payload);
  const taggedWire = await readWire(page);

  // The wire the eavesdropper sees is the same size and shape as before — the
  // implant changed nothing about the cryptography (README's central claim).
  expect(taggedWire.headerBytes).toBe(cleanWire.headerBytes);
  expect(taggedWire.bodyBytes).toBe(cleanWire.bodyBytes);
  expect(taggedWire.tagBytes).toBe(cleanWire.tagBytes);
  expect(taggedWire.totalBytes).toBe(cleanWire.totalBytes);
  // Still opaque, and still a fresh key: same length, different bytes.
  expect(taggedWire.bodyHex).not.toBe(cleanWire.bodyHex);
  expect(taggedWire.bodyHex).not.toContain(Buffer.from(payload, "utf8").toString("hex"));

  // ...yet the plaintext is read twice: once before encryption on the sender,
  // once after decryption on the receiver.
  const caps = await page.evaluate(() =>
    [...document.querySelectorAll(".capture-list li")].map((li) => ({
      meta: li.querySelector(".cap-meta")?.textContent ?? "",
      text: li.querySelector(".cap-text")?.textContent ?? "",
    })),
  );
  expect(caps.length).toBe(2);
  expect(caps[0].meta).toBe("alice · pre-encryption");
  expect(caps[1].meta).toBe("bob · post-decryption");
  expect(caps.map((c) => c.text)).toEqual([payload, payload]);

  // Removing the implant clears the harvest and restores both green verdicts.
  await page.locator(".switch").click();
  await settle(page);
  await expect(page.locator(".switch")).toHaveAttribute("aria-pressed", "false");
  expect(await page.locator(".capture-list li").count()).toBe(0);
  const restored = await readVerdicts(page);
  expect(restored.endpointClass).toContain("state-ok");
  expect(restored.systemClass).toContain("state-ok");
});

/* ── The failure paths ────────────────────────────────────────────────────── */

test("the keyless wiretap fails, says why, and leaves the session untouched", async ({ page }) => {
  await boot(page);
  await openDisclosures(page);

  // Gated: with nothing on the wire there is nothing to tap.
  await expect(page.getByRole("button", { name: /tap the wire/i })).toBeDisabled();

  await sendCustom(page, "something worth intercepting");
  const before = await readVerdicts(page);
  const wireBefore = await readWire(page);

  const tap = page.getByRole("button", { name: /tap the wire/i });
  await expect(tap).toBeEnabled();
  await tap.click();
  await settle(page);

  const status = page.locator(".break-status");
  // It reached the failure state...
  await expect(status).toContainText("Wiretap failed");
  await expect(status).toContainText("🔒");
  // ...and it says WHY: the AEAD tag, not a guess, is what refused.
  await expect(status).toContainText("AES-256-GCM authentication failed");
  await expect(status).toContainText("message key");
  await expect(status).toContainText("leaks only its length");
  await expect(status).not.toContainText("should never happen");
  await expect(page.locator(".error-status")).toHaveText("");

  // The failed attack changed nothing about the honest session.
  expect(await readVerdicts(page)).toEqual(before);
  expect(await readWire(page)).toEqual(wireBefore);
});

test("the forged packet is rejected, the authentic one still decrypts, and the flipped byte lands in the ciphertext", async ({
  page,
}) => {
  await boot(page);
  await openDisclosures(page);
  await sendCustom(page, "an honest message");
  const before = await readVerdicts(page);

  await page.getByRole("button", { name: /forge a packet/i }).click();
  await settle(page);

  const status = page.locator(".break-status");
  const text = (await status.textContent()) ?? "";
  // The success marker, not the "unexpected" fallback.
  expect(text).toContain("🛡");
  expect(text).not.toContain("did not behave as required");
  // Rejection AND recovery, each stated with its reason.
  expect(text).toMatch(/rejected the forged packet/i);
  expect(text).toMatch(/rejection commits no state/i);
  expect(text).toMatch(/authentic packet still decrypted/i);

  // The byte it flipped is past the header the wire pane itself reports, so the
  // experiment really targeted ciphertext rather than a header field.
  const wire = await readWire(page);
  const flipped = Number((text.match(/Byte (\d+) flipped/) ?? [])[1]);
  expect(Number.isFinite(flipped)).toBe(true);
  expect(flipped).toBeGreaterThanOrEqual(wire.headerBytes);
  expect(flipped).toBeLessThan(wire.headerBytes + wire.bodyBytes);

  // The isolated experiment must not poison the live conversation.
  expect(await readVerdicts(page)).toEqual(before);
  await expect(page.locator(".error-status")).toHaveText("");
});

/* ── Controls ─────────────────────────────────────────────────────────────── */

test("the scripted stepper runs exactly four messages, then stops", async ({ page }) => {
  await boot(page);
  const btn = page.getByRole("button", { name: /send next message/i });
  await expect(btn).toBeEnabled();
  await sendScript(page, 4);
  expect(await bubbleCount(page)).toBe(4);
  await expect(btn).toBeDisabled();

  // The scripted conversation is the one the source scripts, in order.
  const senders = await page.evaluate(() =>
    [...document.querySelectorAll(".bubble .who")].map((w) => w.textContent),
  );
  expect(senders).toEqual(["Alice", "Alice", "Bob", "Alice"]);
  // No message was ever marked undelivered on the honest path.
  expect(await page.locator(".bubble-warn").count()).toBe(0);
});

test("an empty compose is a no-op, and reset returns the session to no-evidence", async ({
  page,
}) => {
  await boot(page);
  await openDisclosures(page); // the break-it controls live in a <details>
  await sendCustom(page, "   ");
  expect(await bubbleCount(page)).toBe(0);
  await expect(page.locator(".error-status")).toHaveText("");

  await sendScript(page, 2);
  await sendCustom(page, "and one more");
  expect(await bubbleCount(page)).toBe(3);

  await page.getByRole("button", { name: /reset conversation/i }).click();
  await settle(page);

  expect(await bubbleCount(page)).toBe(0);
  expect(await page.locator(".rk-chip").count()).toBe(0);
  expect(await page.locator(".wire-seg").count()).toBe(0);
  await expect(page.locator(".wire-meta")).toHaveText("");
  await expect(page.getByText("Send a message to populate the wire.")).toBeVisible();
  await expect(page.getByRole("button", { name: /tap the wire/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /send next message/i })).toBeEnabled();

  const v = await readVerdicts(page);
  expect(v.encClass).toContain("state-untested");
  expect(v.encStatus).toContain("NOT YET TESTED");
  expect(v.systemClass).toContain("state-neutral");
  expect(v.systemTitle).toBe("AWAITING EVIDENCE");

  // The script rewinds too: all four messages are available again.
  await sendScript(page, 4);
  expect(await bubbleCount(page)).toBe(4);
});

test("reset keeps a deployed implant deployed, and the verdicts follow", async ({ page }) => {
  await boot(page);
  await page.locator(".switch").click();
  await settle(page);
  await sendCustom(page, "harvest me");
  expect(await page.locator(".capture-list li").count()).toBe(2);

  await page.getByRole("button", { name: /reset conversation/i }).click();
  await settle(page);

  // Fresh keys and an empty transcript, but the endpoint is still owned.
  expect(await bubbleCount(page)).toBe(0);
  expect(await page.locator(".capture-list li").count()).toBe(0);
  await expect(page.locator(".switch")).toHaveAttribute("aria-pressed", "true");
  const v = await readVerdicts(page);
  expect(v.encStatus).toContain("NOT YET TESTED");
  expect(v.endpointStatus).toContain("COMPROMISED");
  expect(v.systemTitle).toBe("SYSTEM COMPROMISED");
  expect(v.systemClass).toContain("state-alarm");
});
