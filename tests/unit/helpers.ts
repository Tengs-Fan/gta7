import type { V3 } from '../../src/core/math';
import type { Character, Vehicle } from '../../src/sim/entities';
import { neutralInput, type PlayerInput } from '../../src/sim/input';
import { Sim, type SimOptions } from '../../src/sim/sim';
import type { Lane, RoadNetwork } from '../../src/world/roads';
import { StaticWorld } from '../../src/world/staticWorld';

let shared: StaticWorld | null = null;
/** The city is immutable apart from broken props; share it between tests for speed. */
export function world(): StaticWorld {
  if (!shared) shared = new StaticWorld();
  return shared;
}

export function freshWorld(): StaticWorld {
  return new StaticWorld();
}

export function makeSim(opts: SimOptions = {}): Sim {
  return new Sim({ world: freshWorld(), ambient: false, police: true, ...opts });
}

export function input(over: Partial<PlayerInput> = {}): PlayerInput {
  return { ...neutralInput(), ...over };
}

/** Steps the sim for `seconds` at 60 fps; `fn` may adjust input every frame. */
export function step(sim: Sim, seconds: number, inp: PlayerInput | ((t: number) => PlayerInput) = input(), dt = 1 / 60): void {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    const cur = typeof inp === 'function' ? inp(i * dt) : inp;
    // Keep a plausible camera pose for visibility heuristics.
    if (cur.aimOrigin.x === 0 && cur.aimOrigin.z === 0 && cur.aimOrigin.y === 0) {
      const p = sim.playerPos();
      cur.aimOrigin = { x: p.x, y: p.y + 3, z: p.z - 6 };
    }
    sim.update(dt, cur);
  }
}

/** Input that aims from slightly behind the player at a target point. */
export function aimAt(sim: Sim, target: V3, over: Partial<PlayerInput> = {}): PlayerInput {
  const p = sim.playerPos();
  const o = { x: p.x, y: p.y + 1.6, z: p.z };
  let dx = target.x - o.x;
  let dy = target.y - o.y;
  let dz = target.z - o.z;
  const l = Math.hypot(dx, dy, dz) || 1;
  dx /= l;
  dy /= l;
  dz /= l;
  // Pull the camera origin back along the ray, like a third-person camera.
  return input({ aimOrigin: { x: o.x - dx * 3, y: o.y - dy * 3, z: o.z - dz * 3 }, aimDir: { x: dx, y: dy, z: dz }, cameraYaw: Math.atan2(dx, dz), ...over });
}

export function teleport(sim: Sim, x: number, z: number): void {
  const p = sim.player;
  if (p.vehicle) {
    const v = p.vehicle;
    v.pos.x = x;
    v.pos.z = z;
    v.pos.y = sim.world.groundHeight(x, z);
    v.vel.x = 0;
    v.vel.z = 0;
  } else {
    p.pos.x = x;
    p.pos.z = z;
    p.pos.y = sim.world.groundHeight(x, z);
    p.vel.x = 0;
    p.vel.z = 0;
  }
}

/** A point in the middle of a long straight lane, with its heading. */
/**
 * The lane that was roads.lanes[id] in the square city, before road segments could be missing (docs/map.md): the
 * fixtures that name lanes by number keep their places whatever the map closes elsewhere. That order was the
 * junctions by id, each one's directions N, E, S, W, and each direction's lanes from the centre line out.
 */
export function legacyLane(sim: { roads: RoadNetwork }, id: number): Lane {
  const roads = sim.roads;
  const { n, vLines, hLines } = roads.layout;
  const step = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
  let k = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      for (let d = 0; d < 4; d++) {
        const ni = i + step[d]![0];
        const nj = j + step[d]![1];
        if (ni < 0 || ni > n || nj < 0 || nj > n) continue;
        const lanes = (d % 2 === 0 ? vLines[i]! : hLines[j]!).lanes;
        if (id < k + lanes) return roads.lanesBetween(roads.id(i, j), roads.id(ni, nj))[id - k]!;
        k += lanes;
      }
    }
  }
  throw new Error(`No lane ${id} in the square city`);
}

export function roadPoint(sim: Sim, laneIndex = 40, s = 20): { x: number; z: number; heading: number; lane: ReturnType<Sim['roads']['nearestLane']>['lane'] } {
  const lane = legacyLane(sim, laneIndex);
  return { x: lane.sx + lane.dx * s, z: lane.sz + lane.dz * s, heading: lane.heading, lane };
}

export function placeInCar(sim: Sim, v: Vehicle): void {
  sim.seat(sim.player, v, 0);
  v.usedByPlayer = true;
}

export function allFinite(sim: Sim): boolean {
  const ok = (v: V3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  return sim.vehicles.every((v: Vehicle) => ok(v.pos) && Number.isFinite(v.heading) && Number.isFinite(v.vel.x)) && sim.characters.every((c: Character) => ok(c.pos) && ok(c.vel));
}
