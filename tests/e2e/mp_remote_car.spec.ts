// A remote player's car as another client draws it (VAL-MPCL-003, browser clause): session A drives a car at 15-25 m/s
// for 10 s on a long straight road with real held keys while session B, in the same room beside the road, records A's
// car position as drawn each animation frame. Over that window no frame step may exceed 2.5x the median step and A's
// car may not stand still on B for more than one frame while A is moving. The server listens on GTA7_MP_PORT (default
// 4210) with --dev, whose 'debug' command only prepares the scene (teleports, a car, no wanted level); the driving is
// real W / S / A / D key events regulated from A's own state. The trace and summary are written to GTA7_MPCL003_OUT
// (default test-results/mp-remote-car/trace.json) with a screenshot of B next to it. Playwright empties test-results
// at the start of a run, so a collector should read the files after the run, or set GTA7_MPCL003_OUT elsewhere.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { StaticWorld } from '../../src/world/staticWorld';
import type { Lane } from '../../src/world/roads';
import { boot, type Api } from './helpers';

const MP_PORT = Number(process.env.GTA7_MP_PORT ?? 4210);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const OUT = (() => {
  const p = process.env.GTA7_MPCL003_OUT ?? 'test-results/mp-remote-car/trace.json';
  return isAbsolute(p) ? p : join(ROOT, p);
})();
const SHOT = join(dirname(OUT), 'mp-remote-car-B.png');
const ROOM = 'mpcl003';

const BAND_MIN = 15;
const BAND_MAX = 25;
/** The controller aims for the middle of the band. */
const TARGET_LOW = 19;
const TARGET_HIGH = 21;
/** Seconds of the band held before the measured window starts (the car has finished accelerating), and its length. */
const SETTLE_S = 1;
const WINDOW_S = 10;
/** A step between two frames further apart than this is a paused page, not a frame, and is left out. */
const PAUSE_MS = 500;
const MAX_STEP_RATIO = 2.5;
const MAX_ATTEMPTS = 8;
/** Metres along the lane, from its start, where B stands. */
const B_ALONG = 215;
/** Metres to the left of A's lane where B stands: just across the centre line, clear of A's path. */
const B_LEFT = 3;

let server: ChildProcess | null = null;
let serverLog = '';

async function startServer(): Promise<void> {
  server = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['server/main.ts', '--port', String(MP_PORT), '--host', '127.0.0.1', '--dev', '--status-every', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  serverLog = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${serverLog}`)), 30_000);
    const check = (d: Buffer) => {
      serverLog += d.toString();
      if (serverLog.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    server!.stdout!.on('data', check);
    server!.stderr!.on('data', check);
  });
}

async function stopServer(): Promise<void> {
  const p = server;
  server = null;
  if (!p || p.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    p.once('exit', () => resolve());
    p.kill('SIGTERM');
    setTimeout(() => p.kill('SIGKILL'), 4000).unref();
  });
}

async function serverPlayer(name: string): Promise<{ x: number; z: number; vehicle: { kind: string } | null } | null> {
  const r = await fetch(`http://127.0.0.1:${MP_PORT}/status`);
  const room = ((await r.json()) as { rooms: Array<{ id: string; tickErrors: number; members: Array<{ name: string; player: { x: number; z: number; vehicle: { kind: string } | null } | null }> }> }).rooms.find((x) => x.id === ROOM);
  return room?.members.find((m) => m.name === name)?.player ?? null;
}

const appErrors = (errors: string[]) => errors.filter((e) => !/WebSocket connection to .* failed/i.test(e));

/**
 * Straight stretches of the multi-lane avenues, longest first: a lane and the lanes its straight turns lead on to
 * (the road is the same lane for its whole length). Only the lane nearest the centre line of each road and direction.
 */
function straightLanes(): Array<{ lane: Lane; length: number }> {
  const roads = new StaticWorld().roads;
  const out: Array<{ lane: Lane; length: number }> = [];
  for (const lane of roads.lanes) {
    if (!lane.line.avenue || lane.lanesInDir < 2 || lane.index !== 0) continue;
    let length = 0;
    let l: Lane | undefined = lane;
    const seen = new Set<number>();
    while (l && !seen.has(l.id)) {
      seen.add(l.id);
      length += l.length;
      // On along the avenue: not out over the Magnolia Causeway or the Southgate Bridge into Las Lomas County.
      const t: { to: Lane; length: number } | undefined = l.turns.find((x) => x.kind === 'straight' && x.to.line.avenue);
      if (!t) break;
      length += t.length;
      l = t.to;
    }
    if (length >= 700) out.push({ lane, length });
  }
  return out.sort((x, y) => y.length - x.length || x.lane.id - y.lane.id);
}

interface AState {
  t: number;
  id: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  destroyed: boolean;
}

/** A's driven car as A itself draws it, stamped on the epoch clock the recorder on B uses. */
const readCar = (page: Page) =>
  page.evaluate(() => {
    const g = (window as Api).__gta7;
    const l = g.net.local();
    if (!l?.vehicle) return null;
    const v = g.game.view.vehicles.find((x: { id: number }) => x.id === l.vehicle.id);
    if (!v) return null;
    return { t: performance.timeOrigin + performance.now(), id: v.id, x: v.pos.x, z: v.pos.z, heading: v.heading, speed: v.speed, destroyed: !!v.destroyed } as AState;
  });

const debug = (page: Page, arg: Record<string, unknown>) => page.evaluate((a) => (window as Api).__gta7.net.command('debug', a), arg);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};

interface Frame {
  /** Epoch ms of the animation frame. */
  t: number;
  /** The game's frame counter at that moment. */
  g: number;
  hidden: boolean;
  x: number | null;
  z: number | null;
}

/** Records, every animation frame of the page, where the page draws player `name`'s car (the interpolated mirror pose). */
async function startRecorder(page: Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    const w = window as Api;
    const rec = { frames: [] as unknown[], on: true };
    w.__mpcl = rec;
    const tick = (ts: number) => {
      if (!rec.on) return;
      const p = w.__gta7.net.players().find((x: { name: string }) => x.name === n);
      rec.frames.push([performance.timeOrigin + ts, w.__gta7.game.frames, document.visibilityState !== 'visible', p ? p.x : null, p ? p.z : null]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, name);
}

async function stopRecorder(page: Page): Promise<Frame[]> {
  const rows = (await page.evaluate(() => {
    const rec = (window as Api).__mpcl;
    rec.on = false;
    return rec.frames;
  })) as Array<[number, number, boolean, number | null, number | null]>;
  return rows.map(([t, g, hidden, x, z]) => ({ t, g, hidden, x, z }));
}

test.describe('remote car drawn smoothly', () => {
  test.beforeAll(startServer);
  test.afterAll(stopServer);

  test('B draws A\'s car driving past at 15-25 m/s for 10 s without jumps or stalls', async ({ browser }) => {
    test.setTimeout(240_000);
    const candidates = straightLanes();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    try {
      const url = (n: string) => `/?intro=0&mp=1&server=127.0.0.1:${MP_PORT}&room=${ROOM}&name=${n}`;
      const errorsA = await boot(A, url('A'));
      const errorsB = await boot(B, url('B'));
      for (const p of [A, B]) await p.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 20_000 });
      await A.waitForFunction(() => (window as Api).__gta7.net.players().length === 2, null, { timeout: 8000 });

      await debug(A, { godMode: true, neverWanted: true });
      await debug(B, { godMode: true, neverWanted: true });

      const visibility = await Promise.all([A, B].map((p) => p.evaluate(() => document.visibilityState)));
      await startRecorder(B, 'A');

      const pressed = new Set<string>();
      const key = async (k: string, down: boolean) => {
        if (down === pressed.has(k)) return;
        if (down) pressed.add(k);
        else pressed.delete(k);
        await (down ? A.keyboard.down(k) : A.keyboard.up(k));
      };
      const releaseAll = async () => {
        for (const k of [...pressed]) await key(k, false);
      };

      interface Attempt {
        lane: Lane;
        length: number;
        bAt: { x: number; z: number };
        ok: boolean;
        why: string;
        series: AState[];
        runStart: number;
      }
      const bCharacter = ((await B.evaluate(() => (window as Api).__gta7.net.local())) as { id: number }).id;
      const attempts: Attempt[] = [];
      let result: Attempt | null = null;
      const interp: Array<{ t: number; interpDelayMs: number; rtt: number }> = [];
      let lastInterp = 0;

      for (let n = 0; n < MAX_ATTEMPTS && !result; n++) {
        const cand = candidates[n % candidates.length]!;
        const lane = cand.lane;
        const lat = { x: Math.cos(lane.heading), z: -Math.sin(lane.heading) };
        // Scene: B stands on the avenue's centre line, facing along it, where A's 10 s window ends, so A drives past him
        // and stops in front of his camera; the drive stays within B's 250 m interest radius. A starts on foot at the
        // lane's start, and the road is only driven when nothing stands in it. Only the scene is set up through debug.
        const bAt = { x: lane.sx + lane.dx * B_ALONG + lat.x * B_LEFT, z: lane.sz + lane.dz * B_ALONG + lat.z * B_LEFT };
        await releaseAll();
        await debug(B, { teleport: [bAt.x, bAt.z] });
        await debug(A, { teleport: [lane.sx + lane.dx * 20, lane.sz + lane.dz * 20] });
        await A.waitForTimeout(800);
        const inRoad = await A.evaluate(
          ([sx, sz, dx, dz, lx, lz, other]) => {
            const g = (window as Api).__gta7;
            const me = g.net.local();
            const rel = (e: Api) => ({ along: (e.pos.x - sx) * dx + (e.pos.z - sz) * dz, lateral: (e.pos.x - sx) * lx + (e.pos.z - sz) * lz });
            const hits: string[] = [];
            for (const v of g.game.view.vehicles) {
              const r = rel(v);
              if (!v.removed && r.along > -10 && r.along < 300 && Math.abs(r.lateral) < 5) hits.push(`${v.kind}@${r.along.toFixed(0)}`);
            }
            for (const c of g.game.view.characters) {
              const r = rel(c);
              if (!c.removed && c.id !== me.id && c.id !== other && !c.vehicle && r.along > -10 && r.along < 300 && Math.abs(r.lateral) < 5) hits.push(`person@${r.along.toFixed(0)}`);
            }
            return hits;
          },
          [lane.sx, lane.sz, lane.dx, lane.dz, lat.x, lat.z, bCharacter],
        );
        if (inRoad.length) {
          const why = `road ${lane.id} not clear: ${inRoad.join(' ')}`;
          attempts.push({ lane, length: cand.length, bAt, ok: false, why, series: [], runStart: -1 });
          console.log(`[mp_remote_car] attempt ${n + 1}: ${why}`);
          continue;
        }
        await debug(A, { drive: 'sedan' });
        await A.waitForFunction(() => (window as Api).__gta7.net.local().vehicle !== null, null, { timeout: 5000 });
        await A.waitForTimeout(500);
        await A.bringToFront();
        const series: AState[] = [];
        let runStart = -1;
        let why = '';
        const t0 = Date.now();
        while (Date.now() - t0 < 50_000) {
          const s = await readCar(A);
          if (!s) {
            why = 'A lost its car';
            break;
          }
          series.push(s);
          const along = (s.x - lane.sx) * lane.dx + (s.z - lane.sz) * lane.dz;
          const lateral = (s.x - lane.sx) * lat.x + (s.z - lane.sz) * lat.z;
          if (s.destroyed) {
            why = 'car destroyed';
            break;
          }
          if (Math.abs(lateral) > 9 || along < -10) {
            why = `left the road (lateral ${lateral.toFixed(1)} m, along ${along.toFixed(0)} m)`;
            break;
          }
          if (runStart < 0 && along > 340 - (SETTLE_S + WINDOW_S) * BAND_MIN) {
            why = `no room left for ${WINDOW_S} s in the band after ${along.toFixed(0)} m`;
            break;
          }
          if (along > 340) {
            why = `ran past the measured stretch at ${along.toFixed(0)} m`;
            break;
          }
          // Speed: W below the target band, off above it, a touch of S if it still climbs.
          if (s.speed < TARGET_LOW) await key('KeyW', true);
          else if (s.speed > TARGET_HIGH) await key('KeyW', false);
          await key('KeyS', s.speed > BAND_MAX - 1.5);
          // Steering: aim at the lane line, drifting back towards it in proportion to the offset (positive yaw turns left).
          const wantHeading = lane.heading - Math.max(-0.12, Math.min(0.12, lateral * 0.03));
          const err = wrap(wantHeading - s.heading);
          await key('KeyA', err > 0.025);
          await key('KeyD', err < -0.025);
          const inBand = s.speed >= BAND_MIN && s.speed <= BAND_MAX;
          const prev = series.at(-2);
          if (!inBand || (prev && s.t - prev.t > 300)) runStart = inBand ? series.length - 1 : -1;
          else if (runStart < 0) runStart = series.length - 1;
          if (runStart >= 0 && s.t - series[runStart]!.t >= (SETTLE_S + WINDOW_S) * 1000 + 300) break;
          if (Date.now() - lastInterp > 1000) {
            lastInterp = Date.now();
            const net = await B.evaluate(() => {
              const st = (window as Api).__gta7.net.state();
              return { t: performance.timeOrigin + performance.now(), interpDelayMs: st.interpDelayMs, rtt: st.rtt };
            });
            interp.push(net);
          }
        }
        await releaseAll();
        const done = runStart >= 0 && series.length > 0 && series.at(-1)!.t - series[runStart]!.t >= (SETTLE_S + WINDOW_S) * 1000;
        const last = series.at(-1);
        const where = last ? ` (last: ${((last.x - lane.sx) * lane.dx + (last.z - lane.sz) * lane.dz).toFixed(0)} m along, ${last.speed.toFixed(1)} m/s)` : '';
        const a: Attempt = { lane, length: cand.length, bAt, ok: done, why: done ? 'ok' : `${why || 'timed out before 10 s in the band'}${where}`, series, runStart };
        attempts.push(a);
        if (!done && series.length) {
          const timeline = series.filter((x, i) => i === 0 || x.t - series[0]!.t >= Math.round((x.t - series[0]!.t) / 500) * 500 && (i === series.length - 1 || Math.floor((x.t - series[0]!.t) / 500) !== Math.floor((series[i - 1]!.t - series[0]!.t) / 500)));
          console.log(`[mp_remote_car] attempt ${n + 1} speed every 0.5 s: ${timeline.map((x) => x.speed.toFixed(1)).join(' ')}`);
        }
        console.log(`[mp_remote_car] attempt ${n + 1} on road ${lane.id}: ${a.why}, ${series.length} samples`);
        if (done) result = a;
      }
      expect(result, `A held 15-25 m/s for ${WINDOW_S} s in ${MAX_ATTEMPTS} attempts: ${attempts.map((x) => x.why).join('; ')}`).not.toBeNull();

      const { lane, length: laneLength, bAt } = result!;

      // A brakes to a stop beside B for the screenshot, and the recorder stops.
      await key('KeyS', true);
      await A.waitForTimeout(1800);
      await releaseAll();
      const frames = await stopRecorder(B);
      await B.bringToFront();
      mkdirSync(dirname(OUT), { recursive: true });
      await B.screenshot({ path: SHOT });
      const serverA = await serverPlayer('A');
      const atRest = await B.evaluate(() => {
        const g = (window as Api).__gta7;
        return { bLocal: g.net.local().character, aDrawn: g.net.players().find((p: { name: string }) => p.name === 'A') };
      });

      // The window: 10 s of A's samples that are all in the band, starting SETTLE_S after the band was entered.
      const series = result!.series.slice(result!.runStart);
      const w0 = series[0]!.t + SETTLE_S * 1000;
      const w1 = w0 + WINDOW_S * 1000;
      const aWindow = series.filter((s) => s.t >= w0 && s.t <= w1);
      const speeds = aWindow.map((s) => s.speed);
      const aGaps = aWindow.slice(1).map((s, i) => s.t - aWindow[i]!.t);

      const inWindow = frames.filter((f) => f.t >= w0 && f.t <= w1);
      const usable: Frame[] = [];
      let hiddenFrames = 0;
      let duplicateFrames = 0;
      let missingFrames = 0;
      for (const f of inWindow) {
        if (f.hidden) hiddenFrames++;
        else if (f.x === null || f.z === null) missingFrames++;
        else if (usable.length && usable.at(-1)!.g === f.g) duplicateFrames++;
        else usable.push(f);
      }
      const steps: Array<{ t: number; dt: number; d: number }> = [];
      let pausedSteps = 0;
      for (let i = 1; i < usable.length; i++) {
        const dt = usable[i]!.t - usable[i - 1]!.t;
        if (dt > PAUSE_MS) {
          pausedSteps++;
          continue;
        }
        steps.push({ t: usable[i]!.t, dt, d: Math.hypot(usable[i]!.x! - usable[i - 1]!.x!, usable[i]!.z! - usable[i - 1]!.z!) });
      }
      const d = steps.map((s) => s.d);
      const med = median(d);
      const max = Math.max(...d);
      const rates = steps.map((s) => (s.d / s.dt) * 1000);
      const medRate = median(rates);
      const stallLimit = Math.max(0.01, 0.1 * med);
      let stalled = 0;
      let run = 0;
      let longest = 0;
      const runs: Array<{ t: number; frames: number }> = [];
      steps.forEach((s, i) => {
        if (s.d < stallLimit) {
          stalled++;
          run++;
          if (run > longest) longest = run;
        } else {
          if (run > 1) runs.push({ t: steps[i - run]!.t, frames: run });
          run = 0;
        }
      });
      if (run > 1) runs.push({ t: steps[steps.length - run]!.t, frames: run });
      const duration = (steps.at(-1)?.t ?? 0) - (usable[0]?.t ?? 0);
      const drawnDistance = d.reduce((a, b) => a + b, 0);
      const meanDrawnSpeed = (drawnDistance / (steps.reduce((a, s) => a + s.dt, 0) / 1000)) || 0;
      const meanTrueSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      const aStart = aWindow[0]!;
      const aEnd = aWindow.at(-1)!;
      const summary = {
        road: { laneId: lane.id, start: [lane.sx, lane.sz], dir: [lane.dx, lane.dz], chainLengthM: Math.round(laneLength), bAt },
        attempts: attempts.map((a) => a.why),
        visibility,
        windowS: (w1 - w0) / 1000,
        aSpeed: { min: Math.min(...speeds), max: Math.max(...speeds), mean: meanTrueSpeed, samples: aWindow.length, maxSampleGapMs: Math.max(...aGaps) },
        aDistanceM: Math.hypot(aEnd.x - aStart.x, aEnd.z - aStart.z),
        bFrames: { inWindow: inWindow.length, usable: usable.length, hidden: hiddenFrames, duplicate: duplicateFrames, missingCar: missingFrames, pausedSteps, fps: (usable.length - 1) / (duration / 1000) },
        step: { medianM: med, maxM: max, ratio: max / med, minM: Math.min(...d), p99M: [...d].sort((a, b) => a - b)[Math.floor(d.length * 0.99)] },
        stepPerSecond: { medianMps: medRate, maxMps: Math.max(...rates), ratio: Math.max(...rates) / medRate },
        stalls: { limitM: stallLimit, stalledFrames: stalled, longestRun: longest, runsOver1: runs },
        meanDrawnSpeedMps: meanDrawnSpeed,
        meanDrawnDistanceM: drawnDistance,
        interp: { samples: interp.length, interpDelayMsMedian: median(interp.map((x) => x.interpDelayMs)), rttMedian: median(interp.map((x) => x.rtt)) },
        serverAfterStop: serverA,
        atRestOnB: atRest,
      };
      const trace = {
        summary,
        window: { startEpochMs: w0, endEpochMs: w1 },
        aSpeedSeries: result!.series.map((s) => ({ t: s.t, speed: s.speed, x: s.x, z: s.z })),
        bDrawnFrames: frames.map((f) => ({ t: f.t, game: f.g, hidden: f.hidden, x: f.x, z: f.z, inWindow: f.t >= w0 && f.t <= w1 })),
        windowSteps: steps,
        interpSamples: interp,
      };
      writeFileSync(OUT, JSON.stringify(trace));
      writeFileSync(join(dirname(OUT), 'summary.json'), JSON.stringify(summary, null, 2));
      console.log(`[mp_remote_car] summary ${JSON.stringify(summary)}`);
      console.log(`[mp_remote_car] trace ${OUT}, screenshot ${SHOT}`);

      expect(summary.windowS).toBeGreaterThanOrEqual(WINDOW_S);
      expect(summary.aSpeed.min, 'A stayed at or above 15 m/s').toBeGreaterThanOrEqual(BAND_MIN);
      expect(summary.aSpeed.max, 'A stayed at or below 25 m/s').toBeLessThanOrEqual(BAND_MAX);
      expect(summary.aSpeed.maxSampleGapMs, 'A\'s speed was sampled throughout').toBeLessThan(300);
      expect(usable.length, 'B drew enough frames').toBeGreaterThan(WINDOW_S * 20);
      expect(Math.abs(meanDrawnSpeed - meanTrueSpeed), 'the car B draws moves as fast as A drives').toBeLessThan(3);
      expect(med, 'B draws A\'s car moving').toBeGreaterThan(0);
      expect(max, `largest frame step ${max.toFixed(3)} m vs median ${med.toFixed(3)} m`).toBeLessThanOrEqual(MAX_STEP_RATIO * med);
      expect(longest, `longest run of stalled frames while A moves (${JSON.stringify(runs)})`).toBeLessThanOrEqual(1);

      for (const p of [A, B]) {
        const s = await p.evaluate(() => (window as Api).__gta7.state());
        expect(s.crashed).toBe(false);
      }
      expect(appErrors(errorsA)).toEqual([]);
      expect(appErrors(errorsB)).toEqual([]);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
