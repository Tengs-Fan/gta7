// VAL-MPX-002 in the browser, start to finish: one player is chased by the police for a full minute while the other,
// at 0 stars, stands close by and is never targeted, shot at, hurt or arrested. A real server process (--dev), two real
// pages, real sustained key events and mouse buttons; the only debug commands are scene setup (a weapon, a spot) and
// god mode for A alone, so that the chase stays live for the whole minute instead of ending in a death or a bust.
// B has no god mode, no weapon and no cheats.
//
// Scene: the south sidewalk of the block x -264..-180 (z 77.8) is A's route. A runs it back and forth on foot (W + Shift
// held, the camera steered along the route); B stands on the far sidewalk of the road below it (z 92.2, 14.4 m off the
// route), at the middle of the route. Evidence (trace.json and screenshots) goes to the test's output directory.

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { boot, type Api } from './helpers';

const MP_PORT = Number(process.env.GTA7_MP_PORT ?? 4210);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const ROOM = 'x-bystander';
/** The measured chase, from the first police round at A; the police may take this long to arrive first. */
const CHASE_SECONDS = 60;
const APPROACH_LIMIT_S = 40;
/** Police this close (m) to A count as round him. */
const NEAR_A = 70;

/** The route: A's sidewalk (z) between x0 and x1, and where B stands (across the road, in the middle). */
const ROUTE = { z: 77.8, x0: -258, x1: -186 };
const B_SPOT = { x: -222, z: 92.2 };

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

interface ServerPlayer {
  x: number;
  z: number;
  state: string;
  health: number;
  vehicle: { id: number; kind: string } | null;
  wanted: number;
  police: { units: number; chasing: number; officers: number; helis: number; nearest: number | null; shotsAt: number; hits: number; healthLost: number };
}
interface PoliceUnit {
  kind: 'car' | 'officer' | 'heli';
  id: number;
  works: string | null;
  active: boolean;
  target: string | null;
  x: number;
  z: number;
}
interface RoomStatus {
  tickErrors: number;
  policeUnits: PoliceUnit[];
  members: Array<{ playerId: number; name: string; slot: number; player: ServerPlayer | null }>;
}

async function status(): Promise<{ players: Record<string, ServerPlayer>; units: PoliceUnit[]; tickErrors: number }> {
  const r = await fetch(`http://127.0.0.1:${MP_PORT}/status`);
  const room = ((await r.json()) as { rooms: Array<RoomStatus & { id: string }> }).rooms.find((x) => x.id === ROOM)!;
  return {
    players: Object.fromEntries(room.members.filter((m) => m.player).map((m) => [m.name, m.player!])),
    units: room.policeUnits,
    tickErrors: room.tickErrors,
  };
}

const appErrors = (errors: string[]) => errors.filter((e) => !/WebSocket connection to .* failed/i.test(e));

interface Player {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

async function joinRoom(browser: Browser, name: string): Promise<Player> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = await boot(page, `/?intro=0&mp=1&server=127.0.0.1:${MP_PORT}&room=${ROOM}&name=${name}`);
  await page.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 20_000 });
  // The test steers the camera itself (the mouse moves of a headless page are bogus).
  await page.evaluate(() => ((window as Api).__gta7.game.renderer.cameraCtl.sensitivity = 0));
  return { ctx, page, errors };
}

const debug = (p: Player, arg: Record<string, unknown>) => p.page.evaluate((a) => (window as Api).__gta7.net.command('debug', a), arg);
const local = (p: Player) => p.page.evaluate(() => (window as Api).__gta7.net.local());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where a page draws another player right now, and the stars it shows for him. */
const seen = (p: Player, name: string) =>
  p.page.evaluate(
    (n) => new Promise((res) => requestAnimationFrame(() => res((window as Api).__gta7.net.players().find((x: { name: string }) => x.name === n) ?? null))),
    name,
  ) as Promise<{ x: number; z: number; wanted: number } | null>;

/**
 * Points A's crosshair at the nearest live civilian on foot within `reach` m of A (from A's own mirror); false when there
 * is none. Re-run before every burst: the ped moves.
 */
async function aimAtCivilian(p: Player, reach: number): Promise<{ id: number; d: number } | null> {
  return p.page.evaluate((r) => {
    const g = (window as Api).__gta7;
    const me = g.net.local().character;
    let best: { c: Api; d: number } | null = null;
    for (const c of g.game.view.characters) {
      if (c.role !== 'civilian' || !c.alive || c.removed || c.vehicle) continue;
      const d = Math.hypot(c.pos.x - me.x, c.pos.z - me.z);
      if (d < r && (!best || d < best.d)) best = { c, d };
    }
    if (!best) return null;
    const cam = g.game.renderer.cameraCtl;
    const t = { x: best.c.pos.x, y: best.c.pos.y + 1.1, z: best.c.pos.z };
    for (let k = 0; k < 3; k++) {
      const { origin: o, dir: d } = cam.rayFor();
      const tx = t.x - o.x;
      const ty = t.y - o.y;
      const tz = t.z - o.z;
      cam.yaw = Math.atan2(tx, tz);
      cam.pitch += Math.atan2(ty, Math.hypot(tx, tz)) - Math.asin(Math.max(-1, Math.min(1, d.y)));
    }
    return { id: best.c.id, d: best.d };
  }, reach);
}

/** Two idle civilians a few metres east of A on his sidewalk (scene setup: the people he is about to shoot). */
const placeVictims = (A: Player) => debug(A, { civilians: [[ROUTE.x0 + 6, ROUTE.z], [ROUTE.x0 + 8.5, ROUTE.z]] });

/** A real crime: A shoots civilians (left mouse held, the crosshair on them) until the server has him at 2 stars. */
async function commitCrime(A: Player): Promise<void> {
  await debug(A, { give: ['smg', 400] });
  await placeVictims(A);
  await A.page.bringToFront();
  await A.page.mouse.move(640, 360);
  const deadline = Date.now() + 40_000;
  let held = false;
  while (Date.now() < deadline) {
    if ((await status()).players.Ann!.wanted >= 2) break;
    const target = await aimAtCivilian(A, 30);
    if (!target) {
      if (held) await A.page.mouse.up();
      held = false;
      await placeVictims(A);
      await sleep(600);
      continue;
    }
    if (!held) {
      await A.page.mouse.down();
      held = true;
    }
    await sleep(70);
  }
  if (held) await A.page.mouse.up();
  expect((await status()).players.Ann!.wanted, 'A reached 2 stars by shooting civilians').toBe(2);
}

/**
 * Steers A's camera along the route from inside the page (every 50 ms), so that W keeps him on the sidewalk: toward the
 * end of the leg, and back when he gets within 3 m of it. Returns the legs run so far when read.
 */
async function startRouteSteering(A: Player): Promise<void> {
  await A.page.evaluate((route) => {
    const w = window as Api;
    const g = w.__gta7;
    const cam = g.game.renderer.cameraCtl;
    const state = { toEast: true, legs: 0, timer: 0 };
    w.__route = state;
    state.timer = window.setInterval(() => {
      const me = g.net.local()?.character;
      if (!me) return;
      const tx = state.toEast ? route.x1 : route.x0;
      if (Math.abs(me.x - tx) < 3 && Math.abs(me.z - route.z) < 6) {
        state.toEast = !state.toEast;
        state.legs++;
      }
      const gx = state.toEast ? route.x1 : route.x0;
      // Back onto the sidewalk line first when he is far off it, then along it.
      const aimZ = Math.abs(me.z - route.z) > 4 ? route.z : route.z + (route.z - me.z) * 0.3;
      cam.yaw = Math.atan2(gx - me.x, aimZ - me.z);
      cam.pitch = 0.05;
    }, 50);
  }, ROUTE);
}

const routeLegs = (A: Player) => A.page.evaluate(() => (window as Api).__route?.legs ?? 0) as Promise<number>;

interface Sample {
  t: number;
  engaged: boolean;
  A: ServerPlayer;
  B: ServerPlayer;
  aHud: number;
  bHud: number;
  bSeesA: number | null;
  aSeesB: number | null;
  bPoliceNearA: number;
  aPoliceNearA: number;
  serverNearA: number;
  units: PoliceUnit[];
  gap: number;
  aDrawErr: number | null;
}

test.describe('multiplayer bystander (VAL-MPX-002)', () => {
  test.beforeAll(startServer);
  test.afterAll(stopServer);

  test('A is chased on foot for 60 s while B, at 0 stars, stands 14 m off the route and is never targeted or hurt', async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const A = await joinRoom(browser, 'Ann');
    const B = await joinRoom(browser, 'Bea');
    const shot = async (name: string) => {
      await Promise.all([A.page.screenshot({ path: testInfo.outputPath(`${name}-A.png`) }), B.page.screenshot({ path: testInfo.outputPath(`${name}-B.png`) })]);
    };
    await A.page.waitForFunction(() => (window as Api).__gta7.net.players().length === 2, null, { timeout: 8000 });

    // Setup: A to the west end of his route, B stays where he spawned (far away) until the crime is done.
    await debug(A, { teleport: [ROUTE.x0, ROUTE.z] });
    await sleep(1500);
    await commitCrime(A);
    const bStart = (await status()).players.Bea!;
    expect(bStart.wanted, 'B committed nothing').toBe(0);

    // B walks to nothing: he is placed on the far sidewalk and then left alone (no keys, no weapon).
    await debug(B, { teleport: [B_SPOT.x, B_SPOT.z] });
    await sleep(800);
    const bSpot = (await status()).players.Bea!;
    expect(Math.hypot(bSpot.x - B_SPOT.x, bSpot.z - B_SPOT.z), 'B stands where he was put').toBeLessThan(3);
    await debug(A, { godMode: true });

    // A runs the route on foot: W and Shift held throughout. The minute that is measured starts with the first police
    // round at A (the units take about ten seconds to arrive); B-side checks cover the approach as well.
    await A.page.bringToFront();
    await startRouteSteering(A);
    await A.page.keyboard.down('w');
    await A.page.keyboard.down('Shift');

    const samples: Sample[] = [];
    const hudMismatch: string[] = [];
    const SHOT_AT = [1, 15, 30, 45];
    let nextShot = 0;
    let engagedAt: number | null = null;
    const t0 = Date.now();
    try {
      while (Date.now() - t0 < APPROACH_LIMIT_S * 1000 + CHASE_SECONDS * 1000) {
        const elapsed = (Date.now() - t0) / 1000;
        const before = await status();
        const [la, lb, bSeesA, aSeesB, polA, polB] = await Promise.all([
          local(A),
          local(B),
          seen(B, 'Ann'),
          seen(A, 'Bea'),
          A.page.evaluate(() => (window as Api).__gta7.net.police()),
          B.page.evaluate(() => (window as Api).__gta7.net.police()),
        ]);
        const after = await status();
        const a = after.players.Ann!;
        const b = after.players.Bea!;
        if (engagedAt === null && a.police.shotsAt > 0) engagedAt = elapsed;
        const near = (pol: { cars: Array<{ x: number; z: number }>; officers: Array<{ x: number; z: number }> }) =>
          [...pol.cars, ...pol.officers].filter((c) => Math.hypot(c.x - a.x, c.z - a.z) < NEAR_A).length;
        samples.push({
          t: Math.round(elapsed * 10) / 10,
          engaged: engagedAt !== null,
          A: a,
          B: b,
          aHud: la.wanted,
          bHud: lb.wanted,
          bSeesA: bSeesA?.wanted ?? null,
          aSeesB: aSeesB?.wanted ?? null,
          bPoliceNearA: near(polB),
          aPoliceNearA: near(polA),
          serverNearA: after.units.filter((u) => Math.hypot(u.x - a.x, u.z - a.z) < NEAR_A).length,
          units: after.units,
          gap: Math.round(Math.hypot(a.x - b.x, a.z - b.z) * 10) / 10,
          aDrawErr: bSeesA ? Math.round(Math.hypot(bSeesA.x - a.x, bSeesA.z - a.z) * 10) / 10 : null,
        });
        // A client's stars must equal the server's from just before or just after it read them.
        const stars = (who: 'Ann' | 'Bea') => [before.players[who]!.wanted, after.players[who]!.wanted];
        if (!stars('Ann').includes(la.wanted)) hudMismatch.push(`A's HUD ${la.wanted} vs server ${stars('Ann')} at ${elapsed.toFixed(1)} s`);
        if (!stars('Bea').includes(lb.wanted)) hudMismatch.push(`B's HUD ${lb.wanted} vs server ${stars('Bea')} at ${elapsed.toFixed(1)} s`);
        if (engagedAt !== null && nextShot < SHOT_AT.length && elapsed - engagedAt >= SHOT_AT[nextShot]!) await shot(`chase-${String(SHOT_AT[nextShot++]).padStart(2, '0')}s`);
        if (engagedAt !== null && elapsed - engagedAt >= CHASE_SECONDS) break;
        await sleep(700);
      }
    } finally {
      await A.page.keyboard.up('Shift');
      await A.page.keyboard.up('w');
    }
    const legs = await routeLegs(A);
    await shot('chase-end');

    const chase = samples.filter((s) => s.engaged);
    const summary = {
      route: ROUTE,
      bSpot: B_SPOT,
      chaseSeconds: chase.length ? Math.round((chase.at(-1)!.t - chase[0]!.t) * 10) / 10 : 0,
      approachSeconds: chase.length ? chase[0]!.t : null,
      legs,
      samples: samples.length,
      aWantedMin: Math.min(...chase.map((s) => s.A.wanted)),
      bWantedMax: Math.max(...samples.map((s) => s.B.wanted)),
      bHealthMin: Math.min(...samples.map((s) => s.B.health)),
      aShotsAt: Math.max(...samples.map((s) => s.A.police.shotsAt)),
      bShotsAt: Math.max(...samples.map((s) => s.B.police.shotsAt)),
      bHits: Math.max(...samples.map((s) => s.B.police.hits)),
      bTargeted: samples.reduce((n, s) => n + s.units.filter((u) => u.target === 'Bea' || (u.works === 'Bea' && u.active)).length, 0),
      gapMin: Math.min(...samples.map((s) => s.gap)),
      gapMax: Math.max(...samples.map((s) => s.gap)),
      maxChasing: Math.max(...samples.map((s) => s.A.police.chasing)),
      maxOfficers: Math.max(...samples.map((s) => s.A.police.officers)),
      hudMismatch,
    };
    writeFileSync(testInfo.outputPath('trace.json'), JSON.stringify({ summary, samples }, null, 1));
    console.log(`[mp_bystander] ${JSON.stringify(summary)}`);
    await testInfo.attach('trace.json', { path: testInfo.outputPath('trace.json'), contentType: 'application/json' });

    // The chase was live for a full minute.
    expect(engagedAt, 'the police opened fire on A').not.toBeNull();
    expect(summary.chaseSeconds, 'a full minute of chase measured').toBeGreaterThanOrEqual(CHASE_SECONDS);
    expect(summary.aWantedMin, 'A kept his 2 stars through the chase').toBe(2);
    expect(samples.every((s) => s.A.state !== 'wasted' && s.A.state !== 'busted'), 'A never wasted or busted').toBe(true);
    expect(chase.filter((s) => s.A.police.chasing + s.A.police.officers > 0).length / chase.length, 'police units chase A in nearly every sample').toBeGreaterThan(0.9);
    expect(chase.filter((s) => s.serverNearA > 0).length / chase.length, 'police stay within reach of A').toBeGreaterThan(0.9);
    for (const third of [0, 1, 2]) {
      const part = chase.filter((s) => s.t - chase[0]!.t >= third * 20 && s.t - chase[0]!.t < (third + 1) * 20);
      const rounds = Math.max(...part.map((s) => s.A.police.shotsAt)) - Math.min(...part.map((s) => s.A.police.shotsAt));
      expect(rounds, `police shot at A during seconds ${third * 20}-${(third + 1) * 20} of the chase`).toBeGreaterThan(0);
    }
    expect(legs, 'A ran his route, back and forth').toBeGreaterThanOrEqual(3);
    expect(summary.gapMax, 'B stayed near the chase').toBeLessThan(60);
    expect(summary.gapMin, 'A never ran into B').toBeGreaterThan(8);
    const serverSees = chase.filter((s) => s.serverNearA > 0);
    expect(serverSees.filter((s) => s.bPoliceNearA > 0).length / serverSees.length, "B's client draws the police round A").toBeGreaterThan(0.9);
    expect(serverSees.filter((s) => s.aPoliceNearA > 0).length / serverSees.length, "A's client draws the police round him").toBeGreaterThan(0.9);

    // B was never touched.
    expect(summary.bWantedMax, "B's stars on the server").toBe(0);
    expect(samples.every((s) => s.bHud === 0), "B's own HUD").toBe(true);
    expect(samples.every((s) => s.aSeesB === 0), 'A sees B at 0 stars').toBe(true);
    expect(samples.some((s) => s.bSeesA !== null && s.bSeesA >= 1), 'B sees A wanted').toBe(true);
    // (`units` counts ambient patrols too: untagged ones belong to slot 0 whatever his stars; `chasing` is cars driving at him.)
    expect(samples.every((s) => s.B.police.chasing === 0), 'no police car drives at B').toBe(true);
    expect(summary.bTargeted, 'no police unit works for or targets B').toBe(0);
    expect(summary.bShotsAt, 'no police round passed B').toBe(0);
    expect(summary.bHits, 'no police damage to B').toBe(0);
    expect(samples.every((s) => s.B.health === bStart.health && s.B.state === bStart.state), 'B never lost health').toBe(true);
    expect(samples.every((s) => s.B.vehicle === null), 'B stayed on foot').toBe(true);
    const bLog = (await B.page.evaluate(() => (window as Api).__gta7.net.events(400))) as Array<{ type: string; playerId?: number }>;
    const bId = (await B.page.evaluate(() => (window as Api).__gta7.net.state().playerId)) as number;
    expect(bLog.filter((e) => (e.type === 'busted' || e.type === 'wasted') && e.playerId === bId)).toEqual([]);
    expect(((await local(B)).deathKind ?? null)).toBeNull();

    // Both clients agree with the server on the chase.
    expect(samples.filter((s) => s.aDrawErr !== null && s.aDrawErr > 6).length, "A as B draws him vs the server (running, interpolated)").toBeLessThan(samples.length * 0.1);
    expect(hudMismatch, 'both HUDs show what the server has').toEqual([]);
    expect((await status()).tickErrors).toBe(0);
    for (const p of [A, B]) {
      const s = await p.page.evaluate(() => (window as Api).__gta7.state());
      expect(s.crashed).toBe(false);
      expect(s.listenerErrors).toBe(0);
      expect(s.render.tier).toBe('high');
      expect(appErrors(p.errors)).toEqual([]);
    }
    await A.ctx.close();
    await B.ctx.close();
  });
});
