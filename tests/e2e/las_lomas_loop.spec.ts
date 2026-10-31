// The Las Lomas Loop head to head: two clients join a room by URL, one opens the loop from the pause menu's STREET RUNS,
// the other joins, both hold W off the grid at GO, west down Magnolia Ave and through the causeway gate at Harbor Blvd,
// with Dry Creek's junction held green for them on the server. The server listens on GTA7_MP_PORT (default 4210).

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { boot, type Api } from './helpers';

const MP_PORT = Number(process.env.GTA7_MP_PORT ?? 4210);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const ROOM = 'e2e-laslomas';
let server: ChildProcess | null = null;

test.beforeAll(async () => {
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
});

test.afterAll(async () => {
  const p = server;
  server = null;
  if (!p || p.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    p.once('exit', () => resolve());
    p.kill('SIGTERM');
    setTimeout(() => p.kill('SIGKILL'), 4000).unref();
  });
});

const appErrors = (errors: string[]) => errors.filter((e) => !/WebSocket connection to .* failed/i.test(e));

/** Pause menu > STREET RUNS > the button with this id (real clicks). */
async function raceMenu(page: Page, id: string): Promise<void> {
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(350);
  await page.locator('button[data-id="mp-races"]').click();
  await page.waitForTimeout(350);
  await page.locator(`button[data-id="${id}"]`).click();
  await page.waitForFunction(() => !document.querySelector('.screen'));
}

const race = (page: Page) => page.evaluate(() => (window as Api).__gta7.net.room().state?.race);

test('races the Las Lomas Loop head to head through the causeway gate', async ({ browser, page }) => {
  test.setTimeout(240_000);
  const url = (name: string) => `/?intro=0&mp=1&server=127.0.0.1:${MP_PORT}&room=${ROOM}&name=${name}`;
  const errorsA = await boot(page, url('Ann'));
  const ctx = await browser.newContext();
  const pageB = await ctx.newPage();
  const errorsB = await boot(pageB, url('Bea'));
  for (const p of [page, pageB]) await p.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 20_000 });
  await page.waitForFunction(() => (window as Api).__gta7.net.players().length === 2);

  // A opens the loop, B joins, A starts it.
  await raceMenu(page, 'race-open-laslomas');
  await pageB.waitForFunction(() => (window as Api).__gta7.net.room().state?.race?.stage === 'lobby');
  expect((await race(pageB)).courseId).toBe('laslomas');
  await raceMenu(pageB, 'race-join');
  await page.waitForFunction(() => (window as Api).__gta7.net.room().state?.race?.entrants.length === 2);
  await raceMenu(page, 'race-start');
  for (const p of [page, pageB]) await p.waitForFunction(() => (window as Api).__gta7.net.room().state?.race?.stage === 'racing', null, { timeout: 15_000 });

  // Both hold W: Magnolia Ave's last junction, then Harbor Blvd's, where the Magnolia Causeway leaves for the county.
  await page.keyboard.down('KeyW');
  await pageB.keyboard.down('KeyW');
  try {
    for (const p of [page, pageB]) {
      await p.waitForFunction(() => {
        const g = (window as Api).__gta7;
        const me = g.net.room().state?.race?.entrants.find((e: Api) => e.playerId === g.net.state().playerId);
        return (me?.gate ?? 0) >= 2;
      }, null, { timeout: 60_000 });
    }
  } finally {
    await page.keyboard.up('KeyW');
    await pageB.keyboard.up('KeyW');
  }
  const r = await race(page);
  expect(r.entrants.map((e: Api) => e.status)).toEqual(['racing', 'racing']);
  for (const e of r.entrants) expect(e.gate).toBeGreaterThanOrEqual(2);
  const car = await page.evaluate(() => (window as Api).__gta7.net.local().vehicle);
  expect(car.x).toBeLessThan(-440);
  expect(appErrors(errorsA)).toEqual([]);
  expect(appErrors(errorsB)).toEqual([]);
  await ctx.close();
});
