import { expect, test, type Page } from '@playwright/test';

import { boot, fakePad, newGame, padTap, type Api } from './helpers';

// The horn and the headlight switch in the real game: holding H raises the horn's gain and sets the car's horn flag, and
// L (or B on a pad) in a car flips the lamps the player sees: at night the headlight spot and the head lens go dark and
// come back, by day the lenses and tail lamps light, and a toast says so.

/** A quiet street at `hour` with the clock stopped and the player at the wheel of a sedan, on the High tier (it has the spot). */
async function drive(page: Page, hour: number): Promise<void> {
  await page.evaluate((hour) => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(hour);
    g.sim.traffic.density = 0;
    g.sim.peds.density = 0;
    for (const v of [...g.sim.vehicles]) if (v.driver !== g.sim.player) g.sim.removeVehicle(v);
    g.spawnVehicle('sedan', true);
  }, hour);
  await page.waitForTimeout(600);
}

/** What the player's car shows: the sim's switch, the head and tail lenses' glow, the spot's intensity, the newest toast and the help box. */
const lamps = (page: Page) =>
  page.evaluate(() => {
    const g = (window as Api).__gta7;
    const r = g.game.renderer;
    const car = g.sim.player.vehicle;
    const view = r.vehicleViews.get(car.id);
    const glow = (role: string): number => Math.max(...view.lamps.filter((l: Api) => l.role === role).map((l: Api) => l.mat.emissiveIntensity as number));
    return {
      switch: car.lights as string,
      lit: view.lightsOn as boolean,
      head: glow('head'),
      tail: glow('tail'),
      spot: r.headlight.intensity as number,
      toast: (document.querySelector('[data-el="toast"]')?.textContent ?? '') as string,
      help: (document.querySelector('[data-el="help"]')?.textContent ?? '') as string,
    };
  });

/** One press of a key, long enough for a frame to see it. */
const tap = async (page: Page, key: string): Promise<void> => {
  await page.keyboard.down(key);
  await page.waitForTimeout(100);
  await page.keyboard.up(key);
  await page.waitForTimeout(400);
};

test.describe('the horn and the headlight switch', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem('gta7.settings.v1')) localStorage.setItem('gta7.settings.v1', JSON.stringify({ quality: 'high' }));
    });
  });

  test('holding H in an ordinary car raises the horn and lets go on release', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await drive(page, 12);
    const horn = () =>
      page.evaluate(() => {
        const g = (window as Api).__gta7;
        const nodes = g.game.audio.hornNodes;
        return { flag: g.sim.player.vehicle.horn as boolean, gain: nodes ? (nodes.gain.gain.value as number) : -1, audio: g.game.audio.ctx?.state as string | undefined };
      });
    const idle = await horn();
    expect(idle.flag).toBe(false);
    expect(idle.audio).toBe('running');
    expect(idle.gain).toBeLessThan(0.001);
    await page.keyboard.down('KeyH');
    await page.waitForTimeout(400);
    const held = await horn();
    expect(held.flag).toBe(true);
    // HORN_LEVEL (audio.ts) is 0.15.
    expect(held.gain).toBeGreaterThan(0.1);
    await page.keyboard.up('KeyH');
    await page.waitForTimeout(400);
    const released = await horn();
    expect(released.flag).toBe(false);
    expect(released.gain).toBeLessThan(0.01);
    expect(errors).toEqual([]);
  });

  test('at night L darkens the headlight spot and the head lens and the next press brings them back on auto, with a toast each time', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await drive(page, 23);
    // An instruction up in the help box (the welcome text, a fire warning): the notice must leave it alone.
    await page.evaluate(() => (window as Api).__gta7.sim.events.emit('message', { text: 'Probe instruction', duration: 30 }));
    await page.waitForTimeout(200);
    const auto = await lamps(page);
    expect(auto.switch).toBe('auto');
    expect(auto.help).toContain('Probe instruction');
    expect(auto.lit).toBe(true);
    expect(auto.spot).toBeGreaterThan(50);
    expect(auto.head).toBeGreaterThan(2);
    await tap(page, 'KeyL');
    const off = await lamps(page);
    expect(off.switch).toBe('off');
    expect(off.lit).toBe(false);
    expect(off.spot).toBe(0);
    expect(off.head).toBeLessThan(0.5);
    expect(off.toast).toBe('Headlights off');
    expect(off.help).toContain('Probe instruction');
    await tap(page, 'KeyL');
    const on = await lamps(page);
    // Lit again is what `auto` shows at night, so the car goes back to `auto`.
    expect(on.switch).toBe('auto');
    expect(on.lit).toBe(true);
    expect(on.spot).toBeCloseTo(auto.spot, 3);
    expect(on.head).toBeCloseTo(auto.head, 3);
    expect(on.toast).toBe('Headlights on');
    expect(on.help).toContain('Probe instruction');
    expect(errors).toEqual([]);
  });

  test('by day L lights the lenses and the tail lamps as running lights, and the next press puts them out on auto', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await drive(page, 12);
    const auto = await lamps(page);
    expect(auto.lit).toBe(false);
    expect(auto.tail).toBe(0);
    await tap(page, 'KeyL');
    const on = await lamps(page);
    expect(on.switch).toBe('on');
    expect(on.lit).toBe(true);
    expect(on.head).toBeGreaterThan(auto.head * 4);
    expect(on.tail).toBeGreaterThanOrEqual(1);
    expect(on.toast).toBe('Headlights on');
    await tap(page, 'KeyL');
    const off = await lamps(page);
    expect(off.switch).toBe('auto');
    expect(off.lit).toBe(false);
    expect(off.head).toBe(0);
    expect(off.tail).toBe(0);
    expect(off.toast).toBe('Headlights off');
    expect(errors).toEqual([]);
  });

  test('B on a gamepad flips the lamps in a car, and does nothing on foot', async ({ page }) => {
    await fakePad(page);
    const errors = await boot(page);
    await newGame(page);
    await drive(page, 23);
    await padTap(page, 1);
    await page.waitForTimeout(300);
    expect((await lamps(page)).switch).toBe('off');
    await padTap(page, 1);
    await page.waitForTimeout(300);
    expect((await lamps(page)).switch).toBe('auto');
    await padTap(page, 1);
    await page.waitForTimeout(300);
    expect((await lamps(page)).switch).toBe('off');
    // On foot B reloads: the car keeps its switch.
    await page.evaluate(() => (window as Api).__gta7.sim.playerCtl.ejectPlayer(false));
    await page.waitForTimeout(300);
    await padTap(page, 1);
    await page.waitForTimeout(300);
    const left = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      return { onFoot: g.sim.player.vehicle === null, lights: g.sim.vehicles.find((v: Api) => v.usedByPlayer)?.lights as string };
    });
    expect(left).toEqual({ onFoot: true, lights: 'off' });
    expect(errors).toEqual([]);
  });
});
