/**
 * Known WCAG 1.4.11 / generated-content findings in this lab, captured through
 * the gate's own path so the baseline and the check cannot disagree.
 *
 * THIS FILE IS A TO-DO LIST, NOT A SET OF EXEMPTIONS. The gate ratchets on it:
 *   - a finding NOT listed here fails the run, so a regression cannot land;
 *   - a listed finding whose ratio gets WORSE fails, so the list cannot rot;
 *   - a listed finding that no longer appears ALSO fails, so a fixed entry must
 *     be deleted and the file can only shrink toward empty.
 * The last rule is what stops an allowlist becoming a permanent exemption.
 *
 * `unverified: true` marks an absolutely-positioned pseudo-element. It can paint
 * outside its host and the oracle measures it against the host's backdrop, so
 * that ratio is NOT trustworthy — hand-measure before acting on it.
 */
export const NONTEXT_BASELINE: Record<
  string,
  { ratio: number; required: number; unverified: boolean }
> = {
  // RECAPTURED. This file was previously EMPTY, and that emptiness was not a
  // clean bill of health — it was the footprint of a dead oracle.
  // `expectNoNewNonTextFailures` was reachable only from inside
  // `expectScrollersReachableSoft`, AFTER that function's
  // `if (!COLLECTING) return …` guard, so `nontext.ts` never ran in a strict
  // pass and the baseline was captured by a check that never looked. It is now
  // called from `scan()` directly, at every driven state.
  //
  // What the live oracle actually finds, over {dark, light} × {1280, 380} and
  // every state the drive builds, is exactly these two — both in the SHARED
  // Crypto Lab top bar, and neither one this repo's to fix.
  //
  // `.cl-btn` draws its edge as
  // `1px solid color-mix(in srgb, var(--accent, #35d6bb) 38%, transparent)`
  // over the bar's fixed `#0b1512`. This lab defines `--accent` (`#5a8f7b`
  // dark, `#3a7a61` light) and it cascades from `:root` into the bar, so the
  // edge is theme-dependent even though the bar behind it is not: measured
  // 1.73:1 in dark and 1.52:1 in light (needs 3:1).
  //
  // The recorded ratio is the WORSE of the two, 1.52, because the ratchet fires
  // on `ratio < baseline - 0.01` and a single entry has to hold for both
  // themes. Recording the dark figure would fail every light-theme run.
  //
  // Every repo in this fleet carries a byte-identical copy of that markup and
  // CSS, and `CLAUDE.md` is explicit that a change every lab should get is a
  // reviewed fleet-wide pass and never an overwrite driven from one repo. So it
  // is measured here, ratcheted here, and reported upward.
  //
  // Everything inside `<main>`, the hero and the footer is audited with no
  // exemption, and comes back clean.
  'control-boundary|a.cl-btn': { ratio: 1.52, required: 3, unverified: false },
};
