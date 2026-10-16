import { expect, test } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

/** Starts a mission from its contact marker with real input (E). */
async function startAtMarker(page: import('@playwright/test').Page, id: string): Promise<void> {
  await page.evaluate((mid) => {
    const g = (window as Api).__gta7;
    const m = g.sim.interactions.markers.find((x: Api) => x.kind === 'mission' && x.ref === mid);
    g.place(m.x, m.z);
  }, id);
  await page.waitForTimeout(300);
  await page.keyboard.press('KeyE');
  await page.waitForFunction((mid) => (window as Api).__gta7.state().mission === mid, id, { timeout: 5000 });
}

test.describe('GTA 7 story missions in the browser', () => {
  test('Hot Delivery: collect the package and beat the timer', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.markDone('wheels');
    });
    await startAtMarker(page, 'delivery');
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Collect the package', null, { timeout: 25_000 });
    const money0 = (await state(page)).money;
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const m = g.sim.missions.active.markers[0];
      g.place(m.x, m.z);
    });
    await page.waitForFunction(() => String((window as Api).__gta7.state().objective).startsWith('Deliver'), null, { timeout: 5000 });
    await expect(page.locator('.status')).toContainText('DELIVERY');
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const m = g.sim.missions.active.markers[0];
      g.place(m.x, m.z);
    });
    await expect(page.locator('.big')).toContainText('MISSION PASSED', { timeout: 15_000 });
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === null, null, { timeout: 15_000 });
    expect((await state(page)).money).toBe(money0 + 1200);
    expect(errors).toEqual([]);
  });

  test('The Big Score: hold the bank, escape to the marina', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.missions.noBust = true;
      g.markDone('wheels', 'delivery', 'repo', 'loose_lips', 'heatwave');
    });
    await startAtMarker(page, 'big_score');
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Go to the First Azura Bank', null, { timeout: 25_000 });
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const b = g.poi('bank');
      g.place(b.x, b.z);
    });
    await page.waitForFunction(() => String((window as Api).__gta7.state().objective).startsWith('Hold'), null, { timeout: 5000 });
    expect((await state(page)).wanted).toBe(3);
    await expect(page.locator('.status')).toContainText('VAULT');
    // Keep the player in the bank area while the vault opens (cops may knock us around).
    await page.waitForFunction(() => {
      const g = (window as Api).__gta7;
      const b = g.poi('bank');
      const p = g.sim.player;
      if (p.state === 'normal' && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) > 6) g.place(b.x, b.z);
      return g.state().objective === 'Get in the getaway car';
    }, null, { timeout: 60_000, polling: 500 });
    expect((await state(page)).wanted).toBeGreaterThanOrEqual(4);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const car = g.sim.missions.active.vehicles[0];
      if (g.sim.player.vehicle) g.sim.playerCtl.ejectPlayer(true);
      g.sim.seat(g.sim.player, car, 0);
    });
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Escape to the Marina', null, { timeout: 5000 });
    const money0 = (await state(page)).money;
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const m = g.poi('marina');
      g.place(m.x - 3, m.z);
    });
    await expect(page.locator('.big')).toContainText('MISSION PASSED', { timeout: 20_000 });
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === null, null, { timeout: 20_000 });
    const s = await state(page);
    expect(s.money).toBe(money0 + 25000);
    expect(s.wanted).toBe(0);
    expect(s.missionsDone).toContain('big_score');
    expect(errors).toEqual([]);
  });
});
