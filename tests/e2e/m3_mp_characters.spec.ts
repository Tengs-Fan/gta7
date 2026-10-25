// Mission 3 characters in multiplayer (VAL-CHR-010): two clients of a real game server each draw the other player
// whole as a skinned model, every player has his own look and the same one on both clients, only the local player's
// own body takes the near-lens dissolve, and a remote player's tracer leaves the muzzle of the gun drawn in his hands.
// The server listens on GTA7_MP_PORT (default 4210).

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { boot, type Api } from './helpers';

const MP_PORT = Number(process.env.GTA7_MP_PORT ?? 4210);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
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

const mpUrl = (name: string) => `/?intro=0&mp=1&server=127.0.0.1:${MP_PORT}&room=chars&name=${name}`;
const appErrors = (errors: string[]) => errors.filter((e) => !/WebSocket connection to .* failed/i.test(e));
const debug = (page: Page, arg: Record<string, unknown>) => page.evaluate((a) => (window as Api).__gta7.net.command('debug', a), arg);

/** Both players' character ids on a client, with the look each is drawn with there (null: not drawn skinned). */
async function looks(page: Page): Promise<{ me: number; players: Array<{ name: string; characterId: number; drawn: { look: string; lens: boolean; near: boolean } | null }> }> {
  return page.evaluate(() => {
    const g = (window as Api).__gta7;
    const me = g.net.state().playerId as number;
    const players = g.net.players() as Array<{ playerId: number; name: string; characterId: number }>;
    return {
      me: players.find((p) => p.playerId === me)!.characterId,
      players: players.map((p) => ({ name: p.name, characterId: p.characterId, drawn: g.ext.characters.lookOf(p.characterId) ?? null })),
    };
  });
}

/** Points the client's camera from behind its own player towards the other one. */
async function lookAtOther(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    const me = g.net.state().playerId as number;
    const ps = g.net.players() as Array<{ playerId: number; x: number; z: number }>;
    const a = ps.find((p) => p.playerId === me)!;
    const b = ps.find((p) => p.playerId !== me)!;
    g.setCamera(Math.atan2(b.x - a.x, b.z - a.z), -0.05);
  });
}

test.describe('multiplayer characters', () => {
  test.beforeAll(startServer);
  test.afterAll(stopServer);

  test('each client draws the other player whole and skinned, with his own look, the same on both clients', async ({ page, browser }, info) => {
    const errorsA = await boot(page, mpUrl('Ana'));
    await page.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 15_000 });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageB = await ctx.newPage();
    const errorsB = await boot(pageB, mpUrl('Ben'));
    await pageB.waitForFunction(() => (window as Api).__gta7.net?.state().state === 'connected', null, { timeout: 15_000 });
    for (const p of [page, pageB]) await p.waitForFunction(() => (window as Api).__gta7.net.players().length === 2, null, { timeout: 10_000 });

    // Side by side in a quiet street at noon.
    const bank = await page.evaluate(() => (window as Api).__gta7.poi('bank'));
    await debug(page, { teleport: [bank.x - 2, bank.z], godMode: true });
    await debug(pageB, { teleport: [bank.x - 2, bank.z - 5], godMode: true });
    await page.waitForTimeout(2500);
    await lookAtOther(page);
    await lookAtOther(pageB);
    await page.waitForTimeout(1200);
    const a = await looks(page);
    const b = await looks(pageB);
    console.log(`[m3-mp-characters] client A ${JSON.stringify(a)}; client B ${JSON.stringify(b)}`);
    await page.screenshot({ path: info.outputPath('mp-client-a.png') });
    await pageB.screenshot({ path: info.outputPath('mp-client-b.png') });
    for (const [client, other] of [[a, b], [b, a]] as const) {
      expect(client.players.length).toBe(2);
      for (const p of client.players) {
        expect(p.drawn, `${p.name} drawn skinned`).not.toBeNull();
        // The same look for each player on both clients.
        expect(p.drawn!.look).toBe(other.players.find((q) => q.characterId === p.characterId)!.drawn!.look);
        // Only the local player's own body dissolves at the lens.
        expect(p.drawn!.lens).toBe(p.characterId === client.me);
      }
      expect(client.players[0]!.drawn!.look).not.toBe(client.players[1]!.drawn!.look);
    }

    // Ana aims and fires a pistol: on Ben's screen the tracer leaves the muzzle drawn in her hands.
    await debug(page, { give: ['pistol', 50] });
    await page.waitForTimeout(500);
    await pageB.evaluate(() => {
      const g = (window as Api).__gta7;
      const fx = g.game.renderer.effects;
      (window as Api).__tracers = [];
      const orig = fx.tracer.bind(fx);
      fx.tracer = (...t: number[]) => {
        const T = g.game.renderer.crowd.weapons.get('pistol');
        const cam = g.game.renderer.cameraCtl.camera;
        const M = cam.matrixWorld.clone();
        const muzzles: number[][] = [];
        for (let i = 0; i < T.mesh.count; i++) {
          T.mesh.getMatrixAt(i, M);
          const v = cam.position.clone().set(0, 0, 0.21).applyMatrix4(M);
          muzzles.push([v.x, v.y, v.z]);
        }
        (window as Api).__tracers.push({ t, muzzles });
        return orig(...t);
      };
    });
    const box = await page.locator('canvas').first().boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(900);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
    await pageB.waitForFunction(() => (window as Api).__tracers.length > 0, null, { timeout: 5000 });
    await page.mouse.up({ button: 'right' });
    const shot = await pageB.evaluate(() => {
      const g = (window as Api).__gta7;
      const cam = g.game.renderer.cameraCtl.camera;
      const r = (window as Api).__tracers[0] as { t: number[]; muzzles: number[][] };
      const from = cam.position.clone().set(r.t[0], r.t[1], r.t[2]);
      let best = Infinity;
      for (const m of r.muzzles) best = Math.min(best, from.distanceTo(cam.position.clone().set(m[0], m[1], m[2])));
      // Pixels at 1080p from 1.5 m: focal length in px times the world error over the distance.
      const focal = 540 / Math.tan((cam.fov * Math.PI) / 360);
      return { worldErr: best, px15: (focal * best) / 1.5, guns: r.muzzles.length };
    });
    console.log(`[m3-mp-characters] remote tracer vs drawn muzzle ${JSON.stringify(shot)}`);
    expect(shot.guns).toBeGreaterThan(0);
    expect(shot.px15).toBeLessThanOrEqual(4);

    await ctx.close();
    expect(appErrors(errorsA)).toEqual([]);
    expect(appErrors(errorsB)).toEqual([]);
  });
});
