// Multiplayer cross-area flows with two real players (VAL-MPX-001, 002, 004, 005, 007) against a real game server
// process: each sees the other walk and drive where the server has him, the police chase only the wanted one, a boat
// at the Marina for the second player, and leaving and rejoining. The server listens on GTA7_MP_PORT (default 4210)
// with --dev, whose 'debug' command only prepares scenes (a car, a wanted level, a spot); the actions are real keys.

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { boot, type Api } from './helpers';

const MP_PORT = Number(process.env.GTA7_MP_PORT ?? 4210);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
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
  police: { units: number; chasing: number; officers: number; helis: number; nearest: number | null };
}
interface RoomStatus {
  id: string;
  tickRate: number;
  snapshotRate: number;
  tickErrors: number;
  members: Array<{ playerId: number; name: string; slot: number; player: ServerPlayer | null }>;
}

async function room(id: string): Promise<RoomStatus | undefined> {
  const r = await fetch(`http://127.0.0.1:${MP_PORT}/status`);
  return ((await r.json()) as { rooms: RoomStatus[] }).rooms.find((x) => x.id === id);
}

async function serverPlayers(id: string): Promise<Record<string, ServerPlayer>> {
  const r = await room(id);
  return Object.fromEntries((r?.members ?? []).filter((m) => m.player).map((m) => [m.name, m.player!]));
}

/** WebSocket failure notices of the browser itself in deliberate disconnects are allowed; nothing else is. */
const appErrors = (errors: string[]) => errors.filter((e) => !/WebSocket connection to .* failed/i.test(e));

interface Player {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

async function joinRoom(browser: Browser, name: string, roomId: string): Promise<Player> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = await boot(page, `/?intro=0&mp=1&server=127.0.0.1:${MP_PORT}&room=${roomId}&name=${name}`);
  await page.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 20_000 });
  return { ctx, page, errors };
}

const debug = (p: Player, arg: Record<string, unknown>) => p.page.evaluate((a) => (window as Api).__gta7.net.command('debug', a), arg);
const seen = (p: Player, name: string) =>
  p.page.evaluate((n) => (window as Api).__gta7.net.players().find((x: { name: string }) => x.name === n) ?? null, name) as Promise<{ x: number; z: number; wanted: number } | null>;
const names = (p: Player) => p.page.evaluate(() => (window as Api).__gta7.net.players().map((x: { name: string }) => x.name).sort()) as Promise<string[]>;
const local = (p: Player) => p.page.evaluate(() => (window as Api).__gta7.net.local());

/** Where `viewer` draws `name`, against the server's position at about the same moment (the closer of before/after). */
async function viewError(viewer: Player, name: string, roomId: string): Promise<{ d: number; speed: number; inVehicle: boolean }> {
  const t0 = Date.now();
  const before = (await serverPlayers(roomId))[name]!;
  const v = (await drawn(viewer, name))!;
  const after = (await serverPlayers(roomId))[name]!;
  const dt = Math.max(0.05, (Date.now() - t0) / 1000);
  const d = Math.min(Math.hypot(v.x - before.x, v.z - before.z), Math.hypot(v.x - after.x, v.z - after.z));
  return { d, speed: Math.hypot(after.x - before.x, after.z - before.z) / dt, inVehicle: !!after.vehicle };
}

/** Where `viewer` draws `name` in its next frame (between frames the mirror may hold a snapshot not yet interpolated). */
const drawn = (p: Player, name: string) =>
  p.page.evaluate(
    (n) => new Promise((res) => requestAnimationFrame(() => res((window as Api).__gta7.net.players().find((x: { name: string }) => x.name === n) ?? null))),
    name,
  ) as Promise<{ x: number; z: number } | null>;

/** The server's positions of player `name`, polled every ~50 ms until stopped (Date.now() stamps). */
function track(roomId: string, name: string): { samples: Array<{ t: number; x: number; z: number; vehicle: boolean }>; stop: () => Promise<void> } {
  const samples: Array<{ t: number; x: number; z: number; vehicle: boolean }> = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const p = (await serverPlayers(roomId))[name];
      if (p) samples.push({ t: Date.now(), x: p.x, z: p.z, vehicle: !!p.vehicle });
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  return { samples, stop: async () => {
    on = false;
    await loop;
  } };
}

test.describe('multiplayer cross-area flows', () => {
  test.beforeAll(startServer);
  test.afterAll(stopServer);

  test('two players see each other walk, get in a car and drive where the server has them', async ({ browser }) => {
    const A = await joinRoom(browser, 'Ann', 'x-see');
    const B = await joinRoom(browser, 'Bea', 'x-see');
    await A.page.waitForFunction(() => (window as Api).__gta7.net.players().length === 2, null, { timeout: 5000 });
    expect(await names(A)).toEqual(['Ann', 'Bea']);
    expect(await names(B)).toEqual(['Ann', 'Bea']);
    // B steps aside so A's walk does not push him (they spawn one behind the other).
    await B.page.keyboard.down('d');
    await B.page.waitForTimeout(500);
    await B.page.keyboard.up('d');
    // A walks with real W; B's view of A is within 2 m of the server's A throughout.
    await A.page.bringToFront();
    await A.page.keyboard.down('w');
    let walked = 0;
    for (let i = 0; i < 6; i++) {
      await A.page.waitForTimeout(400);
      const e = await viewError(B, 'Ann', 'x-see');
      expect(e.inVehicle).toBe(false);
      expect(e.d, 'A walking as drawn on B vs server').toBeLessThan(2);
      walked = Math.max(walked, e.speed);
    }
    await A.page.keyboard.up('w');
    expect(walked).toBeGreaterThan(1);
    // A gets a car next to him and drives it with real W; B sees him in it, moving, within 2 m of where the server had
    // him during the last interpolation delay plus a snapshot interval and the round trip (VAL-MPX-001 allows for it).
    await debug(A, { drive: 'sedan' });
    await A.page.waitForFunction(() => (window as Api).__gta7.net.local().vehicle !== null, null, { timeout: 5000 });
    const hist = track('x-see', 'Ann');
    await A.page.keyboard.down('w');
    let worst = 0;
    for (let i = 0; i < 10; i++) {
      await A.page.waitForTimeout(350);
      const net = (await B.page.evaluate(() => (window as Api).__gta7.net.state())) as { interpDelayMs: number; rtt: number };
      const v = (await drawn(B, 'Ann'))!;
      const now = Date.now();
      const span = net.interpDelayMs + 40 + net.rtt + 150;
      const near = hist.samples.filter((s) => s.t >= now - span && s.vehicle);
      expect(near.length, 'server samples in the window').toBeGreaterThan(0);
      const d = Math.min(...near.map((s) => Math.hypot(v.x - s.x, v.z - s.z)));
      expect(d, `A's car as drawn on B vs the server's within ${span} ms`).toBeLessThan(2);
      worst = Math.max(worst, d);
    }
    await A.page.keyboard.up('w');
    await hist.stop();
    const s = hist.samples;
    const travelled = Math.hypot(s.at(-1)!.x - s[0]!.x, s.at(-1)!.z - s[0]!.z);
    expect(travelled, 'A drove').toBeGreaterThan(10);
    console.log(`[mp_cross] A's car on B: worst ${worst.toFixed(2)} m from the server's track; A drove ${travelled.toFixed(0)} m`);
    // B's mirror has A's character seated in the car it draws.
    const aId = (await local(A)).id;
    const seat = await B.page.evaluate((id) => {
      const c = (window as Api).__gta7.game.view.characters.find((x: { id: number }) => x.id === id);
      return c ? { state: c.state, vehicle: c.vehicle?.kind ?? null } : null;
    }, aId);
    expect(seat).toEqual({ state: 'inVehicle', vehicle: 'sedan' });
    // And the other way round: B walks, A sees it.
    await B.page.bringToFront();
    await B.page.keyboard.down('w');
    await B.page.waitForTimeout(800);
    const eb = await viewError(A, 'Bea', 'x-see');
    await B.page.keyboard.up('w');
    expect(eb.d).toBeLessThan(2);
    for (const p of [A, B]) {
      const s = await p.page.evaluate(() => (window as Api).__gta7.state());
      expect(s.crashed).toBe(false);
      expect(s.listenerErrors).toBe(0);
      expect(s.render.tier).toBe('high');
    }
    expect(appErrors(A.errors)).toEqual([]);
    expect(appErrors(B.errors)).toEqual([]);
    await A.ctx.close();
    await B.ctx.close();
  });

  test('the police chase the wanted player only: the other stands by at 0 stars, untouched, and sees the chase', async ({ browser }) => {
    const A = await joinRoom(browser, 'Ann', 'x-chase');
    const B = await joinRoom(browser, 'Bea', 'x-chase');
    const bId = (await local(B)).id as number;
    // Setup: A at 3 stars in god mode (so the chase lasts), B 12 m away at 0 stars.
    const start = (await serverPlayers('x-chase')).Ann!;
    await debug(B, { teleport: [start.x + 12, start.z] });
    await debug(A, { godMode: true, wanted: 3 });
    let chased = false;
    let bSawChase = false;
    let aHud = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 25_000) {
      await A.page.waitForTimeout(1000);
      const s = await serverPlayers('x-chase');
      const [la, lb] = await Promise.all([local(A), local(B)]);
      // B: never wanted, never the target of a police car, on his own HUD and on the server.
      expect(s.Bea!.wanted).toBe(0);
      expect(lb.wanted).toBe(0);
      expect(s.Bea!.police.chasing).toBe(0);
      if (s.Ann!.wanted > 0 && s.Ann!.police.chasing + s.Ann!.police.officers > 0) chased = true;
      aHud = Math.max(aHud, la.wanted);
      const pol = await B.page.evaluate(() => (window as Api).__gta7.net.police());
      const nearA = [...pol.cars, ...pol.officers].filter((c: { x: number; z: number }) => Math.hypot(c.x - s.Ann!.x, c.z - s.Ann!.z) < 60).length;
      if (nearA > 0 && s.Ann!.wanted > 0) bSawChase = true;
      if (chased && bSawChase && Date.now() - t0 > 12_000) break;
    }
    expect(chased, 'police units chase A').toBe(true);
    expect(bSawChase, "B's client draws police round A").toBe(true);
    expect(aHud).toBeGreaterThanOrEqual(1);
    // Nothing the police did hurt B or arrested him.
    const bLog = (await B.page.evaluate(() => (window as Api).__gta7.net.events(400))) as Array<{ type: string; refs: Record<string, number>; playerId?: number }>;
    const lawIds = new Set(await B.page.evaluate(() => (window as Api).__gta7.game.view.characters.filter((c: { isLaw: boolean }) => c.isLaw).map((c: { id: number }) => c.id)));
    expect(bLog.filter((e) => e.type === 'damage' && e.refs.victim === bId && lawIds.has(e.refs.attacker!))).toEqual([]);
    const bPlayer = (await B.page.evaluate(() => (window as Api).__gta7.net.state().playerId)) as number;
    expect(bLog.filter((e) => (e.type === 'busted' || e.type === 'wasted') && e.playerId === bPlayer)).toEqual([]);
    expect(appErrors(A.errors)).toEqual([]);
    expect(appErrors(B.errors)).toEqual([]);
    await A.ctx.close();
    await B.ctx.close();
  });

  test('the second player alone at the Marina takes a moored boat; the other sees him in it', async ({ browser }) => {
    const A = await joinRoom(browser, 'Ann', 'x-boat');
    const B = await joinRoom(browser, 'Bea', 'x-boat');
    // Setup: B (not the room's first player) on the finger pier by the dinghy's mooring; A stays across town.
    await debug(B, { teleport: [643.2, 459] });
    await B.page.waitForFunction(() => (window as Api).__gta7.game.view.vehicles.some((v: { spec: { class: string }; removed: boolean }) => !v.removed && v.spec.class === 'boat'), null, { timeout: 8000 });
    await B.page.bringToFront();
    await B.page.waitForTimeout(500);
    await B.page.keyboard.press('f');
    await B.page.waitForFunction(() => (window as Api).__gta7.net.local().vehicle?.kind === 'dinghy', null, { timeout: 6000 });
    await B.page.keyboard.down('w');
    await B.page.waitForTimeout(2500);
    await B.page.keyboard.up('w');
    const s = (await serverPlayers('x-boat')).Bea!;
    expect(s.vehicle?.kind).toBe('dinghy');
    const onA = (await seen(A, 'Bea'))!;
    expect(Math.hypot(onA.x - s.x, onA.z - s.z)).toBeLessThan(4);
    const bId = (await local(B)).id;
    const seatOnA = await A.page.evaluate((id) => (window as Api).__gta7.game.view.characters.find((c: { id: number }) => c.id === id)?.vehicle?.kind ?? null, bId);
    expect(seatOnA).toBe('dinghy');
    expect(appErrors(A.errors)).toEqual([]);
    expect(appErrors(B.errors)).toEqual([]);
    await A.ctx.close();
    await B.ctx.close();
  });

  test('a player who closes his page leaves within 2 s; the room carries on, and a new player joins and sees the one still there', async ({ browser }) => {
    const A = await joinRoom(browser, 'Ann', 'x-leave');
    const B = await joinRoom(browser, 'Bea', 'x-leave');
    await A.page.waitForFunction(() => (window as Api).__gta7.net.players().length === 2, null, { timeout: 5000 });
    // B's page goes away without leaving through the menu.
    const t0 = Date.now();
    await B.ctx.close();
    await A.page.waitForFunction(() => !(window as Api).__gta7.net.players().some((p: { name: string }) => p.name === 'Bea'), null, { timeout: 2000 });
    expect(Date.now() - t0).toBeLessThan(2500);
    // A keeps playing: snapshots at 20-30 Hz, and he can still move.
    const n0 = (await A.page.evaluate(() => (window as Api).__gta7.net.state().snapshots)) as number;
    await A.page.bringToFront();
    await A.page.keyboard.down('w');
    await A.page.waitForTimeout(2000);
    await A.page.keyboard.up('w');
    const n1 = (await A.page.evaluate(() => (window as Api).__gta7.net.state().snapshots)) as number;
    expect((n1 - n0) / 2).toBeGreaterThanOrEqual(18);
    expect((n1 - n0) / 2).toBeLessThanOrEqual(32);
    const r = (await room('x-leave'))!;
    expect(r.members.map((m) => m.name)).toEqual(['Ann']);
    expect(r.tickErrors).toBe(0);
    // A new player joins the same room and sees A where the server has him; A sees him.
    const D = await joinRoom(browser, 'Dot', 'x-leave');
    await A.page.waitForFunction(() => (window as Api).__gta7.net.players().some((p: { name: string }) => p.name === 'Dot'), null, { timeout: 2000 });
    expect(await names(D)).toEqual(['Ann', 'Dot']);
    const e = await viewError(D, 'Ann', 'x-leave');
    expect(e.d).toBeLessThan(2);
    // A leaves through the pause menu and joins again as a new player: D drops and then sees him.
    await A.page.keyboard.press('Escape');
    await A.page.locator('button', { hasText: 'QUIT' }).first().click();
    const yes = A.page.locator('button', { hasText: 'YES' });
    if (await yes.count()) await yes.first().click();
    await A.page.waitForFunction(() => (window as Api).__gta7.state().mode === 'title');
    await D.page.waitForFunction(() => !(window as Api).__gta7.net.players().some((p: { name: string }) => p.name === 'Ann'), null, { timeout: 2000 });
    await A.page.evaluate((port) => (window as Api).__gta7.net.join({ server: `127.0.0.1:${port}`, room: 'x-leave', name: 'Ann' }), MP_PORT);
    await A.page.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 15_000 });
    await D.page.waitForFunction(() => (window as Api).__gta7.net.players().some((p: { name: string }) => p.name === 'Ann'), null, { timeout: 3000 });
    expect(await names(A)).toEqual(['Ann', 'Dot']);
    expect(serverLog).not.toMatch(/\[error\]|failed/);
    expect(appErrors(A.errors)).toEqual([]);
    expect(appErrors(D.errors)).toEqual([]);
    await A.ctx.close();
    await D.ctx.close();
  });
});
