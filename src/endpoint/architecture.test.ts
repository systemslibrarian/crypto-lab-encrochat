import { describe, it, expect } from 'vitest';
import { runArchitecture, type Layer } from './architecture';

describe('enforceable operator separation', () => {
  it('rejects untrusted update signatures and identity bindings with no compromise', async () => {
    const r = await runArchitecture('shared', []);
    expect(r.installed).toBe(false);
    expect(r.identityAccepted).toBe(false);
    expect(r.users.every(u => u.tagVerified && !u.captured)).toBe(true);
  });
  for (const layer of ['vendor', 'update', 'pki', 'server'] as Layer[]) {
    it(`contains isolated ${layer} authority, but renaming shared administration does not`, async () => {
      const split = await runArchitecture('independent', [layer]);
      expect(split.installed).toBe(false);
      expect(split.identityAccepted).toBe(layer === 'pki');
      expect(split.users.every(u => u.tagVerified && !u.captured)).toBe(true);
      for (const mode of ['shared', 'renamed'] as const) {
        const shared = await runArchitecture(mode, [layer]);
        expect(shared.installed).toBe(true);
        expect(shared.users.every(u => u.captured && u.tagVerified)).toBe(true);
      }
    });
  }
  it('accepts an attacker update only when both independent signing authorities are held', async () => {
    const r = await runArchitecture('independent', ['vendor', 'update']);
    expect(r.vendorSignature).toBe(true);
    expect(r.updateApproval).toBe(true);
    expect(r.installed).toBe(true);
    expect(r.users.every(u => u.captured && u.tagVerified)).toBe(true);
    expect(r.identityAccepted).toBe(false);
  });
  it('cannot cure an existing endpoint implant by separating operators', async () => {
    const r = await runArchitecture('independent', ['server'], true);
    expect(r.installed).toBe(false);
    expect(r.users.map(u => u.captured)).toEqual([true, false]);
    expect(r.users.every(u => u.tagVerified)).toBe(true);
  });
});
