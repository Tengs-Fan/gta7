import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

test.describe('GTA 7 driving (round 2)', () => {
  test('a steering key winds the wheel in gradually at speed', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    // A sports car at 30 m/s heading south down Azura Ave, a long straight avenue, alone.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.traffic.density = 0;
      for (const o of g.sim.vehicles) g.sim.removeVehicle(o);
      g.spawnVehicle('sports', true);
      const n = g.sim.roads.node(5, 1);
      g.place(n.x - 2, n.z + n.halfZ + 8, 0);
      g.sim.player.vehicle.vel.z = 30;
      // Record, every frame, the steering sent to the car and how long D has been held.
      const w = window as unknown as { __steer: { held: number; max: number; frames: number } };
      w.__steer = { held: 0, max: 0, frames: 0 };
      let down = false;
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyD') down = true;
      });
      window.addEventListener('keyup', (e) => {
        if (e.code === 'KeyD') down = false;
      });
      const game = g.game;
      const step = game.step.bind(game);
      game.step = (dt: number, fi: unknown) => {
        step(dt, fi);
        const v = g.sim.player.vehicle;
        if (!down || !v) return;
        w.__steer.held += dt;
        w.__steer.frames++;
        w.__steer.max = Math.max(w.__steer.max, v.controls.steer);
      };
    });
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(150);
    await page.keyboard.up('KeyD');
    await page.waitForTimeout(300);
    await page.keyboard.up('KeyW');
    const s = await page.evaluate(() => (window as unknown as { __steer: { held: number; max: number; frames: number } }).__steer);
    expect(s.frames).toBeGreaterThan(0);
    expect(s.max).toBeGreaterThan(0);
    // The old controller sent full lock (1) on the first frame. At ~30 m/s the keyboard wheel winds in
    // at about 1.4/s, cut to about 70% above 20 m/s: well under half lock within half a second.
    expect(s.max).toBeLessThan(Math.min(0.5, 1.6 * s.held + 0.05));
    expect(errors).toEqual([]);
  });
});
