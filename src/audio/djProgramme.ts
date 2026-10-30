// A music station's DJ: a pure, seeded programme of what is said over each song's intro, decided a song ahead so the
// clip has time to load. At a song boundary it is nothing (about 45 %), an ident (20 %) or a link (35 %): the coming
// hit's announce, the last hit's back-announce, banter, or a line for the moment (a chase, a chase got away from, the
// rain, the night), which beats the others when it applies. Never two links in a row, and a link only if it fits the
// coming intro, so the radio can start it where its last word lands on the A section's first downbeat. Each pool is
// drawn from a Bag: all of its clips before any comes round again.

import { Rng } from '../core/rng';
import { SPEECH, type LinkKind } from '../sim/speech';
import type { WeatherKind } from '../sim/weather';
import type { Song } from './stations/style';
import { Bag } from './talk';

/**
 * A link comes at this share of the boundaries after one without (35 % of them all, as a link never follows a link);
 * of the boundaries without a link, this share have an ident (20 % of all) and the rest nothing (45 %).
 */
const LINK = 0.35 / 0.65;
const IDENT = 0.2 / 0.65;
/** Intensity (0 calm .. 1 five stars) above which the DJ talks about the chase: three stars or more. */
export const CHASE_INTENSITY = 0.5;
/** Seconds of an intro a link leaves free: it starts at least this long after the song does. */
export const LINK_MARGIN = 0.6;

/** Seconds of a song's intro played at `bpm` (its tempo with the chase's lift). */
export function introSeconds(song: Song, bpm: number): number {
  return (song.form[0]![1] * 240) / bpm;
}

/** What the DJ knows when deciding what to say over the coming song's intro. */
export interface DjScene {
  /** The coming song: its index in the station's hits, or null for a deep cut. */
  hit: number | null;
  /** The song now playing, if it is a hit and at least two thirds of it will have played; otherwise null. */
  back: number | null;
  /** Seconds of the coming intro a link may fill (its length at the current tempo, less LINK_MARGIN). */
  room: number;
  hours: number;
  weather: WeatherKind;
  /** The music's chase intensity. */
  intensity: number;
  /** The stars cleared a moment ago, after a chase of two or more. */
  gotAway: boolean;
}

export interface DjItem {
  kind: LinkKind;
  clip: string;
}

type Pool = 'banter' | 'night' | 'rain' | 'chase' | 'gotAway';

export class DjProgramme {
  private readonly rng: Rng;
  private readonly idents: Bag;
  private readonly pools: Partial<Record<Pool, Bag>> = {};
  /** The last boundary had a link. */
  private linked = false;

  constructor(
    private readonly station: string,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.idents = new Bag(SPEECH.idents[station]!, this.rng);
    for (const [kind, clips] of Object.entries(SPEECH.dj[station]!) as Array<[Pool, string[]]>) this.pools[kind] = new Bag(clips, this.rng);
  }

  /** What the DJ says over the coming song's intro, or null for nothing. */
  next(s: DjScene): DjItem | null {
    if (this.linked || !this.rng.chance(LINK)) return this.said(this.rng.chance(IDENT) ? { kind: 'ident', clip: this.idents.next() } : null);
    const kind = this.moment(s) ?? this.rng.pick(this.kinds(s));
    return this.said(this.link(kind, s));
  }

  /** A link of `kind` over the coming intro (null if the kind has nothing for this song, or its clip does not fit). */
  link(kind: LinkKind, s: DjScene): DjItem | null {
    const tracks = SPEECH.tracks[this.station]!;
    let clip: string | undefined;
    if (kind === 'ident') clip = this.idents.next();
    else if (kind === 'front') clip = s.hit === null ? undefined : tracks[s.hit]!.front;
    else if (kind === 'back') clip = s.back === null ? undefined : tracks[s.back]!.back;
    else clip = this.pools[kind]!.next();
    return clip && SPEECH.clips[clip]! <= s.room ? { kind, clip } : null;
  }

  private said(item: DjItem | null): DjItem | null {
    this.linked = item !== null && item.kind !== 'ident';
    return item;
  }

  /** The pool of the moment, if one applies: a chase, then a getaway, then the rain, then the night (22:00-05:00). */
  private moment(s: DjScene): Pool | null {
    if (s.intensity > CHASE_INTENSITY) return 'chase';
    if (s.gotAway) return 'gotAway';
    if (s.weather === 'rain' || s.weather === 'storm') return 'rain';
    if (s.hours >= 22 || s.hours < 5) return 'night';
    return null;
  }

  /** Links for an ordinary boundary: banter, and the announce or back-announce when a hit comes or goes. */
  private kinds(s: DjScene): LinkKind[] {
    const kinds: LinkKind[] = ['banter'];
    if (s.hit !== null) kinds.push('front');
    if (s.back !== null) kinds.push('back');
    return kinds;
  }
}
