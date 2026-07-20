/** Shared types for the Double Ratchet and the demo session. */
import type { KeyPair } from "./x25519";

/** The plaintext header that travels (in the clear) alongside each ciphertext. */
export interface Header {
  /** Sender's current ratchet public key (32 bytes). */
  readonly dh: Uint8Array;
  /** Number of messages in the previous sending chain. */
  readonly pn: number;
  /** Message number within the current sending chain. */
  readonly n: number;
}

/** One wire message: exactly what an on-path network adversary observes. */
export interface WireMessage {
  readonly header: Header;
  /** AES-256-GCM ciphertext || 16-byte tag. Opaque without the message key. */
  readonly ciphertext: Uint8Array;
}

/** Mutable Double Ratchet state for one party. Keys are 32 bytes each. */
export interface RatchetState {
  dhSelf: KeyPair;
  dhRemote: Uint8Array | null;
  rootKey: Uint8Array;
  chainSend: Uint8Array | null;
  chainRecv: Uint8Array | null;
  sendCount: number;
  recvCount: number;
  prevChainLen: number;
}
