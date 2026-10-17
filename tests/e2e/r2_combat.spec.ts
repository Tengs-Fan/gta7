// Round 2, combat cluster: hitmarkers on real clicks, and hip fire that keeps the camera wide.

import { expect, test, type Page } from '@playwright/test';

import { boot, newGame, type Api } from './helpers';

/** Points the shoulder camera at a world point (it swings round the player as it turns, so a few passes settle it). */
async function aimCamera(page: Page, target: { x: number; y: number; z: number }): Promise<void> {
  for (let k = 0; k < 4; k++) {
    await page.evaluate((t) => {
      const cam = (window as Api).__gta7.game.renderer.cameraCtl;
      const cp = cam.camera.position;
      cam.yaw = Math.atan2(t.x - cp.x, t.z - cp.z);
      cam.pitch = Math.atan2(t.y - cp.y, Math.hypot(t.x - cp.x, t.z - cp.z));
    }, target);
    await page.waitForTimeout(60);
  }
}

/** Records when the hitmarker next shows, relative to the next mouse press on the canvas, and what the next shots hit. */
async function watchHitmarker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Api;
    const rec = { pressAt: -1, shownAt: -1, hits: [] as string[] };
    w.__hm = rec;
    if (!w.__hmObserver) {
      const el = document.querySelector('.hitmarker')!;
      w.__hmObserver = new MutationObserver(() => {
        if (el.classList.contains('show') && w.__hm.shownAt < 0) w.__hm.shownAt = performance.now();
      });
      w.__hmObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
      document.querySelector('canvas')!.addEventListener('mousedown', () => {
        if (w.__hm.pressAt < 0) w.__hm.pressAt = performance.now();
      }, { capture: true });
      w.__gta7.sim.events.on('shot', (e: Api) => {
        if (e.shooter === w.__gta7.sim.player) w.__hm.hits.push(e.hit);
      });
    }
  });
}

const hitmarkerRecord = (page: Page) => page.evaluate(() => (window as Api).__hm as { pressAt: number; shownAt: number; hits: string[] });

test.describe('combat feedback', () => {
  test('a pistol hit on a ped shows the hitmarker at once; a wall or a corpse shows none', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const pedId = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.give('pistol', 60);
      g.setCamera(g.sim.player.heading, -0.12);
      // The test points the camera itself (headless Chromium reports bogus mouse movement under pointer lock).
      g.game.renderer.cameraCtl.sensitivity = 0;
      return g.spawnPedAhead(6);
    });
    await page.waitForTimeout(400);
    // The first click may only capture the mouse (pointer lock); spend it on the sky.
    await page.evaluate(() => {
      const cam = (window as Api).__gta7.game.renderer.cameraCtl;
      cam.pitch = 0.9;
    });
    await page.waitForTimeout(100);
    await page.mouse.click(640, 360);
    await page.waitForTimeout(400);
    const chest = () =>
      page.evaluate((id) => {
        const c = (window as Api).__gta7.sim.characters.find((x: Api) => x.id === id);
        return { x: c.pos.x, y: c.pos.y + 1.1, z: c.pos.z };
      }, pedId);
    await aimCamera(page, await chest());
    await expect(page.locator('.crosshair.show')).toHaveCount(1);
    await watchHitmarker(page);
    await page.mouse.click(640, 360);
    await page.waitForTimeout(400);
    const hit = await hitmarkerRecord(page);
    expect(hit.hits).toEqual(['flesh']);
    expect(hit.pressAt).toBeGreaterThan(0);
    expect(hit.shownAt).toBeGreaterThan(0);
    expect(hit.shownAt - hit.pressAt).toBeLessThan(150);
    const health = await page.evaluate((id) => (window as Api).__gta7.sim.characters.find((x: Api) => x.id === id).health, pedId);
    expect(health).toBeLessThan(100);
    await expect(page.locator('.hitmarker.show')).toHaveCount(0);

    // A building wall near the start: the first direction with a solid wall 2.5-10 m away at chest height.
    const wallAt = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const p = g.sim.player.pos;
      const w = g.sim.world;
      const y = p.y + 1.2;
      for (let k = 0; k < 144; k++) {
        const a = (k * Math.PI) / 72;
        const fx = Math.sin(a);
        const fz = Math.cos(a);
        if (w.lineOfSight(p.x, y, p.z, p.x + fx * 2.5, y, p.z + fz * 2.5) && !w.lineOfSight(p.x, y, p.z, p.x + fx * 10, y, p.z + fz * 10)) {
          return { x: p.x + fx * 10, y, z: p.z + fz * 10 };
        }
      }
      return null;
    });
    expect(wallAt).not.toBeNull();
    await aimCamera(page, wallAt!);
    await watchHitmarker(page);
    await page.mouse.click(640, 360);
    await page.waitForTimeout(400);
    const wall = await hitmarkerRecord(page);
    expect(wall.hits).toEqual(['world']);
    expect(wall.shownAt).toBe(-1);

    // The ped, dead (of a fall, not by the player's hand), shot where he lies.
    await page.evaluate((id) => {
      const g = (window as Api).__gta7;
      const c = g.sim.characters.find((x: Api) => x.id === id);
      g.sim.combat.damageCharacter(c, 999, null, 'fall', 0, -1, 0);
    }, pedId);
    await page.waitForTimeout(1200);
    const body = await page.evaluate((id) => {
      const c = (window as Api).__gta7.sim.characters.find((x: Api) => x.id === id);
      return { x: c.pos.x, y: c.pos.y + 0.25, z: c.pos.z, alive: c.alive };
    }, pedId);
    expect(body.alive).toBe(false);
    await aimCamera(page, body);
    await watchHitmarker(page);
    await page.mouse.click(640, 360);
    await page.waitForTimeout(400);
    const corpse = await hitmarkerRecord(page);
    expect(corpse.hits).toEqual(['flesh']);
    expect(corpse.shownAt).toBe(-1);
    expect(errors).toEqual([]);
  });

  test('a hip-fire tap keeps the camera wide; holding the aim button pulls it in (frame-stepped)', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const result = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const game = g.game;
      g.godMode(true);
      g.give('pistol', 60);
      // An empty street (no traffic or peds), the player in the middle of it looking along it: nothing for the camera to bump into.
      g.sim.ambient = false;
      for (const v of [...g.sim.vehicles]) g.sim.removeVehicle(v);
      for (const c of [...g.sim.characters]) if (!c.isPlayer) g.sim.removeCharacter(c);
      const n = g.sim.roads.node(4, 4);
      g.place(n.x, n.z + n.halfZ + 30, 0);
      game.renderer.cameraCtl.reset(g.sim);
      game.renderer.cameraCtl.yaw = 0;
      game.renderer.cameraCtl.pitch = -0.12;
      // Stop the frame loop and drive Game.step directly.
      game.running = false;
      const ui = { pause: false, map: false, camera: false, radioNext: false, radioPrev: false, confirm: false, back: false, up: false, down: false, left: false, right: false };
      const player = (over: Record<string, unknown> = {}) => ({
        moveX: 0, moveZ: 0, cameraYaw: 0, aimOrigin: { x: 0, y: 0, z: 0 }, aimDir: { x: 0, y: 0, z: 1 },
        sprint: false, jump: false, fire: false, firePressed: false, aim: false, enterExit: false, interact: false, reload: false,
        nextWeapon: false, prevWeapon: false, selectSlot: -1, throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false, hornPressed: false, job: false,
        ...over,
      });
      const step = (over: Record<string, unknown> = {}) => game.step(1 / 60, { player: player(over), lookX: 0, lookY: 0, ui, device: 'kb' });
      const cam = game.renderer.cameraCtl;
      const view = () => {
        const p = g.sim.player.pos;
        const c = cam.camera.position;
        return { boom: cam.dist, eye: Math.hypot(c.x - p.x, c.y - (p.y + 1.6), c.z - p.z), fov: cam.camera.fov };
      };
      for (let i = 0; i < 40; i++) step();
      const settled = view();
      const shots0 = g.sim.progress.stats.shotsFired;
      step({ fire: true, firePressed: true });
      const hip = [];
      for (let i = 0; i < 90; i++) {
        step();
        hip.push(view());
      }
      const shots = g.sim.progress.stats.shotsFired - shots0;
      const aimed = [];
      for (let i = 0; i < 60; i++) {
        step({ aim: true });
        aimed.push(view());
      }
      // Back to the frame loop (start() only runs it from a stop).
      game.start();
      return { settled, hip, aimed, shots, baseFov: cam.baseFov };
    });
    expect(result.shots).toBe(1);
    expect(result.settled.boom).toBeGreaterThan(4.2);
    for (const v of result.hip) {
      expect(v.boom).toBeGreaterThanOrEqual(3.8);
      expect(v.eye).toBeGreaterThanOrEqual(3.8);
      expect(v.fov).toBeGreaterThanOrEqual(result.baseFov - 2);
    }
    const last = result.aimed[result.aimed.length - 1]!;
    expect(last.boom).toBeLessThanOrEqual(2.6);
    expect(last.fov).toBeLessThan(result.baseFov - 10);
    expect(errors).toEqual([]);
  });
});
