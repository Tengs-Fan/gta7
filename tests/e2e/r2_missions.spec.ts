import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

test.describe('GTA 7 mission retry', () => {
  test('a failed mission offers a retry, and E restarts it', async ({ page }) => {
    // Headless Chromium that grants pointer lock can stop delivering frames: refuse it, as the playtests do.
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.requestPointerLock = function () {
        throw new DOMException('pointer lock disabled under automation', 'NotSupportedError');
      };
    });
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.markDone('wheels');
      g.startMission('delivery');
    });
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === 'delivery');
    await page.evaluate(() => (window as Api).__gta7.sim.missions.active.fail('test'));
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === null);
    await expect(page.locator('.big')).toContainText('Press E to retry');
    await expect(page.locator('.prompt')).toContainText('retry', { timeout: 5000 });
    await expect(page.locator('.prompt')).toContainText('Hot Delivery');
    // Pressed while MISSION FAILED is still up (it shows for 4.5 s).
    const shown = () => page.evaluate(() => ({ big: document.querySelector('.big')!.className, sub: document.querySelector('.subtitle')!.className }));
    expect((await shown()).big).toContain('show');
    await page.keyboard.press('KeyE');
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === 'delivery', null, { timeout: 5000 });
    // Straight back to work: the old banner gone at once (it had seconds left), no intro, no title card, the player at Lou's.
    expect((await shown()).big).not.toContain('show');
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Collect the package', null, { timeout: 5000 });
    await page.waitForTimeout(600);
    expect(await shown()).toEqual({ big: expect.not.stringContaining('show'), sub: expect.not.stringContaining('show') });
    const near = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const lou = g.poi('lou');
      const p = g.state().player;
      return Math.hypot(p.x - lou.x, p.z - lou.z);
    });
    expect(near).toBeLessThan(6);
    await expect(page.locator('.prompt')).toBeHidden();
    expect(errors).toEqual([]);
  });
});
