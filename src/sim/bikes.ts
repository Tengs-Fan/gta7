// Motorbike rules the physics step does not cover: a crash throws the rider off. A bike whose speed changes by more
// than its spec's throwSpeed within one frame (a wall, a parked bus, a blast), that lands on its side or lands too hard
// throws everyone on it off: knocked down beside it, hurt by the fall (or killed by it), and the bike lies on its side
// where it stopped until someone gets on again.

import { makeBrain } from './brains';
import type { Character, Vehicle } from './entities';
import type { Sim } from './sim';
import type { SimSystem } from './systems';

/** Landing faster than this (m/s down) throws the rider even when the bike lands on its wheels. */
export const THROW_LANDING = 14;
/** Fall damage to someone thrown off at an impact of `speed` m/s (about 60 at 20 m/s into a wall). */
export function throwDamage(speed: number): number {
  return 6 + Math.max(0, speed - 5) * 2.6;
}

interface Seen {
  vx: number;
  vz: number;
  vy: number;
  air: boolean;
}

/** Each sim's bikes as they were at the end of the last frame's physics. */
const seenBy = new WeakMap<Sim, WeakMap<Vehicle, Seen>>();

export const BIKE_SYSTEM: SimSystem = {
  id: 'bikes',
  slot: 'afterPhysics',
  update(sim) {
    let seen = seenBy.get(sim);
    if (!seen) seenBy.set(sim, (seen = new WeakMap()));
    for (const v of sim.vehicles) {
      if (v.removed || v.spec.class !== 'bike') continue;
      const was = seen.get(v);
      if (was && (v.driver || v.passengers.some((p) => p))) {
        const dv = Math.hypot(v.vel.x - was.vx, v.vel.z - was.vz);
        const hardLanding = was.air && !v.airborne && was.vy < -THROW_LANDING;
        if (dv > (v.spec.bike?.throwSpeed ?? Infinity) || v.toppled || hardLanding) throwRiders(sim, v, Math.max(dv, hardLanding ? -was.vy : 0), was);
      }
      const s = was ?? { vx: 0, vz: 0, vy: 0, air: false };
      s.vx = v.vel.x;
      s.vz = v.vel.z;
      s.vy = v.vy;
      s.air = v.airborne;
      if (!was) seen.set(v, s);
    }
  },
  reset(sim) {
    seenBy.delete(sim);
  },
};

/** Throws everyone off `v` after an impact of `speed` m/s; `before` is the bike's velocity just before it. */
export function throwRiders(sim: Sim, v: Vehicle, speed: number, before: { vx: number; vz: number }): void {
  if (!v.toppled) {
    v.toppled = true;
    // It goes down on the side it leaned to (the outside of a turn otherwise).
    if (Math.abs(v.lean) < 0.05) v.lean = v.angVel >= 0 ? 0.05 : -0.05;
  }
  v.wheelie = 0;
  for (const c of v.occupants()) {
    const slot = sim.slotOf(c);
    if (slot) slot.ctl.thrownOff(speed, before.vx, before.vz);
    else throwNpc(sim, c, v, speed, before);
  }
}

function throwNpc(sim: Sim, c: Character, v: Vehicle, speed: number, before: { vx: number; vz: number }): void {
  sim.unseat(c);
  const sx = Math.cos(v.heading);
  const sz = -Math.sin(v.heading);
  const side = c.seat === 0 ? 1 : -1;
  const spot = sim.world.findFreeSpot(v.pos.x + sx * side * (v.halfW + 0.6), v.pos.z + sz * side * (v.halfW + 0.6), 0.4, 4, true) ?? { x: v.pos.x, z: v.pos.z };
  c.pos.x = spot.x;
  c.pos.z = spot.z;
  c.pos.y = Math.max(sim.world.groundHeight(spot.x, spot.z), v.pos.y) + 0.3;
  c.vel.x = before.vx * 0.5;
  c.vel.z = before.vz * 0.5;
  c.vel.y = 3;
  c.onGround = false;
  c.state = 'knocked';
  c.knockTimer = 2.2;
  sim.combat.damageCharacter(c, throwDamage(speed), null, 'fall', before.vx, -1, before.vz);
  // A traffic rider has no brain of his own: he gets up and goes on foot like anyone else.
  if (!c.brain) c.brain = makeBrain('wander');
  if (c.owner === 'traffic') c.owner = 'ped';
}
