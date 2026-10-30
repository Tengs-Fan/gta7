import { expect, test } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

// Hollister Farm and Eternal Palms Cemetery (src/world/attractions.ts), played with real keys.
test.describe('the attractions', () => {
  test('a car driven into the corn maze lays the corn flat, and the HUD names the farm', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const start = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setTime(11);
      const farm = g.sim.world.layout.attractions.find((a: { kind: string }) => a.kind === 'farm');
      const m = farm.anchors.mazes[0];
      const x = m.rect.minX - 6;
      const z = m.rect.minZ + 4.5 * m.cell + 1;
      g.teleport(x, z);
      g.spawnVehicle('muscle', true);
      g.place(x, z, Math.PI / 2);
      g.setCamera(Math.PI / 2, -0.1);
      const w = window as unknown as { __corn: number };
      w.__corn = 0;
      g.sim.events.on('propBroken', (e: { index: number }) => {
        if (g.sim.world.layout.props[e.index].kind === 'corn') w.__corn++;
      });
      return { x, end: m.rect.maxX };
    });
    await page.keyboard.down('w');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __corn: number }).__corn), { timeout: 8000 }).toBeGreaterThanOrEqual(3);
    await page.keyboard.up('w');
    const s = await state(page);
    expect(s.player.vehicle).toBe('muscle');
    expect(s.player.x).toBeGreaterThan(start.x + 8);
    await expect(page.locator('body')).toContainText('Hollister Farm');
    expect(errors).toEqual([]);
  });

  test('on foot in the cemetery, E at an epitaph stone reads it out and counts it', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const at = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.setTime(16);
      const c = g.sim.world.layout.attractions.find((a: { kind: string }) => a.kind === 'cemetery');
      const e = c.anchors.epitaphs[0];
      // A few steps north of the stone's marker (the stone stands south of it): the player walks south up to it.
      g.teleport(e.x, e.z - 3.5);
      g.setCamera(0, -0.2);
      return e;
    });
    expect(at).toBeTruthy();
    await page.keyboard.down('w');
    await expect.poll(() => page.evaluate(() => (window as Api).__gta7.sim.interactions.prompt()), { timeout: 6000 }).toBe('Press E to read');
    await page.keyboard.up('w');
    await page.keyboard.press('e');
    await expect(page.locator('body')).toContainText('EPITAPHS 1/12');
    await expect(page.locator('body')).toContainText('HERE LIES GARY');
    const read = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      return g.sim.interactions.markers.filter((m: { kind: string; id: string }) => m.kind === 'epitaph' && m.id.endsWith(':read')).length;
    });
    expect(read).toBe(1);
    expect(errors).toEqual([]);
  });
});
