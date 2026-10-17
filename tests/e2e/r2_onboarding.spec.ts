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

  test('subtitles never collide with the title card, the radar, the objective or a prompt, at any common size', async ({ page }) => {
    await refusePointerLock(page);
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => (window as Api).__gta7.godMode(true));
    const text = 'Kai Navarro! Six years inside and not one postcard. You need money, I need cars. Bring me one, baby!';
    expect(text.length).toBe(100);
    type Box = { x: number; y: number; width: number; height: number };
    const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
    const line = (t: string) =>
      page.evaluate((s) => (window as Api).__gta7.sim.events.emit('subtitle', { speaker: 'Mama Lou', text: s, duration: 6 }), t);
    const SIZES = [
      [1920, 1080],
      [1366, 768],
      [1280, 720],
      [1024, 768],
      [1366, 560],
      [1024, 560],
      [1366, 400],
      [1024, 400],
      [740, 800],
      [721, 700],
      [700, 600],
    ] as const;
    // A mission starting: its title card and the first line, with the longest objective in the story.
    for (const [width, height] of SIZES) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.evaluate(() => {
        const ev = (window as Api).__gta7.sim.events;
        ev.emit('big', { text: 'THE BIG SCORE', sub: 'Dex Moreau', style: 'title', duration: 1 });
        ev.emit('objective', { text: 'Hold the bank entrance while the vault opens' });
      });
      await line(text);
      await page.waitForTimeout(450);
      const [radar, sub, obj, title, titleSub] = await Promise.all(['.radar', '.subtitle', '.objective', '.big .t', '.big .s'].map(box));
      expect(await page.locator('.big').getAttribute('class'), at).toContain('show');
      expect(sub.width, at).toBeGreaterThan(200);
      expect(overlap(sub, title) || overlap(sub, titleSub), `subtitle vs title card at ${at}`).toBe(false);
      expect(overlap(sub, radar), `subtitle vs radar at ${at}`).toBe(false);
      expect(overlap(obj, radar), `objective vs radar at ${at}`).toBe(false);
      expect(overlap(obj, sub), `objective vs subtitle at ${at}`).toBe(false);
      // Inside the window.
      expect(sub.x).toBeGreaterThanOrEqual(0);
      expect(sub.x + sub.width).toBeLessThanOrEqual(width);
      await page.waitForTimeout(800); // the title card goes
    }
    // A line up while standing on a marker (a mission failed at its contact before the intro was done):
    // the offer card, and a plain prompt, stay above it, all of their lines readable.
    for (const [marker, sel] of [
      [LOU_MARKER, '.prompt .card-start'],
      [GUN_MARKER, '.prompt'],
    ] as const) {
      await placeAt(page, marker);
      for (const [width, height] of SIZES) {
        const at = `${width}x${height}`;
        await page.setViewportSize({ width, height });
        await line(text);
        await page.waitForTimeout(300);
        const [radar, sub, prompt, key] = await Promise.all(['.radar', '.subtitle', '.prompt', sel].map(box));
        expect(overlap(prompt, sub), `${sel} vs subtitle at ${at}`).toBe(false);
        expect(overlap(key, sub), `${sel} line vs subtitle at ${at}`).toBe(false);
        expect(overlap(prompt, radar), `${sel} vs radar at ${at}`).toBe(false);
        expect(prompt.y, at).toBeGreaterThanOrEqual(0);
      }
      // The line gone, the prompt is back in its own place.
      await page.evaluate(() => (window as Api).__gta7.sim.events.emit('subtitle', { speaker: '', text: '', duration: 0 }));
      await page.waitForTimeout(500);
      const prompt = await box('.prompt');
      const own = sel === '.prompt' ? 160 : 150;
      expect(Math.round(SIZES[SIZES.length - 1]![1] - (prompt.y + prompt.height)), 'prompt back at its bottom').toBe(own);
    }
    expect(errors).toEqual([]);
  });

  test("MISSION PASSED shows no stale objective, then Lou's next job on her marker, without a 'Next' line or a route stub", async ({ page }) => {
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
    // Wheels hands over on Lou's marker: her next job's card says what comes next, the 'Next' line would only
    // repeat it, and a GPS route to where he stands would only run out to the junction and back.
    await expect(page.locator('.prompt.card')).toContainText('Hot Delivery', { timeout: 8000 });
    await page.waitForFunction(() => !document.querySelector('.big')!.classList.contains('show'), null, { timeout: 8000 });
    await page.waitForTimeout(1500);
    expect(await page.locator('.objective').getAttribute('class')).not.toContain('show');
    expect(await page.evaluate(() => (window as Api).__gta7.game.hud.route.length)).toBe(0);
    // Walking off, the route leads back to her.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const lou = g.poi('lou');
      g.place(lou.x + 40, lou.z);
    });
    await page.waitForFunction(() => (window as Api).__gta7.game.hud.route.length > 1, null, { timeout: 5000 });
    expect(await page.evaluate(() => (window as Api).__gta7.game.hud.routeColor)).toBe('#ff4fa3');
    expect(errors).toEqual([]);
  });
});
