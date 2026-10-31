// Procedural radio: ten music stations generating endless music with a WebAudio lookahead scheduler, and the talk
// stations (talk.ts), in dial order. Each music station is a style (stations/): it seeds songs (key, progressions,
// motifs, a pattern variant) and plays each sixteenth of a song's form (intro, A, B, A again, outro; some add a
// breakdown) on a shared instrument kit with a tempo echo and a small reverb. The music follows the wanted level: an
// intensity value glides toward the level's target, lifts the tempo a little and drives each style's own chase
// behaviour; at 0 the music is exactly the calm original. A station's songs come round from a rotation of its hits
// (stations/playlists.ts) and deep cuts, and its DJ (djProgramme.ts) talks over some intros, the music ducked under
// the voice.

import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import { SPEECH, type LinkKind } from '../sim/speech';
import type { WeatherKind } from '../sim/weather';
import { DjProgramme, introSeconds, LINK_MARGIN, type DjItem, type DjScene } from './djProgramme';
import { playClip, SpeechBank } from './speech';
import { boombap } from './stations/boombap';
import { chiptune } from './stations/chiptune';
import { citypop } from './stations/citypop';
import { country } from './stations/country';
import { dnb } from './stations/dnb';
import { dub } from './stations/dub';
import { house } from './stations/house';
import { Kit } from './stations/kit';
import { lounge } from './stations/lounge';
import { deepCut, HITS, hitSong } from './stations/playlists';
import { locate, type Beat, type Song, type Style } from './stations/style';
import { surf } from './stations/surf';
import { synthwave } from './stations/synthwave';
import type { NodeTally } from './tally';
import { AZURA_FORMAT, Bag, HOST_BED, TalkProgramme, TalkShow, type TalkFormat, type TalkSegment } from './talk';

export interface StationDef {
  name: string;
  genre: string;
  /** The line under the name when the station is tuned. */
  tag: string;
  /** The language of the station's name, tag and songs when it is not English (the HUD marks them with it). */
  lang?: string;
  /** The music; null on a talk station. */
  style: Style | null;
  /** A talk station's show. */
  talk?: TalkFormat;
}

/**
 * SAPR 107.3, San Azura Public Radio: Reginald Ashcombe-Pryce's review, Pru's garden line, the next chapter of Harbor
 * Lights and a pledge break in turn, over a soft triangle pad; the serial plays over rain, the underwriting over a pad
 * that breathes. Its jingle climbs a tenth and settles.
 */
export const SAPR_FORMAT: TalkFormat = {
  show: 'sapr',
  slots: [['host'], ['call'], ['serial'], ['news']],
  adChance: 0.3,
  bed: { ...AZURA_FORMAT.bed, type: 'triangle', cutoff: 900 },
  beds: { serial: { ...AZURA_FORMAT.bed, level: 0, noise: { filters: [['highpass', 300], ['lowpass', 1400]], level: HOST_BED } } },
  adBed: { ...AZURA_FORMAT.bed, cutoff: 800, tremolo: 1.5 },
  bells: [0, 7, 16, 12],
};

/**
 * THE BOWL 1090 AM: Big Ron's rant, two callers and the sports desk in turn, over a low pad and a crowd that swells
 * and falls; its jingle is a stadium organ's charge.
 */
export const BOWL_FORMAT: TalkFormat = {
  show: 'bowl',
  slots: [['host'], ['call'], ['call'], ['news']],
  adChance: 0.6,
  bed: { ...AZURA_FORMAT.bed, cutoff: 600, noise: { filters: [['bandpass', 700, 0.8]], level: 0.03, swell: 0.1 } },
  adBed: AZURA_FORMAT.adBed,
  bells: [0, 7, 12, 7, 12],
  am: true,
};

/**
 * STATIC 1260 AM, Beyond the Bay: Lyle Truett's theory, a caller, another theory, another caller and the Signal in
 * turn, over a pad that wavers like a theremin and a low wind; its jingle falls through a tritone.
 */
export const STATIC_FORMAT: TalkFormat = {
  show: 'static',
  slots: [['host'], ['call'], ['host'], ['call'], ['news']],
  adChance: 0.4,
  bed: { ...AZURA_FORMAT.bed, vibrato: { hz: 5.5, cents: 25 }, noise: { filters: [['bandpass', 450, 1.2]], level: 0.06, swell: 0.06 } },
  adBed: AZURA_FORMAT.adBed,
  bells: [12, 11, 6, 0],
  am: true,
};

export const STATIONS: readonly StationDef[] = [
  {
    name: 'NEON DRIVE 88.7',
    genre: 'synthwave',
    tag: 'Synthwave after dark',
    style: synthwave,
  },
  {
    name: 'VELVET 89.9',
    genre: 'lounge',
    tag: 'Lounge, music to wait to',
    style: lounge,
  },
  {
    name: 'DOCKSIDE DUB 92.3',
    genre: 'dub',
    tag: 'Dub from the Docks',
    style: dub,
  },
  {
    name: '月光電台 95.3',
    genre: 'citypop',
    tag: '城市流行，陪你到天亮',
    lang: 'zh-Hant',
    style: citypop,
  },
  {
    name: 'PULSE 96.1',
    genre: 'house',
    tag: 'House all night',
    style: house,
  },
  {
    name: 'COYOTE 97.7',
    genre: 'country',
    tag: 'Outlaw country',
    style: country,
  },
  {
    name: 'WIPEOUT 99.5',
    genre: 'surf',
    tag: 'Surf rock, Ocean Beach',
    style: surf,
  },
  {
    name: 'BOOM BAP 101.3',
    genre: 'boombap',
    tag: 'Golden-era hip hop',
    style: boombap,
  },
  {
    name: 'BREAKNECK 102.7',
    genre: 'dnb',
    tag: 'Drum and bass, jungle',
    style: dnb,
  },
  {
    name: 'PIXEL 103.9',
    genre: 'chiptune',
    tag: '8-bit chiptune',
    style: chiptune,
  },
  { name: 'AZURA TALK 104.5', genre: 'talk', tag: 'Talk, news, nonsense', style: null, talk: AZURA_FORMAT },
  { name: 'SAPR 107.3', genre: 'talk', tag: 'Calm voices. Pledge now.', style: null, talk: SAPR_FORMAT },
  { name: 'THE BOWL 1090 AM', genre: 'talk', tag: 'Sports talk, zero wins', style: null, talk: BOWL_FORMAT },
  { name: 'STATIC 1260 AM', genre: 'talk', tag: "It's always 3 AM here", style: null, talk: STATIC_FORMAT },
];

/** AZURA TALK's place on the dial: the talk station the tools act on while no talk station is tuned. */
const AZURA = STATIONS.findIndex((s) => s.talk === AZURA_FORMAT);

/** Music intensity for a wanted level (0-5 stars): non-decreasing, 0 at no stars, 1 at five. */
export function wantedIntensity(level: number): number {
  return clamp(Math.floor(level), 0, 5) / 5;
}

/** Seconds (time constants) the intensity takes to rise toward a higher level and fall back toward a lower one. */
export const INTENSITY_RISE = 1;
export const INTENSITY_FALL = 3;
/** Tempo lift at full intensity. */
export const INTENSITY_TEMPO = 0.08;

/** Output level of a playing station: 3 dB over unity, so the music sits over the engine. */
const RADIO_LEVEL = 1.41;
/** A station voice over a song's intro (an ident or a DJ's link), at the talk station's ident level. */
const IDENT_LEVEL = 0.46;
/** The music under a DJ's link (-7 dB), reached just before the first word. */
const DUCK = 0.45;
const DUCK_LEAD = 0.25;
/** The music starts back up this long before the link's clip ends, so it is most of the way up on the downbeat. */
const DUCK_RELEASE = 0.15;
/** Seconds after a chase of two stars or more clears that the DJ may still talk about the getaway. */
const GOT_AWAY = 60;
/** The station whose DJ (Captain Reverb) talks into the station's own echo. */
const ECHO_DJ = 'DOCKSIDE DUB 92.3';

/** The song on air: a hit (its index in the station's HITS) or a deep cut. */
export interface NowPlaying {
  artist: string;
  title: string;
  hit: number | null;
}

/** The reverb: four damped feedback delays in parallel (s, feedback), a short metallic room like a spring tank. */
const COMBS: readonly (readonly [number, number])[] = [
  [0.0297, 0.8],
  [0.0371, 0.78],
  [0.0411, 0.76],
  [0.0437, 0.74],
];

/** The AM band: two high-passes and two low-passes (24 dB per octave each side), and a faint hiss (about -67 dBFS, 40 dB under the voice). */
export const AM_LOW = 150;
export const AM_HIGH = 4500;
const HISS_LEVEL = 0.0016;

export class Radio {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private noise!: AudioBuffer;
  private delay!: DelayNode;
  private echoFeedback!: GainNode;
  private kit!: Kit;
  private index = 0;
  private active = false;
  private paused = false;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private song: Song | null = null;
  private style: Style | null = null;
  private rng = new Rng(Date.now() & 0xffff);
  /** The step being played, handed to the style (one object, refilled each sixteenth). */
  private readonly beat: Beat = { t: 0, sd: 0, step: 0, bar: 0, section: 'intro', sbar: 0, top: false, fill: false, chord: 0, nextChord: 0, k: 0, r: this.rng };
  private intensityValue = 0;
  private intensityTarget = 0;
  /** The talk stations' programmes by dial index, made when first asked for: all live, on the one clock. */
  private readonly programmes = new Map<number, TalkProgramme>();
  private seed = 0;
  private talk: TalkShow | null = null;
  /** The talk show's output, into the radio's output straight or through the AM band. */
  private talkOut!: GainNode;
  private amIn!: AudioNode;
  private onAm = false;
  private hissIn!: AudioNode;
  private hiss: AudioBufferSourceNode | null = null;
  private bank!: SpeechBank;
  private tally?: NodeTally;
  /** The station voice's ident on air, cut when the station changes. */
  private ident: AudioBufferSourceNode | null = null;
  /** Context time of the talk programmes' start: the stations are live whether or not anyone listens. */
  private epoch = 0;
  /** The music (the kit, its echo and reverb) into the output: ducked under a DJ's link. */
  private music!: GainNode;
  private echoSend!: GainNode;
  /** Each music station's rotation (its hits and as many deep-cut tokens) and its DJ, by station name. */
  private readonly rotations: Record<string, Bag> = {};
  private readonly djs: Record<string, DjProgramme> = {};
  private onAir: NowPlaying | null = null;
  /** The bar the song on air started at (tuning in joins a song mid-form). */
  private songFrom = 0;
  /** The song after this one, composed ahead, and what the DJ will say over its intro (loading meanwhile). */
  private upNext: { song: Song; track: NowPlaying; item: DjItem | null } | null = null;
  /** Songs started so far: the HUD shows each new one. */
  songSerial = 0;
  private wanted = 0;
  private lastWanted = 0;
  private lastDown = false;
  private hours = 12;
  private weather: WeatherKind = 'clear';
  /** Context time the stars last cleared after a chase of two or more. */
  private clearedAt = -Infinity;

  /** How hard the music drives (0 calm .. 1 five stars), gliding toward the wanted level's target. */
  get intensity(): number {
    return this.intensityValue;
  }

  /** The wanted level the music follows. */
  setWanted(level: number): void {
    this.intensityTarget = wantedIntensity(level);
    this.lastWanted = this.wanted;
    this.wanted = level;
  }

  /**
   * What the DJs talk about: the time of day and the weather, and a getaway when the stars clear (after setWanted) from
   * two or more while the player is up, and was the frame before: wasted or busted is no getaway, and the sim clears the
   * stars in the step that brings him back. Off the game (the title) counts as down.
   */
  setScene(hours: number, weather: WeatherKind, down: boolean): void {
    this.hours = hours;
    this.weather = weather;
    if (this.lastWanted >= 2 && this.wanted === 0 && !down && !this.lastDown) this.clearedAt = this.ctx!.currentTime;
    this.lastDown = down;
  }

  /** The song on the tuned music station (null off the music stations, and until a tuned station's song starts). */
  get nowPlaying(): NowPlaying | null {
    return this.song ? this.onAir : null;
  }

  /**
   * Cuts to the next song now, as if this one had ended (tools and tests; the owner auditions with it). With a seed, that
   * song is the one the seed composes, as a hit's (named as the station's hit with that seed, if there is one); with a
   * link kind, the DJ says a link of that kind over its intro, and the cut waits for the clip to load. Resolves to what
   * the DJ says over the intro (null for nothing, or off the music stations).
   */
  async cueSong(seed?: number, link?: LinkKind): Promise<DjItem | null> {
    const up = this.upNext;
    if (!this.song || !up) return null;
    const name = STATIONS[this.index]!.name;
    if (seed !== undefined) {
      const hit = HITS[name]!.findIndex((h) => h.seed === seed);
      up.song = hitSong(this.style!, seed);
      up.track = hit >= 0 ? { artist: HITS[name]![hit]!.artist, title: HITS[name]![hit]!.title, hit } : { artist: 'Seed', title: String(seed), hit: null };
      up.item = null;
    }
    if (link) {
      up.item = this.djs[name]!.link(link, this.scene(up));
      if (up.item) await this.bank.load(up.item.clip);
    }
    this.step = 0;
    this.bar = 0;
    this.startSong(true);
    return up.item;
  }

  /** The tuned station is a talk station. */
  get talkTuned(): boolean {
    return !!STATIONS[this.index]?.talk;
  }

  /** The programme of the talk station at dial index `i`. */
  private programmeOf(i: number): TalkProgramme {
    let p = this.programmes.get(i);
    if (!p) this.programmes.set(i, (p = new TalkProgramme(this.seed ^ Math.imul(i + 1, 0x9e3779b1), STATIONS[i]!.talk)));
    return p;
  }

  /** The programme of the tuned talk station, or AZURA TALK's while none is tuned (null before init). */
  private get programme(): TalkProgramme | null {
    return this.ctx ? this.programmeOf(this.talkTuned ? this.index : AZURA) : null;
  }

  /** Where the talk programme is: its clock and the segment on air (whether or not it is tuned). */
  talkInfo(): { time: number; segment: TalkSegment | null; rendering: TalkSegment | null } {
    const prog = this.programme;
    if (!prog) return { time: 0, segment: null, rendering: null };
    const time = this.ctx!.currentTime - this.epoch;
    return { time, segment: prog.at(time), rendering: this.talk?.segment ?? null };
  }

  /**
   * Moves the talk programmes' clock to just after the start of the programme's next segment of `kind` (tools and
   * tests: the show otherwise runs on as broadcast). Returns that segment.
   */
  cueTalk(kind: TalkSegment['kind'], into = 0.05): TalkSegment | null {
    const prog = this.programme;
    if (!prog) return null;
    const now = this.ctx!.currentTime - this.epoch;
    prog.at(now + 900);
    const seg = prog.segments.find((s) => s.kind === kind && s.start > now);
    if (!seg) return null;
    this.epoch = this.ctx!.currentTime - seg.start - into;
    return seg;
  }

  /** The talk programme (its schedule), for tests and tools. */
  get talkProgramme(): TalkProgramme | null {
    return this.programme;
  }

  get stationName(): string {
    return this.index < STATIONS.length ? STATIONS[this.index]!.name : 'RADIO OFF';
  }

  /** A station is playing (in a car, not paused, not switched off). */
  get playing(): boolean {
    return this.active;
  }

  /** One sample: notes start this long after their envelope's first event. */
  private get sample(): number {
    return 1 / this.ctx!.sampleRate;
  }

  init(ctx: AudioContext, dest: AudioNode, noise: AudioBuffer, tally?: NodeTally): void {
    this.ctx = ctx;
    this.noise = noise;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    // Tuning in for the first time lands somewhere in the first minute of the show.
    this.epoch = ctx.currentTime - Math.random() * 60;
    this.talkOut = ctx.createGain();
    this.talk = new TalkShow(ctx, this.talkOut, noise, tally);
    this.talkOut.connect(this.out);
    const am = (['highpass', 'highpass', 'lowpass', 'lowpass'] as const).map((type) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = type === 'highpass' ? AM_LOW : AM_HIGH;
      return f;
    });
    am.forEach((f, i) => f.connect(am[i + 1] ?? this.out));
    this.amIn = am[0]!;
    const hissBand = ctx.createBiquadFilter();
    hissBand.type = 'bandpass';
    hissBand.frequency.value = 3000;
    hissBand.Q.value = 0.7;
    const hissGain = ctx.createGain();
    hissGain.gain.value = HISS_LEVEL;
    hissBand.connect(hissGain);
    hissGain.connect(this.out);
    this.hissIn = hissBand;
    this.bank = new SpeechBank(ctx);
    this.tally = tally;
    this.delay = ctx.createDelay(1.5);
    this.echoFeedback = ctx.createGain();
    this.echoFeedback.gain.value = 0.32;
    const dl = ctx.createBiquadFilter();
    dl.type = 'lowpass';
    dl.frequency.value = 2500;
    const echoSend = ctx.createGain();
    echoSend.gain.value = 0.35;
    echoSend.connect(this.delay);
    this.delay.connect(dl);
    dl.connect(this.echoFeedback);
    this.echoFeedback.connect(this.delay);
    const verbSend = ctx.createGain();
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.22;
    for (const [time, feedback] of COMBS) {
      const d = ctx.createDelay(0.1);
      d.delayTime.value = time;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 3200;
      const fb = ctx.createGain();
      fb.gain.value = feedback;
      verbSend.connect(d);
      d.connect(damp);
      damp.connect(fb);
      fb.connect(d);
      damp.connect(verbOut);
    }
    this.echoSend = echoSend;
    this.music = ctx.createGain();
    this.music.connect(this.out);
    dl.connect(this.music);
    verbOut.connect(this.music);
    this.kit = new Kit(ctx, this.music, noise, echoSend, verbSend);
  }

  next(): string {
    this.index = (this.index + 1) % (STATIONS.length + 1);
    this.switched();
    return this.stationName;
  }

  prev(): string {
    this.index = (this.index + STATIONS.length) % (STATIONS.length + 1);
    this.switched();
    return this.stationName;
  }

  private switched(): void {
    this.song = null;
    this.stopTalk();
    this.stopIdent();
    this.static();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    // update() does not run under a menu: the talk voices must not hold on behind the pause.
    if (p) {
      this.stopTalk();
      this.stopIdent();
    }
  }

  private stopIdent(): void {
    if (!this.ident) return;
    this.ident.stop();
    this.ident = null;
    // A link cut short: the music comes straight back up.
    const t = this.ctx!.currentTime;
    this.music.gain.cancelScheduledValues(t);
    this.music.gain.setTargetAtTime(1, t, 0.05);
  }

  /**
   * The station's voice says `id` at `at`, unless the station changes before it has loaded. A DJ's link ducks the music
   * from just before its first word until just before its last ends, goes round the echo on ECHO_DJ's station, and is
   * dropped from the bank once it has played (idents stay: they are short).
   */
  private sayClip(id: string, at: number, link: boolean): void {
    const station = this.index;
    const still = () => this.active && this.index === station;
    void playClip({ ctx: this.ctx!, bank: this.bank, id, dest: this.out, at, level: IDENT_LEVEL, still, tally: this.tally, kind: link ? 'dj' : 'ident' }).then((p) => {
      if (!p) return;
      this.ident = p.src;
      if (!link) return;
      const g = this.music.gain;
      g.setTargetAtTime(DUCK, at - DUCK_LEAD, 0.08);
      g.setTargetAtTime(1, at + p.src.buffer!.duration - DUCK_RELEASE, 0.1);
      if (STATIONS[station]!.name === ECHO_DJ) p.gain.connect(this.echoSend);
      p.src.addEventListener('ended', () => this.bank.forget(id));
    });
  }

  private stopTalk(): void {
    if (this.ctx && this.talk?.segment) this.talk.stop(this.ctx.currentTime);
    this.hiss?.stop();
    this.hiss = null;
  }

  /** Routes the talk show straight to the output or through the AM band, and starts the AM hiss on air there. */
  private tuneBand(am: boolean): void {
    const ctx = this.ctx!;
    if (am !== this.onAm) {
      this.talkOut.disconnect();
      this.talkOut.connect(am ? this.amIn : this.out);
      this.onAm = am;
    }
    if (am && !this.hiss) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.connect(this.hissIn);
      this.tally?.track('talk', src);
      src.start(ctx.currentTime, Math.random() * this.noise.duration);
      this.hiss = src;
    }
  }

  private static(): void {
    const ctx = this.ctx;
    if (!ctx || !this.active) return;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400;
    f.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    g.gain.linearRampToValueAtTime(0, t + 0.32);
    src.connect(f);
    f.connect(g);
    g.connect(this.out);
    src.start(t + this.sample, Math.random());
    src.stop(t + 0.35);
  }

  /** The tuned station's next song from its rotation: a hit (the same song every time) or a deep cut. */
  private compose(): { song: Song; track: NowPlaying } {
    const def = STATIONS[this.index]!;
    const style = def.style!;
    const hits = HITS[def.name]!;
    this.rotations[def.name] ??= new Bag(hits.flatMap((_, i) => [String(i), String(hits.length + i)]), this.rng);
    const i = Number(this.rotations[def.name]!.next());
    if (i < hits.length) return { song: hitSong(style, hits[i]!.seed), track: { artist: hits[i]!.artist, title: hits[i]!.title, hit: i } };
    return { song: style.song(this.rng, this.rng.range(style.bpm[0], style.bpm[1])), track: { ...deepCut(def.name, this.rng), hit: null } };
  }

  /** What the DJ knows now about the coming song, `next`. */
  private scene(next: { song: Song; track: NowPlaying }): DjScene {
    const k = this.intensityValue;
    const song = this.song!;
    return {
      hit: next.track.hit,
      back: this.onAir!.hit !== null && 3 * (song.bars - this.songFrom) >= 2 * song.bars ? this.onAir!.hit : null,
      room: introSeconds(next.song, next.song.bpm * (1 + INTENSITY_TEMPO * k)) - LINK_MARGIN,
      hours: this.hours,
      weather: this.weather,
      intensity: k,
      gotAway: this.ctx!.currentTime - this.clearedAt < GOT_AWAY,
    };
  }

  /**
   * Starts the tuned station's next song and moves the echo to a dotted eighth of its tempo and the style's feedback.
   * At a song `boundary` (the last one ended) it is the song composed ahead, and the DJ says what was decided for its
   * intro if that clip has loaded: an ident just after the song starts, a link where its last word lands on the A
   * section's first downbeat. Tuned in, half the time the station's voice says an ident. Then the DJ decides what to
   * say over the next song's intro, which starts loading.
   */
  private startSong(boundary = false): Song {
    const def = STATIONS[this.index]!;
    const style = def.style!;
    const { song, track, item } = (boundary && this.upNext) || { ...this.compose(), item: null };
    this.song = song;
    this.style = style;
    this.onAir = track;
    this.songSerial++;
    // Tuned in from a longer song: this one starts over.
    if (this.bar >= song.bars) this.bar = 0;
    this.songFrom = this.bar;
    const t = this.ctx!.currentTime;
    this.delay.delayTime.setTargetAtTime((0.75 * 60) / song.bpm, t, 0.05);
    this.echoFeedback.gain.setTargetAtTime(style.echo, t, 0.05);
    const start = Math.max(t, this.nextTime);
    const clip = item && this.bank.get(item.clip);
    if (!boundary) {
      // The link loaded for the song after the last one tuned is not coming: it need not stay decoded, also once a load
      // still under way comes in (load hands back that load).
      if (this.upNext?.item && this.upNext.item.kind !== 'ident') {
        const id = this.upNext.item.clip;
        void this.bank.load(id).then(() => this.bank.forget(id), () => undefined);
      }
      const idents = SPEECH.idents[def.name];
      if (idents && this.rng.chance(0.5)) this.sayClip(idents[this.rng.int(0, idents.length - 1)]!, start + 0.4, false);
    } else if (item && clip) {
      if (item.kind === 'ident') this.sayClip(item.clip, start + 0.4, false);
      else {
        const downbeat = start + introSeconds(song, song.bpm * (1 + INTENSITY_TEMPO * this.intensityValue));
        this.sayClip(item.clip, Math.max(start, downbeat - clip.duration), true);
      }
    }
    const next = this.compose();
    this.djs[def.name] ??= new DjProgramme(def.name, (this.rng.next() * 0xffffffff) >>> 0);
    this.upNext = { ...next, item: this.djs[def.name]!.next(this.scene(next)) };
    if (this.upNext.item) this.bank.preload([this.upNext.item.clip]);
    return song;
  }

  update(dt: number, inCar: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const step = Math.min(dt, 0.25);
    const up = this.intensityTarget > this.intensityValue;
    this.intensityValue += (this.intensityTarget - this.intensityValue) * (1 - Math.exp(-step / (up ? INTENSITY_RISE : INTENSITY_FALL)));
    const want = inCar && !this.paused && this.index < STATIONS.length;
    const t = ctx.currentTime;
    const talk = this.talkTuned;
    if (want !== this.active) {
      this.active = want;
      this.out.gain.setTargetAtTime(want ? RADIO_LEVEL : 0, t, want ? 0.3 : 0.15);
      if (want) {
        this.nextTime = t + 0.08;
        if (!this.song && !talk) this.startSong();
        this.static();
      } else {
        this.stopTalk();
        this.stopIdent();
      }
    }
    if (!this.active) return;
    if (talk) {
      this.updateTalk(t);
      return;
    }
    let song = this.song ?? this.startSong();
    if (this.nextTime < t - 0.2) this.nextTime = t + 0.05;
    while (this.nextTime < t + 0.14) {
      const stepDur = 60 / (song.bpm * (1 + INTENSITY_TEMPO * this.intensityValue)) / 4;
      this.playStep(song, this.step, this.bar, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step++;
      if (this.step >= 16) {
        this.step = 0;
        this.bar++;
        if (this.bar >= song.bars) {
          this.bar = 0;
          song = this.startSong(true);
        }
      }
    }
  }

  /** Plays one sixteenth of the song: where it falls in the form, then the style. */
  private playStep(song: Song, step: number, bar: number, t: number, sd: number): void {
    const b = this.beat;
    locate(b, song, bar);
    b.t = t;
    b.sd = sd;
    b.step = step;
    b.k = this.intensityValue;
    b.r = this.rng;
    this.style!.step(this.kit, song, b);
  }

  private updateTalk(t: number): void {
    const prog = this.programme!;
    this.tuneBand(!!prog.format.am);
    const seg = prog.at(t - this.epoch);
    this.talk!.update(seg, this.epoch + seg.start, prog.format);
    // The next segment with something to say: after a gap, or after the gap that follows this one.
    const next = prog.at(seg.start + seg.dur);
    this.talk!.preload(next.kind === 'gap' ? prog.at(next.start + next.dur) : next);
  }
}
