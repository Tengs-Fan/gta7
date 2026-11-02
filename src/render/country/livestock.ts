// The Lazy Q Ranch's animals (world/country/valley.ts Ranch), as presentation only: where each stands, which way it faces
// and what it is doing, moved each frame by the view (ranch.ts), with no sim state, no collider and nothing in a save or
// on the wire. Pure (no three.js), so a test steps them in Node.
// - The flock grazes round a gathering point in its pasture; a car or a person that comes within SCARE_PERSON m of a sheep
//   (a car's reach grows with its speed) sends it running away from him, and when he is gone the flock walks back to its
//   gathering point and settles to graze, the sheep each at its own place round it.
// - A horse keeps to its paddock's roam: it grazes with its head down, stands and flicks its tail, and now and then
//   walks to another spot.

import { Rng } from '../../core/rng';
import type { Rect } from '../../world/layout';

/** Whoever frightens the flock: a car or a person, where he is and how fast he moves (m/s). */
export interface Threat {
  x: number;
  z: number;
  speed: number;
}

/** How near (m) a person or a slow car must come to frighten a sheep, and how much farther a fast car does (per m/s). */
export const SCARE_PERSON = 15;
export const SCARE_PER_SPEED = 0.4;
/** The sheep's running pace and their walk back (m/s), and how long (s) one runs on once he is out of reach. */
export const SHEEP_RUN = 6.2;
export const SHEEP_WALK = 1.5;
export const SHEEP_RUN_ON = 2.2;
/** A gathering point keeps this far (m) beyond a threat's reach. */
const GATHER_CLEAR = 6;
/** The sheep keep this far (m) inside their pasture's fence. */
const FENCE_KEEP = 1.6;

/** How far (m) a threat of `speed` m/s frightens. */
export function scareRadius(speed: number): number {
  return SCARE_PERSON + SCARE_PER_SPEED * speed;
}

export type SheepMode = 'graze' | 'run' | 'return';

export interface Sheep {
  x: number;
  z: number;
  /** Which way it faces (rad, as a heading: 0 towards +z). */
  heading: number;
  mode: SheepMode;
  /** Where it settles in the flock, from the gathering point. */
  slot: { x: number; z: number };
  /** Its pace now (m/s). */
  speed: number;
  /** Seconds left of running on, and of the pause before it next moves while grazing. */
  runOn: number;
  rest: number;
  /** Where it wanders to while grazing, or null. */
  wander: { x: number; z: number } | null;
  /** Its own phase for the head's nod and the hop. */
  phase: number;
}

export class Flock {
  readonly sheep: Sheep[] = [];
  /** The flock's gathering point, which moves now and then to fresh grass, along the pasture's road side. */
  readonly centre: { x: number; z: number };
  private readonly rng: Rng;
  private move = 40;
  private watch = 0;

  constructor(readonly pasture: Rect, count: number, seed: number) {
    this.rng = new Rng(seed);
    this.centre = { x: pasture.minX + 12, z: pasture.minZ + 40 };
    for (let i = 0; i < count; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = Math.sqrt(this.rng.next()) * 9;
      const slot = { x: Math.cos(a) * d, z: Math.sin(a) * d };
      this.sheep.push({
        x: this.centre.x + slot.x, z: this.centre.z + slot.z, heading: this.rng.range(-Math.PI, Math.PI), mode: 'graze', slot, speed: 0,
        runOn: 0, rest: this.rng.range(0, 6), wander: null, phase: this.rng.range(0, Math.PI * 2),
      });
    }
  }

  /** Steps the flock `dt` s on with `threats` about. */
  update(dt: number, threats: readonly Threat[]): void {
    const p = this.pasture;
    const rng = this.rng;
    // To fresh grass: the gathering point moves to another spot of the pasture now and then.
    this.move -= dt;
    if (this.move <= 0) {
      this.move = rng.range(45, 90);
      this.centre.x = rng.range(p.minX + 10, p.minX + 40);
      this.centre.z = rng.range(p.minZ + 14, p.maxZ - 14);
    }
    // A flock whose gathering point lies in reach of someone who stays there moves it, to the spot of the pasture farthest from
    // them, rather than run from him and walk back to be frightened again.
    this.watch -= dt;
    if (this.watch <= 0 && threats.some((t) => Math.hypot(this.centre.x - t.x, this.centre.z - t.z) < scareRadius(t.speed) + GATHER_CLEAR)) {
      this.watch = 1;
      let best = this.centre;
      let far = -Infinity;
      for (let k = 0; k < 12; k++) {
        const c = { x: rng.range(p.minX + 8, p.maxX - 8), z: rng.range(p.minZ + 8, p.maxZ - 8) };
        const room = Math.min(...threats.map((t) => Math.hypot(c.x - t.x, c.z - t.z) - scareRadius(t.speed)));
        if (room > far) {
          far = room;
          best = c;
        }
      }
      this.centre.x = best.x;
      this.centre.z = best.z;
    }
    for (const s of this.sheep) {
      // The nearest threat that reaches it.
      let fear: Threat | null = null;
      let near = Infinity;
      for (const t of threats) {
        const d = Math.hypot(s.x - t.x, s.z - t.z);
        if (d < scareRadius(t.speed) && d < near) {
          fear = t;
          near = d;
        }
      }
      let tx = s.x;
      let tz = s.z;
      let pace = 0;
      if (fear) {
        s.mode = 'run';
        s.runOn = SHEEP_RUN_ON;
        // Away from him, each a little to one side of the others.
        s.heading = Math.atan2(s.x - fear.x, s.z - fear.z) + Math.sin(s.phase * 3.7) * 0.5;
        pace = SHEEP_RUN * rng.range(0.9, 1.1);
      } else if (s.mode === 'run') {
        s.runOn -= dt;
        pace = SHEEP_RUN * 0.8;
        if (s.runOn <= 0) s.mode = 'return';
      } else if (s.mode === 'return') {
        tx = this.centre.x + s.slot.x;
        tz = this.centre.z + s.slot.z;
        pace = SHEEP_WALK;
        if (Math.hypot(tx - s.x, tz - s.z) < 1.5) {
          s.mode = 'graze';
          s.wander = null;
          s.rest = rng.range(2, 7);
        }
      } else if (s.wander) {
        tx = s.wander.x;
        tz = s.wander.z;
        pace = 0.55;
        if (Math.hypot(tx - s.x, tz - s.z) < 0.4) {
          s.wander = null;
          s.rest = rng.range(3, 9);
        }
      } else {
        s.rest -= dt;
        // Grazing: a few steps now and then, to a spot near where it belongs.
        if (s.rest <= 0) s.wander = { x: this.centre.x + s.slot.x + rng.range(-2.5, 2.5), z: this.centre.z + s.slot.z + rng.range(-2.5, 2.5) };
      }
      // Ahead of the flock's drift: a grazing sheep follows the gathering point when it has moved on.
      if (s.mode === 'graze' && !s.wander && Math.hypot(this.centre.x + s.slot.x - s.x, this.centre.z + s.slot.z - s.z) > 6) s.mode = 'return';
      if (pace > 0 && !fear && s.mode !== 'run') {
        const want = Math.atan2(tx - s.x, tz - s.z);
        s.heading += Math.atan2(Math.sin(want - s.heading), Math.cos(want - s.heading)) * Math.min(1, dt * 5);
      }
      s.speed = pace;
      s.x += Math.sin(s.heading) * pace * dt;
      s.z += Math.cos(s.heading) * pace * dt;
      // Along the fence rather than through it.
      const x = Math.min(p.maxX - FENCE_KEEP, Math.max(p.minX + FENCE_KEEP, s.x));
      const z = Math.min(p.maxZ - FENCE_KEEP, Math.max(p.minZ + FENCE_KEEP, s.z));
      if (s.mode === 'run' && (x !== s.x || z !== s.z)) s.heading = Math.atan2(this.centre.x - x, this.centre.z - z);
      s.x = x;
      s.z = z;
    }
    // No two stand on one spot.
    for (let i = 0; i < this.sheep.length; i++) {
      for (let j = i + 1; j < this.sheep.length; j++) {
        const a = this.sheep[i]!;
        const b = this.sheep[j]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= 1.1 || d === 0) continue;
        const push = (1.1 - d) / 2;
        a.x -= (dx / d) * push;
        a.z -= (dz / d) * push;
        b.x += (dx / d) * push;
        b.z += (dz / d) * push;
      }
    }
  }
}

export type HorseMode = 'idle' | 'graze' | 'walk';

export interface Horse {
  x: number;
  z: number;
  heading: number;
  mode: HorseMode;
  /** The coat (0..4), and the roam it keeps inside. */
  coat: number;
  roam: Rect;
  /** Seconds left in this mode. */
  left: number;
  target: { x: number; z: number } | null;
  /** How far the head is down (0 up, 1 at the grass), the tail's swing (-1..1) and the legs' phase (rad). */
  head: number;
  tail: number;
  stride: number;
  /** When (s) the next flick of the tail starts, and when the last one did. */
  flickAt: number;
  flickFrom: number;
}

/** A horse's walk (m/s). */
export const HORSE_WALK = 1.3;
/** A flick of the tail takes this long (s). */
const FLICK = 0.9;

export function makeHorse(x: number, z: number, coat: number, roam: Rect, seed: number): Horse {
  const rng = new Rng(seed);
  return { x, z, heading: rng.range(-Math.PI, Math.PI), mode: 'idle', coat, roam, left: rng.range(1, 6), target: null, head: 0, tail: 0, stride: 0, flickAt: rng.range(1, 6), flickFrom: -10 };
}

/** Steps `horse` `dt` s on at time `now` (s); `rng` picks what it does next. */
export function stepHorse(h: Horse, dt: number, now: number, rng: Rng): void {
  h.left -= dt;
  if (h.mode === 'walk') {
    const t = h.target!;
    const d = Math.hypot(t.x - h.x, t.z - h.z);
    const want = Math.atan2(t.x - h.x, t.z - h.z);
    h.heading += Math.atan2(Math.sin(want - h.heading), Math.cos(want - h.heading)) * Math.min(1, dt * 2.5);
    h.x += Math.sin(h.heading) * HORSE_WALK * dt;
    h.z += Math.cos(h.heading) * HORSE_WALK * dt;
    h.stride += dt * HORSE_WALK * 4.2;
    if (d < 0.8 || h.left <= 0) {
      h.mode = 'idle';
      h.left = rng.range(3, 8);
      h.target = null;
    }
  } else if (h.left <= 0) {
    const roll = rng.next();
    if (roll < 0.28) {
      h.mode = 'walk';
      h.target = { x: rng.range(h.roam.minX, h.roam.maxX), z: rng.range(h.roam.minZ, h.roam.maxZ) };
      h.left = 25;
    } else if (roll < 0.7) {
      h.mode = 'graze';
      h.left = rng.range(9, 22);
    } else {
      h.mode = 'idle';
      h.left = rng.range(4, 10);
    }
  }
  // The head comes down to graze and goes up to look; the legs stand still when it is not walking.
  const want = h.mode === 'graze' ? 1 : 0;
  h.head += Math.sign(want - h.head) * Math.min(Math.abs(want - h.head), dt * 0.9);
  if (h.mode !== 'walk') h.stride += (Math.round(h.stride / Math.PI) * Math.PI - h.stride) * Math.min(1, dt * 6);
  // A flick of the tail now and then, a swing that dies away.
  if (now >= h.flickAt) {
    h.flickFrom = now;
    h.flickAt = now + rng.range(3, 9);
  }
  const f = (now - h.flickFrom) / FLICK;
  h.tail = f < 1 ? Math.sin(f * Math.PI * 3) * (1 - f) : 0;
  h.x = Math.min(h.roam.maxX, Math.max(h.roam.minX, h.x));
  h.z = Math.min(h.roam.maxZ, Math.max(h.roam.minZ, h.z));
}
