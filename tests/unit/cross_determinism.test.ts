// The simulation is a pure function of its seed and inputs, also with dynamic weather and the newer behaviours (the
// Street Run green wave, police unjamming round a stopped car, detours and towing round a car left in a junction,
// point-blank and downed-body shots) and the wave-1 features: gangs, gang cars and war, roadblocks, spike strips and
// fire; motorbikes and boats; thrown grenades and molotovs; witnesses phoning crimes in and angry drivers; the
// ambulance, firefighter, courier and car export activities; and a business's takings over a game day. Each scripted
// run is made twice with one seed (identical events and final state) and once with another (not identical).
// Core, world and sim also stay free of three.js and the browser.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AmbulanceJob, CourierJob, FireJob, StreetRunJob } from '../../src/sim/activities';
import { EXPORT_LIST, exportDone } from '../../src/sim/activities/carExport';
import { places } from '../../src/sim/activities/places';
import { activityRecords } from '../../src/sim/activities/records';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import { FIRE_PATCH_R } from '../../src/sim/fire';
import { BUSINESS_DAILY, propertyState } from '../../src/sim/properties';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { scheduledWeather } from '../../src/sim/weather';
import { WATER_Y } from '../../src/world/constants';
import { coursePath, KeyboardBot, type BotKeys } from '../e2e/keyboardBot';
import { turfBorders } from '../../src/sim/gangs';
import { aimAt, input, makeSim, placeInCar, roadPoint, teleport } from './helpers';
import { getaway } from './r2_police_helpers';

const DT = 1 / 60;

interface Run {
  sim: Sim;
  events: string[];
  heldSeen: number;
  crewsOnFoot: number;
  /** The most police cars about at once during the 5-star chase. */
  policeCars: number;
  abandoned: Vehicle | null;
  /** First driver to hold the abandoned car as the vehicle it detours round, and when (sim time). */
  detour: { at: number; frame: number; driver: number } | null;
  /** When the abandoned car was first holding up a driver, and when it was towed. */
  firstHeldAt: number | null;
  tow: { at: number; frame: number; vehicle: number; heldFor: number; playerDist: number } | null;
  gates: number;
  frames: number;
}

/** Entity references in event payloads become ids; numbers are kept exact. */
function serialise(type: string, payload: unknown): string {
  return `${type} ${JSON.stringify(payload, function (this: unknown, key, value: unknown) {
    if (key !== '' && value && typeof value === 'object' && 'id' in value && 'pos' in value) return `${'spec' in value ? 'V' : 'C'}${(value as { id: number }).id}`;
    return value;
  })}`;
}

function look(sim: Sim, inp: PlayerInput, yaw = 0): PlayerInput {
  if (inp.aimOrigin.x === 0 && inp.aimOrigin.y === 0 && inp.aimOrigin.z === 0) {
    const p = sim.playerPos();
    inp.aimOrigin = { x: p.x - Math.sin(yaw) * 6, y: p.y + 3, z: p.z - Math.cos(yaw) * 6 };
    inp.aimDir = { x: Math.sin(yaw), y: -0.1, z: Math.cos(yaw) };
    inp.cameraYaw = yaw;
  }
  return inp;
}

const HOUR = 21.5;

/** The first day after day 1 (always clear) on which the seed's schedule rains through the script's two hours. */
function rainyDay(seed: number): number {
  for (let day = 2; day < 200; day++) if ([0, 0.5, 1, 1.5, 2].every((h) => scheduledWeather(seed, day, HOUR + h).rain > 0.3)) return day;
  throw new Error('no rainy evening');
}

function scripted(seed: number): Run {
  const sim = makeSim({ ambient: true, police: true, seed, weather: 'dynamic', startHour: HOUR });
  sim.clock.day = rainyDay(seed);
  // The chase is about the police finding a way to the car, not about the player dying in it.
  sim.cheats.godMode = true;
  const run: Run = { sim, events: [], heldSeen: 0, crewsOnFoot: 0, policeCars: 0, abandoned: null, detour: null, firstHeldAt: null, tow: null, gates: 0, frames: 0 };
  const emit = sim.events.emit.bind(sim.events);
  sim.events.emit = ((type: string, payload: unknown) => {
    run.events.push(`${run.frames} ${serialise(type, payload)}`);
    (emit as (t: string, p: unknown) => void)(type, payload);
  }) as typeof sim.events.emit;
  sim.events.on('streetRunCheckpoint', () => run.gates++);
  const tick = (inp: PlayerInput, yaw?: number) => {
    sim.update(DT, look(sim, inp, yaw));
    run.frames++;
  };

  // A Street Run with the keyboard bot, the green wave holding the junctions ahead.
  const course = sim.activities.streetRunCourses().find((c) => c.id === 'magnolia')!;
  const car = sim.spawnVehicle('sports', course.start.x, course.start.z, course.start.heading);
  placeInCar(sim, car);
  expect(sim.activities.startStreetRun('magnolia')).toBe(true);
  const bot = new KeyboardBot(coursePath(sim.roads, course));
  let keys: BotKeys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false };
  for (let f = 0; f < 60 * 28; f++) {
    const job = sim.activities.job as StreetRunJob | null;
    if (job?.stage === 'racing' && f % 3 === 0) {
      const obstacles = sim.vehicles.filter((v) => v !== car && !v.removed).map((v) => ({ x: v.pos.x, z: v.pos.z, heading: v.heading, halfL: v.halfL, halfW: v.halfW, vx: v.vel.x, vz: v.vel.z }));
      keys = bot.decide({ x: car.pos.x, z: car.pos.z, heading: car.heading, speed: car.forwardSpeed, wheel: car.steer, halfL: car.halfL, halfW: car.halfW, length: car.spec.length, steer: car.spec.steer }, obstacles);
    }
    run.heldSeen = Math.max(run.heldSeen, sim.roads.heldSignals.size);
    const steer = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    tick(input({ throttle: keys.KeyW ? 1 : 0, brake: keys.KeyS ? 1 : 0, steer, steerDigital: steer !== 0, handbrake: keys.Space }));
  }
  if (sim.activities.job) sim.activities.toggleJob();

  // A 5-star chase: a short getaway, then the player sits stopped in the car while units arrive and jam.
  sim.wanted.setLevel(5);
  for (let f = 0; f < 60 * 12; f++) tick(input({ throttle: 1, steer: Math.sin(f / 90) * 0.4 }));
  for (let f = 0; f < 60 * 20; f++) {
    tick(input({ brake: 1, handbrake: true }));
    const onFoot = sim.characters.filter((c) => !c.removed && !c.vehicle && (c.role === 'cop' || c.role === 'swat')).length;
    run.crewsOnFoot = Math.max(run.crewsOnFoot, onFoot);
    run.policeCars = Math.max(run.policeCars, sim.vehicles.filter((v) => !v.removed && v.spec.police).length);
  }

  // A car abandoned across the end of a lane into a junction, so that every turn off the lane passes it, with a
  // driver coming up behind it. Held up for over 2 s, the driver takes it as the vehicle to detour round (and backs
  // off); as no detour gets past it, it keeps holding traffic up and is towed once that has gone on for 30 s, the
  // player well away from it and looking the other way.
  sim.wanted.setLevel(0);
  const n = sim.roads.node(5, 5);
  const lane = sim.roads.lanes.find((l) => l.to === n.id && l.length > 45 && l.turns.length >= 2 && l.turns.some((t) => t.kind === 'straight'))!;
  const e = lane.length + 2;
  const left = sim.spawnVehicle('sedan', lane.sx + lane.dx * e, lane.sz + lane.dz * e, lane.heading + Math.PI / 2);
  run.abandoned = left;
  const s0 = lane.length - 30;
  const behind = sim.spawnVehicle('sedan', lane.sx + lane.dx * s0, lane.sz + lane.dz * s0, lane.heading);
  sim.addDriver(behind, 'civilian', 'traffic');
  behind.ai!.setLane(lane, s0);
  const s1 = lane.length - 80;
  teleport(sim, lane.sx + lane.dx * s1, lane.sz + lane.dz * s1);
  const away = Math.atan2(-lane.dx, -lane.dz);
  let removedSeen = false;
  for (let f = 0; f < 60 * 70 && !removedSeen; f++) {
    tick(input({ handbrake: true }), away);
    // Out of view all along, so the tow is the rule that takes it, not one waiting for the player to look away.
    if (!left.removed) expect(sim.isVisible(left.pos.x, left.pos.y, left.pos.z)).toBe(false);
    for (const v of sim.vehicles) {
      if (v.removed || !v.ai) continue;
      if (!run.detour && (v.ai as unknown as { avoid: Vehicle | null }).avoid === left) run.detour = { at: sim.time, frame: run.frames, driver: v.id };
      if (run.firstHeldAt === null && v.ai.heldUpBy === left) run.firstHeldAt = sim.time;
    }
    if (left.removed) {
      removedSeen = true;
      const pp = sim.playerPos();
      run.tow = { at: sim.time, frame: run.frames, vehicle: left.id, heldFor: sim.time - (run.firstHeldAt ?? sim.time), playerDist: Math.hypot(left.pos.x - pp.x, left.pos.z - pp.z) };
    }
  }
  // A few seconds of traffic flowing on after the tow.
  for (let f = 0; f < 60 * 3; f++) tick(input({ handbrake: true }), away);
  teleport(sim, n.x + n.halfX + 30, n.z + n.halfZ + 30);

  // Point-blank shots on foot, then shots into the body lying on the ground.
  sim.unseat(sim.player);
  sim.player.state = 'normal';
  sim.player.inventory.give('pistol', 200);
  sim.player.inventory.current = 'pistol';
  const p = sim.player.pos;
  const h = sim.player.heading;
  const victim: Character = sim.spawnCharacter('civilian', p.x + Math.sin(h) * 1.1, p.z + Math.cos(h) * 1.1);
  for (let f = 0; f < 60 * 2; f++) tick(aimAt(sim, { x: victim.pos.x, y: victim.pos.y + 1.2, z: victim.pos.z }, { aim: true, fire: f % 20 === 0, firePressed: f % 20 === 0 }));
  for (let f = 0; f < 60 * 2; f++) tick(aimAt(sim, { x: victim.pos.x, y: victim.pos.y + 0.2, z: victim.pos.z }, { aim: true, fire: f % 20 === 0, firePressed: f % 20 === 0 }));
  return run;
}

function snapshot(run: Run) {
  const sim = run.sim;
  const v3 = (v: { x: number; y?: number; z: number }) => [v.x, v.y, v.z];
  return {
    frames: run.frames,
    player: { pos: v3(sim.player.pos), heading: sim.player.heading, health: sim.player.health, state: sim.player.state },
    vehicles: sim.vehicles.map((v: Vehicle) => ({ id: v.id, kind: v.kind, removed: v.removed, pos: v3(v.pos), vel: v3(v.vel), heading: v.heading, health: v.health })),
    characters: sim.characters.map((c: Character) => ({ id: c.id, role: c.role, removed: c.removed, pos: v3(c.pos), state: c.state, health: c.health })),
    wanted: sim.wanted.level,
    weather: JSON.parse(JSON.stringify(sim.weather.state)) as unknown,
    clock: [sim.clock.day, sim.clock.hours],
    held: [...sim.roads.heldSignals.entries()],
    events: run.events,
  };
}

describe('same-seed determinism of the newer behaviour', () => {
  it('two sims with one seed and dynamic weather match after the same scripted inputs', () => {
    const a = scripted(23);
    const b = scripted(23);
    // The script did exercise the behaviour it is meant to cover.
    expect(a.heldSeen).toBeGreaterThan(0);
    expect(a.gates).toBeGreaterThan(0);
    expect(a.events.some((e) => / wanted /.test(e) && /"level":5/.test(e))).toBe(true);
    expect(a.policeCars).toBeGreaterThan(0);
    expect(a.events.some((e) => / damage /.test(e))).toBe(true);
    expect(a.crewsOnFoot).toBeGreaterThan(0);
    for (const [name, r] of [['a', a], ['b', b]] as const) {
      console.log(`[determinism] run ${name}: abandoned V${r.abandoned?.id}, detour ${JSON.stringify(r.detour)}, first held up at ${r.firstHeldAt}, tow ${JSON.stringify(r.tow)}`);
      // A driver took the abandoned car as the one to detour round, and it was towed after holding traffic up 30 s.
      expect(r.detour, name).not.toBeNull();
      expect(r.firstHeldAt, name).not.toBeNull();
      expect(r.tow, name).not.toBeNull();
      expect(r.abandoned!.removed, name).toBe(true);
      expect(r.tow!.at, name).toBeGreaterThan(r.detour!.at);
      expect(r.tow!.heldFor, name).toBeGreaterThanOrEqual(30);
      expect(r.tow!.playerDist, name).toBeLessThan(200);
    }
    expect(b.detour).toEqual(a.detour);
    expect(b.tow).toEqual(a.tow);
    console.log(`[determinism] gates ${a.gates}, held junctions ${a.heldSeen}, crews on foot ${a.crewsOnFoot}, ${a.events.length} events over ${a.frames} frames`);
    const killedAt = a.events.findIndex((e) => / characterKilled /.test(e));
    expect(killedAt).toBeGreaterThan(0);
    // Shots into the body on the ground land on it.
    expect(a.events.slice(killedAt).some((e) => / shot /.test(e) && /"shooter":"C1"/.test(e) && /"hit":"flesh"/.test(e))).toBe(true);
    expect(a.sim.weather.state.rain).toBeGreaterThan(0.3);
    const sa = snapshot(a);
    const sb = snapshot(b);
    expect(sa.events.length).toBe(sb.events.length);
    expect(sa).toEqual(sb);
  }, 120_000);
});

describe('same-seed determinism of the wave-1 street systems', () => {
  // Both gangs, their cars and a war at the border, a 4-star chase into roadblocks and spike strips, and a molotov fire.
  function streetRun(seed: number) {
    const sim = makeSim({ ambient: true, police: true, seed, streetCrime: true });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const events: string[] = [];
    for (const type of ['gangWar', 'roadblock', 'tyreBurst', 'fireStarted', 'damage', 'characterKilled'] as const) {
      sim.events.on(type, (e) => events.push(serialise(type, e)));
    }
    const b = turfBorders(sim.world.layout)[0]!;
    teleport(sim, (b.ax + b.bx) / 2 + 24, (b.az + b.bz) / 2);
    for (let f = 0; f < 120; f++) sim.update(1 / 60, input({}));
    sim.gangs.startWar(b, true);
    sim.combat.fire.ignite(sim.player.pos.x + 6, sim.player.pos.y, sim.player.pos.z, sim.player);
    for (let f = 0; f < 60 * 20; f++) sim.update(1 / 60, input({}));
    const { bot } = getaway(sim, seed);
    sim.wanted.setLevel(4);
    for (let f = 0; f < 60 * 50; f++) {
      if (sim.wanted.level < 4) sim.wanted.setLevel(4);
      sim.update(1 / 60, bot(1 / 60));
    }
    return { sim, events };
  }

  it('two runs with one seed match: gangs, gang cars, a war, roadblocks, strips and fire', () => {
    const a = streetRun(13);
    const b = streetRun(13);
    expect(a.events.some((e) => e.startsWith('gangWar '))).toBe(true);
    expect(a.events.some((e) => e.startsWith('roadblock '))).toBe(true);
    expect(a.events.some((e) => e.startsWith('tyreBurst '))).toBe(true);
    expect(a.events.some((e) => e.startsWith('fireStarted '))).toBe(true);
    expect(a.sim.gangs.cars.length + a.sim.gangs.wars.length).toBeGreaterThan(0);
    const snap = (s: Sim) => ({ v: s.vehicles.map((v) => [v.id, v.kind, v.removed, v.pos.x, v.pos.z, v.health, ...v.flat]), c: s.characters.map((c) => [c.id, c.role, c.gang, c.removed, c.pos.x, c.pos.z, c.health]), w: s.wanted.level });
    expect(b.events).toEqual(a.events);
    expect(snap(b.sim)).toEqual(snap(a.sim));
  }, 120_000);
});

/** Every event the sim emits, with the frame it came on. */
function tape(sim: Sim): string[] {
  const events: string[] = [];
  const emit = sim.events.emit.bind(sim.events);
  sim.events.emit = ((type: string, payload: unknown) => {
    events.push(`${sim.frame} ${serialise(type, payload)}`);
    (emit as (t: string, p: unknown) => void)(type, payload);
  }) as typeof sim.events.emit;
  return events;
}

/** Everything a run leaves behind that the seed could change. */
function finalState(sim: Sim, events: string[], extra: unknown = null) {
  const v3 = (v: { x: number; y?: number; z: number }) => [v.x, v.y, v.z];
  return {
    frame: sim.frame,
    time: sim.time,
    clock: [sim.clock.day, sim.clock.hours],
    money: sim.progress.money,
    wanted: sim.wanted.level,
    player: { pos: v3(sim.player.pos), heading: sim.player.heading, health: sim.player.health, state: sim.player.state },
    vehicles: sim.vehicles.map((v) => ({ id: v.id, kind: v.kind, removed: v.removed, pos: v3(v.pos), vel: v3(v.vel), heading: v.heading, health: v.health, lean: v.lean, wheelie: v.wheelie, burning: v.burning })),
    characters: sim.characters.map((c) => ({ id: c.id, role: c.role, removed: c.removed, pos: v3(c.pos), state: c.state, health: c.health, burn: c.burnTimer })),
    weather: JSON.parse(JSON.stringify(sim.weather.state)) as unknown,
    fires: sim.combat.fire.areas.map((a) => ({ x: a.x, z: a.z, radius: a.radius, patches: a.patches })),
    extra,
    events,
  };
}

/** The same scripted run twice with one seed matches exactly; with another seed it does not. */
function expectDeterministic<T extends { state: unknown }>(run: (seed: number) => T, seed: number, otherSeed: number): T {
  const a = run(seed);
  const b = run(seed);
  expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  expect(b.state).toEqual(a.state);
  expect(JSON.stringify(run(otherSeed).state)).not.toBe(JSON.stringify(a.state));
  return a;
}

/** The player on foot on a stretch of road clear for 30 m ahead and 6 m to either side, facing along it. */
function openRoad(sim: Sim) {
  for (const lane of sim.roads.lanes) {
    if (lane.length < 60) continue;
    const x = lane.sx + lane.dx * 15;
    const z = lane.sz + lane.dz * 15;
    const rx = -Math.cos(lane.heading);
    const rz = Math.sin(lane.heading);
    let open = true;
    for (let a = -6; a <= 32 && open; a += 2) for (let l = -6; l <= 6 && open; l++) open = sim.world.isFree(x + lane.dx * a + rx * l, z + lane.dz * a + rz * l, 0.5) && sim.world.waterDepth(x + lane.dx * a, z + lane.dz * a) < -0.5;
    if (!open) continue;
    teleport(sim, x, z);
    sim.player.heading = lane.heading;
    return { x, z, h: lane.heading, fx: Math.sin(lane.heading), fz: Math.cos(lane.heading), rx, rz };
  }
  throw new Error('no open road');
}

describe('same-seed determinism of the wave-1 vehicles: motorbikes and boats', () => {
  function vehicleRun(seed: number) {
    const sim = makeSim({ ambient: true, police: false, seed });
    sim.cheats.godMode = true;
    const events = tape(sim);
    const rp = roadPoint(sim);
    const trips: Record<string, number> = {};
    const maxLean: Record<string, number> = {};
    const ride = (key: string, v: Vehicle, seconds: number, drive: (f: number) => PlayerInput) => {
      const x0 = v.pos.x;
      const z0 = v.pos.z;
      let lean = 0;
      for (let f = 0; f < seconds * 60; f++) {
        sim.update(DT, look(sim, drive(f)));
        lean = Math.max(lean, Math.abs(v.lean));
      }
      trips[key] = Math.hypot(v.pos.x - x0, v.pos.z - z0);
      maxLean[key] = lean;
    };
    const winding = (f: number) => input({ throttle: f % 200 < 150 ? 1 : 0, brake: f % 200 >= 170 ? 1 : 0, steer: Math.sin(f / 50) * 0.6 });
    for (const kind of ['sportbike', 'scooter'] as const) {
      const bike = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
      placeInCar(sim, bike);
      ride(kind, bike, 8, winding);
      sim.playerCtl.exitVehicle(false);
      sim.update(DT, look(sim, input()));
    }
    // Open water east of the beach.
    teleport(sim, 700, -300);
    let onWater = true;
    for (const kind of ['speedboat', 'dinghy'] as const) {
      const boat = sim.spawnVehicle(kind, 700, -300, 0);
      boat.pos.y = WATER_Y;
      placeInCar(sim, boat);
      ride(kind, boat, 12, (f) => input({ throttle: 1, steer: Math.sin(f / 40) }));
      onWater &&= sim.world.waterDepth(boat.pos.x, boat.pos.z) > 0 && Math.abs(boat.pos.y - WATER_Y) < 0.3;
      sim.playerCtl.exitVehicle(false);
      sim.update(DT, look(sim, input()));
      teleport(sim, 700, -300);
    }
    return { events, onWater, trips, maxLean, state: finalState(sim, events, { trips, maxLean }) };
  }

  it('two runs with one seed match: a sport bike and a scooter on the road, a speedboat and a dinghy on the sea', () => {
    const r = expectDeterministic(vehicleRun, 31, 32);
    expect(r.trips.sportbike).toBeGreaterThan(20);
    expect(r.trips.scooter).toBeGreaterThan(10);
    expect(r.maxLean.sportbike).toBeGreaterThan(0.05);
    expect(r.trips.speedboat).toBeGreaterThan(60);
    expect(r.trips.dinghy).toBeGreaterThan(30);
    expect(r.onWater).toBe(true);
  }, 120_000);
});

describe('same-seed determinism of the wave-1 weapons: grenade and molotov', () => {
  function weaponRun(seed: number) {
    const sim = makeSim({ ambient: true, police: true, seed, streetCrime: true });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const events = tape(sim);
    const f = openRoad(sim);
    for (const d of [14, 17, 21]) {
      const c = sim.spawnCharacter('civilian', f.x + f.fx * d + f.rx * ((d % 3) - 1) * 1.5, f.z + f.fz * d + f.rz * ((d % 3) - 1) * 1.5);
      c.owner = 'mission';
      c.persistent = true;
    }
    const throwAt = (id: 'grenade' | 'molotov') => {
      sim.player.inventory.give(id, 2);
      sim.player.inventory.current = id;
      // Taking a weapon out holds the throw back for a moment.
      for (let i = 0; i < 30; i++) sim.update(DT, look(sim, input()));
      sim.update(DT, look(sim, input({ fire: true, firePressed: true, aimDir: { x: f.fx * 0.95, y: 0.3, z: f.fz * 0.95 } })));
    };
    throwAt('grenade');
    for (let i = 0; i < 60 * 6; i++) sim.update(DT, look(sim, input()));
    const fireStart = events.length;
    throwAt('molotov');
    let maxRadius = 0;
    for (let i = 0; i < 60 * 14; i++) {
      sim.update(DT, look(sim, input()));
      for (const a of sim.combat.fire.areas) maxRadius = Math.max(maxRadius, a.radius);
    }
    return { events, fireStart, maxRadius, state: finalState(sim, events, { maxRadius }) };
  }

  it('two runs with one seed match: a thrown grenade blast and a thrown molotov whose fire spreads', () => {
    const r = expectDeterministic(weaponRun, 41, 42);
    const grenadeEvents = r.events.slice(0, r.fireStart);
    expect(grenadeEvents.some((e) => / thrown /.test(e) && /grenade/.test(e))).toBe(true);
    expect(grenadeEvents.some((e) => / explosion /.test(e))).toBe(true);
    expect(r.events.slice(r.fireStart).some((e) => / thrown /.test(e) && /molotov/.test(e))).toBe(true);
    expect(r.events.some((e) => / fireStarted /.test(e))).toBe(true);
    expect(r.maxRadius).toBeGreaterThan(FIRE_PATCH_R + 1);
  }, 120_000);
});

describe('same-seed determinism of the wave-1 NPCs: witnesses and angry drivers', () => {
  function witnessRun(seed: number) {
    const sim = makeSim({ ambient: false, police: true, seed, streetCrime: true });
    const events = tape(sim);
    const f = openRoad(sim);
    const bystander = (x: number, z: number) => {
      const c = sim.spawnCharacter('civilian', x, z);
      c.owner = 'ped';
      c.persistent = true;
      c.brain = sim.peds.makeGangBrain(x, z);
      c.brain.brave = false;
      c.brain.mode = 'idle';
      c.brain.modeTimer = 1e6;
      return c;
    };
    const victim = bystander(f.x + f.fx * 1.2, f.z + f.fz * 1.2);
    victim.heading = f.h + Math.PI;
    const witnesses = [0, 1].map((k) => bystander(f.x + f.rx * (8 + k * 1.5) + f.fx * 2, f.z + f.rz * (8 + k * 1.5) + f.fz * 2));
    let calledAt = -1;
    sim.events.on('wanted', (e) => {
      if (e.level > 0 && calledAt < 0) calledAt = sim.time;
    });
    sim.combat.melee(sim.player);
    const levelRightAfter = sim.wanted.level;
    let phoned = false;
    for (let i = 0; i < 60 * 14; i++) {
      sim.update(DT, look(sim, input()));
      phoned ||= witnesses.some((w) => w.phoneTimer > 0);
    }
    return { events, levelRightAfter, phoned, calledAt, calls: sim.witnesses.log.map((l) => l.state), state: finalState(sim, events, { calledAt }) };
  }

  it('two runs with one seed match: a civilian phones a punch in and the star comes seconds later', () => {
    const r = expectDeterministic(witnessRun, 51, 52);
    const a = r.state;
    expect(r.levelRightAfter).toBe(0);
    expect(r.phoned).toBe(true);
    expect(r.calledAt).toBeGreaterThanOrEqual(2);
    expect(r.calledAt).toBeLessThanOrEqual(10);
    expect(r.calls.length).toBe(1);
    expect(a.wanted).toBe(1);
  }, 120_000);

  /** A civilian car stopped on a lane and the player's sedan driven into it at 11 m/s. */
  function angryRun(seed: number) {
    const sim = makeSim({ ambient: true, police: false, seed, streetCrime: true });
    sim.cheats.godMode = true;
    const events = tape(sim);
    const lanes = sim.roads.lanes.filter((l) => l.length > 70);
    const lane = lanes[(seed * 7) % lanes.length]!;
    const tx = lane.sx + lane.dx * 50;
    const tz = lane.sz + lane.dz * 50;
    for (const v of sim.vehicles) if (!v.removed && Math.hypot(v.pos.x - tx, v.pos.z - tz) < 30) sim.removeVehicle(v);
    const target = sim.spawnVehicle('sedan', tx, tz, lane.heading);
    target.owner = 'traffic';
    const driver = sim.addDriver(target, 'civilian', 'traffic');
    driver.owner = 'traffic';
    target.ai!.setLane(lane, 50);
    target.ai!.hold = true;
    const mine = sim.spawnVehicle('sedan', lane.sx + lane.dx * 30, lane.sz + lane.dz * 30, lane.heading);
    placeInCar(sim, mine);
    mine.vel.x = lane.dx * 11;
    mine.vel.z = lane.dz * 11;
    let hit = false;
    sim.events.on('impact', (e) => {
      if (e.vehicle === target) hit = true;
    });
    for (let i = 0; i < 60 * 6 && !hit; i++) {
      target.ai!.hold = true;
      const sp = mine.vel.x * lane.dx + mine.vel.z * lane.dz;
      sim.update(DT, look(sim, input({ throttle: sp < 11 ? 1 : 0 })));
    }
    for (let i = 0; i < 60 * 8; i++) sim.update(DT, look(sim, input({ brake: 1 })));
    const g = sim.angryDrivers.log.find((l) => l.car === target.id);
    const out = driver.state !== 'inVehicle' && driver.vehicle === null;
    return { hit, out, fights: g?.fights ?? null, logged: !!g, state: finalState(sim, events, { out, fights: g?.fights ?? null }) };
  }

  /** Not every hard hit has the driver get out; this seed's does. */
  const ANGRY_SEED = 3;

  it('two runs with one seed match: a driver hit hard gets out of his car', () => {
    const r = expectDeterministic(angryRun, ANGRY_SEED, ANGRY_SEED + 1);
    expect(r.hit).toBe(true);
    expect(r.logged).toBe(true);
    expect(r.out).toBe(true);
  }, 120_000);
});

describe('same-seed determinism of the wave-1 activities', () => {
  const carAt = (sim: Sim, kind: VehicleKind, x: number, z: number, heading = 0, color?: number) => {
    const v = sim.spawnVehicle(kind, x, z, heading, color);
    placeInCar(sim, v);
    return v;
  };
  const moveCar = (sim: Sim, v: Vehicle, x: number, z: number) => {
    v.pos.x = x;
    v.pos.z = z;
    v.pos.y = sim.world.groundHeight(x, z);
    v.vel.x = 0;
    v.vel.z = 0;
    v.angVel = 0;
  };
  const run = (sim: Sim, seconds: number, inp: PlayerInput = input()) => {
    for (let f = 0; f < Math.round(seconds / DT); f++) sim.update(DT, look(sim, { ...inp }));
  };

  function activityRun(kind: 'ambulance' | 'firefighter' | 'courier' | 'carExport', seed: number) {
    const sim = makeSim({ ambient: true, police: true, seed });
    sim.cheats.godMode = true;
    const events = tape(sim);
    const p = places(sim.world);
    const money = sim.progress.money;
    const stages: string[] = [];
    if (kind === 'ambulance') {
      const d = p.depots.find((q) => q.kind === 'ambulance')!;
      const car = carAt(sim, 'ambulance', d.x, d.z, d.heading);
      sim.activities.toggleJob();
      const j = sim.activities.job as AmbulanceJob;
      stages.push(j.kind);
      while (j.waiting.length > 0) {
        const c = j.waiting[0]!;
        moveCar(sim, car, c.pos.x + 3.2, c.pos.z);
        run(sim, 1.3);
      }
      stages.push(`aboard ${j.aboard.length}`);
      moveCar(sim, car, p.hospitalDrop.x, p.hospitalDrop.z);
      run(sim, 3);
      stages.push(`level ${j.level}`);
    } else if (kind === 'firefighter') {
      const d = p.depots.find((q) => q.kind === 'firetruck')!;
      const truck = carAt(sim, 'firetruck', d.x, d.z, d.heading);
      sim.activities.toggleJob();
      const j = sim.activities.job as FireJob;
      stages.push(j.kind);
      for (const f of [...j.fires]) {
        moveCar(sim, truck, f.x + 12, f.z);
        for (let t = 0; f.strength > 0 && t < 8 * 60; t++) {
          const dx = f.x - truck.pos.x;
          const dz = f.z - truck.pos.z;
          const l = Math.hypot(dx, dz) || 1;
          sim.update(DT, input({ fire: true, aimDir: { x: dx / l, y: -0.05, z: dz / l }, aimOrigin: { x: truck.pos.x - (dx / l) * 6, y: truck.pos.y + 4, z: truck.pos.z - (dz / l) * 6 } }));
        }
      }
      run(sim, 3);
      stages.push(`level ${j.level}`);
    } else if (kind === 'courier') {
      const o = p.courier;
      const car = carAt(sim, 'sedan', o.x, o.z, o.heading);
      sim.activities.toggleJob();
      const j = sim.activities.job as CourierJob;
      stages.push(j.kind);
      const drops = [...j.drops];
      for (const d of drops) {
        run(sim, 2, input({ throttle: 0.6 }));
        moveCar(sim, car, d.x, d.z);
        run(sim, 0.5);
      }
      stages.push(`index ${j.index}`);
    } else {
      sim.player.pos.x = p.exportBoard.x;
      sim.player.pos.z = p.exportBoard.z;
      sim.interactions.interact();
      stages.push(sim.activities.job?.kind ?? 'none');
      const first = EXPORT_LIST[0]!;
      const crane = p.crane;
      carAt(sim, first.kind, (crane.minX + crane.maxX) / 2, (crane.minZ + crane.maxZ) / 2, 0, first.color ?? VEHICLE_SPECS[first.kind].colors[0]);
      run(sim, 1);
      stages.push(`shipped ${[...exportDone(sim.progress)].join(',')}`);
    }
    return { stages, paid: sim.progress.money - money, records: JSON.stringify(activityRecords(sim.progress)), events, state: finalState(sim, events, { stages, records: activityRecords(sim.progress) }) };
  }

  it.each([
    ['ambulance', 61, 62],
    ['firefighter', 63, 64],
    ['courier', 65, 66],
    ['carExport', 67, 68],
  ] as const)('%s: two runs with one seed match, with a payout, and another seed differs', (kind, seed, other) => {
    const a = expectDeterministic((s) => activityRun(kind, s), seed, other);
    expect(a.stages[0]).toBe(kind);
    expect(a.paid).toBeGreaterThan(0);
    expect(a.events.some((e) => / activityMilestone /.test(e))).toBe(true);
    if (kind === 'ambulance') expect(a.stages).toContain('level 2');
    if (kind === 'firefighter') expect(a.stages).toContain('level 2');
    if (kind === 'courier') expect(a.records).toContain('"courierRuns":1');
    if (kind === 'carExport') expect(a.stages.at(-1)).toBe(`shipped ${EXPORT_LIST[0]!.id}`);
  }, 120_000);
});

describe('same-seed determinism of the wave-1 economy: a business over a game day', () => {
  function businessRun(seed: number) {
    const sim = makeSim({ ambient: false, police: false, seed, startHour: 10, weather: 'dynamic' });
    sim.cheats.godMode = true;
    const events = tape(sim);
    sim.progress.money = 30000;
    const m = sim.interactions.markers.find((k) => k.kind === 'business')!;
    teleport(sim, m.x, m.z);
    sim.update(DT, input({ interact: true }));
    const bought = propertyState(sim.progress).business;
    const home = sim.interactions.markers.find((k) => k.kind === 'save')!;
    // A little over one game day (1 game hour is 60 s) in steps of the sim's largest frame.
    teleport(sim, home.x + 8, home.z + 8);
    for (let f = 0; f < 14500; f++) sim.update(0.1, input());
    const takings = propertyState(sim.progress).uncollected;
    const money = sim.progress.money;
    teleport(sim, home.x, home.z);
    sim.update(DT, input());
    const collected = sim.progress.money - money;
    return { bought, takings, collected, state: finalState(sim, events, { takings, collected }) };
  }

  it('two runs with one seed match: the takings after a game day are the same and are collected at the safehouse', () => {
    const r = expectDeterministic(businessRun, 71, 72);
    const a = r.state;
    expect(r.bought).toBe(true);
    expect(r.takings).toBe(BUSINESS_DAILY);
    expect(r.collected).toBe(BUSINESS_DAILY);
    expect(a.events.some((e) => / activityMilestone /.test(e) && /"kind":"business"/.test(e))).toBe(true);
  }, 120_000);
});

/** Source files under a directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.ts$/.test(f) ? [p] : [];
  });
}

/** Source with comments and string/template contents blanked, so only code is searched. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => (m.startsWith('/') ? '' : m[0]! + m[0]!));
}

describe('layering: core, world and sim stay free of three.js and the browser', () => {
  const root = join(__dirname, '../../src');
  const files = ['core', 'world', 'sim'].flatMap((d) => sources(join(root, d)));

  it('finds the layer sources', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('nothing imports three or three/addons', () => {
    const bad = files.filter((f) => /(?:from|import|require\()\s*['"]three(?:\/[^'"]*)?['"]/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });

  it('no code references document, window or localStorage', () => {
    const bad = files.flatMap((f) => {
      const code = codeOnly(readFileSync(f, 'utf8'));
      return [...code.matchAll(/(?<![\w$.])(document|window|localStorage)\b/g)].map((m) => `${f}: ${m[1]}`);
    });
    expect(bad).toEqual([]);
  });

  it('the check catches a reference in code but not in a comment', () => {
    expect(/(?<![\w$.])window\b/.test(codeOnly('// window\nconst a = 1;'))).toBe(false);
    expect(/(?<![\w$.])window\b/.test(codeOnly('const w = window.innerWidth;'))).toBe(true);
  });
});
