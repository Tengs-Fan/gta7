import { expect, test } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

// Weather: the settings (Dynamic / Always clear, lightning flashes) persist, the debug hooks set and release weather,
// and the atmosphere follows it. These specs use the Weather setting instead of the helpers' forced clear weather.

const weather = (page: import('@playwright/test').Page) => page.evaluate(() => (window as Api).__gta7.weather());

test.describe('weather', () => {
  test('the Weather and Lightning flashes settings default to Dynamic / on and persist across a reload', async ({ page }) => {
    const errors = await boot(page, '/?intro=0', { weather: null });
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    const select = page.locator('.setting select[aria-label="Weather"]');
    const flashes = page.locator('.setting input[aria-label="Lightning flashes"]');
    await expect(select).toHaveValue('dynamic');
    await expect(select.locator('option')).toHaveText(['Dynamic', 'Always clear']);
    await expect(flashes).toBeChecked();
    await select.selectOption('clear');
    await flashes.uncheck();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gta7.settings.v1') ?? '{}'));
    expect(stored).toMatchObject({ weather: 'clear', lightningFlashes: false });
    await page.reload();
    await page.waitForFunction(() => (window as Api).__gta7?.state().frames > 20, null, { timeout: 90_000 });
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await expect(select).toHaveValue('clear');
    await expect(flashes).not.toBeChecked();
    expect(await page.evaluate(() => (window as Api).__gta7.game.renderer.lightningFlashes)).toBe(false);
    // A game started now holds clear skies whatever the forecast says.
    await page.getByRole('button', { name: 'BACK', exact: true }).click();
    await newGame(page);
    expect((await weather(page)).mode).toBe('clear');
    expect(errors).toEqual([]);
  });

  test('setWeather and clearWeather set, ramp and release the weather, and the atmosphere follows it', async ({ page }) => {
    const errors = await boot(page, '/?intro=0', { weather: null });
    await newGame(page);
    await page.evaluate(() => (window as Api).__gta7.setTime(12));
    // Day 1 is always clear.
    let w = await weather(page);
    expect(w).toMatchObject({ kind: 'clear', rain: 0, mode: 'dynamic', overridden: null });
    // A forced kind applies at the next simulation step: wait a few frames first.
    const look = () =>
      page.waitForTimeout(150).then(() => page.evaluate(() => {
        const g = (window as Api).__gta7;
        const px = g.samplePixels();
        const r = g.game.renderer;
        return { fogFar: r.scene.fog.far, sun: r.env.sun.intensity, exposure: r.renderer.toneMappingExposure, mean: px.mean };
      }));
    const clear = await look();
    await page.evaluate(() => (window as Api).__gta7.setWeather('overcast', { instant: true }));
    const overcast = await look();
    expect(overcast.exposure).not.toBe(clear.exposure);
    w = await page.evaluate(() => (window as Api).__gta7.setWeather('rain', { instant: true }));
    await page.waitForTimeout(100);
    w = await weather(page);
    expect(w).toMatchObject({ kind: 'rain', overridden: 'rain' });
    expect(w.rain).toBeGreaterThanOrEqual(0.9);
    expect(w.dim).toBeGreaterThanOrEqual(0.5);
    const rain = await look();
    expect(rain.fogFar).toBeLessThanOrEqual(clear.fogFar * 0.6);
    await page.evaluate(() => (window as Api).__gta7.setWeather('storm', { instant: true }));
    const storm = await look();
    expect(storm.sun).toBeLessThan(clear.sun);
    expect(storm.mean).toBeGreaterThanOrEqual(clear.mean * 0.35);
    await page.evaluate(() => (window as Api).__gta7.setWeather({ seaState: 1 }));
    await page.waitForTimeout(100);
    expect((await weather(page)).seaState).toBe(1);
    w = await page.evaluate(() => (window as Api).__gta7.clearWeather({ instant: true }));
    await page.waitForTimeout(100);
    w = await weather(page);
    expect(w).toMatchObject({ kind: 'clear', rain: 0, overridden: null });
    expect(w.seaState).toBeCloseTo(0.3, 5);
    expect((await state(page)).crashed).toBe(false);
    expect(errors).toEqual([]);
  });
});
