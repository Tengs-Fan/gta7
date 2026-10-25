import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Effects and weapons (mission 3): a car explosion draws a fireball, debris, a scorch and a smoke plume within the tier's
// caps without building a shader mid-game, on High, Medium and Low; guns are the modelled ones; and a burning wreck's
// fire, smoke, scorch and debris are back after a WebGL context loss.

/** Clears the street by the bank and puts a sedan on it, the player 30 m away and the camera looking at it. */
async function sedan(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(12);
    const sim = g.sim;
    sim.ambient = false;
    for (const v of [...sim.vehicles]) if (v !== sim.player.vehicle) sim.removeVehicle(v);
    const bp = g.poi('bank');
    const lane = sim.roads.nearestLane(bp.x, bp.z).lane;
    const s = Math.min(lane.length - 8, Math.max(8, (bp.x - lane.sx) * lane.dx + (bp.z - lane.sz) * lane.dz));
    const x = lane.sx + lane.dx * s;
    const z = lane.sz + lane.dz * s;
    g.place(x - lane.dx * 20, z - lane.dz * 20, Math.atan2(lane.dx, lane.dz));
    g.setCamera(Math.atan2(lane.dx, lane.dz), -0.1);
    const v = sim.spawnVehicle('sedan', x, z, lane.heading);
    v.persistent = true;
    (window as Api).__car = v;
  });
  await page.waitForTimeout(800);
}

const fxStats = (page: Page) => page.evaluate(() => (window as Api).__gta7.state().render.effects as Record<string, number>);

test.describe('effects and weapons', () => {
  test('a car explosion draws a fireball, debris, a scorch and a plume within caps on every tier, with no new programs', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    for (const q of ['high', 'medium', 'low'] as const) {
      await page.evaluate((q) => {
        const g = (window as Api).__gta7;
        g.game.applySettings({ ...g.game.settings, quality: q }, false);
      }, q);
      await sedan(page);
      const programs = await page.evaluate(() => (window as Api).__gta7.state().render.programs);
      const placed = (await fxStats(page)).scorchesPlaced!;
      await page.evaluate(() => (window as Api).__gta7.sim.combat.explodeVehicle((window as Api).__car));
      await page.waitForTimeout(250);
      const early = await fxStats(page);
      expect(early.fireballs, q).toBeGreaterThan(0);
      expect(early.fireballPuffs, q).toBeGreaterThanOrEqual(6);
      expect(early.debris, q).toBeGreaterThanOrEqual(8);
      // One more scorch (the last tier's stays: decals outlive a tier switch).
      expect(early.scorchesPlaced! - placed, q).toBe(1);
      await page.waitForTimeout(3000);
      const late = await fxStats(page);
      // The fireball is gone by 2 s; the wreck burns and smokes.
      expect(late.fireballs, q).toBe(0);
      expect(late.flamePuffs, q).toBeGreaterThan(0);
      expect(late.smokePuffs, q).toBeGreaterThan(10);
      for (const [k, cap] of [['puffs', 'puffCap'], ['debris', 'debrisCap'], ['sparks', 'sparkCap'], ['scorches', 'scorchCap'], ['peakFireballs', 'fireballCap']] as const) expect(late[k], `${q} ${k}`).toBeLessThanOrEqual(late[cap]!);
      expect(await page.evaluate(() => (window as Api).__gta7.state().render.programs), q).toBe(programs);
    }
    expect(errors).toEqual([]);
  });

  test('held guns are the modelled guns (hundreds of triangles, vertex-coloured), one draw per kind', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const guns = await page.evaluate(() => {
      const crowd = (window as Api).__gta7.game.renderer.crowd;
      const out: Record<string, { tris: number; colours: boolean }> = {};
      crowd.group.traverse((o: { name: string; geometry?: { getAttribute(n: string): { count: number } | undefined; index: unknown } }) => {
        if (!o.name.startsWith('gun-') || !o.geometry) return;
        out[o.name] = { tris: o.geometry.getAttribute('position')!.count / 3, colours: !!o.geometry.getAttribute('color') };
      });
      return out;
    });
    expect(Object.keys(guns).sort()).toEqual(['gun-pistol', 'gun-rifle', 'gun-rocket', 'gun-shotgun', 'gun-smg', 'gun-sniper']);
    for (const [name, g] of Object.entries(guns)) {
      expect(g.tris, name).toBeGreaterThan(250);
      expect(g.colours, name).toBe(true);
    }
    expect(errors).toEqual([]);
  });

  test("a burning wreck's fire, smoke, scorch and debris are back after a context loss", async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await sedan(page);
    await page.evaluate(() => (window as Api).__gta7.sim.combat.explodeVehicle((window as Api).__car));
    await page.waitForTimeout(2500);
    const before = await fxStats(page);
    await page.evaluate(() => {
      const ext = (window as Api).__gta7.game.renderer.renderer.getContext().getExtension('WEBGL_lose_context');
      (window as Api).__loseContext = ext;
      ext.loseContext();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => (window as Api).__loseContext.restoreContext());
    await page.getByRole('button', { name: 'RESUME', exact: true }).click();
    await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
    await page.waitForTimeout(800);
    const after = await fxStats(page);
    expect(before.flamePuffs).toBeGreaterThan(0);
    expect(after.flamePuffs).toBeGreaterThan(0);
    expect(after.smokePuffs).toBeGreaterThan(5);
    expect(after.scorches).toBe(1);
    expect(after.debris).toBeGreaterThanOrEqual(8);
    const colors = await page.evaluate(() => (window as Api).__gta7.samplePixels().colors);
    expect(colors).toBeGreaterThan(6);
    expect(errors.filter((e) => !/CONTEXT_LOST_WEBGL/.test(e))).toEqual([]);
  });
});
