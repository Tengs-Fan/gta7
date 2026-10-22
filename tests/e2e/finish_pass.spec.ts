import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

// FinishPass on the real GPU: the per-tier anti-aliasing, the time-of-day grade and the vignette.

/** Renders a frame and reads the whole canvas: channel means, the four 5 % corners and the centre. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const r = (window as Api).__gta7.game.renderer;
    r.render(1 / 60, false);
    const gl = r.renderer.getContext() as WebGL2RenderingContext;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const cw = Math.floor(w * 0.05);
    const ch = Math.floor(h * 0.05);
    let rb = 0;
    let corner = 0;
    let cn = 0;
    let centre = 0;
    let cen = 0;
    let sum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const l = (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
        sum += l;
        rb += px[i]! - px[i + 2]!;
        if ((x < cw || x >= w - cw) && (y < ch || y >= h - ch)) {
          corner += l;
          cn++;
        }
        if (Math.abs(x - w / 2) < w * 0.05 && Math.abs(y - h / 2) < h * 0.05) {
          centre += l;
          cen++;
        }
      }
    }
    return { mean: sum / (w * h), rMinusB: rb / (w * h), corner: corner / cn, centre: centre / cen };
  });

async function still(page: Page, hours: number): Promise<void> {
  await page.evaluate((h) => {
    const g = (window as Api).__gta7;
    g.setClockRate(0);
    g.setTime(h);
    g.setCamera(0.6, 0.05);
  }, hours);
  await page.waitForTimeout(800);
}

test.describe('finish pass', () => {
  test('High grades warm at golden hour, keeps noon neutral and vignettes the night', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const s = await state(page);
    expect(s.render.tier).toBe('high');
    expect(s.render.post).toMatchObject({ aa: 'msaa', grade: true });

    const pair = async () => {
      await page.evaluate(() => (window as Api).__gta7.setPost({ grade: false }));
      const off = await measure(page);
      await page.evaluate(() => (window as Api).__gta7.setPost({ grade: true }));
      return { off, on: await measure(page) };
    };
    await still(page, 12);
    const noon = await pair();
    expect(Math.abs(noon.on.rMinusB - noon.off.rMinusB)).toBeLessThanOrEqual(3);
    await still(page, 18.4);
    const golden = await pair();
    expect(golden.on.rMinusB).toBeGreaterThan(golden.off.rMinusB);
    await still(page, 23);
    const night = await pair();
    expect(night.on.rMinusB).toBeLessThan(night.off.rMinusB);

    await page.evaluate(() => (window as Api).__gta7.setPost({ vignette: 0 }));
    const flat = await measure(page);
    await page.evaluate(() => (window as Api).__gta7.setPost({ vignette: null }));
    const vig = await measure(page);
    expect(vig.corner).toBeLessThan(flat.corner * 0.95);
    expect(Math.abs(vig.centre - flat.centre)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('Low uses FXAA without shifting the colours', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('gta7.settings.v1', JSON.stringify({ quality: 'low' })));
    const errors = await boot(page);
    await newGame(page);
    expect((await state(page)).render.post).toMatchObject({ aa: 'fxaa', grade: true });
    await still(page, 12);
    await page.evaluate(() => (window as Api).__gta7.setPost({ aa: 'none' }));
    const none = await measure(page);
    await page.evaluate(() => (window as Api).__gta7.setPost({ aa: 'fxaa' }));
    const fxaa = await measure(page);
    expect(Math.abs(fxaa.mean - none.mean)).toBeLessThanOrEqual(3);
    expect(errors).toEqual([]);
  });
});
