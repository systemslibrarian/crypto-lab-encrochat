import { aesGcmDecrypt, aesGcmEncrypt, fromUtf8, randomBytes, utf8 } from '../crypto/primitives';
import { Implant, type Party } from './implant';

export type Layer = 'vendor' | 'update' | 'pki' | 'server';
export type Separation = 'shared' | 'renamed' | 'independent';
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const makeKey = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);

// Signature verification is real; operator permissions and installation are an
// explicit teaching policy, not a reconstruction of Encrochat's update protocol.
export async function runArchitecture(mode: Separation, compromised: Layer[], existingImplant = false) {
  const [vendor, update, pki, outsider] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
  const capabilities = new Set<Layer>(mode !== 'independent' && compromised.length
    ? ['vendor', 'update', 'pki', 'server'] : compromised);
  const payload = new TextEncoder().encode('teaching update: enable passive plaintext reader');
  const prove = async (authority: CryptoKeyPair, held: boolean, bytes: Uint8Array<ArrayBuffer>) => {
    const signature = await crypto.subtle.sign(SIGN, held ? authority.privateKey : outsider.privateKey, bytes);
    return crypto.subtle.verify(SIGN, authority.publicKey, signature, bytes);
  };
  const vendorSignature = await prove(vendor, capabilities.has('vendor'), payload);
  const updateApproval = await prove(update, capabilities.has('update'), payload);
  // Pinned independent public keys; renaming an operator never changes this rule.
  const installed = vendorSignature && updateApproval;
  const fakeIdentity = new TextEncoder().encode('Bob -> attacker-controlled peer key');
  const identityAccepted = await prove(pki, capabilities.has('pki'), fakeIdentity);
  const users = [];
  for (const party of ['alice', 'bob'] as Party[]) {
    const implanted = installed || (existingImplant && party === 'alice');
    const implant = new Implant();
    const text = `Private message on ${party}'s device`;
    if (implanted) implant.captureOutbound(party, text);
    const key = randomBytes(32), iv = randomBytes(12), aad = utf8('architecture probe');
    try {
      const ciphertext = await aesGcmEncrypt(key, iv, utf8(text), aad);
      const delivered = fromUtf8(await aesGcmDecrypt(key, iv, ciphertext, aad));
      users.push({ party, captured: implant.captures().some(c => c.plaintext === text),
        tagVerified: delivered === text, identityAccepted });
    } finally { key.fill(0); }
  }
  return { vendorSignature, updateApproval, installed, identityAccepted, users };
}
