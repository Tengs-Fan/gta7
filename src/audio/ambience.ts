// The ambience bed: city hum, traffic wash, wind, surf and crowd murmur as looping layers,
// plus rate-limited one-shots (birds, gulls, crickets, far horns, dogs, a distant siren),
// and the cemetery chapel's bell, tolling twelve at noon and at midnight.
// The layers are a fixed set of about two dozen nodes.
// Their loops are generated procedurally (no files), one per frame after start-up,
// and only their gains, filters and pans move afterwards.
//
//   brown loop -> low-pass ------------------> hum -----------+
//   pink loop  -> band-pass -> traffic -> pan ----------------+
//   pink loop  -> swept band-pass -> gust -> wind ------------+-> out -> in-car low-pass -> ambBus
//   surf loop  -> low-pass -> surf -> pan --------------------+
//   murmur loop ------------------------> murmur -------------+
//   one-shots -> pan -----------------------------------------+

import { clamp, smoothstep } from '../core/math';
import { WATER_Y } from '../world/constants';
import { beachOffsetAt, type Bounds, type District, type Rect } from '../world/layout';
import { Glider, OPEN_HZ, dbToGain, withinParam } from './mixer';

export type AmbienceDistrict = District | 'beach' | 'sea';

export interface AmbienceInput {
  district: AmbienceDistrict;
  /** Hours since midnight. */
  hours: number;
  /** Metres to the nearest shore that makes surf (sea walls count as farther away than the beach). */
  shoreDist: number;
  /** Listener height in metres (roofs and the title flyover are windy). */
  height: number;
  /** 0..1: moving traffic within 120 m, speed-weighted. */
  traffic: number;
  inVehicle: boolean;
  /** Wanted level: the rare distant siren only plays at 0 stars. */
  wanted?: number;
}

export interface AmbienceLevels {
  cityHum: number;
  trafficWash: number;
  wind: number;
  surf: number;
  murmur: number;
  /** One-shot densities, 0..1. */
  birds: number;
  gulls: number;
  crickets: number;
  dogs: number;
  horns: number;
  siren: number;
}

interface DistrictMood {
  hum: number;
  murmur: number;
  birds: number;
  crickets: number;
  gulls: number;
  dogs: number;
  horns: number;
  wind: number;
}

const MOOD: Readonly<Record<AmbienceDistrict, DistrictMood>> = {
  downtown: { hum: 0.85, murmur: 0.8, birds: 0.05, crickets: 0, gulls: 0, dogs: 0, horns: 1, wind: 0.1 },
  midtown: { hum: 0.7, murmur: 0.6, birds: 0.12, crickets: 0.05, gulls: 0, dogs: 0.05, horns: 0.8, wind: 0.1 },
  southgate: { hum: 0.6, murmur: 0.4, birds: 0.15, crickets: 0.15, gulls: 0.05, dogs: 0.15, horns: 0.6, wind: 0.12 },
  beachfront: { hum: 0.5, murmur: 0.45, birds: 0.1, crickets: 0.05, gulls: 0.5, dogs: 0, horns: 0.5, wind: 0.25 },
  docks: { hum: 0.55, murmur: 0.1, birds: 0, crickets: 0, gulls: 0.8, dogs: 0.1, horns: 0.3, wind: 0.3 },
  westside: { hum: 0.45, murmur: 0.2, birds: 0.35, crickets: 0.75, gulls: 0, dogs: 0.6, horns: 0.4, wind: 0.15 },
  hillcrest: { hum: 0.42, murmur: 0.1, birds: 0.9, crickets: 0.8, gulls: 0, dogs: 0.7, horns: 0.3, wind: 0.2 },
  park: { hum: 0.45, murmur: 0.25, birds: 1, crickets: 1, gulls: 0, dogs: 0.2, horns: 0.2, wind: 0.15 },
  country: { hum: 0.03, murmur: 0, birds: 1, crickets: 1, gulls: 0.1, dogs: 0.4, horns: 0, wind: 0.45 },
  beach: { hum: 0.15, murmur: 0.15, birds: 0, crickets: 0, gulls: 1, dogs: 0, horns: 0.1, wind: 0.5 },
  sea: { hum: 0.05, murmur: 0, birds: 0, crickets: 0, gulls: 0.8, dogs: 0, horns: 0, wind: 0.7 },
};

/** 1 inside [from, to) hours (wrapping midnight), easing in and out over `ease` hours inside the window. */
function timeWindow(h: number, from: number, to: number, ease: number): number {
  const len = (to - from + 24) % 24;
  const u = (h - from + 24) % 24;
  if (!(u < len)) return 0;
  return clamp(Math.min(u, len - u) / ease, 0, 1);
}

/** Sea walls (the west, north and south coasts) lap rather than break: they count this much farther away than the beach. */
const SEAWALL_EXTRA = 60;

export interface ShoreInfo {
  /** Metres to the shore that makes surf (0 over water). */
  dist: number;
  /** Unit direction toward it (0, 0 over water). */
  dirX: number;
  dirZ: number;
}

/**
 * The nearest surf for a listener at (x, z): the east beach's waterline, or a sea wall 60 m "farther", the walls round
 * the water cut into the city (`water`: the cove, the basin, the canal) included. Pure.
 */
export function shoreInfo(b: Bounds, x: number, z: number, out?: ShoreInfo, water: readonly Rect[] = []): ShoreInfo {
  const o = out ?? ({} as ShoreInfo);
  const waterX = b.beachStartX + beachOffsetAt(WATER_Y);
  if (!(x >= b.landMinX && x <= waterX && z >= b.landMinZ && z <= b.landMaxZ)) {
    o.dist = 0;
    o.dirX = 0;
    o.dirZ = 0;
    return o;
  }
  o.dist = waterX - x;
  o.dirX = 1;
  o.dirZ = 0;
  const west = x - b.landMinX + SEAWALL_EXTRA;
  const north = z - b.landMinZ + SEAWALL_EXTRA;
  const south = b.landMaxZ - z + SEAWALL_EXTRA;
  if (west < o.dist) {
    o.dist = west;
    o.dirX = -1;
  }
  if (north < o.dist) {
    o.dist = north;
    o.dirX = 0;
    o.dirZ = -1;
  }
  if (south < o.dist) {
    o.dist = south;
    o.dirX = 0;
    o.dirZ = 1;
  }
  for (const r of water) {
    const dx = x < r.minX ? r.minX - x : x > r.maxX ? r.maxX - x : 0;
    const dz = z < r.minZ ? r.minZ - z : z > r.maxZ ? r.maxZ - z : 0;
    const d = Math.hypot(dx, dz);
    if (d === 0) {
      o.dist = 0;
      o.dirX = 0;
      o.dirZ = 0;
      return o;
    }
    if (d + SEAWALL_EXTRA < o.dist) {
      o.dist = d + SEAWALL_EXTRA;
      o.dirX = dx / d;
      o.dirZ = dz / d;
    }
  }
  return o;
}

/** In a car the outside world is 8 dB down (and goes through a 900 Hz low-pass). */
export const IN_CAR = dbToGain(-8);

/** Layer gains (0..1) and one-shot densities for a place and time. Pure. */
export function ambienceTargets(i: AmbienceInput, out?: AmbienceLevels): AmbienceLevels {
  const o = out ?? ({} as AmbienceLevels);
  const m = MOOD[i.district] ?? MOOD.midtown;
  const h = Number.isFinite(i.hours) ? ((i.hours % 24) + 24) % 24 : 12;
  // Same curve as GameClock.daylight: 1 at noon, 0 at night.
  const day = clamp(smoothstep(5, 7.2, h) * (1 - smoothstep(18.2, 20.3, h)), 0, 1);
  const birdsTime = timeWindow(h, 6, 19, 0.5);
  const cricketsTime = timeWindow(h, 21, 5, 0.5);
  const shore = Number.isFinite(i.shoreDist) ? Math.max(0, i.shoreDist) : 1e4;
  const height = Number.isFinite(i.height) ? i.height : 0;
  const traffic = Number.isFinite(i.traffic) ? clamp(i.traffic, 0, 1) : 0;
  const k = i.inVehicle ? IN_CAR : 1;
  // Street life fades with height (rooftops keep some of it, the title flyover little).
  const street = 1 - 0.8 * smoothstep(15, 70, height);
  o.cityHum = k * m.hum * (0.72 + 0.28 * day);
  o.trafficWash = k * traffic;
  o.wind = k * clamp(m.wind + 0.75 * smoothstep(8, 45, height), 0, 1);
  o.surf = k * Math.pow(clamp(1 - (shore - 15) / 165, 0, 1), 1.4);
  o.murmur = k * street * m.murmur * day;
  o.birds = k * m.birds * birdsTime;
  o.gulls = k * m.gulls * (0.3 + 0.7 * day);
  o.crickets = k * street * m.crickets * cricketsTime;
  o.dogs = k * street * m.dogs * (0.5 + 0.5 * day);
  o.horns = k * m.horns * (0.25 + 0.75 * traffic) * (0.4 + 0.6 * day);
  o.siren = (i.wanted ?? 0) > 0 ? 0 : k * m.hum;
  return o;
}

/** Calibrated gain of each layer at level 1 (before the bus and master chain). */
const LAYER_GAIN = { cityHum: 0.09, trafficWash: 0.16, wind: 0.18, surf: 0.036, murmur: 0.05 };

/** Peak gain of each one-shot (scaled by a random distance). */
const ONE_SHOT_GAIN = { birds: 0.05, gulls: 0.05, crickets: 0.03, dogs: 0.05, horns: 0.03, siren: 0.022 };

/** One-shots per second at density 1. */
const ONE_SHOT_RATE = { birds: 0.45, gulls: 0.2, crickets: 1, dogs: 0.05, horns: 0.07, siren: 0.006 };

/** At most two ambience one-shots start per second. */
export const ONE_SHOT_GAP = 0.5;

type OneShot = keyof typeof ONE_SHOT_RATE;
const ONE_SHOTS = Object.keys(ONE_SHOT_RATE) as OneShot[];

interface ShotOut {
  node: AudioNode;
  level: number;
}

// ---------------------------------------------------------------------------
// Loop generation

/** Fills a stereo loop of `seconds` and crossfades its ends so it repeats without a click. */
function makeLoop(ctx: BaseAudioContext, seconds: number, rate: number, fill: (data: Float32Array, ch: number) => void): AudioBuffer {
  const len = Math.max(2, Math.round(seconds * rate));
  const fade = Math.min(Math.round(0.3 * rate), Math.floor(len / 4));
  const buf = ctx.createBuffer(2, len, rate);
  const tmp = new Float32Array(len + fade);
  for (let ch = 0; ch < 2; ch++) {
    fill(tmp, ch);
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = tmp[i]!;
    // The head becomes a crossfade from the tail's continuation into the head,
    // so the last sample flows into the first.
    for (let i = 0; i < fade; i++) {
      const a = (i + 0.5) / fade;
      d[i] = tmp[i]! * Math.sin((a * Math.PI) / 2) + tmp[len + i]! * Math.cos((a * Math.PI) / 2);
    }
  }
  return buf;
}

/** `want` if the context can make buffers at that rate, else its own rate. */
function supportedRate(ctx: BaseAudioContext, want: number): number {
  try {
    ctx.createBuffer(1, 1, want);
    return want;
  } catch {
    return ctx.sampleRate;
  }
}

function brownNoise(d: Float32Array, rnd: () => number): void {
  let b = 0;
  for (let i = 0; i < d.length; i++) {
    b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02;
    d[i] = b * 3.5;
  }
}

function pinkNoise(d: Float32Array, rnd: () => number): void {
  // Paul Kellet's economy pink filter.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
}

/** Waves on the beach: one swell per 12.5 s (0.08 Hz) - a rising rumble, the break, the hissing wash. */
function surfNoise(d: Float32Array, rate: number, period: number, rnd: () => number, phase: number): void {
  let lp = 0;
  let rumble = 0;
  // The envelope and the filter move slowly: work them out every 32 samples.
  const block = 32;
  for (let i0 = 0; i0 < d.length; i0 += block) {
    const u = (i0 / rate / period + phase) % 1;
    // Swell envelope: builds up to the break at 30 % of the cycle, then washes out.
    // Distant breakers never stop, so each swell rises out of a bed about 7 dB down.
    const env = u < 0.3 ? 0.45 + 0.55 * smoothstep(0, 0.3, u) ** 2 : 0.45 + 0.55 * Math.exp(-(u - 0.3) * 4.2);
    // The break is bright, the wash gets darker as it runs out.
    const cutoff = 900 + 2000 * (u < 0.3 ? smoothstep(0.15, 0.3, u) : Math.exp(-(u - 0.3) * 3));
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
    const end = Math.min(d.length, i0 + block);
    for (let i = i0; i < end; i++) {
      const w = rnd() * 2 - 1;
      lp += a * (w - lp);
      rumble = (rumble + 0.02 * w) / 1.02;
      d[i] = lp * 1.3 * env + rumble * 2.2 * (0.6 + 0.4 * env);
    }
  }
}

/** Distant crowd walla: a few pitched, formant-filtered voices with syllable envelopes. */
function murmurNoise(d: Float32Array, rate: number, rnd: () => number): void {
  d.fill(0);
  for (let v = 0; v < 3; v++) addVoice(d, rate, rnd, 95 + rnd() * 140, 0.5 + rnd() * 0.5);
}

/** One talker: a soft glottal triangle plus breath through two formant resonators retuned per syllable. */
function addVoice(d: Float32Array, rate: number, rnd: () => number, f0: number, level: number): void {
  const k = Math.exp((-Math.PI * 120) / rate);
  const k2 = Math.exp((-Math.PI * 180) / rate);
  let b11 = 0;
  let b12 = 0;
  let b21 = 0;
  let b22 = 0;
  let phase = rnd();
  let env = 0;
  // Samples left in the current syllable or pause.
  let syl = 0;
  let speaking = false;
  let target = 0;
  let y1a = 0;
  let y1b = 0;
  let y2a = 0;
  let y2b = 0;
  let inc = f0 / rate;
  const envK = 40 / rate;
  const gain = level * 0.65;
  for (let i = 0; i < d.length; i++) {
    if ((i & 63) === 0) inc = (f0 * (1 + 0.04 * Math.sin(i / rate))) / rate;
    if (syl <= 0) {
      speaking = !speaking || rnd() < 0.7;
      if (speaking) {
        syl = Math.round((0.09 + rnd() * 0.16) * rate);
        target = 0.6 + rnd() * 0.4;
        b11 = 2 * k * Math.cos((2 * Math.PI * (300 + rnd() * 500)) / rate);
        b12 = -k * k;
        b21 = 2 * k2 * Math.cos((2 * Math.PI * (900 + rnd() * 1300)) / rate);
        b22 = -k2 * k2;
      } else {
        syl = Math.round((rnd() < 0.15 ? 0.3 + rnd() * 0.5 : 0.03 + rnd() * 0.1) * rate);
        target = 0;
      }
    }
    syl--;
    env += (target - env) * envK;
    phase += inc;
    if (phase >= 1) phase -= 1;
    const src = (phase < 0.5 ? phase * 2 - 0.5 : 1.5 - phase * 2) * 0.7 + (rnd() * 2 - 1) * 0.3;
    const o1 = (1 - k) * src + b11 * y1a + b12 * y1b;
    y1b = y1a;
    y1a = o1;
    const o2 = (1 - k2) * src + b21 * y2a + b22 * y2b;
    y2b = y2a;
    y2a = o2;
    d[i] = d[i]! + (o1 + 0.6 * o2) * env * gain;
  }
}

// ---------------------------------------------------------------------------

interface Layer {
  level: GainNode;
  pan: StereoPannerNode | null;
}

export interface AmbienceFrame extends AmbienceInput {
  /** Pan (-1 left .. 1 right) toward the sea and toward the traffic. */
  seaPan: number;
  trafficPan: number;
  /** Metres to Eternal Palms Cemetery's bell tower and the pan toward it (none: no bell in earshot). */
  bell?: { dist: number; pan: number };
}

/** The chapel bell is heard within BELL_RANGE m: BELL_STRIKES strokes BELL_GAP s apart when the clock passes 0:00 or 12:00. */
export const BELL_RANGE = 500;
export const BELL_STRIKES = 12;
export const BELL_GAP = 2.6;
const BELL_GAIN = 0.07;
/** The bell's strike tone (Hz) and its partials: a church bell's hum, prime, minor third, fifth, nominal and the rest above, out of tune with one another. */
const BELL_HZ = 392;
const BELL_PARTIALS: ReadonlyArray<readonly [ratio: number, gain: number, decay: number]> = [
  [0.5, 0.55, 6], [1, 0.8, 4.5], [1.183, 0.45, 3.5], [1.506, 0.3, 2.8], [2, 0.5, 2.5], [2.514, 0.22, 1.8], [2.662, 0.2, 1.6], [3.011, 0.14, 1.3], [4.166, 0.1, 0.9],
];

/**
 * Whether the clock ran on past noon or midnight between two readings of its hours a frame apart (NaN: no earlier
 * reading). A jump (a new game, a load, a cheat setting the time) tolls nothing.
 */
export function bellTolls(prev: number, hours: number): boolean {
  const d = (hours - prev + 24) % 24;
  return d > 0 && d < 0.25 && Math.floor((prev + d) / 12) > Math.floor(prev / 12);
}

/** The whisper by the Bramble family crypt: within WHISPER_RANGE m of its door, from 03:00 to 03:15, once a night. */
export const WHISPER_RANGE = 6;
export const WHISPER_FROM = 3;
export const WHISPER_TO = 3.25;

export function whisperDue(hours: number, dist: number): boolean {
  return hours >= WHISPER_FROM && hours < WHISPER_TO && dist <= WHISPER_RANGE;
}

export class Ambience {
  /** Random source (tests replace it to make one-shots deterministic or silent). */
  random: () => number = Math.random;
  /** One-shots started so far (for tests). */
  oneShots = 0;
  readonly levels = {} as AmbienceLevels;
  private readonly out: GainNode;
  private readonly carFilter: BiquadFilterNode;
  private readonly hum: Layer;
  private readonly traffic: Layer;
  private readonly wind: Layer;
  private readonly surf: Layer;
  private readonly murmur: Layer;
  private readonly humFilter: BiquadFilterNode;
  private readonly trafficFilter: BiquadFilterNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly surfFilter: BiquadFilterNode;
  private readonly glide = new Glider();
  /** Loop generators still to run, one per update (spreads the start-up cost over frames). */
  private readonly pending: Array<() => void> = [];
  private lastOneShot = -Infinity;
  private surfDrift = 0;
  private surfSource: AudioBufferSourceNode | null = null;
  private readonly rate: number;
  /** The clock's hours at the last update (for the bell). */
  private lastHours = NaN;
  /** Bell tolls started so far (for tests). */
  tolls = 0;

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode) {
    const gain = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const filter = (type: BiquadFilterType, hz: number, q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = withinParam(f.frequency, hz);
      f.Q.value = q;
      return f;
    };
    const panner = () => (typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null);
    const layer = (withPan: boolean): Layer => {
      const level = gain(0);
      const pan = withPan ? panner() : null;
      if (pan) {
        level.connect(pan);
        pan.connect(this.out);
      } else level.connect(this.out);
      return { level, pan };
    };
    // Ambience textures need no more than ~8 kHz: a third of the rate keeps the loops small and quick to make.
    // Some older browsers refuse buffers below 22.05 kHz; they get loops at the context's own rate.
    this.rate = supportedRate(ctx, clamp(Math.round(ctx.sampleRate / 3), 8000, 16000));
    this.out = gain(1);
    this.carFilter = filter('lowpass', OPEN_HZ, Math.SQRT1_2);
    this.out.connect(this.carFilter);
    this.carFilter.connect(dest);
    this.hum = layer(false);
    this.traffic = layer(true);
    this.wind = layer(false);
    this.surf = layer(true);
    this.murmur = layer(false);
    this.humFilter = filter('lowpass', 200, 0.7);
    this.humFilter.connect(this.hum.level);
    this.trafficFilter = filter('bandpass', 650, 0.55);
    this.trafficFilter.connect(this.traffic.level);
    this.windFilter = filter('bandpass', 700, 0.9);
    // Gusts: a slow LFO sweeps the wind band and swells its level.
    const gust = gain(0.7);
    this.windFilter.connect(gust);
    gust.connect(this.wind.level);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoToGain = gain(0.3);
    const lfoToFreq = gain(320);
    lfo.connect(lfoToGain);
    lfoToGain.connect(gust.gain);
    lfo.connect(lfoToFreq);
    lfoToFreq.connect(this.windFilter.frequency);
    lfo.start();
    this.surfFilter = filter('lowpass', 6000, 0.6);
    this.surfFilter.connect(this.surf.level);

    const rnd = () => this.random();
    const start = (buf: AudioBuffer, to: AudioNode, offset = 0) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(to);
      src.start(ctx.currentTime + 0.02, offset);
      return src;
    };
    const rate = this.rate;
    this.pending.push(
      () => start(makeLoop(ctx, 4, rate, (d) => brownNoise(d, rnd)), this.humFilter),
      () => {
        const pink = makeLoop(ctx, 4, rate, (d) => pinkNoise(d, rnd));
        start(pink, this.trafficFilter);
        start(pink, this.windFilter, 2);
      },
      () => {
        this.surfSource = start(makeLoop(ctx, 12.5, rate, (d, ch) => surfNoise(d, rate, 12.5, rnd, ch * 0.02)), this.surfFilter);
      },
      () => start(makeLoop(ctx, 4, rate, (d) => murmurNoise(d, rate, rnd)), this.murmur.level),
    );
  }

  /** True once every loop has been generated and started. */
  get ready(): boolean {
    return this.pending.length === 0;
  }

  update(dt: number, now: number, f: AmbienceFrame): void {
    const job = this.pending.shift();
    if (job) job();
    const l = ambienceTargets(f, this.levels);
    const g = this.glide;
    // Layers drift over 1-2 s as the place, the clock or the traffic changes.
    const tau = 0.5;
    g.set(this.hum.level.gain, l.cityHum * LAYER_GAIN.cityHum, now, tau);
    g.set(this.traffic.level.gain, l.trafficWash * LAYER_GAIN.trafficWash, now, tau);
    g.set(this.wind.level.gain, l.wind * LAYER_GAIN.wind, now, tau);
    g.set(this.surf.level.gain, l.surf * LAYER_GAIN.surf, now, tau);
    g.set(this.murmur.level.gain, l.murmur * LAYER_GAIN.murmur, now, tau);
    // The farther the surf, the darker it gets.
    const shore = Number.isFinite(f.shoreDist) ? f.shoreDist : 1e4;
    g.set(this.surfFilter.frequency, 1200 + 4800 * clamp(1 - (shore - 15) / 165, 0, 1), now, 1);
    if (this.surf.pan) g.set(this.surf.pan.pan, clamp(f.seaPan, -0.85, 0.85), now, 0.4, 0, 0.03);
    if (this.traffic.pan) g.set(this.traffic.pan.pan, clamp(f.trafficPan, -0.7, 0.7), now, 0.6, 0, 0.03);
    g.set(this.carFilter.frequency, f.inVehicle ? 900 : OPEN_HZ, now, 0.3);
    // Successive waves differ a little in length.
    this.surfDrift -= dt;
    if (this.surfDrift <= 0 && this.surfSource) {
      this.surfDrift = 10 + this.random() * 6;
      this.surfSource.playbackRate.setTargetAtTime(0.9 + this.random() * 0.2, now, 3);
    }
    this.oneShotsFor(dt, now, l, f);
    if (f.bell && f.bell.dist < BELL_RANGE && bellTolls(this.lastHours, f.hours)) this.toll(now + 0.05, f.bell);
    this.lastHours = f.hours;
  }

  /** Twelve strokes of the chapel bell, quieter and duller the farther off it is. */
  private toll(t: number, bell: { dist: number; pan: number }): void {
    const ctx = this.ctx;
    const near = clamp(1 - bell.dist / BELL_RANGE, 0, 1);
    const o = this.shotOut(bell.pan, BELL_GAIN * near * near);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = withinParam(lp.frequency, 1400 + 6000 * near);
    lp.connect(o.node);
    this.tolls++;
    for (let k = 0; k < BELL_STRIKES; k++) {
      const ts = t + k * BELL_GAP;
      for (const [ratio, gain, decay] of BELL_PARTIALS) {
        const osc = ctx.createOscillator();
        osc.frequency.value = BELL_HZ * ratio;
        const g = this.envGain(ctx.currentTime);
        g.gain.setValueAtTime(0, ts);
        g.gain.linearRampToValueAtTime(o.level * gain, ts + 0.004);
        g.gain.exponentialRampToValueAtTime(Math.max(1e-5, o.level * gain * 1e-3), ts + decay);
        g.gain.linearRampToValueAtTime(0, ts + decay + 0.05);
        osc.connect(g);
        g.connect(lp);
        osc.start(ts + 1 / ctx.sampleRate);
        osc.stop(ts + decay + 0.1);
      }
    }
  }

  private oneShotsFor(dt: number, now: number, l: AmbienceLevels, f: AmbienceFrame): void {
    if (!(dt > 0) || now - this.lastOneShot < ONE_SHOT_GAP) return;
    for (const kind of ONE_SHOTS) {
      const p = l[kind] * ONE_SHOT_RATE[kind] * Math.min(dt, 0.1);
      if (p > 0 && this.random() < p) {
        this.lastOneShot = now;
        this.oneShots++;
        this.play(kind, now + 0.02, f);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // One-shots. Every gain starts at 0 and sources start a sample after their envelope.

  private envGain(now: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, now);
    return g;
  }

  private shotOut(pan: number, level: number): ShotOut {
    const ctx = this.ctx;
    const p = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    if (!p) return { node: this.out, level };
    p.pan.value = Number.isFinite(pan) ? clamp(pan, -1, 1) : 0;
    p.connect(this.out);
    return { node: p, level };
  }

  private play(kind: OneShot, t: number, f: AmbienceFrame): void {
    const r = this.random;
    const near = 0.35 + 0.65 * r();
    const side = (r() * 2 - 1) * 0.85;
    switch (kind) {
      case 'birds':
        this.bird(this.shotOut(side, ONE_SHOT_GAIN.birds * near), t);
        break;
      case 'gulls':
        this.gull(this.shotOut(f.seaPan * 0.6 + side * 0.4, ONE_SHOT_GAIN.gulls * near), t);
        break;
      case 'crickets':
        this.cricket(this.shotOut(side, ONE_SHOT_GAIN.crickets * near), t);
        break;
      case 'dogs':
        this.dog(this.shotOut(side, ONE_SHOT_GAIN.dogs * near), t);
        break;
      case 'horns':
        this.farHorn(this.shotOut(side, ONE_SHOT_GAIN.horns * near), t);
        break;
      case 'siren':
        this.farSiren(this.shotOut(side, ONE_SHOT_GAIN.siren), t);
        break;
    }
  }

  private bird(o: ShotOut, t: number): void {
    const ctx = this.ctx;
    const r = this.random;
    const osc = ctx.createOscillator();
    const g = this.envGain(ctx.currentTime);
    const notes = 3 + Math.floor(r() * 5);
    const base = 2600 + r() * 2200;
    let tt = t;
    osc.frequency.setValueAtTime(base, t);
    for (let i = 0; i < notes; i++) {
      const len = 0.04 + r() * 0.08;
      const f0 = base * (0.85 + r() * 0.4);
      const f1 = f0 * (r() < 0.5 ? 1.35 : 0.75);
      osc.frequency.setValueAtTime(f0, tt);
      osc.frequency.exponentialRampToValueAtTime(f1, tt + len);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(o.level, tt + len * 0.25);
      g.gain.linearRampToValueAtTime(0, tt + len);
      tt += len + 0.03 + r() * 0.07;
    }
    osc.connect(g);
    g.connect(o.node);
    osc.start(t + 1 / ctx.sampleRate);
    osc.stop(tt + 0.05);
  }

  private gull(o: ShotOut, t: number): void {
    const ctx = this.ctx;
    const r = this.random;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700 + r() * 500;
    bp.Q.value = 3;
    const g = this.envGain(ctx.currentTime);
    const cries = 2 + Math.floor(r() * 3);
    let tt = t;
    for (let i = 0; i < cries; i++) {
      const len = 0.22 + r() * 0.18;
      const top = 1250 + r() * 400;
      osc.frequency.setValueAtTime(top * 0.8, tt);
      osc.frequency.linearRampToValueAtTime(top, tt + len * 0.2);
      osc.frequency.exponentialRampToValueAtTime(top * 0.62, tt + len);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(o.level, tt + 0.03);
      g.gain.linearRampToValueAtTime(o.level * 0.8, tt + len * 0.6);
      g.gain.linearRampToValueAtTime(0, tt + len);
      tt += len + 0.06 + r() * 0.12;
    }
    osc.connect(bp);
    bp.connect(g);
    g.connect(o.node);
    osc.start(t + 1 / ctx.sampleRate);
    osc.stop(tt + 0.05);
  }

  private cricket(o: ShotOut, t: number): void {
    const ctx = this.ctx;
    const r = this.random;
    const osc = ctx.createOscillator();
    osc.frequency.value = 4200 + r() * 900;
    const g = this.envGain(ctx.currentTime);
    const chirps = 4 + Math.floor(r() * 5);
    const every = 0.38 + r() * 0.25;
    const pulses = 3 + Math.floor(r() * 2);
    for (let c = 0; c < chirps; c++) {
      for (let p = 0; p < pulses; p++) {
        const tp = t + c * every + p * 0.032;
        g.gain.setValueAtTime(0, tp);
        g.gain.linearRampToValueAtTime(o.level, tp + 0.006);
        g.gain.linearRampToValueAtTime(0, tp + 0.02);
      }
    }
    osc.connect(g);
    g.connect(o.node);
    osc.start(t + 1 / ctx.sampleRate);
    osc.stop(t + chirps * every + 0.2);
  }

  private dog(o: ShotOut, t: number): void {
    const ctx = this.ctx;
    const r = this.random;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 750 + r() * 300;
    bp.Q.value = 1.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1600;
    const g = this.envGain(ctx.currentTime);
    const barks = 1 + Math.floor(r() * 3);
    const f0 = 260 + r() * 200;
    let tt = t;
    for (let i = 0; i < barks; i++) {
      const len = 0.09 + r() * 0.06;
      osc.frequency.setValueAtTime(f0 * 1.25, tt);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.7, tt + len);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(o.level, tt + 0.012);
      g.gain.exponentialRampToValueAtTime(o.level * 0.05, tt + len);
      g.gain.linearRampToValueAtTime(0, tt + len + 0.01);
      tt += len + 0.12 + r() * 0.2;
    }
    osc.connect(bp);
    bp.connect(lp);
    lp.connect(g);
    g.connect(o.node);
    osc.start(t + 1 / ctx.sampleRate);
    osc.stop(tt + 0.05);
  }

  private farHorn(o: ShotOut, t: number): void {
    const ctx = this.ctx;
    const r = this.random;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = this.envGain(ctx.currentTime);
    const base = 300 + r() * 160;
    const taps = r() < 0.4 ? 2 : 1;
    let end = t;
    for (let i = 0; i < taps; i++) {
      const t0 = t + i * 0.32;
      const len = taps === 2 ? 0.16 : 0.3 + r() * 0.4;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(o.level, t0 + 0.015);
      g.gain.setValueAtTime(o.level, t0 + len);
      g.gain.linearRampToValueAtTime(0, t0 + len + 0.06);
      end = t0 + len + 0.1;
    }
    for (const f of [base, base * 1.26]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(lp);
      osc.start(t + 1 / ctx.sampleRate);
      osc.stop(end);
    }
    lp.connect(g);
    g.connect(o.node);
  }

  private farSiren(o: ShotOut, t: number): void {
    const ctx = this.ctx;
    const r = this.random;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    const g = this.envGain(ctx.currentTime);
    const len = 5 + r() * 3;
    const cycle = 2.6;
    for (let tt = 0; tt < len; tt += cycle) {
      osc.frequency.setValueAtTime(650, t + tt);
      osc.frequency.linearRampToValueAtTime(1250, t + tt + cycle * 0.45);
      osc.frequency.linearRampToValueAtTime(650, t + tt + cycle);
    }
    // Comes into earshot and fades away again.
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.level, t + len * 0.4);
    g.gain.linearRampToValueAtTime(0, t + len);
    osc.connect(lp);
    lp.connect(g);
    g.connect(o.node);
    osc.start(t + 1 / ctx.sampleRate);
    osc.stop(t + len + 0.05);
  }
}
