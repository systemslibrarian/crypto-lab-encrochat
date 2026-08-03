/**
 * The endpoint-compromise model — the heart of what this lab teaches.
 *
 * An "implant" is any code running ON the device with access to the messaging
 * app's memory. It does NOT attack the cryptography: it never sees a private
 * key, a chain key, or the ratchet state, and it never touches a ciphertext.
 * It simply reads the plaintext the application is already holding — the message
 * the user typed, before it is handed to the ratchet, and the message that comes
 * back out of the ratchet, after it is decrypted.
 *
 * That is the entire lesson: end-to-end encryption protects the channel between
 * the endpoints, not the endpoints themselves. When the endpoint is compromised,
 * the plaintext is read before it is ever encrypted, and the primitive — which
 * held perfectly — did not matter.
 *
 * INVARIANT (enforced by the types below): the implant's capture methods accept
 * only already-decrypted plaintext. There is deliberately no path here that
 * takes a key, a `RatchetState`, or a `WireMessage`. The implant cannot weaken
 * the crypto because it is architecturally denied the crypto.
 *
 * Non-goal, per the brief: this file models the PRINCIPLE (plaintext is readable
 * at a compromised endpoint). It contains no method, mechanism, or operational
 * detail for achieving endpoint compromise, and never will.
 */

export type Party = "alice" | "bob";
export type CapturePoint = "pre-encryption" | "post-decryption";

/** One line of plaintext harvested at the device. */
export interface Capture {
  readonly party: Party;
  readonly point: CapturePoint;
  readonly plaintext: string;
  /** Monotonic index in capture order (no wall-clock — keeps the demo reproducible). */
  readonly seq: number;
}

/**
 * A passive endpoint implant. Append-only log of plaintext it observed. It is
 * given plaintext strings and nothing else — see the file-level invariant.
 */
export class Implant {
  private readonly log: Capture[] = [];
  private seq = 0;

  /** Read the message the user composed, before the app encrypts it. */
  captureOutbound(party: Party, plaintext: string): Capture {
    const entry: Capture = { party, point: "pre-encryption", plaintext, seq: this.seq++ };
    this.log.push(entry);
    return entry;
  }

  /** Read the message the app just decrypted, after the ratchet returns it. */
  captureInbound(party: Party, plaintext: string): Capture {
    const entry: Capture = { party, point: "post-decryption", plaintext, seq: this.seq++ };
    this.log.push(entry);
    return entry;
  }

  captures(): readonly Capture[] {
    return this.log;
  }

  transcript(): string {
    return this.log.map((c) => c.plaintext).join("\n");
  }

  clear(): void {
    this.log.length = 0;
    this.seq = 0;
  }
}

/**
 * A component's status, derived from OBSERVED evidence. `untested` is a real,
 * distinct state — the absence of a modelled compromise is not proof of safety,
 * and zero messages is not proof the encryption works.
 */
export type Integrity = "sound" | "compromised" | "untested";
/** The colour/urgency an indicator should carry. */
export type Signal = "ok" | "alarm" | "neutral";

/** Evidence recorded from what actually happened this session. */
export interface Evidence {
  /** Messages whose recipient AEAD tag verified and decrypted. */
  readonly messagesVerified: number;
  /** Messages whose authentication failed on the honest delivery path. */
  readonly verificationFailures: number;
  /** Is a modelled implant currently deployed on the endpoints? */
  readonly endpointCompromised: boolean;
}

export interface SystemVerdict {
  /** Encryption status from observed tag verifications, not from a send counter. */
  readonly encryption: Integrity;
  readonly encryptionLabel: string;
  /** Endpoint status from whether a modelled implant is deployed. */
  readonly endpoint: Integrity;
  readonly endpointLabel: string;
  /**
   * The verdict that actually matters. Security is a system property: if the
   * endpoint is compromised, the SYSTEM is compromised — no matter how sound the
   * encryption is. Colour tracks system integrity, never the raw crypto result,
   * so "encryption sound but plaintext harvested" reads as ALARM, not success.
   */
  readonly system: Integrity;
  readonly systemLabel: string;
  readonly systemSignal: Signal;
  readonly headline: string;
}

/**
 * Derive the verdict strictly from recorded evidence. The crux: sound encryption
 * does NOT upgrade a compromised endpoint (the weakest link decides), and a state
 * that was never observed reads as `untested`, never green.
 */
export function assessSystem(e: Evidence): SystemVerdict {
  const encryption: Integrity =
    e.verificationFailures > 0 ? "compromised" : e.messagesVerified > 0 ? "sound" : "untested";

  const endpoint: Integrity = e.endpointCompromised ? "compromised" : "sound";

  const system: Integrity =
    encryption === "compromised" || e.endpointCompromised
      ? "compromised"
      : encryption === "sound"
        ? "sound"
        : "untested";

  const encryptionLabel =
    encryption === "compromised" ? "FAILED" : encryption === "sound" ? "SOUND" : "NOT YET TESTED";
  const endpointLabel = e.endpointCompromised ? "COMPROMISED" : "NO MODELLED COMPROMISE";
  const systemLabel =
    system === "compromised"
      ? "SYSTEM COMPROMISED"
      : system === "sound"
        ? "SECURE UNDER THIS LAB'S ASSUMPTIONS"
        : "AWAITING EVIDENCE";

  let headline: string;
  if (system === "untested") {
    headline = "No messages sent yet and no implant deployed — nothing has been observed.";
  } else if (encryption === "compromised") {
    headline = "A message failed authentication — the encryption result is not sound this session.";
  } else if (e.endpointCompromised) {
    // "Encryption held" is itself an evidence claim, so it may only be made once
    // a tag has actually verified. With an implant deployed but nothing sent, the
    // encryption axis is `untested`, and a headline asserting it held would
    // contradict the very panel next to it.
    headline =
      encryption === "sound"
        ? "Encryption held; the endpoint did not. Plaintext is read at the device, before it is ever encrypted."
        : "No message has been sent yet, so the encryption is untested — but an implant already reads plaintext at the device.";
  } else {
    headline = "Every delivered message authenticated, and no endpoint compromise is modelled.";
  }

  return {
    encryption,
    encryptionLabel,
    endpoint,
    endpointLabel,
    system,
    systemLabel,
    systemSignal: system === "sound" ? "ok" : system === "compromised" ? "alarm" : "neutral",
    headline,
  };
}
