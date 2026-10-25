import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Mission 3 buildings: the facades render on every tier, tier cycles do not grow memory or programs, the facade maps
// get their anisotropy per tier, and the facades come back after a lost WebGL context.

/** Frames the downtown avenue with a fixed camera and empties the streets, so memory counts compare like with like. */
async function avenue(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(13);
    g.place(-1, 153);
    g.sim.ambient = false;
    for (const v of [...g.sim.vehicles]) if (!v.persistent) g.sim.removeVehicle(v);
    for (const c of [...g.sim.characters]) if (!c.isPlayer) g.sim.removeCharacter(c);
    const ctl = g.game.renderer.cameraCtl;
    const orig = ctl.update.bind(ctl);
    ctl.update = (...a: unknown[]) => {
      orig(...a);
      ctl.camera.position.set(-1, 2.2, 150);
      ctl.camera.lookAt(-1, 9, 0);
      ctl.camera.updateMatrixWorld();
    };
  });
}

const frames = (n: number) => `for (let k = 0; k < ${n}; k++) await new Promise((r) => requestAnimationFrame(r));`;

test.describe('mission 3 buildings', () => {
  test('facades draw on every tier with their anisotropy, and two tier cycles grow neither memory nor programs', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await avenue(page);
    await page.waitForTimeout(500);
    const tiers = ['high', 'medium', 'low', 'high', 'medium', 'low', 'high'] as const;
    const rows: Array<Record<string, number | string | boolean>> = [];
    for (const tier of tiers) {
      const r = await page.evaluate(
        new Function('tier', `return (async () => {
          const g = window.__gta7;
          const R = g.game.renderer;
          R.setQuality(tier);
          ${frames(30)}
          const m = R.city.materials.facades.get('office');
          const st = g.state();
          return {
            tier: st.render.tier,
            geometries: R.renderer.info.memory.geometries,
            textures: R.renderer.info.memory.textures,
            programs: st.render.programs,
            calls: st.render.calls,
            aniso: m.map.anisotropy,
            max: R.renderer.capabilities.getMaxAnisotropy(),
            parallax: R.city.buildingU.parallax.value,
            pbr: !!m.map.userData.assetId,
            colors: g.samplePixels().colors,
          };
        })()`) as (t: string) => Promise<Record<string, number | string | boolean>>,
        tier,
      );
      rows.push(r);
    }
    console.log(`[m3-buildings tiers] ${rows.map((r) => `${r.tier} geo ${r.geometries} tex ${r.textures} prog ${r.programs} calls ${r.calls} aniso ${r.aniso} parallax ${r.parallax}`).join('; ')}`);
    for (const r of rows) {
      expect(r.pbr).toBe(true);
      expect(r.colors as number).toBeGreaterThan(6);
      expect(r.calls as number).toBeGreaterThan(50);
      if (r.tier === 'high') expect(r.aniso).toBe(Math.min(8, r.max as number));
      if (r.tier === 'medium') expect(r.aniso as number).toBeGreaterThanOrEqual(Math.min(4, r.max as number));
      expect(r.parallax).toBe(r.tier === 'low' ? 0 : 1);
    }
    const highs = rows.filter((r) => r.tier === 'high');
    const warm = rows[3]!;
    const last = rows[rows.length - 1]!;
    expect(last.geometries as number).toBeLessThanOrEqual((highs[0]!.geometries as number) * 1.03);
    expect(last.textures as number).toBeLessThanOrEqual((highs[0]!.textures as number) * 1.03);
    expect(last.programs as number).toBeLessThanOrEqual(warm.programs as number);
    expect(errors).toEqual([]);
  });

  test('the facades redraw with their textures after a lost and restored WebGL context', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await avenue(page);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const ext = (window as Api).__gta7.game.renderer.renderer.getContext().getExtension('WEBGL_lose_context');
      (window as Api).__lose = ext;
      ext.loseContext();
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as Api).__lose.restoreContext());
    await page.waitForFunction(() => !(window as Api).__gta7.game.contextLost);
    const r = await page.evaluate(
      new Function(`return (async () => {
        const g = window.__gta7;
        const R = g.game.renderer;
        ${frames(20)}
        R.render(0, false);
        const m = R.city.materials.facades.get('office');
        return { calls: g.state().render.calls, px: g.samplePixels(), image: !!m.map.image, glass: !!m.userData.facade.glass.image };
      })()`) as () => Promise<{ calls: number; px: { colors: number; std: number }; image: boolean; glass: boolean }>,
    );
    expect(r.image && r.glass).toBe(true);
    expect(r.calls).toBeGreaterThan(50);
    expect(r.px.colors).toBeGreaterThan(6);
    expect(r.px.std).toBeGreaterThan(4);
    expect(errors).toEqual([]);
  });

  test('at 22:30 the storefront lights hold steady over ten frames', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await avenue(page);
    const r = await page.evaluate(
      new Function(`return (async () => {
        const g = window.__gta7;
        const R = g.game.renderer;
        g.setTime(22.5);
        const out = [];
        for (let k = 0; k < 10; k++) {
          ${frames(1)}
          out.push([R.city.nightU.shopOccupancy.value, R.city.materials.storefront.emissiveIntensity, g.state().render.programs]);
        }
        return out;
      })()`) as () => Promise<number[][]>,
    );
    for (const row of r) expect(row).toEqual(r[0]);
    expect(r[0]![0]).toBeGreaterThanOrEqual(0.4);
    expect(r[0]![0]).toBeLessThanOrEqual(0.95);
    expect(errors).toEqual([]);
  });
});
