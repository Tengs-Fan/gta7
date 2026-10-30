// The radio's stations: the dial, and what each music style plays over whole songs, calm and in a chase.

import { describe, expect, it } from 'vitest';
import { STATIONS } from '../../src/audio/radio';
import type { Kit } from '../../src/audio/stations/kit';
import { deepCut, HITS, hitSong } from '../../src/audio/stations/playlists';
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
  it('run up the dial in frequency order, the talk station last, with short tag lines and voiced idents', () => {
    const freqs = STATIONS.map((s) => Number(s.name.split(' ').at(-1)));
    for (let i = 1; i < freqs.length; i++) expect(freqs[i]!, STATIONS[i]!.name).toBeGreaterThan(freqs[i - 1]!);
    expect(new Set(STATIONS.map((s) => s.name)).size).toBe(STATIONS.length);
    expect(STATIONS.at(-1)!.genre).toBe('talk');
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

describe('the hits', () => {
  it('six per music station, each its own, titled in 40 characters or fewer, and deep cuts named in between', () => {
    expect(Object.keys(HITS).sort()).toEqual(MUSIC.map((s) => s.name).sort());
    const names = new Set<string>();
    for (const st of MUSIC) {
      const hits = HITS[st.name]!;
      expect(hits.length, st.name).toBe(6);
      expect(new Set(hits.map((h) => h.seed)).size, st.name).toBe(6);
      for (const h of hits) {
        expect(h.title.length, h.title).toBeLessThanOrEqual(40);
        names.add(`${h.artist} - ${h.title}`);
      }
      const r = new Rng(3);
      for (let i = 0; i < 300; i++) {
        const cut = deepCut(st.name, r);
        expect(cut.title.length, `${st.name}: ${cut.title}`).toBeLessThanOrEqual(40);
        expect(cut.artist.length, st.name).toBeGreaterThan(0);
      }
    }
    expect(names.size).toBe(MUSIC.length * 6);
  });

  for (const st of MUSIC) {
    it(`${st.name}: a hit is the same song every time it comes round, and passes the checks every song does`, () => {
      const style = st.style!;
      const songs = HITS[st.name]!.map((h) => hitSong(style, h.seed));
      for (const [i, h] of HITS[st.name]!.entries()) {
        const song = songs[i]!;
        expect(hitSong(style, h.seed)).toEqual(song);
        // The song of its seed (what voicesPerBar plays), at a tempo of the style's own.
        expect(song).toEqual({ ...style.song(new Rng(h.seed), style.bpm[0]), bpm: song.bpm });
        expect(song.bpm).toBeGreaterThanOrEqual(style.bpm[0]);
        expect(song.bpm).toBeLessThanOrEqual(style.bpm[1]);
        expect(new Set(song.form.map(([s]) => s))).toContain('b');
        const calm = voicesPerBar(style, h.seed, 0);
        const chase = voicesPerBar(style, h.seed, 1);
        expect(Math.min(...calm), `${h.title}: quietest bar`).toBeGreaterThanOrEqual(3);
        const sum = (v: number[]) => v.reduce((a, x) => a + x, 0);
        expect(sum(chase), h.title).toBeGreaterThan(sum(calm) * 1.1);
        expect(voicesPerBar(style, h.seed, 0)).toEqual(calm);
      }
      // The six differ from each other, in their chords, pattern, key or tempo.
      const looks = songs.map((s) => JSON.stringify([s.progA, s.progB, s.variant, s.root, Math.round(s.bpm)]));
      expect(new Set(looks).size).toBe(6);
    });
  }
});
