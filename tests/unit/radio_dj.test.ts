// The music stations' DJs and hits (src/audio/djProgramme.ts, stations/playlists.ts, the music side of radio.ts): the
// programme's rules, every recorded link fitting its station's intro, and the radio against a fake context: the hit on
// air, the duck under a link, and a talk-up whose last word lands on the A section's first downbeat.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHASE_INTENSITY, DjProgramme, introSeconds, LINK_MARGIN, type DjItem, type DjScene } from '../../src/audio/djProgramme';
import { INTENSITY_TEMPO, Radio, STATIONS } from '../../src/audio/radio';
import { HITS, hitSong } from '../../src/audio/stations/playlists';
import { synthwave } from '../../src/audio/stations/synthwave';
import type { Beat, Song } from '../../src/audio/stations/style';
import { Rng } from '../../src/core/rng';
import { SPEECH } from '../../src/sim/speech';

const MUSIC = STATIONS.filter((s) => s.style);
const NEON = 'NEON DRIVE 88.7';

/** A plain afternoon boundary: a deep cut coming, a deep cut ending, all the room in the world. */
const PLAIN: DjScene = { hit: null, back: null, room: 60, hours: 15, weather: 'clear', intensity: 0, gotAway: false };

const isLink = (i: DjItem | null) => i !== null && i.kind !== 'ident';

describe('the DJ programme', () => {
  it('is seeded: the same seed and scenes say the same things', () => {
    const run = (seed: number) => {
      const p = new DjProgramme(NEON, seed);
      const r = new Rng(9);
      return Array.from({ length: 200 }, () => p.next({ ...PLAIN, hit: r.chance(0.5) ? r.int(0, 5) : null, back: r.chance(0.5) ? r.int(0, 5) : null, hours: r.range(0, 24) }));
    };
    expect(run(3)).toEqual(run(3));
    expect(run(3)).not.toEqual(run(4));
  });

  it('says nothing at about 45 % of song boundaries, an ident at 20 % and a link at 35 %, never two links running', () => {
    for (const st of MUSIC) {
      const p = new DjProgramme(st.name, 11);
      const items = Array.from({ length: 4000 }, () => p.next(PLAIN));
      const share = (f: (i: DjItem | null) => boolean) => items.filter(f).length / items.length;
      expect(share((i) => i === null), st.name).toBeCloseTo(0.45, 1);
      expect(share((i) => i?.kind === 'ident'), st.name).toBeCloseTo(0.2, 1);
      expect(share(isLink), st.name).toBeCloseTo(0.35, 1);
      for (let i = 1; i < items.length; i++) expect(isLink(items[i]!) && isLink(items[i - 1]!), `${st.name} boundary ${i}`).toBe(false);
    }
  });

  it('plays every clip of a pool before any comes round again', () => {
    for (const st of MUSIC) {
      const p = new DjProgramme(st.name, 5);
      const items = Array.from({ length: 600 }, () => p.next(PLAIN));
      for (const [kind, pool] of [
        ['banter', SPEECH.dj[st.name]!.banter!],
        ['ident', SPEECH.idents[st.name]!],
      ] as const) {
        const said = items.filter((i) => i?.kind === kind).map((i) => i!.clip);
        expect(new Set(said.slice(0, pool.length)), `${st.name} ${kind}`).toEqual(new Set(pool));
      }
    }
  });

  it('talks about the moment when it applies: a chase, then a getaway, then the rain, then the night', () => {
    const kinds = (s: Partial<DjScene>) => {
      const p = new DjProgramme(NEON, 2);
      return new Set(Array.from({ length: 300 }, () => p.next({ ...PLAIN, hit: 1, back: 2, ...s })).filter(isLink).map((i) => i!.kind));
    };
    expect(kinds({})).toEqual(new Set(['banter', 'front', 'back']));
    expect(kinds({ intensity: CHASE_INTENSITY + 0.1, gotAway: true, weather: 'storm', hours: 23 })).toEqual(new Set(['chase']));
    expect(kinds({ intensity: CHASE_INTENSITY, gotAway: true, weather: 'storm', hours: 23 })).toEqual(new Set(['gotAway']));
    expect(kinds({ weather: 'rain', hours: 2 })).toEqual(new Set(['rain']));
    expect(kinds({ hours: 22.5 })).toEqual(new Set(['night']));
    expect(kinds({ hours: 4.9 })).toEqual(new Set(['night']));
    expect(kinds({ hours: 5, weather: 'overcast' })).toEqual(new Set(['banter', 'front', 'back']));
    // A hit's announce is its own; the back-announce is the hit that just played.
    const p = new DjProgramme(NEON, 2);
    for (let i = 0; i < 300; i++) {
      const item = p.next({ ...PLAIN, hit: 4, back: 2 });
      if (item?.kind === 'front') expect(item.clip).toBe(SPEECH.tracks[NEON]![4]!.front);
      if (item?.kind === 'back') expect(item.clip).toBe(SPEECH.tracks[NEON]![2]!.back);
    }
  });

  it('skips a link longer than the intro it would play over', () => {
    const shortest = Math.min(...Object.values(SPEECH.dj[NEON]!).flat().map((id) => SPEECH.clips[id]!));
    const p = new DjProgramme(NEON, 8);
    const items = Array.from({ length: 400 }, () => p.next({ ...PLAIN, room: shortest - 0.01 }));
    expect(items.filter(isLink)).toEqual([]);
    expect(items.some((i) => i?.kind === 'ident')).toBe(true);
    expect(p.link('banter', { ...PLAIN, room: shortest - 0.01 })).toBeNull();
    expect(p.link('banter', PLAIN)).not.toBeNull();
    // No announce for a deep cut.
    expect(p.link('front', PLAIN)).toBeNull();
  });
});

describe('the DJs on record', () => {
  /** Seconds a link may fill over `song`'s intro at intensity `k`. */
  const room = (song: Song, k: number) => introSeconds(song, song.bpm * (1 + INTENSITY_TEMPO * k)) - LINK_MARGIN;

  it("fit their station's fastest intro: chase lines at five stars, the rest at two, a hit's announce over its own intro", () => {
    for (const st of MUSIC) {
      const style = st.style!;
      // Every style opens with the same 4-bar intro the room is reckoned on.
      expect(style.song(new Rng(1), style.bpm[0]).form[0], st.name).toEqual(['intro', 4]);
      const fastest = style.song(new Rng(1), style.bpm[1]);
      const fits = (id: string, r: number) => expect(SPEECH.clips[id], `${st.name} ${id} (${r.toFixed(2)} s free)`).toBeLessThanOrEqual(r);
      for (const [kind, ids] of Object.entries(SPEECH.dj[st.name]!)) for (const id of ids) fits(id, room(fastest, kind === 'chase' ? 1 : CHASE_INTENSITY));
      HITS[st.name]!.forEach((hit, i) => {
        const t = SPEECH.tracks[st.name]![i]!;
        fits(t.front, room(hitSong(style, hit.seed), CHASE_INTENSITY));
        fits(t.back, room(fastest, CHASE_INTENSITY));
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The radio against a fake context: AudioParams keep their automation, so a gain can be read at any time.

type Ev = { t: number; kind: 'set' | 'target'; v: number; tc: number };

class FParam {
  value: number;
  readonly events: Ev[] = [];
  constructor(private readonly base = 0) {
    this.value = base;
  }
  setValueAtTime(v: number, t: number): this {
    this.events.push({ t, kind: 'set', v, tc: 0 });
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, t: number, tc: number): this {
    this.events.push({ t, kind: 'target', v, tc });
    return this;
  }
  cancelScheduledValues(t: number): this {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.t >= t) this.events.splice(i, 1);
    return this;
  }
  /** The value at context time `t` from its set and target events. */
  at(t: number): number {
    let start = this.base;
    let seg: Ev | null = null;
    const valueAt = (x: number) => (seg?.kind === 'target' ? seg.v + (start - seg.v) * Math.exp(-(x - seg.t) / seg.tc) : start);
    for (const e of [...this.events].sort((a, b) => a.t - b.t)) {
      if (e.t > t) break;
      const v0 = valueAt(e.t);
      seg = e;
      start = e.kind === 'set' ? e.v : v0;
    }
    return valueAt(t);
  }
}

class FNode {
  readonly outputs: unknown[] = [];
  readonly listeners: Array<() => void> = [];
  onended: (() => void) | null = null;
  buffer: { duration: number } | null = null;
  startAt = -1;
  stopAt = Infinity;
  readonly gain = new FParam(1);
  readonly frequency = new FParam(350);
  readonly Q = new FParam(1);
  readonly detune = new FParam(0);
  readonly delayTime = new FParam(0);
  readonly playbackRate = new FParam(1);
  type = '';
  curve: unknown = null;
  connect<T>(d: T): T {
    this.outputs.push(d);
    return d;
  }
  disconnect(): void {}
  setPeriodicWave(): void {}
  addEventListener(_: 'ended', f: () => void): void {
    this.listeners.push(f);
  }
  start(t = 0, offset = 0): void {
    this.startAt = t;
    if (this.buffer) this.stopAt = Math.min(this.stopAt, t + this.buffer.duration - offset);
  }
  stop(t = 0): void {
    this.stopAt = Math.min(this.stopAt, t);
  }
}

class FContext {
  currentTime = 5;
  readonly sampleRate = 8000;
  readonly made: FNode[] = [];
  readonly destination = new FNode();
  private node(): FNode {
    const n = new FNode();
    this.made.push(n);
    return n;
  }
  createGain = () => this.node();
  createBiquadFilter = () => this.node();
  createOscillator = () => this.node();
  createBufferSource = () => this.node();
  createDelay = () => this.node();
  createWaveShaper = () => this.node();
  createPeriodicWave = () => ({});
  createBuffer = () => ({ duration: 1, getChannelData: () => new Float32Array(8000) });
  /** A clip decodes to a buffer as long as the speech index says (the fake fetch hands over its URL). */
  decodeAudioData(url: string): Promise<{ duration: number }> {
    return Promise.resolve({ duration: SPEECH.clips[/([^/]+)\.mp3$/.exec(url)![1]!]! });
  }
  /** Ends every source whose stop time has passed, as a real context does. */
  endSources(): void {
    for (const n of this.made) {
      if (n.startAt >= 0 && n.stopAt <= this.currentTime && (n.onended || n.listeners.length)) {
        n.onended?.();
        for (const f of n.listeners.splice(0)) f();
        n.onended = null;
      }
    }
  }
}

type Inner = {
  music: FNode;
  echoSend: FNode;
  bank: { get(id: string): unknown; preload(ids: string[]): void };
  upNext: { item: DjItem | null };
  scene(next: Inner['upNext']): DjScene;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A radio in a car on NEON DRIVE (the first station), its clips fetched by a fake that knows their lengths. */
async function rig() {
  vi.stubGlobal('fetch', (url: string) => Promise.resolve({ arrayBuffer: () => Promise.resolve(url) }));
  const ctx = new FContext();
  const radio = new Radio();
  radio.init(ctx as unknown as AudioContext, ctx.destination as unknown as AudioNode, ctx.createBuffer() as unknown as AudioBuffer);
  const frames = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      ctx.currentTime += 1 / 60;
      radio.update(1 / 60, true);
      ctx.endSources();
    }
  };
  frames(0.1);
  await flush();
  return { ctx, radio, inner: radio as unknown as Inner, frames };
}

/** Cuts to the song of `seed` with a link of `kind` over its intro; returns the link's clip and source. */
async function talkUp(r: Awaited<ReturnType<typeof rig>>, kind: 'banter' | 'front', seed: number) {
  const item = await r.radio.cueSong(seed, kind);
  expect(item?.kind).toBe(kind);
  const clip = item!.clip;
  await flush();
  const src = r.ctx.made.find((n) => n.buffer?.duration === SPEECH.clips[clip] && n.startAt >= 0)!;
  return { clip, src };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the radio, music side', () => {
  it('names the song on air, a hit by its seed, and counts each new song', async () => {
    const { radio } = await rig();
    expect(radio.nowPlaying).not.toBeNull();
    const n = radio.songSerial;
    await radio.cueSong(HITS[NEON]![3]!.seed);
    expect(radio.nowPlaying).toEqual({ artist: HITS[NEON]![3]!.artist, title: HITS[NEON]![3]!.title, hit: 3 });
    expect(radio.songSerial).toBe(n + 1);
    await radio.cueSong();
    expect(radio.songSerial).toBe(n + 2);
    await radio.cueSong(424242);
    expect(radio.nowPlaying).toEqual({ artist: 'Seed', title: '424242', hit: null });
    radio.next();
    expect(radio.nowPlaying).toBeNull();
  });

  it('ducks the music under a link and brings it back up, and drops the clip from the bank once it has played', async () => {
    const r = await rig();
    const { clip, src } = await talkUp(r, 'banter', HITS[NEON]![0]!.seed);
    const len = SPEECH.clips[clip]!;
    const g = r.inner.music.gain;
    expect(g.at(src.startAt - 0.6)).toBeCloseTo(1, 2);
    expect(g.at(src.startAt)).toBeLessThan(0.5);
    expect(g.at(src.startAt + len / 2)).toBeCloseTo(0.45, 2);
    expect(g.at(src.startAt + len + 0.5)).toBeCloseTo(1, 2);
    // The voice goes straight out, not under the duck.
    expect(r.inner.music.outputs).not.toContain(src);
    expect(r.inner.bank.get(clip)).toBeDefined();
    r.frames(src.startAt + len + 0.2 - r.ctx.currentTime);
    expect(r.inner.bank.get(clip)).toBeUndefined();
  });

  it('lets the music straight back up when the station changes under a link', async () => {
    const r = await rig();
    const { src } = await talkUp(r, 'banter', HITS[NEON]![1]!.seed);
    r.frames(src.startAt + 0.5 - r.ctx.currentTime);
    expect(r.inner.music.gain.at(r.ctx.currentTime)).toBeLessThan(0.5);
    r.radio.next();
    expect(r.inner.music.gain.at(r.ctx.currentTime + 0.3)).toBeCloseTo(1, 2);
    expect(src.stopAt).toBeLessThanOrEqual(r.ctx.currentTime);
  });

  it("at no stars, a hit's talk-up ends on the A section's first downbeat", async () => {
    for (const i of [0, 2, 5]) {
      const r = await rig();
      const hit = HITS[NEON]![i]!;
      const downbeats: number[] = [];
      const step = synthwave.step;
      vi.spyOn(synthwave, 'step').mockImplementation((kit, s, b: Beat) => {
        if (b.section === 'a' && b.sbar === 0 && b.step === 0) downbeats.push(b.t);
        step(kit, s, b);
      });
      const { clip, src } = await talkUp(r, 'front', hit.seed);
      expect(clip).toBe(SPEECH.tracks[NEON]![i]!.front);
      r.frames(12);
      expect(downbeats.length).toBeGreaterThan(0);
      console.log(`[dj] ${hit.artist}: talk-up ends ${(1000 * (src.startAt + SPEECH.clips[clip]! - downbeats[0]!)).toFixed(1)} ms from the downbeat`);
      expect(Math.abs(src.startAt + SPEECH.clips[clip]! - downbeats[0]!)).toBeLessThan(0.05);
      vi.restoreAllMocks();
    }
  });

  it('drops a link loaded for a song that is not coming when the station changes, also one still loading then', async () => {
    const r = await rig();
    const clip = SPEECH.dj[NEON]!.banter![2]!;
    r.inner.upNext.item = { kind: 'banter', clip };
    r.inner.bank.preload([clip]);
    await flush();
    expect(r.inner.bank.get(clip)).toBeDefined();
    r.radio.next();
    r.frames(0.1);
    await flush();
    expect(r.inner.bank.get(clip)).toBeUndefined();
    // Back on NEON DRIVE, and off again before the link's fetch comes back.
    const held: Array<() => void> = [];
    vi.stubGlobal('fetch', (url: string) => new Promise((res) => held.push(() => res({ arrayBuffer: () => Promise.resolve(url) }))));
    r.radio.prev();
    r.frames(0.1);
    const late = SPEECH.dj[NEON]!.banter![3]!;
    r.inner.upNext.item = { kind: 'banter', clip: late };
    r.inner.bank.preload([late]);
    r.radio.next();
    r.frames(0.1);
    for (const f of held) f();
    await flush();
    expect(r.inner.bank.get(late)).toBeUndefined();
  });

  it('hears a getaway when the stars clear from two or more, not as a wasted or busted player comes back or off the game', async () => {
    const r = await rig();
    // As audio.ts does each frame: the wanted level, then the scene.
    const frame = (wanted: number, down: boolean) => {
      r.radio.setWanted(wanted);
      r.radio.setScene(15, 'clear', down);
    };
    const gotAway = () => r.inner.scene(r.inner.upNext).gotAway;
    // Busted at three stars: the sim clears the stars in the step that brings the player back, so he is up again then.
    frame(3, true);
    frame(0, false);
    expect(gotAway()).toBe(false);
    // Quit to the title at three stars: off the game is down.
    frame(3, false);
    frame(0, true);
    expect(gotAway()).toBe(false);
    frame(3, false);
    frame(0, false);
    expect(gotAway()).toBe(true);
  });

  it("sends Captain Reverb's links round DOCKSIDE DUB's echo", async () => {
    const r = await rig();
    while (r.radio.stationName !== 'DOCKSIDE DUB 92.3') r.radio.next();
    r.frames(0.1);
    const { src } = await talkUp(r, 'banter', HITS['DOCKSIDE DUB 92.3']![0]!.seed);
    const voice = src.outputs[0] as FNode;
    expect(voice.outputs).toContain(r.inner.echoSend);
  });
});
