// The simulation is a pure function of its seed and inputs, also with dynamic weather and the newer behaviours (the
// Street Run green wave, police unjamming round a stopped car, detours and towing round a car left in a junction,
// point-blank and downed-body shots); and core, world and sim stay free of three.js and the browser.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StreetRunJob } from '../../src/sim/activities';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import { scheduledWeather } from '../../src/sim/weather';
import { coursePath, KeyboardBot, type BotKeys } from '../e2e/keyboardBot';
import { aimAt, input, makeSim, placeInCar, teleport } from './helpers';

const DT = 1 / 60;

interface Run {
  sim: Sim;
  events: string[];
  heldSeen: number;
  crewsOnFoot: number;
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
  const run: Run = { sim, events: [], heldSeen: 0, crewsOnFoot: 0, abandoned: null, detour: null, firstHeldAt: null, tow: null, gates: 0, frames: 0 };
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
    expect(a.sim.vehicles.some((v) => v.spec.police)).toBe(true);
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
