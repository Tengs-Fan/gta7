import { expect, test, type Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Api = any;

/** Console noise that is caused by the test harness itself, not the game. */
const IGNORED = [/GPU stall due to ReadPixels/i, /requestPointerLock/i, /pointer lock/i];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !IGNORED.some((r) => r.test(m.text()))) errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return errors;
}

async function boot(page: Page): Promise<string[]> {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as Api).__gta7?.state().frames > 20, null, { timeout: 90_000 });
  return errors;
}

async function newGame(page: Page): Promise<void> {
  await page.click('button[data-id="new"]');
  await page.waitForFunction(() => (window as Api).__gta7.state().mode === 'game');
  await page.waitForTimeout(400);
}

const state = (page: Page) => page.evaluate(() => (window as Api).__gta7.state());

async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

test.describe('GTA 7', () => {
  test('boots to a rendered title screen with no errors', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator('.logo')).toContainText('GTA');
    await expect(page.locator('button[data-id="new"]')).toBeVisible();
    const px = await page.evaluate(() => (window as Api).__gta7.samplePixels());
    expect(px.mean).toBeGreaterThan(20);
    expect(px.std).toBeGreaterThan(8);
    expect(px.colors).toBeGreaterThan(12);
    const s = await state(page);
    expect(s.mode).toBe('title');
    expect(s.crashed).toBe(false);
    expect(errors).toEqual([]);
  });

  test('new game shows the HUD and the player walks with WASD', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await expect(page.locator('.money')).toHaveText('$250');
    await expect(page.locator('.radar canvas')).toBeVisible();
    await expect(page.locator('.help')).toContainText('Mama Lou');
    const s0 = await state(page);
    await holdKey(page, 'KeyW', 1500);
    const s1 = await state(page);
    expect(Math.hypot(s1.player.x - s0.player.x, s1.player.z - s0.player.z)).toBeGreaterThan(3);
    const px = await page.evaluate(() => (window as Api).__gta7.samplePixels());
    expect(px.colors).toBeGreaterThan(12);
    expect(errors).toEqual([]);
  });

  test('steals a car with F, drives it and gets out', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.spawnVehicle('sedan', false);
      const sim = g.sim;
      const v = sim.vehicles[sim.vehicles.length - 1];
      const sx = Math.cos(v.heading);
      const sz = -Math.sin(v.heading);
      g.place(v.pos.x + sx * 2.3, v.pos.z + sz * 2.3);
    });
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => (window as Api).__gta7.state().player.vehicle === 'sedan', null, { timeout: 5000 });
    await holdKey(page, 'KeyW', 3000);
    const s = await state(page);
    expect(s.player.speed).toBeGreaterThan(8);
    await holdKey(page, 'KeyS', 1800);
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => (window as Api).__gta7.state().player.vehicle === null, null, { timeout: 8000 });
    expect((await state(page)).player.state).toBe('normal');
    expect(errors).toEqual([]);
  });

  test('completes the first story mission through real input', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const start = await state(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      const lou = g.poi('lou');
      g.place(lou.x, lou.z);
    });
    await page.waitForTimeout(300);
    await expect(page.locator('.prompt')).toContainText('Wheels');
    await page.keyboard.press('KeyE');
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === 'wheels');
    await expect(page.locator('.subtitle')).toContainText('Mama Lou', { timeout: 5000 });
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Steal a car', null, { timeout: 25_000 });
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.spawnVehicle('compact', false);
      const sim = g.sim;
      const v = sim.vehicles[sim.vehicles.length - 1];
      g.place(v.pos.x + Math.cos(v.heading) * 2.2, v.pos.z - Math.sin(v.heading) * 2.2);
    });
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => (window as Api).__gta7.state().player.vehicle !== null, null, { timeout: 5000 });
    await page.waitForFunction(() => String((window as Api).__gta7.state().objective).startsWith('Drive'), null, { timeout: 5000 });
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const bay = g.sim.world.layout.pois.find((p: Api) => p.id === 'lou').bay;
      g.place((bay.minX + bay.maxX) / 2, (bay.minZ + bay.maxZ) / 2);
    });
    await expect(page.locator('.big')).toContainText('MISSION PASSED', { timeout: 20_000 });
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === null, null, { timeout: 20_000 });
    const end = await state(page);
    expect(end.missionsDone).toContain('wheels');
    expect(end.money).toBe(start.money + 500);
    expect(errors).toEqual([]);
  });

  test('murder brings the police and the stars light up', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const pedId = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.give('pistol', 60);
      g.setCamera(g.sim.player.heading, -0.12);
      return g.spawnPedAhead(5);
    });
    await page.waitForTimeout(300);
    // Aim at the pedestrian's chest via the camera and shoot with real mouse clicks.
    for (let i = 0; i < 12; i++) {
      const alive = await page.evaluate((id) => (window as Api).__gta7.characterAlive(id), pedId);
      if (!alive) break;
      await page.evaluate((id) => {
        const g = (window as Api).__gta7;
        const c = g.sim.characters.find((x: Api) => x.id === id);
        const cam = g.game.renderer.cameraCtl;
        const cp = cam.camera.position;
        const dx = c.pos.x - cp.x;
        const dy = c.pos.y + 1.2 - cp.y;
        const dz = c.pos.z - cp.z;
        cam.yaw = Math.atan2(dx, dz);
        cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      }, pedId);
      await page.mouse.click(640, 360);
      await page.waitForTimeout(300);
    }
    expect(await page.evaluate((id) => (window as Api).__gta7.characterAlive(id), pedId)).toBe(false);
    await page.waitForFunction(() => (window as Api).__gta7.state().wanted >= 1, null, { timeout: 5000 });
    await page.waitForFunction(() => (window as Api).__gta7.state().police >= 1, null, { timeout: 30_000 });
    expect(await page.locator('.stars svg.on').count()).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('wasted players respawn at the hospital', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.sim.combat.damageCharacter(g.sim.player, 999, null, 'fall', 0, -1, 0);
    });
    await expect(page.locator('.big')).toContainText('WASTED', { timeout: 3000 });
    await expect(page.locator('#game')).toHaveClass(/wasted/);
    await page.waitForFunction(() => (window as Api).__gta7.state().deathKind === null, null, { timeout: 10_000 });
    const s = await state(page);
    expect(s.player.health).toBe(100);
    const h = await page.evaluate(() => (window as Api).__gta7.poi('hospital'));
    expect(Math.hypot(s.player.x - h.x, s.player.z - h.z)).toBeLessThan(15);
    expect(errors).toEqual([]);
  });

  test('pause menu, map, stats, settings and controls all work', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => (window as Api).__gta7.game.pause());
    await expect(page.locator('.panel h2:visible')).toHaveText('PAUSED');
    await page.getByRole('button', { name: 'MAP', exact: true }).click();
    await expect(page.locator('.map-screen')).toBeVisible();
    await page.mouse.click(500, 300);
    expect(await page.evaluate(() => (window as Api).__gta7.game.hud.waypoint)).not.toBeNull();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await expect(page.locator('.panel h2:visible')).toHaveText('PAUSED');
    await page.getByRole('button', { name: 'STATS', exact: true }).click();
    await expect(page.locator('.panel h2:visible')).toHaveText('STATS');
    await expect(page.locator('.stat-grid')).toContainText('Story missions');
    await page.getByRole('button', { name: 'BACK', exact: true }).click();
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await expect(page.locator('.panel h2:visible')).toHaveText('SETTINGS');
    const slider = page.locator('.setting input[type=range]').first();
    await slider.fill('0.3');
    expect(await page.evaluate(() => (window as Api).__gta7.game.settings.master)).toBeCloseTo(0.3, 2);
    await page.getByRole('button', { name: 'BACK', exact: true }).click();
    await page.getByRole('button', { name: 'CONTROLS', exact: true }).click();
    await expect(page.locator('.panel h2:visible')).toHaveText('CONTROLS');
    await page.getByRole('button', { name: 'BACK', exact: true }).click();
    await page.getByRole('button', { name: 'RESUME', exact: true }).click();
    await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
    const f0 = (await state(page)).frames;
    await page.waitForTimeout(500);
    expect((await state(page)).frames).toBeGreaterThan(f0);
    expect(errors).toEqual([]);
  });

  test('buys a weapon at Bang Bang Guns', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.sim.progress.addMoney(5000);
      const p = g.poi('guns_south');
      g.place(p.x, p.z);
    });
    await page.waitForTimeout(300);
    await expect(page.locator('.prompt')).toContainText('Bang Bang');
    await page.keyboard.press('KeyE');
    await expect(page.locator('.panel h2:visible')).toHaveText('BANG BANG GUNS');
    const money0 = (await state(page)).money;
    await page.locator('.shop-item', { hasText: 'SMG' }).click();
    await expect(page.locator('.shop-msg')).toContainText('Bought');
    const s = await state(page);
    expect(s.money).toBe(money0 - 900);
    expect(await page.evaluate(() => (window as Api).__gta7.sim.player.inventory.has('smg'))).toBe(true);
    await page.getByRole('button', { name: 'LEAVE', exact: true }).click();
    await page.waitForFunction(() => !(window as Api).__gta7.state().menuOpen);
    expect(errors).toEqual([]);
  });

  test('saves at the safehouse and continues after a reload', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.sim.progress.addMoney(4321);
      g.markDone('wheels');
      g.give('shotgun', 30);
      const s = g.poi('safehouse');
      g.place(s.x, s.z);
    });
    await page.waitForTimeout(300);
    await page.keyboard.press('KeyE');
    await expect(page.locator('.toast')).toContainText('saved');
    const saved = await state(page);
    await page.reload();
    await page.waitForFunction(() => (window as Api).__gta7?.state().frames > 20, null, { timeout: 90_000 });
    await expect(page.locator('button[data-id="continue"]')).toBeEnabled();
    await page.click('button[data-id="continue"]');
    await page.waitForFunction(() => (window as Api).__gta7.state().mode === 'game');
    const s = await state(page);
    expect(s.money).toBe(saved.money);
    expect(s.missionsDone).toContain('wheels');
    expect(await page.evaluate(() => (window as Api).__gta7.sim.player.inventory.has('shotgun'))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('renders at night and after switching graphics quality', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => (window as Api).__gta7.setTime(23));
    await page.waitForTimeout(800);
    const night = await page.evaluate(() => (window as Api).__gta7.samplePixels());
    expect(night.colors).toBeGreaterThan(6);
    for (const q of ['low', 'medium', 'high']) {
      await page.evaluate((quality) => {
        const g = (window as Api).__gta7.game;
        g.applySettings({ ...g.settings, quality }, false);
      }, q);
      await page.waitForTimeout(500);
      const px = await page.evaluate(() => (window as Api).__gta7.samplePixels());
      expect(px.colors).toBeGreaterThan(6);
    }
    expect((await state(page)).crashed).toBe(false);
    expect(errors).toEqual([]);
  });

  test('survives two minutes of chaotic play', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.give('smg', 2000);
      g.give('rocket', 40);
    });
    const keys = ['KeyW', 'KeyA', 'KeyD', 'KeyS', 'Space', 'ShiftLeft'];
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const fps: number[] = [];
    const t0 = Date.now();
    let round = 0;
    while (Date.now() - t0 < 120_000) {
      round++;
      const action = Math.floor(rnd() * 7);
      if (action === 0) {
        await page.evaluate(() => (window as Api).__gta7.spawnVehicle(['sports', 'muscle', 'sedan', 'pickup', 'police'][Math.floor(Math.random() * 5)]));
      } else if (action === 1) {
        await page.evaluate(() => (window as Api).__gta7.setWanted(1 + Math.floor(Math.random() * 5)));
      } else if (action === 2) {
        await page.keyboard.press('KeyF');
      } else if (action === 3) {
        for (let k = 0; k < 6; k++) await page.mouse.click(640 + rnd() * 100 - 50, 360);
      } else if (action === 4) {
        await page.evaluate(() => {
          const g = (window as Api).__gta7;
          const n = g.sim.roads.nodes[Math.floor(Math.random() * g.sim.roads.nodes.length)];
          if (!g.sim.player.vehicle) g.place(n.x + n.halfX + 2, n.z + n.halfZ + 2);
        });
      }
      const key = keys[Math.floor(rnd() * keys.length)]!;
      await page.keyboard.down('KeyW');
      await page.keyboard.down(key);
      await page.waitForTimeout(400 + rnd() * 1200);
      await page.keyboard.up(key);
      await page.keyboard.up('KeyW');
      if (round % 5 === 0) {
        const s = await state(page);
        fps.push(s.fps);
        expect(s.crashed).toBe(false);
        expect(s.vehicles).toBeLessThan(120);
        expect(s.characters).toBeLessThan(180);
        if (s.menuOpen) await page.evaluate(() => (window as Api).__gta7.game.resume());
      }
    }
    const avg = fps.reduce((a, b) => a + b, 0) / Math.max(1, fps.length);
    expect(avg).toBeGreaterThan(30);
    expect(errors).toEqual([]);
  });
});
