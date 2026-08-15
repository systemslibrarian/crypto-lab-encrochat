import { expect, test } from '@playwright/test';
import {
  boot,
  driveAllStates,
  expectBaselineNotStale,
  NARROW,
  reportCollected,
  watchPageErrors,
} from './gate';

/**
 * WCAG A/AA regression gate.
 *
 * The lab is driven along everything it teaches, and every state is scanned as
 * it is reached: the arrival page, where nothing has been sent, the encryption
 * verdict reads `NOT YET TESTED`, the system verdict `AWAITING EVIDENCE` and
 * "Tap the wire" is locked; the skip link focused; the implant deployed with
 * NOTHING sent, which is the only route to the "encryption is untested — but an
 * implant already reads plaintext" headline, and then removed again; both
 * disclosures opened through their own summaries, which is also the only way the
 * two attack controls inside the first one become clickable at all; each of the
 * four scripted messages separately, because they are not interchangeable —
 * Alice's second in a row advances the symmetric ratchet only, Bob's reply is
 * the page's one `.bubble.from-bob`, and the fourth exhausts the script and
 * disables its own button; a wiretap attempted without keys; a packet forged,
 * rejected, and the authentic one recovered; a blank compose submission, which
 * must change nothing; 120 unbroken characters, which is the reflow case and the
 * only content on the page a reader controls; the implant deployed over a live
 * conversation and driven until the capture scroller passes its cap; the implant
 * removed, which clears the harvest and returns the system verdict to sound; and
 * Reset in both of its branches, since it keeps the implant deployed if it was.
 * All of that in both themes, at desktop and phone width.
 *
 * No clipboard permission is granted because this lab has no copy control — the
 * only `navigator` API it touches is `crypto`.
 *
 * See `gate.ts` for why nothing is injected into the page, why no disclosure is
 * force-opened, why the lab's defaults are asserted rather than assumed, and why
 * `violations` is not the whole oracle.
 */

for (const theme of ['dark', 'light'] as const) {
  test(`no WCAG A/AA violations in ${theme} theme`, async ({ page }) => {
    test.setTimeout(900_000);
    const errors = watchPageErrors(page);
    await boot(page, theme);
    await driveAllStates(page, theme);
    expect(errors, errors.join('\n')).toEqual([]);
    reportCollected();
    expectBaselineNotStale();
  });

  test(`no WCAG A/AA violations in ${theme} theme at 380px`, async ({ page }) => {
    test.setTimeout(900_000);
    const errors = watchPageErrors(page);
    await page.setViewportSize(NARROW);
    await boot(page, theme);
    await driveAllStates(page, `${theme} @380px`);
    expect(errors, errors.join('\n')).toEqual([]);
    reportCollected();
    expectBaselineNotStale();
  });
}
