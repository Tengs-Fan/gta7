import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Round 2, cluster "police": the dispatch scanner line, the evade bar and the helicopter's spotlight
// in the real game.

test.describe('GTA 7 police', () => {
  test('dispatch chatter on its own line, and the evade bar while the stars flash', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.missions.noBust = true;
      g.setWanted(2);
    });
    await expect(page.locator('.scanner.show')).toContainText('DISPATCH: All units', { timeout: 5000 });
    await expect(page.locator('.evade')).toBeHidden();
    // He slips away out of the search area: the stars flash and the bar fills.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const w = g.sim.wanted;
      w.responseUntil = 0;
      g.sim.police.dismissAll();
      const p = g.sim.player.pos;
      const n = g.sim.roads.nearestNode(p.x + 300, p.z);
      g.teleport(n.x + 9, n.z + 9);
      g.sim.ambient = false;
    });
    await expect(page.locator('.evade')).toBeVisible({ timeout: 6000 });
    await page.waitForFunction(() => parseFloat(document.querySelector<HTMLElement>('.evade > i')!.style.width) > 15, null, { timeout: 8000 });
    await expect(page.locator('.scanner.show')).toContainText('We lost visual', { timeout: 8000 });
    await expect(page.locator('.subtitle.show')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the helicopter spotlight at night does not wash out the screen', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.missions.noBust = true;
      g.setTime(22.5);
      g.setWanted(3);
    });
    // The helicopter comes overhead with its beam on the player.
    await page.waitForFunction(
      () => {
        const g = (window as Api).__gta7;
        const h = g.sim.helis.find((x: Api) => !x.destroyed);
        const p = g.sim.player.pos;
        return !!h && Math.hypot(h.pos.x - p.x, h.pos.z - p.z) < 40 && Math.hypot(h.spotlight.x - p.x, h.spotlight.z - p.z) < 6;
      },
      null,
      { timeout: 30_000 },
    );
    const lit = await page.evaluate(() => (window as Api).__gta7.samplePixels().mean);
    const dark = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const m = g.game.renderer.markers;
      const sync = m.syncHelis.bind(m);
      m.syncHelis = (...args: Api[]) => {
        sync(...args);
        for (const v of m.heliViews.values()) v.cone.visible = v.pool.visible = false;
      };
      const mean = g.samplePixels().mean;
      m.syncHelis = sync;
      return mean;
    });
    // The light adds a little, and never blacks the frame out (a NaN in the beam would, through the bloom).
    expect(lit).toBeGreaterThanOrEqual(dark - 1);
    expect(lit).toBeLessThanOrEqual(dark * 1.25 + 1);
    expect(errors).toEqual([]);
  });
});
