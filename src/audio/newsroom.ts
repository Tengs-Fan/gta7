// AZURA TALK's newsdesk: Dolores Vance reads the local player's record (a chase of two stars or more, a car he sank, a
// pile of burnt cars, a mission he passed) and what the sky will do, spliced into the programme after a piece
// (TalkProgramme.splice). It watches the view the screens read, once a second, and its own player's events, so it works
// on a network client's mirror too; nothing is saved. The freshest and most important story airs first, each at most
// twice, and the desk waits DESK_GAP seconds of programme between bulletins, so the show is still mostly the show.
//
// Three clocks: real seconds for the poll and the forecast's cadence, the programme's for DESK_GAP, and game hours on
// the clock's time line (day * 24 + hours) for when a story happened, when it may air again and when it is old news.

import { Rng } from '../core/rng';
import type { Vehicle } from '../sim/entities';
import { SPEECH } from '../sim/speech';
import type { PlayerView, ViewState } from '../sim/viewState';
import type { WeatherKind } from '../sim/weather';
import type { StaticWorld } from '../world/staticWorld';
import { bulletin, type Bags, type Story } from './newsText';
import type { Radio } from './radio';
import { Bag } from './talk';

/** Seconds of programme from tuning in, or from the end of a bulletin, before the next one. */
export const DESK_GAP = 75;
/** A bulletin goes in after the host or ad piece on air once it has this many seconds or less to run. */
export const DESK_CUE = 4;
export const MAX_STORIES = 6;
/** Game hours a story stays news, the least before its second airing, and before a mission's follow-up. */
export const STORY_LIFE = 24;
export const REPEAT_AFTER = 6;
export const FOLLOW_UP_AFTER = 24;
/** Real seconds between two forecasts. */
export const FORECAST_EVERY = 480;
/** Metres from the player a helicopter is shot down in his chase, and a car burns in his fire. */
const HELI_RANGE = 300;
const FIRE_RANGE = 150;
/** Real seconds after the last car burned that the fire is over. */
const FIRE_QUIET = 20;
/** Game hours after a forecast change's start that it may still arrive (its ramp). */
const PROMISE_WINDOW = 1;

const STATION = 'AZURA TALK 104.5';

/** The higher airs first: a mission over a chase, a chase over a sunk or burnt car. */
const PRIORITY: Readonly<Record<Story['kind'], number>> = { mission: 3, chase: 2, sunk: 1, fire: 1, weather: 0, promised: 0 };

/** Game hours on the clock's time line. */
const hoursOf = (view: ViewState): number => view.clock.day * 24 + view.clock.hours;

export interface Filed {
  story: Story;
  aired: number;
  /** Game hours of its first airing. */
  airedAt: number;
}

export class Newsroom {
  /** The stories waiting, in the order filed. */
  readonly stories: Filed[] = [];
  private readonly bags: Bags;
  /** Real seconds since it started, and until the next poll. */
  private clock = 0;
  private wait = 0;
  private level = 0;
  private chase: { at: number; stars: number; from: string; heli: boolean } | null = null;
  /** Helicopters in the air at the last poll. */
  private flying = new Set<number>();
  /** The road vehicle he last sat in, and whether it was in the water at the last poll. */
  private car: Vehicle | null = null;
  private wet = false;
  private fire: { at: number; zone: string; cars: number; last: number } | null = null;
  private readonly followUps: Array<{ id: string; due: number }> = [];
  /** Real seconds of the last forecast; the change it promised, and the line saying it came true once it has. */
  private forecastAt = -Infinity;
  private promise: { sky: WeatherKind; at: number } | null = null;
  private promised: WeatherKind | null = null;
  private tuned = false;
  /** Programme seconds of tuning in or of the end of the last bulletin. */
  private since = 0;

  constructor(
    private readonly radio: Radio,
    private readonly world: StaticWorld,
  ) {
    const rng = new Rng((Math.random() * 0xffffffff) >>> 0);
    const bags = new Map<readonly string[], Bag>();
    this.bags = {
      draw(pool) {
        let b = bags.get(pool);
        if (!b) bags.set(pool, (b = new Bag(pool, rng)));
        return b.next();
      },
    };
  }

  /** Files a story (the hooks file one by hand); a seventh pushes out the least of them. */
  file(story: Story): void {
    this.stories.push({ story, aired: 0, airedAt: 0 });
    if (this.stories.length <= MAX_STORIES) return;
    let least = 0;
    this.stories.forEach((f, i) => {
      const l = this.stories[least]!.story;
      if (PRIORITY[f.story.kind] < PRIORITY[l.kind] || (PRIORITY[f.story.kind] === PRIORITY[l.kind] && f.story.at < l.at)) least = i;
    });
    this.stories.splice(least, 1);
  }

  /** The player passed mission `id`: the news has it now, and its follow-up a day later (a mod's mission has none). */
  mission(id: string, view: ViewState): void {
    const news = SPEECH.missionNews[id];
    if (!news) return;
    const at = hoursOf(view);
    this.file({ kind: 'mission', at, id, later: false });
    if (news.followUp) this.followUps.push({ id, due: at + FOLLOW_UP_AFTER });
  }

  /** A vehicle burned out: near the player, it is part of his fire. */
  wreck(v: Vehicle, view: ViewState, me: PlayerView): void {
    const p = me.pos();
    if (Math.hypot(v.pos.x - p.x, v.pos.z - p.z) > FIRE_RANGE) return;
    const f = this.fire;
    if (f) {
      f.cars++;
      f.last = this.clock;
    } else this.fire = { at: hoursOf(view), zone: this.world.zoneName(v.pos.x, v.pos.z), cars: 1, last: this.clock };
  }

  update(dt: number, view: ViewState, me: PlayerView): void {
    this.clock += dt;
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = 1;
    const now = hoursOf(view);
    this.watchChase(view, me, now);
    this.watchCar(me, now);
    if (this.fire && this.clock - this.fire.last > FIRE_QUIET) {
      const { at, zone, cars } = this.fire;
      if (cars >= 2) this.file({ kind: 'fire', at, zone, cars });
      this.fire = null;
    }
    for (let i = this.followUps.length - 1; i >= 0; i--) {
      const f = this.followUps[i]!;
      if (now < f.due) continue;
      this.file({ kind: 'mission', at: now, id: f.id, later: true });
      this.followUps.splice(i, 1);
    }
    for (let i = this.stories.length - 1; i >= 0; i--) if (now - this.stories[i]!.story.at >= STORY_LIFE) this.stories.splice(i, 1);
    const tuned = this.radio.playing && this.radio.stationName === STATION;
    this.watchSky(view, now, tuned);
    this.air(view, now, tuned);
  }

  /** A chase starts at his first star and ends when he is down (wasted or busted) or the stars are gone (got away). */
  private watchChase(view: ViewState, me: PlayerView, now: number): void {
    const p = me.pos();
    const level = me.wanted.level;
    const flying = new Set<number>();
    for (const h of view.helis) {
      if (!h.destroyed) flying.add(h.id);
      else if (this.chase && this.flying.has(h.id) && Math.hypot(h.pos.x - p.x, h.pos.z - p.z) < HELI_RANGE) this.chase.heli = true;
    }
    this.flying = flying;
    const c = this.chase;
    if (c) {
      c.stars = Math.max(c.stars, level);
      // Down first: the respawn clears his stars while he is still down.
      const outcome = me.down ? me.deathKind! : level === 0 ? 'evaded' : null;
      if (outcome) {
        if (c.stars >= 2) this.file({ kind: 'chase', at: c.at, stars: c.stars, from: c.from, to: this.world.zoneName(p.x, p.z), heli: c.heli, outcome });
        this.chase = null;
      }
    } else if (level > 0 && this.level === 0 && !me.down) this.chase = { at: now, stars: level, from: this.world.zoneName(p.x, p.z), heli: false };
    this.level = level;
  }

  /** His car going into the water, whether he is still in it or not: a boat floats, and a bike is not a car. */
  private watchCar(me: PlayerView, now: number): void {
    const v = me.character.vehicle;
    if (v && v !== this.car) {
      this.car = v;
      this.wet = v.inWater;
    }
    const car = this.car;
    if (!car || car.inWater === this.wet) return;
    this.wet = car.inWater;
    if (car.inWater && car.spec.class === 'car') this.file({ kind: 'sunk', at: now, zone: this.world.zoneName(car.pos.x, car.pos.z) });
  }

  /** The change the last forecast promised, arriving while he listens: the desk says so, once. */
  private watchSky(view: ViewState, now: number, tuned: boolean): void {
    const p = this.promise;
    if (!p || now < p.at) return;
    if (view.weather.state.kind === p.sky) {
      if (tuned) this.promised = p.sky;
      this.promise = null;
    } else if (now > p.at + PROMISE_WINDOW) this.promise = null;
  }

  /** Splices a bulletin in after the piece on air once it nears its end, DESK_GAP after the last, if there is news. */
  private air(view: ViewState, now: number, tuned: boolean): void {
    if (!tuned) {
      this.tuned = false;
      return;
    }
    const info = this.radio.talkInfo();
    if (!this.tuned) {
      this.tuned = true;
      this.since = info.time;
    }
    const seg = info.segment!;
    if ((seg.kind !== 'host' && seg.kind !== 'ad') || seg.start + seg.dur - info.time > DESK_CUE || info.time - this.since < DESK_GAP) return;
    const next = this.next(view, now);
    if (!next) return;
    const prog = this.radio.talkProgramme!;
    const desk = prog.splice(prog.segments.indexOf(seg) + 1, this.clips(next.story, now, next.again));
    this.since = desk.start + desk.dur;
  }

  /**
   * The story to read next: a fresh one before one airing again (6 game hours on), the higher kind first, then the
   * newest. Then the line saying the forecast came true, while it still has; then the forecast, when one is due.
   */
  private next(view: ViewState, now: number): { story: Story; again: boolean } | null {
    let best: Filed | null = null;
    const rank = (f: Filed) => (f.aired === 0 ? 10 : 0) + PRIORITY[f.story.kind];
    for (const f of this.stories) {
      if (f.aired === 1 && now - f.airedAt < REPEAT_AFTER) continue;
      if (!best || rank(f) > rank(best) || (rank(f) === rank(best) && f.story.at > best.story.at)) best = f;
    }
    if (best) {
      const again = best.aired === 1;
      if (again) this.stories.splice(this.stories.indexOf(best), 1);
      else {
        best.aired = 1;
        best.airedAt = now;
      }
      return { story: best.story, again };
    }
    const promised = this.promised;
    this.promised = null;
    if (promised && view.weather.state.kind === promised) return { story: { kind: 'promised', at: now, sky: promised }, again: false };
    if (this.clock - this.forecastAt < FORECAST_EVERY) return null;
    this.forecastAt = this.clock;
    const w = view.weather;
    const sky = w.state.kind;
    if (!w.forecast) return { story: { kind: 'weather', at: now, sky }, again: false };
    const forecast = w.forecast(view.clock.day, view.clock.hours);
    if (!forecast) return { story: { kind: 'weather', at: now, sky, forecast, held: w.overridden ? 'override' : 'clear' }, again: false };
    if (forecast.next) this.promise = { sky: forecast.next.kind, at: view.clock.day * 24 + forecast.next.startHours };
    return { story: { kind: 'weather', at: now, sky, forecast }, again: false };
  }

  /** A story's clips: its sentences', and a mission's recorded piece after the opener. */
  private clips(story: Story, now: number, again: boolean): string[] {
    const clips = bulletin(story, now, this.bags, again).map((s) => SPEECH.news[s]!);
    if (story.kind === 'mission') {
      const m = SPEECH.missionNews[story.id]!;
      clips.splice(1, 0, story.later ? m.followUp! : m.breaking);
    }
    return clips;
  }
}
