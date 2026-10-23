// Wave 1 weapons in the real game: number keys and the wheel draw them, a bat swing floors a man, the grenade arc and
// blast, a molotov fire, the sniper scope and its zoom, and a gamepad weapon cycle reaching them.

import { expect, test, type Page } from '@playwright/test';

import { boot, fakePad, newGame, padTap, type Api } from './helpers';

const combat = (page: Page) => page.evaluate(() => (window as Api).__gta7.ext.combat.state());

test('number keys, the wheel and the pad cycle draw the new weapons; a bat floors a man; grenade arc, blast and molotov fire; sniper scope zoom', async ({ page }) => {
  await fakePad(page);
  const errors = await boot(page);
  await newGame(page);
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    // Witnesses would phone the bat swing and the blasts in, and the police would come for him mid-test.
    g.sim.cheats.neverWanted = true;
    for (const w of ['bat', 'knife', 'grenade', 'molotov', 'sniper']) g.give(w, 6);
    g.sim.player.inventory.current = 'fists';
  });
  const weapon = async () => (await page.evaluate(() => (window as Api).__gta7.state().player.weapon)) as string;
  await page.mouse.move(640, 360);
  // Keys 7, 8 and 9; pressed again, 7 and 8 step to the other weapon of their slot.
  const drawn: string[] = [];
  for (const k of ['Digit7', 'Digit7', 'Digit8', 'Digit8', 'Digit9']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(150);
    drawn.push(await weapon());
  }
  expect(drawn).toEqual(['bat', 'knife', 'grenade', 'molotov', 'sniper']);
  // The wheel and the pad's RB step through every one of them.
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(180);
    seen.add(await weapon());
  }
  const padSeen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    await padTap(page, 5);
    padSeen.add(await weapon());
  }
  for (const w of ['bat', 'knife', 'grenade', 'molotov', 'sniper']) {
    expect(seen.has(w), `wheel reaches ${w}`).toBe(true);
    expect(padSeen.has(w), `pad reaches ${w}`).toBe(true);
  }

  // A bat swing on a pedestrian 1.5 m ahead knocks him down.
  await page.keyboard.press('Digit7');
  await page.waitForTimeout(100);
  if ((await weapon()) !== 'bat') await page.keyboard.press('Digit7');
  const ped = await page.evaluate(() => (window as Api).__gta7.spawnPedAhead(1.5));
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await expect.poll(() => page.evaluate((id) => (window as Api).__gta7.sim.characters.find((c: Api) => c.id === id)?.state, ped)).toBe('knocked');

  // Holding aim with a grenade shows the arc; thrown, it goes off about 3 s later and damages a car where it lands.
  await page.keyboard.press('Digit8');
  await page.waitForTimeout(100);
  if ((await weapon()) !== 'grenade') await page.keyboard.press('Digit8');
  await page.evaluate(() => (window as Api).__gta7.setCamera((window as Api).__gta7.game.renderer.cameraCtl.yaw, 0.12));
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(600);
  const aimed = await combat(page);
  expect(aimed.arcShown).toBe(true);
  const car = await page.evaluate((e) => (window as Api).__gta7.sim.spawnVehicle('sedan', e.x + 1.2, e.z, 0.4).id, aimed.arcEnd);
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const w = window as Api;
    w.__booms = [];
    w.__gta7.sim.events.on('explosion', () => w.__booms.push(w.__gta7.sim.time));
    w.__thrownAt = -1;
    w.__gta7.sim.events.on('thrown', () => (w.__thrownAt = w.__gta7.sim.time));
  });
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.mouse.up({ button: 'right' });
  await expect.poll(() => page.evaluate(() => (window as Api).__booms.length), { timeout: 8000 }).toBeGreaterThan(0);
  const fuse = await page.evaluate(() => (window as Api).__booms[0] - (window as Api).__thrownAt);
  expect(fuse).toBeGreaterThan(2.9);
  expect(fuse).toBeLessThan(3.1);
  const carState = await page.evaluate((id) => (window as Api).__gta7.ext.combat.vehicle(id), car);
  expect(carState.health).toBeLessThan(900);

  // A molotov fire spreads, then burns out.
  const at = await page.evaluate(() => (window as Api).__gta7.ext.combat.fireAt());
  expect(at).not.toBeNull();
  await page.waitForTimeout(3500);
  const burning = await combat(page);
  expect(burning.fires.length).toBeGreaterThan(0);
  expect(Math.max(...burning.fires.map((f: Api) => f.radius))).toBeGreaterThan(2.5);
  await expect.poll(async () => (await combat(page)).fires.length, { timeout: 16000 }).toBe(0);

  // The sniper scope narrows the view at least 3x and the wheel zooms it further; releasing aim restores the view.
  await page.keyboard.press('Digit9');
  await page.waitForTimeout(400);
  const before = (await combat(page)).fov;
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(500);
  const scoped = await combat(page);
  expect(scoped.scoped).toBe(true);
  expect(scoped.scopeOverlay).toBe(true);
  expect(before / scoped.fov).toBeGreaterThanOrEqual(3);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(700);
  const zoomed = await combat(page);
  expect(zoomed.scopeLevel).toBe(1);
  expect(zoomed.fov).toBeLessThan(scoped.fov * 0.7);
  expect(zoomed.weapon).toBe('sniper');
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(1200);
  const after = await combat(page);
  expect(after.scoped).toBe(false);
  expect(after.scopeOverlay).toBe(false);
  expect(after.fov).toBeGreaterThan(before - 2);
  expect(errors).toEqual([]);
});

test('the scope mask leaves when the map or the pause menu opens while scoped, and comes back only in play', async ({ page }) => {
  const errors = await boot(page);
  await newGame(page);
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    g.sim.cheats.neverWanted = true;
    g.give('sniper', 10);
  });
  await page.mouse.move(640, 360);
  await page.keyboard.press('Digit9');
  await page.waitForTimeout(300);
  const overlay = page.locator('[data-el=scope]');
  for (const key of ['KeyM', 'KeyP']) {
    await page.mouse.down({ button: 'right' });
    await expect(overlay).toBeVisible();
    await page.keyboard.press(key);
    await page.waitForFunction(() => (window as Api).__gta7.game.menus.open);
    await page.waitForTimeout(300);
    await expect(overlay).toBeHidden();
    expect((await combat(page)).scopeOverlay).toBe(false);
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(300);
    await expect(overlay).toBeHidden();
    await page.keyboard.press(key);
    await page.waitForFunction(() => !(window as Api).__gta7.game.menus.open);
    await page.waitForTimeout(300);
    await expect(overlay).toBeHidden();
  }
  expect(errors).toEqual([]);
});
