// The talk station's declared segments are audible from first to last sample: no silent tail or padding inside a
// non-gap segment (the validator measures the music bus above -50 dBFS wherever the programme says something plays).

import { describe, expect, it } from 'vitest';
import { AM_HIGH, AM_LOW, STATIONS } from '../../src/audio/radio';
import { bellGain, jingleBells, padEnvelope, TREMOLO_BASE, TREMOLO_DEPTH, talkProgramme, type Bed } from '../../src/audio/talk';

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
  const w = Math.round(WIN * SR);
  let min = Infinity;
  const e = Math.round(EDGE * SR);
  for (let i = e; i + w <= n - e; i += Math.round(0.005 * SR)) {
    let s = 0;
    for (let k = i; k < i + w; k++) s += x[k]! * x[k]!;
    min = Math.min(min, 10 * Math.log10(s / w + 1e-15));
  }
  return min;
}

/**
 * The pad bed alone (a lower bound on a host or ad segment: the voice and a bed's noise only add to it). A Web Audio
 * low- or high-pass at its default Q never cuts its pass band, so a note under the bed's low-pass (and, on AM, inside
 * the band) counts at full level and any other is left out. A square note counts as its fundamental alone (4/pi of its
 * peak): the harmonics the low-pass leaves only add to it.
 */
function pad(dur: number, seed: number, bed: Bed, am = false): number {
  const root = 50 + (seed % 7);
  const notes = [0, 3, 7].map((m) => midi(root + m + 12)).filter((f) => f <= bed.cutoff && (!am || (f >= AM_LOW && f <= AM_HIGH)));
  const amp = (bed.type === 'square' ? 4 / Math.PI : 1) / 3;
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
          if (s.kind === 'host') host = Math.min(host, pad(s.dur, s.seed, talk!.bed, talk!.am));
          if (s.kind === 'ad') ad = Math.min(ad, pad(s.dur, s.seed, talk!.adBed, talk!.am));
        }
      }
      console.log(`[talk] ${name} bed min 20 ms level: host ${host.toFixed(1)}, ad ${ad.toFixed(1)} dBFS`);
      expect(host, name).toBeGreaterThan(-50);
      expect(ad, name).toBeGreaterThan(-50);
    }
  });
});
