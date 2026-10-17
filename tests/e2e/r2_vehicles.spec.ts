import { expect, test } from '@playwright/test';

import { boot, newGame, type Api } from './helpers';

// Round 2 vehicles: a real crash in the browser dents the car, cracks its glass, throws parts and glass, and a car
// grinding along a container throws sparks, all on the real WebGL renderer without a console error.
test.describe('GTA 7 vehicle damage', () => {
  test('a crash into a container dents the car and throws parts; scraping along it throws sparks', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const ok = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const sim = g.sim;
      g.godMode(false);
      sim.policeEnabled = false;
      // A ground-floor container whose long side has 22 m of clear, level ground in front of it.
      const blocked = (x0: number, z0: number, x1: number, z1: number): boolean =>
        sim.world.grid.colliders.some((c: Api) => !c.broken && c.maxX > x0 && c.minX < x1 && c.maxZ > z0 && c.minZ < z1);
      for (const p of sim.world.layout.props) {
        if (p.kind !== 'container' || p.y > 1 || p.w < p.d) continue;
        for (const side of [-1, 1]) {
          const face = p.z + (side * p.d) / 2;
          const far = face + side * 22;
          if (blocked(p.x - 1.6, Math.min(face + side * 0.05, far), p.x + 1.6, Math.max(face + side * 0.05, far))) continue;
          if (Math.abs(sim.world.groundHeight(p.x, face + side * 10) - sim.world.groundHeight(p.x, far)) > 0.05) continue;
          (window as Api).__crash = { x: p.x, face, side, cont: p };
          return true;
        }
      }
      return false;
    });
    expect(ok).toBe(true);
    const crash = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const sim = g.sim;
      const c = (window as Api).__crash;
      const v = sim.spawnVehicle('sedan', c.x, c.face + c.side * 14, c.side > 0 ? Math.PI : 0);
      sim.seat(sim.player, v, 0);
      v.usedByPlayer = true;
      const w = window as Api;
      w.__car = v;
      w.__hit = 0;
      sim.events.on('impact', (e: Api) => {
        if (e.vehicle === v && !w.__hit) w.__hit = e.strength;
      });
      // Hold 22 m/s straight at the container until the first impact.
      const update = sim.update.bind(sim);
      sim.update = (dt: number, inp: Api) => {
        if (!w.__hit && w.__car === v) {
          v.vel.x = Math.sin(v.heading) * 22;
          v.vel.z = Math.cos(v.heading) * 22;
          v.angVel = 0;
        }
        if (w.__push) w.__push();
        update(dt, inp);
      };
      return v.id;
    });
    expect(crash).toBeGreaterThan(0);
    await page.waitForFunction(() => (window as Api).__hit > 0, null, { timeout: 10_000 });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const v = (window as Api).__car;
      const r = g.game.renderer;
      const view = r.vehicleViews.get(v.id);
      const glass = view.group.children.find((o: Api) => o.name === 'glass');
      return { hit: (window as Api).__hit, dents: v.dents.length, lz: v.dents[0]?.lz ?? 0, half: v.halfL, condition: v.condition, parts: r.effects.partCount, glassMap: !!glass.material.map, glassOpacity: glass.material.opacity };
    });
    expect(after.hit).toBeGreaterThan(20);
    expect(after.dents).toBeGreaterThan(0);
    expect(after.lz).toBeGreaterThan(after.half * 0.7);
    expect(after.condition).toBeLessThan(0.55);
    expect(after.parts).toBeGreaterThanOrEqual(1);
    expect(after.parts).toBeLessThanOrEqual(3);
    expect(after.glassOpacity).toBeGreaterThan(0.4);
    // Now grind along the container's side.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const sim = g.sim;
      const w = window as Api;
      const c = w.__crash;
      const p = c.cont;
      sim.playerCtl.ejectPlayer(true);
      for (const v of [...sim.vehicles]) sim.removeVehicle(v);
      // Alongside the container from the start, its side 3 cm into the container's.
      const v = sim.spawnVehicle('muscle', p.x - p.w / 2 + 3, c.face + c.side * 0.97, Math.PI / 2);
      sim.seat(sim.player, v, 0);
      w.__car = v;
      w.__scrapes = 0;
      sim.events.on('scrape', (e: Api) => {
        if (e.vehicle === v) w.__scrapes++;
      });
      w.__push = () => {
        v.vel.x = 14;
        v.vel.z = -c.side * 0.8;
        v.angVel = 0;
      };
    });
    await page.waitForFunction(() => (window as Api).__scrapes >= 3, null, { timeout: 10_000 });
    const sparks = await page.evaluate(() => (window as Api).__gta7.state().render.particles);
    expect(sparks).toBeGreaterThan(0);
    await page.evaluate(() => {
      (window as Api).__push = null;
    });
    const px = await page.evaluate(() => (window as Api).__gta7.samplePixels());
    expect(px.colors).toBeGreaterThan(12);
    expect(errors).toEqual([]);
  });
});
