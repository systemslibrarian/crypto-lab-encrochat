/**
 * Demo orchestration: a live conversation between two real Double Ratchet
 * endpoints, plus the two adversaries the lab contrasts —
 *
 *   1. the on-path NETWORK adversary, who sees only the wire and gets nothing;
 *   2. the ENDPOINT implant, who ignores the wire and reads plaintext directly.
 *
 * Every byte here is produced by the real crypto in `crypto/`. Production
 * sessions draw all key material from the platform CSPRNG — a fresh session
 * every time, so no key or IV is ever reused. A deterministic mode exists ONLY
 * for tests (opt-in), never in the shipped UI.
 */
import {
  decodeWire,
  encodeWire,
  GCM_TAG_LEN,
  initReceiver,
  initSender,
  ratchetDecrypt,
  ratchetEncrypt,
  WIRE_HEADER_LEN,
} from "./crypto/double-ratchet";
import { aesGcmDecrypt, fromUtf8, hkdfSha256, randomBytes, toHex, utf8 } from "./crypto/primitives";
import { dh, generateKeyPair } from "./crypto/x25519";
import type { RatchetState, WireMessage } from "./crypto/types";
import {
  assessSystem,
  Implant,
  type Capture,
  type Party,
  type SystemVerdict,
} from "./endpoint/implant";

export interface WireView {
  readonly headerDhHex: string;
  readonly pn: number;
  readonly n: number;
  /** The full plaintext header bytes: dh(32) || pn(4) || n(4). */
  readonly headerHex: string;
  /** Ciphertext body (without the tag). */
  readonly bodyHex: string;
  /** The 16-byte AES-GCM authentication tag. */
  readonly tagHex: string;
  /** The entire packet exactly as it crosses the network. */
  readonly packetHex: string;
  readonly headerBytes: number;
  readonly bodyBytes: number;
  readonly tagBytes: number;
  readonly totalBytes: number;
}

export interface MessageEvent {
  readonly seq: number;
  readonly from: Party;
  readonly to: Party;
  readonly plaintext: string;
  readonly wire: WireView;
  /** What the recipient's real ratchet decrypted (only set when verified). */
  readonly delivered: string;
  /** Did the recipient's AEAD tag verify? */
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
  readonly rejected: boolean;
  readonly recovered: boolean;
  /** Index (in the full packet) of the byte that was flipped. */
  readonly flippedIndex: number;
  readonly reason: string;
}

function toWireView(msg: WireMessage): WireView {
  const packet = encodeWire(msg);
  const bodyLen = msg.ciphertext.length - GCM_TAG_LEN;
  return {
    headerDhHex: toHex(msg.header.dh),
    pn: msg.header.pn,
    n: msg.header.n,
    headerHex: toHex(packet.slice(0, WIRE_HEADER_LEN)),
    bodyHex: toHex(msg.ciphertext.slice(0, bodyLen)),
    tagHex: toHex(msg.ciphertext.slice(bodyLen)),
    packetHex: toHex(packet),
    headerBytes: WIRE_HEADER_LEN,
    bodyBytes: bodyLen,
    tagBytes: GCM_TAG_LEN,
    totalBytes: packet.length,
  };
}

async function fingerprint(state: RatchetState): Promise<string> {
  // A short, non-reversible tag of the live sending chain key, purely so the UI
  // can show the chain advancing. Never exposes usable key material.
  if (!state.chainSend) return "——";
  const tag = await hkdfSha256(state.chainSend, new Uint8Array(1), utf8("fp"), 3);
  return toHex(tag);
}

/**
 * Build a fresh Double Ratchet endpoint pair sharing an initial root key. In
 * production every key is random (CSPRNG). `deterministic` is a test-only knob
 * for a reproducible transcript; it is never set by the shipped UI.
 */
async function makeEndpoints(
  deterministic: boolean,
): Promise<{ alice: RatchetState; bob: RatchetState }> {
  const seed = deterministic
    ? (label: string) => utf8(label.padEnd(32, "·")).slice(0, 32)
    : undefined;

  const aliceIdentity = generateKeyPair(seed?.("alice-identity"));
  const bobSignedPrekey = generateKeyPair(seed?.("bob-signed-prekey"));
  const bobRatchet = generateKeyPair(seed?.("bob-ratchet"));

  // Initial shared secret: Alice's identity ⋈ Bob's signed prekey (a one-DH
  // stand-in; the full X3DH agreement is the sibling lab crypto-lab-x3dh-wire).
  const rawShared = dh(aliceIdentity, bobSignedPrekey.publicKey);
  const sharedRootKey = await hkdfSha256(
    rawShared,
    new Uint8Array(32),
    utf8("Encrochat/initial-root"),
    32,
  );

  const alice = await initSender(sharedRootKey, bobRatchet.publicKey, seed?.("alice-ratchet"));
  const bob = initReceiver(sharedRootKey, bobRatchet);
  return { alice, bob };
}

export class Session {
  private alice!: RatchetState;
  private bob!: RatchetState;
  private lastWire: WireMessage | null = null;
  private seq = 0;
  private messagesVerified = 0;
  private verificationFailures = 0;
  readonly implant = new Implant();
  implantActive = false;

  private constructor() {}

  static async create(opts: { deterministic?: boolean } = {}): Promise<Session> {
    const s = new Session();
    const { alice, bob } = await makeEndpoints(opts.deterministic ?? false);
    s.alice = alice;
    s.bob = bob;
    return s;
  }

  /** True once at least one packet has been produced (gates the attack controls). */
  hasPacket(): boolean {
    return this.lastWire !== null;
  }

  /**
   * Send one message end-to-end. Runs the real encrypt → wire → decrypt path.
   * The implant decision is read ONCE, up front, so a mid-flight toggle cannot
   * capture only one side of a single message.
   */
  async send(from: Party, plaintext: string): Promise<MessageEvent> {
    const to: Party = from === "alice" ? "bob" : "alice";
    const sender = from === "alice" ? this.alice : this.bob;
    const receiver = from === "alice" ? this.bob : this.alice;
    const implantOn = this.implantActive;

    const captures: Capture[] = [];
    // (1) Endpoint implant reads the composed plaintext BEFORE encryption.
    if (implantOn) captures.push(this.implant.captureOutbound(from, plaintext));

    // (2) Real Double Ratchet encryption.
    const wire = await ratchetEncrypt(sender, utf8(plaintext));
    this.lastWire = wire;
    const ratchetFingerprint = await fingerprint(sender);

    // (3) Real, transactional Double Ratchet decryption at the receiver.
    const remoteBefore = receiver.dhRemote;
    let delivered = "";
    let verified = false;
    try {
      const pt = await ratchetDecrypt(receiver, wire);
      delivered = fromUtf8(pt);
      verified = true;
      this.messagesVerified += 1;
    } catch {
      verified = false;
      this.verificationFailures += 1;
    }
    const dhStep = remoteBefore === null || !sameBytes(remoteBefore, wire.header.dh);

    // (4) Endpoint implant reads the delivered plaintext AFTER decryption.
    if (implantOn && verified) captures.push(this.implant.captureInbound(to, delivered));

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
   * the keys. Runs a REAL AES-GCM decryption with a random wrong key; it fails.
   * This is a demonstrated failed attempt plus the security assumption — not a
   * proof of a general indistinguishability theorem.
   */
  async wiretapAttempt(): Promise<WiretapResult> {
    if (!this.lastWire) return { ok: false, reason: "No packet on the wire yet." };
    const wrongKey = randomBytes(32);
    try {
      await aesGcmDecrypt(wrongKey, new Uint8Array(12), this.lastWire.ciphertext, new Uint8Array(0));
      return { ok: false, reason: "Decryption unexpectedly returned — should never happen." };
    } catch {
      return {
        ok: false,
        reason:
          "AES-256-GCM authentication failed. Without the ratchet's message key this attempt yields nothing; under standard AEAD assumptions the ciphertext leaks only its length.",
      };
    }
  }

  /**
   * Integrity + recovery experiment on a REAL ratchet packet. A fresh, isolated
   * exchange encrypts an authentic packet; one ciphertext bit is flipped and the
   * tampered packet is delivered to the real (transactional) recipient — which
   * rejects it WITHOUT mutating state. The authentic packet is then delivered
   * and still decrypts, proving a forged packet poisons nothing.
   */
  async tamperAndRecover(): Promise<TamperResult> {
    const { alice, bob } = await makeEndpoints(false);
    const authentic = await ratchetEncrypt(alice, utf8("meet at the usual place"));
    const packet = encodeWire(authentic);
    const flippedIndex = WIRE_HEADER_LEN + 1; // a ciphertext-body byte
    const tampered = new Uint8Array(packet);
    tampered[flippedIndex] ^= 0x01;

    let rejected = false;
    try {
      await ratchetDecrypt(bob, decodeWire(tampered));
    } catch {
      rejected = true;
    }

    let recovered = false;
    try {
      recovered = fromUtf8(await ratchetDecrypt(bob, decodeWire(packet))) === "meet at the usual place";
    } catch {
      recovered = false;
    }

    return {
      rejected,
      recovered,
      flippedIndex,
      reason:
        rejected && recovered
          ? `Byte ${flippedIndex} flipped: AES-256-GCM rejected the forged packet, and because rejection commits no state, the authentic packet still decrypted. Integrity and recovery, not just secrecy.`
          : "Unexpected: the integrity experiment did not behave as required.",
    };
  }

  setImplant(active: boolean): void {
    this.implantActive = active;
    if (!active) this.implant.clear();
  }

  verdict(): SystemVerdict {
    return assessSystem({
      messagesVerified: this.messagesVerified,
      verificationFailures: this.verificationFailures,
      endpointCompromised: this.implantActive,
    });
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
