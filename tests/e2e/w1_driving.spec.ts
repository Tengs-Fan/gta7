import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Wave 1 track C, driving in the real game: a handbrake drift with real key events (VAL-DRIVE-002), the drawn body
// tilting over a curb (VAL-DRIVE-003), a passenger swimming out of a sunk car (VAL-DRIVE-005) and the driver of a
// burning car staying drawn on every tier (VAL-DRIVE-006). Screenshots go to GTA7_SHOTS when it is set.

const SHOTS = process.env.GTA7_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe('wave 1 driving', () => {
  test('a handbrake drift with the real keyboard: D + Space slides the car round a corner, A catches it', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.cheats.neverWanted = true;
      g.setClockRate(0);
      g.setTime(12);
      g.setWeather('clear', { instant: true });
      const sim = g.sim;
      // A long straight lane into a junction with a right turn, the car 70 m out from its end.
      // Turning right onto an avenue, which leaves room to slide wide.
      // North up Reef St into the ring road, turning right onto it (Palmetto St ends in Hillcrest Cove, and Delgado St's
      // right turn now leads straight onto the bridge over Northshore Bay, between parapets).
      const lane = sim.roads.lanesBetween(sim.roads.node(9, 1).id, sim.roads.node(9, 0).id)[0];
      const s = lane.length - 70;
      g.teleport(lane.sx + lane.dx * s, lane.sz + lane.dz * s);
      const v = sim.spawnVehicle('sports', lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
      sim.seat(sim.player, v, 0);
      v.vel.x = lane.dx * 25;
      v.vel.z = lane.dz * 25;
      // Clear the street of traffic, so the run is about the drift.
      for (const o of [...sim.vehicles]) if (o !== v && Math.hypot(o.pos.x - v.pos.x, o.pos.z - v.pos.z) < 150) sim.removeVehicle(o);
      (window as Api).__drift = { lane, end: { x: lane.sx + lane.dx * lane.length, z: lane.sz + lane.dz * lane.length }, trace: [] as number[], impacts: 0, hits: [] as string[] };
      sim.events.on('impact', (e: { vehicle?: unknown }) => {
        if (e.vehicle === v) {
          (window as Api).__drift.impacts++;
          (window as Api).__drift.hits.push(JSON.stringify(e, (k, x) => (k === 'vehicle' ? undefined : typeof x === 'number' ? Math.round(x * 10) / 10 : x)));
        }
      });
      const slip = () => {
        const sp = Math.hypot(v.vel.x, v.vel.z);
        if (sp < 1) return 0;
        let d = Math.atan2(v.vel.x, v.vel.z) - v.heading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        return Math.abs(d) * (180 / Math.PI);
      };
      const tick = () => {
        (window as Api).__drift.trace.push(slip());
        (window as Api).__drift.speed = v.speed;
        (window as Api).__drift.toEnd = (lane.length - ((v.pos.x - lane.sx) * lane.dx + (v.pos.z - lane.sz) * lane.dz));
        requestAnimationFrame(tick);
      };
      tick();
    });
    await page.locator('canvas').first().focus();
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => (window as Api).__drift.toEnd < 16, undefined, { timeout: 10_000 });
    await page.keyboard.up('KeyW');
    await page.keyboard.down('KeyD');
    await page.keyboard.down('Space');
    const marks: number[] = [];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(160);
      marks.push(await page.evaluate(() => (window as Api).__drift.trace.length));
      await shot(page, `drift-${i + 1}`);
    }
    await page.keyboard.up('Space');
    await page.keyboard.up('KeyD');
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(350);
    await page.keyboard.up('KeyA');
    // Through the junction and out onto the avenue: contacts up to here count.
    await page.waitForTimeout(300);
    const turnImpacts = await page.evaluate(() => (window as Api).__drift.impacts as number);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(700);
    await page.keyboard.up('KeyW');
    const r = await page.evaluate(() => {
      const d = (window as Api).__drift;
      return { trace: d.trace as number[], impacts: d.impacts as number, speed: d.speed as number, hits: d.hits as string[] };
    });
    const start = marks[0]! - 14;
    const during = r.trace.slice(start, marks[3]! + 20);
    const peak = Math.max(...during);
    const after = r.trace.slice(-20);
    console.log(`[w1-drift] slip trace (deg, every 4th frame from the turn): ${r.trace.slice(start).filter((_, i) => i % 4 === 0).map((x) => x.toFixed(0)).join(' ')}; peak ${peak.toFixed(1)}deg, last ${after[after.length - 1]!.toFixed(1)}deg, impacts in the turn ${turnImpacts} (all ${r.impacts}: ${r.hits.join(' ')}), speed after ${r.speed.toFixed(1)} m/s`);
    expect(peak).toBeGreaterThan(12);
    for (const s of after) expect(s).toBeLessThan(5);
    expect(turnImpacts).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a side view of the player car mounting a curb shows the body tilt and settle', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const found = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setClockRate(0);
      g.setTime(12);
      g.setWeather('clear', { instant: true });
      const sim = g.sim;
      const w = sim.world;
      for (const lane of sim.roads.lanes) {
        if (lane.length < 40) continue;
        const mx = lane.sx + lane.dx * lane.length * 0.5;
        const mz = lane.sz + lane.dz * lane.length * 0.5;
        const ux = -lane.dz;
        const uz = lane.dx;
        let edge = -1;
        for (let d = 0; d < 20; d += 0.1) if (w.baseGround(mx + ux * d, mz + uz * d) > 0.1) { edge = d; break; }
        if (edge < 0) continue;
        let ok = true;
        for (let d = edge + 0.2; d < edge + 14 && ok; d += 0.5) if (!w.isFree(mx + ux * d, mz + uz * d, 1.3) || w.baseGround(mx + ux * d, mz + uz * d) < 0.1) ok = false;
        if (!ok) continue;
        const v = sim.spawnVehicle('sedan', mx + ux * (edge - 6), mz + uz * (edge - 6), Math.atan2(ux, uz));
        sim.seat(sim.player, v, 0);
        for (const o of [...sim.vehicles]) if (o !== v && Math.hypot(o.pos.x - v.pos.x, o.pos.z - v.pos.z) < 40) sim.removeVehicle(o);
        (window as Api).__curb = { v, pitch: [] as number[] };
        const R = g.game.renderer;
        const tick = () => {
          const view = (R as unknown as { vehicleViews: Map<number, { group: { rotation: { x: number } } }> }).vehicleViews.get(v.id);
          if (view) (window as Api).__curb.pitch.push(-view.group.rotation.x * (180 / Math.PI));
          R.cameraCtl.orbitYaw = Math.PI / 2;
          R.cameraCtl.orbitPitch = 0.05;
          R.cameraCtl.lookIdle = 0;
          requestAnimationFrame(tick);
        };
        tick();
        return true;
      }
      return false;
    });
    expect(found).toBe(true);
    await page.waitForTimeout(800);
    await page.locator('canvas').first().focus();
    await page.keyboard.down('KeyW');
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(i === 0 ? 650 : 180);
      await shot(page, `curb-pitch-${i + 1}`);
    }
    await page.keyboard.up('KeyW');
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyS');
    const pitch = await page.evaluate(() => (window as Api).__curb.pitch as number[]);
    const spread = Math.max(...pitch) - Math.min(...pitch);
    console.log(`[w1-curb] drawn pitch (deg, every 4th frame): ${pitch.filter((_, i) => i % 4 === 0).map((p) => p.toFixed(1)).join(' ')}`);
    expect(spread).toBeGreaterThan(1);
    expect(errors).toEqual([]);
  });

  test('a passenger swims out of a car sunk off the Marina deck', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setClockRate(0);
      g.setTime(12);
      g.setWeather('clear', { instant: true });
      const sim = g.sim;
      const deck = sim.world.layout.decks.find((d: { name: string; rect: { maxX: number; minX: number } }) => d.name === 'Marina' && d.rect.maxX - d.rect.minX > 50).rect;
      g.teleport(deck.maxX - 6, (deck.minZ + deck.maxZ) / 2);
      const v = sim.spawnVehicle('sedan', deck.maxX - 6, (deck.minZ + deck.maxZ) / 2, Math.PI / 2);
      sim.seat(sim.player, v, 0);
      // Three passengers; one at least swims (fates are fixed per character).
      for (let i = 1; i <= 3; i++) sim.seat(sim.spawnCharacter('civilian', v.pos.x, v.pos.z), v, i);
      (window as Api).__sunk = v;
      v.vel.x = 12;
    });
    await page.locator('canvas').first().focus();
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => (window as Api).__sunk.inWater, undefined, { timeout: 10_000 });
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const v = (window as Api).__sunk;
      const near = g.sim.characters.filter((c: { isPlayer: boolean; removed: boolean; pos: { x: number; z: number } }) => !c.isPlayer && !c.removed && Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z) < 12);
      const swimmer = near.find((c: { state: string }) => c.state === 'swimming');
      if (swimmer) {
        // Look at the swimmer from behind the player.
        g.setCamera(Math.atan2(swimmer.pos.x - g.sim.player.pos.x, swimmer.pos.z - g.sim.player.pos.z), -0.25);
      }
      return { player: g.sim.player.state, states: near.map((c: { state: string; alive: boolean }) => (c.alive ? c.state : 'dead')) };
    });
    await page.waitForTimeout(500);
    await shot(page, 'sinking-swim-out');
    console.log(`[w1-sink] player ${r.player}; passengers ${r.states.join(', ')}`);
    expect(r.player).toBe('swimming');
    expect(r.states).toContain('swimming');
    expect(errors).toEqual([]);
  });

  test('a burning car keeps its driver drawn on High, Medium and Low, from the side and through the windscreen', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.setClockRate(0);
      g.setTime(12);
      g.setWeather('clear', { instant: true });
      const n = g.sim.roads.node(4, 4);
      g.teleport(n.x + n.halfX + 2.2, n.z + n.halfZ + 9);
      g.spawnVehicle('sedan', true);
    });
    const views: Array<Record<string, unknown>> = [];
    for (const tier of ['high', 'medium', 'low'] as const) {
      const r = await page.evaluate(async (tier) => {
        const g = (window as Api).__gta7;
        const R = g.game.renderer;
        R.setQuality(tier);
        const v = g.sim.player.vehicle;
        v.health = v.spec.health;
        v.burning = false;
        g.sim.combat.igniteVehicle(v, 30);
        const crowd = (R as unknown as { crowd: { drawnHeads(): Array<{ x: number; y: number; z: number }> } }).crowd;
        const out: { tier: string; side: boolean[]; front: boolean[] } = { tier, side: [], front: [] };
        for (const [k, yaw] of [['side', Math.PI / 2], ['front', Math.PI]] as const) {
          for (let f = 0; f < 40; f++) {
            R.cameraCtl.orbitYaw = yaw;
            R.cameraCtl.orbitPitch = 0.1;
            R.cameraCtl.lookIdle = 0;
            await new Promise((res) => requestAnimationFrame(res));
            // His head is drawn in the car.
            const heads = crowd.drawnHeads().filter((h) => Math.hypot(h.x - v.pos.x, h.z - v.pos.z) < v.halfL);
            out[k].push(v.burning && g.sim.player.vehicle === v && heads.length >= 1);
          }
        }
        return out;
      }, tier);
      views.push(r);
      await page.evaluate(() => {
        const R = (window as Api).__gta7.game.renderer;
        R.cameraCtl.orbitYaw = Math.PI / 2;
        R.cameraCtl.lookIdle = 0;
      });
      await page.waitForTimeout(100);
      await shot(page, `burning-side-${tier}`);
      await page.evaluate(() => {
        const R = (window as Api).__gta7.game.renderer;
        R.cameraCtl.orbitYaw = Math.PI;
        R.cameraCtl.lookIdle = 0;
      });
      await page.waitForTimeout(100);
      await shot(page, `burning-windscreen-${tier}`);
    }
    for (const r of views) {
      console.log(`[w1-burn] ${r.tier}: driver drawn in ${(r.side as boolean[]).filter(Boolean).length}/40 side frames, ${(r.front as boolean[]).filter(Boolean).length}/40 windscreen frames`);
      expect((r.side as boolean[]).every(Boolean)).toBe(true);
      expect((r.front as boolean[]).every(Boolean)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
});
