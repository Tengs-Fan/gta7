import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Wave 1 track C: motorbikes drawn by their own view on every tier, with their riders, through repeated tier
// switches (VAL-BIKE-008). Under GTA7_SWIFTSHADER=1 the same run checks the software renderer. Screenshots go to
// GTA7_SHOTS when it is set.

const SHOTS = process.env.GTA7_SHOTS;
const TIERS = ['high', 'medium', 'low', 'high', 'medium', 'low', 'high'] as const;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe('wave 1 vehicles', () => {
  test('motorbikes and their riders render on every tier and survive tier switches without leaking', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const ids = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setClockRate(0);
      g.setTime(12);
      g.setWeather('clear', { instant: true });
      const n = g.sim.roads.node(4, 4);
      g.teleport(n.x + n.halfX + 2.2, n.z + n.halfZ + 9);
      // A still scene, so the memory counts compare like with like: no traffic or pedestrians streaming in and out.
      g.sim.ambient = false;
      for (const v of [...g.sim.vehicles]) if (!v.persistent) g.sim.removeVehicle(v);
      for (const c of [...g.sim.characters]) if (!c.isPlayer) g.sim.removeCharacter(c);
      const ridden = g.spawnVehicle('sportbike', true);
      const v = g.sim.player.vehicle;
      // A scooter alongside with an NPC rider, and a parked sport bike behind.
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      const scooter = g.sim.spawnVehicle('scooter', v.pos.x + Math.cos(v.heading) * 1.6 + fx * 2, v.pos.z - Math.sin(v.heading) * 1.6 + fz * 2, v.heading);
      g.sim.addDriver(scooter, 'civilian', 'traffic');
      scooter.ai = null;
      const parked = g.sim.spawnVehicle('sportbike', v.pos.x - fx * 3.2, v.pos.z - fz * 3.2, v.heading + 0.3);
      g.game.renderer.cameraCtl.orbitYaw = 2.4;
      return { ridden, scooter: scooter.id, parked: parked.id };
    });
    await page.waitForTimeout(800);
    const results: Array<Record<string, unknown>> = [];
    for (const [i, tier] of TIERS.entries()) {
      const r = await page.evaluate(
        async ([tier, ids]) => {
          const g = (window as Api).__gta7;
          const R = g.game.renderer;
          R.setQuality(tier);
          const c = R.cameraCtl;
          for (let k = 0; k < 30; k++) {
            c.orbitYaw = 2.4;
            c.lookIdle = 0;
            await new Promise((res) => requestAnimationFrame(res));
          }
          const views = (R as unknown as { vehicleViews: Map<number, { kind: string; group: { visible: boolean; children: unknown[] }; leanGroup?: unknown }> }).vehicleViews;
          const bikes = [ids.scooter, ids.parked, g.sim.player.vehicle?.id ?? -1].map((id) => {
            const view = views.get(id);
            return { id, kind: view?.kind ?? null, bikeView: !!view && 'leanGroup' in view, visible: view?.group.visible ?? false };
          });
          const st = g.state();
          return {
            tier: st.render.tier,
            software: st.render.software,
            geometries: R.renderer.info.memory.geometries as number,
            textures: R.renderer.info.memory.textures as number,
            colors: g.samplePixels().colors as number,
            crashed: st.crashed,
            bikes,
            riders: g.sim.characters.filter((ch: { vehicle: { spec: { class: string } } | null }) => ch.vehicle?.spec.class === 'bike').length,
          };
        },
        [tier, ids] as const,
      );
      results.push({ step: i, ...r });
      await shot(page, `w1-bikes-${i}-${tier}`);
    }
    console.log(`[w1-bikes] ${results.map((r) => `${r.step}:${r.tier}${r.software ? '(software)' : ''} geo ${r.geometries} tex ${r.textures} colors ${r.colors}`).join('; ')}`);
    for (const r of results) {
      expect(r.crashed).toBe(false);
      expect(r.colors as number).toBeGreaterThan(6);
      expect(r.riders as number).toBeGreaterThanOrEqual(2);
      for (const b of r.bikes as Array<{ bikeView: boolean; visible: boolean; kind: string }>) {
        expect(b.bikeView, JSON.stringify(b)).toBe(true);
        expect(b.visible).toBe(true);
      }
    }
    // Back on High after two rounds of switches: no more geometries or textures than the first time on High.
    const highs = results.filter((r) => r.tier === 'high');
    const first = highs[1]!;
    const last = highs[highs.length - 1]!;
    expect(last.geometries as number).toBeLessThanOrEqual((first.geometries as number) + 1);
    expect(last.textures as number).toBeLessThanOrEqual(first.textures as number);
    expect(errors).toEqual([]);
  });
});
