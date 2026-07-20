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

/** How a lay observer would read one component's status. */
export type Integrity = "sound" | "compromised";
/** The colour/urgency an indicator should carry. */
export type Signal = "ok" | "alarm";

export interface SystemVerdict {
  /** Did the message encryption do its job (all AEAD tags verified, FS intact)? */
  readonly encryption: Integrity;
  /** Is the device the plaintext lives on trustworthy? */
  readonly endpoint: Integrity;
  /**
   * The verdict that actually matters. Security is a system property: if the
   * endpoint is compromised, the SYSTEM is compromised — no matter how sound the
   * encryption is. Colour tracks system integrity, never the raw crypto result,
   * so "encryption sound but plaintext harvested" reads as ALARM, not success.
   */
  readonly system: Integrity;
  readonly systemSignal: Signal;
  readonly headline: string;
}

/**
 * Combine the two independent axes into the system verdict. The crux: sound
 * encryption does NOT upgrade a compromised endpoint. The weakest link decides.
 */
export function assessSystem(input: {
  encryptionSound: boolean;
  endpointCompromised: boolean;
}): SystemVerdict {
  const encryption: Integrity = input.encryptionSound ? "sound" : "compromised";
  const endpoint: Integrity = input.endpointCompromised ? "compromised" : "sound";
  const system: Integrity =
    input.encryptionSound && !input.endpointCompromised ? "sound" : "compromised";

  let headline: string;
  if (system === "sound") {
    headline = "Channel and endpoints intact — plaintext is confidential.";
  } else if (input.encryptionSound && input.endpointCompromised) {
    headline =
      "Encryption held; the endpoint did not. Plaintext was read before it was ever encrypted.";
  } else {
    headline = "Encryption itself failed.";
  }

  return {
    encryption,
    endpoint,
    system,
    systemSignal: system === "sound" ? "ok" : "alarm",
    headline,
  };
}
