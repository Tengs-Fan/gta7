// Wave-1 audio (track G): the talk station's programme, police radio barks, siren Doppler, wanted-adaptive music,
// gunfire echo by district, and the audio staying out of the simulation. The WebAudio parts run against a small fake
// context (AudioParams keep their last target); levels and spectra are measured in the browser (r2_audio / w1_audio specs).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/audio';
import { DOPPLER_RANGE, dopplerFactor } from '../../src/audio/doppler';
import { decayTime, echoImpulse, gunEcho } from '../../src/audio/echo';
import { mixTargets, type MixInput } from '../../src/audio/mixer';
import { INTENSITY_FALL, Radio, STATIONS, wantedIntensity } from '../../src/audio/radio';
import { BARK_MAX, BARK_MIN_GAP, barkLength, RADIO_BAND } from '../../src/audio/scanner';
import { NodeTally } from '../../src/audio/tally';
import { JINGLE_LEN, talkProgramme, TalkProgramme } from '../../src/audio/talk';
import { HOST_VOICE, speechPlan, voicedSeconds } from '../../src/audio/voice';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { isGun, WEAPONS, type WeaponId } from '../../src/sim/specs';
import { input, makeSim, placeInCar, roadPoint, teleport, legacyLane } from './helpers';

// ---------------------------------------------------------------------------
// A minimal fake Web Audio context.

class FParam {
  value: number;
  maxValue?: number;
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number): this {
    if (v === 0) throw new RangeError('exponential ramp to 0');
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class FNode {
  readonly outputs: unknown[] = [];
  onended: (() => void) | null = null;
  started = false;
  stopAt = Infinity;
  constructor(
    readonly ctx: FContext,
    readonly kind: string,
    props: Record<string, unknown> = {},
  ) {
    Object.assign(this, props);
    ctx.nodes.push(this);
  }
  connect<T>(d: T): T {
    this.outputs.push(d);
    return d;
  }
  disconnect(): void {
    this.outputs.length = 0;
  }
  start(): void {
    this.started = true;
  }
  stop(t = 0): void {
    this.stopAt = Math.min(this.stopAt, t);
  }
}

class FContext {
  static last: FContext | null = null;
  currentTime = 1;
  state = 'running';
  readonly sampleRate = 8000;
  readonly nodes: FNode[] = [];
  readonly destination: FNode;
  constructor() {
    FContext.last = this;
    this.destination = new FNode(this, 'destination');
  }
  createGain() {
    return new FNode(this, 'gain', { gain: new FParam(1) });
  }
  createDynamicsCompressor() {
    return new FNode(this, 'compressor', { threshold: new FParam(), knee: new FParam(), ratio: new FParam(), attack: new FParam(), release: new FParam() });
  }
  createBiquadFilter() {
    return new FNode(this, 'biquad', { type: 'lowpass', frequency: new FParam(350), Q: new FParam(1), gain: new FParam(0) });
  }
  createOscillator() {
    return new FNode(this, 'oscillator', { type: 'sine', frequency: new FParam(440), detune: new FParam(0), setPeriodicWave() {} });
  }
  createBufferSource() {
    return new FNode(this, 'source', { buffer: null, loop: false, playbackRate: new FParam(1) });
  }
  createStereoPanner() {
    return new FNode(this, 'panner', { pan: new FParam(0) });
  }
  createDelay() {
    return new FNode(this, 'delay', { delayTime: new FParam(0) });
  }
  createWaveShaper() {
    return new FNode(this, 'waveshaper', { curve: null, oversample: 'none' });
  }
  createConvolver() {
    return new FNode(this, 'convolver', { buffer: null, normalize: true });
  }
  createAnalyser() {
    return new FNode(this, 'analyser', { fftSize: 2048, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) });
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array): unknown {
    return { real, imag };
  }
  createBuffer(channels: number, length: number): unknown {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, numberOfChannels: channels, getChannelData: (c: number) => data[c]! };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  /** Fires `onended` for every source whose stop time has passed (the real context does this itself). */
  endSources(): void {
    for (const n of this.nodes) {
      if (n.started && n.stopAt <= this.currentTime && n.onended) {
        const f = n.onended;
        n.onended = null;
        f();
      }
    }
  }
}

type Internals = { sfx: unknown; musicBus: unknown };

/** An unlocked engine on a sim, the listener a few metres behind the player; `frames` runs sim and audio together. */
function rig(sim: Sim = makeSim({ police: false })) {
  vi.stubGlobal('window', { AudioContext: FContext });
  const audio = new AudioEngine();
  audio.unlock();
  const ctx = FContext.last!;
  audio.attach(sim);
  const listen = () => {
    const p = sim.playerPos();
    audio.setListener(p.x, p.y + 2, p.z - 5, 0);
  };
  const frames = (n: number, inp = input()) => {
    for (let i = 0; i < n; i++) {
      ctx.currentTime += 1 / 60;
      sim.update(1 / 60, inp);
      listen();
      audio.update(1 / 60, sim, true);
      ctx.endSources();
    }
  };
  listen();
  return { sim, audio, ctx, inner: audio as unknown as Internals, frames };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('talk station', () => {
  it('is on the station list, reached by cycling stations, and RADIO OFF stays last', () => {
    expect(STATIONS.some((s) => s.genre === 'talk')).toBe(true);
    const r = new Radio();
    const names: string[] = [];
    for (let i = 0; i <= STATIONS.length; i++) names.push(r.next());
    expect(names).toContain('AZURA TALK 104.5');
    expect(names.at(-2)).toBe('RADIO OFF');
    expect(names.at(-1)).toBe(STATIONS[0]!.name);
    expect(r.prev()).toBe('RADIO OFF');
    expect(r.prev()).toBe('AZURA TALK 104.5');
  });

  it('its programme over 10 minutes has host speech, jingles and ad breaks, separated by short gaps, and is seeded', () => {
    for (const seed of [1, 7, 42, 1234, 99991]) {
      const segs = talkProgramme(seed, 600);
      const kinds = new Set(segs.map((s) => s.kind));
      expect(kinds.has('host'), `seed ${seed}`).toBe(true);
      expect(kinds.has('jingle'), `seed ${seed}`).toBe(true);
      expect(kinds.has('ad'), `seed ${seed}`).toBe(true);
      for (let i = 1; i < segs.length; i++) {
        // Contiguous, and dead air only between two programme items.
        expect(segs[i]!.start).toBeCloseTo(segs[i - 1]!.start + segs[i - 1]!.dur, 9);
        expect(segs[i]!.kind === 'gap' && segs[i - 1]!.kind === 'gap').toBe(false);
        if (segs[i]!.kind !== 'gap') expect(segs[i - 1]!.kind).toBe('gap');
      }
      for (const s of segs) {
        if (s.kind === 'gap') expect(s.dur).toBeLessThan(1);
        if (s.kind === 'jingle') expect(s.dur).toBe(JINGLE_LEN);
      }
      expect(talkProgramme(seed, 600)).toEqual(segs);
      if (seed === 42) {
        const tally: Record<string, { n: number; s: number }> = {};
        for (const s of segs) {
          tally[s.kind] ??= { n: 0, s: 0 };
          tally[s.kind]!.n++;
          tally[s.kind]!.s += s.dur;
        }
        console.log(`[talk] seed 42, 10 min: ${segs.map((s) => `${s.kind}@${s.start.toFixed(1)}+${s.dur.toFixed(1)}`).join(' ')}`);
        console.log(`[talk] per kind: ${JSON.stringify(tally)}`);
      }
    }
    expect(talkProgramme(1, 600)).not.toEqual(talkProgramme(2, 600));
  });

  it('finds the segment on air at any time, extending the schedule as needed', () => {
    const p = new TalkProgramme(5);
    for (const t of [0, 3, 59.9, 600, 3600, 0.5]) {
      const s = p.at(t);
      expect(s.start).toBeLessThanOrEqual(t);
      expect(s.start + s.dur).toBeGreaterThan(t);
    }
    expect(p.at(NaN)).toBe(p.segments[0]);
  });

  it('host speech plans are seeded syllables with phrase pauses inside the segment', () => {
    const plan = speechPlan(3, 30, HOST_VOICE);
    expect(speechPlan(3, 30, HOST_VOICE)).toEqual(plan);
    const last = plan.at(-1)!;
    expect(last.t + last.dur).toBeLessThanOrEqual(30 + 1e-9);
    // About five syllables a second, voiced most of the time.
    expect(plan.length).toBeGreaterThan(100);
    expect(voicedSeconds(plan) / 30).toBeGreaterThan(0.6);
    for (const s of plan) {
      expect(Number.isFinite(s.pitch) && s.pitch > 60 && s.pitch < 250).toBe(true);
      expect(s.f1).toBeGreaterThan(200);
      expect(s.f3).toBeLessThan(4000);
    }
  });

  it('plays through the music bus with the same mix as the music stations; pause, RADIO OFF and leaving the car stop it', () => {
    const sim = makeSim({ police: false });
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    placeInCar(sim, v);
    const { audio, frames } = rig(sim);
    const mixer = audio.mixer!;
    frames(30);
    const music = { veh: mixer.vehMix.gain.value, hp: mixer.vehHighpass.frequency.value, music: mixer.musicMix.gain.value };
    while (audio.radio.stationName !== 'AZURA TALK 104.5') audio.radio.next();
    // Tuning in lands at a random point of the show, and the 0.5-0.8 s gaps between segments are silent on purpose.
    audio.radio.cueTalk('host');
    frames(30);
    expect(audio.radio.playing).toBe(true);
    expect(audio.radio.talkInfo().rendering).not.toBeNull();
    // The same in-car radio treatment as any music station.
    expect({ veh: mixer.vehMix.gain.value, hp: mixer.vehHighpass.frequency.value, music: mixer.musicMix.gain.value }).toEqual(music);
    const base: MixInput = { inVehicle: true, radio: 1, subtitleActive: false, explosionDist: Infinity, paused: false, bigScreen: false };
    expect(mixer.vehMix.gain.value).toBeCloseTo(mixTargets(base).vehicle, 9);
    // Its voices start under the radio's output gain, which feeds the music bus.
    expect(audio.nodes.started.talk).toBeGreaterThan(0);
    audio.setPaused(true);
    frames(2);
    expect(audio.radio.talkInfo().rendering).toBeNull();
    audio.setPaused(false);
    frames(10);
    expect(audio.radio.talkInfo().rendering).not.toBeNull();
    audio.radio.next();
    frames(5);
    expect(audio.radio.stationName).toBe('RADIO OFF');
    expect(audio.radio.playing).toBe(false);
    expect(audio.radio.talkInfo().rendering).toBeNull();
    audio.radio.prev();
    frames(10);
    expect(audio.radio.talkInfo().rendering).not.toBeNull();
    sim.unseat(sim.player);
    frames(5);
    expect(audio.radio.playing).toBe(false);
    expect(audio.radio.talkInfo().rendering).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/** Magnitude of an RBJ-cookbook biquad (low-pass or high-pass) at `f` Hz. */
function biquadMag(type: 'lowpass' | 'highpass', f0: number, q: number, f: number, fs = 48000): number {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const c = Math.cos(w0);
  const b = type === 'lowpass' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a = [1 + alpha, -2 * c, 1 - alpha];
  const w = (2 * Math.PI * f) / fs;
  const re = (k: number[]) => k[0]! + k[1]! * Math.cos(w) + k[2]! * Math.cos(2 * w);
  const im = (k: number[]) => -(k[1]! * Math.sin(w) + k[2]! * Math.sin(2 * w));
  return Math.hypot(re(b), im(b)) / Math.hypot(re(a), im(a));
}

describe('police radio barks', () => {
  it('each dispatch line starts one bark, at most one at a time and BARK_MIN_GAP apart; counted', () => {
    const { sim, audio, frames } = rig();
    const say = (text: string) => sim.events.emit('dispatch', { text });
    say('All units, shots fired reported in Downtown. Suspect on foot.');
    expect(audio.counters.barks).toBe(1);
    // A burst of lines: the radio is busy.
    say('Air unit on scene.');
    frames(30);
    say('SWAT is rolling.');
    expect(audio.counters.barks).toBe(1);
    expect(audio.counters.dispatches).toBe(3);
    frames(60 * BARK_MIN_GAP);
    say('Suspect spotted heading north through Midtown.');
    expect(audio.counters.barks).toBe(2);
    // Lines for another player are not ours.
    frames(60 * BARK_MIN_GAP);
    sim.events.emit('dispatch', { text: 'Not you.', playerId: 3 });
    expect(audio.counters.dispatches).toBe(4);
    expect(audio.counters.barks).toBe(2);
    expect(BARK_MIN_GAP).toBeGreaterThanOrEqual(BARK_MAX);
  });

  it('the dispatch lines of a real 3-star chase each get a bark (they come 6 s apart)', () => {
    const sim = makeSim({ police: true, ambient: false, seed: 11 });
    const { audio, frames } = rig(sim);
    sim.cheats.godMode = true;
    sim.wanted.setLevel(3);
    let lines = 0;
    sim.events.on('dispatch', () => lines++);
    frames(60 * 40);
    console.log(`[barks] 40 s at 3 stars: ${lines} dispatch lines, ${audio.counters.barks} barks, live ${JSON.stringify(audio.liveNodes().live)}`);
    expect(lines).toBeGreaterThan(0);
    expect(audio.counters.barks).toBe(lines);
  });

  it('a bark is a voice through two 300 Hz high-passes and two 3.4 kHz low-passes into the effects bus, with squelch', () => {
    const { audio, ctx, inner } = rig();
    const n0 = ctx.nodes.length;
    expect(audio.policeBark('All units, return to patrol.')).toBe(true);
    const made = ctx.nodes.slice(n0);
    const band = made.filter((n) => n.kind === 'biquad' && ((n as unknown as { type: string }).type === 'highpass' || (n as unknown as { type: string }).type === 'lowpass'));
    const hz = band.map((n) => [(n as unknown as { type: string }).type, (n as unknown as { frequency: FParam }).frequency.value]);
    expect(hz.filter(([t, f]) => t === 'highpass' && f === RADIO_BAND[0]).length).toBe(2);
    expect(hz.filter(([t, f]) => t === 'lowpass' && f === RADIO_BAND[1]).length).toBe(2);
    // The chain ends on the effects bus (so the Sound effects volume and the pause stage apply).
    expect(made.some((n) => n.outputs.includes(inner.sfx))).toBe(true);
    // A looping hiss source (the squelch) and the voice's two sources.
    expect(made.filter((n) => n.kind === 'source').length).toBe(2);
    expect(made.filter((n) => n.kind === 'oscillator').length).toBe(1);
    // The band: the chain passes 1 kHz and cuts 100 Hz and 8 kHz by more than 24 dB.
    const chain = (f: number) => biquadMag('highpass', RADIO_BAND[0], 0.8, f) ** 2 * biquadMag('lowpass', RADIO_BAND[1], 0.8, f) ** 2;
    const db = (x: number) => 20 * Math.log10(x);
    expect(db(chain(1000))).toBeGreaterThan(-1.5);
    expect(db(chain(100) / chain(1000))).toBeLessThan(-24);
    expect(db(chain(8000) / chain(1000))).toBeLessThan(-24);
    // Bark lengths follow the line, within limits.
    expect(barkLength('Go.')).toBeGreaterThanOrEqual(0.9);
    expect(barkLength('word '.repeat(100))).toBe(BARK_MAX);
  });

  it('started bark sources end and are counted off, so barks do not pile up', () => {
    const { audio, frames, sim } = rig();
    for (let i = 0; i < 6; i++) {
      sim.events.emit('dispatch', { text: `Line ${i}, all units respond.` });
      frames(60 * (BARK_MIN_GAP + 0.1));
    }
    expect(audio.counters.barks).toBe(6);
    expect(audio.nodes.started.bark).toBe(18);
    expect(audio.nodes.live.bark).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('siren Doppler', () => {
  it('approaching raises the pitch, receding lowers it, a stationary pair is exactly 1, and it is clamped and finite', () => {
    const at = (v: number) => dopplerFactor(0, -50, 0, v, 0, 0, 0, 0);
    const rows: string[] = [];
    for (const v of [-40, -20, -10, 0, 10, 20, 40]) rows.push(`${v} m/s: ${at(v).toFixed(4)}`);
    console.log(`[doppler] source speed toward the listener -> factor: ${rows.join(', ')}`);
    const approach = at(20);
    const recede = dopplerFactor(0, 50, 0, 20, 0, 0, 0, 0);
    expect(approach).toBeGreaterThan(1);
    expect(recede).toBeLessThan(1);
    expect(approach / recede).toBeGreaterThan(1.05);
    expect(approach / recede).toBeLessThan(1.3);
    expect(dopplerFactor(10, 20, 0, 0, 0, 0, 0, 0)).toBe(1);
    // Side by side at the same speed: no shift.
    expect(dopplerFactor(0, -10, 0, 20, 0, 0, 0, 20)).toBeCloseTo(1, 12);
    // The listener moving toward the source raises it too.
    expect(dopplerFactor(0, -50, 0, 0, 0, 0, 0, -20)).toBeGreaterThan(1);
    for (const v of [1e9, -1e9, Infinity, -Infinity, NaN, 343, -343, 5000]) {
      for (const f of [dopplerFactor(0, -50, 0, v, 0, 0, 0, 0), dopplerFactor(0, -50, 0, 0, 0, 0, v, v), dopplerFactor(NaN, 0, 0, v, 0, 0, 0, 0)]) {
        expect(Number.isFinite(f)).toBe(true);
        expect(f).toBeGreaterThanOrEqual(DOPPLER_RANGE[0]);
        expect(f).toBeLessThanOrEqual(DOPPLER_RANGE[1]);
      }
    }
    expect(dopplerFactor(0, 0, 0, 20, 0, 0, 0, 0)).toBe(1);
  });

  it('a cruiser driving past the stopped player shifts the siren oscillator from above to below its pitch', () => {
    const sim = makeSim({ police: false });
    // On a long lane: the player stands at its middle, the cruiser comes down it 3 m to his side.
    // One of the square city's longest lanes, down Delgado St from the north ring road.
    const lane = legacyLane(sim, 38);
    const mid = lane.length / 2;
    teleport(sim, lane.sx + lane.dx * mid - lane.dz * 3, lane.sz + lane.dz * mid + lane.dx * 3);
    const { audio, frames } = rig(sim);
    const p = { ...sim.playerPos() };
    const cop: Vehicle = sim.spawnVehicle('police', lane.sx + lane.dx * (mid - 75), lane.sz + lane.dz * (mid - 75), lane.heading);
    cop.siren = true;
    const trace: Array<[number, number]> = [];
    const drive = () => {
      cop.vel.x = lane.dx * 20;
      cop.vel.z = lane.dz * 20;
      cop.angVel = 0;
    };
    for (let i = 0; i < 60 * 7; i++) {
      drive();
      frames(1);
      const s = audio.sirenInfo()!;
      // Along the lane, from the listener (5 m behind the player in z, as rig() places it).
      trace.push([(cop.pos.x - p.x) * lane.dx + (cop.pos.z - (p.z - 5)) * lane.dz, s.frequency]);
    }
    const before = trace.find(([dz]) => dz < -30)!;
    const after = [...trace].reverse().find(([dz]) => dz > 30)!;
    console.log(`[doppler] siren oscillator: ${before[1].toFixed(1)} Hz 30+ m before the pass, ${after[1].toFixed(1)} Hz 30+ m after`);
    expect(before[1]).toBeGreaterThan(950);
    expect(after[1]).toBeLessThan(950);
    expect(before[1] / after[1]).toBeGreaterThan(1.05);
    expect(before[1] / after[1]).toBeLessThan(1.3);
  });
});

// ---------------------------------------------------------------------------

describe('wanted-adaptive music', () => {
  it('the intensity target is non-decreasing over 0-5 stars and higher at 5 than at 0', () => {
    const v = [0, 1, 2, 3, 4, 5].map(wantedIntensity);
    console.log(`[music] intensity per wanted level: ${v.join(', ')}`);
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThanOrEqual(v[i - 1]!);
    expect(v[5]!).toBeGreaterThan(v[0]!);
    expect(v[0]).toBe(0);
    expect(wantedIntensity(9)).toBe(1);
  });

  it('the radio glides up within 5 s of a chase and back to calm within 15 s of it ending, without a step', () => {
    const { audio, frames, sim } = rig(makeSim({ police: false }));
    const r = audio.radio;
    frames(30);
    expect(r.intensity).toBe(0);
    sim.wanted.setLevel(4);
    let last = 0;
    let maxStep = 0;
    for (let i = 0; i < 60 * 5; i++) {
      frames(1);
      maxStep = Math.max(maxStep, Math.abs(r.intensity - last));
      last = r.intensity;
    }
    expect(r.intensity).toBeGreaterThan(0.95 * wantedIntensity(4));
    sim.wanted.setLevel(0);
    for (let i = 0; i < 60 * 15; i++) {
      frames(1);
      maxStep = Math.max(maxStep, Math.abs(r.intensity - last));
      last = r.intensity;
    }
    console.log(`[music] intensity after 5 s at 4 stars then 15 s calm: ${last.toFixed(4)}, largest per-frame step ${maxStep.toFixed(4)}`);
    expect(last).toBeLessThan(0.03);
    expect(maxStep).toBeLessThan(0.05);
    expect(INTENSITY_FALL * 5).toBeLessThanOrEqual(15);
  });

  it('at five stars the music stations schedule more notes per bar than calm', () => {
    const count = (level: number) => {
      const sim = makeSim({ police: false });
      const rp = roadPoint(sim);
      placeInCar(sim, sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading));
      const { ctx, frames } = rig(sim);
      sim.wanted.setLevel(level);
      frames(60 * 6);
      const n0 = ctx.nodes.length;
      frames(60 * 4);
      return ctx.nodes.length - n0;
    };
    const calm = count(0);
    const chase = count(5);
    console.log(`[music] nodes created in 4 s: calm ${calm}, five stars ${chase}`);
    expect(chase).toBeGreaterThan(calm * 1.2);
  });

  it('the talk station keeps talking through a chase', () => {
    const sim = makeSim({ police: false });
    const rp = roadPoint(sim);
    placeInCar(sim, sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading));
    const { audio, frames } = rig(sim);
    while (audio.radio.stationName !== 'AZURA TALK 104.5') audio.radio.next();
    frames(30);
    sim.wanted.setLevel(5);
    frames(60 * 3);
    expect(audio.radio.playing).toBe(true);
    expect(audio.radio.talkInfo().rendering).not.toBeNull();
    expect(audio.radio.stationName).toBe('AZURA TALK 104.5');
  });
});

// ---------------------------------------------------------------------------

describe('gunfire echo by district', () => {
  it('downtown has a longer, louder tail than the open beach; every district has finite parameters', () => {
    const d = gunEcho('downtown');
    const b = gunEcho('beach');
    const rows: string[] = [];
    for (const k of ['downtown', 'midtown', 'docks', 'southgate', 'westside', 'hillcrest', 'park', 'beachfront', 'beach', 'sea']) {
      const p = gunEcho(k);
      const [l] = echoImpulse(p, 8000, 3);
      rows.push(`${k}: ${p.space} RT60 ${p.decay} s level ${p.level} slaps ${p.slaps.length} (IR -30 dB at ${decayTime(l, 8000).toFixed(2)} s)`);
      expect(Number.isFinite(p.decay) && p.decay > 0 && Number.isFinite(p.level) && p.level > 0).toBe(true);
    }
    console.log(`[echo] ${rows.join('; ')}`);
    expect(d.decay).toBeGreaterThan(b.decay * 1.5);
    expect(d.level).toBeGreaterThan(b.level);
    expect(gunEcho('nowhere')).toEqual(gunEcho('southgate'));
  });

  it('the generated impulse responses have unit energy and decay as their RT60 says', () => {
    const rate = 8000;
    const [dl, dr] = echoImpulse(gunEcho('downtown'), rate, 1);
    const [bl] = echoImpulse(gunEcho('beach'), rate, 1);
    const energy = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0);
    expect(energy(dl)).toBeCloseTo(1, 4);
    expect(energy(dr)).toBeCloseTo(1, 4);
    expect(energy(bl)).toBeCloseTo(1, 4);
    expect(decayTime(dl, rate)).toBeGreaterThan(1.5 * decayTime(bl, rate));
    expect(dl.every(Number.isFinite)).toBe(true);
  });

  it("a shot sends into the echo of the district at the shooter, and every echo returns into the effects bus", () => {
    const sim = makeSim({ police: false });
    const { audio, ctx, inner, frames } = rig(sim);
    const shot = vi.spyOn(audio, 'gunshot');
    const p = sim.playerPos();
    sim.events.emit('weaponFired', { shooter: sim.player, weapon: 'pistol', x: p.x, y: p.y + 1.4, z: p.z, dx: 1, dy: 0, dz: 0, pellets: 1 });
    expect(shot.mock.calls[0]![5]).toBe(sim.world.districtAt(p.x, p.z));
    expect(audio.counters.echoes).toBe(1);
    const conv = ctx.nodes.filter((n) => n.kind === 'convolver');
    expect(conv.length).toBe(1);
    expect(conv[0]!.outputs).toContain(inner.sfx);
    // A second shot in the same space reuses its convolver; one on the beach builds the beach's.
    frames(10);
    audio.gunshot('pistol', p.x, p.y + 1.4, p.z, true, sim.world.districtAt(p.x, p.z));
    frames(10);
    audio.gunshot('pistol', p.x, p.y + 1.4, p.z, true, 'beach');
    expect(ctx.nodes.filter((n) => n.kind === 'convolver').length).toBe(sim.world.districtAt(p.x, p.z) === 'beach' ? 1 : 2);
    // Without a district the shot is dry.
    const e0 = audio.counters.echoes;
    frames(10);
    audio.gunshot('pistol', p.x, p.y + 1.4, p.z, true);
    expect(audio.counters.echoes).toBe(e0);
  });

  it('every gun, the sniper rifle included, plays a report of real sources into its echo when it fires', () => {
    const sim = makeSim({ police: false });
    const { audio, ctx, frames } = rig(sim);
    const p = sim.playerPos();
    const district = sim.world.districtAt(p.x, p.z);
    const guns = (Object.keys(WEAPONS) as WeaponId[]).filter(isGun);
    expect(guns).toContain('sniper');
    const rows: string[] = [];
    for (const w of guns) {
      frames(10);
      const n0 = ctx.nodes.length;
      const e0 = audio.counters.echoes;
      sim.events.emit('weaponFired', { shooter: sim.player, weapon: w, x: p.x, y: p.y + 1.4, z: p.z, dx: 1, dy: 0, dz: 0, pellets: 1 });
      const fresh = ctx.nodes.slice(n0);
      const sources = fresh.filter((n) => (n.kind === 'source' || n.kind === 'oscillator') && n.started);
      rows.push(`${w}: ${sources.length} sources, echo ${audio.counters.echoes - e0}`);
      expect(sources.length, w).toBeGreaterThan(0);
      expect(audio.counters.echoes - e0, w).toBe(1);
    }
    console.log(`[echo] gun reports in ${district}: ${rows.join('; ')}`);
  });
});

// ---------------------------------------------------------------------------

describe('audio stays out of the simulation', () => {
  /** A digest of the sim after a scripted 3-star chase with gunfire. */
  function run(withAudio: boolean): unknown {
    const sim = makeSim({ police: true, ambient: true, seed: 77 });
    sim.cheats.godMode = true;
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    placeInCar(sim, v);
    let frames: (n: number, inp?: ReturnType<typeof input>) => void;
    if (withAudio) {
      const r = rig(sim);
      while (r.audio.radio.stationName !== 'AZURA TALK 104.5') r.audio.radio.next();
      frames = r.frames;
    } else {
      frames = (n, inp = input()) => {
        for (let i = 0; i < n; i++) sim.update(1 / 60, inp);
      };
    }
    frames(60 * 2, input({ throttle: 1 }));
    sim.wanted.setLevel(3);
    frames(60 * 12, input({ throttle: 0.6, steer: 0.2 }));
    sim.unseat(sim.player);
    sim.player.inventory.give('pistol', 60);
    sim.player.inventory.current = 'pistol';
    for (let f = 0; f < 60 * 4; f++) frames(1, input({ fire: f % 15 === 0, firePressed: f % 15 === 0 }));
    const v3 = (q: { x: number; y?: number; z: number }) => [q.x, q.y, q.z];
    return {
      time: sim.time,
      wanted: sim.wanted.level,
      player: [v3(sim.player.pos), sim.player.health],
      vehicles: sim.vehicles.map((x: Vehicle) => [x.id, x.kind, x.removed, v3(x.pos), x.heading, x.siren]),
      characters: sim.characters.map((c: Character) => [c.id, c.role, c.removed, v3(c.pos), c.state, c.health]),
      rng: sim.rng.next(),
    };
  }

  it('a same-seed run with the audio engine attached (stub context) ends in the same sim state as one without', () => {
    const a = run(false);
    const b = run(true);
    expect(b).toEqual(a);
  }, 60_000);

  it('no file under src/sim, src/world or src/core imports from src/audio', () => {
    const root = join(__dirname, '../../src');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
      });
    const offenders: string[] = [];
    for (const d of ['sim', 'world', 'core']) {
      for (const f of files(join(root, d))) {
        const src = readFileSync(f, 'utf8');
        if (/from\s+['"][^'"]*\/audio(\/|['"])/.test(src) || /import\(\s*['"][^'"]*\/audio/.test(src)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('node tally', () => {
  it('counts sources live until they end', () => {
    const t = new NodeTally();
    const src = { onended: null as null | (() => void), disconnect: vi.fn() } as unknown as AudioScheduledSourceNode;
    t.track('talk', src);
    expect(t.live.talk).toBe(1);
    expect(t.total).toBe(1);
    (src.onended as unknown as () => void)();
    expect(t.live.talk).toBe(0);
    expect(t.started.talk).toBe(1);
  });
});
