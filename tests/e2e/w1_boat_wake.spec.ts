import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// VAL-BOAT-008: a boat under way out of the Marina leaves a wake and spray on the tiers that draw spray (High and
// Medium), none when it is stopped, and none on Low; switching tiers keeps it drawn without growing geometry or texture counts.

const TIERS = ['high', 'medium', 'low', 'high', 'medium', 'low', 'high'] as const;

test.describe('wave 1 boat wake', () => {
  test('a moving boat shows a wake on High and Medium only, and tier cycles do not grow memory', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const id = await page.evaluate(async () => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setClockRate(0);
      g.setTime(15);
      g.setWeather('clear', { instant: true });
      g.teleport(644, 466);
      await new Promise((res) => setTimeout(res, 1500));
      const boat = g.sim.vehicles.find((v: { kind: string }) => v.kind === 'speedboat');
      g.sim.seat(g.sim.player, boat, 0);
      // A still scene from here on, so the memory counts compare like with like.
      g.sim.ambient = false;
      return boat.id as number;
    });
    const results: Array<{ tier: string; software: boolean; moving: number; sprites: number; particles: number; still: number; geometries: number; textures: number; drawn: boolean; crashed: boolean }> = [];
    for (const tier of TIERS) {
      const r = await page.evaluate(
        async ([tier, id]) => {
          const g = (window as Api).__gta7;
          const R = g.game.renderer;
          R.setQuality(tier);
          const boat = g.sim.vehicles.find((v: { id: number }) => v.id === id)!;
          const views = (R as unknown as { vehicleViews: Map<number, { group: { visible: boolean } }> }).vehicleViews;
          const frames = async (speed: number, n: number): Promise<{ boats: number; sprites: number; particles: number }> => {
            let boats = 0;
            let sprites = 0;
            let particles = 0;
            for (let k = 0; k < n; k++) {
              boat.vel.x = Math.sin(boat.heading) * speed;
              boat.vel.z = Math.cos(boat.heading) * speed;
              R.cameraCtl.orbitYaw = 2.6;
              R.cameraCtl.orbitPitch = 0.25;
              R.cameraCtl.lookIdle = 0;
              await new Promise((res) => requestAnimationFrame(res));
              const st = g.state().render;
              boats = Math.max(boats, st.wakeBoats);
              sprites += st.wakeSprites;
              particles = Math.max(particles, st.particles);
            }
            return { boats, sprites, particles };
          };
          const moving = await frames(14, 60);
          // Let the foam of the run die away before looking at a stopped boat.
          await frames(0, 240);
          const still = await frames(0, 30);
          return {
            tier: g.state().render.tier,
            software: g.state().render.software,
            moving: moving.boats,
            sprites: moving.sprites,
            particles: moving.particles,
            still: still.boats,
            geometries: R.renderer.info.memory.geometries as number,
            textures: R.renderer.info.memory.textures as number,
            drawn: views.get(id)?.group.visible ?? false,
            crashed: g.state().crashed as boolean,
          };
        },
        [tier, id] as const,
      );
      results.push(r);
    }
    console.log(`[w1-boat-wake] ${results.map((r) => `${r.tier}${r.software ? '(software)' : ''} wakeBoats ${r.moving} sprites ${r.sprites} particles ${r.particles} still ${r.still} geo ${r.geometries} tex ${r.textures}`).join('; ')}`);
    for (const r of results) {
      expect(r.crashed).toBe(false);
      expect(r.drawn).toBe(true);
      expect(r.still).toBe(0);
      if (r.tier === 'low' || r.software) {
        expect(r.moving).toBe(0);
        expect(r.sprites).toBe(0);
      } else {
        expect(r.moving).toBeGreaterThan(0);
        expect(r.sprites).toBeGreaterThan(0);
        expect(r.particles).toBeGreaterThan(0);
      }
    }
    const highs = results.filter((r) => r.tier === 'high');
    expect(highs[highs.length - 1]!.geometries).toBeLessThanOrEqual(highs[1]!.geometries + 1);
    expect(highs[highs.length - 1]!.textures).toBeLessThanOrEqual(highs[1]!.textures);
    expect(errors).toEqual([]);
  });
});
