import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Mission 3 asset library in the browser: every manifest entry loads from a relative URL with HTTP 200 and the
// characters draw their models; a failed character model, car model and texture fall back to the procedural forms of
// their own families only (the characters as one family), each with one warning, and the game stays playable.

/** The console's own network line for a request the test fails on purpose, and the library's one warning per id. */
const EXPECTED_FAILURE = /Failed to load resource|GTA7 assets: \S+ failed/;

async function play(page: Page): Promise<void> {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
  await page.evaluate(() => (window as Api).__gta7.spawnVehicle('police', true));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');
}

test.describe('m3 asset library', () => {
  test('every asset loads with HTTP 200 from a relative URL, and the characters draw their models', async ({ page }) => {
    const bad: string[] = [];
    let requests = 0;
    page.on('response', (r) => {
      const path = new URL(r.url()).pathname;
      if (!/\.(glb|webp|hdr)$/.test(path)) return;
      requests++;
      if (r.status() !== 200 || !path.startsWith('/assets/')) bad.push(`${r.status()} ${path}`);
    });
    page.on('requestfailed', (r) => bad.push(`failed ${r.url()}`));
    const errors = await boot(page);
    const report = await page.evaluate(() => (window as Api).__gta7.ext.assets.report());
    console.log(`[m3-assets] manifest ${report.manifest} loaded ${report.loaded} requests ${requests} bytes ${report.bytes} ms ${Math.round(report.ms)}`);
    expect(report.manifestFailed).toBe(false);
    expect(report.timedOut).toBe(false);
    expect(report.failed).toEqual([]);
    expect(report.loaded).toBe(report.manifest);
    expect(requests).toBe(report.manifest);
    expect(bad).toEqual([]);
    await newGame(page);
    await play(page);
    const chars = await page.evaluate(() => (window as Api).__gta7.ext.characters.stats());
    expect(chars.models).toBe(true);
    expect(chars.skinnedMeshes + chars.crowd).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('a failed character model, car model and texture fall back alone, with one warning each', async ({ page }) => {
    let texture = '';
    await page.route(/\/assets\/(swat|q_police)-[^/]*\.glb$/, (r) => r.abort());
    await page.route(/\/assets\/[^/]*\.webp$/, (r) => {
      if (texture) return r.continue();
      texture = new URL(r.request().url()).pathname;
      return r.abort();
    });
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    const errors = await boot(page);
    const report = await page.evaluate(() => (window as Api).__gta7.ext.assets.report());
    const failed = [...report.failed].sort();
    console.log(`[m3-assets] aborted swat, q_police and ${texture}: failed ${failed.join(', ')}; loaded ${report.loaded} of ${report.manifest}`);
    expect(failed).toHaveLength(3);
    expect(failed).toEqual(expect.arrayContaining(['char.swat', 'veh.q.police']));
    expect(failed.filter((id) => id.startsWith('tex.'))).toHaveLength(1);
    expect(report.loaded).toBe(report.manifest - 3);
    for (const id of failed) expect(warnings.filter((w) => w.includes(`GTA7 assets: ${id} failed`)), id).toHaveLength(1);
    await newGame(page);
    await play(page);
    const after = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const list = g.ext.assets.list() as Array<{ id: string; loaded: boolean }>;
      return {
        frames: g.state().frames,
        mode: g.state().mode,
        chars: g.ext.characters.stats(),
        police: list.find((e) => e.id === 'veh.q.police')?.loaded,
        taxi: list.find((e) => e.id === 'veh.q.taxi')?.loaded,
        pixels: g.samplePixels(),
      };
    });
    expect(after.mode).toBe('game');
    expect(after.police).toBe(false);
    expect(after.taxi).toBe(true);
    // The characters fall back as one family (characterModels.ts: any missing look model means the segment crowd).
    expect(after.chars.models).toBe(false);
    expect(after.chars.segments).toBeGreaterThan(0);
    expect(after.pixels.colors).toBeGreaterThan(6);
    expect(errors.filter((e) => !EXPECTED_FAILURE.test(e))).toEqual([]);
  });
});
