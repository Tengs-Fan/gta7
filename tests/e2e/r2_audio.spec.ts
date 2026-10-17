import { expect, test, type Page } from '@playwright/test';

import { boot, newGame, type Api } from './helpers';

/**
 * Installs an in-page meter on the analyser tap at the end of the master chain (after the soft clip) and on a second
 * tap on the limiter's output, which is what the soft clip is fed: the clip's curve ends at 0.93, so the final output
 * can never read above that whatever reaches the clip, and only the tap before it shows what the limiter lets through.
 * It polls on its own timer, so it keeps measuring while the game is paused (the frame loop then skips audio).
 */
async function installMeter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Api;
    const mixer = w.__gta7.game.audio.mixer;
    const an = mixer.analyser as AnalyserNode;
    const pre = (mixer.limiter as AudioNode).context.createAnalyser();
    pre.fftSize = 8192;
    mixer.limiter.connect(pre);
    const buf = new Float32Array(an.fftSize);
    const pbuf = new Float32Array(pre.fftSize);
    w.__meter = {
      start() {
        this.peak = 0;
        this.prePeak = 0;
        this.preN = 0;
        this.overKnee = 0;
        this.ss = 0;
        this.n = 0;
        clearInterval(this.iv);
        this.iv = setInterval(() => this.sample(), 40);
      },
      sample() {
        an.getFloatTimeDomainData(buf);
        pre.getFloatTimeDomainData(pbuf);
        let ss = 0;
        // Peak over the whole window (170 ms, overlapping the next poll); RMS over the last 2048 samples.
        for (let i = 0; i < buf.length; i++) this.peak = Math.max(this.peak, Math.abs(buf[i]!));
        for (let i = buf.length - 2048; i < buf.length; i++) ss += buf[i]! * buf[i]!;
        // Before the clip: the peak, and how many samples go past the clip's 0.7 knee (counted over the polled windows).
        for (let i = 0; i < pbuf.length; i++) {
          const a = Math.abs(pbuf[i]!);
          this.prePeak = Math.max(this.prePeak, a);
          if (a > 0.7) this.overKnee++;
        }
        this.preN += pbuf.length;
        this.ss += ss / 2048;
        this.n++;
      },
      stop() {
        clearInterval(this.iv);
        return {
          peak: this.peak as number,
          prePeak: this.prePeak as number,
          overKnee: (this.overKnee as number) / Math.max(1, this.preN as number),
          rmsDb: 10 * Math.log10((this.ss as number) / Math.max(1, this.n as number) + 1e-15),
          polls: this.n as number,
        };
      },
      /** RMS of the newest 2048 samples (about 43 ms). */
      now() {
        an.getFloatTimeDomainData(buf);
        let ss = 0;
        for (let i = buf.length - 2048; i < buf.length; i++) ss += buf[i]! * buf[i]!;
        return 10 * Math.log10(ss / 2048 + 1e-15);
      },
    };
  });
}

type Meter = { peak: number; prePeak: number; overKnee: number; rmsDb: number; polls: number };
const meterStart = (page: Page) => page.evaluate(() => (window as Api).__meter.start());
const meterStop = (page: Page) => page.evaluate(() => (window as Api).__meter.stop() as Meter);

/**
 * Plays a 220 Hz tone `amp` times full scale into the master sum (faded in over 80 ms, held 0.7 s) with the world
 * muted, and meters it. `limiter: false` turns the limiter off for the tone (threshold 0 dB, ratio 1) and back on after.
 */
async function hotTone(page: Page, amp: number, limiter: boolean): Promise<Meter> {
  await meterStart(page);
  await page.evaluate(
    ({ amp, limiter }) =>
      new Promise<void>((resolve) => {
        const audio = (window as Api).__gta7.game.audio;
        const m = audio.mixer;
        const ctx = audio.ctx as AudioContext;
        const lim = m.limiter as DynamicsCompressorNode;
        const saved = [lim.threshold.value, lim.ratio.value];
        if (!limiter) {
          lim.threshold.value = 0;
          lim.ratio.value = 1;
        }
        audio.setPaused(true);
        const o = ctx.createOscillator();
        o.frequency.value = 220;
        const g = ctx.createGain();
        const t0 = ctx.currentTime + 0.02;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(amp, t0 + 0.08);
        g.gain.setValueAtTime(amp, t0 + 0.7);
        g.gain.linearRampToValueAtTime(0, t0 + 0.75);
        o.connect(g);
        g.connect(m.preMaster);
        o.start(t0);
        o.stop(t0 + 0.8);
        setTimeout(() => {
          g.disconnect();
          lim.threshold.value = saved[0]!;
          lim.ratio.value = saved[1]!;
          audio.setPaused(false);
          resolve();
        }, 1000);
      }),
    { amp, limiter },
  );
  return meterStop(page);
}

test.describe('GTA 7 audio mix', () => {
  test('the master output stays inside full scale: headroom at default volumes, and the limiter holds a hot mix under full scale', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await installMeter(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.give('shotgun', 30);
      // Mouse look off: headless Chromium reports bogus movement with synthetic clicks.
      g.game.renderer.cameraCtl.sensitivity = 0;
    });
    // Let the shotgun be drawn before pulling the trigger.
    await page.waitForTimeout(1200);
    const shots0 = await page.evaluate(() => (window as Api).__gta7.game.audio.counters.gunshots);
    const shots = () => page.evaluate(() => (window as Api).__gta7.game.audio.counters.gunshots as number);
    await meterStart(page);
    // Real trigger pulls, a second apart (a click that only recaptures the mouse does not fire).
    for (let i = 0; i < 8 && (await shots()) - shots0 < 3; i++) {
      await page.mouse.click(640, 360);
      await page.waitForTimeout(1000);
    }
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const p = g.sim.player;
      const v = g.sim.spawnVehicle('sedan', p.pos.x + 5, p.pos.z + 3, 0);
      g.sim.combat.explodeVehicle(v);
    });
    await page.waitForTimeout(2000);
    const m = await meterStop(page);
    // Nine pellets per pull, one gunshot per pull.
    expect((await shots()) - shots0).toBe(3);
    expect(m.polls).toBeGreaterThan(40);
    expect(m.peak).toBeGreaterThan(0.1);
    // At the default volumes the mix leaves headroom before the clip: it is not leaning on the limiter or the soft clip.
    expect(m.prePeak).toBeLessThanOrEqual(0.8);
    expect(m.overKnee).toBeLessThan(0.001);
    // Sanity: the final output.
    expect(m.peak).toBeLessThanOrEqual(1);

    // A mix far too hot (a tone 6 times full scale into the master sum): the limiter keeps what reaches the clip inside
    // full scale. The tap must carry the master signal (it reads the tone), or the check would pass on silence.
    const held = await hotTone(page, 6, true);
    expect(held.prePeak).toBeGreaterThan(0.5);
    expect(held.prePeak).toBeLessThanOrEqual(1);
    expect(held.peak).toBeLessThanOrEqual(1);
    // The same tone with the limiter off goes over full scale before the clip: without the limiter this test fails.
    const open = await hotTone(page, 6, false);
    expect(open.prePeak).toBeGreaterThan(1.05);
    expect(errors).toEqual([]);
  });

  test('the ambience bed sits between -45 and -28 dBFS on foot by day, at the beach and at night, and pausing silences it', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await installMeter(page);
    await page.evaluate(() => (window as Api).__gta7.godMode(true));
    const places: Array<{ name: string; hours: number; at: string }> = [
      { name: 'downtown at noon', hours: 12, at: 'downtown' },
      { name: 'the beach at sunset', hours: 18.6, at: 'beach' },
      { name: 'a park at night', hours: 23, at: 'park' },
    ];
    for (const place of places) {
      const district = await page.evaluate(({ hours, at }) => {
        const g = (window as Api).__gta7;
        const w = g.sim.world;
        g.setTime(hours);
        if (at === 'beach') g.teleport(w.bounds.beachStartX + 20, 30);
        else {
          const b = at === 'park' ? w.layout.blocks.find((q: Api) => q.bi === 7 && q.bj === 5) : w.layout.blocks.find((q: Api) => q.bi === 4 && q.bj === 4);
          if (at === 'park') g.teleport((b.rect.minX + b.rect.maxX) / 2 + 12, (b.rect.minZ + b.rect.maxZ) / 2 + 12);
          else g.teleport(b.rect.minX + 2.2, (b.rect.minZ + b.rect.maxZ) / 2);
        }
        const p = g.sim.playerPos();
        return w.districtAt(p.x, p.z);
      }, place);
      expect(district, place.name).toBe(place.at);
      // The layers glide to the new place over 1-2 s; dialogue would duck the bed, so measure between lines.
      await page.waitForTimeout(3000);
      await expect(page.locator('.subtitle')).not.toHaveClass(/show/, { timeout: 20_000 });
      await meterStart(page);
      await page.waitForTimeout(5000);
      const m = await meterStop(page);
      expect(m.rmsDb, place.name).toBeGreaterThan(-45);
      expect(m.rmsDb, place.name).toBeLessThan(-28);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as Api).__gta7.state().menuOpen === true, null, { timeout: 5000 });
    await page.waitForTimeout(300);
    const paused = await page.evaluate(() => (window as Api).__meter.now() as number);
    expect(paused).toBeLessThan(-60);
    expect(errors).toEqual([]);
  });

  test('the first subtitle of Wheels ducks the music bus by at least 6 dB', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    // Start from an unducked music stage (no line of dialogue showing).
    await expect(page.locator('.subtitle')).not.toHaveClass(/show/, { timeout: 20_000 });
    await page.waitForFunction(() => (window as Api).__gta7.game.audio.mixer.levels().music > 0.75, null, { timeout: 5000 });
    const before = await page.evaluate(() => (window as Api).__gta7.game.audio.mixer.levels().music as number);
    await page.evaluate(() => (window as Api).__gta7.startMission('wheels'));
    await expect(page.locator('.subtitle')).toHaveClass(/show/, { timeout: 10_000 });
    await page.waitForTimeout(400);
    const during = await page.evaluate(() => (window as Api).__gta7.game.audio.mixer.levels().music as number);
    expect(20 * Math.log10(during / before)).toBeLessThanOrEqual(-6);
    expect(errors).toEqual([]);
  });

  test('a car grinding along a container plays a grind for every scrape', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const ok = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const sim = g.sim;
      g.godMode(true);
      sim.policeEnabled = false;
      // A ground-floor container with a clear lane along one long side.
      const blocked = (x0: number, z0: number, x1: number, z1: number): boolean =>
        sim.world.grid.colliders.some((c: Api) => !c.broken && c.maxX > x0 && c.minX < x1 && c.maxZ > z0 && c.minZ < z1);
      for (const p of sim.world.layout.props) {
        if (p.kind !== 'container' || p.y > 1 || p.w < p.d) continue;
        for (const side of [-1, 1]) {
          const face = p.z + (side * p.d) / 2;
          if (blocked(p.x - p.w / 2 - 6, Math.min(face + side * 0.05, face + side * 4), p.x + p.w / 2 + 6, Math.max(face + side * 0.05, face + side * 4))) continue;
          const w = window as Api;
          for (const v of [...sim.vehicles]) sim.removeVehicle(v);
          // Alongside the container, its side 3 cm into the container's, held at 14 m/s along it.
          const v = sim.spawnVehicle('sedan', p.x - p.w / 2 + 3, face + side * 0.97, Math.PI / 2);
          sim.seat(sim.player, v, 0);
          g.game.renderer.cameraCtl.reset(sim);
          w.__scrapes = 0;
          sim.events.on('scrape', (e: Api) => {
            if (e.vehicle === v) w.__scrapes++;
          });
          const update = sim.update.bind(sim);
          sim.update = (dt: number, inp: Api) => {
            if (w.__scrapes < 6) {
              v.vel.x = 14;
              v.vel.z = -side * 0.8;
              v.angVel = 0;
            }
            update(dt, inp);
          };
          w.__grinds0 = g.game.audio.counters.scrapes;
          return true;
        }
      }
      return false;
    });
    expect(ok).toBe(true);
    await page.waitForFunction(() => (window as Api).__scrapes >= 6, null, { timeout: 10_000 });
    const r = await page.evaluate(() => ({ scrapes: (window as Api).__scrapes as number, grinds: ((window as Api).__gta7.game.audio.counters.scrapes as number) - (window as Api).__grinds0 }));
    // One grind per scrape the sim reports (the listener is right behind the car).
    expect(r.grinds).toBeGreaterThanOrEqual(r.scrapes);
    expect(errors).toEqual([]);
  });

  test('pressing F next to a car plays one door thunk', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.spawnVehicle('sedan', false);
      const sim = g.sim;
      const v = sim.vehicles[sim.vehicles.length - 1];
      // Stand at the driver's door (a vehicle's local +X is its left side).
      g.place(v.pos.x + Math.cos(v.heading) * 2.3, v.pos.z - Math.sin(v.heading) * 2.3);
    });
    await page.waitForTimeout(300);
    const n0 = await page.evaluate(() => (window as Api).__gta7.game.audio.counters.doorThunks as number);
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => (window as Api).__gta7.state().player.vehicle === 'sedan', null, { timeout: 5000 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as Api).__gta7.game.audio.counters.doorThunks as number)).toBe(n0 + 1);
    expect(errors).toEqual([]);
  });
});
