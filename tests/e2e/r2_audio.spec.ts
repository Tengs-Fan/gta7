import { expect, test, type Page } from '@playwright/test';

import { boot, newGame, type Api } from './helpers';

/**
 * Installs an in-page meter on the analyser tap at the end of the master chain.
 * It polls on its own timer, so it keeps measuring while the game is paused (the frame loop then skips audio).
 */
async function installMeter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const an = (window as Api).__gta7.game.audio.mixer.analyser as AnalyserNode;
    const buf = new Float32Array(an.fftSize);
    const w = window as Api;
    w.__meter = {
      start() {
        this.peak = 0;
        this.ss = 0;
        this.n = 0;
        clearInterval(this.iv);
        this.iv = setInterval(() => this.sample(), 40);
      },
      sample() {
        an.getFloatTimeDomainData(buf);
        let ss = 0;
        // Peak over the whole window (170 ms, overlapping the next poll); RMS over the last 2048 samples.
        for (let i = 0; i < buf.length; i++) this.peak = Math.max(this.peak, Math.abs(buf[i]!));
        for (let i = buf.length - 2048; i < buf.length; i++) ss += buf[i]! * buf[i]!;
        this.ss += ss / 2048;
        this.n++;
      },
      stop() {
        clearInterval(this.iv);
        return { peak: this.peak as number, rmsDb: 10 * Math.log10((this.ss as number) / Math.max(1, this.n as number) + 1e-15), polls: this.n as number };
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

const meterStart = (page: Page) => page.evaluate(() => (window as Api).__meter.start());
const meterStop = (page: Page) => page.evaluate(() => (window as Api).__meter.stop() as { peak: number; rmsDb: number; polls: number });

test.describe('GTA 7 audio mix', () => {
  test('the master output stays inside full scale through three shotgun blasts and an explosion', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await installMeter(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.give('shotgun', 30);
    });
    // Let the shotgun be drawn before pulling the trigger.
    await page.waitForTimeout(1200);
    const shots0 = await page.evaluate(() => (window as Api).__gta7.game.audio.counters.gunshots);
    await meterStart(page);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const sim = (window as Api).__gta7.sim;
        const p = sim.player;
        p.fireCooldown = 0;
        sim.combat.playerFire(p, { ...sim.lastInput, fire: true, firePressed: true }, false);
      });
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const p = g.sim.player;
      const v = g.sim.spawnVehicle('sedan', p.pos.x + 5, p.pos.z + 3, 0);
      g.sim.combat.explodeVehicle(v);
    });
    await page.waitForTimeout(2000);
    const m = await meterStop(page);
    const shots = await page.evaluate(() => (window as Api).__gta7.game.audio.counters.gunshots);
    // Nine pellets per pull, one gunshot per pull.
    expect(shots - shots0).toBe(3);
    expect(m.polls).toBeGreaterThan(40);
    expect(m.peak).toBeGreaterThan(0.1);
    expect(m.peak).toBeLessThanOrEqual(1);
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
