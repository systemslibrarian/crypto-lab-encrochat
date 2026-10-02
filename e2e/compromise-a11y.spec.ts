import { test, expect } from '@playwright/test';
import { scan, reportCollected } from './gate';

test('architecture probe results remain accessible at narrow width', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 380, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('.');
  const lab = page.locator('#architecture-lab');
  await lab.getByRole('button', { name: 'Device vendor signer', exact: true }).click();
  for (const mode of ['independent', 'shared', 'renamed']) {
    await lab.locator('select').selectOption(mode);
    await lab.locator('#architecture-run').click();
    await expect(lab.locator('#architecture-run')).toBeEnabled();
    await expect(lab).not.toContainText('failed to run');
    await scan(page, 'architecture ' + mode);
  }
  reportCollected();
});
