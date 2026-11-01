import { expect, test, type Page } from '@playwright/test';
import { boot, fakePad, newGame, padTap, type Api } from './helpers';

// The full map's legend names each kind of icon as the map draws it; pointing at an icon, or putting it under the cross,
// names it; a legend row hovered or picked with Tab (a category with a pad's Y) lights its icons up, and Esc lets go.

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

/**
 * Where a hidden package's square is drawn on the map as it opened (CSS px): of those in the open middle of the view,
 * the one on the darkest ground round it, so that its gold stands well apart from what it fades into.
 */
function packageOnMap(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const sim = (window as Api).__gta7.sim;
    const b = sim.world.layout.bounds;
    const cx = (b.landMinX + b.beachEndX) / 2;
    const cz = (b.landMinZ + b.landMaxZ) / 2;
    const k = Math.min(innerWidth / (2 * (b.worldMaxX - cx)), innerHeight / (2 * (b.worldMaxZ - cz)));
    const c = document.querySelector('.map-screen > canvas') as HTMLCanvasElement;
    const s = c.width / c.getBoundingClientRect().width;
    const one = document.createElement('canvas');
    one.width = one.height = 1;
    // Read back many times (the browser warns unless told so).
    const ctx = one.getContext('2d', { willReadFrequently: true })!;
    const bright = (x: number, y: number) => {
      ctx.drawImage(c, Math.round(x * s), Math.round(y * s), 1, 1, 0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return d[0]! + d[1]! + d[2]!;
    };
    // 14 px out: past the square (9 px) and its outline, not yet as far as the next block.
    const ground = (q: { x: number; y: number }) => Math.max(bright(q.x + 14, q.y), bright(q.x - 14, q.y), bright(q.x, q.y + 14), bright(q.x, q.y - 14));
    return sim.pickups
      .filter((p: { kind: string }) => p.kind === 'package')
      .map((p: { pos: { x: number; z: number } }) => ({ x: innerWidth / 2 + (p.pos.x - cx) * k, y: innerHeight / 2 + (p.pos.z - cz) * k }))
      .filter((q: { x: number; y: number }) => q.x > 320 && q.x < 900 && q.y > 100 && q.y < 620)
      .reduce((a: { x: number; y: number }, q: { x: number; y: number }) => (ground(q) < ground(a) ? q : a));
  });
}

/**
 * A package square's body: the middle of its lower right quarter, 3 px clear of the string across it and of its outline
 * (the square is 18 px, the string 2 px wide, the outline 2 px), so a pixel of rounding either way stays on the gold.
 */
const body = (page: Page, pkg: { x: number; y: number }) => pixel(page, pkg.x + 4.5, pkg.y + 4.5);

/** The legend's picked row: an icon row's kind, a header's name, '' for none. */
const picked = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.map-legend .sel') as HTMLElement | null;
    return el ? (el.dataset.kind ?? el.querySelector('.legend-name')!.textContent!) : '';
  });

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
    // Any icon, the smallest a taxi fare's or an officer's pip (about 28 px; at least 84 for the rows shown here).
    for (const [k, n] of painted) expect(n, k).toBeGreaterThan(20);

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
    // A hidden package's gold, the pixel to watch, with the pointer on the map away from the legend.
    const pkg = await packageOnMap(page);
    await page.mouse.move(600, 640);
    await page.waitForTimeout(150);
    const lit = await body(page, pkg);
    console.log('package', pkg, lit);
    expect(lit[0]).toBeGreaterThan(220);
    expect(lit[1]).toBeGreaterThan(180);
    const hovered = async (name: string) => {
      await page.locator('.legend-row', { hasText: name }).hover();
      await page.waitForTimeout(150);
      return (await body(page, pkg))[0]!;
    };
    const faded = await hovered('Hospital');
    console.log('faded while the hospital row is hovered', faded);
    expect(faded).toBeLessThan(lit[0]! - 80);
    expect(await hovered('Hidden package')).toBeGreaterThan(220);
    // A row with no icon drawn leaves the map as it is: turf (drawn as an area), a category switched off (3: places).
    expect(await hovered('Los Tiburones turf')).toBeGreaterThan(220);
    await key(page, 'Digit3');
    expect(await hovered('Hospital')).toBeGreaterThan(220);
    await key(page, 'Digit3');

    // With the keyboard: Tab steps through the headers and the icons, and picked, a row lights up as hovered.
    await page.mouse.move(600, 640);
    await key(page, 'Tab');
    await expect(page.locator('.legend-cat.sel')).toContainText('Missions');
    expect((await body(page, pkg))[0]).toBeLessThan(lit[0]! - 80);
    await key(page, 'Tab');
    await expect(page.locator('.legend-row.sel')).toHaveText('Mama Lou (missions)');
    await key(page, 'Tab');
    await key(page, 'Tab');
    await expect(page.locator('.legend-row.sel')).toHaveText('Gun shop');
    await page.screenshot({ path: 'test-results/map-legend-tab.png' });
    expect(errors).toEqual([]);
  });

  test('Shift+Tab steps the legend back, through none; Esc lets go of a pick, then closes the map; the focus stays put', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await openMap(page);
    const pkg = await packageOnMap(page);
    await page.mouse.move(600, 640);
    const lit = (await body(page, pkg))[0]!;
    const focus = () => page.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.id}`);
    const focused = await focus();
    const steps: string[] = [];
    for (const k of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await key(page, k);
      steps.push(await picked(page));
    }
    // Back past the first row to none, and on round to the last.
    expect(steps).toEqual(['Missions', 'contact:lou', 'Missions', '', 'waypoint']);
    expect(await focus()).toBe(focused);
    await key(page, 'Shift+Tab');
    await key(page, 'Shift+Tab');
    expect(await focus()).toBe(focused);
    // Up to the live markers' header, which fades the package; nothing else opened over the map (the phone, the pause menu).
    expect(await picked(page)).toBe('Live markers');
    expect((await body(page, pkg))[0]).toBeLessThan(lit - 80);
    expect(await page.evaluate(() => (window as Api).__gta7.game.menus.top.el.classList.contains('map-screen'))).toBe(true);
    await expect(page.locator('.phone-screen')).toHaveCount(0);
    // Esc lets go of the row: the map stays open and unfaded; a second Esc closes it, back to play.
    await key(page, 'Escape');
    expect(await picked(page)).toBe('');
    await expect(page.locator('.map-screen')).toBeVisible();
    expect((await body(page, pkg))[0]).toBeGreaterThan(220);
    await key(page, 'Escape');
    await expect(page.locator('.map-screen')).toHaveCount(0);
    expect(await page.evaluate(() => (window as Api).__gta7.state().menuOpen)).toBe(false);
    expect(errors).toEqual([]);
  });

  test("a pad's Y picks the categories in turn, then none, lighting each one's icons; X switches it; B lets go, then closes", async ({ page }) => {
    await fakePad(page);
    const errors = await boot(page);
    await newGame(page);
    await padTap(page, 8); // Back: the map
    await expect(page.locator('.map-screen')).toBeVisible();
    await page.waitForTimeout(350);
    const pkg = await packageOnMap(page);
    const lit = (await body(page, pkg))[0]!;
    expect(lit).toBeGreaterThan(220);
    const steps: string[] = [];
    for (let i = 0; i < 8; i++) {
      await padTap(page, 3);
      const p = await picked(page);
      steps.push(p);
      // Collectibles lights the packages, and turf, drawn as areas, leaves the map as it is; any other category fades them.
      const r = (await body(page, pkg))[0]!;
      if (['Collectibles', 'Gang turf', ''].includes(p)) expect(r, p).toBeGreaterThan(220);
      else expect(r, p).toBeLessThan(lit - 80);
    }
    expect(steps).toEqual(['Missions', 'Shops', 'Places', 'Properties', 'Gang turf', 'Collectibles', 'Activities', '']);
    // Round again to Collectibles, and X switches it off.
    for (let i = 0; i < 6; i++) await padTap(page, 3);
    expect(await picked(page)).toBe('Collectibles');
    await padTap(page, 2);
    expect(await page.evaluate(() => (window as Api).__gta7.game.settings.mapLayers)).toEqual({ collectibles: false });
    // B lets go of it, the map open; B again closes it.
    await padTap(page, 1);
    expect(await picked(page)).toBe('');
    await expect(page.locator('.map-screen')).toBeVisible();
    await padTap(page, 1);
    await expect(page.locator('.map-screen')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('with the keys, the icon under the cross is named beside it', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await openMap(page);
    // A waypoint one arrow step (60 px) right of the cross, then the pointer at rest on empty sea.
    await page.mouse.click(700, 360);
    await page.mouse.move(1100, 620);
    await expect(tip(page)).toBeHidden();
    // An arrow key pans the waypoint onto the cross, and the tip names it there, with the pointer still where it was.
    await key(page, 'ArrowRight');
    await expect(tip(page)).toContainText('Waypoint');
    const at = async () => {
      const box = (await tip(page).boundingBox())!;
      expect(Math.abs(box.x - (640 + 16))).toBeLessThan(2);
      expect(Math.abs(box.y - (360 + 16))).toBeLessThan(2);
    };
    await at();
    await page.waitForTimeout(1000);
    await expect(tip(page)).toContainText('Waypoint');
    // Zooming with + keeps the cross on it, still named there.
    await key(page, 'Equal');
    await expect(tip(page)).toContainText('Waypoint');
    await at();
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
