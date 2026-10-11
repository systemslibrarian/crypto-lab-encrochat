# Exhibit D: enforceable operator separation

`src/endpoint/architecture.ts` models four capabilities: vendor signing, update approval, peer-directory signing, and routing-server control. Shared administration grants all four after any selected compromise. Renamed operators deliberately retain that same rule. Independent mode grants only selected capabilities.

An update is accepted only after two P-256 signatures over the identical payload verify against independently pinned vendor and approval public keys. An attacker without an authority signs using an unrelated key, and real verification rejects it. This is an illustrative authorization policy, not Encrochat's historical update format. Vendor compromise means possession of the app-signing key, not arbitrary endpoint execution or authority to replace the verifier.

Accepted installation enables the existing `Implant` passive plaintext reader on Alice and Bob. A separate control models a preexisting implant on Alice. Each device then runs a fresh AES-GCM probe, and the result records both actual capture and tag verification. These isolated probes do not change the main Double Ratchet session. No active plaintext modification or availability attack is claimed tested.

A separate signed peer-directory assertion checks identity substitution capability. It is not a full impersonation exchange and does not assert that existing ratchet sessions were decrypted. An intact message tag cannot establish the real-world identity behind a compromised directory binding.

`src/architecture-view.ts` renders results, retires them when inputs change, and disables controls while the probe runs. All material is session-local. `src/endpoint/architecture.test.ts` covers each isolated authority, shared and renamed administration, dual-authority compromise, no compromise, and a preexisting implant. Browser claims cover the same visible distinction. Run `npm test`, `npm run build`, and `npm run test:e2e`.
