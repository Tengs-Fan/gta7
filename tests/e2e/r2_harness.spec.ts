import { expect, test } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

test.describe('GTA 7 harness: resilience and typed cheats', () => {
  test('a throwing sim listener is logged and counted, and the game plays on', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.give('pistol', 60);
      g.sim.events.on('shot', () => {
        throw new Error('test listener');
      });
    });
    await page.waitForTimeout(400); // the pistol's draw time
    // Pointer lock is refused under automation, so the first click already shoots.
    await page.mouse.click(640, 360);
    await page.waitForFunction(() => (window as Api).__gta7.state().listenerErrors >= 1, null, { timeout: 5000 });
    expect(await page.evaluate(() => (window as Api).__gta7.sim.progress.stats.shotsFired)).toBe(1);
    const f0 = (await state(page)).frames;
    await page.waitForTimeout(500);
    const s = await state(page);
    expect(s.crashed).toBe(false);
    expect(s.frames).toBeGreaterThan(f0 + 5);
    expect(errors.filter((e) => /GTA7 listener error/.test(e))).toHaveLength(1);
    expect(errors.filter((e) => !/GTA7 listener error/.test(e))).toEqual([]);
  });

  test('errors outside the frame loop are logged and kept for the crash report, and the game plays on', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('stray handler');
      }, 0);
      void Promise.reject(new Error('stray promise'));
    });
    await page.waitForTimeout(500);
    const s = await state(page);
    expect(s.crashed).toBe(false);
    const report: string = await page.evaluate(() => (window as Api).__gta7.game.crashReport(new Error('probe')));
    expect(report).toContain('error Uncaught Error: stray handler');
    expect(report).toContain('rejection stray promise');
    const ours = /GTA7 uncaught error|GTA7 unhandled rejection|stray handler|stray promise/;
    expect(errors.filter((e) => ours.test(e)).length).toBeGreaterThanOrEqual(2);
    expect(errors.filter((e) => !ours.test(e))).toEqual([]);
  });

  test('a crash shows the error screen, and COPY DETAILS copies a report', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.sim.events.emit('message', { text: 'Before the crash.', duration: 1 });
      g.game.hud.update = () => {
        throw new Error('hud exploded');
      };
    });
    await expect(page.locator('.error h2')).toHaveText('SOMETHING BROKE');
    expect((await state(page)).crashed).toBe(true);
    await expect(page.getByRole('button', { name: 'RELOAD' })).toBeVisible();
    // The report box only appears where the clipboard is refused.
    await expect(page.locator('.error textarea')).toBeHidden();
    await page.getByRole('button', { name: 'COPY DETAILS' }).click();
    await expect(page.getByRole('button', { name: 'COPIED' })).toBeVisible();
    const report = await page.evaluate(() => navigator.clipboard.readText());
    expect(report).toContain('hud exploded');
    expect(report).toContain('mode: game');
    expect(report).toMatch(/sim time: \d+\.\d\d s/);
    expect(report).toContain('mission: none');
    expect(report).toMatch(/zone: \S/);
    expect(report).toMatch(/player: normal, health 100/);
    expect(report).toMatch(/quality: \w+/);
    expect(report).toContain('message Before the crash.');
    expect(errors.filter((e) => !/GTA7 crashed/.test(e))).toEqual([]);
  });

  test('all nine cheat codes work when typed, and leave no menu open', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await boot(page);
    await newGame(page);
    const read = <T>(fn: () => T) => page.evaluate(fn);
    const typeCode = async (code: string) => {
      await page.keyboard.type(code.toLowerCase(), { delay: 130 });
      await page.waitForTimeout(500);
      expect((await state(page)).menuOpen, `a menu is open after ${code}`).toBe(false);
    };

    expect(await read(() => (window as Api).__gta7.sim.cheats.godMode)).toBe(false);
    await typeCode('IMMORTAL'); // its M opens the map
    expect(await read(() => (window as Api).__gta7.sim.cheats.godMode)).toBe(true);

    const money = (await state(page)).money;
    await typeCode('MONEYTREE'); // its M opens the map
    expect((await state(page)).money).toBe(money + 50000);

    await typeCode('GUNSGALORE');
    expect(await read(() => ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'].every((w) => (window as Api).__gta7.sim.player.inventory.has(w)))).toBe(true);

    await typeCode('SUNSET');
    expect((await state(page)).hours).toBeCloseTo(18.3, 1);
    await typeCode('NIGHTOWL');
    expect((await state(page)).hours).toBeCloseTo(23, 1);

    const sports = () => read(() => (window as Api).__gta7.sim.vehicles.filter((v: Api) => v.kind === 'sports' && !v.removed).length);
    const before = await sports();
    await typeCode('SPAWNSPORTS'); // its P pauses
    expect(await sports()).toBe(before + 1);

    // In a damaged car: its F gets the player out, the cheat puts him back and repairs the car.
    const carId = await read(() => {
      const g = (window as Api).__gta7;
      const id = g.spawnVehicle('sedan', true);
      g.sim.player.vehicle.health = 250;
      return id;
    });
    await typeCode('FIXMYRIDE');
    const car = await read(() => {
      const v = (window as Api).__gta7.sim.player.vehicle;
      return v ? { id: v.id, repaired: v.health === v.spec.health } : null;
    });
    expect(car).toEqual({ id: carId, repaired: true });

    await typeCode('COPMAGNET'); // its P is swallowed: no pause
    expect((await state(page)).wanted).toBe(2);
    await typeCode('CHILLOUT');
    expect((await state(page)).wanted).toBe(0);

    expect((await state(page)).crashed).toBe(false);
    expect(errors).toEqual([]);
  });
});
