import { expect, test } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

test.describe('AzuraLink', () => {
  test('ride once: E at Northshore waits for the train, which takes him aboard for $5; F gets him off at Seaview', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const f = g.sim.world.layout.monorail.stations[0].foot;
      g.teleport(f.x, f.z);
    });
    await expect(page.locator('.prompt')).toContainText('ride AzuraLink to Seaview', { timeout: 5000 });
    const money = (await state(page)).money;
    await page.keyboard.press('KeyE');
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job?.kind === 'monorail');
    expect((await state(page)).activityStatus).toMatch(/TRAIN IN/);
    // Forward to a moment before the train leaves: it takes him aboard and the camera rides beside it.
    await page.evaluate(() => {
      const sim = (window as Api).__gta7.sim;
      sim.time = Math.max(sim.time, sim.activities.job.departs - 1.5);
    });
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job?.stage === 'riding', null, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    const aboard = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const r = g.game.renderer;
      const m = g.sim.world.layout.monorail;
      const cam = r.cameraCtl.camera.position;
      return { hidden: r.crowd.scopeHiddenId === g.sim.player.id, camX: cam.x - m.x, camY: cam.y, beamY: m.beamY, locked: g.sim.controlLock > 0 };
    });
    expect(aboard.hidden).toBe(true);
    expect(aboard.locked).toBe(true);
    expect(Math.abs(aboard.camX)).toBeLessThan(8);
    expect(aboard.camY).toBeGreaterThan(aboard.beamY);
    expect((await state(page)).money).toBe(money - 5);
    // F: off at Seaview's foot at once, walking again.
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job === null);
    const off = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const f = g.sim.world.layout.monorail.stations[1].foot;
      const p = g.sim.player.pos;
      return { d: Math.hypot(p.x - f.x, p.z - f.z), locked: g.sim.controlLock > 0 };
    });
    expect(off.d).toBeLessThan(1);
    expect(off.locked).toBe(false);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as Api).__gta7.game.renderer.crowd.scopeHiddenId)).toBe(-1);
    const before = (await state(page)).player;
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(800);
    await page.keyboard.up('KeyW');
    const after = (await state(page)).player;
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(1);
    expect(errors).toEqual([]);
  });
});
