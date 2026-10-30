// The talk station's declared segments are audible from first to last sample: no silent tail or padding inside a
// non-gap segment (the validator measures the music bus above -50 dBFS wherever the programme says something plays).

import { describe, expect, it } from 'vitest';
import { AM_HIGH, AM_LOW, STATIONS } from '../../src/audio/radio';
import { bellGain, jingleBells, padEnvelope, TREMOLO_BASE, TREMOLO_DEPTH, talkProgramme, type Bed, type NoiseFilter } from '../../src/audio/talk';
import { Rng } from '../../src/core/rng';

const SR = 16000;
const WIN = 0.02;

function midi(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Seconds at each end where a 5-30 ms attack or release is allowed (the contract samples 0.15 s in from both ends). */
const EDGE = 0.04;

/** Lowest 20 ms RMS (dBFS) of `sample(t)` over [EDGE, dur - EDGE], hopping 5 ms. */
function minLevel(dur: number, sample: (t: number) => number): number {
  const n = Math.round(dur * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = sample(i / SR);
  return lowest(x, SR);
}

/** Lowest 20 ms RMS (dBFS) of `x` at `sr` over [EDGE, end - EDGE], hopping 5 ms. */
function lowest(x: Float32Array, sr: number): number {
  const n = x.length;
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i]! + x[i]! * x[i]!;
  const w = Math.round(WIN * sr);
  let min = Infinity;
  const e = Math.round(EDGE * sr);
  for (let i = e; i + w <= n - e; i += Math.round(0.005 * sr)) min = Math.min(min, 10 * Math.log10((sum[i + w]! - sum[i]!) / w + 1e-15));
  return min;
}

/** A Web Audio biquad (its spec's formulas: Q in dB for a low- or high-pass, default 1) run over `x` in place at `sr`. */
function biquad(x: Float32Array, sr: number, [type, hz, q]: NoiseFilter): void {
  const w0 = (2 * Math.PI * hz) / sr;
  const c = Math.cos(w0);
  const alpha = type === 'bandpass' ? Math.sin(w0) / (2 * (q ?? 1)) : Math.sin(w0) / (2 * Math.pow(10, (q ?? 1) / 20));
  const b =
    type === 'lowpass' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : type === 'highpass' ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  const [a1, a2] = [-2 * c, 1 - alpha];
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < x.length; i++) {
    const y = (b[0]! * x[i]! + b[1]! * x1 + b[2]! * x2 - a1 * y1 - a2 * y2) / a0;
    [x2, x1, y2, y1] = [x1, x[i]!, y1, y];
    x[i] = y;
  }
}

/** The radio's noise is a buffer of uniform white noise at the context's rate. */
const NOISE_SR = 48000;

/**
 * A bed's noise alone (the voice only adds to it): seeded white noise through its filters and, on AM, the band, at the
 * bottom of its swell for the whole segment.
 */
function noise(dur: number, bed: Bed, am = false): number {
  const n = bed.noise!;
  const r = new Rng(9);
  const x = new Float32Array(Math.round(dur * NOISE_SR));
  for (let i = 0; i < x.length; i++) x[i] = r.range(-1, 1);
  const band: NoiseFilter[] = am ? [['highpass', AM_LOW], ['highpass', AM_LOW], ['lowpass', AM_HIGH], ['lowpass', AM_HIGH]] : [];
  for (const f of [...n.filters, ...band]) biquad(x, NOISE_SR, f);
  const level = n.swell ? n.level * 0.2 : n.level;
  for (let i = 0; i < x.length; i++) x[i]! *= level * padEnvelope(i / NOISE_SR, dur);
  return lowest(x, NOISE_SR);
}

/** A note's fundamental, as a share of the oscillator's peak. */
const FUNDAMENTAL: Partial<Record<OscillatorType, number>> = { square: 4 / Math.PI, triangle: 8 / Math.PI ** 2 };

/**
 * The pad bed alone (a lower bound on a host or ad segment: the voice and a bed's noise only add to it), or a bed without
 * a pad's noise. A Web Audio low- or high-pass at its default Q never cuts its pass band, so a note under the bed's
 * low-pass (and, on AM, inside the band) counts at full level and any other is left out. A square or triangle note
 * counts as its fundamental alone (4/pi or 8/pi^2 of its peak): the harmonics the low-pass leaves only add to it.
 */
function pad(dur: number, seed: number, bed: Bed, am = false): number {
  if (bed.level === 0) return noise(dur, bed, am);
  const root = 50 + (seed % 7);
  const notes = [0, 3, 7].map((m) => midi(root + m + 12)).filter((f) => f <= bed.cutoff && (!am || (f >= AM_LOW && f <= AM_HIGH)));
  const amp = (FUNDAMENTAL[bed.type] ?? 1) / 3;
  return minLevel(dur, (t) => {
    let v = 0;
    for (const f of notes) v += amp * Math.sin(2 * Math.PI * f * t);
    const trem = bed.tremolo > 0 ? TREMOLO_BASE + TREMOLO_DEPTH * Math.sin(2 * Math.PI * bed.tremolo * t + 3 * Math.PI / 2) : 1;
    return v * bed.level * trem * padEnvelope(t, dur);
  });
}

/** The bells alone of a jingle `dur` seconds long on `motif` (its ident only adds to them). */
function jingle(seed: number, dur: number, motif: readonly number[]): number {
  const root = 60 + (seed % 5);
  const bells = jingleBells(dur, motif);
  return minLevel(dur, (t) => {
    let v = 0;
    for (const b of bells) {
      const x = t - b.t;
      v += bellGain(b, x) * Math.sin(2 * Math.PI * midi(root + b.m) * x) + bellGain(b, x, 0.35) * Math.sin(2 * Math.PI * midi(root + b.m) * 2.76 * x);
    }
    return v;
  });
}

describe('talk station segments are audible across their declared length', () => {
  it("every talk station's jingle never falls under -50 dBFS from its start to its declared end", () => {
    for (const { name, talk } of STATIONS.filter((s) => s.talk)) {
      const jingles = talkProgramme(7, 1800, talk).filter((s) => s.kind === 'jingle');
      const lows = jingles.map((s) => jingle(s.seed, s.dur, talk!.bells));
      console.log(`[talk] ${name} jingle min 20 ms level over ${jingles.map((s) => s.dur.toFixed(1)).join(', ')} s: ${lows.map((x) => x.toFixed(1)).join(', ')} dBFS`);
      for (const l of lows) expect(l, name).toBeGreaterThan(-50);
    }
  });

  it("every talk station's host and ad segments of ten-minute programmes keep their bed above -50 dBFS from edge to edge", () => {
    for (const { name, talk } of STATIONS.filter((s) => s.talk)) {
      let host = Infinity;
      let ad = Infinity;
      for (const seed of [1, 7, 42, 1234, 99991]) {
        for (const s of talkProgramme(seed, 600, talk)) {
          if (s.kind === 'host') host = Math.min(host, pad(s.dur, s.seed, talk!.beds?.[s.piece!] ?? talk!.bed, talk!.am));
          if (s.kind === 'ad') ad = Math.min(ad, pad(s.dur, s.seed, talk!.adBed, talk!.am));
        }
      }
      console.log(`[talk] ${name} bed min 20 ms level: host ${host.toFixed(1)}, ad ${ad.toFixed(1)} dBFS`);
      expect(host, name).toBeGreaterThan(-50);
      expect(ad, name).toBeGreaterThan(-50);
    }
  });
});
