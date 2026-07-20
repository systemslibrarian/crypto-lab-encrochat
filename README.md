# Encrochat

**Endpoint Compromise · eprint 2026/1319**

A browser lab that reconstructs how the Encrochat encrypted messenger was defeated
in 2020 — not by breaking its cryptography, but by compromising the endpoint. It
runs a **real Signal-protocol Double Ratchet** exchange, shows that the wire is
genuinely opaque, then deploys a modelled endpoint implant that reads the plaintext
the cryptography just protected perfectly. The primitive held. It did not matter.

> **This is a teaching demo, not production cryptography.** It runs real crypto and
> passes spec known-answer tests, but do not use it to protect real secrets.

## What It Is

The exact primitives running in your browser:

- **X25519** Diffie–Hellman (RFC 7748) — the ratchet's asymmetric step.
- **HKDF-SHA256** (RFC 5869) — the root-key KDF.
- **HMAC-SHA256** (RFC 4231) — the symmetric-chain KDF.
- **AES-256-GCM** — authenticated message encryption, header bound as associated data.
- The **Double Ratchet** itself (Perrin & Marlinspike, 2016) — hand-rolled and
  inspectable in `src/crypto/double-ratchet.ts`, because the ratchet is the subject.

The security model on display is the one the lab exists to teach: **end-to-end
encryption secures the channel between two endpoints, not the endpoints themselves.**
When code runs on the device, plaintext is readable before it is ever encrypted and
after it is decrypted — and no amount of sound cryptography changes that. Security is
a property of the whole system, not of one algorithm. Based on the public account in
Albrecht, Park, Specter & Stebila, *"A Real-World Law-Enforcement Hack: The Case of
Encrochat"* (eprint 2026/1319). **Not production crypto.**

## Exhibits

1. **A real Double Ratchet, and what the network sees** — send a scripted exchange or
   compose your own. The left pane is the plaintext conversation on the devices; the
   right pane is the exact AES-256-GCM bytes an on-path eavesdropper captures. A
   ratchet strip shows a fresh key per message and marks each DH step (`⟳`) versus a
   symmetric-only advance (`chain +1`).
2. **Break it yourself** — attempt a keyless wiretap of the ciphertext (fails), or flip
   a single bit and hand it to the real recipient (rejected). The wire has integrity,
   not just secrecy.
3. **The endpoint pivot** — deploy an implant on the devices and send a message. It
   never sees a key and never touches a ciphertext; it reads the plaintext the app
   already holds. The wire and the cipher are unchanged — the plaintext leaks anyway.
4. **Two verdicts, one that decides** — *Message encryption: SOUND ✓* sits beside
   *Endpoint integrity: COMPROMISED ✗*. The system banner tracks the weakest link, so
   sound encryption on a compromised device reads as an alarm, not a success.
5. **Why one endpoint compromise scaled to all of them** — the vertically integrated
   stack (device vendor + service provider + PKI) as the real single point of failure.

## When to Use It

- **Use it** to teach the difference between channel security and endpoint security;
  to show that "we use end-to-end encryption" is not the same claim as "your messages
  are safe"; and to see a correct Double Ratchet run and the wire it produces.
- **Do NOT** treat it as evidence that the Signal protocol or the Double Ratchet is
  weak — the entire point is that it was **not** broken. And do **not** use this code
  to secure anything real: it is a lab, not a messenger.

## Live Demo

**https://systemslibrarian.github.io/crypto-lab-encrochat/**

Send messages and watch the wire stay opaque; try to tap or tamper with the wire and
watch it fail; then deploy the endpoint implant and watch the plaintext appear at the
device while the encryption verdict stays green and the system verdict flips to alarm.

## What Can Go Wrong

The lab is a catalogue of the failure it teaches:

- **Compromised endpoint → total loss of confidentiality.** Plaintext is read before
  encryption and after decryption; forward secrecy and a perfect cipher are irrelevant.
- **Concentrated trust → compromise scales.** When one entity owns the hardware, the
  servers, and the PKI, compromising the provider compromises every endpoint at once —
  no per-user attack required.
- **Misreading the guarantee.** "End-to-end encrypted" describes the channel. It says
  nothing about who controls the ends.

## Real-World Usage

The Double Ratchet shown here is the real thing — the same construction secures
Signal, WhatsApp, and Messenger's secret conversations. The lesson generalises well
past Encrochat: endpoint security (device integrity, supply chain, what runs on the
phone) bounds what any messaging cryptography can deliver. Threat-modelling that stops
at "is the crypto strong?" misses where real systems actually fail.

## How to Run Locally

```bash
npm install
npm run dev       # http://localhost:5173/crypto-lab-encrochat/
npm test          # unit tests + spec KATs
npm run build     # typecheck + production build
npm run test:a11y # WCAG 2.1 AA gate (both themes) against the production build
```

## Related Demos

- [cipher-museum](https://systemslibrarian.github.io/cipher-museum/) — real-world case studies of ciphers and how they fell.
- [crypto-lab-x3dh-wire](https://systemslibrarian.github.io/crypto-lab-x3dh-wire/) — the X3DH initial key agreement that seeds a Double Ratchet.
- [crypto-lab-ratchet-wire](https://systemslibrarian.github.io/crypto-lab-ratchet-wire/) — the Double Ratchet on the wire, step by step.

## Build & Verify

- **30 unit tests** (Vitest), colocated as `src/**/*.test.ts`, run in CI before deploy.
- **7 spec known-answer tests** pin the primitives to their standards:
  - `src/crypto/primitives.test.ts` — HMAC-SHA256 (RFC 4231 ×2), HKDF-SHA256
    (RFC 5869 ×2), AES-256-GCM (NIST CAVP vector).
  - `src/crypto/x25519.test.ts` — X25519 (RFC 7748 §5.2 ×2).
- `src/crypto/double-ratchet.test.ts` covers round-trips across DH ratchet steps,
  on-wire opacity, fail-closed tamper rejection, and forward secrecy.
- `src/endpoint/implant.test.ts` proves the thesis: encryption sound **and** endpoint
  compromised leaks plaintext, and the system verdict tracks integrity.
- **Accessibility gate:** `@axe-core/playwright` scans the production build for zero
  WCAG 2.1 A/AA violations in **both** themes; the GitHub Pages deploy is blocked on it.

## Performance

Everything runs client-side with no backend. The whole exchange — X25519 agreement,
HKDF/HMAC chains, and AES-GCM per message — completes in single-digit milliseconds
per message via WebCrypto and `@noble/curves`; the UI never blocks.

---

*One of 120+ browser demos in the [Crypto Lab](https://crypto-lab.systemslibrarian.dev/) suite.*

*"So whether you eat or drink or whatever you do, do it all for the glory of God." — 1 Corinthians 10:31*
