// Multiplayer rules and lobby in two browsers against a real game server: joining from the title's MULTIPLAYER screen
// (one player with the mouse, one with the keyboard), the player list, name tags over the other player (and none over
// yourself or behind the camera), and a head-to-head Street Run: opened and joined from the pause menu, one countdown
// with both locked until GO, one player driven round the course by the keyboard bot through real key presses, the other
// quitting (DNF), and the same results on both screens. The server listens on GTA7_MP_PORT (default 4210).

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { buildStreetRunCourses } from '../../src/sim/streetRuns';
import { StaticWorld } from '../../src/world/staticWorld';
import { boot, type Api } from './helpers';
import { BOT_KEYS, coursePath, KeyboardBot, type BotCar, type BotKeys, type BotObstacle } from './keyboardBot';

const MP_PORT = Number(process.env.GTA7_MP_PORT ?? 4210);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const ROOM = 'e2e-lobby';
let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  server = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['server/main.ts', '--port', String(MP_PORT), '--host', '127.0.0.1', '--dev', '--status-every', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30_000);
    const check = (d: Buffer) => {
      out += d.toString();
      if (out.includes('listening on')) {
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

const connected = (page: Page) => page.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 20_000 });
const room = (page: Page) => page.evaluate(() => (window as Api).__gta7.net.room());
const local = (page: Page) => page.evaluate(() => (window as Api).__gta7.net.local());

/** Pause menu > STREET RUNS > the button with this id (real clicks). */
async function raceMenu(page: Page, id: string): Promise<void> {
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(350);
  await page.locator('button[data-id="mp-races"]').click();
  await page.waitForTimeout(350);
  await page.locator(`button[data-id="${id}"]`).click();
  await page.waitForFunction(() => !document.querySelector('.screen'));
}

/** What the bot may know in multiplayer: its car as the client draws it and what is around it in the mirror. */
async function look(page: Page): Promise<{ stage: string | null; status: string; car: BotCar | null; obstacles: BotObstacle[] }> {
  return page.evaluate(() => {
    const g = (window as Api).__gta7;
    const view = g.game.view;
    const r = g.net.room();
    const me = view.players.find((p: Api) => p.id === g.net.state().playerId);
    const car = me?.character.vehicle;
    const mine = r.state?.race?.entrants.find((e: Api) => e.playerId === g.net.state().playerId);
    const stage = r.state?.race?.stage ?? null;
    if (!car) return { stage, status: mine?.status ?? '', car: null, obstacles: [] };
    const near = (x: number, z: number) => Math.abs(x - car.pos.x) < 60 && Math.abs(z - car.pos.z) < 60;
    const obstacles: BotObstacle[] = [];
    for (const v of view.vehicles) if (v !== car && !v.removed && near(v.pos.x, v.pos.z)) obstacles.push({ x: v.pos.x, z: v.pos.z, heading: v.heading, halfL: v.halfL, halfW: v.halfW, vx: v.vel.x, vz: v.vel.z });
    for (const c of view.characters) if (!c.removed && !c.vehicle && c !== me.character && near(c.pos.x, c.pos.z)) obstacles.push({ x: c.pos.x, z: c.pos.z, heading: 0, halfL: 0.4, halfW: 0.4, vx: c.vel.x, vz: c.vel.z });
    return {
      stage,
      status: mine?.status ?? '',
      car: { x: car.pos.x, z: car.pos.z, heading: car.heading, speed: car.forwardSpeed, wheel: car.steer, halfL: car.halfL, halfW: car.halfW, length: car.spec.length, steer: car.spec.steer },
      obstacles,
    };
  });
}

async function setKeys(page: Page, held: BotKeys, want: BotKeys): Promise<void> {
  for (const k of BOT_KEYS) {
    if (want[k] === held[k]) continue;
    if (want[k]) await page.keyboard.down(k);
    else await page.keyboard.up(k);
    held[k] = want[k];
  }
}

const appErrors = (errors: string[]) => errors.filter((e) => !/WebSocket connection to .* failed/i.test(e));

test.describe('multiplayer lobby', () => {
  test.beforeAll(startServer);
  test.afterAll(stopServer);

  test('joins from the MULTIPLAYER screen, lists the players, tags the other one and races head to head', async ({ browser, page }, testInfo) => {
    test.setTimeout(420_000);
    const server = `127.0.0.1:${MP_PORT}`;
    // A: the mouse.
    const errorsA = await boot(page, '/?intro=0');
    await page.locator('button[data-id="multiplayer"]').click();
    await expect(page.locator('input[name="mp-server"]')).toHaveValue('ws://localhost:4210');
    await expect(page.locator('input[name="mp-room"]')).toHaveValue('lobby');
    await page.locator('button[data-id="mp-join"]').click();
    await expect(page.locator('.mp-join-error')).toHaveText('Enter a name to join.');
    await page.locator('input[name="mp-name"]').fill('  Ann  ');
    await page.locator('input[name="mp-server"]').fill(server);
    await page.locator('input[name="mp-room"]').fill(ROOM);
    await page.locator('button[data-id="mp-join"]').click();
    await connected(page);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gta7.multiplayer.v1')!))).toEqual({ name: 'Ann', server, room: ROOM });

    // B: the keyboard only (arrows, typing, Enter).
    const ctx = await browser.newContext();
    const pageB = await ctx.newPage();
    const errorsB = await boot(pageB, '/?intro=0');
    await pageB.keyboard.press('ArrowDown');
    await pageB.waitForTimeout(150);
    await pageB.keyboard.press('ArrowDown');
    await expect(pageB.locator('button[data-id="multiplayer"]')).toHaveClass(/sel/);
    await pageB.keyboard.press('Enter');
    await expect(pageB.locator('input[name="mp-name"]')).toBeFocused();
    await pageB.keyboard.type('Bea');
    await pageB.keyboard.press('ArrowDown');
    await pageB.keyboard.press('ControlOrMeta+A');
    await pageB.keyboard.type(server);
    await pageB.keyboard.press('ArrowDown');
    await pageB.keyboard.press('ControlOrMeta+A');
    await pageB.keyboard.type(ROOM);
    await pageB.keyboard.press('Enter');
    await connected(pageB);

    // The player list (Tab) on A: both names, A marked.
    await page.waitForFunction(() => (window as Api).__gta7.net.players().length === 2);
    await page.keyboard.press('Tab');
    const rows = page.locator('.mp-players tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(page.locator('.mp-players tr.you')).toContainText('Ann');
    await expect(page.locator('.mp-players')).toContainText('Bea');
    // Past the screen's input guard (a quarter second), the same key closes it.
    await page.waitForTimeout(400);
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => !document.querySelector('.screen'));

    // Name tags: A 15 m ahead of B's camera has one with her name; B has none over himself; behind the camera, none.
    const bPos = (await local(pageB)).character;
    await page.evaluate(([x, z]) => (window as Api).__gta7.net.command('debug', { teleport: [x, z] }), [bPos.x + 10, bPos.z + 11]);
    await pageB.waitForTimeout(800);
    const aim = async (back: boolean) => pageB.evaluate((behind) => {
      const g = (window as Api).__gta7;
      const me = g.net.local().character;
      const a = g.net.players().find((p: Api) => p.name === 'Ann');
      g.setCamera(Math.atan2(a.x - me.x, a.z - me.z) + (behind ? Math.PI : 0), -0.05);
    }, back);
    await aim(false);
    await pageB.waitForTimeout(400);
    await expect(pageB.locator('.mp-tag')).toHaveCount(1);
    await expect(pageB.locator('.mp-tag')).toHaveText('Ann');
    const tag = (await room(pageB)).tags[0];
    expect(tag.distance).toBeGreaterThan(5);
    expect(tag.distance).toBeLessThan(60);
    await pageB.screenshot({ path: testInfo.outputPath('mplobby-nametag.png') });
    await aim(true);
    await pageB.waitForTimeout(400);
    await expect(pageB.locator('.mp-tag')).toHaveCount(0);

    // The race: A opens Magnolia Rush, B joins, A starts it.
    await raceMenu(page, 'race-open-magnolia');
    await pageB.waitForFunction(() => (window as Api).__gta7.net.room().state?.race?.stage === 'lobby');
    await raceMenu(pageB, 'race-join');
    await page.waitForFunction(() => (window as Api).__gta7.net.room().state?.race?.entrants.length === 2);
    for (const p of [page, pageB]) await expect(p.locator('.mp-race')).toContainText(/Ann[\s\S]*Bea/);
    await raceMenu(page, 'race-start');
    for (const p of [page, pageB]) await p.waitForFunction(() => (window as Api).__gta7.net.room().locked === true, null, { timeout: 5000 });
    // W held through the countdown moves neither car.
    for (const p of [page, pageB]) await p.waitForFunction(() => (window as Api).__gta7.net.local()?.vehicle?.kind === 'sports', null, { timeout: 2000 });
    const gridA = await local(page);
    const gridB = await local(pageB);
    expect(gridA.vehicle?.kind).toBe('sports');
    expect(gridB.vehicle?.kind).toBe('sports');
    await page.keyboard.down('KeyW');
    await pageB.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    const heldA = await local(page);
    const heldB = await local(pageB);
    expect(Math.hypot(heldA.vehicle.x - gridA.vehicle.x, heldA.vehicle.z - gridA.vehicle.z)).toBeLessThan(0.3);
    expect(Math.hypot(heldB.vehicle.x - gridB.vehicle.x, heldB.vehicle.z - gridB.vehicle.z)).toBeLessThan(0.3);
    await page.keyboard.up('KeyW');
    await pageB.keyboard.up('KeyW');
    for (const p of [page, pageB]) await p.waitForFunction(() => (window as Api).__gta7.net.room().goAt !== null, null, { timeout: 6000 });
    const goA = (await room(page)).goAt as number;
    const goB = (await room(pageB)).goAt as number;
    expect(Math.abs(goA - goB)).toBeLessThan(100);

    // B quits a few seconds in (QUIT RACE: DNF, she stays in the room); A drives the course with the bot, real keys only.
    await pageB.waitForTimeout(3000);
    await raceMenu(pageB, 'race-quit');
    // Off the grid, which is also the finish: she drives on down the road and stops.
    await pageB.keyboard.down('KeyW');
    await pageB.waitForTimeout(1800);
    await pageB.keyboard.up('KeyW');
    await pageB.keyboard.down('KeyS');
    await pageB.waitForTimeout(1200);
    await pageB.keyboard.up('KeyS');
    const world = new StaticWorld();
    const course = buildStreetRunCourses(world.roads).find((c) => c.id === 'magnolia')!;
    const bot = new KeyboardBot(coursePath(world.roads, course));
    const held: BotKeys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false };
    const deadline = Date.now() + (course.bronze + 20) * 1000;
    try {
      for (;;) {
        const seen = await look(page);
        if (seen.stage !== 'racing' || seen.status !== 'racing' || !seen.car || Date.now() > deadline) break;
        await setKeys(page, held, bot.decide(seen.car, seen.obstacles));
      }
    } finally {
      await setKeys(page, held, { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false });
    }
    for (const p of [page, pageB]) await p.waitForFunction(() => (window as Api).__gta7.net.room().state?.race?.stage === 'results', null, { timeout: 30_000 });
    const resA = (await room(page)).state.race.entrants;
    const resB = (await room(pageB)).state.race.entrants;
    console.log(`[mplobby] results ${JSON.stringify(resA.map((e: Api) => [e.name, e.position, e.status, e.time && e.time.toFixed(2), e.medal]))}`);
    expect(resA).toEqual(resB);
    // The bot through live traffic on a networked car may be held up past the bronze time (an angry driver it touched
    // pulls it out): the race then ends out of time for it, as it must. Either way the results agree and B is DNF.
    expect(resA.map((e: Api) => e.name)).toEqual(['Ann', 'Bea']);
    expect(['finished', 'timeout']).toContain(resA[0].status);
    expect(resA[1]).toMatchObject({ status: 'dnf', reason: 'quit', position: 0 });
    if (resA[0].status === 'finished') {
      expect(resA[0].position).toBe(1);
      expect(resA[0].time).toBeLessThanOrEqual(course.bronze);
      expect(resA[0].time).toBeCloseTo((resA[0].finishTick - (await room(page)).state.race.goTick) / 60, 6);
    }
    for (const p of [page, pageB]) await expect(p.locator('.mp-results')).toBeVisible();
    expect(await page.locator('.mp-results').innerText()).toBe(await pageB.locator('.mp-results').innerText());
    await page.screenshot({ path: testInfo.outputPath('mplobby-results-a.png') });
    await pageB.screenshot({ path: testInfo.outputPath('mplobby-results-b.png') });
    // Nothing was saved in single player's save.
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gta7.save')))).toEqual([]);
    for (const p of [page, pageB]) {
      const s = await p.evaluate(() => (window as Api).__gta7.state());
      expect(s.crashed).toBe(false);
      expect(s.listenerErrors).toBe(0);
    }
    await ctx.close();
    expect(appErrors(errorsA)).toEqual([]);
    expect(appErrors(errorsB)).toEqual([]);
  });
});
