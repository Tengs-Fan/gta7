import { expect, test } from '@playwright/test';
import { boot, fakePad, newGame, padTap, type Api } from './helpers';

test.describe('wave 1: map legend, settings and pause on focus loss', () => {
  test('losing window focus pauses play (and the WASTED screen); coming back does not resume', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const read = () => page.evaluate(() => { const g = (window as Api).__gta7; return { hours: g.sim.clock.hours, time: g.sim.time, menu: g.state().menuOpen, death: g.sim.player.deathTimer ?? g.sim.players[0].deathTimer }; });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('.menu button', { hasText: 'RESUME' })).toBeVisible();
    const a = await read();
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1000);
    const b = await read();
    console.log('blur in play', JSON.stringify({ before: a, after: b }));
    expect(b.time).toBe(a.time);
    expect(b.menu).toBe(true);
    await page.waitForTimeout(350);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !(window as Api).__gta7.game.menus.open);
    // WASTED: the countdown waits under the pause menu.
    await page.evaluate(() => (window as Api).__gta7.sim.combat.kill((window as Api).__gta7.sim.player, null, 'bullet', 1, 0));
    await page.waitForFunction(() => (window as Api).__gta7.sim.playerDown);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('.menu button', { hasText: 'RESUME' })).toBeVisible();
    const c = await read();
    await page.waitForTimeout(2500);
    const d = await read();
    console.log('blur while wasted', JSON.stringify({ before: c, after: d }));
    expect(d.time).toBe(c.time);
    expect(await page.evaluate(() => (window as Api).__gta7.sim.playerDown)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('the map legend and checklist work with a gamepad alone', async ({ page }) => {
    await fakePad(page);
    const errors = await boot(page);
    await newGame(page);
    await padTap(page, 8); // Back: the map
    await expect(page.locator('.map-screen')).toBeVisible();
    await expect(page.locator('.map-checklist')).toContainText('Hidden packages');
    await page.waitForTimeout(350);
    await padTap(page, 3); // Y: pick the next legend row (shops)
    await expect(page.locator('.legend-row.sel')).toContainText('Shops');
    await padTap(page, 2); // X: switch it off
    await expect(page.locator('.legend-row.sel')).toHaveClass(/off/);
    expect(await page.evaluate(() => (window as Api).__gta7.game.settings.mapLayers)).toEqual({ shops: false });
    await padTap(page, 2);
    expect(await page.evaluate(() => (window as Api).__gta7.game.settings.mapLayers)).toEqual({ shops: true });
    await page.screenshot({ path: 'test-results/uix-map-legend-pad.png' });
    expect(errors).toEqual([]);
  });

  test('SETTINGS reaches key bindings with a gamepad alone, and B cancels a waiting rebind', async ({ page }) => {
    await fakePad(page);
    const errors = await boot(page);
    // From the title: SETTINGS is the item after the play items; walk the menu until it is selected.
    for (let i = 0; i < 12; i++) {
      if ((await page.locator('.menu button.sel').textContent())?.trim() === 'SETTINGS') break;
      await padTap(page, 13);
    }
    await padTap(page, 0);
    await expect(page.locator('h2', { hasText: 'SETTINGS' })).toBeVisible();
    await page.waitForTimeout(350);
    for (let i = 0; i < 2; i++) await padTap(page, 12); // up round past BACK (DELETE SAVE greyed out) to Key bindings
    await expect(page.locator('.setting.sel')).toContainText('Key bindings');
    await padTap(page, 0);
    await expect(page.locator('.bindings-panel')).toBeVisible();
    await page.waitForTimeout(350);
    await padTap(page, 0); // the first action waits for a key
    await expect(page.locator('.bind-row.waiting')).toHaveCount(1);
    await padTap(page, 1); // B gives up the wait
    await expect(page.locator('.bind-row.waiting')).toHaveCount(0);
    await expect(page.locator('.bind-note')).toHaveText('Cancelled.');
    expect(errors).toEqual([]);
  });
});
