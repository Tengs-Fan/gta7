// Procedural radio: nine music stations generating endless music with a WebAudio lookahead scheduler, and a talk
// station (talk.ts), in dial order. Each music station is a style (stations/): it seeds songs (key, progressions,
// motifs, a pattern variant) and plays each sixteenth of a song's form (intro, A, B, A again, outro; some add a
// breakdown) on a shared instrument kit with a tempo echo and a small reverb. The music follows the wanted level: an
// intensity value glides toward the level's target, lifts the tempo a little and drives each style's own chase
// behaviour; at 0 the music is exactly the calm original.

import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import { boombap } from './stations/boombap';
import { chiptune } from './stations/chiptune';
import { country } from './stations/country';
import { dnb } from './stations/dnb';
import { dub } from './stations/dub';
import { house } from './stations/house';
import { Kit } from './stations/kit';
import { lounge } from './stations/lounge';
import { locate, type Beat, type Song, type Style } from './stations/style';
import { surf } from './stations/surf';
import { synthwave } from './stations/synthwave';
import type { NodeTally } from './tally';
import { TalkProgramme, TalkShow, type TalkSegment } from './talk';

export interface StationDef {
  name: string;
  genre: string;
  /** The line under the name when the station is tuned. */
  tag: string;
  /** The music; null on the talk station. */
  style: Style | null;
  /** What the station's voice says between songs (station idents, for a voiced radio). */
  idents: readonly string[];
}

export const STATIONS: readonly StationDef[] = [
  {
    name: 'NEON DRIVE 88.7',
    genre: 'synthwave',
    tag: 'Synthwave after dark',
    style: synthwave,
    idents: ['Neon Drive, eighty-eight point seven. Keep your lights on and your engine warm.', 'You are cruising with Neon Drive. The night is long, San Azura.'],
  },
  {
    name: 'VELVET 89.9',
    genre: 'lounge',
    tag: 'Lounge, music to wait to',
    style: lounge,
    idents: ['Velvet, eighty-nine point nine. Music to wait to.', 'Relax. Whatever it is, it can wait. This is Velvet.'],
  },
  {
    name: 'DOCKSIDE DUB 92.3',
    genre: 'dub',
    tag: 'Dub from the Docks',
    style: dub,
    idents: ['Dockside Dub, ninety-two point three. Bass from the harbour, all night long.', 'Turn it up and lean back. Dockside Dub.'],
  },
  {
    name: 'PULSE 96.1',
    genre: 'house',
    tag: 'House all night',
    style: house,
    idents: ['Pulse, ninety-six point one. Keep moving, San Azura.', 'Four to the floor and no brakes. This is Pulse.'],
  },
  {
    name: 'COYOTE 97.7',
    genre: 'country',
    tag: 'Outlaw country',
    style: country,
    idents: ['Coyote, ninety-seven point seven. Outlaw country for the open road.', 'Dust on the boots, gas in the tank. You are on Coyote.'],
  },
  {
    name: 'WIPEOUT 99.5',
    genre: 'surf',
    tag: 'Surf rock, Ocean Beach',
    style: surf,
    idents: ['Wipeout, ninety-nine point five, live from Ocean Beach. Surf is up.', 'Wax your board and floor it. This is Wipeout.'],
  },
  {
    name: 'BOOM BAP 101.3',
    genre: 'boombap',
    tag: 'Golden-era hip hop',
    style: boombap,
    idents: ['Boom Bap, one-oh-one point three. Beats from the block.', 'Heads nodding from Southgate to the Docks. Boom Bap.'],
  },
  {
    name: 'BREAKNECK 102.7',
    genre: 'dnb',
    tag: 'Drum and bass, jungle',
    style: dnb,
    idents: ['Breakneck, one-oh-two point seven. Faster than the cops.', 'One hundred and seventy-four beats a minute. Breakneck.'],
  },
  {
    name: 'PIXEL 103.9',
    genre: 'chiptune',
    tag: '8-bit chiptune',
    style: chiptune,
    idents: ['Pixel, one-oh-three point nine. Insert coin to continue.', 'High score radio. You are tuned to Pixel.'],
  },
  { name: 'AZURA TALK 104.5', genre: 'talk', tag: 'Talk, news, nonsense', style: null, idents: [] },
];

/** Music intensity for a wanted level (0-5 stars): non-decreasing, 0 at no stars, 1 at five. */
export function wantedIntensity(level: number): number {
  return clamp(Math.floor(level), 0, 5) / 5;
}

/** Seconds (time constants) the intensity takes to rise toward a higher level and fall back toward a lower one. */
export const INTENSITY_RISE = 1;
export const INTENSITY_FALL = 3;
/** Tempo lift at full intensity. */
const INTENSITY_TEMPO = 0.08;

/** Output level of a playing station: 3 dB over unity, so the music sits over the engine. */
const RADIO_LEVEL = 1.41;

/** The reverb: four damped feedback delays in parallel (s, feedback), a short metallic room like a spring tank. */
const COMBS: readonly (readonly [number, number])[] = [
  [0.0297, 0.8],
  [0.0371, 0.78],
  [0.0411, 0.76],
  [0.0437, 0.74],
];

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
  private programme: TalkProgramme | null = null;
  private talk: TalkShow | null = null;
  /** Context time of the talk programme's start: the station is live whether or not anyone listens. */
  private epoch = 0;

  /** How hard the music drives (0 calm .. 1 five stars), gliding toward the wanted level's target. */
  get intensity(): number {
    return this.intensityValue;
  }

  /** The wanted level the music follows. */
  setWanted(level: number): void {
    this.intensityTarget = wantedIntensity(level);
  }

  /** The tuned station is the talk station. */
  get talkTuned(): boolean {
    return STATIONS[this.index]?.genre === 'talk';
  }

  /** Where the talk programme is: its clock and the segment on air (whether or not it is tuned). */
  talkInfo(): { time: number; segment: TalkSegment | null; rendering: TalkSegment | null } {
    if (!this.ctx || !this.programme) return { time: 0, segment: null, rendering: null };
    const time = this.ctx.currentTime - this.epoch;
    return { time, segment: this.programme.at(time), rendering: this.talk?.segment ?? null };
  }

  /**
   * Moves the talk programme's clock to just after the start of its next segment of `kind` (tools and tests: the show
   * otherwise runs on as broadcast). Returns that segment.
   */
  cueTalk(kind: TalkSegment['kind'], into = 0.05): TalkSegment | null {
    if (!this.ctx || !this.programme) return null;
    const now = this.ctx.currentTime - this.epoch;
    this.programme.at(now + 900);
    const seg = this.programme.segments.find((s) => s.kind === kind && s.start > now);
    if (!seg) return null;
    this.epoch = this.ctx.currentTime - seg.start - into;
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
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.programme = new TalkProgramme(seed);
    // Tuning in for the first time lands somewhere in the first minute of the show.
    this.epoch = ctx.currentTime - Math.random() * 60;
    this.talk = new TalkShow(ctx, this.out, tally);
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
    dl.connect(this.out);
    const verbSend = ctx.createGain();
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.22;
    verbOut.connect(this.out);
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
    this.kit = new Kit(ctx, this.out, noise, echoSend, verbSend);
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
    this.static();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    // update() does not run under a menu: the talk voices must not hold on behind the pause.
    if (p) this.stopTalk();
  }

  private stopTalk(): void {
    if (this.ctx && this.talk?.segment) this.talk.stop(this.ctx.currentTime);
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

  /** Starts a new song of the tuned station and moves the echo to a dotted eighth of its tempo and the style's feedback. */
  private startSong(): Song {
    const style = STATIONS[this.index]!.style!;
    const song = style.song(this.rng, this.rng.range(style.bpm[0], style.bpm[1]));
    this.song = song;
    this.style = style;
    // Tuned in from a longer song: this one starts over.
    if (this.bar >= song.bars) this.bar = 0;
    const t = this.ctx!.currentTime;
    this.delay.delayTime.setTargetAtTime((0.75 * 60) / song.bpm, t, 0.05);
    this.echoFeedback.gain.setTargetAtTime(style.echo, t, 0.05);
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
      } else this.stopTalk();
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
          song = this.startSong();
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
    const seg = prog.at(t - this.epoch);
    this.talk!.update(seg, this.epoch + seg.start);
    this.talk!.preload(prog.at(seg.start + seg.dur));
  }
}
