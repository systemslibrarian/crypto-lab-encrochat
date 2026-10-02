import { el } from './dom';
import { runArchitecture, type Layer, type Separation } from './endpoint/architecture';

export function architectureView(): HTMLElement {
  const section = el('section', { class: 'section', id: 'architecture-lab' });
  section.append(el('div', { class: 'section-head' },
    el('span', { class: 'section-kicker', text: 'Exhibit D' }),
    el('h2', { class: 'section-title', text: 'When does one compromise reach every device?' })),
    el('p', { class: 'section-lede', text: 'Compare shared administration with independently pinned update approvals. Changing company names alone changes no permissions.' }));
  const card = el('section', { class: 'card' });
  const mode = el('select', { id: 'architecture-mode', class: 'btn' },
    el('option', { value: 'independent', text: 'Independent signing authorities' }),
    el('option', { value: 'shared', text: 'One shared administrator' }),
    el('option', { value: 'renamed', text: 'Different names, same administrator' }));
  const chosen = new Set<Layer>();
  const controls = el('div', { class: 'controls', role: 'group', 'aria-label': 'Compromised authorities' });
  const output = el('div', { id: 'architecture-result', role: 'status', 'aria-live': 'polite', text: 'Not run. Choose an authority to compromise, then run the probe.' });
  const retire = () => { output.textContent = 'Previous results retired. Run the changed scenario.'; };
  for (const [layer, label] of [['vendor', 'Device vendor signer'], ['update', 'Update approval signer'], ['pki', 'Peer identity authority'], ['server', 'Routing server']] as const) {
    const button = el('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', text: label });
    button.addEventListener('click', () => {
      if (chosen.has(layer)) chosen.delete(layer); else chosen.add(layer);
      button.setAttribute('aria-pressed', String(chosen.has(layer)));
      button.textContent = label + (chosen.has(layer) ? ' — compromised' : ''); retire();
    });
    controls.append(button);
  }
  const preexisting = el('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', text: 'Existing implant on Alice' });
  preexisting.addEventListener('click', () => { preexisting.setAttribute('aria-pressed', String(preexisting.getAttribute('aria-pressed') !== 'true')); retire(); });
  let previousMode = mode.value;
  mode.addEventListener('change', () => { if (previousMode !== mode.value) retire(); previousMode = mode.value; });
  const run = el('button', { type: 'button', class: 'btn', id: 'architecture-run', text: 'Run architecture probe' });
  run.addEventListener('click', async () => {
    const all = Array.from(card.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select'));
    all.forEach(c => c.disabled = true);
    output.textContent = 'Checking update signatures and sending encrypted probes…';
    try {
      const r = await runArchitecture(mode.value as Separation, [...chosen], preexisting.getAttribute('aria-pressed') === 'true');
      output.replaceChildren(
        el('p', { text: `Vendor signature: ${r.vendorSignature ? 'verified' : 'rejected'}. Independent update approval: ${r.updateApproval ? 'verified' : 'rejected'}. Attacker update: ${r.installed ? 'INSTALLED — endpoint compromise' : 'BLOCKED'}.` }),
        el('p', { text: `Attacker peer binding: ${r.identityAccepted ? 'ACCEPTED — identity impersonation possible' : 'REJECTED'}. This is a directory-signature check, not a complete impersonation exchange.` }));
      for (const u of r.users) output.append(el('p', { class: u.captured ? 'spof' : '', text: `${u.party}: plaintext ${u.captured ? 'CAPTURED' : 'not captured by this probe'}; message tag ${u.tagVerified ? 'VERIFIED' : 'FAILED'}.` }));
      output.append(el('p', { text: 'A verified message tag does not establish endpoint integrity or the identity behind a directory key. Separating operators cannot remove an implant already on a device.' }));
    } catch { output.textContent = 'Probe failed to run; no security verdict is available.'; }
    finally { all.forEach(c => c.disabled = false); }
  });
  card.append(el('label', { for: 'architecture-mode', text: 'Administration model' }), mode, controls, preexisting, run,
    el('p', { text: 'Model: shared administration grants all four authorities after one compromise. Independent mode requires two real P-256 signatures over the same update, verified against separate pinned keys. The vendor control here means its app-signing key, not arbitrary code execution or replacement of the verifier.' }),
    output, el('details', { class: 'more' }, el('summary', { text: 'For the expert: scope of this counterfactual' }),
      el('p', { text: 'An illustrative authorization policy, not a reconstruction of Encrochat’s update protocol. Installations and permissions are modelled; P-256 verification, AES-GCM probes, and the existing passive Implant reader execute. The ratchet above is unchanged. Routing-server control alone grants no signing key in independent mode. Availability attacks and active endpoint modification are not tested.' })));
  section.append(card);
  return section;
}
