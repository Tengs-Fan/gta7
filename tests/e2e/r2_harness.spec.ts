import { expect, test } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

test.describe('GTA 7 harness: resilience and typed cheats', () => {
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

  test('where the clipboard is refused, the report shows in a dark box, scrolled to the error', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) }, configurable: true });
    });
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      for (let i = 0; i < 30; i++) g.sim.events.emit('message', { text: `Event ${i} before the crash.`, duration: 1 });
      g.game.hud.update = () => {
        throw new Error('hud exploded');
      };
    });
    await expect(page.locator('.error h2')).toHaveText('SOMETHING BROKE');
    await page.getByRole('button', { name: 'COPY DETAILS' }).click();
    const area = page.locator('.error textarea');
    await expect(area).toBeVisible();
    await expect(area).toHaveClass('crash-report');
    await page.waitForTimeout(200);
    const look = await area.evaluate((el: HTMLTextAreaElement) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color, radius: s.borderTopLeftRadius, scrollTop: el.scrollTop, overflows: el.scrollHeight > el.clientHeight, selected: el.selectionEnd - el.selectionStart };
    });
    expect(look.bg).toBe('rgba(10, 14, 24, 0.9)');
    expect(look.color).toBe('rgb(230, 233, 239)');
    expect(look.radius).toBe('8px');
    // A long report, selected to copy, with its first line (the error) in view.
    expect(look.overflows).toBe(true);
    expect(look.scrollTop).toBe(0);
    expect(look.selected).toBeGreaterThan(500);
    expect(await area.inputValue()).toContain('hud exploded');
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

    // Count the cheat's own car: ambient traffic and parked cars stream sports cars in and out meanwhile.
    const ids = await read(() => (window as Api).__gta7.sim.vehicles.map((v: Api) => v.id));
    await typeCode('SPAWNSPORTS'); // its P pauses
    const spawned = await page.evaluate((old: number[]) => {
      const g = (window as Api).__gta7;
      const p = g.sim.player.pos;
      return g.sim.vehicles.filter((v: Api) => !old.includes(v.id) && !v.removed && v.kind === 'sports' && v.owner === 'none' && Math.hypot(v.pos.x - p.x, v.pos.z - p.z) < 25).length;
    }, ids);
    expect(spawned).toBe(1);

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
