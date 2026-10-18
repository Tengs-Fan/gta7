import { describe, expect, it } from 'vitest';
import { makeContact, obbBounds, obbVsAabb } from '../../src/core/collision';
import { Rng } from '../../src/core/rng';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import { vehicleObb } from '../../src/sim/vehiclePhysics';
import { allFinite, input, makeSim, teleport } from './helpers';

/**
 * The vehicles by what keeps their number down, as the e2e chaos test's vehicleCensus counts them, since
 * nothing caps the total: parked cars fill a share of the bays around the player (up to 100 at once in the
 * densest district), so a total only says which district the bot is in. TrafficSystem tops ambient traffic
 * up to its target and no further, and parks at most one car per bay, each one tracked (parkedBySpot);
 * PoliceSystem keeps at most UNITS_BY_LEVEL[5] = 7 crewed units out, one more with a patrol. Everything
 * else (cars the player took or jacked, wrecks, cars left by their crews) has no cap of its own and goes
 * once out of range: `far` lists what is still more than 450 m from the player, beyond the 320 m anything
 * stays visible plus a streaming tick of driving at 60 m/s. Police sweeping a search area may stay by it.
 */
function vehicleCensus(sim: Sim): { traffic: number; parked: number; units: number; far: string[] } {
  const pp = sim.playerPos();
  const out = { traffic: 0, parked: 0, units: 0, far: [] as string[] };
  for (const v of sim.vehicles) {
    if (v.removed || v === sim.player.vehicle) continue;
    const npc = v.driver && !v.driver.isPlayer;
    if (v.owner === 'traffic' && npc && !v.destroyed) out.traffic++;
    else if (v.owner === 'parked') out.parked++;
    else if (v.owner === 'police' && v.drivable && v.occupants().some((c) => c.isLaw && c.alive)) out.units++;
    const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
    if (v.owner !== 'police' && d > 450) out.far.push(`${v.kind} (${v.owner}${v.destroyed ? ', wreck' : ''}) ${Math.round(d)} m away`);
  }
  return out;
}

describe('soak', () => {
  it('survives ten minutes of chaotic play with all invariants intact', () => {
    const sim = makeSim({ ambient: true, police: true, seed: 7 });
    const rng = new Rng(1234);
    const p = sim.player;
    p.inventory.give('smg', 5000);
    p.inventory.give('rocket', 50);
    sim.cheats.godMode = false;
    let mode = 0;
    let modeTime = 0;
    let yaw = 0;
    let steer = 0;
    const contact = makeContact();
    const obb = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
    const bounds = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
    let maxVehicles = 0;
    let maxChars = 0;
    let deaths = 0;
    let enteredCars = 0;
    let maxWanted = 0;
    let maxTarget = 0;
    /** Sim time of the player's latest jump across town: a teleport or a respawn. */
    let jumpedAt = -Infinity;
    sim.events.on('wasted', () => deaths++);
    sim.events.on('vehicleEnter', () => enteredCars++);
    sim.events.on('respawn', () => (jumpedAt = sim.time));
    const dt = 1 / 60;
    const frames = 60 * 600;
    for (let f = 0; f < frames; f++) {
      modeTime -= dt;
      // Arrests confiscate weapons: re-arm like a player visiting a gun shop.
      if (f % (60 * 30) === 0) {
        p.inventory.give('smg', 500);
        p.inventory.give('rocket', 5);
      }
      if (modeTime <= 0) {
        mode = rng.int(0, 5);
        modeTime = rng.range(2, 9);
        yaw = rng.range(-Math.PI, Math.PI);
        if (rng.chance(0.08)) {
          const n = rng.pick(sim.roads.nodes);
          if (!p.vehicle && p.alive) {
            teleport(sim, n.x + 9, n.z + 9);
            jumpedAt = sim.time;
          }
        }
        if (rng.chance(0.1)) sim.wanted.setLevel(rng.int(1, 5));
        if (rng.chance(0.05)) sim.wanted.clear();
      }
      steer += (rng.next() - 0.5) * 0.3;
      steer = Math.max(-1, Math.min(1, steer * 0.98));
      const pp = sim.playerPos();
      const aimDir = { x: Math.sin(yaw), y: -0.05, z: Math.cos(yaw) };
      const inp: PlayerInput = input({
        cameraYaw: yaw,
        aimOrigin: { x: pp.x - aimDir.x * 5, y: pp.y + 2.5, z: pp.z - aimDir.z * 5 },
        aimDir,
      });
      if (p.vehicle) {
        inp.throttle = mode === 3 ? 0 : 1;
        inp.brake = mode === 3 ? 1 : 0;
        inp.steer = steer;
        inp.handbrake = mode === 4 && rng.chance(0.3);
        inp.enterExit = rng.chance(0.002);
        inp.fire = mode === 5;
        inp.horn = rng.chance(0.01);
        inp.hornPressed = inp.horn;
        if (mode === 5) p.inventory.current = 'smg';
      } else if (mode === 3 || mode === 4) {
        // Seek the nearest car and get in (jacking drivers on the way).
        const near = sim.nearestVehicle(p.pos.x, p.pos.z, 60, (v) => v.drivable && v.speed < 6);
        if (near) {
          const dx = near.pos.x - p.pos.x;
          const dz = near.pos.z - p.pos.z;
          inp.cameraYaw = Math.atan2(dx, dz);
          inp.moveZ = 1;
          inp.sprint = true;
          inp.enterExit = Math.hypot(dx, dz) < near.halfL + 2 && rng.chance(0.3);
        } else {
          inp.moveZ = 1;
        }
      } else {
        inp.moveZ = mode === 0 ? 0 : 1;
        inp.moveX = mode === 2 ? 0.7 : 0;
        inp.sprint = mode === 1;
        inp.jump = rng.chance(0.01);
        inp.enterExit = mode >= 3 && rng.chance(0.05);
        inp.fire = mode === 2 || mode === 5;
        inp.firePressed = inp.fire && rng.chance(0.2);
        inp.aim = inp.fire;
        if (mode === 2) p.inventory.current = 'smg';
        if (mode === 5 && rng.chance(0.02)) p.inventory.current = 'rocket';
        inp.selectSlot = rng.chance(0.002) ? rng.int(0, 5) : -1;
      }
      sim.update(dt, inp);
      maxWanted = Math.max(maxWanted, sim.wanted.level);

      if (f % 60 === 0) {
        expect(allFinite(sim), `non-finite state at frame ${f}`).toBe(true);
        maxVehicles = Math.max(maxVehicles, sim.vehicles.length);
        maxChars = Math.max(maxChars, sim.characters.length);
        // What caps the vehicle count, category by category (see vehicleCensus).
        const census = vehicleCensus(sim);
        maxTarget = Math.max(maxTarget, sim.traffic.targetCount);
        expect(census.traffic, `traffic at frame ${f}`).toBeLessThanOrEqual(maxTarget);
        expect(census.parked, `parked cars at frame ${f}`).toBeLessThanOrEqual(sim.traffic.parkedBySpot.size);
        expect(census.units, `police units at frame ${f}`).toBeLessThanOrEqual(8);
        // After a jump the streaming needs a tick (parked cars: 1.1 s) to drop what was left behind.
        if (sim.time >= jumpedAt + 1.5) expect(census.far, `left behind at frame ${f}`).toEqual([]);
        expect(sim.characters.length).toBeLessThan(170);
        // No vehicle deep inside a building.
        for (const v of sim.vehicles) {
          vehicleObb(v, obb);
          obb.hw = Math.max(0.1, obb.hw - 0.35);
          obb.hl = Math.max(0.1, obb.hl - 0.35);
          obbBounds(obb, bounds);
          sim.world.grid.query(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, (c) => {
            if (c.tag !== 'building' || c.y0 > v.pos.y + 1) return;
            expect(obbVsAabb(obb, c, contact) && contact.depth > 0.5, `vehicle ${v.id} (${v.kind}) inside building at frame ${f}`).toBe(false);
          });
        }
        // Entity bookkeeping is consistent.
        for (const v of sim.vehicles) {
          if (v.driver) expect(v.driver.vehicle).toBe(v);
          for (const o of v.passengers) if (o) expect(o.vehicle).toBe(v);
        }
        for (const c of sim.characters) {
          if (c.state === 'inVehicle') {
            expect(c.vehicle).not.toBeNull();
            expect(c.vehicle!.removed).toBe(false);
          }
        }
        expect(sim.player.removed).toBe(false);
        expect(sim.characters.includes(sim.player)).toBe(true);
      }
    }
    // The bot really exercised the systems.
    expect(maxVehicles).toBeGreaterThan(15);
    expect(maxChars).toBeGreaterThan(20);
    expect(enteredCars).toBeGreaterThan(3);
    expect(maxWanted).toBeGreaterThanOrEqual(4);
    expect(sim.progress.stats.shotsFired).toBeGreaterThan(100);
    void deaths;
  }, 600_000);
});
