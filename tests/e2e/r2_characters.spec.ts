import { expect, test } from '@playwright/test';
import { type Api, boot, newGame } from './helpers';

// Round 2, characters cluster, in the real renderer: shots leave from the drawn barrel tip, and a driver
// is drawn in his car.

test.describe('character rig', () => {
  test('rifle shots start at the end of the drawn barrel, and a parked car shows its driver', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.give('rifle', 300);
      g.setCamera(g.sim.player.heading, 0.05);
      g.game.renderer.cameraCtl.sensitivity = 0;
      // On every player shot, where the drawn rifle's barrel ends right now (instance matrix of the
      // last rendered frame, column-major) next to where the shot started.
      const w = (window as Api).__shots = [] as Array<{ gap: number }>;
      g.sim.events.on('shot', (e: Api) => {
        if (e.shooter !== g.sim.player) return;
        const part = g.game.renderer.crowd.weapons.get('rifle');
        if (!part || part.mesh.count < 1) return;
        const m = part.mesh.instanceMatrix.array as Float32Array;
        const z = 0.705;
        const x = m[8]! * z + m[12]!;
        const y = m[9]! * z + m[13]!;
        const zz = m[10]! * z + m[14]!;
        w.push({ gap: Math.hypot(x - e.fx, y - e.fy, zz - e.fz) });
      });
    });
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(700);
    for (let i = 0; i < 4; i++) {
      await page.mouse.click(640, 360);
      await page.waitForTimeout(350);
    }
    await page.mouse.up({ button: 'right' });
    const shots = await page.evaluate(() => (window as Api).__shots as Array<{ gap: number }>);
    expect(shots.length).toBeGreaterThan(0);
    // The first shot of each click leaves from the tip drawn the frame before (a few cm of motion at most).
    expect(Math.min(...shots.map((s) => s.gap))).toBeLessThan(0.06);

    // A sedan with a driver parked a few metres ahead: his head is drawn inside it.
    const found = await page.evaluate(async () => {
      const g = (window as Api).__gta7;
      const sim = g.sim;
      const p = sim.player;
      const h = p.heading;
      const v = sim.spawnVehicle('sedan', p.pos.x + Math.sin(h) * 6, p.pos.z + Math.cos(h) * 6, h + Math.PI / 2);
      const d = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
      sim.seat(d, v, 0);
      await new Promise((r) => setTimeout(r, 500));
      const heads = g.game.renderer.crowd.parts.head.mesh;
      const a = heads.instanceMatrix.array as Float32Array;
      let inside = 0;
      for (let i = 0; i < heads.count; i++) {
        const x = a[i * 16 + 12]!;
        const y = a[i * 16 + 13]!;
        const z = a[i * 16 + 14]!;
        if (Math.hypot(x - v.pos.x, z - v.pos.z) < v.halfL && y > v.pos.y + 0.8 && y < v.pos.y + v.spec.height) inside++;
      }
      return inside;
    });
    expect(found).toBe(1);
    expect(errors).toEqual([]);
  });
});
