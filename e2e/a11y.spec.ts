import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WCAG 2.1 A/AA gate. Runs against the production `vite preview` build, so what
 * passes here is what ships. Axe only checks what is in the DOM, so we drive
 * EVERY panel into its post-interaction state — the full conversation, the wire,
 * the ratchet strip, the break-it results, the implant capture list, all three
 * verdict states, and every disclosure — before scanning, in both themes.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function driveDemos(page: Page): Promise<void> {
  await page.waitForSelector(".cl-hero-title");

  // Neutralize motion so nothing is mid-animation when axe measures contrast.
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important}`,
  });

  // Send the full scripted exchange (button disables itself at the end).
  const sendNext = page.getByRole("button", { name: /send next message/i });
  for (let i = 0; i < 6; i++) {
    if (!(await sendNext.isEnabled().catch(() => false))) break;
    await sendNext.click();
  }

  // Compose a custom message so the free-text path is exercised too.
  await page.fill("#custom-msg", "custom traffic for the wire");
  await page.getByRole("button", { name: /encrypt & send/i }).click();

  // Deploy the endpoint implant, then send again so the capture list populates
  // and the endpoint + system verdicts flip to their ALARM state.
  await page.locator(".switch").click();
  await expect(page.locator(".switch")).toHaveAttribute("aria-pressed", "true");
  await page.fill("#custom-msg", "harvested at the endpoint");
  await page.getByRole("button", { name: /encrypt & send/i }).click();
  await page.waitForSelector(".capture-list li");

  // Open every disclosure and run the break-it experiments.
  await page.evaluate(() => {
    document.querySelectorAll("details").forEach((d) => ((d as HTMLDetailsElement).open = true));
  });
  await page.getByRole("button", { name: /tap the wire/i }).click();
  await page.getByRole("button", { name: /flip a bit/i }).click();
  await page.waitForTimeout(300);
}

async function scan(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5),
    })),
  ).toEqual([]);
}

test("no WCAG A/AA violations — dark theme", async ({ page }) => {
  await page.goto(".");
  await driveDemos(page);
  await scan(page);
});

test("no WCAG A/AA violations — light theme", async ({ page }) => {
  await page.goto(".");
  await driveDemos(page);
  await page.locator("#cl-theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await scan(page);
});
