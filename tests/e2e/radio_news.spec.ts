import { expect, test, type Page } from '@playwright/test';

import { boot, newGame, type Api } from './helpers';

/**
 * The Azura Newsdesk in the browser: a story filed through the hook (audio.newsroom.file) goes on AZURA TALK as a desk
 * after the host piece on air, and Dolores is heard on the music bus. The programme is cued past DESK_GAP from tuning
 * in, then to 3 s before the end of the next host piece: the newsroom polls once a second and splices the desk there.
 */

/** In a fresh sedan with the police off, tuned to AZURA TALK with R, an AnalyserNode on the music bus. */
async function tuneIn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    g.sim.policeEnabled = false;
    g.spawnVehicle('sedan', true);
  });
  await page.waitForFunction(() => (window as Api).__gta7.state().player.vehicle === 'sedan', null, { timeout: 5000 });
  for (let i = 0; i < 16 && (await page.evaluate(() => (window as Api).__gta7.game.audio.radio.stationName)) !== 'AZURA TALK 104.5'; i++) {
    await page.keyboard.press('KeyR');
    await page.waitForTimeout(250);
  }
  await expect(page.locator('.radio')).toHaveText(/^AZURA TALK 104\.5/);
  // DESK_GAP counts from the newsroom's first poll (once a second) with the station on.
  await page.waitForFunction(() => (window as Api).__gta7.game.audio.newsroom.tuned === true, null, { timeout: 5000 });
  await page.evaluate(() => {
    const w = window as Api;
    const audio = w.__gta7.game.audio;
    const ctx = audio.ctx as AudioContext;
    const an = ctx.createAnalyser();
    an.fftSize = 4096;
    an.smoothingTimeConstant = 0;
    audio.mixer.musicBus.connect(an);
    const td = new Float32Array(4096);
    const fd = new Float32Array(2048);
    w.__news = {
      /** dBFS over the newest 2048 samples, and the share of the spectrum's power from 200 Hz to 4 kHz. */
      sample() {
        an.getFloatTimeDomainData(td);
        let s = 0;
        for (let i = td.length - 2048; i < td.length; i++) s += td[i]! * td[i]!;
        an.getFloatFrequencyData(fd);
        const bin = ctx.sampleRate / an.fftSize;
        let tot = 0;
        let voice = 0;
        for (let i = 1; i < fd.length; i++) {
          const p = Math.pow(10, fd[i]! / 10);
          tot += p;
          if (i * bin >= 200 && i * bin < 4000) voice += p;
        }
        return { db: 10 * Math.log10(s / 2048 + 1e-15), band: tot > 0 ? voice / tot : 0 };
      },
    };
  });
}

/** Cues the programme DESK_GAP and more past tuning in, then 3 s before the end of the next host piece. */
async function cueNearHostEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const radio = (window as Api).__gta7.game.audio.radio;
    const t0 = radio.talkInfo().time;
    while (radio.talkInfo().time - t0 < 80) radio.cueTalk('host', 1);
    const now = radio.talkInfo().time;
    const host = radio.talkProgramme.segments.find((s: { kind: string; start: number }) => s.kind === 'host' && s.start > now);
    radio.cueTalk('host', host.dur - 3);
  });
}

type Heard = { kind: string; into: number; db: number; band: number; nodes: number };

/** Waits up to 10 s for a desk on air, then samples the music bus and the live voices every 50 ms for `ms` while it reads. */
async function hearDesk(page: Page, ms: number): Promise<{ heard: Heard[]; clips: number }> {
  await page.waitForFunction(() => (window as Api).__gta7.game.audio.radio.talkInfo().segment?.kind === 'desk', null, { timeout: 10000 });
  return page.evaluate(async (ms) => {
    const w = window as Api;
    const radio = w.__gta7.game.audio.radio;
    const heard: Heard[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const info = radio.talkInfo();
      heard.push({ kind: info.segment.kind, into: info.time - info.segment.start, nodes: w.__gta7.game.audio.liveNodes().total, ...w.__news.sample() });
      await new Promise((r) => setTimeout(r, 50));
    }
    return { heard, clips: radio.talkInfo().segment.clips?.length ?? 0 };
  }, ms);
}

const meanDb = (s: Heard[]) => 10 * Math.log10(s.reduce((p, x) => p + Math.pow(10, x.db / 10), 0) / Math.max(1, s.length) + 1e-15);
const meanBand = (s: Heard[]) => s.reduce((p, x) => p + x.band, 0) / Math.max(1, s.length);

test.describe('GTA 7 radio newsdesk', () => {
  test('a chase filed with the hook airs on AZURA TALK as a desk after the host piece, Dolores voice-band above -45 dBFS', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await tuneIn(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const c = g.sim.clock;
      g.game.audio.newsroom.file({ kind: 'chase', at: c.day * 24 + c.hours, stars: 4, from: 'Midtown', to: 'Ocean Beach', heli: true, outcome: 'evaded' });
    });
    await cueNearHostEnd(page);
    const { heard, clips } = await hearDesk(page, 7000);
    // The sting rings for the first DESK_LEAD (1 s); the sentences come after it.
    const read = heard.filter((x) => x.kind === 'desk' && x.into > 1.3);
    const nodes = Math.max(...heard.map((x) => x.nodes));
    console.log(`[news] chase desk: ${clips} clips, ${read.length} windows, mean ${meanDb(read).toFixed(1)} dBFS, 200 Hz-4 kHz share ${meanBand(read).toFixed(3)}, at most ${nodes} live voices`);
    expect(clips).toBe(8);
    // Every sentence is scheduled when the desk goes on air: still inside the hot mix's bound on live voices.
    expect(nodes).toBeLessThan(40);
    expect(read.length).toBeGreaterThan(60);
    expect(meanDb(read)).toBeGreaterThan(-45);
    expect(meanBand(read)).toBeGreaterThan(0.6);
    expect(await page.evaluate(() => (window as Api).__gta7.game.audio.newsroom.stories.map((f: { aired: number }) => f.aired))).toEqual([1]);
    expect(errors).toEqual([]);
  });

  test('with the weather following its schedule and no story waiting, the desk reads the forecast', async ({ page }) => {
    const errors = await boot(page, '/?intro=0', { weather: null });
    await newGame(page);
    expect(await page.evaluate(() => (window as Api).__gta7.sim.weather.mode)).toBe('dynamic');
    await tuneIn(page);
    await cueNearHostEnd(page);
    const { heard, clips } = await hearDesk(page, 4000);
    const read = heard.filter((x) => x.kind === 'desk' && x.into > 1.3);
    console.log(`[news] forecast desk: ${clips} clips, ${read.length} windows, mean ${meanDb(read).toFixed(1)} dBFS, 200 Hz-4 kHz share ${meanBand(read).toFixed(3)}`);
    // The opener, the sky now, the next change or none, tomorrow, the sign-off.
    expect(clips).toBe(5);
    expect(meanDb(read)).toBeGreaterThan(-45);
    expect(errors).toEqual([]);
  });
});
