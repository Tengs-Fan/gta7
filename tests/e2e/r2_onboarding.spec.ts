import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

/** Headless Chromium that grants pointer lock can stop delivering frames, so these tests refuse it. */
async function refusePointerLock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = function () {
      throw new DOMException('pointer lock disabled under automation', 'NotSupportedError');
    };
  });
}

/** Stands the player on a marker. */
async function placeAt(page: Page, find: string): Promise<void> {
  await page.evaluate((src) => {
    const g = (window as Api).__gta7;
    const m = new Function('g', `return (${src})(g)`)(g);
    g.place(m.x, m.z);
  }, find);
  await page.waitForTimeout(300);
}

const LOU_MARKER = "(g) => g.sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === 'wheels')";
const GUN_MARKER = "(g) => g.sim.interactions.markers.find((m) => m.kind === 'gunshop')";

test.describe('GTA 7 onboarding', () => {
  test('New Game from / gets the phone call: Wheels starts and Mama Lou sets the first objective', async ({ page }) => {
    await refusePointerLock(page);
    const errors = await boot(page, '/');
    const t0 = Date.now();
    await newGame(page);
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === 'wheels', null, { timeout: Math.max(1000, 5000 - (Date.now() - t0)) });
    await expect(page.locator('.subtitle')).toContainText('Mama Lou', { timeout: Math.max(1000, 8000 - (Date.now() - t0)) });
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Steal a car', null, { timeout: Math.max(1000, 20_000 - (Date.now() - t0)) });
    await expect(page.locator('.objective')).toContainText('Steal a car');
    expect(errors).toEqual([]);
  });

  test('with ?intro=0 nothing starts: the pink route and the next-step line lead to Lou instead', async ({ page }) => {
    await refusePointerLock(page);
    const errors = await boot(page);
    await newGame(page);
    await expect(page.locator('.objective.next')).toContainText('Next: Mama Lou has work - L on your radar');
    await expect(page.locator('.help')).toContainText('pink route');
    const hud = await page.evaluate(() => {
      const h = (window as Api).__gta7.game.hud;
      return { waypoint: h.waypoint, color: h.routeColor, route: h.route.length };
    });
    expect(hud).toEqual({ waypoint: null, color: '#ff4fa3', route: expect.any(Number) });
    expect(hud.route).toBeGreaterThan(2);
    await page.waitForTimeout(10_000);
    expect((await state(page)).mission).toBe(null);
    expect(errors).toEqual([]);
  });

  test("the mission offer card at Lou's marker, the plain label at the gun shop", async ({ page }) => {
    await refusePointerLock(page);
    const errors = await boot(page);
    await newGame(page);
    await placeAt(page, LOU_MARKER);
    const prompt = page.locator('.prompt');
    await expect(prompt).toHaveClass(/card/);
    for (const text of ['Wheels', 'Mama Lou needs a car', '$500', 'Mama Lou']) await expect(prompt).toContainText(text);
    await expect(prompt.locator('kbd')).toHaveText('E');
    await placeAt(page, GUN_MARKER);
    await expect(prompt).toContainText('Bang Bang');
    await expect(prompt).not.toHaveClass(/card/);
    expect(errors).toEqual([]);
  });

  test('on a gamepad the prompts show pad buttons, not keyboard keys', async ({ page }) => {
    await refusePointerLock(page);
    await page.addInitScript(() => {
      const pad = {
        id: 'Test Pad (STANDARD GAMEPAD)',
        index: 0,
        connected: true,
        mapping: 'standard',
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      };
      (window as Api).__pad = pad;
      Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
    });
    const errors = await boot(page);
    await newGame(page);
    // A tap on LB (no weapon to switch to) makes the pad the active device.
    await page.evaluate(() => ((window as Api).__pad.buttons[4].pressed = true));
    await page.waitForTimeout(150);
    await page.evaluate(() => ((window as Api).__pad.buttons[4].pressed = false));
    await page.waitForFunction(() => (window as Api).__gta7.game.hud.device === 'pad');
    await expect(page.locator('.help kbd.pad-y')).toHaveText('Y');
    await placeAt(page, LOU_MARKER);
    const prompt = page.locator('.prompt');
    await expect(prompt).toContainText('Wheels');
    await expect(prompt.locator('kbd.dpad')).toHaveCount(1);
    expect(await prompt.locator('kbd').allTextContents()).not.toContain('E');
    // Next to a car: the steal prompt names Y.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.spawnVehicle('sedan', false);
      const v = g.sim.vehicles[g.sim.vehicles.length - 1];
      g.place(v.pos.x + Math.cos(v.heading) * 2.3, v.pos.z - Math.sin(v.heading) * 2.3);
    });
    await expect(prompt).toContainText('to steal the Velora');
    await expect(prompt.locator('kbd.pad-y')).toHaveText('Y');
    expect(errors).toEqual([]);
  });

  test('subtitles and objectives clear the radar at common screen sizes', async ({ page }) => {
    await refusePointerLock(page);
    const errors = await boot(page);
    await newGame(page);
    const text = 'Kai Navarro! Six years inside and not one postcard. You need money, I need cars. Bring me one, baby!';
    expect(text.length).toBe(100);
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const [width, height] of [
      [1024, 768],
      [1280, 720],
      [1366, 768],
      [1024, 560],
      [700, 600],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((t) => {
        const ev = (window as Api).__gta7.sim.events;
        ev.emit('subtitle', { speaker: 'Mama Lou', text: t, duration: 6 });
        // The longest objective in the story.
        ev.emit('objective', { text: 'Hold the bank entrance while the vault opens' });
      }, text);
      await page.waitForTimeout(450);
      const radar = (await page.locator('.radar').boundingBox())!;
      const sub = (await page.locator('.subtitle').boundingBox())!;
      const obj = (await page.locator('.objective').boundingBox())!;
      expect(sub.width, `${width}x${height}`).toBeGreaterThan(200);
      expect(overlap(sub, radar), `subtitle vs radar at ${width}x${height}`).toBe(false);
      if (width >= 720) {
        expect(overlap(obj, radar), `objective vs radar at ${width}x${height}`).toBe(false);
        expect(overlap(obj, sub), `objective vs subtitle at ${width}x${height}`).toBe(false);
      }
      // Inside the window.
      expect(sub.x).toBeGreaterThanOrEqual(0);
      expect(sub.x + sub.width).toBeLessThanOrEqual(width);
    }
    expect(errors).toEqual([]);
  });

  test('MISSION PASSED shows no stale objective, then the next step', async ({ page }) => {
    await refusePointerLock(page);
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.startMission('wheels');
    });
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Steal a car', null, { timeout: 25_000 });
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.spawnVehicle('compact', true);
      g.godMode(true);
    });
    await page.waitForFunction(() => String((window as Api).__gta7.state().objective).startsWith('Drive'), null, { timeout: 5000 });
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const bay = g.sim.world.layout.pois.find((p: Api) => p.id === 'lou').bay;
      g.place((bay.minX + bay.maxX) / 2, (bay.minZ + bay.maxZ) / 2);
    });
    await expect(page.locator('.big')).toContainText('MISSION PASSED', { timeout: 20_000 });
    await expect(page.locator('.objective')).not.toHaveClass(/show/);
    await expect(page.locator('.objective.next.show')).toContainText('Next: Mama Lou has work', { timeout: 8000 });
    expect(errors).toEqual([]);
  });
});
