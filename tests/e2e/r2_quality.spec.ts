import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

// Graphics quality tiers (Auto, Low, Medium, High) and recovery from a lost WebGL context.
// This machine's discrete GPU makes Auto mean High, so Low and Medium are also booted directly.

/** Automated runs refuse pointer lock (headless Chromium can stall rAF once it grants it). */
async function noPointerLock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = function () {
      throw new DOMException('pointer lock disabled under automation', 'NotSupportedError');
    };
  });
}

/** Visible dynamic lights in the scene, and a few renderer facts. */
const rendererFacts = (page: Page) =>
  page.evaluate(() => {
    const r = (window as Api).__gta7.game.renderer;
    let point = 0;
    let spot = 0;
    r.scene.traverseVisible((o: { isPointLight?: boolean; isSpotLight?: boolean }) => {
      if (o.isPointLight) point++;
      if (o.isSpotLight) spot++;
    });
    const gl = r.renderer.getContext();
    return { tier: r.currentQuality, msaa: r.msaa, antialias: gl.getContextAttributes().antialias, pixelRatio: r.pixelRatio, shadows: r.renderer.shadowMap.enabled, point, spot, canvasW: gl.drawingBufferWidth };
  });

test.describe('graphics quality', () => {
  test('switches Auto -> Low -> High in settings with zero console errors', async ({ page }) => {
    await noPointerLock(page);
    const errors = await boot(page);
    expect((await state(page)).render.tier).toBe('high');
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    const select = page.locator('.setting select');
    const note = page.locator('.setting-note');
    await expect(select).toHaveValue('auto');
    await expect(select.locator('option').first()).toHaveText('AUTO (HIGH)');
    await expect(note).toBeHidden();
    await select.selectOption('low');
    expect((await state(page)).render.tier).toBe('low');
    // MSAA was fixed when the renderer was made; everything else applied at once.
    await expect(note).toHaveText('Anti-aliasing turns off after a reload.');
    let r = await rendererFacts(page);
    expect(r).toMatchObject({ tier: 'low', msaa: true, antialias: true, shadows: false, point: 0, spot: 0 });
    expect(r.pixelRatio).toBeCloseTo(0.67, 5);
    await select.selectOption('high');
    expect((await state(page)).render.tier).toBe('high');
    await expect(note).toBeHidden();
    r = await rendererFacts(page);
    expect(r).toMatchObject({ tier: 'high', shadows: true, point: 3, spot: 1 });
    await page.getByRole('button', { name: 'BACK', exact: true }).click();

    // The same in a running game, where the tier also sets traffic and pedestrian density.
    await newGame(page);
    await page.evaluate(() => (window as Api).__gta7.game.pause());
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await select.selectOption('low');
    const low = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      return { tier: g.state().render.tier, traffic: g.sim.traffic.density, peds: g.sim.peds.density, px: g.samplePixels() };
    });
    expect(low).toMatchObject({ tier: 'low', traffic: 0.75, peds: 0.75 });
    expect(low.px.colors).toBeGreaterThan(6);
    await select.selectOption('auto');
    const auto = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      return { tier: g.state().render.tier, traffic: g.sim.traffic.density, setting: g.game.settings.quality, px: g.samplePixels() };
    });
    expect(auto).toMatchObject({ tier: 'high', traffic: 1, setting: 'auto' });
    expect(auto.px.colors).toBeGreaterThan(6);
    await page.getByRole('button', { name: 'BACK', exact: true }).click();
    await page.getByRole('button', { name: 'RESUME', exact: true }).click();
    await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
    const f0 = (await state(page)).frames;
    await page.waitForTimeout(500);
    expect((await state(page)).frames).toBeGreaterThan(f0);
    // The choice is saved.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gta7.settings.v1') ?? '{}').quality)).toBe('auto');
    expect(errors).toEqual([]);
  });

  for (const tier of ['low', 'medium'] as const) {
    test(`boots straight into a saved ${tier} tier and renders day and night`, async ({ page }) => {
      await noPointerLock(page);
      await page.addInitScript((quality) => localStorage.setItem('gta7.settings.v1', JSON.stringify({ quality })), tier);
      const errors = await boot(page);
      const r = await rendererFacts(page);
      expect(r.tier).toBe(tier);
      // Low is created without MSAA; Medium keeps it.
      expect(r.msaa).toBe(tier !== 'low');
      expect(r.antialias).toBe(tier !== 'low');
      expect(r.shadows).toBe(tier !== 'low');
      expect(r.point).toBe(tier === 'low' ? 0 : 2);
      expect(r.spot).toBe(tier === 'low' ? 0 : 1);
      expect(r.pixelRatio).toBeCloseTo(tier === 'low' ? 0.67 : 0.85, 5);
      expect(r.canvasW).toBe(Math.floor(1280 * r.pixelRatio));
      await newGame(page);
      for (const hours of [12, 23]) {
        await page.evaluate((h) => (window as Api).__gta7.setTime(h), hours);
        await page.waitForTimeout(600);
        const px = await page.evaluate(() => (window as Api).__gta7.samplePixels());
        expect(px.colors).toBeGreaterThan(6);
      }
      const s = await state(page);
      expect(s.render.tier).toBe(tier);
      expect(s.crashed).toBe(false);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('WebGL context loss', () => {
  test('a lost context pauses under an overlay and a restored one returns to a rendered, paused game', async ({ page }) => {
    await noPointerLock(page);
    const errors = await boot(page);
    await newGame(page);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      // Kept: the extension cannot be fetched again from a lost context.
      const ext = g.game.renderer.renderer.getContext().getExtension('WEBGL_lose_context');
      (window as Api).__loseContext = ext;
      ext.loseContext();
    });
    const overlay = page.locator('.gfx-lost');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Graphics reset - restoring...');
    const t0 = await page.evaluate(() => (window as Api).__gta7.sim.time);
    const f0 = (await state(page)).frames;
    await page.waitForTimeout(800);
    // The loop keeps running but nothing steps: sim time stands still.
    expect(await page.evaluate(() => (window as Api).__gta7.sim.time)).toBe(t0);
    expect((await state(page)).frames).toBeGreaterThan(f0);
    expect(await page.evaluate(() => (window as Api).__gta7.game.contextLost)).toBe(true);

    await page.evaluate(() => (window as Api).__loseContext.restoreContext());
    await expect(overlay).toHaveCount(0);
    expect(await page.evaluate(() => (window as Api).__gta7.game.contextLost)).toBe(false);
    await expect(page.locator('.panel h2:visible')).toHaveText('PAUSED');
    await page.waitForTimeout(300);
    const px = await page.evaluate(() => (window as Api).__gta7.samplePixels());
    expect(px.colors).toBeGreaterThan(6);
    expect(px.std).toBeGreaterThan(4);
    expect(await page.evaluate(() => (window as Api).__gta7.sim.time)).toBe(t0);

    await page.getByRole('button', { name: 'RESUME', exact: true }).click();
    await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as Api).__gta7.sim.time)).toBeGreaterThan(t0 + 0.3);
    // Play goes on: drive off in a car and look around at night.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.spawnVehicle('sports', true);
      g.setTime(22);
    });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    const s = await state(page);
    expect(s.player.vehicle).toBe('sports');
    expect(s.player.speed).toBeGreaterThan(3);
    const night = await page.evaluate(() => (window as Api).__gta7.samplePixels());
    expect(night.colors).toBeGreaterThan(6);
    expect(s.crashed).toBe(false);
    // Resizing and switching tiers dispose targets made before the loss: still no WebGL errors.
    await page.setViewportSize({ width: 1100, height: 640 });
    await page.waitForTimeout(300);
    for (const quality of ['low', 'medium', 'high']) {
      await page.evaluate((q) => {
        const g = (window as Api).__gta7.game;
        g.applySettings({ ...g.settings, quality: q }, false);
      }, quality);
      await page.waitForTimeout(300);
      const px = await page.evaluate(() => (window as Api).__gta7.samplePixels());
      expect(px.colors).toBeGreaterThan(6);
    }
    expect((await state(page)).crashed).toBe(false);
    // Only the browser's own notice about the lost context may appear.
    expect(errors.filter((e) => !/CONTEXT_LOST_WEBGL/.test(e))).toEqual([]);
  });
});
