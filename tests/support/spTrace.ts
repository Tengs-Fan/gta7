// Records a single-player trace of the simulation: two seeds, 3600 frames each at dt = 1/60, with ambient traffic,
// police and dynamic weather, and scripted inputs that walk, enter and drive a car, shoot, get 3 stars, run a Street Run
// and die (seed 1) or get busted (seed 2). Every 60 frames it samples the state and the events since the last sample.
//
// It touches only the Sim API that exists at 72d0b98, so the same file records the pre-refactor baseline in a scratch
// worktree (scripts/record-sp-trace.ts) and replays the script on the current tree (tests/unit/sp_trace.test.ts).

import type { PlayerInput } from '../../src/sim/input';
import { neutralInput } from '../../src/sim/input';
import { Sim } from '../../src/sim/sim';
import { StaticWorld } from '../../src/world/staticWorld';

const DT = 1 / 60;
export const TRACE_FRAMES = 3600;
export const TRACE_SEEDS = [11, 29] as const;
export const TRACE_END = ['wasted', 'busted'] as const;

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Entity references in event payloads become ids, numbers are rounded, and a playerId of undefined or 0 is dropped. */
function serialise(type: string, payload: unknown): [string, unknown] {
  const text = JSON.stringify(payload, function (this: unknown, key, value: unknown) {
    if (key === 'playerId' && (value === undefined || value === 0)) return undefined;
    if (key !== '' && value && typeof value === 'object' && 'id' in value && 'pos' in value) return `${'spec' in value ? 'V' : 'C'}${(value as { id: number }).id}`;
    if (typeof value === 'number') return r6(value);
    return value;
  });
  return [type, text === undefined ? null : (JSON.parse(text) as unknown)];
}

export interface TraceFrame {
  frame: number;
  player: { pos: number[]; heading: number; health: number; state: string; vehicle: number | null; wantedStars: number };
  vehicles: Array<[number, string, number, number, number]>;
  characters: Array<[number, string, number, number, number, string]>;
  wanted: number;
  money: number;
  weather: unknown;
  clock: number[];
  events: Array<[string, unknown]>;
}

export interface SeedTrace {
  seed: number;
  end: string;
  streetRunStarted: boolean;
  frames: TraceFrame[];
}

export interface SpTrace {
  dt: number;
  frameCount: number;
  seeds: SeedTrace[];
}

function look(sim: Sim, inp: PlayerInput, yaw: number): PlayerInput {
  if (inp.aimOrigin.x !== 0 || inp.aimOrigin.y !== 0 || inp.aimOrigin.z !== 0) return inp;
  const p = sim.playerPos();
  inp.aimOrigin = { x: p.x - Math.sin(yaw) * 6, y: p.y + 3, z: p.z - Math.cos(yaw) * 6 };
  inp.aimDir = { x: Math.sin(yaw), y: -0.1, z: Math.cos(yaw) };
  inp.cameraYaw = yaw;
  return inp;
}

function input(over: Partial<PlayerInput>): PlayerInput {
  return { ...neutralInput(), ...over };
}

/** Extra Sim options for a variant of the trace (the baseline uses none, as 72d0b98 had none of them). */
export interface TraceOptions {
  streetCrime?: boolean;
}

function record(seed: number, end: 'wasted' | 'busted', extra: TraceOptions = {}): SeedTrace {
  const sim = new Sim({ world: new StaticWorld(), ambient: true, police: true, seed, weather: 'dynamic', startHour: 20, ...extra });
  let pending: Array<[string, unknown]> = [];
  const emit = sim.events.emit.bind(sim.events);
  sim.events.emit = ((type: string, payload: unknown) => {
    pending.push(serialise(type, payload));
    (emit as (t: string, p: unknown) => void)(type, payload);
  }) as typeof sim.events.emit;

  const out: SeedTrace = { seed, end, streetRunStarted: false, frames: [] };
  let yaw = 0;
  let victim: ReturnType<Sim['spawnCharacter']> | null = null;

  const sample = (frame: number) => {
    const p = sim.player;
    out.frames.push({
      frame,
      player: { pos: [r6(p.pos.x), r6(p.pos.y), r6(p.pos.z)], heading: r6(p.heading), health: r6(p.health), state: p.state, vehicle: p.vehicle ? p.vehicle.id : null, wantedStars: sim.wanted.level },
      vehicles: sim.vehicles.map((v) => [v.id, v.kind, r6(v.pos.x), r6(v.pos.y), r6(v.pos.z)]),
      characters: sim.characters.map((c) => [c.id, c.role, r6(c.pos.x), r6(c.pos.y), r6(c.pos.z), c.state]),
      wanted: sim.wanted.level,
      money: sim.progress.money,
      weather: JSON.parse(JSON.stringify(sim.weather.state, (_k, v: unknown) => (typeof v === 'number' ? r6(v) : v))) as unknown,
      clock: [sim.clock.day, r6(sim.clock.hours)],
      events: pending,
    });
    pending = [];
  };

  for (let f = 0; f < TRACE_FRAMES; f++) {
    let inp = input({});
    if (f >= 180 && f < 540) {
      yaw = Math.sin(f / 120) * 0.6;
      inp = input({ moveZ: 1, sprint: f >= 420 });
    } else if (f === 540) {
      const p = sim.player.pos;
      const h = sim.player.heading;
      sim.spawnVehicle('sedan', p.x + Math.sin(h) * 4, p.z + Math.cos(h) * 4, h);
    } else if (f === 541) {
      inp = input({ enterExit: true });
    } else if (f === 720 && !sim.player.vehicle) {
      const car = sim.nearestVehicle(sim.player.pos.x, sim.player.pos.z, 12);
      if (car) sim.seat(sim.player, car, 0);
    } else if (f >= 720 && f < 1320) {
      const t = f - 720;
      yaw = sim.player.vehicle ? sim.player.vehicle.heading : yaw;
      inp = input({ throttle: t % 300 < 240 ? 1 : 0, brake: t % 300 >= 240 ? 1 : 0, steer: Math.sin(t / 70) * 0.5, handbrake: t % 300 >= 280 });
    } else if (f === 1320) {
      inp = input({ enterExit: true });
    } else if (f === 1400) {
      sim.player.inventory.give('pistol', 200);
      sim.player.inventory.current = 'pistol';
      const p = sim.player.pos;
      const h = sim.player.heading;
      victim = sim.spawnCharacter('civilian', p.x + Math.sin(h) * 6, p.z + Math.cos(h) * 6);
    } else if (f > 1400 && f < 1700 && victim) {
      const p = sim.player.pos;
      const dx = victim.pos.x - p.x;
      const dz = victim.pos.z - p.z;
      const l = Math.hypot(dx, dz) || 1;
      yaw = Math.atan2(dx, dz);
      inp = input({ aim: true, fire: f % 25 === 0, firePressed: f % 25 === 0, moveZ: l > 8 ? 1 : 0 });
      inp.aimOrigin = { x: p.x - (dx / l) * 3, y: p.y + 1.6 + 0.6, z: p.z - (dz / l) * 3 };
      const ay = victim.pos.y + 1.2 - inp.aimOrigin.y;
      const al = Math.hypot(dx + (dx / l) * 3, ay, dz + (dz / l) * 3) || 1;
      inp.aimDir = { x: (dx + (dx / l) * 3) / al, y: ay / al, z: (dz + (dz / l) * 3) / al };
      inp.cameraYaw = yaw;
    } else if (f === 1700) {
      sim.wanted.setLevel(3);
    } else if (f > 1700 && f < 2300) {
      yaw = Math.sin(f / 100) * 2;
      inp = input({ moveZ: 1, sprint: true });
    } else if (f === 2300) {
      sim.wanted.setLevel(0);
      const course = sim.activities.streetRunCourses().find((c) => c.id === 'magnolia')!;
      const car = sim.spawnVehicle('sports', course.start.x, course.start.z, course.start.heading);
      sim.player.pos.x = course.start.x;
      sim.player.pos.z = course.start.z;
      sim.seat(sim.player, car, 0);
      car.usedByPlayer = true;
      out.streetRunStarted = sim.activities.startStreetRun('magnolia');
    } else if (f > 2300 && f < 3000) {
      const t = f - 2300;
      yaw = sim.player.vehicle ? sim.player.vehicle.heading : yaw;
      inp = input({ throttle: t > 200 ? 0.45 : 0, steer: Math.sin(t / 60) * 0.12 });
    } else if (f === 3000) {
      if (end === 'wasted') sim.combat.damageCharacter(sim.player, 2000, null, 'fall', 0, -1, 0);
      else sim.bustPlayer();
    }
    sim.update(DT, look(sim, inp, yaw));
    if ((f + 1) % 60 === 0) sample(f + 1);
  }
  return out;
}

export function recordSpTrace(extra: TraceOptions = {}): SpTrace {
  return { dt: DT, frameCount: TRACE_FRAMES, seeds: TRACE_SEEDS.map((seed, i) => record(seed, TRACE_END[i]!, extra)) };
}
