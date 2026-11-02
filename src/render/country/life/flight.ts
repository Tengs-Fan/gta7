// What flies and drives over Las Lomas County's fields, as pure functions of the clocks (no three.js, no sim state):
// - the crop-duster biplane's sorties: every SORTIE_PERIOD s of sim time one of two runs flies in off the sound, makes
//   three low passes along a field's rows (spraying while it is over crops), pulls up and leaves over the ridge, the
//   Halfmoon Acres run ending in a loop; a sortie that begins by day flies to its end, and none flies in the rain;
// - the combine harvester's circuit of the wheat, lane after lane with a headland turn between, its place on it the
//   hour of the working day (7:00-17:30), so it is where it is whenever the clock is set;
// - the hot-air balloon, which swells on its meadow at 05:30, lifts at 05:45, drifts south down the county over the
//   orchard and sets down at 08:15 in the meadow west of the wheat, to be folded away by 08:30, and its burner's flares.
// A path is a turtle's walk (lines, level turns, a loop) sampled every metre; a heading h points along (sin h, cos h).

import { clamp, lerp, smoothstep } from '../../../core/math';
import { hashInts, rectContains, type Rect } from '../../../world/layout';
import type { StaticWorld } from '../../../world/staticWorld';

/** A flyer's pose: where it is, its nose and its up (unit vectors), its velocity, and whether it is spraying. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  ux: number;
  uy: number;
  uz: number;
  vx: number;
  vy: number;
  vz: number;
  spray: boolean;
}

export const newPose = (): Pose => ({ x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, ux: 0, uy: 1, uz: 0, vx: 0, vy: 0, vz: 0, spray: false });

/** Metres between a path's samples. */
const STEP = 1;
const G = 9.81;
/** A banked turn leans at most this far (rad); a level turn eases its lean in and out over this many metres. */
const MAX_BANK = 1.15;
const BANK_RAMP = 24;
/** The doubles of a sample: x, y, z, nose, up. */
const STRIDE = 9;
/** One game hour is this many seconds at the clock's default rate (GameClock.rate). */
const SECONDS_PER_HOUR = 60;

/** A sampled path from a start to an end, `flag`ging the samples (the biplane's spray) by where they are. */
export class FlightPath {
  readonly length: number;
  private readonly count: number;
  private readonly flags: Uint8Array;

  constructor(private readonly data: Float32Array, flag: (x: number, y: number, z: number) => boolean) {
    this.count = data.length / STRIDE;
    this.length = (this.count - 1) * STEP;
    this.flags = new Uint8Array(this.count);
    for (let i = 0; i < this.count; i++) this.flags[i] = flag(data[i * STRIDE]!, data[i * STRIDE + 1]!, data[i * STRIDE + 2]!) ? 1 : 0;
  }

  /** The pose `s` m along the path (clamped to it), moving at `speed` m/s. */
  sample(s: number, speed: number, out: Pose): void {
    const f = clamp(s, 0, this.length) / STEP;
    const i = Math.min(this.count - 2, Math.floor(f));
    const t = f - i;
    const d = this.data;
    const a = i * STRIDE;
    const b = a + STRIDE;
    const mix = (k: number) => lerp(d[a + k]!, d[b + k]!, t);
    out.x = mix(0);
    out.y = mix(1);
    out.z = mix(2);
    const fl = Math.hypot(mix(3), mix(4), mix(5)) || 1;
    out.fx = mix(3) / fl;
    out.fy = mix(4) / fl;
    out.fz = mix(5) / fl;
    const ul = Math.hypot(mix(6), mix(7), mix(8)) || 1;
    out.ux = mix(6) / ul;
    out.uy = mix(7) / ul;
    out.uz = mix(8) / ul;
    out.vx = out.fx * speed;
    out.vy = out.fy * speed;
    out.vz = out.fz * speed;
    out.spray = this.flags[Math.round(f)] === 1;
  }
}

/** Walks a path: lines, level turns and a vertical loop, every sample a metre on. */
class Turtle {
  private readonly out: number[] = [];

  constructor(
    private x: number,
    private y: number,
    private z: number,
    private h: number,
    private readonly speed: number,
  ) {
    this.push(0, 0, 1);
  }

  /**
   * A sample at the current spot: the nose along the heading tilted up by `fy`, the up leaning `bank` towards `side` (+1
   * the heading's left, as a positive turn takes it, -1 its right).
   */
  private push(fy: number, bank: number, side: number): void {
    const c = Math.sqrt(Math.max(0, 1 - fy * fy));
    const fx = Math.sin(this.h) * c;
    const fz = Math.cos(this.h) * c;
    let ux = Math.cos(this.h) * side * Math.sin(bank);
    let uy = Math.cos(bank);
    let uz = -Math.sin(this.h) * side * Math.sin(bank);
    // Square to the nose.
    const along = ux * fx + uy * fy + uz * fz;
    ux -= along * fx;
    uy -= along * fy;
    uz -= along * fz;
    const ul = Math.hypot(ux, uy, uz);
    this.out.push(this.x, this.y, this.z, fx, fy, fz, ux / ul, uy / ul, uz / ul);
  }

  /** `len` m straight on, rising to altitude `yEnd`. */
  line(len: number, yEnd: number): this {
    const y0 = this.y;
    const slope = (yEnd - y0) / len;
    const fy = slope / Math.hypot(1, slope);
    const n = Math.round(len / STEP);
    for (let k = 1; k <= n; k++) {
      this.x += (Math.sin(this.h) * len) / n;
      this.z += (Math.cos(this.h) * len) / n;
      this.y = y0 + (yEnd - y0) * (k / n);
      this.push(fy, 0, 1);
    }
    return this;
  }

  /** Turns through `dh` rad (positive to the heading's left) on a circle of radius `r`, level, leaning into it. */
  turn(dh: number, r: number): this {
    const side = Math.sign(dh);
    const cx = this.x + side * r * Math.cos(this.h);
    const cz = this.z - side * r * Math.sin(this.h);
    const h0 = this.h;
    const len = Math.abs(dh) * r;
    const n = Math.max(1, Math.round(len / STEP));
    const lean = Math.min(MAX_BANK, Math.atan((this.speed * this.speed) / (r * G)));
    for (let k = 1; k <= n; k++) {
      this.h = h0 + (dh * k) / n;
      this.x = cx - side * r * Math.cos(this.h);
      this.z = cz + side * r * Math.sin(this.h);
      const run = (k / n) * len;
      this.push(0, lean * smoothstep(0, BANK_RAMP, run) * smoothstep(0, BANK_RAMP, len - run), side);
    }
    return this;
  }

  /** A loop of radius `r` in the vertical plane of the heading, from level flight back to it; the up is to the circle's middle. */
  loop(r: number): this {
    const x0 = this.x;
    const z0 = this.z;
    const y0 = this.y;
    const dx = Math.sin(this.h);
    const dz = Math.cos(this.h);
    const n = Math.round((Math.PI * 2 * r) / STEP);
    for (let k = 1; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      this.x = x0 + dx * r * Math.sin(a);
      this.z = z0 + dz * r * Math.sin(a);
      this.y = y0 + r * (1 - Math.cos(a));
      this.out.push(this.x, this.y, this.z, dx * Math.cos(a), Math.sin(a), dz * Math.cos(a), -dx * Math.sin(a), Math.cos(a), -dz * Math.sin(a));
    }
    return this;
  }

  build(flag: (x: number, y: number, z: number) => boolean): FlightPath {
    return new FlightPath(new Float32Array(this.out), flag);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The crop-duster

export const BIPLANE_SPEED = 34;
/** Seconds of sim time between one sortie's start and the next's; a sortie flies 60 to 70 s of it. */
export const SORTIE_PERIOD = 120;
/** The hours a sortie may begin in: one that has begun flies to its end, past 17:30 (it is not out in rain). */
export const DUSTER_HOURS = { from: 7.5, to: 17.5 } as const;
/** The height (m) of the lowest pass over the ground, and of the highest ground structure it must clear (the grain elevator). */
export const PASS_ALT = 8;
/** Over crops lower than this above the ground it sprays. */
const SPRAY_ALT = 14;

/** A run: three passes along rows at `lanes` (z) between `xW` and `xE`, in from the east, and out west. */
interface DustRun {
  name: string;
  xW: number;
  xE: number;
  lanes: readonly number[];
  /** Pulls up into a loop at the end of the last pass (Halfmoon Acres'). */
  loop: boolean;
}

export const DUST_RUNS: readonly DustRun[] = [
  { name: 'Halfmoon Acres', xW: -1160, xE: -985, lanes: [110, 170, 230], loop: true },
  { name: 'Cud & Sons Dairy', xW: -1060, xE: -880, lanes: [-150, -90, -30], loop: false },
];

/** The runs' paths, each flagging its samples that sweep over a field low enough to spray it. */
export function dustPaths(world: StaticWorld): FlightPath[] {
  const fields = world.layout.country.farms.fields.map((f) => f.rect);
  const flag = (x: number, y: number, z: number) => y - world.groundHeight(x, z) < SPRAY_ALT && fields.some((r) => rectContains(r, x, z));
  return DUST_RUNS.map((run) => {
    const t = new Turtle(run.xE + 330, 55, run.lanes[0]!, -Math.PI / 2, BIPLANE_SPEED);
    t.line(330, PASS_ALT);
    for (let k = 0; k < run.lanes.length; k++) {
      t.line(run.xE - run.xW, PASS_ALT);
      if (k < run.lanes.length - 1) t.turn((k % 2 === 0 ? 1 : -1) * Math.PI, (run.lanes[k + 1]! - run.lanes[k]!) / 2);
    }
    if (run.loop) t.line(60, 18).loop(32);
    t.line(run.loop ? 420 : 560, 70);
    return t.build(flag);
  });
}

/**
 * The biplane at sim time `time` (and the clock's `hours`): its pose into `out`, or false when it is not out (in the
 * hangar between sorties, in a sortie that began at night, in the rain). A sortie is out or not by the hour it began, so
 * none is cut short at 17:30 or switched on part-way through at 07:30; that hour is reckoned at the clock's default
 * rate, so at another rate it drifts within a sortie.
 */
export function biplaneAt(paths: readonly FlightPath[], time: number, hours: number, fair: boolean, out: Pose): boolean {
  const n = Math.floor(time / SORTIE_PERIOD);
  const into = time - n * SORTIE_PERIOD;
  const began = hours - into / SECONDS_PER_HOUR;
  if (!fair || began < DUSTER_HOURS.from || began >= DUSTER_HOURS.to) return false;
  const path = paths[n % paths.length]!;
  const s = into * BIPLANE_SPEED;
  if (s > path.length) return false;
  path.sample(s, BIPLANE_SPEED, out);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// The combine

/** The working day: its circuit from the first lane at 07:00 to the last at 17:30, standing at the start and the end outside it. */
export const COMBINE_DAY = { from: 7, to: 17.5 } as const;
/** Metres between its lanes, and what it keeps off the field's edge (its headland turns reach 5.5 m past the lanes' ends). */
const LANE = 11;
const HEADLAND = 12;

export interface Combine {
  x: number;
  z: number;
  /** Heading (rad, along (sin, cos)). */
  heading: number;
  /** In its working day. */
  working: boolean;
  /** Its speed (m/s) at the clock's default rate. */
  speed: number;
}

/** The combine's circuit of the wheat field `field` (rows along x): lanes west and east, a headland turn between. */
export function combinePath(field: Rect): FlightPath {
  const xW = field.minX + HEADLAND;
  const xE = field.maxX - HEADLAND;
  const z0 = field.minZ + HEADLAND;
  const lanes = Math.floor((field.maxZ - field.minZ - 2 * HEADLAND) / LANE) + 1;
  const t = new Turtle(xE, 0, z0, -Math.PI / 2, 0);
  for (let k = 0; k < lanes; k++) {
    t.line(xE - xW, 0);
    if (k < lanes - 1) t.turn((k % 2 === 0 ? 1 : -1) * Math.PI, LANE / 2);
  }
  return t.build(() => false);
}

const combinePose = newPose();

/** The combine on its circuit at this hour of the day, into `out`: the circuit takes the whole working day. */
export function combineAt(path: FlightPath, hours: number, out: Combine): void {
  const day = COMBINE_DAY.to - COMBINE_DAY.from;
  out.speed = path.length / (day * SECONDS_PER_HOUR);
  path.sample(path.length * clamp((hours - COMBINE_DAY.from) / day, 0, 1), out.speed, combinePose);
  out.x = combinePose.x;
  out.z = combinePose.z;
  out.heading = Math.atan2(combinePose.fx, combinePose.fz);
  out.working = hours >= COMBINE_DAY.from && hours < COMBINE_DAY.to;
}

// ---------------------------------------------------------------------------------------------------------------------
// The balloon

/** Its day: swelling from `from`, lifting at `lift`, setting down at `land`, folded away by `to` (hours). */
export const BALLOON_DAY = { from: 5.5, lift: 5.75, land: 8.25, to: 8.5 } as const;
/** The meadow it rises from and the one it sets down in (x, z), and its height over the ground at the top of its drift. */
export const BALLOON_MEADOWS = { from: { x: -1150, z: -215 }, to: { x: -1235, z: 150 } } as const;
const BALLOON_CEILING = 105;

export interface Balloon {
  x: number;
  y: number;
  z: number;
  /** The envelope's yaw (rad): it turns slowly as it drifts. */
  yaw: number;
  /** How full the envelope is, 0 (laid out) to 1; the balloon is not drawn below BALLOON_MIN. */
  fill: number;
  /** Its height over the ground under it. */
  height: number;
  /** Heading of the drift (rad) and its speed (m/s). */
  heading: number;
  speed: number;
}

export const BALLOON_MIN = 0.03;

/** The balloon at this hour: false before 05:30 and from 08:30 on, and when it rains. */
export function balloonAt(world: StaticWorld, hours: number, fair: boolean, out: Balloon): boolean {
  const d = BALLOON_DAY;
  out.fill = smoothstep(d.from, d.lift, hours) * (1 - smoothstep(d.land, d.to, hours));
  if (!fair || hours < d.from || hours >= d.to || out.fill < BALLOON_MIN) return false;
  const tau = clamp((hours - d.lift) / (d.land - d.lift), 0, 1);
  // Slow off the meadow and into the next, a little faster between; a long S sideways as the breeze veers.
  const along = 0.55 * tau + 0.45 * smoothstep(0, 1, tau);
  const { from, to } = BALLOON_MEADOWS;
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  const sway = Math.sin(tau * Math.PI * 2) * 22 * Math.sin(tau * Math.PI);
  out.x = lerp(from.x, to.x, along) + ((to.z - from.z) / len) * sway;
  out.z = lerp(from.z, to.z, along) - ((to.x - from.x) / len) * sway;
  const up = smoothstep(0, 0.2, tau) * (1 - smoothstep(0.8, 1, tau));
  out.height = (BALLOON_CEILING + 3 * Math.sin(hours * 40)) * up;
  out.y = world.groundHeight(out.x, out.z) + out.height;
  out.yaw = (hours - d.lift) * 0.9;
  out.heading = Math.atan2(to.x - from.x, to.z - from.z);
  out.speed = tau > 0 && tau < 1 ? (len / ((d.land - d.lift) * SECONDS_PER_HOUR)) * (0.55 + 0.45 * 6 * tau * (1 - tau)) : 0;
  return true;
}

/** Seconds between the burner's turns; a flare lasts FLARE_LEN of them (the swelling's, longer, FILL_LEN). */
const FLARE_PERIOD = 11;
const FLARE_LEN = 2.6;
const FILL_LEN = 6.5;

/**
 * How hard the burner roars at sim time `time` (0 off, up to 1): every turn while the envelope swells and the balloon
 * climbs, a few of the turns on the way, none once it is down.
 */
export function burnerAt(time: number, hours: number, fill: number): number {
  const d = BALLOON_DAY;
  if (hours >= d.land) return 0;
  const k = Math.floor(time / FLARE_PERIOD);
  const swelling = hours < d.lift + 0.25;
  if (!swelling && hashInts(k, 4007) % 100 >= 38) return 0;
  const run = time - k * FLARE_PERIOD;
  const len = swelling ? FILL_LEN : FLARE_LEN;
  if (run >= len) return 0;
  return smoothstep(0, 0.25, run) * (1 - smoothstep(len - 0.7, len, run)) * clamp(fill * 2, 0, 1);
}
