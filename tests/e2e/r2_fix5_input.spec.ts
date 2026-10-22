import { expect, test, type Page } from '@playwright/test';
import { boot, fakePad, newGame, padTap, state, type Api } from './helpers';

/**
 * The share (0..1) of the first shown element matching `selector` (and `text`, if given) that is on screen: inside the
 * viewport and inside every box around it that clips (a scrolling panel). Measured without clicking, as a click scrolls.
 */
async function shown(page: Page, selector: string, text?: string): Promise<number> {
  return page.evaluate(
    ([sel, txt]) => {
      const el = [...document.querySelectorAll<HTMLElement>(sel!)].find((e) => e.offsetParent !== null && (txt === '' || e.textContent!.trim() === txt));
      if (!el) return -1;
      const r = el.getBoundingClientRect();
      let [x0, y0, x1, y1] = [Math.max(0, r.left), Math.max(0, r.top), Math.min(innerWidth, r.right), Math.min(innerHeight, r.bottom)];
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const b = a.getBoundingClientRect();
        [x0, y0, x1, y1] = [Math.max(x0, b.left), Math.max(y0, b.top), Math.min(x1, b.right), Math.min(y1, b.bottom)];
      }
      return (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / Math.max(1, r.width * r.height);
    },
    [selector, text ?? ''],
  );
}

/** How far (px) the open pause panel's content runs past its box, so it would have to scroll. */
const panelOverflow = (page: Page) => page.evaluate(() => {
  const p = document.querySelector<HTMLElement>('.pause-panel')!;
  return p.scrollHeight - p.clientHeight;
});

/** Windowed laptop viewports: 1280 x 720 or 1080p at 150 % (595), 1366 x 768 (643, 615 with a bookmarks bar), and lower. */
const WINDOWED = [
  [1280, 595],
  [1366, 643],
  [1366, 615],
  [1280, 560],
] as const;

test.describe('GTA 7 input fixes (round 2, pass 5)', () => {
  test('the title menu, the gun shop and the pause menu fit windowed laptop viewports', async ({ page }) => {
    const errors = await boot(page);
    const logo = () => page.evaluate(() => getComputedStyle(document.querySelector('.logo .gta')!).fontSize);
    // The editorial title leaves the city visible while its mark scales with the viewport.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(200);
    expect(parseFloat(await logo())).toBeGreaterThanOrEqual(120);
    expect(parseFloat(await logo())).toBeLessThanOrEqual(160);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(200);
    expect(parseFloat(await logo())).toBeGreaterThanOrEqual(90);
    expect(parseFloat(await logo())).toBeLessThanOrEqual(140);
    for (const [width, height] of WINDOWED) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      expect(await shown(page, '.menu button', 'CREDITS'), `CREDITS at ${at}`).toBe(1);
      expect(await shown(page, '.title-foot'), `disclaimer at ${at}`).toBe(1);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await newGame(page);
    await page.evaluate(() => (window as Api).__gta7.sim.progress.addMoney(250));
    for (const [width, height] of WINDOWED) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.evaluate(() => {
        const g = (window as Api).__gta7;
        const p = g.poi('guns_south');
        g.place(p.x, p.z);
      });
      await page.waitForTimeout(300);
      await page.keyboard.press('KeyE');
      await expect(page.locator('.panel h2:visible')).toHaveText('BANG BANG GUNS');
      await page.waitForTimeout(300);
      // The last row, bought: the message line says why not. A press a few frames apart from the next (two in one frame
      // count as one, and the shop takes one action a frame).
      for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter']) {
        await page.keyboard.press(key);
        await page.waitForTimeout(100);
      }
      await expect(page.locator('.shop-msg')).not.toHaveText('');
      expect(await shown(page, '.shop-item.sel'), `last row at ${at}`).toBe(1);
      expect(await shown(page, '.shop-msg'), `message at ${at}`).toBe(1);
      expect(await shown(page, '.shop-how'), `how to buy at ${at}`).toBe(1);
      expect(await shown(page, '.panel button', 'LEAVE'), `LEAVE at ${at}`).toBe(1);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => (window as Api).__gta7.startMission('wheels'));
    await page.waitForTimeout(1000);
    for (const [width, height] of WINDOWED) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await expect(page.locator('.panel h2:visible')).toHaveText('PAUSED');
      await page.waitForTimeout(300);
      await expect(page.locator('.panel p:visible')).toContainText('Mission:');
      expect(await shown(page, '.menu button', 'QUIT TO TITLE'), `QUIT TO TITLE at ${at}`).toBe(1);
      expect(await shown(page, '.panel p'), `mission line at ${at}`).toBe(1);
      expect(await panelOverflow(page), `pause panel overflow at ${at}`).toBeLessThanOrEqual(0);
      if (width === 1280 && height === 560) await page.screenshot({ path: test.info().outputPath('pause-1280x560.png') });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
      await page.waitForTimeout(300);
    }
    // A failed mission adds RETRY MISSION with its description line, the tallest pause menu.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.missions.active.fail('The test failed it.');
    });
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === null);
    await page.evaluate(() => (window as Api).__gta7.sim.wanted.clear());
    await page.waitForFunction(() => (window as Api).__gta7.sim.missions.retryMenuOffer() !== null);
    for (const [width, height] of [...WINDOWED, [1280, 720], [1366, 768], [1920, 1080]] as const) {
      const at = `${width}x${height} with a retry`;
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await expect(page.locator('.panel h2:visible')).toHaveText('PAUSED');
      await expect(page.locator('[data-id="retry-mission"]')).toHaveText('RETRY MISSION');
      await page.waitForTimeout(300);
      for (const label of ['RESUME', 'MAP', 'STATS', 'CONTROLS', 'SETTINGS', 'RETRY MISSION', 'QUIT TO TITLE']) {
        expect(await shown(page, '.menu button', label), `${label} at ${at}`).toBe(1);
      }
      expect(await shown(page, '.panel p'), `context line at ${at}`).toBe(1);
      expect(await panelOverflow(page), `pause panel overflow at ${at}`).toBeLessThanOrEqual(0);
      if (width === 1280 || width === 1920) await page.screenshot({ path: test.info().outputPath(`pause-${at.replace(/ /g, '-')}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
      await page.waitForTimeout(300);
    }
    expect(errors).toEqual([]);
  });

  test("a gamepad's left stick moves the title selection and changes a setting", async ({ page }) => {
    await fakePad(page);
    const errors = await boot(page);
    const sel = () => page.evaluate(() => document.querySelector('.screen:not(.hidden) .menu button.sel')?.textContent ?? null);
    /** A push of the left stick for 150 ms (one step: the stick repeats after 0.4 s). */
    const push = async (axis: number, v: number) => {
      await page.evaluate(([a, x]) => ((window as Api).__pad.axes[a!] = x), [axis, v]);
      await page.waitForTimeout(150);
      await page.evaluate((a) => ((window as Api).__pad.axes[a] = 0), axis);
      await page.waitForTimeout(150);
    };
    await page.waitForTimeout(300);
    expect(await sel()).toBe('NEW GAME');
    await push(1, 1);
    expect(await sel()).toBe('STREET RUN');
    await push(1, 1);
    expect(await sel()).toBe('CONTROLS');
    await push(1, 1);
    expect(await sel()).toBe('SETTINGS');
    await padTap(page, 0);
    await expect(page.locator('.panel h2:visible')).toHaveText('SETTINGS');
    await page.waitForTimeout(300);
    const quality = () => page.evaluate(() => (window as Api).__gta7.game.settings.quality);
    const q0 = await quality();
    await push(0, q0 === 'high' ? -1 : 1);
    expect(await quality()).not.toBe(q0);
    expect(errors).toEqual([]);
  });

  test('a gamepad in a car: LB steps the drawn rifle back to the SMG, and X fires it from the car', async ({ page }) => {
    await fakePad(page);
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.give('pistol', 100);
      g.give('smg', 300);
      g.give('rifle', 300);
      g.spawnVehicle('sedan', true);
    });
    await page.waitForTimeout(400);
    expect((await state(page)).player).toMatchObject({ vehicle: 'sedan', weapon: 'rifle' });
    const shots = () => page.evaluate(() => (window as Api).__gta7.sim.progress.stats.shotsFired as number);
    const before = await shots();
    await padTap(page, 4);
    expect((await state(page)).player.weapon).toBe('smg');
    await page.evaluate(() => ((window as Api).__pad.buttons[2].pressed = true));
    await page.waitForTimeout(500);
    await page.evaluate(() => ((window as Api).__pad.buttons[2].pressed = false));
    expect(await shots()).toBeGreaterThan(before);
    expect((await state(page)).player.vehicle).toBe('sedan');
    expect(errors).toEqual([]);
  });

  test('in a taxi job F gets out at once, and the job ends once no FIXMYRIDE follows', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.spawnVehicle('taxi', true);
      g.sim.activities.toggleJob();
    });
    await page.waitForTimeout(400);
    const job = () => page.evaluate(() => (window as Api).__gta7.sim.activities.job?.kind ?? null);
    expect(await job()).toBe('taxi');
    await page.keyboard.down('KeyF');
    // Out within a few frames: it no longer waits up to 1.5 s for the I of FIXMYRIDE.
    await page.waitForFunction(() => (window as Api).__gta7.state().player.vehicle === null, null, { timeout: 400 });
    await page.keyboard.up('KeyF');
    await page.waitForTimeout(2000);
    expect(await job()).toBe(null);
    expect(errors).toEqual([]);
  });
});
