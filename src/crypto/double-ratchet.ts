/**
 * The Signal Double Ratchet — hand-rolled and inspectable, because the ratchet
 * IS the teaching subject here. It is built on the real primitives in
 * `primitives.ts` and the real X25519 in `x25519.ts`; nothing is faked.
 *
 * This is the protocol that kept Encrochat's message content perfectly secret
 * on the wire. The lab's whole point is that it held — and that holding was not
 * enough, because the plaintext was read on the device, before it ever reached
 * this code. See `../endpoint/implant.ts`.
 *
 * Design follows the Signal spec (Perrin & Marlinspike, "The Double Ratchet
 * Algorithm", 2016):
 *   - KDF_RK: HKDF-SHA256 over the root key advances the root chain on each DH step.
 *   - KDF_CK: HMAC-SHA256 with distinct constants advances a symmetric chain and
 *             emits a per-message key (forward secrecy: keys are one-way derived).
 *   - Messages: AES-256-GCM with the header bound as AEAD associated data.
 *
 * Scope honesty: session setup here seeds the initial root key from a single
 * X25519 handshake for clarity. The full X3DH initial agreement (identity +
 * signed prekey + one-time prekey) is a separate lab, crypto-lab-x3dh-wire.
 */
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  concat,
  hkdfSha256,
  hmacSha256,
  utf8,
} from "./primitives";
import { dh, generateKeyPair, type KeyPair } from "./x25519";
import type { Header, RatchetState, WireMessage } from "./types";

const ROOT_INFO = utf8("Encrochat/Double-Ratchet/Root");
const MSG_INFO = utf8("Encrochat/Double-Ratchet/Message");
const CHAIN_MSG_CONST = new Uint8Array([0x01]);
const CHAIN_NEXT_CONST = new Uint8Array([0x02]);
/** Fixed associated data mixed into every message header binding. */
const ASSOCIATED_DATA = utf8("Encrochat/Double-Ratchet/AD");

/**
 * KDF_RK — advance the root chain. HKDF-SHA256(salt = root key, ikm = DH output)
 * yields a fresh 32-byte root key and a fresh 32-byte chain key.
 */
async function kdfRootKey(
  rootKey: Uint8Array,
  dhOut: Uint8Array,
): Promise<{ rootKey: Uint8Array; chainKey: Uint8Array }> {
  const okm = await hkdfSha256(dhOut, rootKey, ROOT_INFO, 64);
  return { rootKey: okm.slice(0, 32), chainKey: okm.slice(32, 64) };
}

/**
 * KDF_CK — advance a symmetric chain by one step. HMAC-SHA256(chainKey, 0x02)
 * is the next chain key; HMAC-SHA256(chainKey, 0x01) is this step's message key.
 * One-way: knowing a later chain key never reveals an earlier message key.
 */
async function kdfChainKey(
  chainKey: Uint8Array,
): Promise<{ chainKey: Uint8Array; messageKey: Uint8Array }> {
  const messageKey = await hmacSha256(chainKey, CHAIN_MSG_CONST);
  const nextChainKey = await hmacSha256(chainKey, CHAIN_NEXT_CONST);
  return { chainKey: nextChainKey, messageKey };
}

/** Derive the AES-256-GCM key + 12-byte IV for one message from its message key. */
async function messageCipherParams(
  messageKey: Uint8Array,
): Promise<{ aesKey: Uint8Array; iv: Uint8Array }> {
  const okm = await hkdfSha256(messageKey, new Uint8Array(32), MSG_INFO, 44);
  return { aesKey: okm.slice(0, 32), iv: okm.slice(32, 44) };
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

/** Serialize a header into the bytes bound as AEAD associated data. */
export function serializeHeader(header: Header): Uint8Array {
  return concat(ASSOCIATED_DATA, header.dh, u32(header.pn), u32(header.n));
}

/**
 * Initialise the sender ("Alice"). She holds the shared root key and the
 * receiver's initial ratchet public key, and immediately performs a DH step so
 * her first message already rides a fresh sending chain.
 */
export async function initSender(
  sharedRootKey: Uint8Array,
  remotePublic: Uint8Array,
  seed?: Uint8Array,
): Promise<RatchetState> {
  const dhSelf = generateKeyPair(seed);
  const dhOut = dh(dhSelf, remotePublic);
  const { rootKey, chainKey } = await kdfRootKey(sharedRootKey, dhOut);
  return {
    dhSelf,
    dhRemote: remotePublic,
    rootKey,
    chainSend: chainKey,
    chainRecv: null,
    sendCount: 0,
    recvCount: 0,
    prevChainLen: 0,
  };
}

/**
 * Initialise the receiver ("Bob"). He holds the shared root key and the ratchet
 * key pair whose public half the sender used; his chains open when her first
 * message arrives and triggers his first DH step.
 */
export function initReceiver(sharedRootKey: Uint8Array, ratchetKey: KeyPair): RatchetState {
  return {
    dhSelf: ratchetKey,
    dhRemote: null,
    rootKey: sharedRootKey,
    chainSend: null,
    chainRecv: null,
    sendCount: 0,
    recvCount: 0,
    prevChainLen: 0,
  };
}

/** Perform a DH ratchet step in response to a new remote ratchet key. */
async function dhRatchet(state: RatchetState, header: Header): Promise<void> {
  state.prevChainLen = state.sendCount;
  state.sendCount = 0;
  state.recvCount = 0;
  state.dhRemote = header.dh;

  const recv = await kdfRootKey(state.rootKey, dh(state.dhSelf, state.dhRemote));
  state.rootKey = recv.rootKey;
  state.chainRecv = recv.chainKey;

  state.dhSelf = generateKeyPair();
  const send = await kdfRootKey(state.rootKey, dh(state.dhSelf, state.dhRemote));
  state.rootKey = send.rootKey;
  state.chainSend = send.chainKey;
}

/** Encrypt one message, advancing the sending chain by one step. */
export async function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
): Promise<WireMessage> {
  if (!state.chainSend) throw new Error("sending chain not initialised");
  const { chainKey, messageKey } = await kdfChainKey(state.chainSend);
  state.chainSend = chainKey;

  const header: Header = {
    dh: state.dhSelf.publicKey,
    pn: state.prevChainLen,
    n: state.sendCount,
  };
  state.sendCount += 1;

  const { aesKey, iv } = await messageCipherParams(messageKey);
  const ciphertext = await aesGcmEncrypt(aesKey, iv, plaintext, serializeHeader(header));
  return { header, ciphertext };
}

/**
 * Decrypt one wire message, performing a DH step first if the sender has
 * ratcheted forward. Fail-closed: a bad tag (tamper / wrong key) throws.
 *
 * (Skipped-message handling for out-of-order delivery is intentionally omitted;
 * the demo delivers in order. The invariant that matters here — the tag must
 * verify — is fully enforced.)
 */
export async function ratchetDecrypt(
  state: RatchetState,
  message: WireMessage,
): Promise<Uint8Array> {
  const sameRemote =
    state.dhRemote !== null &&
    state.dhRemote.length === message.header.dh.length &&
    state.dhRemote.every((b, i) => b === message.header.dh[i]);

  if (!sameRemote) await dhRatchet(state, message.header);
  if (!state.chainRecv) throw new Error("receiving chain not initialised");

  const { chainKey, messageKey } = await kdfChainKey(state.chainRecv);
  state.chainRecv = chainKey;
  state.recvCount += 1;

  const { aesKey, iv } = await messageCipherParams(messageKey);
  return aesGcmDecrypt(aesKey, iv, message.ciphertext, serializeHeader(message.header));
}
