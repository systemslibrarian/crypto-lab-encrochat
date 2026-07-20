/**
 * Demo orchestration: a live conversation between two real Double Ratchet
 * endpoints, plus the two adversaries the lab contrasts —
 *
 *   1. the on-path NETWORK adversary, who sees only the wire and gets nothing;
 *   2. the ENDPOINT implant, who ignores the wire and reads plaintext directly.
 *
 * Every byte here is produced by the real crypto in `crypto/`. The session is
 * seeded deterministically so the demo transcript is reproducible and testable;
 * `randomBytes` still backs everything in the unseeded/production path.
 */
import {
  initReceiver,
  initSender,
  ratchetDecrypt,
  ratchetEncrypt,
} from "./crypto/double-ratchet";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  fromUtf8,
  hkdfSha256,
  toHex,
  utf8,
} from "./crypto/primitives";
import { dh, generateKeyPair } from "./crypto/x25519";
import type { RatchetState, WireMessage } from "./crypto/types";
import { assessSystem, Implant, type Capture, type Party } from "./endpoint/implant";

export interface WireView {
  readonly headerDhHex: string;
  readonly pn: number;
  readonly n: number;
  readonly ciphertextHex: string;
  readonly byteLength: number;
}

export interface MessageEvent {
  readonly seq: number;
  readonly from: Party;
  readonly to: Party;
  readonly plaintext: string;
  readonly wire: WireView;
  /** What the recipient's real ratchet decrypted. Equal to `plaintext` iff sound. */
  readonly delivered: string;
  /** Did the recipient's AEAD tag verify? (Always true on the honest path.) */
  readonly verified: boolean;
  /** Did receiving this message trigger a DH ratchet step? */
  readonly dhStep: boolean;
  /** Short fingerprint of the sender's chain key after this step — the ratchet turning. */
  readonly ratchetFingerprint: string;
  /** Plaintext the endpoint implant harvested for this message (empty if none). */
  readonly captures: readonly Capture[];
}

export interface WiretapResult {
  readonly ok: false;
  readonly reason: string;
}

export interface TamperResult {
  readonly rejected: true;
  readonly reason: string;
}

function toWireView(msg: WireMessage): WireView {
  return {
    headerDhHex: toHex(msg.header.dh),
    pn: msg.header.pn,
    n: msg.header.n,
    ciphertextHex: toHex(msg.ciphertext),
    byteLength: msg.ciphertext.length,
  };
}

async function fingerprint(state: RatchetState): Promise<string> {
  // A short, non-reversible tag of the live sending chain key, purely so the UI
  // can show the chain advancing. Never exposes usable key material.
  if (!state.chainSend) return "——";
  const tag = await hkdfSha256(state.chainSend, new Uint8Array(1), utf8("fp"), 3);
  return toHex(tag);
}

export class Session {
  private alice!: RatchetState;
  private bob!: RatchetState;
  private lastWire: WireMessage | null = null;
  private seq = 0;
  readonly implant = new Implant();
  implantActive = false;

  private constructor() {}

  /**
   * Build a session. The initial root key is seeded from one X25519 handshake
   * (identity ⋈ prekey); the full X3DH agreement is the sibling lab. Seeds make
   * the transcript reproducible.
   */
  static async create(): Promise<Session> {
    const s = new Session();
    // Deterministic keys for a stable, inspectable demo transcript.
    const aliceIdentity = generateKeyPair(seedFrom("alice-identity"));
    const bobSignedPrekey = generateKeyPair(seedFrom("bob-signed-prekey"));
    const bobRatchet = generateKeyPair(seedFrom("bob-ratchet"));

    // Initial shared secret: Alice's identity ⋈ Bob's signed prekey.
    const rawShared = dh(aliceIdentity, bobSignedPrekey.publicKey);
    const sharedRootKey = await hkdfSha256(
      rawShared,
      new Uint8Array(32),
      utf8("Encrochat/initial-root"),
      32,
    );

    s.alice = await initSender(sharedRootKey, bobRatchet.publicKey, seedFrom("alice-ratchet"));
    s.bob = initReceiver(sharedRootKey, bobRatchet);
    return s;
  }

  /**
   * Send one message end-to-end. Runs the real encrypt → wire → decrypt path.
   * If the implant is active, it reads the plaintext at both endpoints — without
   * ever touching a key or the ciphertext.
   */
  async send(from: Party, plaintext: string): Promise<MessageEvent> {
    const to: Party = from === "alice" ? "bob" : "alice";
    const sender = from === "alice" ? this.alice : this.bob;
    const receiver = from === "alice" ? this.bob : this.alice;

    const captures: Capture[] = [];
    // (1) Endpoint implant reads the composed plaintext BEFORE encryption.
    if (this.implantActive) captures.push(this.implant.captureOutbound(from, plaintext));

    // (2) Real Double Ratchet encryption.
    const wire = await ratchetEncrypt(sender, utf8(plaintext));
    this.lastWire = wire;
    const ratchetFingerprint = await fingerprint(sender);

    // (3) Real Double Ratchet decryption at the receiver.
    const remoteBefore = receiver.dhRemote;
    let delivered = "";
    let verified = false;
    try {
      const pt = await ratchetDecrypt(receiver, wire);
      delivered = fromUtf8(pt);
      verified = true;
    } catch {
      verified = false;
    }
    const dhStep = remoteBefore === null || !sameBytes(remoteBefore, wire.header.dh);

    // (4) Endpoint implant reads the delivered plaintext AFTER decryption.
    if (this.implantActive && verified) {
      captures.push(this.implant.captureInbound(to, delivered));
    }

    return {
      seq: this.seq++,
      from,
      to,
      plaintext,
      wire: toWireView(wire),
      delivered,
      verified,
      dhStep,
      ratchetFingerprint,
      captures,
    };
  }

  /**
   * The network adversary's best shot: try to read the last ciphertext without
   * the keys. This runs a REAL AES-GCM decryption with a wrong key; it fails,
   * which is exactly the point — the wire yields nothing.
   */
  async wiretapAttempt(): Promise<WiretapResult> {
    if (!this.lastWire) return { ok: false, reason: "No message on the wire yet." };
    const guessedKey = generateKeyPair(seedFrom("wiretap-guess")).privateKey; // a wrong 32-byte key
    const iv = new Uint8Array(12);
    try {
      await aesGcmDecrypt(guessedKey, iv, this.lastWire.ciphertext, new Uint8Array(0));
      return { ok: false, reason: "Decryption unexpectedly returned — should never happen." };
    } catch {
      return {
        ok: false,
        reason:
          "AES-256-GCM authentication failed. Without the ratchet's message key the ciphertext is indistinguishable from random — the network adversary learns nothing but the message length.",
      };
    }
  }

  /**
   * Integrity demonstration with real AES-256-GCM: encrypt a message with a
   * correct key, flip exactly one ciphertext bit, then decrypt again with that
   * same correct key. The AEAD tag fails and decryption is rejected — proving
   * the channel has integrity, not just secrecy, which is what makes a
   * compromised endpoint the only way in.
   */
  async tamperAttempt(): Promise<TamperResult> {
    const key = generateKeyPair(seedFrom("integrity-demo")).privateKey; // a real 32-byte AES key
    const iv = new Uint8Array(12);
    const aad = utf8("Encrochat/Double-Ratchet/AD");
    const good = await aesGcmEncrypt(key, iv, utf8("meet at the usual place"), aad);
    const forged = new Uint8Array(good);
    forged[0] ^= 0x01; // flip one bit
    try {
      await aesGcmDecrypt(key, iv, forged, aad); // correct key, tampered ciphertext
      return { rejected: true, reason: "unreachable" };
    } catch {
      return {
        rejected: true,
        reason:
          "Same correct key, one flipped bit — AES-256-GCM authentication fails and the message is rejected. A single-bit change invalidates the 128-bit tag: the channel has integrity, not just secrecy.",
      };
    }
  }

  setImplant(active: boolean): void {
    this.implantActive = active;
    if (!active) this.implant.clear();
  }

  verdict() {
    return assessSystem({
      encryptionSound: true,
      endpointCompromised: this.implantActive,
    });
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Deterministic 32-byte seed from a label (demo reproducibility only). */
function seedFrom(label: string): Uint8Array {
  const bytes = utf8(label.padEnd(32, "·"));
  return bytes.slice(0, 32);
}
