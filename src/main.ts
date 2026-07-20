import "./style.css";
import { clear, el } from "./dom";
import { Session, type MessageEvent } from "./session";
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

/* Dynamic regions, wired once and updated in place. */
let convoEl: HTMLElement;
let wireMetaEl: HTMLElement;
let hexEl: HTMLElement;
let ratchetEl: HTMLElement;
let breakStatusEl: HTMLElement;
let sendScriptBtn: HTMLButtonElement;
let customInput: HTMLInputElement;
let implantSwitch: HTMLButtonElement;
let implantStatusEl: HTMLElement;
let captureListEl: HTMLElement;
let wireMirrorEl: HTMLElement;
let encVerdictEl: HTMLElement;
let endpointVerdictEl: HTMLElement;
let systemVerdictEl: HTMLElement;

let messageCount = 0;

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
        text: "Run a real Signal-protocol Double Ratchet exchange, watch the wire stay opaque, then deploy an endpoint implant and see it read the plaintext the cryptography just protected perfectly.",
      }),
    ),
    el(
      "aside",
      { class: "cl-hero-why", "aria-label": "Why it matters" },
      el("span", { class: "cl-hero-why-label", text: "WHY IT MATTERS" }),
      el("p", {
        class: "cl-hero-why-text",
        text: "In 2020, Encrochat's encrypted messages were read by the million — not by breaking the maths, but by owning the phones. Unbreakable encryption is worthless the moment the device it runs on is not yours.",
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
      text: "Encrochat sold phones that did exactly this, correctly, using the same Double Ratchet protocol behind Signal and WhatsApp. It was still defeated. Not by cracking the encryption — by putting code on the phone itself, where the message exists as plain text before it is ever encrypted and after it is decrypted.",
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
      text: "Every message below is genuinely encrypted in your browser with X25519, HKDF-SHA256 and AES-256-GCM. The left pane is the conversation; the right pane is the exact bytes an on-path eavesdropper captures.",
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
    "aria-label": "Ciphertext bytes visible on the wire",
  });
  const wirePane = el(
    "div",
    {},
    el(
      "div",
      { class: "pane-label" },
      el("span", { "aria-hidden": "true", text: "📡" }),
      el("span", { text: "On the wire (what an eavesdropper captures)" }),
    ),
    el(
      "div",
      { class: "wire" },
      wireMetaEl,
      hexEl,
      el("p", {
        class: "wire-verdict",
        text: "This is the entire message as it crosses the network. No key, no plaintext — just an authenticated blob.",
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
  const resetBtn = el("button", { class: "btn", type: "button", text: "Reset conversation" }) as HTMLButtonElement;
  resetBtn.addEventListener("click", () => void reset());
  card.append(el("div", { class: "controls" }, sendScriptBtn, resetBtn));

  // Compose your own.
  customInput = el("input", {
    type: "text",
    id: "custom-msg",
    placeholder: "Type a message to send as Alice…",
    maxlength: "120",
  }) as HTMLInputElement;
  const customSend = el("button", { class: "btn", type: "button", text: "Encrypt & send" }) as HTMLButtonElement;
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
  breakStatusEl = el("div", {
    class: "break-status",
    role: "status",
    "aria-live": "polite",
  });
  const tapBtn = el("button", { class: "btn", type: "button" }) as HTMLButtonElement;
  tapBtn.append(el("span", { "aria-hidden": "true", text: "🕵" }), document.createTextNode(" Tap the wire (no keys)"));
  tapBtn.addEventListener("click", () => void doWiretap());
  const tamperBtn = el("button", { class: "btn", type: "button" }) as HTMLButtonElement;
  tamperBtn.append(el("span", { "aria-hidden": "true", text: "✂" }), document.createTextNode(" Flip a bit of ciphertext"));
  tamperBtn.addEventListener("click", () => void doTamper());

  const breakBlock = el("details", { class: "more" });
  breakBlock.append(
    el("summary", { text: "Break it yourself — try to read or forge the wire" }),
    el(
      "div",
      {},
      el("p", {
        text: "The network adversary has the full ciphertext. Give them the best shot: attempt a decryption without the key, or tamper with a byte and hand it to the real recipient.",
      }),
      el("div", { class: "controls" }, tapBtn, tamperBtn),
      breakStatusEl,
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

  implantSwitch = el("button", {
    class: "switch",
    type: "button",
    "aria-pressed": "false",
  }) as HTMLButtonElement;
  implantSwitch.append(
    el("span", { class: "dot", "aria-hidden": "true" }),
    el("span", { class: "switch-label", text: "Deploy implant on the devices" }),
  );
  implantSwitch.addEventListener("click", toggleImplant);

  implantStatusEl = el("div", {
    class: "hint",
    role: "status",
    "aria-live": "polite",
    text: "Endpoints clean. Plaintext exists only in each device's memory.",
  });
  card.append(el("div", { class: "toggle-row" }, implantSwitch, implantStatusEl));

  // Side-by-side: the wire (unchanged) vs the endpoint (leaking).
  wireMirrorEl = el("p", {
    class: "hint",
    text: "Send a message to populate the wire.",
  });
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
      text: "Message encryption and endpoint integrity are independent axes. A green cipher does not upgrade a red device — the weakest link sets the system verdict, and the colour tracks the system.",
    }),
  );

  encVerdictEl = el("div", { class: "verdict" });
  endpointVerdictEl = el("div", { class: "verdict" });
  systemVerdictEl = el("div", {
    class: "system-verdict",
    role: "status",
    "aria-live": "polite",
  });

  const card = el("section", { class: "card" });
  card.append(
    el("div", { class: "verdict-grid" }, encVerdictEl, endpointVerdictEl),
    systemVerdictEl,
  );
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
        text: "Session setup seeds the initial root key from a single X25519 handshake for clarity; the full X3DH initial agreement (identity, signed prekey, one-time prekey) is the sibling lab crypto-lab-x3dh-wire. Out-of-order and skipped-message handling is omitted — the demo delivers in order.",
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
      el("li", {}, el("b", { text: "Real: " }), "the Double Ratchet, X25519, HKDF-SHA256 and AES-256-GCM all run for real and pass spec known-answer tests. Ciphertext on the wire is genuinely opaque and tamper-evident."),
      el("li", {}, el("b", { text: "Modelled: " }), "the endpoint implant is a stand-in for “code on the device” — it reads app plaintext directly. It carries no technique for getting there."),
      el("li", {}, el("b", { text: "What it does NOT prove: " }), "nothing here weakens the Signal protocol or the Double Ratchet. The point is the opposite — the cryptography was sound and the system still failed at the endpoint."),
      el("li", {}, "Based on the public account in Albrecht, Park, Specter & Stebila, ", el("i", { text: "“A Real-World Law-Enforcement Hack: The Case of Encrochat”" }), " (eprint 2026/1319). No attribution or legal commentary."),
    ),
  );
  return card;
}

/* ── Rendering updates ────────────────────────────────────────────────────── */
function appendEvent(event: MessageEvent): void {
  messageCount += 1;

  const bubble = el(
    "div",
    { class: `bubble from-${event.from}` },
    el("div", { class: "who", text: event.from === "alice" ? "Alice" : "Bob" }),
    el("div", { class: "text", text: event.plaintext }),
  );
  convoEl.append(bubble);
  convoEl.scrollTop = convoEl.scrollHeight;

  // Wire pane — latest ciphertext.
  clear(wireMetaEl);
  wireMetaEl.append(
    el("span", {}, "dh ", el("b", { text: event.wire.headerDhHex.slice(0, 16) + "…" })),
    el("span", {}, "pn ", el("b", { text: String(event.wire.pn) })),
    el("span", {}, "n ", el("b", { text: String(event.wire.n) })),
    el("span", {}, "bytes ", el("b", { text: String(event.wire.byteLength) })),
  );
  hexEl.textContent = event.wire.ciphertextHex;

  // Wire mirror in Exhibit B.
  wireMirrorEl.textContent = `Latest ciphertext: ${event.wire.byteLength} bytes, header + AES-256-GCM tag. Identical whether or not the implant is deployed.`;

  // Ratchet chip.
  const chip = el("li", { class: `rk-chip${event.dhStep ? " dh-step" : ""}` });
  chip.append(
    el("span", { class: "rk-n", text: `${event.from === "alice" ? "A" : "B"} · msg ${event.wire.n}` }),
    el("div", { class: "rk-fp", text: event.ratchetFingerprint }),
    event.dhStep
      ? el("span", { class: "rk-tag", text: "⟳ DH step" })
      : el("span", { class: "rk-tag", text: "chain +1" }),
  );
  ratchetEl.append(chip);

  // Captures (Exhibit B).
  for (const cap of event.captures) {
    const li = el("li", {});
    li.append(
      el("span", { class: "cap-meta", text: `${cap.party} · ${cap.point}` }),
      el("div", { class: "cap-text", text: cap.plaintext }),
    );
    captureListEl.append(li);
  }

  updateVerdicts();
}

function updateVerdicts(): void {
  const v = session.verdict();

  // Encryption card — always sound on the honest path.
  encVerdictEl.className = "verdict state-ok";
  clear(encVerdictEl);
  encVerdictEl.append(
    el("div", { class: "v-label", text: "Message encryption" }),
    el(
      "div",
      { class: "v-status" },
      el("span", { class: "v-icon", "aria-hidden": "true", text: "✓" }),
      el("span", { text: "SOUND" }),
    ),
    el("div", {
      class: "v-note",
      text: `Double Ratchet over X25519 · HKDF-SHA256 · AES-256-GCM. ${messageCount} message${messageCount === 1 ? "" : "s"} sent, every AEAD tag verified. Each message used a fresh, one-way-derived key.`,
    }),
  );

  // Endpoint card — tracks the implant.
  const compromised = session.implantActive;
  endpointVerdictEl.className = `verdict ${compromised ? "state-alarm" : "state-ok"}`;
  clear(endpointVerdictEl);
  endpointVerdictEl.append(
    el("div", { class: "v-label", text: "Endpoint integrity" }),
    el(
      "div",
      { class: "v-status" },
      el("span", { class: "v-icon", "aria-hidden": "true", text: compromised ? "✗" : "✓" }),
      el("span", { text: compromised ? "COMPROMISED" : "INTACT" }),
    ),
    el("div", {
      class: "v-note",
      text: compromised
        ? "An implant reads plaintext at the device — before encryption and after decryption. It never needed a key."
        : "No implant. Plaintext lives only in each device's memory and is never exposed.",
    }),
  );

  // System banner.
  systemVerdictEl.className = `system-verdict ${v.systemSignal === "ok" ? "state-ok" : "state-alarm"}`;
  clear(systemVerdictEl);
  systemVerdictEl.append(
    el("span", { class: "sv-icon", "aria-hidden": "true", text: v.systemSignal === "ok" ? "🛡" : "🚨" }),
    el(
      "div",
      {},
      el("div", {
        class: "sv-title",
        text: v.system === "sound" ? "SYSTEM SECURE" : "SYSTEM COMPROMISED",
      }),
      el("div", { class: "sv-body", text: v.headline }),
    ),
  );
}

/* ── Actions ──────────────────────────────────────────────────────────────── */
async function sendScripted(): Promise<void> {
  if (scriptIndex >= SCRIPT.length) {
    breakStatusEl.textContent = "End of the scripted exchange — compose your own below, or reset.";
    sendScriptBtn.disabled = true;
    return;
  }
  const { from, text } = SCRIPT[scriptIndex++];
  const event = await session.send(from, text);
  appendEvent(event);
  if (scriptIndex >= SCRIPT.length) sendScriptBtn.disabled = true;
}

async function sendCustom(): Promise<void> {
  const text = customInput.value.trim();
  if (!text) return;
  customInput.value = "";
  const event = await session.send("alice", text);
  appendEvent(event);
}

async function doWiretap(): Promise<void> {
  const r = await session.wiretapAttempt();
  breakStatusEl.textContent = `🔒 Wiretap failed. ${r.reason}`;
}

async function doTamper(): Promise<void> {
  const r = await session.tamperAttempt();
  breakStatusEl.textContent = `🛡 Tamper rejected. ${r.reason}`;
}

function toggleImplant(): void {
  const next = !session.implantActive;
  session.setImplant(next);
  implantSwitch.setAttribute("aria-pressed", String(next));
  const label = implantSwitch.querySelector(".switch-label");
  if (label) label.textContent = next ? "Implant deployed — click to remove" : "Deploy implant on the devices";
  implantStatusEl.textContent = next
    ? "Implant active. Send a message and watch it harvest the plaintext — while the wire and the cipher are unchanged."
    : "Endpoints clean. Plaintext exists only in each device's memory.";
  if (!next) clear(captureListEl);
  updateVerdicts();
}

async function reset(): Promise<void> {
  session = await Session.create();
  session.setImplant(implantSwitch.getAttribute("aria-pressed") === "true");
  scriptIndex = 0;
  messageCount = 0;
  sendScriptBtn.disabled = false;
  clear(convoEl);
  clear(ratchetEl);
  clear(captureListEl);
  clear(wireMetaEl);
  hexEl.textContent = "";
  wireMirrorEl.textContent = "Send a message to populate the wire.";
  breakStatusEl.textContent = "";
  updateVerdicts();
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */
async function main(): Promise<void> {
  const app = document.getElementById("app");
  if (!app) return;
  session = await Session.create();

  clear(app);
  app.append(hero(), intro(), exhibitA(), exhibitB(), exhibitC(), exhibitD(), scoping());

  updateVerdicts();
}

void main();
