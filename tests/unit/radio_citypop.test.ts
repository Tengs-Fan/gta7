// The city-pop style (月光電台), checked like every station in radio_stations.test.ts until it joins the dial.

import { describe, expect, it } from 'vitest';
import { citypop } from '../../src/audio/stations/citypop';
import type { Kit } from '../../src/audio/stations/kit';
import { locate, note, type Beat, type Style } from '../../src/audio/stations/style';
import { Rng } from '../../src/core/rng';

/** A kit that only counts the voices a style asks for. */
function countingKit(): { kit: Kit; count: () => number } {
  let n = 0;
  const kit = new Proxy({}, { get: (_, key) => (key === 'pulse' ? () => ({}) : () => void n++) }) as unknown as Kit;
  return { kit, count: () => n };
}

/** Voices per bar over one whole song of `style` at chase intensity `k`. */
function voicesPerBar(style: Style, seed: number, k: number): number[] {
  const r = new Rng(seed);
  const song = style.song(r, style.bpm[0]);
  const { kit, count } = countingKit();
  const b: Beat = { t: 0, sd: 60 / song.bpm / 4, step: 0, bar: 0, section: 'intro', sbar: 0, top: false, fill: false, chord: 0, nextChord: 0, k, r };
  const bars: number[] = [];
  for (let bar = 0; bar < song.bars; bar++) {
    const before = count();
    locate(b, song, bar);
    for (let step = 0; step < 16; step++) {
      b.step = step;
      b.t = (bar * 16 + step) * b.sd;
      style.step(kit, song, b);
    }
    bars.push(count() - before);
  }
  return bars;
}

describe('city pop', () => {
  it('every bar of a song plays, the song has a form, and a chase plays more', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const song = citypop.song(new Rng(seed), citypop.bpm[0]);
      expect(song.bars).toBe(song.form.reduce((n, [, b]) => n + b, 0));
      expect(new Set(song.form.map(([s]) => s))).toContain('b');
      const calm = voicesPerBar(citypop, seed, 0);
      const chase = voicesPerBar(citypop, seed, 1);
      expect(Math.min(...calm), `seed ${seed}: quietest bar`).toBeGreaterThanOrEqual(3);
      const sum = (v: number[]) => v.reduce((a, x) => a + x, 0);
      expect(sum(chase), `seed ${seed}`).toBeGreaterThan(sum(calm) * 1.1);
      expect(voicesPerBar(citypop, seed, 0)).toEqual(calm);
    }
  });

  it('plays at a city-pop tempo, and every iii chord leads to vi, where the keys play it dominant', () => {
    expect(citypop.bpm[0]).toBeGreaterThanOrEqual(100);
    expect(citypop.bpm[1]).toBeLessThanOrEqual(118);
    for (let seed = 0; seed < 200; seed++) {
      const song = citypop.song(new Rng(seed), citypop.bpm[0]);
      for (const prog of [song.progA, song.progB]) {
        prog.forEach((c, i) => {
          if (c === 2) expect(prog[i + 1], `seed ${seed}: ${prog.join(' ')}`).toBe(5);
        });
      }
    }
    // Seed 2's verse is IV, iii, vi, I: over the iii bar the keys sound a major third above its root, not a minor one.
    const r = new Rng(2);
    const song = citypop.song(r, citypop.bpm[0]);
    expect(song.progA).toContain(2);
    const pcs = new Set<number>();
    const kit = new Proxy({}, { get: (_, key) => (key === 'epiano' ? (_t: number, f: number) => void pcs.add(Math.round(12 * Math.log2(f / 440) + 69) % 12) : () => {}) }) as unknown as Kit;
    const b: Beat = { t: 0, sd: 0.13, step: 0, bar: 0, section: 'intro', sbar: 0, top: false, fill: false, chord: 0, nextChord: 0, k: 0, r };
    const bar = 4 + song.progA.indexOf(2);
    locate(b, song, bar);
    for (let step = 0; step < 14; step++) {
      b.step = step;
      citypop.step(kit, song, b);
    }
    const root = note(song, 2, 0) % 12;
    expect(pcs.has((root + 4) % 12)).toBe(true);
    expect(pcs.has((root + 3) % 12)).toBe(false);
  });
});
