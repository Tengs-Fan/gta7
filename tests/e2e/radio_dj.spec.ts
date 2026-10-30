import { expect, test, type Page } from '@playwright/test';

import { boot, newGame, type Api } from './helpers';

// The music stations' hits and DJs in the running game: the HUD names the song on air, a cued song changes it, and the
// station's music dips under a DJ's link while it plays.

/** In a fresh sedan with the police and the city's people out of the way. */
async function quietCar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    g.sim.policeEnabled = false;
    g.spawnVehicle('sedan', true);
  });
  await page.waitForFunction(() => (window as Api).__gta7.state().player.vehicle === 'sedan', null, { timeout: 5000 });
}

/**
 * An AnalyserNode on the radio's music (the kit, its echo and reverb, before the DJ's voice joins them), as
 * w1_audio.spec.ts taps the buses. `__dj.record(ms)` samples its level (dBFS over the newest 2048 samples) and the music
 * gain every 50 ms, timed from the call.
 */
async function tapMusic(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Api;
    const audio = w.__gta7.game.audio;
    const ctx = audio.ctx as AudioContext;
    const music = (audio.radio as unknown as { music: GainNode }).music;
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0;
    music.connect(an);
    const td = new Float32Array(2048);
    w.__dj = {
      async record(ms: number) {
        const out: Array<{ t: number; db: number; gain: number }> = [];
        const t0 = ctx.currentTime;
        while (ctx.currentTime - t0 < ms / 1000) {
          an.getFloatTimeDomainData(td);
          let s = 0;
          for (const v of td) s += v * v;
          out.push({ t: ctx.currentTime - t0, db: 10 * Math.log10(s / td.length + 1e-15), gain: music.gain.value });
          await new Promise((r) => setTimeout(r, 50));
        }
        return out;
      },
    };
  });
}

type Sample = { t: number; db: number; gain: number };
const meanDb = (s: Sample[]) => 10 * Math.log10(s.reduce((p, x) => p + Math.pow(10, x.db / 10), 0) / Math.max(1, s.length) + 1e-15);

test.describe('GTA 7 radio DJs', () => {
  test('after R the HUD names the song on air under the station, and a cued hit changes it', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await quietCar(page);
    // The car's radio comes on: a frame has run with the player in it, so R changes the station (on a slow frame, a key
    // pressed before that frame would be taken on foot).
    await expect(page.locator('.radio')).toHaveText(/^NEON DRIVE 88\.7/);
    await page.keyboard.press('KeyR');
    await expect(page.locator('.radio')).toHaveText(/^VELVET 89\.9/);
    const track = page.locator('.radio small.track');
    await expect(track).toHaveText(/^.+ - .+$/);
    const now = await page.evaluate(() => (window as Api).__gta7.game.audio.radio.nowPlaying);
    await expect(track).toHaveText(`${now.artist} - ${now.title}`);
    // VELVET's first hit, cued by its seed: the line follows the new song.
    await page.evaluate(() => (window as Api).__gta7.game.audio.radio.cueSong(2000));
    await expect(track).toHaveText('The Hold Music Quartet - Your Call Is Important to Us');
    await expect(page.locator('.radio small:not(.track)')).toHaveText('Lounge, music to wait to');
    expect(errors).toEqual([]);
  });

  test("the station's music dips about 7 dB under a DJ's link and comes back after it", async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await quietCar(page);
    await tapMusic(page);
    expect(await page.evaluate(() => (window as Api).__gta7.game.audio.radio.stationName)).toBe('NEON DRIVE 88.7');
    // The same hit twice, first with nothing over its intro, then with Lazer Lacey's banter: the same music both times.
    const run = (link: string | null) =>
      page.evaluate(async (link) => {
        const w = window as Api;
        const item = await w.__gta7.game.audio.radio.cueSong(1000, link ?? undefined);
        return { clip: (item?.clip ?? null) as string | null, samples: (await w.__dj.record(11000)) as Sample[] };
      }, link);
    const plain = await run(null);
    const linked = await run('banter');
    expect(plain.clip).toBeNull();
    expect(linked.clip).toMatch(/^dj-neon-drive-88-7-banter-/);
    const ducked = linked.samples.filter((s) => s.gain < 0.5);
    const from = ducked[0]!.t;
    const to = ducked.at(-1)!.t;
    const span = (s: Sample[]) => s.filter((x) => x.t >= from + 0.2 && x.t <= to - 0.2);
    const dip = meanDb(span(linked.samples)) - meanDb(span(plain.samples));
    console.log(`[dj] ${linked.clip}: ducked ${from.toFixed(2)}-${to.toFixed(2)} s into the song, music ${dip.toFixed(1)} dB against the same song without it`);
    expect(to - from).toBeGreaterThan(2);
    expect(dip).toBeLessThan(-4);
    expect(dip).toBeGreaterThan(-10);
    // Back up after the link, as the A section comes in.
    expect(linked.samples.at(-1)!.gain).toBeGreaterThan(0.95);
    expect(Math.min(...plain.samples.map((s) => s.gain))).toBeGreaterThan(0.95);
    expect(errors).toEqual([]);
  });
});
