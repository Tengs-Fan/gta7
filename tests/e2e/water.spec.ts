import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

const WATER_Y = -1;

test.describe('the sea', () => {
  test('the wave grid is on High only, the sea state follows the weather, and a rocket into the sea goes off at the surface', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const r = await page.evaluate(async () => {
      const g = (window as Api).__gta7;
      const tiers: Record<string, boolean> = {};
      for (const q of ['low', 'medium', 'high']) {
        g.game.applySettings({ ...g.game.settings, quality: q }, false);
        tiers[q] = g.state().render.waterGrid;
      }
      const calm = g.weather().seaState;
      g.setWeather('storm', { instant: true });
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const storm = g.weather().seaState;
      g.setWeather('clear', { instant: true });
      g.godMode(true);
      g.setTime(12);
      g.teleport(-509, -100);
      g.give('rocket', 4);
      g.setCamera(-Math.PI / 2, -0.5);
      const w = window as unknown as { __waterEvents: Array<{ kind: string; y: number }> };
      w.__waterEvents = [];
      g.sim.events.on('explosion', (e: { y: number }) => w.__waterEvents.push({ kind: 'explosion', y: e.y }));
      g.sim.events.on('splash', (e: { y: number; big: boolean }) => {
        if (e.big) w.__waterEvents.push({ kind: 'splash', y: e.y });
      });
      return { tiers, calm, storm };
    });
    expect(r.tiers).toEqual({ low: false, medium: false, high: true });
    expect(r.calm).toBeCloseTo(0.3, 5);
    expect(r.storm).toBeGreaterThan(0.95);
    await page.waitForTimeout(800);
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __waterEvents: unknown[] }).__waterEvents.length), { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    const events = await page.evaluate(() => (window as unknown as { __waterEvents: Array<{ kind: string; y: number }> }).__waterEvents);
    const boom = events.find((e) => e.kind === 'explosion')!;
    expect(Math.abs(boom.y - WATER_Y)).toBeLessThan(0.3);
    expect(events.some((e) => e.kind === 'splash' && e.y === WATER_Y)).toBe(true);
    expect(errors).toEqual([]);
  });
});
