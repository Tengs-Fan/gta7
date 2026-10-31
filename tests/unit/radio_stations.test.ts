// The radio's stations: the dial, and what each music style plays over whole songs, calm and in a chase.

import { describe, expect, it } from 'vitest';
import { STATIONS } from '../../src/audio/radio';
import type { Kit } from '../../src/audio/stations/kit';
import { locate, type Beat, type Style } from '../../src/audio/stations/style';
import { Rng } from '../../src/core/rng';
import { SPEECH } from '../../src/sim/speech';

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

const MUSIC = STATIONS.filter((s) => s.style);

describe('radio stations', () => {
  it('run up the dial in frequency order, FM before AM, the talk stations last, with short tag lines and voiced idents', () => {
    const dial = STATIONS.map((s) => {
      const [, f, am] = /(\d+(?:\.\d+)?)( AM)?$/.exec(s.name)!;
      return { am: !!am, f: Number(f) };
    });
    for (let i = 1; i < dial.length; i++) {
      const [a, b] = [dial[i - 1]!, dial[i]!];
      expect(a.am && !b.am, STATIONS[i]!.name).toBe(false);
      if (a.am === b.am) expect(b.f, STATIONS[i]!.name).toBeGreaterThan(a.f);
    }
    expect(new Set(STATIONS.map((s) => s.name)).size).toBe(STATIONS.length);
    const talk = STATIONS.findIndex((s) => s.talk);
    expect(talk).toBeGreaterThan(0);
    for (const s of STATIONS.slice(talk)) expect(s.talk, s.name).toBeDefined();
    // A station on the AM band sounds like one.
    STATIONS.forEach((s, i) => expect(!!s.talk?.am, s.name).toBe(dial[i]!.am));
    expect(MUSIC.length).toBe(9);
    for (const s of STATIONS) expect(s.tag.length, s.name).toBeLessThanOrEqual(25);
    for (const s of MUSIC) expect(SPEECH.idents[s.name]?.length, s.name).toBeGreaterThan(0);
  });

  for (const st of MUSIC) {
    it(`${st.name}: every bar of a song plays, the song has a form, and a chase plays more`, () => {
      for (const seed of [1, 7, 42, 1234]) {
        const song = st.style!.song(new Rng(seed), st.style!.bpm[0]);
        expect(song.bars).toBe(song.form.reduce((n, [, b]) => n + b, 0));
        expect(new Set(song.form.map(([s]) => s))).toContain('b');
        const calm = voicesPerBar(st.style!, seed, 0);
        const chase = voicesPerBar(st.style!, seed, 1);
        // No silent bar: even an intro's first bar or a drop-out has something going on.
        expect(Math.min(...calm), `${st.name} seed ${seed}: quietest bar`).toBeGreaterThanOrEqual(3);
        const sum = (v: number[]) => v.reduce((a, x) => a + x, 0);
        expect(sum(chase), `${st.name} seed ${seed}`).toBeGreaterThan(sum(calm) * 1.1);
        // The same seed makes the same song.
        expect(voicesPerBar(st.style!, seed, 0)).toEqual(calm);
      }
    });
  }
});
