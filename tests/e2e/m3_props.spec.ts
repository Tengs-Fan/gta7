import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Mission 3 props and foliage on the real GPU: the dressing is drawn, the foliage sways with render time while the
// clock stands still and stops on Low, and switching tiers twice builds no new programs for it.
test.describe('m3 props and foliage', () => {
  test('dressing drawn, wind on High and Medium, still on Low, programs stable', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const info = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.setClockRate(0);
      const props = g.game.renderer.props;
      const kinds = [...props.dressing.keys()].sort();
      const instances = [...props.dressing.values()].flat().reduce((n: number, m: { count: number }) => n + m.count, 0);
      return { kinds, instances, tier: g.state().render.tier };
    });
    expect(info.tier).toBe('high');
    expect(info.kinds).toEqual(expect.arrayContaining(['umbrella', 'towel', 'fence', 'mailbox', 'rail', 'bollard', 'workbench', 'tyres']));
    expect(info.instances).toBeGreaterThan(500);
    const wind = () => page.evaluate(() => (window as Api).__gta7.game.renderer.props.wind as { time: number; amp: number });
    const t0 = await wind();
    await page.waitForTimeout(500);
    const t1 = await wind();
    expect(t1.time).toBeGreaterThan(t0.time + 0.2);
    expect(t1.amp).toBeGreaterThan(0);
    const programs = () => page.evaluate(() => (window as Api).__gta7.state().render.programs as number);
    const setTier = (q: string) => page.evaluate((q) => {
      const g = (window as Api).__gta7.game;
      g.applySettings({ ...g.settings, quality: q }, false);
    }, q);
    await setTier('low');
    await page.waitForTimeout(400);
    expect((await wind()).amp).toBe(0);
    await setTier('medium');
    await page.waitForTimeout(400);
    expect((await wind()).amp).toBeGreaterThan(0);
    await setTier('high');
    await page.waitForTimeout(600);
    const p0 = await programs();
    await setTier('low');
    await page.waitForTimeout(400);
    await setTier('high');
    await page.waitForTimeout(600);
    expect(await programs()).toBeLessThanOrEqual(p0 + 1);
    expect(errors).toEqual([]);
  });
});
