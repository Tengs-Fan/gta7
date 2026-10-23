import { expect, test } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

// Wave-1 properties and Azura Customs through the real keys: E buys at a property's marker, a car stopped in the
// customs bay opens its screen, Enter buys there and Esc drives off.
test.describe('wave-1 economy', () => {
  test('buy the garage with E and store a car in it', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.sim.progress.addMoney(50000);
      const m = g.sim.interactions.markers.find((k: { kind: string }) => k.kind === 'garage');
      g.teleport(m.x, m.z);
    });
    await expect(page.locator('.prompt')).toContainText('buy the garage for $15,000', { timeout: 5000 });
    const money = (await state(page)).money;
    await page.keyboard.press('KeyE');
    await expect(page.locator('.prompt')).toContainText('Your garage: 0/4', { timeout: 3000 });
    expect((await state(page)).money).toBe(money - 15000);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.spawnVehicle('sedan', true);
      g.place(-46.6, -253, Math.PI / 2);
    });
    await page.waitForTimeout(400);
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => (window as Api).__gta7.state().player.vehicle === null, null, { timeout: 4000 });
    await expect(page.locator('#ui')).toContainText('Car stored in your garage (1/4)', { timeout: 3000 });
    expect(errors).toEqual([]);
  });

  test('Azura Customs opens on a stop in its bay and sells an engine upgrade', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.sim.progress.addMoney(50000);
      g.spawnVehicle('sedan', true);
      g.place(207.5, -25, Math.PI);
    });
    await expect(page.locator('.customs')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(400);
    const money = await page.evaluate(() => (window as Api).__gta7.sim.progress.money);
    await page.keyboard.press('Enter');
    await expect(page.locator('.customs .shop-item[data-cat="engine"]')).toHaveAttribute('data-level', '1');
    expect(await page.evaluate(() => (window as Api).__gta7.sim.progress.money)).toBe(money - 1500);
    expect(await page.evaluate(() => (window as Api).__gta7.sim.player.vehicle.tune.accel)).toBe(1.1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.customs')).toHaveCount(0, { timeout: 3000 });
    expect(errors).toEqual([]);
  });
});
