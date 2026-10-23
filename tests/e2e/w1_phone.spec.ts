import { expect, test } from '@playwright/test';
import { boot, fakePad, newGame, padTap, type Api } from './helpers';

const top = (page: import('@playwright/test').Page) => page.evaluate(() => (window as Api).__gta7.game.menus.top?.el.className ?? null);

test.describe('wave 1: the phone', () => {
  test('Tab opens and closes it; Esc closes it without pausing; P pauses over it; M opens the map over it', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.keyboard.press('Tab');
    await expect(page.locator('.phone-screen')).toBeVisible();
    await page.waitForTimeout(350); // a screen takes no input for its first 0.25 s
    await expect(page.locator('.phone-row.contact b')).toHaveText(['Mama Lou (phone)', 'Dex Moreau (phone)']);
    await page.keyboard.press('Tab');
    await expect(page.locator('.phone-screen')).toHaveCount(0);
    expect(await top(page)).toBeNull();
    await page.keyboard.press('Tab');
    await expect(page.locator('.phone-screen')).toBeVisible();
    await page.waitForTimeout(350); // a screen takes no input for its first 0.25 s
    await page.keyboard.press('Escape');
    await expect(page.locator('.phone-screen')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await top(page)).toBeNull();
    await page.keyboard.press('Tab');
    await expect(page.locator('.phone-screen')).toBeVisible();
    await page.waitForTimeout(350); // a screen takes no input for its first 0.25 s
    await page.keyboard.press('KeyP');
    await expect(page.locator('.menu button', { hasText: 'RESUME' })).toBeVisible();
    await page.waitForTimeout(350);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !(window as Api).__gta7.game.menus.open);
    await page.keyboard.press('Tab');
    await expect(page.locator('.phone-screen')).toBeVisible();
    await page.waitForTimeout(350); // a screen takes no input for its first 0.25 s
    await page.keyboard.press('KeyM');
    await expect(page.locator('.map-screen')).toBeVisible();
    await page.waitForTimeout(350);
    await page.keyboard.press('KeyM');
    await expect(page.locator('.map-screen')).toHaveCount(0);
    await page.waitForTimeout(350);
    await expect(page.locator('.phone-screen')).toBeVisible();
    await page.waitForTimeout(350); // a screen takes no input for its first 0.25 s
    // Calling Lou: her offer line, and the GPS to her.
    await page.keyboard.press('Enter');
    await expect(page.locator('.subtitle')).toContainText('Mama Lou (phone)');
    expect(await page.evaluate(() => (window as Api).__gta7.ext.phone.routeContact())).toBe('lou');
    expect(await top(page)).toBeNull();
    // In a car the key does nothing (the phone is used on foot).
    await page.evaluate(() => (window as Api).__gta7.spawnVehicle('taxi', true));
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    expect(await top(page)).toBeNull();
    // T still starts the taxi job.
    await expect(page.locator('.prompt')).toContainText('taxi job', { timeout: 5000 });
    await page.keyboard.press('KeyT');
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job?.kind === 'taxi');
    expect(errors).toEqual([]);
  });

  test('on a gamepad, D-pad right on foot opens it and B closes it; the D-pad navigates it', async ({ page }) => {
    await fakePad(page);
    const errors = await boot(page);
    await newGame(page);
    const tap = async (b: number) => {
      await padTap(page, b);
      await page.waitForTimeout(200);
    };
    await tap(15);
    await expect(page.locator('.phone-screen')).toBeVisible();
    await page.waitForTimeout(350); // a screen takes no input for its first 0.25 s
    await tap(13);
    await expect(page.locator('.phone-row.sel b')).toHaveText('Dex Moreau (phone)');
    await tap(1);
    await expect(page.locator('.phone-screen')).toHaveCount(0);
    expect(await top(page)).toBeNull();
    // Start pauses over it.
    await tap(15);
    await expect(page.locator('.phone-screen')).toBeVisible();
    await page.waitForTimeout(350); // a screen takes no input for its first 0.25 s
    await tap(9);
    await expect(page.locator('.menu button', { hasText: 'RESUME' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a long text log opens on the newest text and the arrow keys scroll it to the oldest', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7.game;
      for (let i = 1; i <= 14; i++) {
        g.sim.events.emit('activityMilestone', { kind: 'taxi', reward: 100 + i });
        g.phoneLog.flush(g.sim);
      }
    });
    await page.keyboard.press('Tab');
    await expect(page.locator('.phone-screen')).toBeVisible();
    await page.waitForTimeout(350); // a screen takes no input for its first 0.25 s
    // One press a frame at most is read: space them out.
    const down = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(80);
      }
    };
    await down(3);
    await expect(page.locator('.phone-row.sel b')).toHaveText('Texts');
    await page.keyboard.press('Enter');
    await expect(page.locator('.phone-title')).toHaveText('TEXTS');
    const list = page.locator('.phone-list');
    const scroll = () => list.evaluate((l) => ({ top: l.scrollTop, max: l.scrollHeight - l.clientHeight }));
    await expect(page.locator('.phone-text.sel')).toContainText('+$114');
    const opened = await scroll();
    expect(opened.max).toBeGreaterThan(0);
    expect(opened.top).toBe(0);
    await down(13);
    await expect(page.locator('.phone-text.sel')).toContainText('+$101');
    await expect(page.locator('.phone-text.sel')).toBeInViewport();
    expect((await scroll()).top).toBeGreaterThan(0);
    await down(1);
    await expect(page.locator('.phone-row.sel b')).toHaveText('Back');
    expect(errors).toEqual([]);
  });

  test('a contact calls when new work turns up; Tab answers', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => (window as Api).__gta7.sim.progress.markDone('wheels'));
    await expect(page.locator('.phone-call')).toContainText('Mama Lou (phone)', { timeout: 15000 });
    await expect(page.locator('.phone-call kbd')).toHaveText('Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('.phone-call')).toBeHidden();
    await expect(page.locator('.subtitle')).toContainText('Hot Delivery');
    expect(await top(page)).toBeNull();
    expect(await page.evaluate(() => (window as Api).__gta7.sim.missions.active)).toBeNull();
    expect(errors).toEqual([]);
  });
});
