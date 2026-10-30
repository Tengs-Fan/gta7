import { expect, test } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

// Wave-1 jobs, each started by its own prompt's key: T in its vehicle (ambulance, fire truck, a car at the courier
// office), E at Lou's export board.
test.describe('wave-1 activities', () => {
  test('paramedic and firefighter jobs start from T in their vehicles', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    for (const [kind, prompt, title, activity] of [
      ['ambulance', 'paramedic job', 'PARAMEDIC', 'ambulance'],
      ['firetruck', 'firefighter job', 'FIREFIGHTER', 'firefighter'],
    ] as const) {
      await page.evaluate((k) => {
        const g = (window as Api).__gta7;
        g.godMode(true);
        g.spawnVehicle(k, true);
      }, kind);
      await expect(page.locator('.prompt')).toContainText(prompt, { timeout: 5000 });
      await page.keyboard.press('KeyT');
      await expect(page.locator('.big')).toContainText(title, { timeout: 3000 });
      expect((await state(page)).activity).toBe(activity);
      await expect(page.locator('.status')).toContainText(`${title} LVL 1`);
      await page.keyboard.press('KeyT');
      await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job === null);
      await page.evaluate(() => (window as Api).__gta7.sim.playerCtl.ejectPlayer(false));
      // The HUD queues title cards: the next job's title waits until this one's 3 s card has gone.
      await expect(page.locator('.big.show')).toHaveCount(0, { timeout: 5000 });
    }
    expect(errors).toEqual([]);
  });

  test('a courier run starts from a car stopped at Azura Express', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.spawnVehicle('sedan', true);
      g.place(2, -137, Math.PI);
    });
    await expect(page.locator('.prompt')).toContainText('courier run', { timeout: 5000 });
    await page.keyboard.press('KeyT');
    await expect(page.locator('.big')).toContainText('AZURA EXPRESS', { timeout: 3000 });
    expect((await state(page)).activity).toBe('courier');
    await expect(page.locator('.status')).toContainText('COURIER 1/3');
    expect(errors).toEqual([]);
  });

  test("Lou's export board takes the list with E and shows it", async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    // The board stands 6 m along the sidewalk from Lou's marker (places.ts exportBoard).
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const lou = g.poi('lou')!;
      g.teleport(lou.x + 6, lou.z);
    });
    await expect(page.locator('.prompt')).toContainText("export list", { timeout: 5000 });
    await page.keyboard.press('KeyE');
    await expect(page.locator('.export-board')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.export-row')).toHaveCount(8);
    expect((await state(page)).activity).toBe('carExport');
    // Past the screen's input guard (Menus ignores the first 0.25 s).
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await expect(page.locator('.export-board')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('.export-widget')).toContainText('EXPORT LIST 0/8');
    expect(errors).toEqual([]);
  });
});
