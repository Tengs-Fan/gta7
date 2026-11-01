import { expect, test, type Page } from '@playwright/test';

import { boot, fakePad, newGame, padTap, type Api } from './helpers';

// The horn and the headlight switch in the real game: holding H raises the horn's gain and sets the car's horn flag, and
// L (or B on a pad) in a car flips the lamps the player sees: at night the headlight spot and the head lens go dark and
// come back, by day the lenses and tail lamps light, and a toast says so. And at night the headlights light the road
// ahead of the car from the chase camera, on a dark county road and under a street lamp alike, read back from the
// canvas with the lamps off and on.

/** A quiet street at `hour` with the clock stopped and the player at the wheel of a sedan, on the High tier (it has the spot); `at` moves the player first. */
async function drive(page: Page, hour: number, at?: [number, number]): Promise<void> {
  await page.evaluate(([hour, at]) => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(hour);
    g.sim.traffic.density = 0;
    g.sim.peds.density = 0;
    if (at) g.teleport(at[0], at[1]);
    for (const v of [...g.sim.vehicles]) if (v.driver !== g.sim.player) g.sim.removeVehicle(v);
    g.spawnVehicle('sedan', true);
    g.game.renderer.cameraCtl.reset(g.sim);
  }, [hour, at] as const);
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

/** Mean sRGB luma (0..255) of a 7x5 box of the canvas on the ground `d` m ahead of the bumper and `side` m to its left, with the lamps set to `lights`. */
const luma = (page: Page, lights: string, points: Array<[number, number]>) =>
  page.evaluate(
    ([lights, points]) => {
      const g = (window as Api).__gta7;
      const r = g.game.renderer;
      const car = g.sim.player.vehicle;
      car.lights = lights;
      for (let i = 0; i < 4; i++) r.render(1 / 60, false);
      const gl = r.renderer.getContext();
      const cam = r.cameraCtl.camera;
      cam.updateMatrixWorld();
      const view = cam.matrixWorldInverse.elements;
      const proj = cam.projectionMatrix.elements;
      const mul = (m: number[], x: number, y: number, z: number): number[] => [0, 1, 2, 3].map((i) => m[i]! * x + m[4 + i]! * y + m[8 + i]! * z + m[12 + i]!);
      const fx = Math.sin(car.heading);
      const fz = Math.cos(car.heading);
      const px = new Uint8Array(4 * 7 * 5);
      return (points as Array<[number, number]>).map(([d, side]) => {
        const x = car.pos.x + fx * (car.halfL + d) + fz * side;
        const z = car.pos.z + fz * (car.halfL + d) - fx * side;
        const v = mul(view, x, g.sim.world.groundHeight(x, z) + 0.02, z);
        const c = mul(proj, v[0]!, v[1]!, v[2]!);
        const sx = Math.round(((c[0]! / c[3]!) * 0.5 + 0.5) * gl.drawingBufferWidth);
        const sy = Math.round(((c[1]! / c[3]!) * 0.5 + 0.5) * gl.drawingBufferHeight);
        gl.readPixels(sx - 3, sy - 2, 7, 5, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let l = 0;
        for (let i = 0; i < 35; i++) l += 0.2126 * px[i * 4]! + 0.7152 * px[i * 4 + 1]! + 0.0722 * px[i * 4 + 2]!;
        return l / 35;
      });
    },
    [lights, points] as const,
  );

/** Sets the player's car down in a county crop field, facing `heading`, the chase camera behind it, and lets the plants come in. */
async function inField(page: Page, at: [number, number], heading: number): Promise<void> {
  await drive(page, 22.18, at);
  await page.evaluate(([at, heading]) => {
    const g = (window as Api).__gta7;
    g.place(at[0], at[1], heading);
    g.game.renderer.cameraCtl.reset(g.sim);
  }, [at, heading] as const);
  await page.waitForTimeout(1500);
}

/** The lit field above the car as the canvas shows it (a box of x 0.3 to 0.7 and y 0.38 to 0.52 from the top: beyond the roof, below the horizon), with the lamps set to `lights`: mean and brightest sRGB luma, and the share over 200. */
const patch = (page: Page, lights: string) =>
  page.evaluate((lights) => {
    const g = (window as Api).__gta7;
    const r = g.game.renderer;
    g.sim.player.vehicle.lights = lights;
    for (let i = 0; i < 4; i++) r.render(1 / 60, false);
    const gl = r.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const x0 = Math.round(w * 0.3);
    const y0 = Math.round(h * 0.48);
    const bw = Math.round(w * 0.4);
    const bh = Math.round(h * 0.14);
    const px = new Uint8Array(4 * bw * bh);
    gl.readPixels(x0, y0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0;
    let max = 0;
    let over = 0;
    for (let i = 0; i < bw * bh; i++) {
      const l = 0.2126 * px[i * 4]! + 0.7152 * px[i * 4 + 1]! + 0.0722 * px[i * 4 + 2]!;
      sum += l;
      max = Math.max(max, l);
      if (l > 200) over++;
    }
    return { mean: sum / (bw * bh), max, over: over / (bw * bh) };
  }, lights);

/** The lit field's mean luma in the box `patch` reads, every frame while the player's car drives at `speed` m/s for `secs` s through the field it stands in. */
const cruise = (page: Page, speed: number, secs: number) =>
  page.evaluate(
    async ([speed, secs]) => {
      const g = (window as Api).__gta7;
      const r = g.game.renderer;
      const car = g.sim.player.vehicle;
      car.lights = 'auto';
      const gl = r.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const x0 = Math.round(w * 0.3);
      const y0 = Math.round(h * 0.48);
      const bw = Math.round(w * 0.4);
      const bh = Math.round(h * 0.14);
      const px = new Uint8Array(4 * bw * bh);
      const render = r.render.bind(r);
      const means: number[] = [];
      r.render = (dt: number, aim: boolean) => {
        car.vel.x = Math.sin(car.heading) * speed;
        car.vel.z = Math.cos(car.heading) * speed;
        const res = render(dt, aim);
        gl.readPixels(x0, y0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let i = 0; i < bw * bh; i++) sum += 0.2126 * px[i * 4]! + 0.7152 * px[i * 4 + 1]! + 0.0722 * px[i * 4 + 2]!;
        means.push(sum / (bw * bh));
        return res;
      };
      await new Promise((done) => setTimeout(done, (secs as number) * 1000));
      r.render = render;
      return means;
    },
    [speed, secs] as const,
  );

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
    // Back to what it was before the first press: the faint daytime glow of a driven car on `auto`, no tail lamp.
    expect(off.head).toBeCloseTo(auto.head, 3);
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

  test('at night the headlights light the road ahead from the chase camera, brightest well out, still lit at 35 m and gone past the end of the beam, and add the same light under a street lamp, short of white', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    // A straight stretch of county road, running south, with no lamps of its own.
    await drive(page, 23, [-842.2, 126]);
    const points: Array<[number, number]> = [[7, 0], [13, 0], [20, 0], [35, 0], [45, 0], [55, 0], [10, 0], [10, 1.5], [10, -1.5]];
    const off = await luma(page, 'off', points);
    const on = await luma(page, 'auto', points);
    const gain = on.map((l, i) => l - off[i]!);
    // The lit road ahead of the car is clearly brighter, brightest well out (13 to 25 m, where the two lamps' lobes have merged
    // and the beam has not yet fallen away) and not in a patch by the bumper...
    expect(gain[0]!).toBeGreaterThan(25);
    expect(gain[6]!).toBeGreaterThan(30);
    expect(gain[1]!).toBeGreaterThan(40);
    expect(gain[2]!).toBeGreaterThan(30);
    expect(gain[1]!).toBeGreaterThan(gain[0]!);
    // ...a long beam: still lit at 35 m, fainter by 45 m, and nothing at 55 m, past its end 50 m out; the sides are softer than the middle.
    expect(gain[3]!).toBeGreaterThan(10);
    expect(gain[3]!).toBeLessThan(gain[2]!);
    expect(gain[4]!).toBeLessThan(gain[3]!);
    expect(Math.abs(gain[5]!)).toBeLessThan(1.5);
    expect(gain[7]!).toBeLessThan(gain[6]!);
    expect(gain[8]!).toBeLessThan(gain[6]!);
    // Downtown, 5 and 7 m ahead lie in a street lamp's light. The headlights are a light of their own, not a multiple of
    // the lamp's: they add about what they add to the dark county road (a multiplied pool added twice that there, and
    // took the road to near white, luma 223 and 204), and the lit road stays well short of white.
    const n = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      // Out of the county car, which drive() then clears away with the rest.
      g.sim.playerCtl.ejectPlayer(true);
      const r = g.sim.roads.node(5, 5);
      return [r.x + r.halfX + 2.2, r.z + r.halfZ + 40] as [number, number];
    });
    await drive(page, 23, n);
    const lamp: Array<[number, number]> = [[5, 0], [7, 0]];
    const lampOff = await luma(page, 'off', lamp);
    const lampOn = await luma(page, 'auto', lamp);
    expect(lampOff[0]!).toBeGreaterThan(60);
    expect(lampOff[1]!).toBeGreaterThan(40);
    expect(lampOn[1]! - lampOff[1]!).toBeGreaterThan(25);
    expect(lampOn[1]! - lampOff[1]!).toBeLessThan(1.4 * gain[0]!);
    expect(lampOn[0]!).toBeLessThan(180);
    expect(lampOn[1]!).toBeLessThan(170);
    expect(errors).toEqual([]);
  });

  test('at night in a crop field the headlights light the soil and the plants as they light a road, and nothing shines: the palest, the wheat, reads about as bright as lit pavement', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    // The county road is the measure: the same points ahead of the car, lamps off and on.
    const points: Array<[number, number]> = [[10, 0], [15, 0], [20, 0]];
    await drive(page, 22.18, [-842.2, 126]);
    const roadOff = await luma(page, 'off', points);
    const roadOn = await luma(page, 'auto', points);
    const road = roadOn.map((l, i) => l - roadOff[i]!);
    expect(Math.min(...road)).toBeGreaterThan(25);
    // Halfmoon Acres' wheat (straw, ten times the asphalt's albedo, with the plants over it) and its sunflowers over bare soil, driven north.
    for (const [name, at] of [['wheat', [-1086, 120]], ['sunflowers', [-987, 120]]] as const) {
      await inField(page, [at[0], at[1]], 0);
      const off = await luma(page, 'off', points);
      const on = await luma(page, 'auto', points);
      const gain = on.map((l, i) => l - off[i]!);
      // Lit as the road is: clearly brighter than with the lamps off at 10 to 20 m, a good way short of white, and
      // (the wheat, whose straw is the palest) no more than 2.2 times the road's gain (1.9 now; the road's own rule gave 3.7).
      expect(Math.min(...gain), name).toBeGreaterThan(20);
      expect(Math.max(...on), name).toBeLessThan(170);
      if (name === 'wheat') expect(Math.max(...gain), name).toBeLessThan(2.2 * Math.max(...road));
      // No plant or patch of ground shines: nothing in the beam's field reaches white, where the player's spot took the plants in front of the bumper to 255.
      const lit = await patch(page, 'auto');
      expect(lit.max, name).toBeLessThan(200);
      expect(lit.over, name).toBe(0);
    }
    // Driving through the wheat the lit field holds steady frame to frame: the tufts crossing the player's spot made it flash, up to
    // 9 luma between frames (1.7 on average), where now the patch moves by under half a luma.
    await inField(page, [-1086, 92], 0);
    const means = await cruise(page, 12, 3);
    const jumps = means.slice(1).map((m, i) => Math.abs(m - means[i]!));
    expect(means.length).toBeGreaterThan(60);
    expect(Math.max(...jumps)).toBeLessThan(3);
    expect(errors).toEqual([]);
  });
});
