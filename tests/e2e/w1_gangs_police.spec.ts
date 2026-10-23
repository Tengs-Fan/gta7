// Wave 1 gangs and police in the real game: Los Halcones turn on a player who draws a pistol in their turf, and at 3
// stars a roadblock with a spike strip stands ahead on the avenue he drives; its strip bursts his tyres.

import { expect, test } from '@playwright/test';

import { boot, newGame, type Api } from './helpers';

test('a pistol drawn in Halcones turf turns the members on the player', async ({ page }) => {
  const errors = await boot(page);
  await newGame(page);
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    const s = g.ext.combat.toTurf('halcones');
    g.teleport(s.x, s.z);
  });
  await page.waitForTimeout(800);
  const ids = await page.evaluate(() => [0, 1, 2].map((k) => (window as Api).__gta7.ext.combat.spawnMember('halcones', 6 + k * 1.5)));
  await page.waitForTimeout(1500);
  const hostile = () => page.evaluate((list) => (window as Api).__gta7.ext.combat.gangs().members.filter((m: Api) => list.includes(m.id) && m.hostile).length, ids);
  expect(await hostile()).toBe(0);
  expect(await page.evaluate(() => (window as Api).__gta7.ext.combat.gangs().here)).toBe('halcones');
  // Draw a pistol (key 2).
  await page.evaluate(() => (window as Api).__gta7.give('pistol', 60));
  await page.keyboard.press('Digit2');
  await expect.poll(hostile, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('at 3 stars a roadblock and a spike strip stand ahead on the avenue, and the strip flattens the tyres', async ({ page }) => {
  const errors = await boot(page);
  await newGame(page);
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    const s = g.sim;
    g.godMode(true);
    s.missions.noBust = true;
    const lane = s.roads.lanes.filter((l: Api) => l.line.avenue && Math.abs(l.dx) < 0.1 && l.dz > 0 && l.sz < -150 && l.sz > -260 && l.length > 60).sort((a: Api, b: Api) => Math.abs(a.line.pos) - Math.abs(b.line.pos))[0];
    g.teleport(lane.sx + lane.dx * 4 + 3, lane.sz + lane.dz * 4);
    g.spawnVehicle('sedan', true);
    const v = s.player.vehicle;
    v.pos.x = lane.sx + lane.dx * 4;
    v.pos.z = lane.sz + lane.dz * 4;
    v.heading = lane.heading;
    g.setCamera(lane.heading, -0.1);
    g.setWanted(3);
  });
  await page.keyboard.down('KeyW');
  const standing = () => page.evaluate(() => (window as Api).__gta7.ext.combat.roadblocks());
  await expect.poll(async () => (await standing()).standing.length, { timeout: 40_000 }).toBeGreaterThan(0);
  const rb = await standing();
  expect(rb.standing[0].cars.length).toBe(2);
  expect(rb.standing[0].officers.length).toBe(2);
  expect(rb.standing[0].ahead).toBeGreaterThanOrEqual(80);
  expect(rb.strips.length).toBe(1);
  // Onto the strip at speed.
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    const v = g.sim.player.vehicle;
    const strip = g.sim.roadblocks.strips[0];
    // 30 m short of it on the player's side, heading across it.
    v.pos.x = strip.x + strip.ux * 30;
    v.pos.z = strip.z + strip.uz * 30;
    v.heading = Math.atan2(-strip.ux, -strip.uz);
    v.vel.x = -strip.ux * 15;
    v.vel.z = -strip.uz * 15;
    v.angVel = 0;
  });
  await expect.poll(async () => ((await standing()).flats ?? []).filter(Boolean).length, { timeout: 8000 }).toBeGreaterThan(0);
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});
