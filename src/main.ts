import "./style.css";
import { clear, el } from "./dom";
import { Session, type MessageEvent, type WireView } from "./session";
import type { Party } from "./endpoint/implant";

/* ── Scripted conversation ────────────────────────────────────────────────────
   Deliberately mundane logistics — this is exactly the kind of content the
   channel kept secret. Note the two consecutive messages from Alice: the second
   advances the symmetric ratchet only (no new DH key), which the strip shows. */
const SCRIPT: Array<{ from: Party; text: string }> = [
  { from: "alice", text: "New handsets are provisioned and ready." },
  { from: "alice", text: "Nothing leaves the device in the clear." },
  { from: "bob", text: "Good. Same contact list as before?" },
  { from: "alice", text: "Yes. Talk tonight." },
];

let session: Session;
let scriptIndex = 0;
let sentCount = 0;
let verifiedCount = 0;

/* Dynamic regions, wired once and updated in place. */
let appRoot: HTMLElement;
let convoEl: HTMLElement;
let wireMetaEl: HTMLElement;
let hexEl: HTMLElement;
let ratchetEl: HTMLElement;
let breakStatusEl: HTMLElement;
let errorEl: HTMLElement;
let sendScriptBtn: HTMLButtonElement;
let resetBtn: HTMLButtonElement;
let customInput: HTMLInputElement;
let customSend: HTMLButtonElement;
let tapBtn: HTMLButtonElement;
let tamperBtn: HTMLButtonElement;
let implantSwitch: HTMLButtonElement;
let implantStatusEl: HTMLElement;
let captureListEl: HTMLElement;
let wireMirrorEl: HTMLElement;
let encVerdictEl: HTMLElement;
let endpointVerdictEl: HTMLElement;
let systemVerdictEl: HTMLElement;

/* ── One serialized command queue ─────────────────────────────────────────────
   Every state-changing action runs to completion before the next starts, so two
   fast clicks (or Enter + click) can never race the ratchet into reusing a
   message key/IV, reordering output, or throwing. Controls are disabled and
   aria-busy is set while a command runs. */
let opLock: Promise<unknown> = Promise.resolve();

function runOp(fn: () => Promise<void>): Promise<void> {
  const task = opLock.then(async () => {
    setBusy(true);
    errorEl.textContent = "";
    try {
      await fn();
    } catch (err) {
      errorEl.textContent = `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      setBusy(false);
    }
  });
  opLock = task.catch(() => undefined);
  return task;
}

function setBusy(busy: boolean): void {
  appRoot.setAttribute("aria-busy", busy ? "true" : "false");
  const all = [sendScriptBtn, resetBtn, customSend, tapBtn, tamperBtn, implantSwitch];
  for (const c of all) c.disabled = true;
  customInput.disabled = busy;
  if (!busy) refreshControls();
}

function refreshControls(): void {
  sendScriptBtn.disabled = scriptIndex >= SCRIPT.length;
  resetBtn.disabled = false;
  customSend.disabled = false;
  tapBtn.disabled = !session.hasPacket();
  tamperBtn.disabled = false;
  implantSwitch.disabled = false;
  customInput.disabled = false;
}

/* ── Hero ─────────────────────────────────────────────────────────────────── */
function hero(): HTMLElement {
  return el(
    "header",
    { class: "cl-hero" },
    el(
      "div",
      { class: "cl-hero-main" },
      el("h1", { class: "cl-hero-title", text: "Encrochat" }),
      el("p", { class: "cl-hero-sub", text: "Endpoint Compromise · eprint 2026/1319" }),
      el("p", {
        class: "cl-hero-desc",
        text: "Run a real (in-order) Signal-protocol Double Ratchet exchange, watch the wire stay opaque, then deploy an endpoint implant and see it read the plaintext the cryptography just protected perfectly.",
      }),
    ),
    el(
      "aside",
      { class: "cl-hero-why", "aria-label": "Why it matters" },
      el("span", { class: "cl-hero-why-label", text: "WHY IT MATTERS" }),
      el("p", {
        class: "cl-hero-why-text",
        text: "In 2020, Encrochat's messages were read by the million — not by breaking the maths, but by owning the phones. When the device is compromised, plaintext is exposed at that endpoint, even while the encryption keeps protecting the channel from everyone else.",
      }),
    ),
  );
}

function intro(): HTMLElement {
  const card = el("section", { class: "card intro" });
  card.append(
    el("h2", { text: "What you're looking at" }),
    el(
      "p",
      {},
      "End-to-end encryption scrambles a message on your device and unscrambles it on the other person's, so anyone in between — your network, your carrier, the servers — sees only ",
      el("strong", { text: "ciphertext" }),
      ": noise.",
    ),
    el("p", {
      text: "Encrochat sold phones built around this exact protocol — the same Double Ratchet behind Signal and WhatsApp. They were still defeated: not by cracking the encryption, but by putting code on the phone itself, where the message exists as plain text before it is ever encrypted and after it is decrypted.",
    }),
    el(
      "p",
      {},
      el("strong", {
        text: "The lesson: encryption protects the channel, not the device. Security is a property of the whole system, not of one algorithm.",
      }),
    ),
  );
  return card;
}

/* ── Exhibit A: the conversation and the wire ─────────────────────────────── */
function exhibitA(): HTMLElement {
  const section = el("section", { class: "section" });
  section.append(
    el(
      "div",
      { class: "section-head" },
      el("span", { class: "section-kicker", text: "Exhibit A" }),
      el("h2", { class: "section-title", text: "A real Double Ratchet, and what the network sees" }),
    ),
    el("p", {
      class: "section-lede",
      text: "Every message below is genuinely encrypted in your browser with X25519, HKDF-SHA256 and AES-256-GCM. The left pane is the conversation; the right pane is the exact packet — header, ciphertext and authentication tag — that an on-path eavesdropper captures.",
    }),
  );

  const card = el("section", { class: "card" });

  convoEl = el("div", {
    class: "convo",
    role: "log",
    "aria-label": "Conversation between Alice and Bob",
    "aria-live": "polite",
  });
  const convoPane = el(
    "div",
    {},
    el(
      "div",
      { class: "pane-label" },
      el("span", { "aria-hidden": "true", text: "💬" }),
      el("span", { text: "Conversation (plaintext, on the devices)" }),
    ),
    convoEl,
  );

  wireMetaEl = el("div", { class: "wire-meta" });
  hexEl = el("div", {
    class: "hex",
    role: "group",
    tabindex: "0",
    "aria-label": "The packet bytes visible on the wire: header, ciphertext and tag",
  });
  const wirePane = el(
    "div",
    {},
    el(
      "div",
      { class: "pane-label" },
      el("span", { "aria-hidden": "true", text: "📡" }),
      el("span", { text: "On the wire (the exact packet captured)" }),
    ),
    el(
      "div",
      { class: "wire" },
      wireMetaEl,
      hexEl,
      el("p", {
        class: "wire-verdict",
        text: "The whole packet as it crosses the network. Its length and header leak; the plaintext does not.",
      }),
    ),
  );

  card.append(el("div", { class: "wire-grid" }, convoPane, wirePane));

  // The ratchet, turning.
  ratchetEl = el("ul", {
    class: "ratchet",
    "aria-label": "Double Ratchet steps — chain-key fingerprint per message",
  });
  card.append(
    el(
      "div",
      { style: "margin-top:1.1rem" },
      el(
        "div",
        { class: "pane-label" },
        el("span", { "aria-hidden": "true", text: "⚙" }),
        el("span", { text: "The ratchet turning (a fresh key per message)" }),
      ),
      ratchetEl,
    ),
  );

  // Controls: scripted stepper + reset.
  sendScriptBtn = el("button", { class: "btn btn-primary", type: "button" }) as HTMLButtonElement;
  sendScriptBtn.append(el("span", { "aria-hidden": "true", text: "➤" }), document.createTextNode(" Send next message"));
  sendScriptBtn.addEventListener("click", () => void sendScripted());
  resetBtn = el("button", { class: "btn", type: "button", text: "Reset conversation" }) as HTMLButtonElement;
  resetBtn.addEventListener("click", () => void doReset());
  card.append(el("div", { class: "controls" }, sendScriptBtn, resetBtn));

  // Compose your own.
  customInput = el("input", {
    type: "text",
    id: "custom-msg",
    placeholder: "Type a message to send as Alice…",
    maxlength: "120",
  }) as HTMLInputElement;
  customSend = el("button", { class: "btn", type: "button", text: "Encrypt & send" }) as HTMLButtonElement;
  customSend.addEventListener("click", () => void sendCustom());
  customInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void sendCustom();
  });
  card.append(
    el(
      "div",
      { class: "compose" },
      el("label", { for: "custom-msg", text: "Compose your own (sent as Alice, encrypted for real):" }),
      customInput,
      customSend,
    ),
  );

  // Break-it-yourself: prove the wire is opaque and tamper-evident.
  breakStatusEl = el("div", { class: "break-status", role: "status", "aria-live": "polite" });
  errorEl = el("div", { class: "error-status", role: "alert" });
  tapBtn = el("button", { class: "btn", type: "button" }) as HTMLButtonElement;
  tapBtn.append(el("span", { "aria-hidden": "true", text: "🕵" }), document.createTextNode(" Tap the wire (no keys)"));
  tapBtn.addEventListener("click", () => void doWiretap());
  tamperBtn = el("button", { class: "btn", type: "button" }) as HTMLButtonElement;
  tamperBtn.append(el("span", { "aria-hidden": "true", text: "✂" }), document.createTextNode(" Forge a packet & recover"));
  tamperBtn.addEventListener("click", () => void doTamper());

  const breakBlock = el("details", { class: "more" });
  breakBlock.append(
    el("summary", { text: "Break it yourself — try to read or forge the wire" }),
    el(
      "div",
      {},
      el("p", {
        text: "The network adversary has the full packet. Give them the best shot: attempt a decryption without the key (needs a captured packet), or run an isolated real exchange, flip one ciphertext bit, and watch the recipient reject the forgery while the authentic packet still decrypts.",
      }),
      el("div", { class: "controls" }, tapBtn, tamperBtn),
      breakStatusEl,
      errorEl,
    ),
  );
  card.append(breakBlock);

  section.append(card);
  return section;
}

/* ── Exhibit B: the endpoint pivot ────────────────────────────────────────── */
function exhibitB(): HTMLElement {
  const section = el("section", { class: "section" });
  section.append(
    el(
      "div",
      { class: "section-head" },
      el("span", { class: "section-kicker", text: "Exhibit B" }),
      el("h2", { class: "section-title", text: "The pivot: compromise the endpoint, not the cipher" }),
    ),
    el("p", {
      class: "section-lede",
      text: "The implant never sees a key and never touches the ciphertext. It just reads the plaintext the app already holds — before encryption on the sender, after decryption on the receiver. Deploy it, then send a message and watch.",
    }),
  );

  const card = el("section", { class: "card danger-zone" });

  implantSwitch = el("button", { class: "switch", type: "button", "aria-pressed": "false" }) as HTMLButtonElement;
  implantSwitch.append(
    el("span", { class: "dot", "aria-hidden": "true" }),
    el("span", { class: "switch-label", text: "Deploy implant on the devices" }),
  );
  implantSwitch.addEventListener("click", () => void toggleImplant());

  implantStatusEl = el("div", {
    class: "hint",
    role: "status",
    "aria-live": "polite",
    text: "No implant deployed. Plaintext exists only in each device's memory.",
  });
  card.append(el("div", { class: "toggle-row" }, implantSwitch, implantStatusEl));

  wireMirrorEl = el("p", { class: "hint", text: "Send a message to populate the wire." });
  const wireMirror = el(
    "div",
    {},
    el(
      "div",
      { class: "pane-label" },
      el("span", { "aria-hidden": "true", text: "📡" }),
      el("span", { text: "On the wire — unchanged by the implant" }),
    ),
    wireMirrorEl,
  );

  captureListEl = el("ul", { class: "capture-list" });
  const captureScroll = el(
    "div",
    {
      class: "capture-scroll",
      role: "group",
      tabindex: "0",
      "aria-label": "Plaintext harvested by the endpoint implant",
    },
    captureListEl,
  );
  const capturePane = el(
    "div",
    {},
    el(
      "div",
      { class: "pane-label" },
      el("span", { "aria-hidden": "true", text: "📟" }),
      el("span", { text: "At the endpoint — plaintext the implant reads" }),
    ),
    captureScroll,
  );

  card.append(el("div", { class: "wire-grid", style: "margin-top:1rem" }, wireMirror, capturePane));
  section.append(card);
  return section;
}

/* ── Exhibit C: verdict separation ────────────────────────────────────────── */
function exhibitC(): HTMLElement {
  const section = el("section", { class: "section" });
  section.append(
    el(
      "div",
      { class: "section-head" },
      el("span", { class: "section-kicker", text: "Exhibit C" }),
      el("h2", { class: "section-title", text: "Two verdicts, one that decides" }),
    ),
    el("p", {
      class: "section-lede",
      text: "Message encryption and endpoint integrity are independent axes, and every status here is derived from what was actually observed — not asserted. A green cipher does not upgrade a red device; the weakest link sets the system verdict.",
    }),
  );

  encVerdictEl = el("div", { class: "verdict" });
  endpointVerdictEl = el("div", { class: "verdict" });
  systemVerdictEl = el("div", { class: "system-verdict", role: "status", "aria-live": "polite" });

  const card = el("section", { class: "card" });
  card.append(el("div", { class: "verdict-grid" }, encVerdictEl, endpointVerdictEl), systemVerdictEl);
  section.append(card);
  return section;
}

/* ── Exhibit D: the architecture that was the real single point of failure ── */
function exhibitD(): HTMLElement {
  const section = el("section", { class: "section" });
  section.append(
    el(
      "div",
      { class: "section-head" },
      el("span", { class: "section-kicker", text: "Exhibit D" }),
      el("h2", { class: "section-title", text: "Why one endpoint compromise scaled to all of them" }),
    ),
    el("p", {
      class: "section-lede",
      text: "Encrochat was a vertically integrated stack: one operation controlled the hardware, the servers, and the key infrastructure. That concentration is the architectural lesson — the crypto was never the weakest link, the trust boundary was.",
    }),
  );

  const rows: Array<[string, string, string]> = [
    ["Device / vendor", "custom handset + OS", "The vendor built the phones and the messaging app, so the vendor decided what ran on the endpoint — the one place plaintext is readable."],
    ["Service provider", "servers + updates", "Message routing and software updates flowed through infrastructure the operation ran, a single channel reaching every device at once."],
    ["PKI / key distribution", "identities + trust roots", "Key material and trust anchors were issued centrally, so the users' notion of 'who am I talking to' rested on one authority."],
  ];

  const stack = el("div", { class: "stack" });
  for (const [layer, sub, note] of rows) {
    stack.append(
      el(
        "div",
        { class: "stack-row" },
        el("div", { class: "layer" }, document.createTextNode(layer), el("small", { text: sub })),
        el("div", { class: "layer-note", text: note }),
      ),
    );
  }

  const card = el("section", { class: "card" });
  card.append(
    stack,
    el(
      "div",
      { class: "spof" },
      el("span", { "aria-hidden": "true", text: "⚠ " }),
      "Single point of failure: ",
      el("b", { text: "when one entity owns device, service, and PKI, compromising the provider compromises every endpoint" }),
      " — no per-user attack required. The Double Ratchet held on all of them and it changed nothing.",
    ),
    scopingDetails(),
  );
  section.append(card);
  return section;
}

function scopingDetails(): HTMLElement {
  const d = el("details", { class: "more" });
  d.append(
    el("summary", { text: "For the expert: what this model does and does not include" }),
    el(
      "div",
      {},
      el("p", {
        text: "This lab models the principle, never a method. It contains no operational or acquisition detail for compromising an endpoint — that is out of scope by design. The implant here is a passive reader of application plaintext, which is sufficient to make the point and nothing more.",
      }),
      el("p", {
        text: "It is an in-order Double Ratchet teaching subset: session setup seeds the initial root key from a single X25519 handshake for clarity (the full X3DH agreement is the sibling lab crypto-lab-x3dh-wire), and out-of-order / skipped-message handling is omitted. Every production session draws fresh random keys, so no key or IV is reused; a rejected packet commits no ratchet state.",
      }),
    ),
  );
  return d;
}

function scoping(): HTMLElement {
  const card = el("section", { class: "card scoping" });
  card.append(
    el("h2", { text: "Honest scope — read this" }),
    el(
      "ul",
      {},
      el("li", {}, "This is ", el("b", { text: "not production crypto" }), " — it is a teaching demo. Do not protect real secrets with it."),
      el("li", {}, el("b", { text: "Real: " }), "the Double Ratchet, X25519, HKDF-SHA256 and AES-256-GCM all run for real and pass spec known-answer tests. Ciphertext on the wire is genuinely opaque and tamper-evident, and a rejected packet leaves the ratchet unchanged."),
      el("li", {}, el("b", { text: "Modelled: " }), "the endpoint implant is a stand-in for “code on the device” — it reads app plaintext directly. It carries no technique for getting there."),
      el("li", {}, el("b", { text: "What it does NOT prove: " }), "nothing here weakens the Signal protocol or the Double Ratchet. The point is the opposite — the cryptography was sound and the system still failed at the endpoint."),
      el("li", {}, "Based on the public account in Albrecht, Park, Specter & Stebila, ", el("i", { text: "“A Real-World Law-Enforcement Hack: The Case of Encrochat”" }), " (eprint 2026/1319). No attribution or legal commentary."),
    ),
  );
  return card;
}

/* ── Rendering updates ────────────────────────────────────────────────────── */
function seg(label: string, hex: string, cls: string): HTMLElement {
  return el(
    "div",
    { class: `wire-seg ${cls}` },
    el("span", { class: "seg-label", text: label }),
    el("span", { class: "seg-hex", text: hex || "—" }),
  );
}

function renderWire(view: WireView): void {
  clear(wireMetaEl);
  wireMetaEl.append(
    el("span", {}, "dh ", el("b", { text: view.headerDhHex.slice(0, 16) + "…" })),
    el("span", {}, "pn ", el("b", { text: String(view.pn) })),
    el("span", {}, "n ", el("b", { text: String(view.n) })),
    el("span", {}, "total ", el("b", { text: `${view.totalBytes} B` })),
  );
  clear(hexEl);
  hexEl.append(
    seg(`header · ${view.headerBytes} B`, view.headerHex, "seg-header"),
    seg(`ciphertext · ${view.bodyBytes} B`, view.bodyHex, "seg-body"),
    seg(`GCM tag · ${view.tagBytes} B`, view.tagHex, "seg-tag"),
  );
  wireMirrorEl.textContent = `Latest packet: ${view.totalBytes} bytes (header ${view.headerBytes} + ciphertext ${view.bodyBytes} + tag ${view.tagBytes}). Identical whether or not the implant is deployed.`;
}

function appendEvent(event: MessageEvent): void {
  sentCount += 1;
  if (event.verified) verifiedCount += 1;

  const bubble = el(
    "div",
    { class: `bubble from-${event.from}` },
    el("div", { class: "who", text: event.from === "alice" ? "Alice" : "Bob" }),
    el("div", { class: "text", text: event.plaintext }),
    !event.verified ? el("div", { class: "bubble-warn", text: "⚠ not delivered — authentication failed" }) : null,
  );
  convoEl.append(bubble);
  convoEl.scrollTop = convoEl.scrollHeight;

  renderWire(event.wire);

  // Ratchet chip.
  const chip = el("li", { class: `rk-chip${event.dhStep ? " dh-step" : ""}` });
  chip.append(
    el("span", { class: "rk-n", text: `${event.from === "alice" ? "A" : "B"} · msg ${event.wire.n}` }),
    el("div", { class: "rk-fp", text: event.ratchetFingerprint }),
    el("span", { class: "rk-tag", text: event.dhStep ? "⟳ DH step" : "chain +1" }),
  );
  ratchetEl.append(chip);

  // Captures (Exhibit B).
  for (const cap of event.captures) {
    captureListEl.append(
      el(
        "li",
        {},
        el("span", { class: "cap-meta", text: `${cap.party} · ${cap.point}` }),
        el("div", { class: "cap-text", text: cap.plaintext }),
      ),
    );
  }

  updateVerdicts();
}

function updateVerdicts(): void {
  const v = session.verdict();

  encVerdictEl.className = `verdict state-${v.encryption === "sound" ? "ok" : v.encryption === "compromised" ? "alarm" : "untested"}`;
  clear(encVerdictEl);
  encVerdictEl.append(
    el("div", { class: "v-label", text: "Message encryption" }),
    el(
      "div",
      { class: "v-status" },
      el("span", { class: "v-icon", "aria-hidden": "true", text: v.encryption === "sound" ? "✓" : v.encryption === "compromised" ? "✗" : "•" }),
      el("span", { text: v.encryptionLabel }),
    ),
    el("div", {
      class: "v-note",
      text:
        v.encryption === "untested"
          ? "No messages delivered yet. Send one and the recipient's AEAD tag is checked for real."
          : `${verifiedCount} of ${sentCount} message${sentCount === 1 ? "" : "s"} authenticated at the recipient (Double Ratchet · X25519 · HKDF-SHA256 · AES-256-GCM). Each used a fresh, one-way-derived key.`,
    }),
  );

  const compromised = v.endpoint === "compromised";
  endpointVerdictEl.className = `verdict state-${compromised ? "alarm" : "ok"}`;
  clear(endpointVerdictEl);
  endpointVerdictEl.append(
    el("div", { class: "v-label", text: "Endpoint integrity" }),
    el(
      "div",
      { class: "v-status" },
      el("span", { class: "v-icon", "aria-hidden": "true", text: compromised ? "✗" : "✓" }),
      el("span", { text: v.endpointLabel }),
    ),
    el("div", {
      class: "v-note",
      text: compromised
        ? "An implant reads plaintext at the device — before encryption and after decryption. It never needed a key."
        : "No modelled implant. (Absence of a modelled compromise is not proof a real device is clean.)",
    }),
  );

  systemVerdictEl.className = `system-verdict state-${v.systemSignal}`;
  clear(systemVerdictEl);
  systemVerdictEl.append(
    el("span", { class: "sv-icon", "aria-hidden": "true", text: v.systemSignal === "ok" ? "🛡" : v.systemSignal === "alarm" ? "🚨" : "•" }),
    el(
      "div",
      {},
      el("div", { class: "sv-title", text: v.systemLabel }),
      el("div", { class: "sv-body", text: v.headline }),
    ),
  );
}

/* ── Actions (all serialized through runOp) ───────────────────────────────── */
function sendScripted(): Promise<void> {
  return runOp(async () => {
    if (scriptIndex >= SCRIPT.length) {
      breakStatusEl.textContent = "End of the scripted exchange — compose your own below, or reset.";
      return;
    }
    const item = SCRIPT[scriptIndex];
    const event = await session.send(item.from, item.text);
    scriptIndex += 1; // advance only after the command commits
    appendEvent(event);
  });
}

function sendCustom(): Promise<void> {
  return runOp(async () => {
    const text = customInput.value.trim();
    if (!text) return;
    const event = await session.send("alice", text);
    customInput.value = "";
    appendEvent(event);
  });
}

function doWiretap(): Promise<void> {
  return runOp(async () => {
    const r = await session.wiretapAttempt();
    breakStatusEl.textContent = `🔒 Wiretap failed. ${r.reason}`;
  });
}

function doTamper(): Promise<void> {
  return runOp(async () => {
    const r = await session.tamperAndRecover();
    breakStatusEl.textContent = `${r.rejected && r.recovered ? "🛡" : "⚠"} ${r.reason}`;
  });
}

function toggleImplant(): Promise<void> {
  return runOp(async () => {
    const next = !session.implantActive;
    session.setImplant(next);
    implantSwitch.setAttribute("aria-pressed", String(next));
    const label = implantSwitch.querySelector(".switch-label");
    if (label) label.textContent = next ? "Implant deployed — click to remove" : "Deploy implant on the devices";
    implantStatusEl.textContent = next
      ? "Implant active. Send a message and watch it harvest the plaintext — while the wire and the cipher are unchanged."
      : "No implant deployed. Plaintext exists only in each device's memory.";
    if (!next) clear(captureListEl);
    updateVerdicts();
  });
}

function doReset(): Promise<void> {
  return runOp(async () => {
    const keepImplant = implantSwitch.getAttribute("aria-pressed") === "true";
    session = await Session.create();
    session.setImplant(keepImplant);
    scriptIndex = 0;
    sentCount = 0;
    verifiedCount = 0;
    clear(convoEl);
    clear(ratchetEl);
    clear(captureListEl);
    clear(wireMetaEl);
    clear(hexEl);
    wireMirrorEl.textContent = "Send a message to populate the wire.";
    breakStatusEl.textContent = "";
    errorEl.textContent = "";
    updateVerdicts();
  });
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */
async function main(): Promise<void> {
  const app = document.getElementById("app");
  if (!app) return;
  appRoot = app;
  session = await Session.create();

  clear(app);
  app.append(hero(), intro(), exhibitA(), exhibitB(), exhibitC(), exhibitD(), scoping());

  updateVerdicts();
  refreshControls();
  app.setAttribute("aria-busy", "false");
}

void main();
