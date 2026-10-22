import { expect, test, type Page } from '@playwright/test';
import { QUALITY, type QualityTier } from '../../src/render/quality';
import { boot, newGame, state, type Api } from './helpers';

// Graphics quality tiers (Auto, Low, Medium, High) and recovery from a lost WebGL context.
// What Auto means depends on the machine's GPU (High on the reference RTX machine, Low under
// SwiftShader), so the settings test reads it from the game; Low and Medium are also booted directly.

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
    const auto: QualityTier = await page.evaluate(() => (window as Api).__gta7.game.autoTier);
    const gpu = await page.evaluate(() => {
      const gl = (window as Api).__gta7.game.renderer.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    });
    console.log(`GPU: ${gpu}; auto tier: ${auto}`);
    test.info().annotations.push({ type: 'gpu', description: `${gpu}; auto tier ${auto}` });
    // MSAA is fixed when the renderer is made (here from Auto); everything else applies at once.
    const builtMsaa = QUALITY[auto].msaa;
    expect((await state(page)).render.tier).toBe(auto);
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    const select = page.locator('.setting select');
    const note = page.locator('.setting-note');
    await expect(select).toHaveValue('auto');
    await expect(select.locator('option').first()).toHaveText(`AUTO (${auto.toUpperCase()})`);
    await expect(note).toBeHidden();
    await select.selectOption('low');
    expect((await state(page)).render.tier).toBe('low');
    if (builtMsaa) await expect(note).toHaveText('Anti-aliasing turns off after a reload.');
    else await expect(note).toBeHidden();
    let r = await rendererFacts(page);
    expect(r).toMatchObject({ tier: 'low', msaa: builtMsaa, antialias: builtMsaa, shadows: false, point: 0, spot: 0 });
    expect(r.pixelRatio).toBeCloseTo(0.67, 5);
    await select.selectOption('high');
    expect((await state(page)).render.tier).toBe('high');
    if (builtMsaa) await expect(note).toBeHidden();
    else await expect(note).toHaveText('Anti-aliasing turns on after a reload.');
    r = await rendererFacts(page);
    expect(r).toMatchObject({ tier: 'high', shadows: true, point: 3, spot: 7 });
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
    const back = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      return { tier: g.state().render.tier, traffic: g.sim.traffic.density, setting: g.game.settings.quality, px: g.samplePixels() };
    });
    expect(back).toMatchObject({ tier: auto, traffic: QUALITY[auto].trafficDensity, setting: 'auto' });
    expect(back.px.colors).toBeGreaterThan(6);
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

/**
 * Renders one traffic light head-on (downtown node 4,4) with its clock pinned to show each colour, and
 * reads the lit bulb's pixels: the centre of the bulb, and the halo just beside it.
 */
const signalPixels = (page: Page) =>
  page.evaluate(() => {
    const g = (window as Api).__gta7;
    const sim = g.sim;
    const R = g.game.renderer;
    const props = R.props;
    const node = sim.roads.node(4, 4);
    const k = props.signalProps.findIndex((q: { node: number; dir: number }) => q.node === node.id && q.dir === 0);
    const p = props.signalProps[k];
    const axis = p.dir === 0 || p.dir === 2 ? 'NS' : 'EW';
    const fx = Math.sin(p.rot);
    const fz = Math.cos(p.rot);
    const cam = R.cameraCtl.camera;
    // A fixed camera 6 m in front of the signal head, looking at it.
    R.cameraCtl.update = () => {
      cam.position.set(p.x + fx * 6, 4.4, p.z + fz * 6);
      cam.lookAt(p.x + fx * 0.21, 4.55, p.z + fz * 0.21);
    };
    const gl = R.renderer.getContext() as WebGL2RenderingContext;
    const read = (x: number, y: number) => {
      const a = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
      return [a[0]!, a[1]!, a[2]!];
    };
    const mean = (pts: number[][]) => [0, 1, 2].map((i) => Math.round(pts.reduce((sum, q) => sum + read(q[0]!, q[1]!)[i]!, 0) / pts.length));
    const out: Record<string, { centre: number[]; halo: number[] }> = {};
    for (const [b, want] of [[0, 'red'], [1, 'yellow'], [2, 'green']] as const) {
      let t = 0;
      while (sim.roads.signalState(p.node, axis, t) !== want) t += 0.25;
      sim.time = t;
      R.render(0, false);
      const m = cam.matrixWorld.clone();
      props.signalBulbs.getMatrixAt(k * 3 + b, m);
      const pos = cam.position.clone().setFromMatrixPosition(m);
      const v = pos.clone().project(cam);
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const x = Math.round(((v.x + 1) / 2) * w);
      const y = Math.round(((v.y + 1) / 2) * h);
      // The bulb's radius (0.11 m) in pixels; the halo is sampled 2.2 radii out to either side.
      const r = Math.abs(((pos.clone().add(cam.up.clone().multiplyScalar(0.11)).project(cam).y + 1) / 2) * h - y);
      const d = Math.round(2.2 * r);
      out[want] = { centre: mean([[x, y], [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]), halo: mean([[x - d, y], [x + d, y]]) };
    }
    return out;
  });

test.describe('traffic lights by tier', () => {
  test('on Low a lit light shows its own colour without bloom; on High the red one blooms like the rest', async ({ page }) => {
    await noPointerLock(page);
    await page.addInitScript(() => localStorage.setItem('gta7.settings.v1', JSON.stringify({ quality: 'low' })));
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.clock.rate = 0;
      g.setTime(22);
    });
    expect((await rendererFacts(page)).tier).toBe('low');
    const low = await signalPixels(page);
    const [rr, rg, rb] = low.red!.centre as [number, number, number];
    expect(rr - Math.max(rg, rb), `red ${low.red!.centre}`).toBeGreaterThan(150);
    const [yr, yg, yb] = low.yellow!.centre as [number, number, number];
    expect(yr - yb, `yellow ${low.yellow!.centre}`).toBeGreaterThan(120);
    expect(yg - yb, `yellow ${low.yellow!.centre}`).toBeGreaterThan(80);
    const [gr, gg, gb] = low.green!.centre as [number, number, number];
    expect(gg - gr, `green ${low.green!.centre}`).toBeGreaterThan(60);
    expect(gg, `green ${low.green!.centre}`).toBeGreaterThan(gb);
    // High: the bulbs' cores are near white, so the colour is in the halo: red's has to be there too.
    await page.evaluate(() => {
      const g = (window as Api).__gta7.game;
      g.applySettings({ ...g.settings, quality: 'high' }, false);
    });
    const high = await signalPixels(page);
    const [hr, hg, hb] = high.red!.halo as [number, number, number];
    expect(hr - Math.max(hg, hb), `red halo ${high.red!.halo}`).toBeGreaterThan(60);
    const [qr, qg] = high.green!.halo as [number, number, number];
    expect(qg - qr, `green halo ${high.green!.halo}`).toBeGreaterThan(40);
    expect(errors).toEqual([]);
  });
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
    await page.waitForFunction((t) => (window as Api).__gta7.sim.time > t + 0.3, t0, { timeout: 15_000 });
    // Play goes on: drive off in a car and look around at night.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.spawnVehicle('sports', true);
      g.setTime(22);
    });
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => (window as Api).__gta7.state().player.speed > 3, null, { timeout: 15_000 });
    await page.keyboard.up('KeyW');
    const s = await state(page);
    expect(s.player.vehicle).toBe('sports');
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
