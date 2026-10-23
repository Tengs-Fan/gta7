// Wave 1 track C, driving (VAL-DRIVE-001, 003..006): the player's handbrake drift, the drawn suspension over curbs,
// cars landing on other cars' roofs, the people in a sinking car, and the driver of a burning car staying drawn.
// The render modules run headless on the canvas/document stub of fix_render.test.ts (copied: vi.hoisted cannot be shared).

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({
    width: 300,
    height: 150,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

import { CrowdView } from '../../src/render/crowd';
import { Suspension } from '../../src/render/suspension';
import { VehicleView } from '../../src/render/vehicleView';
import type { DamageKind } from '../../src/sim/combat';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { drownsInSinkingCar } from '../../src/sim/sinking';
import { DRIFT_MIN_SPEED } from '../../src/sim/vehiclePhysics';
import type { VehicleKind } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import { input, makeSim, placeInCar, roadPoint, step } from './helpers';

const DEG = 180 / Math.PI;

/** Angle (rad, unsigned) between a car's heading and its velocity. */
function slip(v: Vehicle): number {
  if (Math.hypot(v.vel.x, v.vel.z) < 1) return 0;
  let d = Math.atan2(v.vel.x, v.vel.z) - v.heading;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs(d);
}

describe('VAL-DRIVE-001: the handbrake starts a measurable drift', () => {
  /** Full steer for 1.5 s at 25 m/s (with the handbrake in run B), where the car stands on a long lane. */
  function turn(kind: VehicleKind, handbrake: boolean) {
    const sim = makeSim();
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
    placeInCar(sim, v);
    v.vel.x = Math.sin(rp.heading) * 25;
    v.vel.z = Math.cos(rp.heading) * 25;
    // Held in place (open ground is not needed for the tyres' dynamics, which do not depend on where the car is).
    const hold = () => {
      v.pos.x = rp.x;
      v.pos.z = rp.z;
    };
    let peakSlip = 0;
    let peakYaw = 0;
    const trace: number[] = [];
    for (let f = 0; f < 90; f++) {
      step(sim, 1 / 60, input({ steer: 1, handbrake, throttle: 0.3 }));
      hold();
      peakSlip = Math.max(peakSlip, slip(v));
      peakYaw = Math.max(peakYaw, Math.abs(v.angVel));
      trace.push(slip(v));
    }
    const h0 = v.heading;
    let recovered = -1;
    let swung = 0;
    for (let f = 0; f < 150 && recovered < 0; f++) {
      let d = Math.atan2(v.vel.x, v.vel.z) - v.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      // Countersteer towards the direction of travel.
      step(sim, 1 / 60, input({ steer: Math.max(-1, Math.min(1, -d * 3)), throttle: 0.3 }));
      hold();
      let t = v.heading - h0;
      t = Math.atan2(Math.sin(t), Math.cos(t));
      swung = Math.max(swung, Math.abs(t));
      if (slip(v) < 5 / DEG) recovered = (f + 1) / 60;
    }
    return { peakSlip, peakYaw, recovered, swung, speed: v.speed, trace };
  }

  it.each(['sedan', 'sports', 'muscle'] as const)('the %s: twice the slip (12 degrees or more) and 1.3x the yaw rate, and it recovers within 2.5 s', (kind) => {
    const a = turn(kind, false);
    const b = turn(kind, true);
    console.log(`[drive] ${kind}: A slip ${(a.peakSlip * DEG).toFixed(1)}deg yaw ${a.peakYaw.toFixed(2)} rad/s; B slip ${(b.peakSlip * DEG).toFixed(1)}deg yaw ${b.peakYaw.toFixed(2)} rad/s, recovered in ${b.recovered.toFixed(2)} s, swung ${(b.swung * DEG).toFixed(0)}deg from the drift's start, ${b.speed.toFixed(1)} m/s after`);
    expect(b.peakSlip).toBeGreaterThanOrEqual(2 * a.peakSlip);
    expect(b.peakSlip).toBeGreaterThanOrEqual(12 / DEG);
    expect(b.peakYaw).toBeGreaterThanOrEqual(1.3 * a.peakYaw);
    expect(b.recovered).toBeGreaterThan(0);
    expect(b.recovered).toBeLessThanOrEqual(2.5);
    expect(b.swung).toBeLessThan(Math.PI);
    // Same seed, same drift.
    expect(turn(kind, true).trace).toEqual(b.trace);
  });

  it.each(['sedan', 'sports', 'muscle'] as const)('the %s on a straight with the handbrake slows and keeps its heading within 5 degrees', (kind) => {
    const sim = makeSim();
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
    placeInCar(sim, v);
    v.vel.x = Math.sin(rp.heading) * 25;
    v.vel.z = Math.cos(rp.heading) * 25;
    step(sim, 1.5, input({ handbrake: true }));
    let d = v.heading - rp.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    expect(v.speed).toBeLessThan(22);
    expect(Math.abs(d)).toBeLessThan(5 / DEG);
  });

  it('AI and police drivers never hold the handbrake at drift speed: 60 s of traffic and a 3-star chase', () => {
    const sim = makeSim({ ambient: true, seed: 2 });
    const rp = roadPoint(sim);
    const car = sim.spawnVehicle('sports', rp.x, rp.z, rp.heading);
    placeInCar(sim, car);
    sim.wanted.setLevel(3);
    let checked = 0;
    for (let f = 0; f < 60 * 60; f++) {
      step(sim, 1 / 60, input({ throttle: 0.6, steer: Math.sin(f / 90) * 0.4 }));
      for (const v of sim.vehicles) {
        if (v.removed || !v.ai || !v.driver || v.driver.isPlayer) continue;
        checked++;
        if (v.controls.handbrake) expect(Math.abs(v.forwardSpeed), `${v.kind} #${v.id}`).toBeLessThanOrEqual(DRIFT_MIN_SPEED);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  }, 120_000);
});

/** A straight run (m) from a road onto raised ground: a curb with at least `room` m of clear sidewalk or plaza beyond it. */
function findCurb(sim: Sim, room: number): { x: number; z: number; ux: number; uz: number } {
  const w = sim.world;
  for (const lane of sim.roads.lanes) {
    if (lane.length < 40) continue;
    const mx = lane.sx + lane.dx * lane.length * 0.5;
    const mz = lane.sz + lane.dz * lane.length * 0.5;
    for (const side of [1, -1]) {
      const ux = -lane.dz * side;
      const uz = lane.dx * side;
      let edge = -1;
      for (let d = 0; d < 20; d += 0.1) {
        if (w.baseGround(mx + ux * d, mz + uz * d) > 0.1) {
          edge = d;
          break;
        }
      }
      if (edge < 0) continue;
      let ok = true;
      for (let d = edge + 0.2; d < edge + room && ok; d += 0.5) {
        const x = mx + ux * d;
        const z = mz + uz * d;
        if (Math.abs(w.baseGround(x, z) - w.baseGround(mx + ux * (edge + 0.3), mz + uz * (edge + 0.3))) > 0.01 || !w.isFree(x, z, 1.3)) ok = false;
      }
      if (ok) return { x: mx + ux * edge, z: mz + uz * edge, ux, uz };
    }
  }
  throw new Error('no curb found');
}

describe('VAL-DRIVE-003: the drawn body pitches and rolls over bumps and curbs', () => {
  /** The drawn pitch and roll (rad, nose up and left side up positive) of a sedan's view each frame of `frames`. */
  function drive(setup: (sim: Sim, v: Vehicle) => void, frames: number, withView = true) {
    const sim = makeSim();
    const v = sim.spawnVehicle('sedan', 0, 0, 0);
    placeInCar(sim, v);
    setup(sim, v);
    const view = new VehicleView('sedan');
    view.suspension = new Suspension(sim.world);
    view.bind(v);
    const pitch: number[] = [];
    const roll: number[] = [];
    const path: number[] = [];
    for (let f = 0; f < frames; f++) {
      step(sim, 1 / 60, input({ throttle: v.forwardSpeed < 8 ? 0.6 : 0.15 }));
      if (withView) {
        view.sync(v, 1 / 60, f / 60, 0);
        pitch.push(-view.group.rotation.x);
        roll.push(view.group.rotation.z);
      }
      path.push(v.pos.x, v.pos.y, v.pos.z, v.heading);
    }
    return { pitch, roll, path, v };
  }

  it('mounting a curb at 8 m/s pitches the body by 1 degree within 0.3 s, and it settles within 1.0 s; the sim does not notice', () => {
    let curb!: ReturnType<typeof findCurb>;
    const setup = (sim: Sim, v: Vehicle) => {
      curb = findCurb(sim, 14);
      v.pos.x = curb.x - curb.ux * 4;
      v.pos.z = curb.z - curb.uz * 4;
      v.pos.y = sim.world.groundHeight(v.pos.x, v.pos.z);
      v.heading = Math.atan2(curb.ux, curb.uz);
      v.vel.x = curb.ux * 8;
      v.vel.z = curb.uz * 8;
    };
    const r = drive(setup, 120);
    // The front wheels reach the curb when the nose (wheel 0.72 half lengths ahead) has covered 4 - 1.7 m.
    const rest0 = r.pitch[5]!;
    const hit = Math.round(((4 - r.v.halfL * 0.72) / 8) * 60);
    const window = r.pitch.slice(hit, hit + 18);
    const change = Math.max(...window.map((p) => Math.abs(p - rest0)));
    // At rest on the sidewalk: the last 0.25 s. Settled = within 0.2 degrees of it, 1 s after the rear wheels mount.
    const rest1 = r.pitch.slice(-15).reduce((a, b) => a + b, 0) / 15;
    const rearUp = hit + Math.round(((r.v.halfL * 1.44) / 8) * 60);
    const after = r.pitch.slice(rearUp + 60);
    console.log(`[drive] curb pitch trace (deg, every 0.05 s): ${r.pitch.filter((_, i) => i % 3 === 0).map((p) => (p * DEG).toFixed(2)).join(' ')}`);
    expect(change).toBeGreaterThanOrEqual(1 / DEG);
    for (const p of after) expect(Math.abs(p - rest1)).toBeLessThanOrEqual(0.2 / DEG);
    // Presentation only: the same run without any view moves the car exactly the same.
    expect(drive(setup, 120, false).path).toEqual(r.path);
  });

  it('a curb under one side rolls the body by more than a degree; flat road at constant speed varies under 0.2 degrees', () => {
    const r = drive((sim, v) => {
      const curb = findCurb(sim, 6);
      // Along the curb, its left wheels on the sidewalk.
      v.heading = Math.atan2(-curb.uz, curb.ux);
      const lx = Math.cos(v.heading);
      const lz = -Math.sin(v.heading);
      v.pos.x = curb.x - lx * 0.1;
      v.pos.z = curb.z - lz * 0.1;
      v.pos.y = sim.world.groundHeight(v.pos.x, v.pos.z);
    }, 60);
    const settled = r.roll.slice(-20);
    console.log(`[drive] straddling a curb: roll ${(settled[settled.length - 1]! * DEG).toFixed(2)}deg`);
    for (const a of settled) expect(Math.abs(a)).toBeGreaterThanOrEqual(1 / DEG);
    const flat = drive((sim, v) => {
      const rp = roadPoint(sim);
      v.pos.x = rp.x;
      v.pos.z = rp.z;
      v.heading = rp.heading;
      v.vel.x = Math.sin(rp.heading) * 8;
      v.vel.z = Math.cos(rp.heading) * 8;
    }, 120);
    const p = flat.pitch.slice(30);
    const q = flat.roll.slice(30);
    const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
    console.log(`[drive] flat road: pitch spread ${(spread(p) * DEG).toFixed(3)}deg, roll spread ${(spread(q) * DEG).toFixed(3)}deg`);
    expect(spread(p)).toBeLessThan(0.2 / DEG);
    expect(spread(q)).toBeLessThan(0.2 / DEG);
  });
});

describe('VAL-DRIVE-004: a car landing on another does not snap sideways', () => {
  /** Largest horizontal step of each car not explained by its velocity, over `seconds`. */
  function track(sim: Sim, cars: Vehicle[], seconds: number, each?: () => void, throttle = 0): number[] {
    const jump = cars.map(() => 0);
    for (let f = 0; f < seconds * 60; f++) {
      const before = cars.map((c) => ({ x: c.pos.x, z: c.pos.z }));
      step(sim, 1 / 60, input({ throttle: sim.player.vehicle?.airborne ? 0 : throttle }));
      cars.forEach((c, i) => {
        jump[i] = Math.max(jump[i]!, Math.hypot(c.pos.x - before[i]!.x - c.vel.x / 60, c.pos.z - before[i]!.z - c.vel.z / 60));
      });
      each?.();
    }
    return jump;
  }
  const finite = (v: Vehicle) => [v.pos.x, v.pos.y, v.pos.z, v.heading, v.pitch, v.roll].every(Number.isFinite);
  /** Whether two cars' bodies overlap (boxes, heights included). */
  function inside(a: Vehicle, b: Vehicle): boolean {
    if (a.pos.y >= b.pos.y + b.spec.height - 0.05 || b.pos.y >= a.pos.y + a.spec.height - 0.05) return false;
    const corners = (v: Vehicle) => [1, -1].flatMap((s) => [1, -1].map((t) => ({ x: v.pos.x + Math.sin(v.heading) * v.halfL * s * 0.9 + Math.cos(v.heading) * v.halfW * t * 0.9, z: v.pos.z + Math.cos(v.heading) * v.halfL * s * 0.9 - Math.sin(v.heading) * v.halfW * t * 0.9 })));
    const within = (p: { x: number; z: number }, v: Vehicle) => {
      const dx = p.x - v.pos.x;
      const dz = p.z - v.pos.z;
      return Math.abs(dx * Math.sin(v.heading) + dz * Math.cos(v.heading)) < v.halfL && Math.abs(dx * Math.cos(v.heading) - dz * Math.sin(v.heading)) < v.halfW;
    };
    return corners(a).some((p) => within(p, b)) || corners(b).some((p) => within(p, a));
  }

  it.each(['sedan', 'bus', 'van'] as const)('a sedan dropped from 2 m onto a %s settles on its roof', (lower) => {
    const sim = makeSim();
    const rp = roadPoint(sim);
    const low = sim.spawnVehicle(lower, rp.x, rp.z, rp.heading);
    const top = sim.spawnVehicle('sedan', rp.x + 0.3, rp.z, rp.heading + 0.4);
    top.pos.y = low.pos.y + low.spec.height + 2;
    top.airborne = true;
    const jumps = track(sim, [top, low], 3);
    console.log(`[drive] dropped on a ${lower}: max per-step jump top ${jumps[0]!.toFixed(3)} m, ${lower} ${jumps[1]!.toFixed(3)} m; top rests ${(top.pos.y - low.pos.y).toFixed(2)} m up`);
    for (const j of jumps) expect(j).toBeLessThanOrEqual(0.3);
    expect(top.airborne).toBe(false);
    expect(top.pos.y).toBeCloseTo(low.pos.y + low.spec.height, 2);
    expect(finite(top) && finite(low)).toBe(true);
    expect(top.flipped).toBe(false);
    expect(inside(top, low)).toBe(false);
  });

  it.each(['sedan', 'bus', 'van'] as const)('a sedan launched off a stunt ramp landing on a %s touches down on its roof, then rests there or slides off', (lower) => {
    const run = (target: { x: number; z: number } | null, height: number) => {
      const sim = makeSim();
      const r = sim.world.layout.ramps[2]!;
      const fx = Math.sin(r.heading);
      const fz = Math.cos(r.heading);
      const car = sim.spawnVehicle('sedan', r.x - fx * (r.length / 2 + 12), r.z - fz * (r.length / 2 + 12), r.heading);
      placeInCar(sim, car);
      car.vel.x = fx * 28;
      car.vel.z = fz * 28;
      const low = target ? sim.spawnVehicle(lower, target.x, target.z, r.heading + Math.PI / 2) : null;
      let peak = -Infinity;
      let crossing: { x: number; z: number } | null = null;
      let onRoof = false;
      const jumps = track(sim, low ? [car, low] : [car], 5, () => {
        if (car.airborne) peak = Math.max(peak, car.pos.y);
        // Where it comes down through the height of the roof (this run's target for the next).
        if (!crossing && car.airborne && car.pos.y < peak - 0.01 && car.pos.y <= sim.world.groundHeight(car.pos.x, car.pos.z) + height + 0.05) {
          crossing = { x: car.pos.x + (car.vel.x / 60) * 6, z: car.pos.z + (car.vel.z / 60) * 6 };
        }
        if (low && !car.airborne && Math.abs(car.pos.y - (low.pos.y + low.spec.height)) < 0.05) onRoof = true;
      }, 0.6);
      return { crossing, jumps, car, low, onRoof };
    };
    const probe = makeSim().spawnVehicle(lower, 0, 0, 0).spec.height;
    const free = run(null, probe);
    expect(free.crossing).not.toBeNull();
    const r = run(free.crossing, probe);
    console.log(`[drive] ramp onto a ${lower}: max per-step jump top ${r.jumps[0]!.toFixed(3)} m, ${lower} ${r.jumps[1]!.toFixed(3)} m; touched its roof ${r.onRoof}; ends ${(r.car.pos.y - r.low!.pos.y).toFixed(2)} m up, ${Math.hypot(r.car.pos.x - r.low!.pos.x, r.car.pos.z - r.low!.pos.z).toFixed(1)} m off its centre`);
    expect(r.onRoof).toBe(true);
    for (const j of r.jumps) expect(j).toBeLessThanOrEqual(0.3);
    expect(finite(r.car) && finite(r.low!)).toBe(true);
    expect(inside(r.car, r.low!)).toBe(false);
  });
});

describe('VAL-DRIVE-005: people in a sinking car swim out or drown, and are counted', () => {
  /** A sedan with `n` NPC passengers (and the player at the wheel, or an NPC) driven off the Marina deck into deep water. */
  function sink(playerDriving: boolean, passengers: number, role: 'civilian' | 'cop' = 'civilian') {
    const sim = makeSim({ seed: 4 });
    const deck = sim.world.layout.decks.find((d) => d.name === 'Marina' && d.rect.maxX - d.rect.minX > 50)!.rect;
    // Off the main deck's east end, heading east into 7 m of water.
    const v = sim.spawnVehicle('sedan', deck.maxX - 4, (deck.minZ + deck.maxZ) / 2, Math.PI / 2);
    const people: Character[] = [];
    if (playerDriving) placeInCar(sim, v);
    else people.push(sim.addDriver(v, 'civilian', 'traffic'));
    if (!playerDriving) v.ai = null;
    for (let i = 0; i < passengers; i++) {
      const c = sim.spawnCharacter(role, v.pos.x, v.pos.z);
      sim.seat(c, v, i + 1);
      people.push(c);
    }
    const kinds = new Map<Character, DamageKind>();
    sim.events.on('damage', (e) => {
      if (e.victim && people.includes(e.victim)) kinds.set(e.victim, e.kind);
    });
    const crimes: string[] = [];
    const crime = sim.wanted.crime.bind(sim.wanted);
    sim.wanted.crime = (type, x, z, by) => {
      crimes.push(type);
      return crime(type, x, z, by);
    };
    const kills0 = sim.progress.stats.kills;
    v.vel.x = 14;
    let under = -1;
    for (let f = 0; f < 60 * 16; f++) {
      const c = v.controls;
      if (!playerDriving) c.throttle = 1;
      step(sim, 1 / 60, input({ throttle: playerDriving ? 1 : 0 }));
      if (under < 0 && v.inWater) under = sim.time;
      if (under >= 0 && sim.time - under > 10.5) break;
    }
    return { sim, v, people, kinds, crimes, kills: sim.progress.stats.kills - kills0, under };
  }

  it('the player driving three passengers off the quay: he swims, they swim or drown, and the drowned are his kills', () => {
    const r = sink(true, 3);
    expect(r.under).toBeGreaterThan(0);
    expect(r.sim.player.state).toBe('swimming');
    let drowned = 0;
    for (const c of r.people) {
      const out = c.alive ? (c.state === 'swimming' ? 'swimming' : c.state) : `dead (${r.kinds.get(c)})`;
      console.log(`[drive] sinking, player driving: passenger #${c.id} ${out}, removed ${c.removed}, fated to drown ${drownsInSinkingCar(c)}`);
      expect(r.sim.characters).toContain(c);
      expect(c.removed).toBe(false);
      // Swimming, or already out of the water (the Marina deck is a few strokes away).
      if (c.alive) expect(c.state === 'swimming' || (c.state === 'normal' && r.sim.world.waterDepth(c.pos.x, c.pos.z) <= 0)).toBe(true);
      else {
        expect(r.kinds.get(c)).toBe('drown');
        drowned++;
      }
    }
    console.log(`[drive] kills counted ${r.kills}, crimes ${r.crimes.join(',') || 'none'}`);
    expect(drowned).toBeGreaterThan(0);
    expect(r.kills).toBe(drowned);
    expect(r.crimes).toContain('murder');
  });

  it('a police officer drowned that way is a killCop, as when the player kills one any other way', () => {
    // Enough officers that at least one is fated to drown.
    const r = sink(true, 3, 'cop');
    const drowned = r.people.filter((c) => !c.alive);
    console.log(`[drive] officers in the sinking car: ${r.people.map((c) => (c.alive ? c.state : `dead (${r.kinds.get(c)})`)).join(', ')}; crimes ${r.crimes.join(',')}`);
    expect(drowned.length).toBeGreaterThan(0);
    expect(r.crimes).toContain('killCop');
    expect(r.kills).toBe(drowned.length);
  });

  it('an ambient car sinking with no player involvement: its people swim or drown, and nothing is counted against him', () => {
    const r = sink(false, 3);
    expect(r.under).toBeGreaterThan(0);
    for (const c of r.people) {
      expect(c.removed).toBe(false);
      // Swimming, or already out of the water (the Marina deck is a few strokes away).
      if (c.alive) expect(c.state === 'swimming' || (c.state === 'normal' && r.sim.world.waterDepth(c.pos.x, c.pos.z) <= 0)).toBe(true);
      else expect(r.kinds.get(c)).toBe('drown');
    }
    console.log(`[drive] ambient sinking: ${r.people.map((c) => (c.alive ? c.state : `dead (${r.kinds.get(c)})`)).join(', ')}; kills ${r.kills}, wanted ${r.sim.wanted.level}`);
    expect(r.kills).toBe(0);
    expect(r.sim.wanted.level).toBe(0);
    expect(r.crimes).toEqual([]);
  });

  it('drowning is fixed per character, about a third of them', () => {
    const sim = makeSim();
    let n = 0;
    for (let i = 0; i < 300; i++) if (drownsInSinkingCar(sim.spawnCharacter('civilian', 0, 0))) n++;
    expect(n / 300).toBeGreaterThan(0.2);
    expect(n / 300).toBeLessThan(0.5);
    expect(WATER_Y).toBeLessThan(0);
  });
});

describe('VAL-DRIVE-006: a burning car keeps its driver visible', () => {
  it('the crowd view draws the seated driver and passenger of a burning car, and no longer once it has blown up', () => {
    const sim = makeSim();
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    const driver = sim.addDriver(v, 'civilian', 'traffic');
    v.ai = null;
    const passenger = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
    sim.seat(passenger, v, 1);
    const view = new VehicleView('sedan');
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    const cv = new CrowdView();
    const heads = () => (cv as unknown as { parts: Record<string, { mesh: THREE.InstancedMesh }> }).parts.head!.mesh.count;
    sim.combat.igniteVehicle(v, 5);
    expect(v.burning).toBe(true);
    // Still in their seats (the views alone: the sim would have them bail out of the fire).
    for (let f = 0; f < 30; f++) {
      view.sync(v, 1 / 60, f / 60, 0);
      cv.sync([driver, passenger], v.pos.x + 6, v.pos.z, 1 / 60);
      expect(heads()).toBe(2);
    }
    v.destroyed = true;
    cv.sync([driver, passenger], v.pos.x + 6, v.pos.z, 1 / 60);
    expect(heads()).toBe(0);
  });
});
