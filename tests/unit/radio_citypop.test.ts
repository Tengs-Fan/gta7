// The city-pop style's own rules (月光電台; radio_stations.test.ts checks its songs like every station's): a city-pop
// tempo, and every iii chord leading to vi, played dominant.

import { describe, expect, it } from 'vitest';
import { citypop } from '../../src/audio/stations/citypop';
import type { Kit } from '../../src/audio/stations/kit';
import { locate, note, type Beat } from '../../src/audio/stations/style';
import { Rng } from '../../src/core/rng';

describe('city pop', () => {
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
