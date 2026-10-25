import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Lighting and sky (mission 3): the sky HDRI is the image-based light on every hardware tier; the night's lamp haze,
// tinted wet-road streaks, city glow and black-level lift follow the clock and the weather; and all of it is back
// after a WebGL context loss.

/** Night and noon on the avenue at (-30, -3.5), lamps and signals in view. */
async function look(page: import('@playwright/test').Page, hours: number, weather: 'clear' | 'rain') {
  return page.evaluate(
    async ([h, w]) => {
      const g = (window as Api).__gta7;
      g.setTime(h);
      g.setWeather(w, { instant: true });
      if (w === 'clear') g.sim.weather.state.wet = 0;
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      await new Promise((res) => setTimeout(res, 500));
      const r = g.game.renderer;
      const s = g.state().render;
      const u = r.env.sky.material.uniforms.uCityGlow.value;
      return {
        tier: s.tier,
        source: g.envStats().source,
        bakes: g.envStats().bakes,
        haze: s.lampHaze,
        streaks: s.streaks,
        glow: 0.2126 * u.r + 0.7152 * u.g + 0.0722 * u.b,
        lift: r.finish ? r.finish.material.uniforms.uLift.value : null,
        grade: s.post.grade,
        colors: g.samplePixels().colors,
      };
    },
    [hours, weather] as const,
  );
}

test.describe('lighting and sky', () => {
  test('the sky HDRI lights every hardware tier, and the night features follow the clock and the weather', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setClockRate(0);
      g.place(-30, -3.5, Math.PI / 2);
      g.setCamera(1.57, -0.05);
    });
    for (const q of ['high', 'medium', 'low'] as const) {
      await page.evaluate((q) => {
        const g = (window as Api).__gta7;
        g.game.applySettings({ ...g.game.settings, quality: q }, false);
      }, q);
      const noon = await look(page, 12, 'clear');
      const night = await look(page, 23, 'rain');
      for (const s of [noon, night]) {
        expect(s.tier, q).toBe(q);
        expect(s.source, q).toBe('hdri');
        expect(s.grade, q).toBe(true);
        expect(s.colors, q).toBeGreaterThan(6);
      }
      expect(noon.haze, `${q} noon haze`).toBe(0);
      expect(noon.glow, `${q} noon city glow`).toBe(0);
      expect(noon.lift, `${q} noon black level`).toBe(0);
      expect(noon.streaks, `${q} noon streaks`).toBe(0);
      expect(night.haze, `${q} rain-night haze`).toBeGreaterThan(1.3);
      expect(night.glow, `${q} night city glow`).toBeGreaterThan(0.02);
      expect(night.lift, `${q} night black level`).toBeGreaterThan(0.01);
      expect(night.streaks, `${q} rain-night streaks`).toBeGreaterThan(0);
    }
    expect(errors).toEqual([]);
  });

  test('after a context loss the HDRI, haze, streaks, city glow and grade come back', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setClockRate(0);
      g.place(-30, -3.5, Math.PI / 2);
      g.setCamera(1.57, -0.05);
    });
    const before = await look(page, 23, 'rain');
    await page.evaluate(() => {
      const ext = (window as Api).__gta7.game.renderer.renderer.getContext().getExtension('WEBGL_lose_context');
      (window as Api).__loseContext = ext;
      ext.loseContext();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => (window as Api).__loseContext.restoreContext());
    await page.getByRole('button', { name: 'RESUME', exact: true }).click();
    await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
    const after = await look(page, 23, 'rain');
    expect(after.source).toBe('hdri');
    expect(after.bakes).toBeGreaterThan(before.bakes);
    expect(after.haze).toBeGreaterThan(1.3);
    expect(after.streaks).toBeGreaterThan(0);
    expect(after.glow).toBeGreaterThan(0.02);
    expect(after.lift).toBeGreaterThan(0.01);
    expect(after.grade).toBe(true);
    expect(after.colors).toBeGreaterThan(6);
    expect(errors.filter((e) => !/CONTEXT_LOST_WEBGL/.test(e))).toEqual([]);
  });
});
