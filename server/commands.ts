// Client commands (menu actions). Story missions, cheats and saving stay single-player: there are no commands for them.
// 'debug' exists only on a server started with --dev (tests, measurements, validation of busy scenes).

import { WEAPONS, type VehicleKind, type WeaponId } from '../src/sim/specs';
import { VEHICLE_SPECS } from '../src/sim/specs';
import type { Member, Room } from './room';

type Handler = (room: Room, m: Member, arg: string) => void;

const HANDLERS = new Map<string, Handler>();

export function registerCommand(name: string, fn: Handler): void {
  HANDLERS.set(name, fn);
}

export function runCommand(room: Room, m: Member, name: string, arg: string): boolean {
  const fn = HANDLERS.get(name);
  if (!fn) return false;
  if (name === 'debug' && !room.opts.dev) return false;
  try {
    fn(room, m, arg);
  } catch (err) {
    room.opts.log(`[room ${room.id}] command ${name} from player ${m.playerId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

/** Skip the wasted/busted screen once it has run its course on the client. */
registerCommand('respawn', (room, m) => {
  if (m.slot !== 0) return;
  if (room.sim.playerDown && room.sim.deathTimer > 2) room.sim.finishRespawn();
});

/** Resend everything: the client missed a snapshot, so what it was sent since only as changes may be lost to it. */
registerCommand('resync', (_room, m) => {
  m.resync();
});

interface DebugArgs {
  wanted?: number;
  teleport?: [number, number];
  give?: [string, number];
  /** Spawn a vehicle of this kind next to the player and seat him in it. */
  drive?: string;
  godMode?: boolean;
}

registerCommand('debug', (room, m, arg) => {
  if (m.slot === null) return;
  const sim = room.sim;
  const a = JSON.parse(arg) as DebugArgs;
  const p = room.slots.character(m.slot);
  if (a.godMode !== undefined) sim.cheats.godMode = !!a.godMode;
  if (a.teleport && Number.isFinite(a.teleport[0]) && Number.isFinite(a.teleport[1])) {
    if (p.vehicle) sim.unseat(p);
    p.state = 'normal';
    const [x, z] = a.teleport;
    const spot = sim.world.findFreeSpot(x, z, 0.5, 20) ?? { x, z };
    p.pos.x = spot.x;
    p.pos.z = spot.z;
    p.pos.y = sim.world.groundHeight(spot.x, spot.z);
    p.vel.x = 0;
    p.vel.y = 0;
    p.vel.z = 0;
  }
  if (a.drive && a.drive in VEHICLE_SPECS) {
    const lane = sim.roads.nearestLane(p.pos.x, p.pos.z).lane;
    const v = sim.spawnVehicle(a.drive as VehicleKind, lane.sx + lane.dx * 5, lane.sz + lane.dz * 5, lane.heading);
    if (p.vehicle) sim.unseat(p);
    sim.seat(p, v, 0);
    v.usedByPlayer = true;
  }
  if (a.give && a.give[0] in WEAPONS) {
    p.inventory.give(a.give[0] as WeaponId, Math.max(0, Math.min(9999, a.give[1] | 0)));
    p.inventory.current = a.give[0] as WeaponId;
  }
  if (a.wanted !== undefined) sim.wanted.setLevel(a.wanted);
});
