import { expect, test, type Page } from '@playwright/test';

import { boot, newGame, type Api } from './helpers';

// Mission 3 cars on the real WebGL renderer: every car kind draws its tinted glass, lamp lenses and the shade under it,
// its first spawn after the warm-up builds no shader program, and the cars come through tier switches and a lost and
// restored WebGL context with their glass and parts, bounded memory and one batched part instance per car in view.

const KINDS = ['compact', 'sedan', 'taxi', 'sports', 'muscle', 'pickup', 'van', 'bus', 'police', 'swat', 'ambulance', 'firetruck'];

/** A quiet noon street: no traffic or pedestrians, the clock stopped, every other vehicle gone. */
async function quietStreet(page: Page, hour = 12): Promise<void> {
  await page.evaluate((hour) => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(hour);
    g.sim.traffic.density = 0;
    g.sim.peds.density = 0;
    for (const v of [...g.sim.vehicles]) if (v.driver !== g.sim.player) g.sim.removeVehicle(v);
  }, hour);
}

/**
 * Parks `kinds` pointing away from the camera in two rows of six, 14 and 26 m ahead (well inside the view, and clear
 * of each other whatever their length), the first at slot `first`; kept: owned by a mission. Returns their ids.
 */
async function parkRow(page: Page, kinds: string[], first = 0): Promise<number[]> {
  return page.evaluate(([kinds, first]) => {
    const g = (window as Api).__gta7;
    const cam = g.game.renderer.cameraCtl.camera;
    const dir = cam.getWorldDirection(cam.position.clone());
    const fx = dir.x / Math.hypot(dir.x, dir.z);
    const fz = dir.z / Math.hypot(dir.x, dir.z);
    const p = g.sim.player.pos;
    const w = window as Api;
    w.__row ??= [];
    return (kinds as string[]).map((kind: string, k: number) => {
      const i = (first as number) + k;
      const across = ((i % 6) - 2.5) * 3.4;
      const d = 14 + Math.floor(i / 6) * 12;
      const v = g.sim.spawnVehicle(kind, p.x + fx * d - fz * across, p.z + fz * d + fx * across, Math.atan2(fx, fz));
      v.owner = 'mission';
      v.persistent = true;
      w.__row.push(v);
      return v.id;
    });
  }, [kinds, first] as const);
}

async function clearRow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    for (const v of (window as Api).__row ?? []) g.sim.removeVehicle(v);
    (window as Api).__row = [];
  });
}

/** Per drawn frame: cars whose parts are drawn (in the camera's view), and the under-car shades and lenses drawn. */
async function partCensus(page: Page): Promise<{ inView: number; shades: number; lenses: number; otherLenses: number; geometries: number; textures: number }> {
  return page.evaluate(() => {
    const r = (window as Api).__gta7.game.renderer;
    const sphere = r.partSphere.clone();
    let inView = 0;
    // Bikes and boats put their lamp lenses in the same batch (a bike its head and tail lamps, a boat its bow and stern).
    let otherLenses = 0;
    for (const view of r.vehicleViews.values()) {
      const v = view.vehicle;
      if (!v || !view.group.visible) continue;
      sphere.center.set(v.pos.x, v.pos.y + v.spec.height / 2, v.pos.z);
      sphere.radius = Math.hypot(v.spec.length, v.spec.width, v.spec.height) / 2 + 0.5;
      if (!r.frustum.intersectsSphere(sphere)) continue;
      if (v.spec.class === 'car') inView++;
      else otherLenses += v.spec.class === 'bike' ? view.lenses.length : 2;
    }
    let shades = 0;
    let lenses = 0;
    for (const m of r.vehicleParts.group.children) {
      const part = r.vehicleParts.partOf(m);
      if (!part || !m.visible) continue;
      if (part.material.name === 'vehicle-under-shade') shades += m.count;
      if (part.geometry.type === 'ExtrudeGeometry') lenses += m.count;
    }
    const mem = r.renderer.info.memory;
    return { inView, shades, lenses, otherLenses, geometries: mem.geometries, textures: mem.textures };
  });
}

test.describe('GTA 7 mission 3 cars', () => {
  test('every car kind draws tinted glass, lamp lenses and the shade under it, and its first spawn builds no shader program', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await quietStreet(page);
    expect((await page.evaluate(() => (window as Api).__gta7.state().render.tier))).toBe('high');
    // The first seconds of play compile a few programs of their own (the sky, the sea in view): let them settle.
    await page.waitForTimeout(6000);
    const programs = await page.evaluate(() => (window as Api).__gta7.state().render.programs);
    const keys0 = await page.evaluate(() => (window as Api).__gta7.game.renderer.renderer.info.programs.map((p: Api) => `${p.name}|${p.cacheKey}`));
    // Each kind joins the row in turn and stays (a car removed in view fades out, which is not a first spawn).
    for (const [i, kind] of KINDS.entries()) {
      const [id] = await parkRow(page, [kind], i);
      await page.waitForTimeout(500);
      const v = await page.evaluate((id) => {
        const g = (window as Api).__gta7;
        const view = g.game.renderer.vehicleViews.get(id);
        const glass = view.group.getObjectByName('glass');
        return { programs: g.state().render.programs, near: !view.isDistant, glass: glass?.material?.name, glassVisible: glass?.visible, opacity: glass?.material?.opacity, lamps: view.lamps.length };
      }, id);
      const added = await page.evaluate((k0) => (window as Api).__gta7.game.renderer.renderer.info.programs.map((p: Api) => `${p.name}|${p.cacheKey}`).filter((k: string) => !k0.includes(k)).map((k: string) => k.slice(0, 40) + " ... " + k.slice(-140)), keys0);
      expect(v.programs, `${kind}: no new program (${added.join(' / ')})`).toBe(programs);
      expect(v.near, kind).toBe(true);
      expect(v.glass, kind).toBe('vehicle-glass');
      expect(v.glassVisible, kind).toBe(true);
      expect(v.opacity, kind).toBeGreaterThanOrEqual(0.7);
      expect(v.lamps, kind).toBe(5);
    }
    await page.waitForTimeout(800);
    const c = await partCensus(page);
    expect(c.inView).toBeGreaterThanOrEqual(6);
    expect(c.shades).toBe(c.inView);
    expect(c.lenses).toBe(5 * c.inView + c.otherLenses);
    expect(errors).toEqual([]);
  });

  test('cars come through tier switches and a lost and restored WebGL context with their glass, parts and memory', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await quietStreet(page);
    await page.waitForTimeout(3000);
    const cycles: Array<{ geometries: number; textures: number; inView: number; shades: number }> = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      await parkRow(page, KINDS);
      for (const tier of ['high', 'medium', 'low', 'high']) {
        await page.evaluate((tier) => {
          const g = (window as Api).__gta7;
          g.game.applySettings({ ...g.game.settings, quality: tier }, false);
        }, tier);
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(800);
      const c = await partCensus(page);
      cycles.push(c);
      // One shade (and five lenses) per car whose parts are drawn, whatever the tier history.
      expect(c.shades, `cycle ${cycle}`).toBe(c.inView);
      expect(c.lenses, `cycle ${cycle}`).toBe(5 * c.inView + c.otherLenses);
      await clearRow(page);
      await page.waitForTimeout(800);
    }
    // The first cycle warms up; the later ones hold vehicle geometries and textures within 3 % of it.
    for (const c of cycles.slice(1)) {
      expect(c.geometries).toBeLessThanOrEqual(cycles[0]!.geometries * 1.03);
      expect(c.textures).toBeLessThanOrEqual(cycles[0]!.textures * 1.03);
    }
    // A lost and restored context: every car is drawn again with its glass, and the frame is not blank.
    await parkRow(page, KINDS);
    await page.waitForTimeout(800);
    const before = await partCensus(page);
    await page.evaluate(() => {
      const gl = (window as Api).__gta7.game.renderer.renderer.getContext();
      (window as Api).__lose = gl.getExtension('WEBGL_lose_context');
      (window as Api).__lose.loseContext();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => (window as Api).__lose.restoreContext());
    await page.waitForFunction(() => (window as Api).__gta7.state().render.calls > 0, null, { timeout: 20_000 });
    await page.waitForTimeout(2500);
    const after = await partCensus(page);
    expect(after.inView).toBe(before.inView);
    expect(after.shades).toBe(after.inView);
    const drawn = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const views = [...g.game.renderer.vehicleViews.values()].filter((v: Api) => v.vehicle && (window as Api).__row.includes(v.vehicle));
      return { glass: views.every((v: Api) => v.group.getObjectByName('glass')?.material?.name === 'vehicle-glass'), colors: g.samplePixels().colors, lost: g.game.renderer.renderer.getContext().isContextLost() };
    });
    expect(drawn.lost).toBe(false);
    expect(drawn.glass).toBe(true);
    expect(drawn.colors).toBeGreaterThan(6);
    expect(errors).toEqual([]);
  });

  test('a parked car\'s lenses are unlit at noon and glow after dark, with no glow sprite or light of their own', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await quietStreet(page, 12);
    const [id] = await parkRow(page, ['sedan']);
    const lamps = async (hour: number) => {
      await page.evaluate((h) => (window as Api).__gta7.setTime(h), hour);
      await page.waitForTimeout(600);
      return page.evaluate((id) => {
        const view = (window as Api).__gta7.game.renderer.vehicleViews.get(id);
        return { emissive: view.lamps.map((l: Api) => l.mat.emissiveIntensity), lit: view.lightsOn };
      }, id);
    };
    const noon = await lamps(12);
    expect(noon.emissive.every((e: number) => e === 0)).toBe(true);
    const night = await lamps(23);
    expect(night.lit).toBe(false);
    // Head and tail lenses glow (the reverse lamp stays dark).
    expect(night.emissive.filter((e: number) => e > 0.1).length).toBe(4);
    expect(errors).toEqual([]);
  });
});
