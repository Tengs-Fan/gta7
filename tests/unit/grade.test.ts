// The time-of-day colour grade (src/render/grade.ts): continuity, a neutral noon, and weather modulation.

import { describe, expect, it } from 'vitest';
import { CLEAR_WEATHER, gradeAt, type Grade, type GradeWeather } from '../../src/render/grade';

function params(g: Grade): number[] {
  return [...g.tint, g.sat, g.contrast, g.vignette, g.splitTone];
}

function maxDelta(a: Grade, b: Grade): number {
  const pa = params(a);
  const pb = params(b);
  return Math.max(...pa.map((v, i) => Math.abs(v - pb[i]!)));
}

describe('gradeAt', () => {
  it('changes no parameter by more than 1e-3 per game minute over a whole day, midnight included', () => {
    let worst = 0;
    let at = 0;
    let prev = gradeAt(0);
    for (let m = 1; m <= 24 * 60; m++) {
      const g = gradeAt(m / 60);
      const d = maxDelta(prev, g);
      if (d > worst) {
        worst = d;
        at = m / 60;
      }
      prev = g;
    }
    expect(worst, `at ${at.toFixed(2)} h`).toBeLessThanOrEqual(1e-3);
    expect(maxDelta(gradeAt(23 + 59 / 60), gradeAt(0))).toBeLessThanOrEqual(1e-3);
    expect(maxDelta(gradeAt(24), gradeAt(0))).toBeLessThan(1e-9);
    expect(maxDelta(gradeAt(-1), gradeAt(23))).toBeLessThan(1e-9);
  });

  it('is near neutral at noon in clear weather', () => {
    const g = gradeAt(12);
    for (const c of g.tint) expect(Math.abs(c - 1)).toBeLessThanOrEqual(0.03);
    expect(g.sat).toBeGreaterThanOrEqual(1);
    expect(g.sat).toBeLessThanOrEqual(1.1);
    expect(gradeAt(12, CLEAR_WEATHER)).toEqual(g);
  });

  it('warms golden hour and cools the night', () => {
    const golden = gradeAt(18.4);
    expect(golden.tint[0]).toBeGreaterThan(golden.tint[2]);
    for (const h of [23, 0, 2]) {
      const n = gradeAt(h);
      expect(n.tint[2], `${h} h`).toBeGreaterThan(n.tint[0]);
      expect(n.vignette).toBeGreaterThan(gradeAt(12).vignette);
    }
  });

  it('cloud lowers saturation and rain raises the vignette by about 0.05', () => {
    for (const h of [9, 12, 18.4, 23]) {
      expect(gradeAt(h, { cloud: 1, rain: 0, storm: 0 }).sat).toBeLessThan(gradeAt(h).sat);
      const dv = gradeAt(h, { cloud: 0, rain: 1, storm: 0 }).vignette - gradeAt(h).vignette;
      expect(dv).toBeCloseTo(0.05, 3);
    }
  });

  it('is continuous in the weather inputs', () => {
    const keys: Array<keyof GradeWeather> = ['cloud', 'rain', 'storm'];
    let worst = 0;
    for (const h of [3, 7, 12, 18.4, 22]) {
      for (const k of keys) {
        for (let v = 0; v <= 0.99; v += 0.01) {
          const w = { cloud: 0.3, rain: 0.3, storm: 0.3, [k]: v };
          const w2 = { ...w, [k]: v + 0.01 };
          worst = Math.max(worst, maxDelta(gradeAt(h, w), gradeAt(h, w2)));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(0.01);
  });

  it('writes into an output grade when given one', () => {
    const out = gradeAt(0);
    const same = gradeAt(18.4, undefined, out);
    expect(same).toBe(out);
    expect(out).toEqual(gradeAt(18.4));
  });
});
