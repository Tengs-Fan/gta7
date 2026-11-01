// Las Lomas County's crows (no three.js, no sim state): small flocks perched on the ground by the roads, on wires, on the
// barns' ridges and the water tower's cone. A flock lifts off together when a car or the player comes within SCARE_R of
// any of its birds, circles over its place with a caw or two, and settles back on its own perches once nothing has been
// near for a few seconds (and takes off again if something comes while it is landing). Each bird's own constants (its
// circle's radius, height and speed, how long it waits before leaving) are hashes of the flock and the bird, so no
// random generator is drawn from while it runs; the sites alone use a generator of their own, seeded here.

import { Rng } from '../../../core/rng';
import { clamp, dampAngle, smoothstep, TAU } from '../../../core/math';
import { hashInts, rectCX, rectCZ } from '../../../world/layout';
import { GARAGE_ROOF, type StaticWorld } from '../../../world/staticWorld';
import { WIRES, wirePoint, type Wire } from './wires';

/** A car or the player this close (m) to any of a flock's birds, on the ground plane, puts it up. */
export const SCARE_R = 20;
/** The flock stays up while anything moving is within this of its middle, and settles CALM_FOR s after the last. */
export const SETTLE_R = 30;
export const CALM_FOR = 2.5;
/** The least a flock stays up (s from the take-off), the time a bird takes to rise to its circle and to come down. */
export const MIN_AIR = 9;
export const RISE = 2.6;
export const LAND = 3.2;
/** Birds leave and land over this many seconds, each at its own moment. */
const TAKEOFF_SPREAD = 0.6;
const LAND_SPREAD = 1.8;
/** Seconds after the take-off of each of the three caws. */
const CAWS: readonly number[] = [0, 0.5, 1.15];
/** Seconds between the chances of a caw while the flock circles. */
const CIRCLE_CAW = 3.5;

export interface Perch {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** On the ground, where it pecks. */
  ground: boolean;
}

export interface Threat {
  x: number;
  z: number;
}

/** A bird as drawn: its feet or body (x, y, z), heading, pitch (+ nose up), bank (+ into a left turn), wings and flap; the world's ground is 0 where they stand. */
export interface CrowPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  bank: number;
  /** Wings: 0 folded to 1 spread, the flap's phase (rad) and its depth (0 glide to 1 beating). */
  open: number;
  flap: number;
  amp: number;
  /** A peck's dip of the head and body (rad), on the ground. */
  peck: number;
}

export type FlockState = 'perched' | 'rising' | 'circling' | 'landing';

/** A hash of the flock, the bird and a salt as a number in [0, 1). */
const unit = (...k: number[]) => (hashInts(...k) % 10000) / 10000;

export class Flock {
  state: FlockState = 'perched';
  readonly crows: CrowPose[];
  /** How many of its birds are out (a tier's share of the perches). */
  count: number;
  /** Where its circle is centred: the perches' mean. */
  readonly cx: number;
  readonly cz: number;
  /** Which way round it circles (+1 or -1). */
  private readonly dir: number;
  private readonly flight: number[];
  private readonly angle: number[];
  private readonly radius: number[];
  private readonly alt: number[];
  private readonly speed: number[];
  private readonly wait: number[];
  private readonly settle: number[];
  /** Seconds since the take-off, in this state, since anything moved near, and the last caw bucket. */
  private air = 0;
  private since = 0;
  private calm = 0;
  private cawed = 0;
  private bucket = -1;

  constructor(
    readonly id: number,
    readonly perches: readonly Perch[],
    /** The heights over the ground (m) its birds circle at. */
    ceiling: readonly [number, number] = [9, 19],
  ) {
    this.count = perches.length;
    this.cx = perches.reduce((s, p) => s + p.x, 0) / perches.length;
    this.cz = perches.reduce((s, p) => s + p.z, 0) / perches.length;
    this.dir = unit(id, 99) < 0.5 ? 1 : -1;
    const n = perches.length;
    const per = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
    this.flight = per(() => 0);
    this.angle = per((i) => unit(id, i, 1) * TAU);
    this.radius = per((i) => 13 + unit(id, i, 2) * 17);
    this.alt = per((i) => ceiling[0] + unit(id, i, 3) * (ceiling[1] - ceiling[0]));
    this.speed = per((i) => 8 + unit(id, i, 4) * 3);
    this.wait = per((i) => unit(id, i, 5) * TAKEOFF_SPREAD);
    this.settle = per((i) => unit(id, i, 6) * LAND_SPREAD);
    this.crows = perches.map((p, i) => ({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: 0, bank: 0, open: 0, flap: unit(id, i, 7) * TAU, amp: 0, peck: 0 }));
  }

  /** The tier's share of the birds: the first `n` perches; everything sits down again. */
  setCount(n: number): void {
    this.count = clamp(Math.round(n), 1, this.perches.length);
    this.state = 'perched';
    this.flight.fill(0);
  }

  /** Whether any of the first `count` perches is within SCARE_R of a threat. */
  private scared(threats: readonly Threat[]): boolean {
    for (const t of threats) for (let i = 0; i < this.count; i++) if (Math.hypot(t.x - this.perches[i]!.x, t.z - this.perches[i]!.z) < SCARE_R) return true;
    return false;
  }

  /** Whether any threat is within SETTLE_R of the circle's middle. */
  private restless(threats: readonly Threat[]): boolean {
    return threats.some((t) => Math.hypot(t.x - this.cx, t.z - this.cz) < SETTLE_R);
  }

  /** Puts the flock up now: the birds leave one after the other, and it caws. */
  private startle(): void {
    this.state = 'rising';
    this.since = 0;
    this.air = 0;
    this.calm = 0;
    this.cawed = 0;
  }

  /** The middle of the birds' drawn spots (where the caws come from). */
  middle(out: { x: number; y: number; z: number }): void {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < this.count; i++) {
      x += this.crows[i]!.x;
      y += this.crows[i]!.y;
      z += this.crows[i]!.z;
    }
    out.x = x / this.count;
    out.y = y / this.count;
    out.z = z / this.count;
  }

  private readonly mid = { x: 0, y: 0, z: 0 };

  /**
   * `dt` s on, `time` the sim's clock: the threats within reach lift it, keep it up or let it settle; `caw` is told
   * where each caw comes from.
   */
  update(dt: number, time: number, threats: readonly Threat[], caw: (x: number, y: number, z: number) => void): void {
    if (dt > 0) this.step(dt, threats, caw, time);
    this.pose(dt, time);
  }

  private step(dt: number, threats: readonly Threat[], caw: (x: number, y: number, z: number) => void, time: number): void {
    const scared = this.scared(threats);
    if (this.state === 'perched') {
      if (scared) this.startle();
    } else if (this.state === 'landing' && scared) {
      this.startle();
    }
    this.since += dt;
    if (this.state === 'rising') {
      this.air += dt;
      for (let i = 0; i < this.count; i++) if (this.since >= this.wait[i]!) this.flight[i] = Math.min(1, this.flight[i]! + dt / RISE);
      for (let k = this.cawed; k < CAWS.length; k++) {
        if (this.since < CAWS[k]!) break;
        this.middle(this.mid);
        caw(this.mid.x, this.mid.y + 1.5, this.mid.z);
        this.cawed = k + 1;
      }
      if (this.since >= RISE + TAKEOFF_SPREAD) this.state = 'circling';
    } else if (this.state === 'circling') {
      this.air += dt;
      this.calm = this.restless(threats) ? 0 : this.calm + dt;
      const bucket = Math.floor(time / CIRCLE_CAW);
      if (bucket !== this.bucket) {
        this.bucket = bucket;
        if (hashInts(bucket, this.id, 31) % 3 === 0) {
          this.middle(this.mid);
          caw(this.mid.x, this.mid.y, this.mid.z);
        }
      }
      if (this.air >= MIN_AIR && this.calm >= CALM_FOR) {
        this.state = 'landing';
        this.since = 0;
      }
    } else if (this.state === 'landing') {
      let down = true;
      for (let i = 0; i < this.count; i++) {
        if (this.since >= this.settle[i]!) this.flight[i] = Math.max(0, this.flight[i]! - dt / LAND);
        if (this.flight[i]! > 0) down = false;
      }
      if (down) this.state = 'perched';
    }
  }

  /** Each bird's drawn pose from its flight (0 on its perch to 1 on its circle). */
  private pose(dt: number, time: number): void {
    for (let i = 0; i < this.count; i++) {
      const c = this.crows[i]!;
      const p = this.perches[i]!;
      const f = this.flight[i]!;
      if (f <= 0) {
        c.x = p.x;
        c.y = p.y;
        c.z = p.z;
        c.yaw = p.yaw;
        c.pitch = 0;
        c.bank = 0;
        c.open = 0;
        c.amp = 0;
        // A ground crow dips its head now and then, each on its own beat.
        c.peck = p.ground ? 0.5 * Math.max(0, Math.sin(time * 2.3 + unit(this.id, i, 8) * TAU)) ** 8 : 0;
        continue;
      }
      if (dt > 0) this.angle[i] = this.angle[i]! + (this.dir * this.speed[i]! * dt) / this.radius[i]!;
      const s = smoothstep(0, 1, f);
      const a = this.angle[i]!;
      const ox = this.cx + Math.cos(a) * this.radius[i]!;
      const oz = this.cz + Math.sin(a) * this.radius[i]!;
      const oy = this.alt[i]! + Math.sin(time * 0.7 + i) * 0.8;
      const x = p.x + (ox - p.x) * s;
      const z = p.z + (oz - p.z) * s;
      const y = p.y + (oy - p.y) * Math.sqrt(s);
      c.peck = 0;
      if (dt > 0) {
        const vx = (x - c.x) / dt;
        const vy = (y - c.y) / dt;
        const vz = (z - c.z) / dt;
        const h = Math.hypot(vx, vz);
        if (h > 1) {
          c.yaw = dampAngle(c.yaw, Math.atan2(vx, vz), 9, dt);
          c.pitch += (clamp(Math.atan2(vy, h), -0.6, 0.6) * 0.8 - c.pitch) * Math.min(1, 8 * dt);
        }
        // Leaning into the circle: its middle is on the left of the heading when `dir` is -1.
        const bank = -this.dir * 0.55 * smoothstep(0.5, 1, f);
        c.bank += (bank - c.bank) * Math.min(1, 6 * dt);
        c.flap += dt * (f < 1 ? 26 : 20);
      }
      c.x = x;
      c.y = y;
      c.z = z;
      c.open = smoothstep(0.02, 0.14, f);
      // Beating on the way up and down; round its circle a few strokes and a glide, each bird on its own beat.
      c.amp = f < 0.97 ? 1 : smoothstep(-0.1, 0.35, Math.sin(time * 2.4 + unit(this.id, i, 9) * TAU));
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Where the flocks are

/** A box on the ground (x0..x1, z0..z1) by a road and how many birds it holds. */
const GROUND_SITES: ReadonlyArray<readonly [number, number, number, number, number]> = [
  // Halfmoon Acres' verge by the highway's south leg, the west straight's verge under the ridge, Hollister Lane's verge
  // and the south leg's far verge.
  [-1100, -1060, 246, 254, 7],
  [-1352, -1342, 18, 44, 6],
  [-1124, -1114, -360, -335, 6],
  [-1030, -1000, 282, 290, 5],
];

/** Whether a crow can stand on the ground at (x, z): flat county land off the roads, clear of every collider and crop. */
function groundOk(world: StaticWorld, x: number, z: number): boolean {
  return world.groundHeight(x, z) === 0 && !world.isOnRoad(x, z) && world.isFree(x, z, 0.7) && !world.cropAt(x, z) && !world.coverAt(x, z);
}

/** Every site's flocks' perches: ground, wires, the barns' ridges and the water tower's cone. */
export function crowSites(world: StaticWorld, wires: readonly Wire[] = WIRES): Array<{ perches: Perch[]; ceiling: readonly [number, number] }> {
  const rng = new Rng(7721);
  const out: Array<{ perches: Perch[]; ceiling: readonly [number, number] }> = [];
  for (const [x0, x1, z0, z1, n] of GROUND_SITES) {
    const perches: Perch[] = [];
    for (let tries = 0; perches.length < n && tries < 400; tries++) {
      const x = rng.range(x0, x1);
      const z = rng.range(z0, z1);
      if (groundOk(world, x, z) && perches.every((p) => Math.hypot(p.x - x, p.z - z) > 1.6)) perches.push({ x, y: 0, z, yaw: rng.range(-Math.PI, Math.PI), ground: true });
    }
    out.push({ perches, ceiling: [9, 19] });
  }
  // The wires: a flock over the first spans, another over the last.
  const spans = wires.length / 3;
  for (const [from, to, n] of [[0, Math.min(2, spans), 5], [Math.max(0, spans - 2), spans, 4]] as const) {
    const perches: Perch[] = [];
    for (let k = 0; k < n; k++) {
      const w = wires[(from + rng.int(0, to - from - 1)) * 3 + rng.int(0, 2)]!;
      const t = rng.range(0.18, 0.82);
      const [x, y, z] = wirePoint(w, t);
      perches.push({ x, y: y + 0.02, z, yaw: Math.atan2(w.bx - w.ax, w.bz - w.az) + (rng.chance(0.5) ? Math.PI : 0), ground: false });
    }
    out.push({ perches, ceiling: [10, 20] });
  }
  // The ridges of the barns at Halfmoon Acres and Hollister Bottoms.
  for (const id of ['acres', 'bottoms'] as const) {
    const f = world.layout.country.farms.farmsteads.find((q) => q.id === id)!;
    const gar = world.layout.garages.find((q) => q.poi === `${id}_barn`)!;
    const r = f.barn;
    const alongX = f.door === 'E' || f.door === 'W';
    const hw = (alongX ? r.maxZ - r.minZ : r.maxX - r.minX) / 2;
    const y = gar.height + GARAGE_ROOF + hw * 0.86 + 0.05;
    const perches: Perch[] = [];
    for (let k = 0; k < 4; k++) {
      const along = rng.range(0.15, 0.85);
      const x = alongX ? r.minX + (r.maxX - r.minX) * along : rectCX(r);
      const z = alongX ? rectCZ(r) : r.minZ + (r.maxZ - r.minZ) * along;
      perches.push({ x, y, z, yaw: alongX ? (rng.chance(0.5) ? Math.PI / 2 : -Math.PI / 2) : rng.chance(0.5) ? 0 : Math.PI, ground: false });
    }
    out.push({ perches, ceiling: [14, 24] });
  }
  // Round the water tower's cone, just in from its rim.
  const t = world.layout.country.places.town.tower;
  const rho = t.r - 1;
  const perches: Perch[] = [];
  for (let k = 0; k < 4; k++) {
    const a = k * 1.7 + 0.4;
    perches.push({ x: t.x + Math.cos(a) * rho, y: t.y1 + (2.4 * (t.r - rho)) / (t.r - 0.4), z: t.z + Math.sin(a) * rho, yaw: a + Math.PI / 2 + (k % 2) * Math.PI, ground: false });
  }
  out.push({ perches, ceiling: [24, 36] });
  return out;
}
