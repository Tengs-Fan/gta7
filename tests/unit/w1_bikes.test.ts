// Wave 1 track C, motorbikes (VAL-BIKE-001..007): two bike kinds as data, riding, entering and stealing like cars, lean
// and wheelie, falling off in a crash, bikes in ambient traffic and in a police chase. Rendering is covered by
// w1_vehicle_views.test.ts and tests/e2e/w1_vehicles.spec.ts.

import { describe, expect, it } from 'vitest';
import { BIKE_UPRIGHT } from '../../src/sim/bikePhysics';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { PARKED_BIKE_EVERY, PARKED_MIX, parkedBike, TRAFFIC_BIKES, TRAFFIC_MIX, trafficBike, VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { input, makeSim, placeInCar, roadPoint, step } from './helpers';
import { at, dist, fleeBot, liveUnits, longestLane, officer, startLane, stepUntil } from './r2_police_helpers';

const BIKES = Object.values(VEHICLE_SPECS).filter((s) => s.class === 'bike').map((s) => s.kind);
const DEG = 180 / Math.PI;

/** A bike of `kind` on a long straight lane, with the player riding it (or nobody). */
function bikeOnRoad(kind: VehicleKind, ride = true, seed = 7): { sim: Sim; bike: Vehicle } {
  const sim = makeSim({ seed });
  const rp = roadPoint(sim);
  const bike = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
  if (ride) placeInCar(sim, bike);
  return { sim, bike };
}

/** A wall across the lane `ahead` m in front of `v` (a box 6 m wide, 0.6 m thick, 3 m tall). */
function wallAhead(sim: Sim, v: Vehicle, ahead: number): void {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const cx = v.pos.x + fx * (ahead + 0.3);
  const cz = v.pos.z + fz * (ahead + 0.3);
  const xs = [cx - 3 * fz - 0.3 * fx, cx + 3 * fz + 0.3 * fx, cx - 3 * fz + 0.3 * fx, cx + 3 * fz - 0.3 * fx];
  const zs = [cz + 3 * fx - 0.3 * fz, cz - 3 * fx + 0.3 * fz, cz + 3 * fx + 0.3 * fz, cz - 3 * fx - 0.3 * fz];
  sim.world.grid.addBox(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), 0, 3, 'wall');
}

describe('VAL-BIKE-001: two motorbike kinds as data', () => {
  it('a sport bike and a scooter, class bike, the sport bike faster and quicker', () => {
    expect(BIKES.sort()).toEqual(['scooter', 'sportbike']);
    for (const k of BIKES) {
      const s = VEHICLE_SPECS[k];
      expect(s.class).toBe('bike');
      expect(s.name.length).toBeGreaterThan(2);
      expect([1, 2]).toContain(s.seats);
      for (const f of [s.mass, s.accel, s.maxSpeed, s.grip]) expect(f).toBeGreaterThan(0);
      expect(s.bike!.leanCap).toBeLessThanOrEqual(Math.PI / 4);
    }
    expect(VEHICLE_SPECS.sportbike.maxSpeed).toBeGreaterThan(VEHICLE_SPECS.scooter.maxSpeed);
    expect(VEHICLE_SPECS.sportbike.accel).toBeGreaterThan(VEHICLE_SPECS.scooter.accel);
    console.log(`[bike] specs: ${BIKES.map((k) => { const s = VEHICLE_SPECS[k]; return `${k} "${s.name}" seats ${s.seats} mass ${s.mass} accel ${s.accel} maxSpeed ${s.maxSpeed} grip ${s.grip} leanCap ${(s.bike!.leanCap * DEG).toFixed(1)}deg wheelie ${s.bike!.wheelie ? `${(s.bike!.wheelie.pitch * DEG).toFixed(1)}deg below ${s.bike!.wheelie.speed} m/s` : 'none'}`; }).join('; ')}`);
  });

  it.each(BIKES)('the %s spawns, seats the player and rides; same-seed runs match at every step', (kind) => {
    const runOnce = () => {
      const { sim, bike } = bikeOnRoad(kind);
      expect(sim.player.vehicle?.kind).toBe(kind);
      const trace: number[] = [];
      for (let f = 0; f < 600; f++) {
        step(sim, 1 / 60, input({ throttle: f % 200 < 150 ? 1 : 0, brake: f % 200 >= 170 ? 1 : 0, steer: Math.sin(f / 50) * 0.6 }));
        trace.push(bike.pos.x, bike.pos.z, bike.heading, bike.lean, bike.wheelie);
      }
      expect(bike.speed).toBeGreaterThan(0);
      return trace;
    };
    expect(runOnce()).toEqual(runOnce());
  });
});

describe('VAL-BIKE-002: entering, leaving and stealing a bike', () => {
  it.each(BIKES)('F next to a parked %s seats the player within 2 s; F again puts him on foot beside it', (kind) => {
    const { sim, bike } = bikeOnRoad(kind, false);
    const p = sim.player;
    const side = { x: Math.cos(bike.heading), z: -Math.sin(bike.heading) };
    p.pos.x = bike.pos.x + side.x * 1.6;
    p.pos.z = bike.pos.z + side.z * 1.6;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    expect(dist(p.pos, bike.pos)).toBeLessThan(2);
    step(sim, 1 / 60, input({ enterExit: true }));
    const seatedAt = stepUntil(sim, 2, () => p.vehicle === bike);
    expect(seatedAt, 'seated within 2 s').toBeGreaterThanOrEqual(0);
    step(sim, 1 / 60, input({ enterExit: true }));
    const offAt = stepUntil(sim, 2, () => p.state === 'normal' && !p.vehicle);
    expect(offAt, 'on foot within 2 s').toBeGreaterThanOrEqual(0);
    expect(sim.vehicles).toContain(bike);
    expect(dist(p.pos, bike.pos)).toBeLessThan(2.5);
    // Already on it, F does not seat him twice: it gets him off.
    step(sim, 1 / 60, input({ enterExit: true }));
    stepUntil(sim, 2, () => p.vehicle === bike);
    expect(bike.driver).toBe(p);
    expect(bike.passengers.includes(p)).toBe(false);
  });

  /** Steals an occupied `kind` held at a stop by its NPC driver; the crimes and the events in the meantime. */
  function steal(kind: VehicleKind): { crimes: string[]; events: string[]; victim: Character; sim: Sim; v: Vehicle } {
    const sim = makeSim({ seed: 3 });
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
    const victim = sim.addDriver(v, 'civilian', 'traffic');
    victim.owner = 'traffic';
    v.owner = 'traffic';
    v.ai!.hold = true;
    const p = sim.player;
    p.pos.x = v.pos.x + Math.cos(v.heading) * (v.halfW + 1);
    p.pos.z = v.pos.z - Math.sin(v.heading) * (v.halfW + 1);
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    const crimes: string[] = [];
    const crime = sim.wanted.crime.bind(sim.wanted);
    sim.wanted.crime = (type, x, z, by) => {
      crimes.push(type);
      return crime(type, x, z, by);
    };
    const events: string[] = [];
    const emit = sim.events.emit.bind(sim.events);
    sim.events.emit = ((type: string, payload: unknown) => {
      if (!events.includes(type)) events.push(type);
      (emit as (t: string, p: unknown) => void)(type, payload);
    }) as typeof sim.events.emit;
    step(sim, 1 / 60, input({ enterExit: true }));
    const t = stepUntil(sim, 3, () => p.vehicle === v);
    expect(t, `${kind} seated`).toBeGreaterThanOrEqual(0);
    return { crimes, events: events.sort(), victim, sim, v };
  }

  it('stealing a ridden bike pulls the rider off and is the same crime and events as stealing an occupied sedan', () => {
    const car = steal('sedan');
    for (const kind of BIKES) {
      const bike = steal(kind);
      console.log(`[bike] steal ${kind}: crimes ${bike.crimes.join(',')} events ${bike.events.join(',')} (sedan: ${car.crimes.join(',')} / ${car.events.join(',')}); rider ${bike.victim.state}, removed ${bike.victim.removed}`);
      expect(bike.crimes).toEqual(car.crimes);
      expect(bike.events).toEqual(car.events);
      expect(bike.victim.removed).toBe(false);
      expect(bike.victim.vehicle).toBeNull();
      expect(['knocked', 'normal']).toContain(bike.victim.state);
      expect(bike.v.driver).toBe(bike.sim.player);
    }
    expect(car.crimes).toContain('carjack');
  });
});

/** Holds a bike at `speed` m/s with `steer` for `seconds` where it stands (so open ground is not needed); the leans seen. */
function holdTurn(sim: Sim, bike: Vehicle, speed: number, steer: number, seconds: number): number[] {
  const x = bike.pos.x;
  const z = bike.pos.z;
  const out: number[] = [];
  for (let f = 0; f < seconds * 60; f++) {
    step(sim, 1 / 60, input({ steer, throttle: 0.3 }));
    const s = Math.hypot(bike.vel.x, bike.vel.z) || 1;
    bike.vel.x *= speed / s;
    bike.vel.z *= speed / s;
    bike.pos.x = x;
    bike.pos.z = z;
    out.push(bike.lean);
  }
  return out;
}

describe('VAL-BIKE-003: bikes lean into turns, within a cap', () => {
  it.each(BIKES)('the %s leans with the turn, more with more lateral acceleration, never past its cap, and straightens within 1 s', (kind) => {
    const cap = VEHICLE_SPECS[kind].bike!.leanCap;
    const peak: Record<string, number> = {};
    const rows: string[] = [];
    for (const speed of [10, 20, 30]) {
      for (const [side, steer] of [['left', -1], ['right', 1]] as const) {
        const { sim, bike } = bikeOnRoad(kind);
        bike.vel.x = Math.sin(bike.heading) * speed;
        bike.vel.z = Math.cos(bike.heading) * speed;
        const leans = holdTurn(sim, bike, speed, steer, 3);
        const settled = leans.slice(-60);
        // Leans left (negative) in a left turn, right in a right one.
        for (const l of settled) expect(Math.sign(l), `${kind} ${speed} m/s ${side}`).toBe(Math.sign(steer));
        for (const l of leans) expect(Math.abs(l)).toBeLessThanOrEqual(cap + 1e-9);
        peak[`${speed}${side}`] = Math.max(...settled.map(Math.abs));
        // Released on the straight: upright (under 2 degrees) within 1.0 s.
        let upright = -1;
        for (let f = 0; f < 90 && upright < 0; f++) {
          step(sim, 1 / 60, input({ throttle: 0.3 }));
          if (Math.abs(bike.lean) < 2 / DEG) upright = (f + 1) / 60;
        }
        expect(upright, `${kind} ${speed} ${side} back upright`).toBeGreaterThan(0);
        expect(upright).toBeLessThanOrEqual(1.0);
        rows.push(`${speed} m/s ${side}: ${(peak[`${speed}${side}`]! * DEG).toFixed(1)}deg, upright in ${upright.toFixed(2)} s`);
      }
    }
    console.log(`[bike] lean ${kind} (cap ${(cap * DEG).toFixed(1)}deg): ${rows.join('; ')}`);
    expect(peak['20left']!).toBeGreaterThan(peak['10left']! - 1e-9);
    expect(peak['20right']!).toBeGreaterThan(peak['10right']! - 1e-9);
    // Below the cap at 10 m/s the lean still grows with the lateral acceleration.
    expect(peak['10left']!).toBeLessThan(cap);
    expect(peak['20left']!).toBeGreaterThan(peak['10left']! + 0.5 / DEG);
  });

  it('a sweep over speeds and steering never gives a non-finite lean or one past the cap', () => {
    let max = 0;
    for (const kind of BIKES) {
      const cap = VEHICLE_SPECS[kind].bike!.leanCap;
      let seed = 12345;
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      for (let k = 0; k < 40; k++) {
        const { sim, bike } = bikeOnRoad(kind);
        const speed = rnd() * VEHICLE_SPECS[kind].maxSpeed;
        const steer = rnd() * 2 - 1;
        bike.vel.x = Math.sin(bike.heading) * speed;
        bike.vel.z = Math.cos(bike.heading) * speed;
        for (const l of holdTurn(sim, bike, speed, steer, 0.5)) {
          expect(Number.isFinite(l)).toBe(true);
          expect(Math.abs(l)).toBeLessThanOrEqual(cap + 1e-9);
          max = Math.max(max, Math.abs(l));
        }
      }
    }
    console.log(`[bike] lean sweep: 80 runs, max lean ${(max * DEG).toFixed(1)}deg`);
  });
});

describe('VAL-BIKE-004: the sport bike wheelies at low speed, the scooter does not', () => {
  it('full throttle from a stop lifts the sport bike front over 8 degrees for over 0.5 s below its wheelie speed', () => {
    const { sim, bike } = bikeOnRoad('sportbike');
    const w = VEHICLE_SPECS.sportbike.bike!.wheelie!;
    let above = 0;
    let max = 0;
    let aboveLimitAt = -1;
    let downAt = -1;
    const trace: string[] = [];
    for (let f = 0; f < 240; f++) {
      step(sim, 1 / 60, input({ throttle: 1 }));
      max = Math.max(max, bike.wheelie);
      if (bike.wheelie > 8 / DEG && bike.forwardSpeed < w.speed) above += 1 / 60;
      if (aboveLimitAt < 0 && bike.forwardSpeed >= w.speed) aboveLimitAt = f / 60;
      if (aboveLimitAt >= 0 && downAt < 0 && bike.wheelie < 2 / DEG) downAt = f / 60 - aboveLimitAt;
      if (f % 15 === 0) trace.push(`${(bike.wheelie * DEG).toFixed(1)}@${bike.forwardSpeed.toFixed(1)}`);
      expect(bike.driver).toBe(sim.player);
    }
    console.log(`[bike] sportbike wheelie from a stop: over 8deg for ${above.toFixed(2)} s, max ${(max * DEG).toFixed(1)}deg, down under 2deg ${downAt.toFixed(2)} s after passing ${w.speed} m/s; trace ${trace.join(' ')}`);
    expect(above).toBeGreaterThanOrEqual(0.5);
    expect(max).toBeLessThanOrEqual(40 / DEG);
    expect(downAt).toBeGreaterThanOrEqual(0);
    expect(downAt).toBeLessThanOrEqual(1.0);
    // Never over backwards, never thrown off.
    expect(bike.toppled).toBe(false);
  });

  it('letting go of the throttle in a wheelie brings the front down within 1 s', () => {
    const { sim, bike } = bikeOnRoad('sportbike');
    step(sim, 0.4, input({ throttle: 1 }));
    expect(bike.wheelie).toBeGreaterThan(8 / DEG);
    const t = stepUntil(sim, 1.5, () => bike.wheelie < 2 / DEG, () => input({ throttle: 0 }));
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(1.0);
  });

  it('the scooter stays under 2 degrees of pitch under full throttle', () => {
    const { sim, bike } = bikeOnRoad('scooter');
    let max = 0;
    for (let f = 0; f < 240; f++) {
      step(sim, 1 / 60, input({ throttle: 1 }));
      max = Math.max(max, Math.abs(bike.wheelie + bike.pitch));
    }
    console.log(`[bike] scooter max pitch under full throttle ${(max * DEG).toFixed(2)}deg`);
    expect(max).toBeLessThan(2 / DEG);
  });
});

describe('VAL-BIKE-005: a hard crash or a flip throws the rider off, the bike stays', () => {
  type Target = 'wall' | 'bus';
  /** Rides `kind` (the player, or an NPC) at `speed` into a wall or a parked bus; when it hit and when the rider came off. */
  function crash(kind: VehicleKind, target: Target, speed: number, npc: boolean, god = false) {
    const sim = makeSim();
    sim.cheats.godMode = god;
    const rp = roadPoint(sim);
    const bike = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
    const rider = npc ? sim.addDriver(bike, 'civilian', 'traffic') : sim.player;
    if (npc) bike.ai = null;
    else placeInCar(sim, bike);
    const gap = speed < 6 ? 1.5 : 6;
    if (target === 'wall') wallAhead(sim, bike, gap + bike.halfL);
    else sim.spawnVehicle('bus', bike.pos.x + Math.sin(bike.heading) * (gap + bike.halfL + 1.3), bike.pos.z + Math.cos(bike.heading) * (gap + bike.halfL + 1.3), bike.heading + Math.PI / 2);
    bike.vel.x = Math.sin(bike.heading) * speed;
    bike.vel.z = Math.cos(bike.heading) * speed;
    const hp = rider.health;
    let hit = -1;
    let off = -1;
    let impact = 0;
    for (let f = 0; f < 150; f++) {
      const vx = bike.vel.x;
      const vz = bike.vel.z;
      // Holding its speed up to the impact (the NPC's controls are set directly).
      const c = bike.controls;
      c.throttle = hit < 0 && speed >= 6 ? 0.25 : 0;
      c.brake = 0;
      c.steer = 0;
      c.handbrake = false;
      step(sim, 1 / 60, input({ throttle: c.throttle }));
      const dv = Math.hypot(bike.vel.x - vx, bike.vel.z - vz);
      if (hit < 0 && dv > 2) {
        hit = f / 60;
        impact = Math.hypot(vx, vz);
      }
      if (off < 0 && rider.vehicle !== bike) off = f / 60;
    }
    return { sim, bike, rider, hit, off, impact, loss: hp - rider.health };
  }

  for (const kind of ['sportbike', 'scooter'] as const) {
    for (const target of ['wall', 'bus'] as const) {
      for (const npc of [false, true]) {
        it(`${kind} into a ${target} at 20 m/s throws ${npc ? 'an NPC rider' : 'the player'} off within 0.2 s; the bike stays and can be ridden again`, () => {
          const r = crash(kind, target, 20, npc);
          console.log(`[bike] crash ${kind} ${target} ${npc ? 'npc' : 'player'}: impact ${r.impact.toFixed(1)} m/s, ejected ${r.off >= 0 ? `${((r.off - r.hit) * 1000).toFixed(0)} ms after it` : 'no'}, rider ${r.rider.state}, health loss ${r.loss.toFixed(0)}, bike present ${r.sim.vehicles.includes(r.bike)}`);
          expect(r.hit).toBeGreaterThanOrEqual(0);
          expect(r.impact).toBeGreaterThan(18);
          expect(r.off).toBeGreaterThanOrEqual(0);
          expect(r.off - r.hit).toBeLessThanOrEqual(0.2);
          expect(['knocked', 'dead', 'normal']).toContain(r.rider.state);
          expect(r.rider.vehicle).toBeNull();
          expect(r.loss).toBeGreaterThan(0);
          expect(r.sim.vehicles).toContain(r.bike);
          expect(r.bike.removed).toBe(false);
          expect(r.bike.toppled).toBe(true);
          if (!npc && r.rider.alive) {
            // Up again, he gets back on: F beside the bike stands it up.
            stepUntil(r.sim, 6, () => r.rider.state === 'normal');
            const p = r.rider;
            p.pos.x = r.bike.pos.x + Math.cos(r.bike.heading) * 1.4;
            p.pos.z = r.bike.pos.z - Math.sin(r.bike.heading) * 1.4;
            step(r.sim, 1 / 60, input({ enterExit: true }));
            expect(stepUntil(r.sim, 3, () => p.vehicle === r.bike)).toBeGreaterThanOrEqual(0);
            expect(r.bike.toppled).toBe(false);
            // Backing away from what it hit.
            step(r.sim, 1.5, input({ brake: 1 }));
            expect(r.bike.forwardSpeed).toBeLessThan(-1);
          }
        });
      }
    }
    it(`${kind}: god mode keeps the player from harm when thrown off`, () => {
      const r = crash(kind, 'wall', 20, false, true);
      expect(r.off).toBeGreaterThanOrEqual(0);
      expect(r.loss).toBe(0);
    });
    it(`${kind}: a 4 m/s nudge into a wall does not throw the rider`, () => {
      for (const npc of [false, true]) {
        const r = crash(kind, 'wall', 4, npc);
        console.log(`[bike] nudge ${kind} ${npc ? 'npc' : 'player'}: impact ${r.impact.toFixed(1)} m/s, ejected ${r.off >= 0}`);
        expect(r.hit).toBeGreaterThanOrEqual(0);
        expect(r.off).toBe(-1);
        expect(r.rider.vehicle).toBe(r.bike);
      }
    });
    it(`${kind}: landing on its side throws the rider off, the bike lies there and can be ridden again`, () => {
      for (const npc of [false, true]) {
        const { sim, bike } = bikeOnRoad(kind, !npc);
        const rider = npc ? sim.addDriver(bike, 'civilian', 'traffic') : sim.player;
        if (npc) bike.ai = null;
        bike.pos.y += 2;
        bike.airborne = true;
        bike.vy = -2;
        bike.roll = 1.3;
        const t = stepUntil(sim, 2, () => rider.vehicle !== bike);
        console.log(`[bike] flip ${kind} ${npc ? 'npc' : 'player'}: thrown after ${t.toFixed(2)} s, rider ${rider.state}`);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(bike.toppled).toBe(true);
        expect(bike.flipped).toBe(false);
        expect(bike.burning).toBe(false);
        expect(Math.abs(bike.lean)).toBeGreaterThan(BIKE_UPRIGHT);
        expect(sim.vehicles).toContain(bike);
        expect(bike.drivable).toBe(true);
      }
    });
  }
});

/** Ambient traffic with the player idle at a junction: spawned kinds, parked bikes, bikes stuck over 20 s. */
function ambientRun(seed: number, seconds: number) {
  const sim = makeSim({ ambient: true, police: false, seed, startHour: 12 });
  const n = sim.roads.node(4, 5);
  sim.player.pos.x = n.x + n.halfX + 2;
  sim.player.pos.z = n.z + n.halfZ + 2;
  sim.player.pos.y = sim.world.groundHeight(sim.player.pos.x, sim.player.pos.z);
  const seen = new Set<Vehicle>();
  let traffic = 0;
  let bikes = 0;
  let parkedBikes = 0;
  let stuckBikes = 0;
  const parkedSeen = new Set<Vehicle>();
  const stuck = new Set<Vehicle>();
  for (let f = 0; f < seconds * 60; f++) {
    sim.update(1 / 60, input({ aimOrigin: { x: sim.player.pos.x, y: 3, z: sim.player.pos.z - 6 }, aimDir: { x: 0, y: -0.1, z: 1 } }));
    if (f % 30 !== 0) continue;
    for (const v of sim.vehicles) {
      if (v.removed) continue;
      if (v.owner === 'traffic' && !seen.has(v)) {
        seen.add(v);
        traffic++;
        if (v.spec.class === 'bike') bikes++;
      }
      if (v.owner === 'parked' && v.spec.class === 'bike' && !parkedSeen.has(v)) {
        parkedSeen.add(v);
        parkedBikes++;
      }
      if (v.owner === 'traffic' && v.spec.class === 'bike' && v.driver && v.stuckTime > 20 && !stuck.has(v)) {
        stuck.add(v);
        stuckBikes++;
      }
    }
  }
  return { traffic, bikes, parkedBikes, stuckBikes, boats: [...seen].filter((v) => v.spec.class === 'boat').length };
}

describe('VAL-BIKE-006: ambient traffic includes some bikes, and they drive normally', () => {
  it('the mixes hold bikes and no boats', () => {
    const total = TRAFFIC_MIX.reduce((a, [, w]) => a + w, 0);
    const compacts = TRAFFIC_MIX.find(([k]) => k === 'compact')![1] / total;
    const share = (compacts * TRAFFIC_BIKES.reduce((a, [, w]) => a + w, 0)) / 1000;
    for (const [k] of TRAFFIC_BIKES) expect(VEHICLE_SPECS[k].class).toBe('bike');
    expect(share).toBeGreaterThanOrEqual(0.01);
    expect(share).toBeLessThanOrEqual(0.15);
    // The substitution is a pure function of the spawn point: no draw from the sim's random stream.
    let n = 0;
    for (let i = 0; i < 4000; i++) if (VEHICLE_SPECS[trafficBike('compact', i * 3.7, -i * 1.3)].class === 'bike') n++;
    expect(n / 4000).toBeCloseTo(0.25, 1);
    expect(trafficBike('sedan', 1, 2)).toBe('sedan');
    const parked = Array.from({ length: 400 }, (_, i) => parkedBike('compact', i));
    expect(parked.filter((k) => VEHICLE_SPECS[k].class === 'bike').length / 400).toBeCloseTo(1 / PARKED_BIKE_EVERY, 1);
    expect(new Set(parked)).toEqual(new Set(['compact', 'sportbike', 'scooter']));
    expect(parkedBike('sedan', 3)).toBe('sedan');
    for (const [k] of [...TRAFFIC_MIX, ...PARKED_MIX]) expect(VEHICLE_SPECS[k].class).not.toBe('boat');
  });

  it('seeds 1-2 x 150 s: bikes are 1-15% of spawned traffic, parked bikes appear, and no bike is stuck over 20 s', () => {
    const rows = [1, 2].map((seed) => ({ seed, ...ambientRun(seed, 150) }));
    console.log(`[bike] ambient: ${rows.map((r) => `seed ${r.seed}: ${r.bikes}/${r.traffic} bikes (${((r.bikes / r.traffic) * 100).toFixed(1)}%), parked bikes ${r.parkedBikes}, stuck bikes ${r.stuckBikes}`).join('; ')}`);
    const traffic = rows.reduce((a, r) => a + r.traffic, 0);
    const bikes = rows.reduce((a, r) => a + r.bikes, 0);
    expect(bikes / traffic).toBeGreaterThanOrEqual(0.01);
    expect(bikes / traffic).toBeLessThanOrEqual(0.15);
    expect(rows.reduce((a, r) => a + r.parkedBikes, 0)).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.stuckBikes).toBe(0);
      expect(r.boats).toBe(0);
    }
  }, 120_000);
});

describe('VAL-BIKE-007: police chase a player on a bike', () => {
  /**
   * The flee bot of the pursuit measurement on a sport bike at 3 stars (kept up, so the run measures pursuit, not search)
   * for `seconds`: the share of 0.5 s samples with a police unit or an officer within 60 m. Over the same runs a sports
   * car has one within 60 m in 37.5% of the samples (seeds 1-5: 21, 19, 46, 11, 90%). Each run is chaotic (a change
   * anywhere reshuffles it: seeds 1-5 range 11-88%), so the test pools eight runs.
   */
  function bikeFlee(seed: number, seconds: number): { near: number; units: number } {
    const sim = makeSim({ ambient: true, seed });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const lane = startLane(sim, seed);
    const p = at(lane, 10);
    const bike = sim.spawnVehicle('sportbike', p.x, p.z, lane.heading);
    placeInCar(sim, bike);
    bike.vel.x = lane.dx * 15;
    bike.vel.z = lane.dz * 15;
    const bot = fleeBot(sim, bike);
    sim.wanted.setLevel(3);
    let samples = 0;
    let near = 0;
    let units = 0;
    for (let i = 0; i < seconds * 60; i++) {
      if (i % 30 === 0) {
        samples++;
        const pp = sim.playerPos();
        const law = [...liveUnits(sim).map((v) => v.pos), ...sim.characters.filter((c) => !c.removed && c.isLaw && c.alive).map((c) => c.pos)];
        if (law.some((q) => dist(q, pp) < 60)) near++;
        units = Math.max(units, liveUnits(sim).length);
      }
      if (sim.wanted.level < 3) sim.wanted.setLevel(3);
      // Thrown off in a crash: back on the bike, as a player would.
      if (!sim.player.vehicle && sim.player.state === 'normal') {
        sim.seat(sim.player, bike, 0);
        bike.toppled = false;
      }
      step(sim, 1 / 60, bot());
    }
    return { near: near / samples, units };
  }

  it('seeds 1-8 x 120 s at 3 stars: police units come after him and are within 60 m in at least 30% of the samples', () => {
    const runs = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => ({ seed, ...bikeFlee(seed, 120) }));
    console.log(`[bike] chase: ${runs.map((r) => `seed ${r.seed}: within 60 m ${(r.near * 100).toFixed(0)}%, up to ${r.units} units`).join('; ')}`);
    const share = runs.reduce((a, r) => a + r.near, 0) / runs.length;
    expect(share).toBeGreaterThanOrEqual(0.3);
    for (const r of runs) expect(r.units).toBeGreaterThan(0);
  }, 300_000);

  it('a player stopped on a bike at 2 stars with an officer beside him is BUSTED', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    const lane = longestLane(sim);
    const bike = sim.spawnVehicle('sportbike', at(lane, 60).x, at(lane, 60).z, lane.heading);
    placeInCar(sim, bike);
    sim.wanted.setLevel(2);
    officer(sim, bike.pos.x + Math.cos(bike.heading) * (bike.halfW + 0.8), bike.pos.z - Math.sin(bike.heading) * (bike.halfW + 0.8));
    const t = stepUntil(sim, 5, () => sim.deathKind === 'busted', () => input({ handbrake: true }));
    console.log(`[bike] bust on a stopped bike after ${t.toFixed(2)} s`);
    expect(t).toBeGreaterThan(0);
  });
});
