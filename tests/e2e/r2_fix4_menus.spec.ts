import { expect, test, type Page } from '@playwright/test';
import { boot, holdKey, newGame, type Api } from './helpers';

// Round 2, fix pass 4 (menus): the full-screen map and a key held from play, and the map on a HiDPI screen.

const waypoint = (page: Page) => page.evaluate(() => (window as Api).__gta7.game.hud.waypoint as { x: number; z: number } | null);

/** A key press, then a few frames for the game to read it. */
async function key(page: Page, k: string): Promise<void> {
  await page.keyboard.press(k);
  await page.waitForTimeout(100);
}

/** Opens the map with M and waits out its 0.25 s input guard. */
async function openMap(page: Page): Promise<void> {
  await page.keyboard.press('KeyM');
  await expect(page.locator('.map-screen')).toBeVisible();
  await page.waitForTimeout(300);
}

/** Where a click at (x, y) on the page drops the waypoint on the open map; the waypoint is then cleared. */
async function clickAt(page: Page, x: number, y: number): Promise<{ x: number; z: number }> {
  await page.evaluate(() => ((window as Api).__gta7.game.hud.waypoint = null));
  await page.mouse.click(x, y);
  const w = (await waypoint(page))!;
  await page.evaluate(() => ((window as Api).__gta7.game.hud.waypoint = null));
  return w;
}

test.describe('GTA 7 menus fixes', () => {
  test('driving with W held, M opens a map that stays put until W is let go; held again, W pans it', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    // The map's opening centre: Enter drops the waypoint at the cross.
    await openMap(page);
    await key(page, 'Enter');
    const centre = (await waypoint(page))!;
    await key(page, 'Enter');
    expect(await waypoint(page)).toBeNull();
    await key(page, 'Escape');
    await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
    // In a car with W down, M pressed with W still held, and W let go a second later.
    await page.evaluate(() => (window as Api).__gta7.spawnVehicle('sedan'));
    await page.waitForTimeout(500);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(600);
    await page.keyboard.press('KeyM');
    await expect(page.locator('.map-screen')).toBeVisible();
    await page.waitForTimeout(1000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(200);
    await key(page, 'Enter');
    const held = (await waypoint(page))!;
    expect(Math.hypot(held.x - centre.x, held.z - centre.z)).toBeLessThan(1);
    // Let go since the map opened, W pans it north when held again.
    await key(page, 'Enter');
    await holdKey(page, 'KeyW', 400);
    await key(page, 'Enter');
    expect((await waypoint(page))!.z).toBeLessThan(centre.z - 100);
    await key(page, 'Escape');
    await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
    expect(errors).toEqual([]);
  });
});

test.describe('GTA 7 menus fixes on a HiDPI screen', () => {
  test.use({ deviceScaleFactor: 2 });

  test('the map canvas is backed at twice its CSS size, and clicks land on the same world points as at ratio 1', async ({ page, browser, baseURL }) => {
    // Clear of the title (top left), the legend (top right) and the hint (bottom left); the second is the cross.
    const points = [
      [700, 250],
      [640, 360],
      [180, 560],
    ] as const;
    // The same clicks on a screen at ratio 1 first.
    const one = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page1 = await one.newPage();
    const errors1 = await boot(page1);
    await newGame(page1);
    await openMap(page1);
    const at1 = [];
    for (const [x, y] of points) at1.push(await clickAt(page1, x, y));
    expect(errors1).toEqual([]);
    await one.close();

    const errors = await boot(page);
    await newGame(page);
    await openMap(page);
    const c = await page.evaluate(() => {
      const canvas = document.querySelector('.map-screen canvas') as HTMLCanvasElement;
      const r = canvas.getBoundingClientRect();
      return { w: canvas.width, h: canvas.height, cssW: r.width, cssH: r.height, dpr: window.devicePixelRatio };
    });
    expect(c).toEqual({ w: 2560, h: 1440, cssW: 1280, cssH: 720, dpr: 2 });
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i]!;
      const w = await clickAt(page, x, y);
      expect(w.x, `click at ${x}, ${y}`).toBeCloseTo(at1[i]!.x, 6);
      expect(w.z, `click at ${x}, ${y}`).toBeCloseTo(at1[i]!.z, 6);
    }
    // The cross in the middle is where Enter puts the waypoint.
    const cross = (await page.locator('.map-cross').boundingBox())!;
    expect([cross.x + cross.width / 2, cross.y + cross.height / 2]).toEqual([640, 360]);
    await key(page, 'Enter');
    expect(await waypoint(page)).toEqual(at1[1]);
    expect(errors).toEqual([]);
  });
});
