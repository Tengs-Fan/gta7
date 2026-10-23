// The multiplayer client in the browser against a real game server process: joining by URL, the mirror's entity
// counts against the server's interest set, a second player seen by the first, losing the server and reconnecting,
// an unreachable address, and single player opening no socket. The server listens on GTA7_MP_PORT (default 4210).

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { boot, type Api } from './helpers';

const MP_PORT = Number(process.env.GTA7_MP_PORT ?? 4210);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  server = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['server/main.ts', '--port', String(MP_PORT), '--host', '127.0.0.1', '--dev', '--puppets', '--status-every', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function status(): Promise<{ rooms: Array<{ id: string; members: Array<{ playerId: number; interest: number }> }> }> {
  const r = await fetch(`http://127.0.0.1:${MP_PORT}/status`);
  return r.json();
}

const mpUrl = (name: string, server = `127.0.0.1:${MP_PORT}`) => `/?intro=0&mp=1&server=${server}&room=e2e&name=${name}`;
const net = (page: Page) => page.evaluate(() => (window as Api).__gta7.net?.state() ?? null);

/** WebSocket failure notices of the browser itself while a server is down are allowed; nothing else is. */
const appErrors = (errors: string[]) => errors.filter((e) => !/WebSocket connection to .* failed/i.test(e));

test.describe('multiplayer client', () => {
  test.beforeAll(startServer);
  test.afterAll(stopServer);

  test('joins by URL, draws the world from snapshots and holds what the server sends it', async ({ page, browser }) => {
    const errors = await boot(page, mpUrl('A'));
    await page.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 15_000 });
    const s = await net(page);
    expect(s.playerId).toBeGreaterThan(0);
    expect(s.slot).toBe(0);
    expect(s.rtt).toBeGreaterThanOrEqual(0);
    expect(s.counts.vehicles).toBeGreaterThan(0);
    expect(s.counts.characters).toBeGreaterThan(0);
    // The mirror holds the server's interest set for this player (within a snapshot of each other).
    let matched = false;
    for (let i = 0; i < 10 && !matched; i++) {
      const before = (await net(page)).counts.total;
      const st = await status();
      const after = (await net(page)).counts.total;
      const interest = st.rooms.find((r) => r.id === 'e2e')!.members.find((m) => m.playerId === s.playerId)!.interest;
      matched = interest === before || interest === after;
    }
    expect(matched).toBe(true);
    const state = await page.evaluate(() => (window as Api).__gta7.state());
    expect(state.mode).toBe('game');
    expect(state.render.tier).toBe('high');
    expect(state.crashed).toBe(false);
    expect(state.listenerErrors).toBe(0);
    expect(await page.locator('.hud').first().isVisible()).toBe(true);

    // A second player in the room is in the first one's player list, and the other way round.
    const ctx = await browser.newContext();
    const pageB = await ctx.newPage();
    const errorsB = await boot(pageB, mpUrl('B'));
    await pageB.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 15_000 });
    await page.waitForFunction(() => (window as Api).__gta7.net.players().some((p: { name: string }) => p.name === 'B'), null, { timeout: 5000 });
    const seen = await pageB.evaluate(() => (window as Api).__gta7.net.players().map((p: { name: string }) => p.name));
    expect(seen).toContain('A');
    await ctx.close();
    expect(appErrors(errors)).toEqual([]);
    expect(appErrors(errorsB)).toEqual([]);
  });

  test('losing the server says so within 3 s; RECONNECT joins again once it is back', async ({ page }) => {
    const errors = await boot(page, mpUrl('A'));
    await page.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 15_000 });
    const first = (await net(page)).playerId;
    const t0 = Date.now();
    await stopServer();
    await page.waitForSelector('.net-status.lost', { timeout: 3000 });
    expect(Date.now() - t0).toBeLessThan(3000);
    await expect(page.locator('.net-status')).toContainText('Connection to the server was lost');
    expect((await page.evaluate(() => (window as Api).__gta7.state())).crashed).toBe(false);
    await startServer();
    await page.locator('.net-status button', { hasText: 'RECONNECT' }).click();
    await page.waitForFunction(() => (window as Api).__gta7.net.state().state === 'connected', null, { timeout: 15_000 });
    const again = await net(page);
    expect(again.connects).toBe(2);
    expect(again.counts.total).toBeGreaterThan(0);
    expect(await page.locator('.net-status').count()).toBe(0);
    expect(again.playerId).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(0);
    // Back to the title, then a single-player game.
    await page.keyboard.press('Escape');
    await page.locator('button', { hasText: 'QUIT' }).first().click();
    const yes = page.locator('button', { hasText: 'YES' });
    if (await yes.count()) await yes.first().click();
    await page.waitForFunction(() => (window as Api).__gta7.state().mode === 'title');
    expect((await page.evaluate(() => (window as Api).__gta7.net.state())).state).toBe('off');
    expect(appErrors(errors)).toEqual([]);
  });

  test('an address with nothing behind it fails cleanly with TRY AGAIN and BACK TO TITLE', async ({ page }) => {
    const errors = await boot(page, mpUrl('A', '127.0.0.1:4299'));
    await page.waitForSelector('.net-status.failed', { timeout: 5000 });
    await expect(page.locator('.net-status')).toContainText('Could not connect to ws://127.0.0.1:4299/ws');
    await page.locator('.net-status button', { hasText: 'BACK TO TITLE' }).click();
    expect(await page.evaluate(() => (window as Api).__gta7.state().mode)).toBe('title');
    expect(appErrors(errors)).toEqual([]);
  });

  test('single player opens no socket and loads no client code', async ({ page }) => {
    const errors = await boot(page, '/?intro=0');
    await page.evaluate(() => (window as Api).__gta7.newGame({ intro: false }));
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => ({
      net: (window as Api).__gta7.net,
      sockets: performance.getEntriesByType('resource').filter((e) => /^wss?:/.test(e.name)).length,
      session: performance.getEntriesByType('resource').some((e) => /session-.*\.js/.test(e.name)),
    }));
    expect(r).toEqual({ net: undefined, sockets: 0, session: false });
    expect(errors).toEqual([]);
  });
});
