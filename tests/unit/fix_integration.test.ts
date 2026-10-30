// Regression tests for the cross-cluster follow-ups made while integrating the fix clusters.

import { describe, expect, it } from 'vitest';
import type { V3 } from '../../src/core/math';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { WATER_Y } from '../../src/world/constants';
import { input, makeSim, placeInCar, roadPoint, step, teleport } from './helpers';

/** Records every crime the wanted system is asked to report. */
function spyCrimes(sim: Sim): string[] {
  const crimes: string[] = [];
  const orig = sim.wanted.crime.bind(sim.wanted);
  sim.wanted.crime = (type, x, z) => {
    crimes.push(type);
    orig(type, x, z);
  };
  return crimes;
}

function damagedBy(sim: Sim, v: Vehicle): Character | undefined {
  return (sim.combat as unknown as { damagedBy: WeakMap<Vehicle, Character> }).damagedBy.get(v);
}

/** Neutral input with the camera at `from`, looking at `at` (visibility decides what streams out). */
function camera(from: V3, at: V3): ReturnType<typeof input> {
  const dx = at.x - from.x;
  const dy = at.y - from.y;
  const dz = at.z - from.z;
  const l = Math.hypot(dx, dy, dz);
  return input({ aimOrigin: { ...from }, aimDir: { x: dx / l, y: dy / l, z: dz / l }, cameraYaw: Math.atan2(dx, dz) });
}

function streamTraffic(sim: Sim): void {
  (sim.traffic as unknown as { streamTraffic(): void }).streamTraffic();
}

describe('cars in the sea', () => {
  it('a swimmer next to a car that drowned takes no fire damage', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    const v = sim.spawnVehicle('sedan', b.landMinX - 20, 0, -Math.PI / 2);
    v.pos.y = WATER_Y;
    step(sim, 5);
    // Sinking marks the car destroyed after 4 s, like a wreck that is still burning out.
    expect(v.inWater).toBe(true);
    expect(v.destroyed).toBe(true);
    teleport(sim, v.pos.x + 1.5, v.pos.z);
    step(sim, 0.5);
    const p = sim.player;
    expect(p.state).toBe('swimming');
    const hp = p.health;
    step(sim, 8);
    expect(p.alive).toBe(true);
    expect(p.health).toBe(hp);
  });

  it('traffic that sank out of sight is cleared away, even in view', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    const v = sim.spawnVehicle('sedan', b.landMinX - 20, 0, -Math.PI / 2);
    v.owner = 'traffic';
    v.pos.y = WATER_Y;
    teleport(sim, b.landMinX + 6, 0);
    const look = camera({ x: b.landMinX + 9, y: 4, z: 0 }, { x: v.pos.x, y: WATER_Y - 2, z: v.pos.z });
    step(sim, 7, look);
    expect(v.sinkTimer).toBeGreaterThan(6);
    expect(v.pos.y + v.spec.height).toBeLessThan(WATER_Y);
    expect(sim.isVisible(v.pos.x, v.pos.y, v.pos.z)).toBe(true);
    streamTraffic(sim);
    expect(v.removed).toBe(true);
  });

  it('a wreck resting in the surf, partly above the water, stays while in view', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    const z = b.landMinZ + 150;
    const v = sim.spawnVehicle('sedan', b.beachStartX + 70, z, Math.PI / 2);
    v.owner = 'traffic';
    v.pos.y = WATER_Y;
    // The player watches from the sand 80 m away (beyond the 60 m at which out-of-view wrecks go).
    teleport(sim, b.beachStartX - 10, z);
    const eye = { x: b.beachStartX - 13, y: 3, z };
    step(sim, 7, camera(eye, v.pos));
    expect(v.inWater).toBe(true);
    expect(v.sinkTimer).toBeGreaterThan(6);
    expect(v.pos.y + v.spec.height).toBeGreaterThan(WATER_Y);
    expect(sim.isVisible(v.pos.x, v.pos.y, v.pos.z)).toBe(true);
    streamTraffic(sim);
    expect(v.removed).toBe(false);
    // Once the player looks away it goes.
    step(sim, 0.1, camera(eye, { x: eye.x - 10, y: eye.y, z }));
    expect(sim.isVisible(v.pos.x, v.pos.y, v.pos.z)).toBe(false);
    streamTraffic(sim);
    expect(v.removed).toBe(true);
  });
});

describe('blame for car crashes', () => {
  /** A police car and the player's sedan on one lane, `gap` m apart; `rammer` drives into the other at 14 m/s. */
  function crash(rammer: 'police' | 'player'): { sim: Sim; cop: Vehicle; crimes: string[] } {
    const sim = makeSim();
    const rp = roadPoint(sim, 40, 30);
    const fx = Math.sin(rp.heading);
    const fz = Math.cos(rp.heading);
    const ahead = sim.spawnVehicle(rammer === 'police' ? 'sedan' : 'police', rp.x, rp.z, rp.heading);
    const behind = sim.spawnVehicle(rammer === 'police' ? 'police' : 'sedan', rp.x - fx * 8, rp.z - fz * 8, rp.heading);
    placeInCar(sim, rammer === 'police' ? ahead : behind);
    behind.vel.x = fx * 14;
    behind.vel.z = fz * 14;
    const crimes = spyCrimes(sim);
    step(sim, 1, input({ throttle: rammer === 'player' ? 1 : 0 }));
    const cop = rammer === 'police' ? behind : ahead;
    expect(cop.health).toBeLessThan(cop.spec.health);
    return { sim, cop, crimes };
  }

  it('a police car ramming the player is not his crime', () => {
    const { sim, cop, crimes } = crash('police');
    expect(crimes).not.toContain('hitPolice');
    expect(sim.wanted.level).toBe(0);
    expect(damagedBy(sim, cop)).toBeUndefined();
  });

  it('the player driving into a police car still is (guard: behaviour preserved)', () => {
    const { sim, cop, crimes } = crash('player');
    expect(crimes).toContain('hitPolice');
    expect(sim.wanted.level).toBeGreaterThan(0);
    expect(damagedBy(sim, cop)).toBe(sim.player);
  });
});

describe('melee', () => {
  it('gang members never punch a crewmate who is in the way', () => {
    const sim = makeSim();
    const rp = roadPoint(sim, 40, 30);
    const thug = sim.spawnCharacter('gang', rp.x, rp.z);
    thug.heading = 0;
    const mate = sim.spawnCharacter('gang', rp.x, rp.z + 0.9);
    teleport(sim, rp.x, rp.z + 1.6);
    const p = sim.player;
    const hp = p.health;
    sim.combat.melee(thug);
    expect(mate.health).toBe(mate.maxHealth);
    // The punch still finds the player behind him.
    expect(p.health).toBeLessThan(hp);
    // Anyone else in the way still gets hit.
    const passer = sim.spawnCharacter('civilian', rp.x, rp.z + 0.6);
    thug.fireCooldown = 0;
    sim.combat.melee(thug);
    expect(passer.health).toBeLessThan(passer.maxHealth);
  });
});
