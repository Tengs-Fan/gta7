import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Each saved graphics tier boots and draws the graphics milestone's features within its limits: the finish pass,
// rain drops, headlight pools and the High-only wave grid, at noon clear, noon rain and 23:00 rain.

const LIMITS = {
  low: { aa: 'fxaa', rainDrops: 1500, pools: 12, waterGrid: false },
  medium: { aa: 'msaa', rainDrops: 3500, pools: 24, waterGrid: false },
  high: { aa: 'msaa', rainDrops: 6000, pools: 40, waterGrid: true },
} as const;

test.describe('graphics tiers', () => {
  for (const tier of ['low', 'medium', 'high'] as const) {
    test(`a page saved on ${tier} boots on ${tier} and renders clear and rain, day and night`, async ({ page }) => {
      await page.addInitScript((q) => {
        if (!localStorage.getItem('gta7.settings.v1')) localStorage.setItem('gta7.settings.v1', JSON.stringify({ quality: q }));
      }, tier);
      const errors = await boot(page);
      await newGame(page);
      const scenes = await page.evaluate(async () => {
        const g = (window as Api).__gta7;
        const frames = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        g.godMode(true);
        g.setClockRate(0);
        // Beside the crossing of two downtown avenues: at 23:00 the pools come from passing traffic's headlights (the
        // player's car lights the road with its own spot on High), and the bays and superblocks thinned the traffic
        // past the old corner at (4, 4).
        const n = g.sim.roads.node(5, 5);
        g.teleport(n.x + n.halfX + 2.2, n.z + n.halfZ + 9);
        g.spawnVehicle('sedan', true);
        const out = [];
        for (const [label, hours, kind] of [['noon-clear', 12, 'clear'], ['noon-rain', 12, 'rain'], ['night-rain', 23, 'rain']] as const) {
          g.setTime(hours);
          g.setWeather(kind, { instant: true });
          await frames();
          await new Promise((res) => setTimeout(res, 500));
          const r = g.state().render;
          out.push({ label, colors: g.samplePixels().colors, tier: r.tier, post: r.post, rainDrops: r.rainDrops, pools: r.pools, glows: r.glows, waterGrid: r.waterGrid, crashed: g.state().crashed });
        }
        return out;
      });
      const lim = LIMITS[tier];
      for (const s of scenes) {
        expect(s.tier, s.label).toBe(tier);
        expect(s.post, s.label).toMatchObject({ aa: lim.aa, grade: true });
        expect(s.rainDrops, s.label).toBe(s.label === 'noon-clear' ? 0 : lim.rainDrops);
        expect(s.pools, s.label).toBeLessThanOrEqual(lim.pools);
        expect(s.waterGrid, s.label).toBe(lim.waterGrid);
        expect(s.colors, s.label).toBeGreaterThan(6);
        expect(s.crashed, s.label).toBe(false);
      }
      const night = scenes.find((s) => s.label === 'night-rain')!;
      expect(night.glows).toBeGreaterThan(0);
      expect(night.pools).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    });
  }
});
