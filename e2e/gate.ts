import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { auditContrast, formatContrastFailures } from './contrast';
import { auditNonText, formatNonTextFailures, type NonTextFailure } from './nontext';
import { NONTEXT_BASELINE } from './nontext-baseline';

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** A phone-width viewport, for the WCAG 1.4.10 reflow half of the gate. */
export const NARROW = { width: 380, height: 800 };

/**
 * Shared machinery for the WCAG gate.
 *
 * Five rules govern everything here, each one a correction of the gate this
 * replaces:
 *
 *  1. NOTHING IS INJECTED INTO THE PAGE BEFORE A SCAN. The old `driveDemos()`
 *     pushed `animation:none!important; transition:none!important` through
 *     `addStyleTag`, with the comment "Neutralize motion so nothing is
 *     mid-animation when axe measures contrast". That BYPASSED this
 *     stylesheet's own `@media (prefers-reduced-motion: reduce)` block instead
 *     of exercising it — so the one rendering it measured was the one no reader
 *     ever gets, and the block itself was never tested at all.
 *
 *     It matters here specifically. `style.css` declares one `@keyframes`,
 *     `pop`, which runs `from { opacity: 0 }` and is applied to `.bubble` and
 *     `.rk-chip` — every message and every ratchet step this lab renders enters
 *     through it. The reduced-motion block does NOT cancel that animation; it
 *     clamps `animation-duration` to 0.01ms and `animation-iteration-count` to
 *     1, so the element runs to the keyframe's `to { opacity: 1 }` and stays
 *     there. That is the safe shape, and `expectNotBlank` asserts it in every
 *     state rather than trusting the reading — because the failure mode one
 *     line away (a block that sets `animation: none` on a keyframe whose
 *     visible state is the END state) strands every bubble at `opacity: 0` for
 *     exactly the readers who asked for less motion.
 *
 *  2. IT FORCE-OPENED BOTH DISCLOSURES FROM SCRIPT.
 *     `document.querySelectorAll("details").forEach(d => d.open = true)` ran
 *     before the only scan, so the SHUT state of "Break it yourself" and "For
 *     the expert" — which is the state every reader arrives at, and the state
 *     in which the `summary::before` triangle is the page's only disclosure
 *     affordance — was never measured. This gate never touches `.open`; each
 *     disclosure is opened by clicking its own `<summary>`, which is also the
 *     only way the two attack controls inside the first one become clickable.
 *
 *  3. IT SCANNED ONCE, AT ONE VIEWPORT, AFTER A FIXED SCRIPT. The old drive ran
 *     the four scripted messages, one custom message, the implant toggle, and
 *     both attacks, and then scanned — once, at 1280px, with the implant ON and
 *     four bubbles on screen. Every state it built along the way was thrown
 *     away unmeasured, and three whole renderings were never reachable from it
 *     at all: the arrival state (empty conversation, `state-untested` encryption
 *     verdict, `state-neutral` system verdict, "Tap the wire" locked); the
 *     implant-on-but-nothing-sent branch, which is the only route to the
 *     "encryption is untested — but an implant already reads plaintext"
 *     headline; and every post-Reset state. This drive scans after every single
 *     step, in {dark, light} × {1280, 380}.
 *
 *  4. `violations` IS NOT THE WHOLE ORACLE. See `scan`. Two things on this page
 *     are invisible to a violations-only assertion in particular: every verdict
 *     surface and every harvested-plaintext row is a `color-mix(in oklab, …)`,
 *     which axe files under `incomplete`; and an `aria-label` on a role-less
 *     element is PROHIBITED and lands in `incomplete` too, never in
 *     `violations` — which is one `role="group"` away from live here, since
 *     `.hex` and `.capture-scroll` are both plain `<div>`s made legal by a role
 *     attribute set beside their label.
 *
 *  5. ITS SC 1.4.11 CHECK POINTED AT THE ONE PLACE THE RULE WAS ALREADY KEPT.
 *     `TEXT_CONTROLS = ["#custom-msg"]` — the single `<input type="text">` on
 *     the page, and the only element the palette's `--control-border` token is
 *     ever applied to. Every BUTTON-shaped control here (`.btn`, `.btn-primary`,
 *     `.switch`) draws its edge from `--border-strong`, a SURFACE divider, and
 *     none of them was measured against anything. `auditControlBoundaries`
 *     measures all of them.
 *
 *     It also HAD NO REFLOW OR KEYBOARD-SCROLLER ORACLE, and this page needs
 *     both. `.hex` (10rem cap) and `.capture-scroll` (12rem cap) do not
 *     overflow at all until enough messages have been sent, so the WCAG 2.1.1
 *     question about them only exists in a state a drive has to go and build.
 */

/**
 * Wait for every running animation and transition to drain.
 *
 * Transitions drain in waves, not in one batch, so a poll for "nothing running
 * right now" can exit through a gap between waves. Require quiescence to hold
 * for several consecutive frames instead.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __quietFrames?: number };
      const running = document.getAnimations().filter((a) => a.playState === 'running');
      w.__quietFrames = running.length === 0 ? (w.__quietFrames ?? 0) + 1 : 0;
      return w.__quietFrames >= 6;
    },
    undefined,
    { timeout: 20_000, polling: 'raf' }
  );
}

/**
 * Wait for the lab's own command queue to drain, then for animation to settle.
 *
 * `main.ts` serialises every state-changing action behind one `opLock` promise
 * and flips `#app[aria-busy]` around it, so `aria-busy="false"` is the
 * completion signal the code itself defines — not a timeout this gate invented.
 *
 * It is deliberately NOT the only thing waited on. `setBusy(true)` runs inside
 * a `.then()` on an already-resolved promise, so between the click and the
 * first microtask `aria-busy` is still `"false"` and a check here alone can
 * pass before the command has started. Every step in the drive therefore also
 * asserts a real DOM outcome — a bubble count, a status string, a control
 * returning from `disabled` — through Playwright's retrying `expect`, and this
 * helper closes the window afterwards.
 */
export async function idle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById('app')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 20_000 }
  );
  await settle(page);
}

/**
 * Assert that reduced motion left the page visible, not merely un-animated.
 *
 * The failure mode this guards against is an element whose only route to its
 * visible state is an animation, in a stylesheet whose reduced-motion block
 * cancels that animation without restoring its end state — the element then
 * renders at `opacity: 0` for every reader with the preference set.
 *
 * This page is one line away from that shape, which is why the assertion is
 * live rather than ceremonial. `style.css` declares exactly one `@keyframes` —
 * `pop`, `from { opacity: 0 } to { opacity: 1 }` — and applies it to `.bubble`
 * and `.rk-chip`, so every message and every ratchet step this lab renders
 * arrives through an animation whose visible state is its END state. Its
 * reduced-motion block clamps `animation-duration` and
 * `animation-iteration-count` rather than setting `animation: none`, so the
 * element runs to `opacity: 1` and stays there. Had it cancelled the animation
 * instead, every bubble and every chip would render invisible for exactly the
 * readers who asked for less motion — and the gate this replaces, which
 * injected `animation: none` over the top through `addStyleTag`, could not have
 * caught it in either direction.
 *
 * `aria-hidden` subtrees are excluded. The cost of that exclusion is stated
 * plainly: text removed from the accessibility tree AND painted at zero opacity
 * is not checked here — which on this page means the four `.pane-label` emoji,
 * the three glyphs inside button labels, and the two verdict icons, each of
 * which sits beside the words carrying the same meaning in the same ink.
 */
async function expectNotBlank(page: Page, label: string): Promise<void> {
  const invisible = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      if (!own) continue;
      // Deliberately hidden subtrees are not "blank", they are closed.
      if (!(el as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true })) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      let effective = 1;
      let node: Element | null = el;
      while (node) {
        effective *= parseFloat(getComputedStyle(node).opacity);
        node = node.parentElement;
      }
      if (effective === 0) {
        out.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim()}`);
      }
    }
    return Array.from(new Set(out));
  });
  expect(invisible, `no visible text may render at opacity 0 in state: ${label}`).toEqual([]);
}

/**
 * Uncaught page errors and console errors, collected from the moment the page
 * is created. A renderer that throws halfway through leaves an earlier state on
 * screen, and a gate that scans that state reports green for a page that is
 * broken. Attach before `boot`, assert after the drive.
 */
export function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

/**
 * Exactly one banner landmark: the shared bar.
 *
 * `main.ts` renders its hero as a `<header class="cl-hero">` and appends it to
 * `<main id="app">`, which scopes that `<header>` out of the banner role on its
 * own — and `index.html`'s `dedupeBanner()` explicitly skips it for that reason
 * (`el.closest('main, …')` returns early). So nothing here demotes anything; the
 * single banner is a property of where `main.ts` mounts. Asserting the OUTCOME
 * rather than either mechanism means a change to the mount point is caught too,
 * and that mount point is one `document.body.append` away from moving.
 */
export async function assertSingleBanner(page: Page): Promise<void> {
  const banners = await page.evaluate(() => {
    const scoped = new Set(['MAIN', 'ARTICLE', 'ASIDE', 'NAV', 'SECTION']);
    const isBanner = (el: Element): boolean => {
      if (el.getAttribute('role') === 'banner') return true;
      if (el.tagName !== 'HEADER') return false;
      if (el.getAttribute('role')) return false; // explicit non-banner role wins
      for (let p = el.parentElement; p; p = p.parentElement) if (scoped.has(p.tagName)) return false;
      return true;
    };
    return [...document.querySelectorAll('header,[role="banner"]')].filter(isBanner).length;
  });
  expect(banners, 'exactly one banner landmark').toBe(1);
}

/**
 * The five buttons `main.ts` builds, by accessible name.
 *
 * Nothing on this page is hidden behind an inline `display:none` — every panel
 * is in the document from first paint and fills in as the lab is driven. What
 * IS gated is a control: "Tap the wire" ships `disabled` and stays that way
 * until `session.hasPacket()`, i.e. until a message has actually crossed the
 * wire. That is the one prerequisite/unlock pair here, and it re-locks after
 * every Reset, so the drive asserts it in both directions rather than once.
 *
 * The two attack controls additionally live inside a shut `<details>`, so they
 * are unreachable — zero-area, unclickable — until its `<summary>` is clicked.
 * That is a second, independent gate on the same buttons, and it is the one the
 * gate this replaces defeated by setting `.open = true` from script.
 */
export const BUTTONS = {
  sendNext: /send next message/i,
  reset: /reset conversation/i,
  sendCustom: /encrypt & send/i,
  tap: /tap the wire/i,
  forge: /forge a packet/i,
} as const;

/** The only control that ships DISABLED until a prerequisite has been met. */
export const LOCKED_UNTIL_PACKET = BUTTONS.tap;

/**
 * Load the page in a known theme with reduced motion actually in effect, and
 * assert the content every scan relies on is really on the page — including the
 * lab's DEFAULTS, which are never assumed.
 *
 * `test.use({ reducedMotion })` silently does nothing on Playwright 1.61.1, so
 * the emulation is applied imperatively BEFORE the navigation and then
 * *asserted* from inside the page. An emulation that silently did nothing would
 * be invisible here rather than obvious: this page has no permanent motion, so
 * the only thing that changes is whether `.bubble` and `.rk-chip` spend 180ms
 * fading in from `opacity: 0` — long enough for an axe pass to land inside, and
 * short enough that a run which caught one would look like a flake rather than
 * a finding.
 *
 * The theme is seeded through `localStorage` rather than by clicking the toggle,
 * which also pins down a real failure mode: `index.html`'s anti-flash script
 * reads `localStorage.getItem('theme')` and the toggle writes
 * `localStorage.setItem('theme', …)`. If those keys drift apart the theme
 * silently stops persisting, and this boot fails on `data-theme` rather than
 * quietly scanning dark twice. (They agree today — both are `'theme'` — which
 * was checked, not assumed.)
 *
 * The defaults are asserted at length because this lab ships EMPTY and because
 * which half of its palette a run measures depends entirely on them. The
 * arrival state has no conversation, no packet, no ratchet step and no
 * harvested plaintext; the encryption verdict reads `state-untested`, the system
 * verdict `state-neutral`, and "Tap the wire" is `disabled`. Those three
 * renderings — an amber-free, alarm-free, muted-ink page — are the first thing
 * every reader sees and the gate this replaces could not reach them: its single
 * scan happened after four scripted messages, a custom message, and the implant
 * toggle, with every verdict already flipped.
 */
export async function boot(page: Page, theme: 'dark' | 'light'): Promise<void> {
  // A click on a control that never becomes actionable otherwise burns the whole
  // test timeout and reports nothing useful. 20s turns that silent hang into a
  // named failure naming the locator.
  page.setDefaultTimeout(20_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
  await page.goto('.');
  expect(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    'reduced-motion emulation must actually be in effect'
  ).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await assertSingleBanner(page);

  // The whole page is built by `src/main.ts` into an empty `<main id="app">`, so
  // a navigation that resolves proves nothing. `aria-busy="false"` is set on the
  // last line of `main()`; until then the mount has not finished.
  await expect(page.locator('.cl-hero-title')).toHaveText('Encrochat');
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');

  // The reduced-motion block's effect, asserted rather than assumed: `pop` is
  // clamped to a duration nothing can be caught inside. Read off a live `.btn`,
  // since the block targets `*`; the value is compared as a NUMBER because
  // Chromium serialises 0.01ms as `1e-05s` and the exact spelling is not this
  // lab's to guarantee.
  expect(
    await page.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('.btn')!).animationDuration)
    ),
    'reduced motion must clamp animation-duration through the * rule'
  ).toBeLessThanOrEqual(0.001);

  // ── The lab ships empty: nothing generated, nothing captured ─────────────
  await expect(page.locator('.convo .bubble')).toHaveCount(0);
  await expect(page.locator('.ratchet .rk-chip')).toHaveCount(0);
  await expect(page.locator('.capture-list li')).toHaveCount(0);
  await expect(page.locator('.hex .wire-seg')).toHaveCount(0);
  await expect(page.locator('.wire-meta')).toBeEmpty();
  await expect(page.locator('.break-status')).toBeEmpty();
  await expect(page.locator('.error-status')).toBeEmpty();
  await expect(page.locator('p.hint')).toHaveText('Send a message to populate the wire.');

  // ── Every shipped control default ────────────────────────────────────────
  await expect(page.locator('#custom-msg')).toHaveValue('');
  await expect(page.getByRole('button', { name: BUTTONS.sendNext })).toBeEnabled();
  await expect(page.getByRole('button', { name: BUTTONS.reset })).toBeEnabled();
  await expect(page.getByRole('button', { name: BUTTONS.sendCustom })).toBeEnabled();

  // The two attack controls are behind a shut `<details>`, so they are not in
  // the accessibility tree at all — `getByRole` finds nothing, which is a
  // stronger statement than "disabled" and is the real reason a reader cannot
  // press them yet. Reached through the DOM instead, one of them ALSO carries
  // `disabled`, because `session.hasPacket()` is false until a message has
  // crossed the wire; the other is self-contained and is not gated on anything.
  await expect(page.getByRole('button', { name: BUTTONS.tap })).toHaveCount(0);
  await expect(page.getByRole('button', { name: BUTTONS.forge })).toHaveCount(0);
  await expect(page.locator('details.more button').nth(0)).toBeDisabled();
  await expect(page.locator('details.more button').nth(1)).toBeEnabled();

  // The implant ships OFF. A lab that shipped it ON would mean every scan of
  // every previous run measured the alarm palette and never the calm one.
  await expect(page.locator('.switch')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.switch .switch-label')).toHaveText('Deploy implant on the devices');
  await expect(page.locator('.toggle-row .hint')).toHaveText(
    'No implant deployed. Plaintext exists only in each device\'s memory.'
  );

  // ── The three verdicts, in the state a reader arrives at ─────────────────
  await expect(page.locator('.verdict-grid .verdict').nth(0)).toHaveClass(/state-untested/);
  await expect(page.locator('.verdict-grid .verdict').nth(0)).toContainText('NOT YET TESTED');
  await expect(page.locator('.verdict-grid .verdict').nth(1)).toHaveClass(/state-ok/);
  await expect(page.locator('.verdict-grid .verdict').nth(1)).toContainText(
    'NO MODELLED COMPROMISE'
  );
  await expect(page.locator('.system-verdict')).toHaveClass(/state-neutral/);
  await expect(page.locator('.system-verdict')).toContainText('AWAITING EVIDENCE');

  // Both disclosures ship shut — which is also what makes the two attack
  // controls inside the first one unreachable until a summary is clicked.
  await expect(page.locator('details.more')).toHaveCount(2);
  await expect(page.locator('details[open]')).toHaveCount(0);

  await settle(page);
  await expectNotBlank(page, `${theme} first paint`);
}

/**
 * Assert the page does not require horizontal scrolling.
 *
 * WCAG 1.4.10 (Reflow, AA). axe has no rule for this at all, and this page has
 * three ways to break it. `.wire-grid`, `.verdict-grid` and `.stack-row` are
 * all bare-`1fr` grid tracks, whose automatic minimum is min-content rather
 * than zero; `.hex` renders unbroken hex runs of 80 characters and up; and the
 * conversation renders whatever a reader types into `#custom-msg`, which is
 * 120 characters of anything, with no spaces required. The drive types exactly
 * that. Each of those is meant to wrap or to scroll inside its own box; the
 * assertion here is that none of them scrolls the DOCUMENT.
 */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    if (doc.scrollWidth <= doc.clientWidth) return null;

    // Only elements that actually push the DOCUMENT sideways are culprits. A
    // wide box inside an `overflow-x: auto` wrapper has a huge bounding rect but
    // is clipped by its scroller and contributes nothing to the document's
    // scroll width — naming it sends you off fixing the wrong element. That cost
    // a run elsewhere in this fleet, and this page has a decoy behind every
    // `.scroller`.
    const clipped = (el: Element): boolean => {
      let n = el.parentElement;
      while (n && n !== doc) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
        n = n.parentElement;
      }
      return false;
    };

    const over = Array.from(document.querySelectorAll('body *'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.right > doc.clientWidth + 1)
      .sort((a, b) => b.r.right - a.r.right);
    const widest = over.filter((x) => !clipped(x.el))[0] ?? over[0];
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      widest: widest
        ? `${clipped(widest.el) ? '[clipped] ' : ''}${widest.el.tagName.toLowerCase()}${widest.el.id ? '#' + widest.el.id : ''}` +
          `${widest.el.getAttribute('class') ? '.' + widest.el.getAttribute('class')!.trim().split(/\s+/).join('.') : ''}` +
          ` @${Math.round(widest.r.width)}px right=${Math.round(widest.r.right)}`
        : '(none identified)',
    };
  });
  expect(overflow, `page must not scroll horizontally in state: ${label}`).toBeNull();
}

/**
 * Every scrolling container must be operable from the keyboard (WCAG 2.1.1). If
 * it holds no focusable content it needs `tabindex="0"`, so it becomes a focus
 * target arrow keys can then scroll.
 *
 * This lab has two, and both are hand-built in `main.ts` rather than produced
 * by a helper: `.hex` (`role="group" tabindex="0"`, capped at 10rem) and
 * `.capture-scroll` (`role="group" tabindex="0"`, capped at 12rem). Both are
 * correct today. The assertion stays because each is three attributes typed by
 * hand at a call site, with nothing enforcing them, and because the content
 * inside them is the evidence the lab exists to show: the packet a network
 * adversary captures and gets nothing from, and the plaintext an endpoint
 * implant reads without ever touching a key. Neither container overflows until
 * the drive has sent enough messages, so this only becomes a real question in a
 * state that has to be built.
 */
export async function expectScrollersReachable(page: Page, label: string): Promise<void> {
  const unreachable = await page.evaluate(() => {
    const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
    return Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .filter((el) => {
        const cs = getComputedStyle(el);
        return (
          ['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY)
        );
      })
      .filter((el) => el.tabIndex < 0 && !el.querySelector(FOCUSABLE))
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim()}` +
          ` (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`
      );
  });
  expect(
    Array.from(new Set(unreachable)),
    `scrolling regions with no keyboard route in state: ${label}`
  ).toEqual([]);
}

/**
 * SC 1.4.11 (non-text contrast) for interactive controls: a control's boundary
 * has to be perceivable against what surrounds it.
 *
 * This is the old spec's check, kept because it was right, with its aim
 * corrected. It used to query exactly one selector, `#custom-msg` — the page's
 * only `<input type="text">`, and the only element the palette's
 * `--control-border` token is ever applied to. Pointing a check only at the
 * place a rule is already kept is the same as not having it. Every
 * BUTTON-shaped control here (`.btn`, `.btn-primary`, `.switch`) draws its edge
 * from `--border-strong` instead, which is a SURFACE divider, and none of them
 * had ever been measured against anything.
 *
 * A control passes if EITHER
 *   - its fill differs from the surface behind it (how `.btn` works: a
 *     transparent border over an `--accent` fill), or
 *   - it has a border that stands out from the surface behind it AND from its
 *     own fill (how a `<select>` works: a near-panel fill with a drawn edge).
 * so the score is `max(fill-vs-outside, min(border-vs-outside, border-vs-fill))`.
 * Taking the max of the two mechanisms is what keeps this from failing a
 * perfectly delineated solid button for having no border.
 *
 * Two deliberate exclusions:
 *  - `disabled` controls. WCAG exempts inactive components, and this page ships
 *    "Tap the wire" disabled until a packet exists, then re-locks it after every
 *    Reset.
 *  - anything outside `#app`. The shared top bar is not this lab's to change —
 *    every repo in the fleet carries a byte-identical copy — and its `.cl-btn`
 *    boundary is `color-mix(in srgb, var(--accent) 38%, transparent)` over the
 *    bar's fixed `#0b1512`, which with this lab's `--accent` measures 1.73:1 in
 *    dark and 1.52:1 in light. That is reported upward as a fleet-wide
 *    observation rather than patched in one repo, and it is written down here so
 *    the exclusion is a decision and not an oversight.
 */
export async function auditControlBoundaries(
  page: Page
): Promise<Array<{ sel: string; ratio: number }>> {
  return page.evaluate(() => {
    type C = { r: number; g: number; b: number; a: number };
    // Resolve through a canvas rather than a regex: this palette is full of
    // `color-mix()`, which `getComputedStyle` reports unchanged and which a
    // regex reads as null — landing the walk on the wrong backdrop.
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    const parse = (s: string): C => {
      if (!s) return { r: 0, g: 0, b: 0, a: 0 };
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = s;
      const a = ctx.fillStyle;
      ctx.fillStyle = '#fff';
      ctx.fillStyle = s;
      if (a !== ctx.fillStyle) return { r: 0, g: 0, b: 0, a: 0 };
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    const over = (fg: C, bg: C): C => {
      const a = fg.a + bg.a * (1 - fg.a);
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
        a,
      };
    };
    const lum = (c: C): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a: C, b: C): number => {
      const la = lum(a);
      const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const backdrop = (start: Element | null): C => {
      const stack: C[] = [];
      for (let n = start; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c.a > 0) {
          stack.push(c);
          if (c.a >= 1) break;
        }
      }
      let out: C = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
      return out;
    };
    const describe = (el: Element): string => {
      const cls = el.getAttribute('class');
      return (
        el.tagName.toLowerCase() +
        (el.id ? `#${el.id}` : '') +
        (cls ? `.${cls.trim().split(/\s+/).join('.')}` : '')
      );
    };

    const out: Array<{ sel: string; ratio: number }> = [];
    const app = document.getElementById('app');
    if (!app) return out;
    app
      .querySelectorAll<HTMLElement>("button, select, textarea, input[type='text']")
      .forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if ((el as HTMLButtonElement).disabled) return;
        if (el.closest('[hidden]')) return;
        const cs = getComputedStyle(el);
        const outside = backdrop(el.parentElement);
        const fillRaw = parse(cs.backgroundColor);
        const fill = fillRaw.a > 0 ? over(fillRaw, outside) : outside;
        const byFill = ratio(fill, outside);
        let byBorder = 1;
        if (parseFloat(cs.borderTopWidth) > 0) {
          const border = over(parse(cs.borderTopColor), fill);
          byBorder = Math.min(ratio(border, outside), ratio(border, fill));
        }
        out.push({
          sel: describe(el),
          ratio: Math.round(Math.max(byFill, byBorder) * 100) / 100,
        });
      });
    return out;
  });
}

/**
 * When `A11Y_COLLECT` is set, `scan` records failures instead of throwing.
 *
 * A strict gate reports the first failing assertion in the first failing state
 * and stops, so a page with defects in several states needs one full run per
 * defect to enumerate them. The collection pass turns that into a single run. It
 * is a debugging aid only: `A11Y_COLLECT` is never set in CI or in the committed
 * workflow, and a run with it set prints every finding as it happens and then
 * fails at the end, so a green collection run cannot be mistaken for a green
 * gate.
 */
const COLLECTING = !!process.env.A11Y_COLLECT;
const collected: string[] = [];

function record(entry: string): void {
  collected.push(entry);
  // Printed as it happens, not only at the end: a hard assertion later in the
  // drive would otherwise abort the test before anything collected so far was
  // ever shown.
  console.log(`\n[A11Y_COLLECT #${collected.length}] ${entry}`);
}

export function softExpect(actual: unknown, message: string, expected: unknown): void {
  if (!COLLECTING) {
    expect(actual, message).toEqual(expected);
    return;
  }
  try {
    expect(actual, message).toEqual(expected);
  } catch {
    record(`${message}\n  ${JSON.stringify(actual, null, 2)}`);
  }
}

/**
 * Fail the test if the collection pass recorded anything. Without this a
 * collection run would end green, and a green collection run is
 * indistinguishable from a green gate — which is the exact confusion the whole
 * exercise exists to remove.
 */
export function reportCollected(): void {
  if (!COLLECTING) return;
  expect(collected, `A11Y_COLLECT recorded ${collected.length} failure(s)`).toEqual([]);
}

async function expectScrollersReachableSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectScrollersReachable(page, label);
  try {
    await expectNoNewNonTextFailures(page, label);
  await expectScrollersReachable(page, label);
  } catch (e) {
    record(String(e).slice(0, 900));
  }
}

async function expectNoHorizontalOverflowSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectNoHorizontalOverflow(page, label);
  try {
    await expectNoHorizontalOverflow(page, label);
  } catch (e) {
    record(String(e).slice(0, 900));
  }
}

/**
 * Scan the page as it currently stands.
 *
 * Seven assertions, because axe's `violations` array alone is not a complete
 * oracle:
 *
 *  - reduced-motion end state — see `expectNotBlank`.
 *  - `violations` — the usual WCAG A/AA rule failures, plus four landmark
 *    best-practice rules `withTags` does not run on its own.
 *  - `incomplete` — axe's "could not decide" bucket, which never reaches the
 *    violations array. The one rule id allowed to remain incomplete is
 *    `color-contrast`, and only because the next assertion computes those ratios
 *    arithmetically — which matters more here than in most labs, since all three
 *    verdict surfaces and every harvested-plaintext row are
 *    `color-mix(in oklab, …)` that axe declines to resolve. Everything else in
 *    that bucket is a real result axe simply could not finish — including
 *    `aria-prohibited-attr`, which is where an `aria-label` on a role-less
 *    element hides, a defect that never reaches the violations array at all.
 *    That one is one attribute from live here: `main.ts` puts an `aria-label` on
 *    the plain `<div>`s behind `.hex` and `.capture-scroll` and makes each legal
 *    with a `role="group"` typed on the line above it.
 *  - arithmetic contrast — composite-aware WCAG 1.4.3 over every text node.
 *  - non-text contrast for interactive controls — SC 1.4.11, which axe has no
 *    rule for; see `auditControlBoundaries`.
 *  - keyboard reachability of scrolling regions — WCAG 2.1.1.
 *  - reflow — WCAG 1.4.10, which axe has no rule for at all.
 */
/**
 * WCAG 1.4.11 and generated content, ratcheted against a per-repo baseline.
 *
 * Neither class has ANY other oracle: axe has no rule for non-text contrast,
 * and the arithmetic text walk cannot reach a control's boundary or a
 * `::before` glyph, because a pseudo-element is not an element and owns no text
 * node. Both were being found by hand-sampling screenshot pixels, which does
 * not regress-test.
 *
 * The backlog is real, so this does not block on it — but a check that merely
 * logs is not a gate, and this sweep has spent its whole length deleting checks
 * that could not fail. So it ratchets instead: anything NOT in the baseline
 * fails, anything in the baseline that got WORSE fails, and anything in the
 * baseline that has been FIXED fails until its entry is deleted. That last rule
 * is what stops the allowlist becoming a permanent exemption.
 */
const nonTextSeen = new Set<string>();

export async function expectNoNewNonTextFailures(page: Page, label: string): Promise<void> {
  const found = await auditNonText(page);
  // Capture mode: emit every finding and assert nothing, so a baseline can be
  // generated by the SAME path that checks it. Opt-in via env, and the run is
  // deliberately left failing at the end by `expectBaselineNotStale` so a
  // capture pass can never be mistaken for a passing gate.
  if (process.env.NT_BASELINE_CAPTURE) {
    for (const f of found) {
      console.log(`NTCAP|${f.kind}|${f.selector}|${f.ratio}|${f.required}|${/POSITIONED/.test(f.detail)}`);
    }
    return;
  }
  const problems: string[] = [];
  for (const f of found) {
    const key = `${f.kind}|${f.selector}`;
    nonTextSeen.add(key);
    const base = NONTEXT_BASELINE[key];
    if (!base) {
      problems.push(`NEW ${f.ratio}:1 (needs ${f.required}:1) [${f.kind}] ${f.selector} — ${f.detail}`);
    } else if (f.ratio < base.ratio - 0.01) {
      problems.push(
        `WORSE ${f.selector}: ${f.ratio}:1, baseline recorded ${base.ratio}:1`
      );
    }
  }
  expect(problems, `new or worsened non-text contrast in state: ${label}`).toEqual([]);
}

/**
 * Fail if a baselined finding never appeared during the whole drive.
 *
 * It has either been fixed — in which case delete the entry, which is the point
 * — or the drive stopped reaching the state that shows it, which is a coverage
 * regression worth knowing about. Call once, after `driveAllStates`.
 */
export function expectBaselineNotStale(): void {
  const unseen = Object.keys(NONTEXT_BASELINE).filter((k) => !nonTextSeen.has(k));
  expect(
    unseen,
    'baselined non-text findings that no longer appear — delete them from nontext-baseline.ts (or restore the drive state that showed them)'
  ).toEqual([]);
}

export async function scan(page: Page, label: string): Promise<void> {
  await settle(page);
  await expectNotBlank(page, label);
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    // These four are axe "best-practice" rules rather than WCAG-tagged ones, so
    // `withTags` alone does not run them. This page is exactly the shape they
    // catch: a shared sticky <header role="banner"> above a <main id="app"> that
    // `main.ts` fills with a second <header class="cl-hero">, which itself
    // contains an <aside class="cl-hero-why"> — and none of the four was enabled
    // before.
    .withRules([
      'landmark-no-duplicate-banner',
      'landmark-unique',
      'landmark-one-main',
      'landmark-complementary-is-top-level',
    ])
    .analyze();

  const violations = results.violations.map((v) => ({
    state: label,
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
  }));
  softExpect(violations, `axe violations in state: ${label}`, []);

  const unexplainedIncomplete = results.incomplete
    .filter((v) => v.id !== 'color-contrast')
    .map((v) => ({
      state: label,
      id: v.id,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
    }));
  softExpect(unexplainedIncomplete, `axe incomplete results in state: ${label}`, []);

  const contrast = Array.from(new Set(formatContrastFailures(await auditContrast(page))));
  softExpect(contrast, `measured contrast failures in state: ${label}`, []);

  const boundaries = await auditControlBoundaries(page);
  expect(boundaries.length, `no controls found to measure in state: ${label}`).toBeGreaterThan(0);
  const undelineated = Array.from(
    new Set(boundaries.filter((b) => b.ratio < 3).map((b) => `${b.ratio}:1 ${b.sel}`))
  );
  softExpect(undelineated, `control boundaries under 3:1 (SC 1.4.11) in state: ${label}`, []);

  await expectScrollersReachableSoft(page, label);
  await expectNoHorizontalOverflowSoft(page, label);
}


// ── The drive ───────────────────────────────────────────────────────────────

/**
 * Open one `<details class="more">` by clicking its summary, and assert it
 * opened.
 *
 * Never `.open = true`. The gate this replaces set that property on both
 * disclosures at once, from script, before its only scan — which meant the shut
 * rendering was never measured, and the click path that a keyboard reader
 * actually uses was never exercised. It also meant the two attack controls
 * inside the first disclosure went from unreachable to clickable without
 * anything asserting that a reader could have made that happen.
 */
async function openDisclosure(page: Page, index: number, expectedSummary: RegExp): Promise<void> {
  const d = page.locator('details.more').nth(index);
  await expect(d.locator('summary')).toHaveText(expectedSummary);
  await expect(d).not.toHaveAttribute('open', '');
  await d.locator('summary').click();
  await expect(d).toHaveAttribute('open', '');
}

/** Send one scripted message and wait for the render it produces. */
async function sendScripted(page: Page, expectedBubbles: number): Promise<void> {
  await page.getByRole('button', { name: BUTTONS.sendNext }).click();
  await expect(page.locator('.convo .bubble')).toHaveCount(expectedBubbles);
  await expect(page.locator('.ratchet .rk-chip')).toHaveCount(expectedBubbles);
  await expect(page.locator('.hex .wire-seg')).toHaveCount(3);
  await idle(page);
}

/** Type into `#custom-msg` and send it, waiting for the bubble it produces. */
async function sendCustom(page: Page, text: string, expectedBubbles: number): Promise<void> {
  await page.fill('#custom-msg', text);
  await page.getByRole('button', { name: BUTTONS.sendCustom }).click();
  await expect(page.locator('.convo .bubble')).toHaveCount(expectedBubbles);
  // The field is cleared only after the command commits, so an empty value is
  // itself a completion signal the code defines.
  await expect(page.locator('#custom-msg')).toHaveValue('');
  await idle(page);
}

/** Flip the implant switch and wait for the label and verdicts to follow. */
async function setImplant(page: Page, on: boolean): Promise<void> {
  await page.locator('.switch').click();
  await expect(page.locator('.switch')).toHaveAttribute('aria-pressed', String(on));
  await expect(page.locator('.switch .switch-label')).toHaveText(
    on ? 'Implant deployed — click to remove' : 'Deploy implant on the devices'
  );
  await expect(page.locator('.verdict-grid .verdict').nth(1)).toHaveClass(
    on ? /state-alarm/ : /state-ok/
  );
  await idle(page);
}

/**
 * Drive the lab through every state that renders content, scanning each.
 *
 * Seven things shape this drive:
 *
 *  - IT STARTS EMPTY, AND THE EMPTY STATE IS SCANNED FIRST. The arrival page has
 *    no conversation, no packet, no ratchet step and no harvested plaintext; its
 *    encryption verdict is `state-untested` and its system verdict
 *    `state-neutral`. Those are two whole ink pairings — `--text-muted` on
 *    `--surface` inside `.v-status`, and `--text-dim` inside `.sv-title` — that
 *    exist in NO other state, and the gate this replaces could not reach them:
 *    its single scan ran after the full script, a custom message and the implant
 *    toggle, with every verdict already flipped.
 *
 *  - THE ONE PREREQUISITE IS SCANNED BEFORE ITS UNLOCK, IN BOTH DIRECTIONS.
 *    "Tap the wire" ships `disabled` because `session.hasPacket()` is false, and
 *    goes back to `disabled` after every Reset. Both transitions are asserted,
 *    so the locked rendering — which is what a reader meets — is measured as
 *    well as the unlocked one.
 *
 *  - THE IMPLANT IS DEPLOYED WITH NOTHING SENT, DELIBERATELY. That combination
 *    is the only route to `assessSystem`'s third headline branch ("No message
 *    has been sent yet, so the encryption is untested — but an implant already
 *    reads plaintext at the device"), and to the only rendering in which the
 *    encryption verdict is `state-untested` while the system verdict is
 *    `state-alarm`. Reaching it needs the implant toggled before the first
 *    message, which no natural reading order does.
 *
 *  - EVERY SCRIPTED MESSAGE IS SCANNED, NOT JUST THE LAST. The four are not
 *    interchangeable: message 2 is Alice's second in a row, so it advances the
 *    symmetric ratchet only and renders `chain +1` rather than `⟳ DH step`;
 *    message 3 is Bob's, so it renders `.bubble.from-bob`, which is the only
 *    bubble that draws its border from `--border-strong` and the only one
 *    aligned to the end of the flex column; and message 4 exhausts the script,
 *    which disables "Send next message" — a fifth distinct rendering.
 *
 *  - THE COMPOSE FIELD IS DRIVEN TO ITS EXTREMES, not just used. Empty input is
 *    a real branch (`sendCustom` returns without sending, and nothing on screen
 *    may change), and 120 characters of unbroken hex — the field's `maxlength`,
 *    with no space anywhere — is the reflow case: it is the only content on the
 *    page a reader controls, it lands in `.bubble .text` inside a bare-`1fr`
 *    grid track, and at 380px it is what decides whether `word-break` is doing
 *    its job or the document is scrolling sideways.
 *
 *  - THE TWO SCROLLERS ARE DRIVEN PAST THEIR CAPS. `.hex` (10rem) and
 *    `.capture-scroll` (12rem) do not overflow at the shipped defaults, so
 *    whether they can be scrolled from a keyboard is a WCAG 2.1.1 question that
 *    only exists once enough has been sent. The drive asserts the overflow is
 *    real before relying on the answer.
 *
 *  - NO FIXED TIMEOUTS. Every command in `main.ts` runs through `runOp`, which
 *    serialises behind one promise and flips `#app[aria-busy]` around it, and
 *    every command has a DOM outcome besides — a bubble count, a status string,
 *    a switch label, a control returning from `disabled`. The drive waits on
 *    those and then on `idle`.
 */
export async function driveAllStates(page: Page, theme: string): Promise<void> {
  const scanAt = (s: string): Promise<void> => scan(page, `${theme} / ${s}`);
  const tap = page.getByRole('button', { name: BUTTONS.tap });
  const forge = page.getByRole('button', { name: BUTTONS.forge });
  const sendNext = page.getByRole('button', { name: BUTTONS.sendNext });

  await scanAt('first paint: nothing sent, encryption untested, system neutral, wiretap locked');

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('Tab');
  await expect(page.locator('a.cl-skip-link')).toBeFocused();
  await scanAt('skip link focused');

  // ── The implant, before anything has been sent ──────────────────────────
  // The only route to the "encryption untested, endpoint already compromised"
  // headline, and the only state pairing a `state-untested` encryption verdict
  // with a `state-alarm` system verdict.
  await setImplant(page, true);
  await expect(page.locator('.verdict-grid .verdict').nth(0)).toHaveClass(/state-untested/);
  await expect(page.locator('.system-verdict')).toHaveClass(/state-alarm/);
  await expect(page.locator('.system-verdict')).toContainText(
    'No message has been sent yet, so the encryption is untested'
  );
  await expect(page.locator('.capture-list li')).toHaveCount(0);
  await scanAt('implant deployed with nothing sent: system alarm, encryption still untested');

  await setImplant(page, false);
  await expect(page.locator('.system-verdict')).toHaveClass(/state-neutral/);
  await scanAt('implant removed, back to awaiting evidence');

  // ── Both disclosures, opened the way a reader opens them ────────────────
  await openDisclosure(page, 0, /Break it yourself/);
  // The two attack controls only become reachable now, and one of them is still
  // locked because no packet exists yet.
  await expect(tap).toBeDisabled();
  await expect(forge).toBeEnabled();
  await scanAt('break-it disclosure open, wiretap still locked with no packet');

  await openDisclosure(page, 1, /For the expert/);
  await scanAt('scoping disclosure open');

  // ── Exhibit A: the scripted exchange, one message at a time ─────────────
  await sendScripted(page, 1);
  await expect(tap).toBeEnabled();
  await expect(page.locator('.verdict-grid .verdict').nth(0)).toHaveClass(/state-ok/);
  await expect(page.locator('.verdict-grid .verdict').nth(0)).toContainText('SOUND');
  await expect(page.locator('.system-verdict')).toHaveClass(/state-ok/);
  await scanAt('message 1 sent: wire populated, encryption sound, wiretap unlocked');

  // Alice's second in a row: the symmetric ratchet only, so this chip reads
  // `chain +1` where the first read `⟳ DH step`.
  await sendScripted(page, 2);
  await expect(page.locator('.ratchet .rk-chip').nth(1)).toContainText('chain +1');
  await scanAt('message 2: symmetric ratchet only, no DH step');

  // Bob's reply: the only `.bubble.from-bob` rendering on the page.
  await sendScripted(page, 3);
  await expect(page.locator('.convo .bubble.from-bob')).toHaveCount(1);
  await expect(page.locator('.ratchet .rk-chip').nth(2)).toContainText('B · msg');
  await scanAt('message 3 from Bob: the from-bob bubble and the DH step it triggers');

  await sendScripted(page, 4);
  await expect(sendNext).toBeDisabled();
  await scanAt('message 4: the script is exhausted and its button is disabled');

  // ── The network adversary's two attempts ────────────────────────────────
  await tap.click();
  await expect(page.locator('.break-status')).toContainText('Wiretap failed');
  await expect(page.locator('.break-status')).toContainText('AES-256-GCM authentication failed');
  await idle(page);
  await scanAt('wiretap attempted without keys and failed');

  await forge.click();
  await expect(page.locator('.break-status')).toContainText('flipped');
  await expect(page.locator('.break-status')).toContainText('rejected the forged packet');
  await idle(page);
  await scanAt('packet forged, rejected, and the authentic one still recovered');

  // ── The compose field, at both extremes ─────────────────────────────────
  // Empty input is a real branch: `sendCustom` returns before sending, so
  // nothing on screen may change.
  await page.fill('#custom-msg', '   ');
  await page.getByRole('button', { name: BUTTONS.sendCustom }).click();
  await idle(page);
  await expect(page.locator('.convo .bubble')).toHaveCount(4);
  await scanAt('blank compose submitted: no message sent, nothing changed');

  // 120 characters — the field's `maxlength` — of unbroken hex, with no space to
  // wrap at. This is the reflow case, and it is the only content on the page a
  // reader controls.
  const UNBREAKABLE = 'a3f19c7e4b02d85f'.repeat(7) + 'a3f19c7e';
  expect(UNBREAKABLE.length, 'the reflow probe must hit the field maxlength').toBe(120);
  await sendCustom(page, UNBREAKABLE, 5);
  await expect(page.locator('.convo .bubble').last()).toContainText(UNBREAKABLE);
  // `.hex` is capped at 10rem; by now the captured packet is well past it, which
  // is what makes the 2.1.1 question about it answerable at all.
  expect(
    await page.locator('.hex').evaluate((el) => el.scrollHeight > el.clientHeight + 1),
    '.hex must actually overflow its 10rem cap before its keyboard route is judged'
  ).toBe(true);
  await scanAt('120 unbroken characters sent: the reflow case, and .hex past its cap');

  // ── Exhibit B: the implant, with a conversation already on screen ───────
  await setImplant(page, true);
  await expect(page.locator('.system-verdict')).toHaveClass(/state-alarm/);
  await expect(page.locator('.system-verdict')).toContainText('Encryption held; the endpoint did not');
  // Nothing already sent is retroactively harvested — the implant only reads
  // messages that pass through it after deployment.
  await expect(page.locator('.capture-list li')).toHaveCount(0);
  await scanAt('implant deployed over a live conversation: alarm verdicts, nothing harvested yet');

  await sendCustom(page, 'the pickup is at nine', 6);
  await expect(page.locator('.capture-list li')).toHaveCount(2);
  await expect(page.locator('.capture-list .cap-meta').first()).toContainText('pre-encryption');
  await expect(page.locator('.capture-list .cap-meta').nth(1)).toContainText('post-decryption');
  await scanAt('first message harvested: plaintext read before encryption and after decryption');

  // Two more, so `.capture-scroll` is past its 12rem cap and its keyboard route
  // becomes a real question.
  await sendCustom(page, 'bring the second handset', 7);
  await sendCustom(page, 'and wipe the old one', 8);
  await expect(page.locator('.capture-list li')).toHaveCount(6);
  expect(
    await page.locator('.capture-scroll').evaluate((el) => el.scrollHeight > el.clientHeight + 1),
    '.capture-scroll must actually overflow its 12rem cap before its keyboard route is judged'
  ).toBe(true);
  await scanAt('six captures harvested, the capture scroller past its cap');

  await setImplant(page, false);
  await expect(page.locator('.capture-list li')).toHaveCount(0);
  await expect(page.locator('.system-verdict')).toHaveClass(/state-ok/);
  await expect(page.locator('.system-verdict')).toContainText(
    'Every delivered message authenticated'
  );
  await scanAt('implant removed: harvest cleared, system verdict back to sound');

  // ── Reset, in both of its branches ──────────────────────────────────────
  await page.getByRole('button', { name: BUTTONS.reset }).click();
  await expect(page.locator('.convo .bubble')).toHaveCount(0);
  await expect(page.locator('.hex .wire-seg')).toHaveCount(0);
  await idle(page);
  // Everything the arrival state asserts, asserted again — a Reset that leaves a
  // control unlocked or a verdict flipped is a state no reader can otherwise
  // reach, and the gate this replaces never pressed this button at all.
  await expect(tap).toBeDisabled();
  await expect(sendNext).toBeEnabled();
  await expect(page.locator('.ratchet .rk-chip')).toHaveCount(0);
  await expect(page.locator('p.hint')).toHaveText('Send a message to populate the wire.');
  await expect(page.locator('.break-status')).toBeEmpty();
  await expect(page.locator('.verdict-grid .verdict').nth(0)).toHaveClass(/state-untested/);
  await expect(page.locator('.system-verdict')).toHaveClass(/state-neutral/);
  await scanAt('reset with no implant: back to the arrival state, wiretap re-locked');

  // Reset KEEPS the implant deployed — `doReset` reads `aria-pressed` and
  // restores it — so this is the arrival state with an alarm endpoint, a
  // combination nothing else on the page produces twice.
  await setImplant(page, true);
  await page.getByRole('button', { name: BUTTONS.reset }).click();
  await expect(page.locator('.convo .bubble')).toHaveCount(0);
  await idle(page);
  await expect(page.locator('.switch')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.verdict-grid .verdict').nth(1)).toHaveClass(/state-alarm/);
  await expect(page.locator('.system-verdict')).toHaveClass(/state-alarm/);
  await expect(page.locator('.system-verdict')).toContainText(
    'No message has been sent yet, so the encryption is untested'
  );
  await scanAt('reset with the implant kept: empty conversation, compromised endpoint');

  // One last message, so the final rendering is a populated page in the alarm
  // palette with every disclosure open.
  await sendScripted(page, 1);
  await expect(page.locator('.capture-list li')).toHaveCount(2);
  await expect(page.locator('details.more[open]')).toHaveCount(2);
  await scanAt('the finished page: harvested conversation, both disclosures open');
}
