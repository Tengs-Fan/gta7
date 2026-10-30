// Helpers for the multi-player sim tests (mp_core*.test.ts): per-slot inputs with a camera behind each player, an
// event log with entity refs as ids, and a state hash.

import { createHash } from 'node:crypto';
import type { Character } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { PlayerSlot } from '../../src/sim/playerSlot';
import type { Sim } from '../../src/sim/sim';
import { input, legacyLane } from './helpers';

export const DT = 1 / 60;

/** Input for `c` with a third-person camera 6 m behind him, looking the way he faces (or `yaw`). */
export function behind(c: Character, over: Partial<PlayerInput> = {}, yaw?: number): PlayerInput {
  const p = c.vehicle ? c.vehicle.pos : c.pos;
  const h = yaw ?? (c.vehicle ? c.vehicle.heading : c.heading);
  return input({
    aimOrigin: { x: p.x - Math.sin(h) * 6, y: p.y + 3, z: p.z - Math.cos(h) * 6 },
    aimDir: { x: Math.sin(h), y: -0.12, z: Math.cos(h) },
    cameraYaw: h,
    ...over,
  });
}

/** Steps `sim` for `seconds`; `inputs(slot, t)` gives each slot's input (a camera behind him by default). */
export function stepSlots(sim: Sim, seconds: number, inputs: (slot: PlayerSlot, t: number) => PlayerInput | null = () => null, each?: (t: number) => void): void {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) {
    const t = i * DT;
    const map = new Map<number, PlayerInput>();
    for (const s of sim.players) map.set(s.id, inputs(s, t) ?? behind(s.character));
    sim.update(DT, map);
    each?.(t);
  }
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Entity references become ids and numbers are rounded, as cross_determinism.test.ts serialises events. */
export function serialise(type: string, payload: unknown): string {
  return `${type}:${JSON.stringify(payload, function (this: unknown, key, value: unknown) {
    if (key !== '' && value && typeof value === 'object' && 'id' in value && 'pos' in value) return `${'spec' in value ? 'V' : 'C'}${(value as { id: number }).id}`;
    if (typeof value === 'number') return r6(value);
    return value;
  })}`;
}

/** Every event the sim emits from now on, in order, with its payload as given. */
export function recordEvents(sim: Sim): Array<{ type: string; payload: Record<string, unknown> }> {
  const log: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const emit = sim.events.emit.bind(sim.events) as (t: string, p: unknown) => void;
  (sim.events as unknown as { emit: (t: string, p: unknown) => void }).emit = (type, payload) => {
    log.push({ type, payload: payload as Record<string, unknown> });
    emit(type, payload);
  };
  return log;
}

/** Hash of every entity's position and state and each slot's wanted level, money and health. */
export function stateHash(sim: Sim): string {
  const h = createHash('sha256');
  for (const v of sim.vehicles) h.update(`V${v.id}:${v.kind}:${r6(v.pos.x)},${r6(v.pos.y)},${r6(v.pos.z)}:${r6(v.heading)}:${r6(v.health)}:${v.destroyed};`);
  for (const c of sim.characters) h.update(`C${c.id}:${c.role}:${r6(c.pos.x)},${r6(c.pos.y)},${r6(c.pos.z)}:${c.state}:${r6(c.health)};`);
  for (const s of sim.players) h.update(`S${s.id}:${s.wanted.level}:${s.progress.money}:${r6(s.character.health)}:${s.deathKind};`);
  h.update(`T${r6(sim.time)}:${r6(sim.clock.hours)}`);
  return h.digest('hex');
}

/** A point on the sidewalk-free road `lane` at `s` m along it. */
export function onLane(sim: Sim, laneIndex: number, s = 20): { x: number; z: number; heading: number } {
  const lane = legacyLane(sim, laneIndex);
  return { x: lane.sx + lane.dx * s, z: lane.sz + lane.dz * s, heading: lane.heading };
}

/** Moves a slot's character (or his car) to (x, z). */
export function place(sim: Sim, slot: PlayerSlot, x: number, z: number): void {
  const c = slot.character;
  const o = c.vehicle ?? c;
  const spot = c.vehicle ? { x, z } : (sim.world.findFreeSpot(x, z, 0.5, 12) ?? { x, z });
  o.pos.x = spot.x;
  o.pos.z = spot.z;
  o.pos.y = sim.world.groundHeight(spot.x, spot.z);
  o.vel.x = 0;
  o.vel.z = 0;
  if (c.vehicle) sim.syncOccupant(c);
}
