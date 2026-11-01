import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// The full map's legend names each kind of icon as the map draws it; pointing at an icon, or putting it under the cross,
// names it; a legend row hovered or picked with Tab lights its icons up.

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

/** Where the first POI of `kind` is drawn (CSS px) on the map as it opened, `zoom` steps of 1.5x in (screens/map.ts). */
function poiOnMap(page: Page, kind: string, zoom = 0): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([kind, zoom]) => {
      const sim = (window as Api).__gta7.sim;
      const b = sim.world.layout.bounds;
      const cx = (b.landMinX + b.beachEndX) / 2;
      const cz = (b.landMinZ + b.landMaxZ) / 2;
      const k = Math.min(innerWidth / (2 * (b.worldMaxX - cx)), innerHeight / (2 * (b.worldMaxZ - cz))) * Math.pow(1.5, zoom);
      const p = sim.world.layout.pois.find((q: { kind: string }) => q.kind === kind);
      return { x: innerWidth / 2 + (p.x - cx) * k, y: innerHeight / 2 + (p.z - cz) * k };
    },
    [kind, zoom] as const,
  );
}

/** The map canvas's colour at (x, y) CSS px. */
function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.map-screen > canvas') as HTMLCanvasElement;
      const s = c.width / c.getBoundingClientRect().width;
      // Copied out to a canvas of its own: reading the map's own back more than once draws a warning.
      const one = document.createElement('canvas');
      one.width = one.height = 1;
      const ctx = one.getContext('2d')!;
      ctx.drawImage(c, Math.round(x * s), Math.round(y * s), 1, 1, 0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    },
    [x, y] as const,
  );
}

const tip = (page: Page) => page.locator('.map-tip');

test.describe('the map legend and icon names', () => {
  test('names each icon as the map draws it, and pointing at the hospital names it beside the pointer', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await openMap(page);
    for (const name of ['Mama Lou (missions)', 'Gun shop', 'Spray Shack', 'Azura Customs', 'Safehouse (save)', 'Hospital', 'AzuraLink station', 'Safehouse garage (for sale)', 'Pier Arcade (for sale)', 'Los Tiburones turf', 'Hidden package', 'Rampage', 'Paramedic', 'Gull Regatta', 'Coyote Ridge Hill Climb', 'Gravel Gulch scramble', 'You', 'Waypoint']) {
      await expect(page.locator('.legend-row', { hasText: name }).first(), name).toBeAttached();
    }
    // Only what is on the map: not wanted, no police.
    await expect(page.locator('.legend-row', { hasText: 'Police unit' })).toHaveCount(0);
    await expect(page.locator('.legend-cat')).toHaveText([/Missions/i, /Shops/i, /Places/i, /Properties/i, /Gang turf/i, /Collectibles/i, /Activities/i, /Live markers/i]);
    // Each row draws its icon.
    const painted = await page.evaluate(() =>
      [...document.querySelectorAll('.legend-row')].map((row) => {
        const c = row.querySelector('canvas')!;
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 128) n++;
        return [(row as HTMLElement).dataset.kind, n] as const;
      }),
    );
    console.log(painted.map(([k, n]) => `${k}: ${n} px`).join(', '));
    for (const [k, n] of painted) expect(n, k).toBeGreaterThan(40);

    const at = await poiOnMap(page, 'hospital');
    await page.mouse.move(at.x, at.y);
    await expect(tip(page)).toBeVisible();
    await expect(tip(page)).toContainText('Hospital');
    await expect(tip(page)).toContainText('San Azura General');
    const box = (await tip(page).boundingBox())!;
    expect(Math.abs(box.x - (at.x + 16))).toBeLessThan(2);
    expect(Math.abs(box.y - (at.y + 16))).toBeLessThan(2);
    // Open sea south of the city: nothing to name.
    await page.mouse.move(at.x, 640);
    await expect(tip(page)).toBeHidden();
    // A click there still sets a waypoint.
    await page.mouse.click(at.x, 640);
    expect(await page.evaluate(() => (window as Api).__gta7.game.hud.waypoint)).not.toBeNull();
    expect(errors).toEqual([]);
  });

  test('a legend row hovered lights its icons up and fades the rest; Tab picks the rows in turn', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await openMap(page);
    // A waypoint in the open sea, its disc beside its W the pixel to watch.
    const at = await poiOnMap(page, 'hospital');
    await page.mouse.click(at.x, 640);
    await page.mouse.move(at.x, 690);
    await page.waitForTimeout(150);
    const lit = await pixel(page, at.x + 9, 640);
    console.log('waypoint disc', lit);
    expect(lit[2]).toBeGreaterThan(200);
    await page.locator('.legend-row', { hasText: 'Hospital' }).hover();
    await page.waitForTimeout(150);
    const faded = await pixel(page, at.x + 9, 640);
    console.log('faded while the hospital row is hovered', faded);
    expect(faded[2]).toBeLessThan(lit[2]! - 60);
    await page.locator('.legend-row', { hasText: 'Waypoint' }).hover();
    await page.waitForTimeout(150);
    expect((await pixel(page, at.x + 9, 640))[2]).toBeGreaterThan(200);
    // A row with no icon drawn leaves the map as it is: turf (drawn as an area), a category switched off (3: places).
    await page.locator('.legend-row', { hasText: 'Los Tiburones turf' }).hover();
    await page.waitForTimeout(150);
    expect((await pixel(page, at.x + 9, 640))[2]).toBeGreaterThan(200);
    await key(page, 'Digit3');
    await page.locator('.legend-row', { hasText: 'Hospital' }).hover();
    await page.waitForTimeout(150);
    expect((await pixel(page, at.x + 9, 640))[2]).toBeGreaterThan(200);
    await key(page, 'Digit3');

    // With the keyboard: Tab steps through the headers and the icons.
    await page.mouse.move(at.x, 690);
    await key(page, 'Tab');
    await expect(page.locator('.legend-cat.sel')).toContainText('Missions');
    await key(page, 'Tab');
    await expect(page.locator('.legend-row.sel')).toHaveText('Mama Lou (missions)');
    await key(page, 'Tab');
    await key(page, 'Tab');
    await expect(page.locator('.legend-row.sel')).toHaveText('Gun shop');
    await page.screenshot({ path: 'test-results/map-legend-tab.png' });
    expect(errors).toEqual([]);
  });

  test('with the keys, the icon under the cross is named beside it', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await openMap(page);
    // Drag the hospital to the cross, then point somewhere empty.
    const at = await poiOnMap(page, 'hospital');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(at.x + ((640 - at.x) * i) / 10, at.y + ((360 - at.y) * i) / 10);
    await page.mouse.up();
    await page.mouse.move(640, 690);
    await expect(tip(page)).toBeHidden();
    // Zooming with + keeps the cross on the hospital and names it there.
    await key(page, 'Equal');
    await expect(tip(page)).toContainText('Hospital');
    const box = (await tip(page).boundingBox())!;
    expect(Math.abs(box.x - (640 + 16))).toBeLessThan(2);
    expect(Math.abs(box.y - (360 + 16))).toBeLessThan(2);
    expect(errors).toEqual([]);
  });
});

test.describe('icon names on a HiDPI screen', () => {
  test.use({ deviceScaleFactor: 2 });

  test('pointing at the hospital names it zoomed in too, at its size in CSS px', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await openMap(page);
    await key(page, 'Equal');
    await key(page, 'Equal');
    const at = await poiOnMap(page, 'hospital', 1);
    // Just inside the icon's edge (its disc's radius is 11 px at the map's 18 px).
    await page.mouse.move(at.x + 9, at.y + 7);
    await expect(tip(page)).toContainText('Hospital');
    await page.mouse.move(at.x + 20, at.y + 20);
    await expect(tip(page)).toBeHidden();
    expect(errors).toEqual([]);
  });
});
