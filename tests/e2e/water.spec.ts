import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

const WATER_Y = -1;

test.describe('the sea', () => {
  test('the wave grid is on High and Medium, the sea state follows the weather, and a rocket into the sea goes off at the surface', async ({ page }) => {
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
    expect(r.tiers).toEqual({ low: false, medium: true, high: true });
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

  test('Medium\'s open-water skips leave the frame as it was: the same pixels with them off, at the beach, a pier, the quays, a storm and in open water', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setClockRate(0);
      g.game.applySettings({ ...g.game.settings, quality: 'medium' }, false);
    });
    const views = [
      { name: 'surf', x: 524, z: -150, yaw: Math.PI / 2 + 0.25, pitch: -0.1, hours: 13, weather: 'clear' },
      { name: 'pier', x: 676, z: 44, yaw: -Math.PI / 2 - 0.45, pitch: -0.1, hours: 13, weather: 'clear' },
      { name: 'marina', x: 605, z: 446, yaw: 0.5, pitch: -0.12, hours: 13, weather: 'clear' },
      { name: 'storm surf', x: 524, z: -150, yaw: Math.PI / 2 + 0.25, pitch: -0.1, hours: 14, weather: 'storm' },
      { name: 'open water', x: 280, z: -740, yaw: Math.PI / 2, pitch: -0.1, hours: 15.5, weather: 'clear' },
    ];
    for (const v of views) {
      await page.evaluate((v) => {
        const g = (window as Api).__gta7;
        g.setTime(v.hours);
        g.setWeather(v.weather, { instant: true });
        g.teleport(v.x, v.z);
        g.setCamera(v.yaw, v.pitch);
      }, v);
      await page.waitForTimeout(1500);
      // The same frame (no time passing) drawn with the skips on, off and on again, read back from the drawing buffer; and a
      // frame 0.4 s later, to show the comparison can tell frames apart.
      const r = await page.evaluate(() => {
        const R = (window as Api).__gta7.game.renderer;
        const sea = R.env.sea;
        const gl = R.renderer.getContext() as WebGL2RenderingContext;
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const grab = (skip: number, dt = 0): Uint8Array => {
          sea.uSeaSkip.value = skip;
          R.render(dt, false);
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return px;
        };
        const differing = (a: Uint8Array, b: Uint8Array): number => {
          let n = 0;
          for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
          return n;
        };
        const on = grab(1);
        const off = grab(0);
        const again = grab(1);
        const later = grab(1, 0.4);
        sea.uSeaSkip.value = 1;
        return { skip: sea.uSeaSkip.value, offVsOn: differing(on, off), onVsOn: differing(on, again), later: differing(on, later) };
      });
      expect(r.offVsOn, v.name).toBe(0);
      expect(r.onVsOn, v.name).toBe(0);
      expect(r.later, v.name).toBeGreaterThan(1000);
    }
    expect(errors).toEqual([]);
  });
});
