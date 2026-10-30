import { expect, test } from '@playwright/test';
import { boot, holdKey, newGame, state, type Api } from './helpers';

test.describe('GTA 7 side content', () => {
  test('taxi job: pick up a fare and drop them off', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.spawnVehicle('taxi', true);
    });
    await expect(page.locator('.prompt')).toContainText('taxi job', { timeout: 5000 });
    await page.keyboard.press('KeyT');
    await expect(page.locator('.big')).toContainText('TAXI DRIVER', { timeout: 3000 });
    await expect(page.locator('.status')).toContainText('FARES 0');
    const money0 = (await state(page)).money;
    // Drive (teleport) next to the waiting fare.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const fare = g.sim.activities.job.fare;
      g.place(fare.pos.x + 3, fare.pos.z + 3);
    });
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job?.stage === 'dropoff', null, { timeout: 5000 });
    await expect(page.locator('.status')).toContainText('FARE TIME');
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const j = g.sim.activities.job;
      g.place(j.destX, j.destZ);
    });
    await expect(page.locator('.big')).toContainText('FARE COMPLETE', { timeout: 5000 });
    const s = await state(page);
    expect(s.money).toBeGreaterThan(money0);
    expect(await page.evaluate(() => (window as Api).__gta7.sim.progress.stats.taxiFares)).toBe(1);
    // T again ends the job.
    await page.keyboard.press('KeyT');
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job === null);
    expect(errors).toEqual([]);
  });

  test('taxi: steal a cab, a pedestrian hails it and rides to their stop', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    // A cab with a cabbie at the wheel (no driver AI: it stays put), and the player at its driver's door. Never wanted:
    // someone who sees the cab stolen would call it in, and the police would come after it.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.cheats.neverWanted = true;
      const id = g.spawnVehicle('taxi', false);
      const v = g.sim.vehicles.find((x: Api) => x.id === id);
      g.sim.seat(g.sim.spawnCharacter('civilian', v.pos.x, v.pos.z), v, 0);
      const out = v.halfW + 0.8;
      g.place(v.pos.x + Math.cos(v.heading) * out, v.pos.z - Math.sin(v.heading) * out);
      (window as Api).__cab = v;
    });
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => {
      const g = (window as Api).__gta7;
      const v = (window as Api).__cab;
      return g.sim.player.vehicle === v && v.driver === g.sim.player;
    }, null, { timeout: 8000 });
    // Up the lane it stands in, from its start.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const v = (window as Api).__cab;
      const lane = g.sim.roads.nearestLane(v.pos.x, v.pos.z).lane;
      g.place(lane.sx + lane.dx * 4, lane.sz + lane.dz * 4, lane.heading);
    });
    // Someone on the sidewalk 30 m ahead keeps pace with the cab until anybody waves it down.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const sim = g.sim;
      const v = (window as Api).__cab;
      const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
      c.owner = 'ped';
      c.brain = sim.peds.makeGangBrain(c.pos.x, c.pos.z);
      c.brain.brave = false;
      c.brain.mode = 'idle';
      c.brain.modeTimer = 60;
      const timer = setInterval(() => {
        if (c.owner !== 'ped' || sim.characters.some((x: Api) => x.owner === 'ped' && x.hailTimer > 0)) {
          clearInterval(timer);
          return;
        }
        // The first free ground off the road to the cab's right (the curb side), a step in.
        const fx = Math.sin(v.heading);
        const fz = Math.cos(v.heading);
        for (let d = 1; d < 20; d += 0.25) {
          const x = v.pos.x + fx * 30 - fz * d;
          const z = v.pos.z + fz * 30 + fx * d;
          if (sim.world.isOnRoad(x, z) || !sim.world.isFree(x, z, 0.4)) continue;
          c.pos.x = x - fz;
          c.pos.z = z + fx;
          c.pos.y = sim.world.groundHeight(c.pos.x, c.pos.z);
          break;
        }
      }, 100);
      (window as Api).__planting = timer;
    });
    // Keep the cab rolling between 6 and 9 m/s with W until he does.
    let speed = 0;
    let hailed = -1;
    await page.keyboard.down('KeyW');
    for (let i = 0; i < 150 && hailed < 0; i++) {
      await page.waitForTimeout(100);
      ({ speed, hailed } = await page.evaluate(() => {
        const g = (window as Api).__gta7;
        const h = g.sim.characters.find((x: Api) => x.owner === 'ped' && x.hailTimer > 0);
        return { speed: (window as Api).__cab.speed, hailed: h ? h.id : -1 };
      }));
      if (speed > 9) await page.keyboard.up('KeyW');
      else if (speed < 6) await page.keyboard.down('KeyW');
    }
    await page.keyboard.up('KeyW');
    expect(hailed).toBeGreaterThan(0);
    // Pull up on the road beside him.
    await page.evaluate((id) => {
      clearInterval((window as Api).__planting);
      const g = (window as Api).__gta7;
      const v = (window as Api).__cab;
      const h = g.sim.characters.find((x: Api) => x.id === id);
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      const ahead = (h.pos.x - v.pos.x) * fx + (h.pos.z - v.pos.z) * fz;
      g.place(v.pos.x + fx * ahead, v.pos.z + fz * ahead, v.heading);
    }, hailed);
    await expect(page.locator('.big')).toContainText('TAXI DRIVER', { timeout: 3000 });
    expect(await page.evaluate(() => (window as Api).__gta7.sim.activities.job.fare.id)).toBe(hailed);
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job?.stage === 'dropoff', null, { timeout: 8000 });
    const dest = await page.evaluate(() => (window as Api).__gta7.sim.activities.job.destName);
    await expect(page.locator('.subtitle')).toContainText(dest, { timeout: 3000 });
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const j = g.sim.activities.job;
      g.place(j.destX, j.destZ);
    });
    await expect(page.locator('.big')).toContainText('FARE COMPLETE', { timeout: 5000 });
    expect(await page.evaluate(() => (window as Api).__gta7.sim.progress.stats.taxiFares)).toBe(1);
    expect(errors).toEqual([]);
  });

  test('vigilante: stop a fleeing criminal from a police car', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.spawnVehicle('police', true);
    });
    await expect(page.locator('.prompt')).toContainText('vigilante', { timeout: 5000 });
    await page.keyboard.press('KeyT');
    await expect(page.locator('.big')).toContainText('VIGILANTE', { timeout: 3000 });
    await page.waitForFunction(() => !!(window as Api).__gta7.sim.activities.job?.target, null, { timeout: 8000 });
    const money0 = (await state(page)).money;
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.sim.combat.explodeVehicle(g.sim.activities.job.target);
    });
    await expect(page.locator('.big')).toContainText('CRIMINAL STOPPED', { timeout: 5000 });
    expect((await state(page)).money).toBeGreaterThan(money0);
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job?.level === 2, null, { timeout: 5000 });
    expect(errors).toEqual([]);
  });

  test('rampage: kill twelve gang members in time', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const money0 = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      const r = g.sim.pickups.find((p: Api) => p.kind === 'rampage' && p.active);
      g.place(r.pos.x, r.pos.z);
      return g.sim.progress.money;
    });
    await expect(page.locator('.big')).toContainText('RAMPAGE!', { timeout: 4000 });
    expect(await page.evaluate(() => (window as Api).__gta7.sim.player.inventory.has('smg'))).toBe(true);
    // Kill rampage targets as they spawn (attributing the kills to the player).
    for (let i = 0; i < 40; i++) {
      const done = await page.evaluate(() => {
        const g = (window as Api).__gta7;
        const j = g.sim.activities.job;
        if (!j) return true;
        for (const c of g.sim.characters) if (c.missionTag === 'rampage' && c.alive) g.sim.combat.damageCharacter(c, 999, g.sim.player, 'bullet', 0, 0, 1);
        return false;
      });
      if (done) break;
      await page.waitForTimeout(500);
    }
    await expect(page.locator('.big')).toContainText('RAMPAGE PASSED', { timeout: 10_000 });
    expect((await state(page)).money).toBe(money0 + 2000);
    expect(errors).toEqual([]);
  });

  test('stunt ramp pays a unique stunt bonus', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const money0 = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.spawnVehicle('sports', true);
      const r = g.sim.world.layout.ramps[0];
      g.place(r.x - Math.sin(r.heading) * 45, r.z - Math.cos(r.heading) * 45, r.heading);
      g.game.renderer.cameraCtl.reset(g.sim);
      return g.sim.progress.money;
    });
    await holdKey(page, 'KeyW', 5500);
    await expect(page.locator('.big')).toContainText('STUNT BONUS', { timeout: 6000 });
    expect((await state(page)).money).toBeGreaterThan(money0);
    expect(errors).toEqual([]);
  });

  test('hidden package collection', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const money0 = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const pkg = g.sim.pickups.find((p: Api) => p.kind === 'package' && p.active);
      g.place(pkg.pos.x, pkg.pos.z);
      return g.sim.progress.money;
    });
    await expect(page.locator('.big')).toContainText('PACKAGE 1 OF 20', { timeout: 4000 });
    expect((await state(page)).money).toBe(money0 + 100);
    expect(errors).toEqual([]);
  });

  test('Spray Shack clears the wanted level', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.spawnVehicle('sedan', true);
      g.setWanted(2);
      // Round 2 (police, P62): the shop turns away a car the police watch drive in.
      g.sim.police.dismissAll();
      const spray = g.sim.world.layout.pois.find((p: Api) => p.id === 'spray_south');
      g.place((spray.bay.minX + spray.bay.maxX) / 2, (spray.bay.minZ + spray.bay.maxZ) / 2, spray.heading + Math.PI);
    });
    await page.waitForFunction(() => (window as Api).__gta7.state().wanted === 0, null, { timeout: 5000 });
    await expect(page.locator('.help')).toContainText('lost you', { timeout: 4000 });
    expect(errors).toEqual([]);
  });
});
