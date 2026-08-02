import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WCAG 2.1 A/AA gate. Runs against the production `vite preview` build, so what
 * passes here is what ships. Axe only checks what is in the DOM, so we drive
 * EVERY panel into its post-interaction state — the full conversation, the
 * labeled wire packet, the ratchet strip, the break-it results, the implant
 * capture list, all three verdict states, and every disclosure — before
 * scanning, in both themes. All app commands are serialized behind an
 * aria-busy flag, so we wait for each to settle.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById("app")?.getAttribute("aria-busy") !== "true",
  );
}

async function driveDemos(page: Page): Promise<void> {
  await page.waitForSelector(".cl-hero-title");
  await settle(page);

  // Neutralize motion so nothing is mid-animation when axe measures contrast.
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important}`,
  });

  // Send the full scripted exchange (button disables itself at the end).
  const sendNext = page.getByRole("button", { name: /send next message/i });
  for (let i = 0; i < 4; i++) {
    if (!(await sendNext.isEnabled())) break;
    await sendNext.click();
    await settle(page);
  }

  // Compose a custom message so the free-text path is exercised too.
  await page.fill("#custom-msg", "custom traffic for the wire");
  await page.getByRole("button", { name: /encrypt & send/i }).click();
  await settle(page);

  // Deploy the endpoint implant, then send again so the capture list populates
  // and the endpoint + system verdicts flip to their ALARM state.
  await page.locator(".switch").click();
  await settle(page);
  await expect(page.locator(".switch")).toHaveAttribute("aria-pressed", "true");
  await page.fill("#custom-msg", "harvested at the endpoint");
  await page.getByRole("button", { name: /encrypt & send/i }).click();
  await settle(page);
  await page.waitForSelector(".capture-list li");

  // Open every disclosure and run the break-it experiments.
  await page.evaluate(() => {
    document.querySelectorAll("details").forEach((d) => ((d as HTMLDetailsElement).open = true));
  });
  await page.getByRole("button", { name: /tap the wire/i }).click();
  await settle(page);
  await page.getByRole("button", { name: /forge a packet/i }).click();
  await settle(page);
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

/**
 * SC 1.4.11 (non-text contrast): the boundary of every text-entry control must
 * reach 3:1 against the adjacent surface AND against the field's own fill, in
 * both themes. Axe does not flag border-vs-surface, so this is asserted
 * directly from rendered computed styles, compositing translucent colors over
 * the real ancestor backdrop.
 */
async function minBorderContrast(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`no element: ${sel}`);
    type C = { r: number; g: number; b: number; a: number };
    const parse = (s: string): C => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return { r: 0, g: 0, b: 0, a: 0 };
      const p = m[1].split(/[,\s/]+/).map(parseFloat);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (fg: C, bg: C): C => {
      const a = fg.a + bg.a * (1 - fg.a);
      return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
        a,
      };
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
    const lum = (c: C) => {
      const f = (v: number) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a: C, b: C) => {
      const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
      return (hi + 0.05) / (lo + 0.05);
    };
    const cs = getComputedStyle(el);
    const outside = backdrop(el.parentElement);
    const fillRaw = parse(cs.backgroundColor);
    const fill = fillRaw.a > 0 ? over(fillRaw, outside) : outside;
    const border = over(over(parse(cs.borderTopColor), fill), outside);
    return Math.min(ratio(border, outside), ratio(border, fill));
  }, selector);
}

const TEXT_CONTROLS = ["#custom-msg"];

test("text-entry control borders reach 3:1 — dark theme", async ({ page }) => {
  await page.goto(".");
  await page.waitForSelector("#custom-msg");
  for (const sel of TEXT_CONTROLS) {
    expect(await minBorderContrast(page, sel), `${sel} (dark)`).toBeGreaterThanOrEqual(3);
  }
});

test("text-entry control borders reach 3:1 — light theme", async ({ page }) => {
  await page.goto(".");
  await page.waitForSelector("#custom-msg");
  await page.locator("#cl-theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const sel of TEXT_CONTROLS) {
    expect(await minBorderContrast(page, sel), `${sel} (light)`).toBeGreaterThanOrEqual(3);
  }
});

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
