// Traffic round a vehicle nobody drives: drivers held up by one detour round it, and one left standing in a junction
// that no detour gets past is towed out of view, never the player's own car while he is near it (library F4).

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import type { Lane, RoadNode, Turn } from '../../src/world/roads';
import { input, makeSim, placeInCar, teleport } from './helpers';
import { at, dist } from './r2_police_helpers';

interface DetourPriv {
  avoid: Vehicle | null;
  avoidAt: number;
  reverseTimer: number;
  reverseKind: string;
  segs: Array<{ lane: Lane | null; turn: Turn | null }>;
  detourTurns(lane: Lane): readonly Turn[];
}
const priv = (v: Vehicle) => v.ai as unknown as DetourPriv;

/** A lane into junction (5,5) with a straight turn and others besides, and the junction. */
function approach(sim: Sim): { n: RoadNode; lane: Lane; straight: Turn } {
  const n = sim.roads.node(5, 5);
  const lane = sim.roads.lanes.find((l) => l.to === n.id && l.length > 45 && l.turns.length >= 2 && l.turns.some((t) => t.kind === 'straight'))!;
  return { n, lane, straight: lane.turns.find((t) => t.kind === 'straight')! };
}

/** The point `f` of the way along a turn's path. */
function along(t: Turn, f: number): { x: number; z: number } {
  const p = t.pts;
  let left = t.length * f;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const l = Math.hypot(p[k + 2]! - p[k]!, p[k + 3]! - p[k + 1]!);
    if (left <= l || k + 4 >= p.length) {
      const u = l > 0 ? Math.min(1, left / l) : 0;
      return { x: p[k]! + (p[k + 2]! - p[k]!) * u, z: p[k + 1]! + (p[k + 3]! - p[k + 1]!) * u };
    }
    left -= l;
  }
  return { x: p[0]!, z: p[1]! };
}

/** Nearest approach (m) of a turn's path, and of the first 12 m of the lane after it, to a point. */
function nearestTo(t: Turn, p: { x: number; z: number }): number {
  let best = Infinity;
  for (let k = 0; k < t.pts.length; k += 2) best = Math.min(best, Math.hypot(t.pts[k]! - p.x, t.pts[k + 1]! - p.z));
  for (let s = 0; s <= 12; s++) best = Math.min(best, dist(at(t.to, s), p));
  return best;
}

/** A traffic driver on `lane`, `s` m along it; with `straightOn`, one bound straight across the junction ahead. */
function trafficCar(sim: Sim, lane: Lane, s: number, straightOn?: Turn): Vehicle {
  const p = at(lane, s);
  const v = sim.spawnVehicle('sedan', p.x, p.z, lane.heading);
  sim.addDriver(v, 'civilian', straightOn ? 'route' : 'traffic');
  if (straightOn) {
    const far = at(straightOn.to, Math.min(60, straightOn.to.length - 5));
    v.ai!.setDestination(far.x, far.z);
  }
  v.ai!.setLane(lane, s);
  return v;
}

/** Input with the camera at (x, z) looking along (dx, dz). */
function look(x: number, z: number, dx: number, dz: number): PlayerInput {
  const l = Math.hypot(dx, dz) || 1;
  const d = { x: dx / l, y: -0.1, z: dz / l };
  return input({ aimDir: d, aimOrigin: { x: x - d.x * 4, y: 3, z: z - d.z * 4 }, cameraYaw: Math.atan2(d.x, d.z) });
}

function run(sim: Sim, seconds: number, inp: () => PlayerInput, each?: (t: number) => boolean | void): number {
  const t0 = sim.time;
  for (let f = 0; f < Math.round(seconds * 60); f++) {
    sim.update(1 / 60, inp());
    if (each?.(sim.time - t0)) break;
  }
  return sim.time - t0;
}

describe('the detour filter (VAL-TRAFFIC-003)', () => {
  it('keeps to turns clear of the remembered vehicle for 20 s, unless that would leave none', () => {
    const sim = makeSim({ police: false });
    const { lane, straight } = approach(sim);
    const car = trafficCar(sim, lane, 10);
    const ai = priv(car);
    const mid = along(straight, 0.5);
    const o = sim.spawnVehicle('sedan', mid.x, mid.z, lane.heading + Math.PI / 4);
    expect(ai.detourTurns(lane)).toBe(lane.turns);
    ai.avoid = o;
    ai.avoidAt = sim.time;
    const ok = ai.detourTurns(lane);
    expect(ok.length).toBeGreaterThan(0);
    expect(ok.length).toBeLessThan(lane.turns.length);
    expect(ok).not.toContain(straight);
    // Each turn kept passes (with the exit lane) clear of the car's body: its half diagonal and a half width more.
    for (const t of ok) expect(nearestTo(t, o.pos)).toBeGreaterThan(Math.hypot(o.halfL, o.halfW) * 0.9);
    ai.avoidAt = sim.time - 19.9;
    expect(ai.detourTurns(lane)).toEqual(ok);
    ai.avoidAt = sim.time - 20.1;
    expect(ai.detourTurns(lane)).toBe(lane.turns);
    ai.avoidAt = sim.time;
    sim.removeVehicle(o);
    expect(ai.detourTurns(lane)).toBe(lane.turns);
    // Standing across the end of the lane, every turn passes it: the filter is not applied.
    const end = at(lane, lane.length + 1.5);
    const across = sim.spawnVehicle('sedan', end.x, end.z, lane.heading + Math.PI / 2);
    ai.avoid = across;
    expect(ai.detourTurns(lane)).toBe(lane.turns);
  });
});

describe('drivers detour round an empty car (VAL-TRAFFIC-003)', () => {
  it('a driver coming up to an empty car in the junction plans round it and drives on', () => {
    const sim = makeSim({ police: false });
    const { n, lane, straight } = approach(sim);
    const mid = along(straight, 0.5);
    const o = sim.spawnVehicle('sedan', mid.x, mid.z, Math.PI / 4);
    const car = trafficCar(sim, lane, lane.length - 40, straight);
    const ai = priv(car);
    expect(ai.segs[1]?.turn).toBe(straight);
    teleport(sim, n.x + n.halfX + 3, n.z + n.halfZ + 3);
    const taken: Turn[] = [];
    let longest = 0;
    let held = 0;
    const t = run(sim, 40, () => look(n.x + 30, n.z + 30, 1, 1), () => {
      const seg = ai.segs[0];
      if (seg?.turn && !taken.includes(seg.turn)) taken.push(seg.turn);
      held = car.ai!.heldUpBy === o ? held + 1 / 60 : 0;
      longest = Math.max(longest, held);
      return dist(car.pos, n) > 30 && taken.length > 0 && !ai.segs[0]?.turn;
    });
    expect(ai.avoid).toBe(o);
    expect(taken.length).toBeGreaterThan(0);
    expect(taken[0]).not.toBe(straight);
    expect(nearestTo(taken[0]!, o.pos)).toBeGreaterThan(3);
    expect(longest).toBeLessThan(2);
    expect(t).toBeLessThan(40);
    expect(o.removed).toBe(false);
  });

  it('a driver held up for over 2 s in the junction by a car the player left re-plans, backs out and goes round it; not while he sits in it', () => {
    const sim = makeSim({ police: false });
    const { n, lane, straight } = approach(sim);
    const ahead = along(straight, 0.85);
    const mine = sim.spawnVehicle('sedan', ahead.x, ahead.z, lane.heading);
    placeInCar(sim, mine);
    const car = trafficCar(sim, lane, lane.length - 30, straight);
    const ai = priv(car);
    const away = () => look(mine.pos.x, mine.pos.z, -lane.dx, -lane.dz);
    // Queued behind the player sitting in his stopped car: an occupied car is no reason to detour.
    let reversed = false;
    run(sim, 9, () => ({ ...away(), handbrake: true, brake: 1 }), () => {
      if (ai.reverseTimer > 0) reversed = true;
    });
    expect(car.ai!.heldUpBy).toBe(mine);
    expect(ai.segs[0]?.turn).toBe(straight);
    expect(ai.avoid).toBe(null);
    expect(reversed).toBe(false);
    // He gets out and stands by it: 2 s later the driver re-plans round the car and backs out of the junction.
    expect(sim.playerCtl.exitVehicle(false)).toBe(true);
    let replannedAt = -1;
    let backedOutAt = -1;
    const taken: Turn[] = [];
    const t = run(sim, 40, away, (t) => {
      if (replannedAt < 0 && ai.avoid === mine) replannedAt = t;
      if (backedOutAt < 0 && ai.reverseTimer > 0) backedOutAt = t;
      const seg = ai.segs[0];
      if (replannedAt >= 0 && seg?.turn && !taken.includes(seg.turn)) taken.push(seg.turn);
      return replannedAt >= 0 && dist(car.pos, n) > 25 && !ai.segs[0]?.turn;
    });
    expect(replannedAt).toBeGreaterThan(1.95);
    expect(replannedAt).toBeLessThan(2.3);
    expect(backedOutAt).toBeCloseTo(replannedAt, 1);
    expect(taken.length).toBeGreaterThan(0);
    expect(taken).not.toContain(straight);
    expect(t).toBeLessThan(40);
    expect(mine.removed).toBe(false);
  });
});

/**
 * An empty sedan standing across the end of a lane into junction (5,5), so that every turn off the lane passes it,
 * and a traffic driver coming up to it. Ambient streaming runs (it does the towing), with no traffic spawned.
 */
function wedged(opts: { kind?: 'sedan' | 'police' } = {}) {
  const sim = makeSim({ police: false, ambient: true });
  sim.traffic.density = 0;
  const { n, lane } = approach(sim);
  const e = at(lane, lane.length + 2);
  const o = sim.spawnVehicle(opts.kind ?? 'sedan', e.x, e.z, lane.heading + Math.PI / 2);
  if (opts.kind === 'police') o.owner = 'police';
  const car = trafficCar(sim, lane, lane.length - 30);
  return { sim, n, lane, o, car };
}

describe('the tow fallback (VAL-TRAFFIC-004)', () => {
  it('tows an empty car out of view once it has held up junction traffic for 30 s, and traffic flows on', () => {
    const { sim, n, lane, o, car } = wedged();
    const p = at(lane, lane.length - 80);
    teleport(sim, p.x, p.z);
    let firstHeld = -1;
    let gone = -1;
    run(sim, 60, () => look(p.x, p.z, -lane.dx, -lane.dz), (t) => {
      if (firstHeld < 0 && car.ai?.heldUpBy === o) firstHeld = t;
      if (gone < 0 && o.removed) gone = t;
      return gone >= 0;
    });
    expect(firstHeld).toBeGreaterThan(0);
    expect(gone - firstHeld).toBeGreaterThanOrEqual(30);
    expect(gone - firstHeld).toBeLessThan(36);
    // The driver held up behind it goes on through the junction.
    run(sim, 20, () => look(p.x, p.z, -lane.dx, -lane.dz), () => dist(car.pos, n) > 25);
    expect(dist(car.pos, n)).toBeGreaterThan(25);
  });

  it('never tows a car in view', () => {
    const { sim, lane, o } = wedged();
    const p = at(lane, lane.length - 60);
    teleport(sim, p.x, p.z);
    run(sim, 70, () => look(p.x, p.z, o.pos.x - p.x, o.pos.z - p.z));
    expect(sim.isVisible(o.pos.x, o.pos.y, o.pos.z)).toBe(true);
    expect(o.removed).toBe(false);
  });

  it('never tows a car with someone in it, one someone is getting into, or a police unit', () => {
    for (const which of ['occupied', 'entering', 'police'] as const) {
      const { sim, lane, o, car } = wedged({ kind: which === 'police' ? 'police' : 'sedan' });
      const p = at(lane, lane.length - 80);
      teleport(sim, p.x, p.z);
      const c = sim.spawnCharacter('civilian', o.pos.x + 4, o.pos.z + 4);
      if (which === 'occupied') sim.seat(c, o, 1);
      if (which === 'entering') c.enterTarget = o;
      let held = 0;
      run(sim, 60, () => look(p.x, p.z, -lane.dx, -lane.dz), () => {
        if (car.ai?.heldUpBy === o) held++;
      });
      expect(held / 60, which).toBeGreaterThan(20);
      expect(o.removed, which).toBe(false);
    }
  });
});

describe("the player's own car (VAL-TRAFFIC-005)", () => {
  it('is kept while he stands within 20 m of it looking away; towed once he has walked off', () => {
    const { sim, lane, o, car } = wedged();
    o.usedByPlayer = true;
    const near = { x: o.pos.x + lane.dz * 12 - lane.dx * 4, z: o.pos.z - lane.dx * 12 - lane.dz * 4 };
    teleport(sim, near.x, near.z);
    let held = 0;
    run(sim, 90, () => look(near.x, near.z, near.x - o.pos.x, near.z - o.pos.z), () => {
      if (car.ai?.heldUpBy === o) held++;
    });
    expect(dist(sim.player.pos, o.pos)).toBeLessThan(20);
    expect(held / 60).toBeGreaterThan(30);
    expect(o.removed).toBe(false);
    const far = at(lane, lane.length - 80);
    teleport(sim, far.x, far.z);
    const t = run(sim, 45, () => look(far.x, far.z, -lane.dx, -lane.dz), () => o.removed);
    expect(o.removed).toBe(true);
    expect(t).toBeLessThan(45);
  });

  it('left diagonally in a busy junction with him standing by it, is never removed or moved in 180 s', () => {
    const sim = makeSim({ ambient: true, police: false, seed: 11, startHour: 17 });
    const n = sim.roads.node(5, 5);
    const mine = sim.spawnVehicle('sedan', n.x, n.z, Math.PI / 4);
    placeInCar(sim, mine);
    sim.unseat(sim.player);
    const px = n.x + n.halfX + 3;
    const pz = n.z + n.halfZ + 3;
    teleport(sim, px, pz);
    const x0 = mine.pos.x;
    const z0 = mine.pos.z;
    let detoured = 0;
    let queued = 0;
    run(sim, 180, () => {
      sim.player.pos.x = px;
      sim.player.pos.z = pz;
      // Facing away from the car.
      return look(px, pz, px - n.x, pz - n.z);
    }, () => {
      for (const v of sim.vehicles) {
        if (v.removed || !v.ai) continue;
        if (priv(v).avoid === mine) detoured++;
        if (v.ai.heldUpBy === mine) queued++;
      }
    });
    // Traffic came up to it and went round it.
    expect(detoured).toBeGreaterThan(0);
    expect(queued / 60).toBeLessThan(30);
    expect(mine.removed).toBe(false);
    expect(sim.vehicles).toContain(mine);
    expect(Math.hypot(mine.pos.x - x0, mine.pos.z - z0)).toBeLessThan(1.5);
  });
});

/** Seconds-weighted tally of drivers near the junction stuck over 20 s, the worst, and the longest held within 12 m. */
function junctionSoak(seed: number, i: number, j: number, seconds: number) {
  const sim = makeSim({ ambient: true, police: false, seed, startHour: 17 });
  const n = sim.roads.node(i, j);
  const wreck = sim.spawnVehicle('sedan', n.x, n.z, Math.PI / 4);
  wreck.usedByPlayer = true;
  const px = n.x + n.halfX + 3;
  const pz = n.z + n.halfZ + 3;
  teleport(sim, px, pz);
  const anchor = new Map<number, { x: number; z: number; t: number }>();
  let carSec = 0;
  let worst = 0;
  let worstHeld = 0;
  let yaw = 0;
  for (let f = 0; f < seconds * 60; f++) {
    sim.player.pos.x = px;
    sim.player.pos.z = pz;
    yaw += 0.15 / 60;
    sim.update(1 / 60, look(px, pz, Math.sin(yaw), Math.cos(yaw)));
    if (f % 30 !== 0) continue;
    for (const v of sim.vehicles) {
      if (v.removed || !v.ai || !v.driver || v.driver.isPlayer || v.destroyed || Math.hypot(v.pos.x - px, v.pos.z - pz) > 130) continue;
      if (v.stuckTime > 20) carSec += 0.5;
      worst = Math.max(worst, v.stuckTime);
      // Backing and filling round one spot is no progress either.
      const a = anchor.get(v.id);
      if (!a || Math.hypot(v.pos.x - a.x, v.pos.z - a.z) > 12) anchor.set(v.id, { x: v.pos.x, z: v.pos.z, t: sim.time });
      else worstHeld = Math.max(worstHeld, sim.time - a.t);
    }
  }
  expect(wreck.removed).toBe(false);
  return { carSec, worst, worstHeld };
}

describe('gridlock round a car abandoned in a junction (VAL-TRAFFIC-001, reduced)', () => {
  it('stays well under the old jams at (5,5) and (3,4), seeds 3 and 11', () => {
    // Before the detours these four runs came to 1,932 stuck car-seconds, drivers waiting at the car for minutes.
    let carSec = 0;
    let worst = 0;
    let worstHeld = 0;
    for (const seed of [3, 11]) {
      for (const [i, j] of [[5, 5], [3, 4]] as const) {
        const r = junctionSoak(seed, i, j, 180);
        carSec += r.carSec;
        worst = Math.max(worst, r.worst);
        worstHeld = Math.max(worstHeld, r.worstHeld);
      }
    }
    expect(carSec).toBeLessThanOrEqual(250);
    expect(worst).toBeLessThanOrEqual(60);
    expect(worstHeld).toBeLessThanOrEqual(90);
  }, 120_000);
});
