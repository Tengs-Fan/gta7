// Weather: a pure schedule per world seed (eight three-hour slots a day), debug and cheat overrides, and lightning in
// storms. Visual only: nothing in the simulation reads it. It never draws from sim.rng, so every seeded behaviour stays
// as it was; the schedule is a stateless hash of (seed, day, slot), so a save (which keeps day and hour) restores it.

import type { Emitter } from '../core/emitter';
import { clamp01, lerp, smoothstep, type V3 } from '../core/math';
import type { GameClock } from './clock';
import type { SimEvents } from './events';

export type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm';
export type WeatherMode = 'dynamic' | 'clear';

export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'cloudy', 'overcast', 'rain', 'storm'];

export interface WeatherState {
  /** The dominant kind right now. */
  kind: WeatherKind;
  /** 0..1 extra cloud cover. */
  cloud: number;
  /** 0..1 rain intensity. */
  rain: number;
  /** 0..1 storm strength (lightning, wind, sea). */
  storm: number;
  /** 0..1 ground wetness: follows the rain up and dries over a couple of game hours. */
  wet: number;
  /** 0..1 how dark the weather makes the sky; cars switch their lights on from about 0.35. */
  dim: number;
  /** 0..1 extra haze. */
  fog: number;
  /** m/s, for rain slant and cloud drift. */
  wind: { x: number; z: number };
  /** 0..1 wave amplitude scale (0.3 calm). */
  seaState: number;
}

/** What the schedule holds from a moment on: the kind of its slot, the next change today (null: none), and tomorrow's at midday. */
export interface Forecast {
  now: WeatherKind;
  next: { kind: WeatherKind; startHours: number } | null;
  tomorrow: WeatherKind;
}

/** The numeric fields a debug override may set. */
export type WeatherFields = Partial<Omit<WeatherState, 'kind' | 'wind'>> & { wind?: { x: number; z: number } };

interface Target {
  cloud: number;
  rain: number;
  storm: number;
  fog: number;
  windSpeed: number;
}

const TARGETS: Readonly<Record<WeatherKind, Target>> = {
  clear: { cloud: 0, rain: 0, storm: 0, fog: 0, windSpeed: 2 },
  cloudy: { cloud: 0.45, rain: 0, storm: 0, fog: 0.08, windSpeed: 3.5 },
  overcast: { cloud: 0.9, rain: 0, storm: 0, fog: 0.25, windSpeed: 5 },
  rain: { cloud: 1, rain: 1, storm: 0, fog: 0.8, windSpeed: 6 },
  storm: { cloud: 1, rain: 1, storm: 1, fog: 1, windSpeed: 12 },
};

/** Share of slots per kind, in percent (before the storm and clearing rules below). */
const WEIGHTS: ReadonlyArray<readonly [WeatherKind, number]> = [
  ['clear', 45],
  ['cloudy', 25],
  ['overcast', 12],
  ['rain', 12],
  ['storm', 6],
];

export const SLOT_HOURS = 3;
const SLOTS_PER_DAY = 24 / SLOT_HOURS;
/** Each change of weather ramps over this many game hours from the start of its slot. */
export const RAMP_HOURS = 0.75;
/** Game hours for the ground to dry to 1/e. */
const DRY_HOURS = 1.5;
/** Wetness looks back this far (game hours) in steps of WET_STEP: exp(-LOOK_BACK / DRY_HOURS) is negligible. */
const LOOK_BACK = 7.5;
const WET_STEP = 1 / 6;
/** Real seconds of the default ramp of an override or a mode change. */
export const DEFAULT_RAMP = 20;
/** Lightning buckets per game hour (one every quarter game minute). */
const STRIKE_BUCKETS = 240;
/** Chance per bucket of a strike in a full storm. */
const STRIKE_P = 0.06;
const STRIKE_MIN = 300;
const STRIKE_MAX = 1500;

const SALT_KIND = 0x1b873593;
const SALT_WIND = 0x2c1b3c6d;
const SALT_STRIKE = 0x297a2d39;
const SALT_X = 0x68e31da4;
const SALT_D = 0x5bd1e995;
const SALT_STORM = 0x7feb352d;
const STORM_GROWTH = 0.3;

/** 32-bit hash of three integers and a salt (murmur3's finaliser), as a float in [0, 1). */
export function weatherHash(seed: number, a: number, b: number, salt: number): number {
  let h = (seed | 0) ^ salt;
  h = Math.imul(h ^ Math.imul(a | 0, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35), 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The kind the hash picks for a global slot (day * 8 + slot), before the rules. Day 1 (and before) is clear. */
function rawKind(seed: number, g: number): WeatherKind {
  const day = Math.floor(g / SLOTS_PER_DAY);
  if (day <= 1) return 'clear';
  let r = weatherHash(seed, day, g - day * SLOTS_PER_DAY, SALT_KIND) * 100;
  for (const [k, w] of WEIGHTS) {
    r -= w;
    if (r < 0) return k;
  }
  return 'clear';
}

const wetKind = (k: WeatherKind): boolean => k === 'rain' || k === 'storm';

/**
 * The kind of a global slot: a storm comes only out of rain or overcast (else it is rain), and rain clears through
 * cloud (a clear slot right after rain is cloudy). Both rules look at the previous slot's raw kind only, which the
 * rules never turn into or out of rain, overcast or storm, so this needs no recursion.
 */
export function slotKind(seed: number, g: number): WeatherKind {
  const raw = rawKind(seed, g);
  if (raw === 'cloudy' || raw === 'overcast') return raw;
  const prev = rawKind(seed, g - 1);
  const stormy = prev === 'overcast' || wetKind(prev);
  if (raw === 'storm') return stormy ? 'storm' : 'rain';
  // Most raw storms are demoted by the rule above: rain that builds on rain or overcast may grow into one instead.
  if (raw === 'rain') return stormy && weatherHash(seed, g, 0, SALT_STORM) < STORM_GROWTH ? 'storm' : 'rain';
  return wetKind(prev) ? 'cloudy' : 'clear';
}

/** Hours since the start of day 0: one continuous time line for the schedule. */
const timeline = (day: number, hours: number): number => day * 24 + hours;

/** Blend of the slot at time T with the one before it (the ramp at the slot's start). */
function blendAt(seed: number, T: number): { a: WeatherKind; b: WeatherKind; w: number } {
  const g = Math.floor(T / SLOT_HOURS);
  const u = T - g * SLOT_HOURS;
  const b = slotKind(seed, g);
  if (u >= RAMP_HOURS) return { a: b, b, w: 1 };
  return { a: slotKind(seed, g - 1), b, w: smoothstep(0, RAMP_HOURS, u) };
}

function rainAt(seed: number, T: number): number {
  const { a, b, w } = blendAt(seed, T);
  return lerp(TARGETS[a].rain, TARGETS[b].rain, w);
}

/**
 * Ground wetness: the strongest of the rain now and every earlier rain dried by exp(-age / DRY_HOURS), sampled on a
 * grid anchored to the time line (so each term moves continuously with T).
 */
function wetAt(seed: number, T: number): number {
  let wet = rainAt(seed, T);
  const start = Math.floor(T / WET_STEP) * WET_STEP;
  for (let t = start; t > T - LOOK_BACK; t -= WET_STEP) {
    const r = rainAt(seed, t);
    if (r > wet) wet = Math.max(wet, r * Math.exp(-(T - t) / DRY_HOURS));
  }
  return clamp01(wet);
}

/** Wind direction: a per-seed prevailing heading that swings slowly over the days. */
function windAngle(seed: number, T: number): number {
  const base = weatherHash(seed, 0, 0, SALT_WIND) * Math.PI * 2;
  return base + 0.8 * Math.sin((T / 41) * Math.PI * 2) + 0.3 * Math.sin((T / 13) * Math.PI * 2);
}

export function clearWeather(): WeatherState {
  return { kind: 'clear', cloud: 0, rain: 0, storm: 0, wet: 0, dim: 0, fog: 0, wind: { x: 0, z: 0 }, seaState: 0.3 };
}

/** The darkness and sea of a state follow from its cloud, rain and storm. */
function derive(s: WeatherState): void {
  s.dim = Math.max(0.5 * s.cloud, 0.65 * s.rain, 0.85 * s.storm);
  s.seaState = 0.3 + 0.7 * s.storm;
}

function fillFrom(out: WeatherState, a: WeatherKind, b: WeatherKind, w: number, angle: number): WeatherState {
  const ta = TARGETS[a];
  const tb = TARGETS[b];
  out.kind = w < 0.5 ? a : b;
  out.cloud = lerp(ta.cloud, tb.cloud, w);
  out.rain = lerp(ta.rain, tb.rain, w);
  out.storm = lerp(ta.storm, tb.storm, w);
  out.fog = lerp(ta.fog, tb.fog, w);
  const speed = lerp(ta.windSpeed, tb.windSpeed, w);
  out.wind.x = Math.sin(angle) * speed;
  out.wind.z = Math.cos(angle) * speed;
  derive(out);
  return out;
}

/** Pure: the scheduled weather for a world seed at a game day and hour. */
export function scheduledWeather(seed: number, day: number, hours: number, out: WeatherState = clearWeather()): WeatherState {
  const T = timeline(day, hours);
  const { a, b, w } = blendAt(seed, T);
  fillFrom(out, a, b, w, windAngle(seed, T));
  out.wet = wetAt(seed, T);
  return out;
}

/** The steady weather of one kind (wind from the schedule's heading at T). */
function kindWeather(kind: WeatherKind, seed: number, T: number, out: WeatherState): WeatherState {
  return fillFrom(out, kind, kind, 1, windAngle(seed, T));
}

function copyState(dst: WeatherState, src: Readonly<WeatherState>): WeatherState {
  dst.kind = src.kind;
  dst.cloud = src.cloud;
  dst.rain = src.rain;
  dst.storm = src.storm;
  dst.wet = src.wet;
  dst.dim = src.dim;
  dst.fog = src.fog;
  dst.wind.x = src.wind.x;
  dst.wind.z = src.wind.z;
  dst.seaState = src.seaState;
  return dst;
}

export class WeatherSystem {
  readonly state: WeatherState = clearWeather();
  private modeNow: WeatherMode;
  private overrideKind: WeatherKind | null = null;
  private fields: WeatherFields | null = null;
  /** The state a ramp started from, or null when there is no ramp. */
  private from: WeatherState | null = null;
  private rampT = 0;
  private rampLen = 0;
  private started = false;
  private lastBucket = Number.NaN;
  private readonly target = clearWeather();
  private readonly lastPlayer = { x: 0, z: 0 };

  constructor(readonly seed: number, mode: WeatherMode = 'clear') {
    this.modeNow = mode;
  }

  /** 'clear' ramps to clear weather and holds it; 'dynamic' follows the schedule. */
  get mode(): WeatherMode {
    return this.modeNow;
  }

  set mode(m: WeatherMode) {
    if (m === this.modeNow) return;
    this.modeNow = m;
    this.startRamp(DEFAULT_RAMP);
  }

  /** The kind forced by a cheat or debug hook, or null when the weather follows the mode. */
  get overridden(): WeatherKind | null {
    return this.overrideKind;
  }

  /** Forces a kind (null: back to the mode / schedule), ramping over `rampSeconds` real seconds (0: at once). */
  override(kind: WeatherKind | null, rampSeconds = DEFAULT_RAMP): void {
    if (kind === null) this.fields = null;
    this.overrideKind = kind;
    this.startRamp(rampSeconds);
  }

  /** Debug: pins single fields (on top of whatever the weather is); null releases them. */
  setFields(fields: WeatherFields | null): void {
    this.fields = fields ? { ...this.fields, ...fields } : null;
  }

  private startRamp(seconds: number): void {
    if (!this.started) return;
    this.from = seconds > 0 ? copyState(this.from ?? clearWeather(), this.state) : null;
    this.rampT = 0;
    this.rampLen = seconds;
  }

  /** Whether the weather is integrated over time (an override or the clear mode) rather than read from the schedule. */
  private get held(): boolean {
    return this.overrideKind !== null || this.modeNow === 'clear';
  }

  /**
   * The schedule's forecast at `hours` of `day` (pure: the slots of the time line): the next change is the first later
   * slot today of another kind. Null while the weather is held, which no schedule foretells.
   */
  forecast(day: number, hours: number): Forecast | null {
    if (this.held) return null;
    const g = Math.floor(timeline(day, hours) / SLOT_HOURS);
    const now = slotKind(this.seed, g);
    let next: Forecast['next'] = null;
    for (let k = g + 1; k < (day + 1) * SLOTS_PER_DAY && !next; k++) {
      const kind = slotKind(this.seed, k);
      if (kind !== now) next = { kind, startHours: (k - day * SLOTS_PER_DAY) * SLOT_HOURS };
    }
    return { now, next, tomorrow: slotKind(this.seed, (day + 1) * SLOTS_PER_DAY + 12 / SLOT_HOURS) };
  }

  update(dt: number, clock: GameClock, events: Emitter<SimEvents>, player: V3): void {
    this.lastPlayer.x = player.x;
    this.lastPlayer.z = player.z;
    const T = timeline(clock.day, clock.hours);
    const tgt = this.target;
    if (this.overrideKind !== null) kindWeather(this.overrideKind, this.seed, T, tgt);
    else if (this.modeNow === 'clear') kindWeather('clear', this.seed, T, tgt);
    else scheduledWeather(this.seed, clock.day, clock.hours, tgt);
    const s = this.state;
    const prevWet = s.wet;
    if (!this.started) {
      this.started = true;
      copyState(s, tgt);
      if (this.held) s.wet = tgt.rain;
    } else if (this.from) {
      this.rampT += dt;
      const w = smoothstep(0, 1, this.rampT / this.rampLen);
      const f = this.from;
      s.kind = w < 0.5 ? f.kind : tgt.kind;
      s.cloud = lerp(f.cloud, tgt.cloud, w);
      s.rain = lerp(f.rain, tgt.rain, w);
      s.storm = lerp(f.storm, tgt.storm, w);
      s.fog = lerp(f.fog, tgt.fog, w);
      s.wind.x = lerp(f.wind.x, tgt.wind.x, w);
      s.wind.z = lerp(f.wind.z, tgt.wind.z, w);
      derive(s);
      s.wet = this.held ? this.dried(prevWet, s.rain, dt, clock) : lerp(f.wet, tgt.wet, w);
      if (w >= 1) this.from = null;
    } else {
      copyState(s, tgt);
      if (this.held) s.wet = this.dried(prevWet, s.rain, dt, clock);
    }
    this.applyFields();
    this.lightning(clock, events);
  }

  /** Stateful wetness while held: up with the rain at once, drying as the schedule's does. */
  private dried(wet: number, rain: number, dt: number, clock: GameClock): number {
    return clamp01(Math.max(rain, wet * Math.exp(-(dt * clock.rate) / DRY_HOURS)));
  }

  private applyFields(): void {
    const f = this.fields;
    if (!f) return;
    const s = this.state;
    for (const k of ['cloud', 'rain', 'storm', 'wet', 'fog'] as const) if (f[k] !== undefined) s[k] = clamp01(f[k]);
    if (f.wind) {
      s.wind.x = f.wind.x;
      s.wind.z = f.wind.z;
    }
    derive(s);
    if (f.dim !== undefined) s.dim = clamp01(f.dim);
    if (f.seaState !== undefined) s.seaState = clamp01(f.seaState);
  }

  /** One possible strike per quarter game minute crossed this frame, while the weather is a storm. */
  private lightning(clock: GameClock, events: Emitter<SimEvents>): void {
    const bucket = Math.floor(clock.hours * STRIKE_BUCKETS);
    const id = clock.day * 24 * STRIKE_BUCKETS + bucket;
    const last = this.lastBucket;
    this.lastBucket = id;
    // A jump of the clock (setTime, a load, a sped-up clock) strikes nothing for the time skipped.
    if (!(id > last) || id - last > 16) return;
    if (this.state.kind !== 'storm') return;
    const p = STRIKE_P * this.state.storm;
    for (let b = last + 1; b <= id; b++) {
      const day = Math.floor(b / (24 * STRIKE_BUCKETS));
      const k = b - day * 24 * STRIKE_BUCKETS;
      if (weatherHash(this.seed, day, k, SALT_STRIKE) >= p) continue;
      const a = weatherHash(this.seed, day, k, SALT_X) * Math.PI * 2;
      const d = STRIKE_MIN + (STRIKE_MAX - STRIKE_MIN) * weatherHash(this.seed, day, k, SALT_D);
      events.emit('lightning', { x: this.lastPlayer.x + Math.sin(a) * d, z: this.lastPlayer.z + Math.cos(a) * d, dist: d });
    }
  }

  /** Forces one strike: at (x, z), or at a hashed spot 300-1500 m from the player. */
  strike(events: Emitter<SimEvents>, player: V3, x?: number, z?: number, salt = 0): void {
    let sx = x;
    let sz = z;
    if (sx === undefined || sz === undefined) {
      const a = weatherHash(this.seed, salt, 1, SALT_X) * Math.PI * 2;
      const d = STRIKE_MIN + (STRIKE_MAX - STRIKE_MIN) * weatherHash(this.seed, salt, 1, SALT_D);
      sx = player.x + Math.sin(a) * d;
      sz = player.z + Math.cos(a) * d;
    }
    events.emit('lightning', { x: sx, z: sz, dist: Math.hypot(sx - player.x, sz - player.z) });
  }
}
