// Wave 1 NPCs in the real game: a witness phones in a punch (the star comes seconds later, or never if he is knocked
// down first), and a driver whose car the player rams hard gets out.

import { expect, test, type Page } from '@playwright/test';

import { boot, newGame, type Api } from './helpers';

/** A quiet stretch of road away from police: the player on foot, a victim ahead and a witness a few metres off. */
async function witnessScene(page: Page): Promise<{ victim: number; witness: number }> {
  return page.evaluate(() => {
    const g = (window as Api).__gta7;
    const s = g.sim;
    g.setTime(12);
    // Clear the street of everyone else (and the police) so only this witness sees it.
    for (const c of s.characters) if (!c.isPlayer && !c.removed) s.removeCharacter(c);
    s.ambient = false;
    const yaw = g.game.renderer.cameraCtl.yaw;
    const p = s.player;
    p.heading = yaw;
    const mk = (dx: number, dz: number) => {
      const c = s.spawnCharacter('civilian', p.pos.x + dx, p.pos.z + dz);
      c.owner = 'ped';
      c.persistent = true;
      c.brain = s.peds.makeGangBrain(c.pos.x, c.pos.z);
      c.brain.brave = false;
      c.brain.mode = 'idle';
      c.brain.modeTimer = 1e6;
      return c;
    };
    const victim = mk(Math.sin(yaw) * 1.2, Math.cos(yaw) * 1.2);
    victim.heading = yaw + Math.PI;
    const witness = mk(Math.sin(yaw) * 5 + Math.cos(yaw) * 4, Math.cos(yaw) * 5 - Math.sin(yaw) * 4);
    return { victim: victim.id, witness: witness.id };
  });
}

test('a witness phones in a punch; knocked down first, he never does', async ({ page }) => {
  const errors = await boot(page);
  await newGame(page);
  const { witness } = await witnessScene(page);
  await page.mouse.move(640, 360);
  const t0 = await page.evaluate(() => (window as Api).__gta7.sim.time);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const calling = await page.evaluate((id) => {
    const g = (window as Api).__gta7;
    const c = g.sim.characters.find((o: Api) => o.id === id);
    return { phone: c.phoneTimer, mode: c.brain.mode, wanted: g.state().wanted };
  }, witness);
  expect(calling.phone).toBeGreaterThan(0);
  expect(calling.wanted).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as Api).__gta7.state().wanted), { timeout: 12_000 }).toBe(1);
  const t1 = await page.evaluate(() => (window as Api).__gta7.sim.time);
  expect(t1 - t0).toBeGreaterThan(2);
  expect(t1 - t0).toBeLessThan(11);

  // Again, but knock the witness down first.
  await page.evaluate(() => (window as Api).__gta7.setWanted(0));
  await page.waitForTimeout(13_000);
  const second = await witnessScene(page);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.evaluate((id) => {
    const c = (window as Api).__gta7.sim.characters.find((o: Api) => o.id === id);
    c.state = 'knocked';
    c.knockTimer = 2.5;
  }, second.witness);
  await page.waitForTimeout(11_000);
  expect(await page.evaluate(() => (window as Api).__gta7.state().wanted)).toBe(0);
  expect(errors).toEqual([]);
});

test('a hard hit on a stopped car brings an angry driver out', async ({ page }) => {
  const errors = await boot(page);
  await newGame(page);
  const out = await page.evaluate(async () => {
    const g = (window as Api).__gta7;
    const s = g.sim;
    g.godMode(true);
    const results: string[] = [];
    // Several rams on fresh cars until one driver gets out (the chance per hit is GET_OUT_CHANCE).
    for (let k = 0; k < 8; k++) {
      const lane = s.roads.lanes.filter((l: Api) => l.length > 70)[k * 5];
      const tx = lane.sx + lane.dx * 50;
      const tz = lane.sz + lane.dz * 50;
      const target = s.spawnVehicle('sedan', tx, tz, lane.heading);
      target.owner = 'traffic';
      const d = s.addDriver(target, 'civilian', 'traffic');
      d.owner = 'traffic';
      target.ai.setLane(lane, 50);
      target.ai.hold = true;
      if (s.player.vehicle) s.playerCtl.ejectPlayer(true);
      g.teleport(lane.sx + lane.dx * 30 + 3, lane.sz + lane.dz * 30);
      g.spawnVehicle('sedan', true);
      const v = s.player.vehicle;
      v.pos.x = lane.sx + lane.dx * 30;
      v.pos.z = lane.sz + lane.dz * 30;
      v.heading = lane.heading;
      v.vel.x = lane.dx * 12;
      v.vel.z = lane.dz * 12;
      await new Promise((r) => setTimeout(r, 4500));
      results.push(d.state);
      if (d.state === 'normal') return { k, state: d.state, mode: d.brain?.mode, results };
    }
    return { k: -1, results };
  });
  expect(out.k).toBeGreaterThanOrEqual(0);
  expect(['fight', 'flee']).toContain(out.mode);
  expect(errors).toEqual([]);
});
