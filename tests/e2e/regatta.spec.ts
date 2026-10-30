// The Gull Regatta in the real game: aboard a Marlin on the start line off the Marina, T starts it, the countdown holds
// the boat, and with W held and A or D steering the bow onto the line it takes the first gate off the end of Azura Pier.

import { expect, test } from '@playwright/test';
import { REGATTA_GATES, REGATTA_START } from '../../src/sim/activities/regatta';
import { boot, newGame, type Api } from './helpers';

test.describe('Gull Regatta', () => {
  test('starts from a boat at the Marina with T and passes the first gate', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate((start) => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setTime(15);
      const boat = g.sim.spawnVehicle('speedboat', start.x, start.z, start.heading);
      boat.pos.y = -1;
      g.sim.seat(g.sim.player, boat, 0);
    }, REGATTA_START);
    await expect.poll(() => page.evaluate(() => (window as Api).__gta7.sim.activities.jobPrompt())).toBe('Press T to start the Gull Regatta');
    await page.keyboard.press('t');
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job?.stage === 'countdown', null, { timeout: 10_000 });
    await page.waitForFunction(() => {
      const g = (window as Api).__gta7;
      return g.sim.activities.job?.stage === 'racing' && g.sim.controlLock === 0;
    }, null, { timeout: 10_000 });
    const gate = REGATTA_GATES[0]!;
    await page.keyboard.down('w');
    let held: string | null = null;
    let r = { gate: 0, x: 0, z: 0, err: 0 };
    for (const deadline = Date.now() + 45_000; Date.now() < deadline; ) {
      r = await page.evaluate((to) => {
        const g = (window as Api).__gta7;
        const b = g.sim.player.vehicle;
        const off = Math.atan2(to.x - b.pos.x, to.z - b.pos.z) - b.heading;
        return { gate: g.sim.activities.job?.gate ?? -1, x: b.pos.x as number, z: b.pos.z as number, err: Math.atan2(Math.sin(off), Math.cos(off)) };
      }, gate);
      if (r.gate !== 0) break;
      // D turns the bow clockwise seen from above (the heading falls), A the other way.
      const want = r.err < -0.04 ? 'd' : r.err > 0.04 ? 'a' : null;
      if (want !== held) {
        if (held) await page.keyboard.up(held);
        if (want) await page.keyboard.down(want);
        held = want;
      }
      await page.waitForTimeout(80);
    }
    if (held) await page.keyboard.up(held);
    await page.keyboard.up('w');
    console.log(`[regatta-e2e] next gate ${r.gate + 1} with the boat at (${r.x.toFixed(1)}, ${r.z.toFixed(1)})`);
    expect(r.gate).toBe(1);
    expect(await page.evaluate(() => (window as Api).__gta7.sim.activities.status())).toMatch(/^GULL REGATTA · GATE 2\/14 · \d:\d\d\.\d$/);
    expect(errors).toEqual([]);
  });
});
