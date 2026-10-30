// The Azura Newsdesk (src/audio/newsroom.ts, newsText.ts; scripts/assets/speech/news.ts, missionNews.ts): every sentence a
// story can be read with has its clip, every place a phrase and every mission its piece; the newsroom files the local
// player's chases, sunk cars, fires and missions, and splices bulletins into AZURA TALK's programme by its rules. The
// station here is a real TalkProgramme on a clock the test moves; the browser plays a bulletin in radio_news.spec.ts.

import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/audio';
import { DESK_CUE, DESK_GAP, Newsroom, REPEAT_AFTER, STORY_LIFE } from '../../src/audio/newsroom';
import { AGAIN, ARRIVAL, bulletin, CHASE_KICKERS, daypart, DAYPARTS, HELD, OPENERS, PROMISED, SIGN_OFFS, WHEN, ZONE_PREP, type Bags, type Story } from '../../src/audio/newsText';
import type { Radio } from '../../src/audio/radio';
import { GAP_LEN, TalkProgramme, type TalkSegment } from '../../src/audio/talk';
import { Helicopter } from '../../src/sim/entities';
import { STORY } from '../../src/sim/missions';
import { SPEECH } from '../../src/sim/speech';
import type { Sim } from '../../src/sim/sim';
import { WEATHER_KINDS, type Forecast } from '../../src/sim/weather';
import { MISSION_NEWS } from '../../scripts/assets/speech/missionNews';
import { newsSentences } from '../../scripts/assets/speech/news';
import { zoneNames } from '../../scripts/assets/speech/phrases';
import { makeSim, placeInCar, roadPoint, teleport, world } from './helpers';

const OUTCOMES = ['evaded', 'busted', 'wasted'] as const;

/** Every story the desk can be handed, each kind in every shape it comes in. */
function everyStory(zones: readonly string[]): Story[] {
  const stories: Story[] = [];
  for (const from of zones) {
    for (const to of zones) for (const outcome of OUTCOMES) for (const heli of [false, true]) stories.push({ kind: 'chase', at: 60, stars: 2, from, to, heli, outcome });
    stories.push({ kind: 'sunk', at: 60, zone: from });
    for (let cars = 2; cars <= 12; cars++) stories.push({ kind: 'fire', at: 60, zone: from, cars });
  }
  for (let stars = 2; stars <= 5; stars++) for (let h = 0; h < 24; h++) stories.push({ kind: 'chase', at: 48 + h, stars, from: zones[0]!, to: zones[1]!, heli: false, outcome: 'evaded' });
  for (const d of STORY) for (const later of [false, true]) stories.push({ kind: 'mission', at: 60, id: d.id, later });
  for (const sky of WEATHER_KINDS) {
    stories.push({ kind: 'weather', at: 60, sky }, { kind: 'promised', at: 60, sky });
    stories.push({ kind: 'weather', at: 60, sky, forecast: null, held: 'clear' }, { kind: 'weather', at: 60, sky, forecast: null, held: 'override' });
    for (const tomorrow of WEATHER_KINDS) {
      const forecasts: Forecast[] = [{ now: sky, next: null, tomorrow }];
      for (const kind of WEATHER_KINDS) for (let startHours = 3; startHours < 24; startHours += 3) forecasts.push({ now: sky, next: { kind, startHours }, tomorrow });
      for (const forecast of forecasts) stories.push({ kind: 'weather', at: 60, sky, forecast });
    }
  }
  return stories;
}

/** Draws the first of each table, and remembers every table drawn from. */
function recorder(): Bags & { pools: Set<readonly string[]> } {
  const pools = new Set<readonly string[]>();
  return {
    pools,
    draw(pool) {
      pools.add(pool);
      return pool[0]!;
    },
  };
}

describe('the newsdesk speech', () => {
  it('has a phrase for every place the city names', () => {
    for (const z of zoneNames(world())) expect(ZONE_PREP[z], z).toBeDefined();
  });

  it('has a clip for every sentence any story can be read with, and renders nothing the desk never says', () => {
    const zones = zoneNames(world());
    const bags = recorder();
    const said = new Set<string>();
    for (const s of everyStory(zones)) {
      // The first airing, the second the same day, and the second the next day.
      for (const [now, again] of [[s.at, false], [s.at + 1, true], [s.at + 24, true]] as const) for (const line of bulletin(s, now, bags, again)) said.add(line);
    }
    for (const pool of bags.pools) for (const line of pool) said.add(line);
    for (const line of said) expect(SPEECH.news[line], line).toBeDefined();
    expect(new Set(newsSentences(zones))).toEqual(said);
    expect(new Set(Object.keys(SPEECH.news))).toEqual(said);
    for (const id of Object.values(SPEECH.news)) expect(SPEECH.clips[id], id).toBeGreaterThan(0.5);
    console.log(`[news] ${said.size} sentences, ${Object.values(SPEECH.news).reduce((t, id) => t + SPEECH.clips[id]!, 0).toFixed(0)} s`);
  });

  it('has a breaking piece for every mission of the story, a follow-up for most, each under 40 s', () => {
    expect(Object.keys(MISSION_NEWS).sort()).toEqual(STORY.map((d) => d.id).sort());
    for (const d of STORY) {
      const m = SPEECH.missionNews[d.id]!;
      expect(m.breaking, d.id).toBe(`news-m-${d.id}`);
      for (const id of [m.breaking, ...(m.followUp ? [m.followUp] : [])]) expect(SPEECH.clips[id], id).toBeLessThan(40);
    }
    expect(Object.values(SPEECH.missionNews).filter((m) => m.followUp).length).toBeGreaterThanOrEqual(6);
  });

  it('reads a chase lead by its stars and the part of the day it happened in', () => {
    const bags = recorder();
    const lead = (stars: number, hours: number) => bulletin({ kind: 'chase', at: 48 + hours, stars, from: 'Midtown', to: 'Ocean Beach', heli: true, outcome: 'evaded' }, 48 + hours, bags)[1];
    expect(lead(2, 19)).toBe('A police chase tore across San Azura this evening.');
    expect(lead(4, 13)).toBe('SWAT vans joined a police chase across the city this afternoon.');
    expect(lead(5, 2)).toBe('The entire San Azura police department chased one driver tonight.');
    expect(lead(3, 7)).toBe('A police chase tore across San Azura this morning.');
    expect(DAYPARTS).toHaveLength(4);
    const chase: Story = { kind: 'chase', at: 60, stars: 4, from: 'Midtown', to: 'Ocean Beach', heli: true, outcome: 'evaded' };
    expect(bulletin(chase, 60, bags)).toEqual([OPENERS[0], 'SWAT vans joined a police chase across the city this afternoon.', 'It started in Midtown.', 'It ended on Ocean Beach.', 'The police helicopter did not make it home.', 'The suspect got away.', CHASE_KICKERS[0], SIGN_OFFS[0]]);
    expect(bulletin(chase, 70, bags, true)[0]).toBe(AGAIN.chase.today);
    expect(bulletin(chase, 75, bags, true)[0]).toBe(AGAIN.chase.yesterday);
    expect(bulletin({ ...chase, to: 'Marina' }, 60, bags)).toContain('It ended at the Marina.');
    expect(bulletin({ ...chase, to: 'Midtown' }, 60, bags)).toContain('It never left Midtown.');
  });
});

/** AZURA TALK on a clock the test moves (seconds of programme), tuned in and playing. */
function station(seed = 5) {
  const prog = new TalkProgramme(seed);
  const r = { time: 0, playing: true, stationName: 'AZURA TALK 104.5', talkProgramme: prog, talkInfo: () => ({ time: r.time, segment: prog.at(r.time), rendering: null }) };
  return r;
}

function newsroom(sim: Sim = makeSim({ police: false })) {
  const radio = station();
  const room = new Newsroom(radio as unknown as Radio, sim.world);
  const me = sim.players[0]!;
  /** One poll, `seconds` of programme on. */
  const poll = (seconds = 1) => {
    radio.time += seconds;
    room.update(1, sim, me);
  };
  /** Polls a second at a time until the programme has a new desk; returns it. */
  const nextDesk = (within = 600) => {
    const before = radio.talkProgramme.segments.filter((s) => s.kind === 'desk').length;
    for (let t = 0; t < within; t++) {
      poll();
      const desks = radio.talkProgramme.segments.filter((s) => s.kind === 'desk');
      if (desks.length > before) return { desk: desks.at(-1)!, at: radio.time };
    }
    return null;
  };
  return { sim, radio, room, me, poll, nextDesk };
}

/** Moves the game clock on by `hours`. */
const later = (sim: Sim, hours: number) => sim.clock.update(hours / sim.clock.rate);
const centre = (sim: Sim, zone: string) => {
  const r = sim.world.layout.blocks.find((b) => b.zone === zone)!.rect;
  return { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 };
};
const sentence = new Map(Object.entries(SPEECH.news).map(([text, id]) => [id, text]));
/** What a desk reads, sentence by sentence (a mission piece by its clip). */
const reads = (desk: TalkSegment) => desk.clips!.map((id) => sentence.get(id) ?? id);

describe('the newsroom', () => {
  it('files a chase from where it started to where it ended, with its most stars, when the player gets away', () => {
    const { sim, room, poll } = newsroom(makeSim());
    const a = centre(sim, 'Midtown');
    const b = centre(sim, 'Hillcrest');
    teleport(sim, a.x, a.z);
    poll();
    sim.wanted.setLevel(4);
    poll();
    sim.wanted.setLevel(3);
    teleport(sim, b.x, b.z);
    poll();
    expect(room.stories).toEqual([]);
    sim.wanted.setLevel(0);
    poll();
    expect(room.stories.map((f) => f.story)).toEqual([{ kind: 'chase', at: expect.any(Number), stars: 4, from: 'Midtown', to: 'Hillcrest', heli: false, outcome: 'evaded' }]);
  });

  it('ends a chase busted or wasted when the player goes down, notes a helicopter shot down near him, and skips a one-star chase', () => {
    const { sim, room, me, poll } = newsroom();
    sim.wanted.setLevel(2);
    poll();
    const p = sim.playerPos();
    const heli = new Helicopter(sim.newId(), p.x + 100, p.y + 60, p.z);
    sim.helis.push(heli);
    poll();
    heli.destroyed = true;
    poll();
    me.deathKind = 'busted';
    poll();
    // The respawn clears the stars: no second story.
    sim.wanted.setLevel(0);
    poll();
    me.deathKind = null;
    poll();
    expect(room.stories.map((f) => f.story)).toMatchObject([{ kind: 'chase', stars: 2, heli: true, outcome: 'busted' }]);
    sim.wanted.setLevel(1);
    poll();
    me.deathKind = 'wasted';
    poll();
    expect(room.stories).toHaveLength(1);
  });

  it('files his car going into the water where it went in, but not a boat or a bike', () => {
    const { sim, room, poll } = newsroom();
    const rp = roadPoint(sim);
    const car = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    placeInCar(sim, car);
    poll();
    car.inWater = true;
    poll();
    poll();
    expect(room.stories.map((f) => f.story)).toEqual([{ kind: 'sunk', at: expect.any(Number), zone: sim.world.zoneName(car.pos.x, car.pos.z) }]);
    const boat = sim.spawnVehicle('dinghy', rp.x, rp.z, rp.heading);
    placeInCar(sim, boat);
    poll();
    boat.inWater = true;
    poll();
    const scooter = sim.spawnVehicle('scooter', rp.x, rp.z, rp.heading);
    placeInCar(sim, scooter);
    poll();
    scooter.inWater = true;
    poll();
    expect(room.stories).toHaveLength(1);
  });

  it('files two or more cars burning near him in a row as one fire, once they have stopped', () => {
    const { sim, room, me, poll } = newsroom();
    const p = sim.playerPos();
    const cars = [0, 1, 2].map((i) => sim.spawnVehicle('sedan', p.x + 10 * i, p.z + 20, 0));
    for (const v of cars) room.wreck(v, sim, me);
    room.wreck(sim.spawnVehicle('sedan', p.x + 400, p.z, 0), sim, me);
    for (let i = 0; i < 15; i++) poll();
    expect(room.stories).toEqual([]);
    for (let i = 0; i < 10; i++) poll();
    expect(room.stories.map((f) => f.story)).toEqual([{ kind: 'fire', at: expect.any(Number), zone: sim.world.zoneName(cars[0]!.pos.x, cars[0]!.pos.z), cars: 3 }]);
  });

  it("files the player's own passed missions as the engine hears of them, and their follow-up a game day later", () => {
    const sim = makeSim({ police: false });
    const audio = new AudioEngine();
    audio.attach(sim);
    sim.events.emit('missionEnded', { id: 'big_score', passed: true });
    sim.events.emit('missionEnded', { id: 'repo', passed: false });
    sim.events.emit('missionEnded', { id: 'wheels', passed: true, playerId: 1 });
    sim.events.emit('missionEnded', { id: 'a_mod_mission', passed: true });
    const room = audio.newsroom!;
    expect(room.stories.map((f) => f.story)).toEqual([{ kind: 'mission', at: sim.clock.day * 24 + sim.clock.hours, id: 'big_score', later: false }]);
    later(sim, 23.5);
    room.update(1, sim, sim.players[0]!);
    expect(room.stories).toHaveLength(1);
    later(sim, 0.5);
    room.update(1, sim, sim.players[0]!);
    expect(room.stories.map((f) => f.story)).toMatchObject([{ kind: 'mission', id: 'big_score', later: true }]);
  });

  it('splices a bulletin after the host or ad piece nearing its end, DESK_GAP of programme after tuning in, and keeps the programme contiguous', () => {
    const { radio, room, nextDesk, poll } = newsroom();
    poll(0);
    room.file({ kind: 'chase', at: 24 * 3 + 20, stars: 4, from: 'Midtown', to: 'Ocean Beach', heli: true, outcome: 'evaded' });
    const got = nextDesk()!;
    const { desk } = got;
    const segs = radio.talkProgramme.until(desk.start + 900);
    const i = segs.indexOf(desk);
    // After the gap after a piece, polled within DESK_CUE of that piece's end, DESK_GAP after tuning in.
    expect(segs[i - 1]!.kind).toBe('gap');
    expect(['host', 'ad']).toContain(segs[i - 2]!.kind);
    expect(segs[i - 2]!.start + segs[i - 2]!.dur - got.at).toBeLessThanOrEqual(DESK_CUE);
    expect(got.at).toBeGreaterThanOrEqual(DESK_GAP);
    expect(segs[i + 1]).toMatchObject({ kind: 'gap', dur: GAP_LEN[0] });
    for (let k = 1; k < segs.length; k++) {
      expect(segs[k]!.start).toBeCloseTo(segs[k - 1]!.start + segs[k - 1]!.dur, 9);
      expect(segs[k]!.kind === 'gap' && segs[k - 1]!.kind === 'gap').toBe(false);
      if (segs[k]!.kind !== 'gap') expect(segs[k - 1]!.kind).toBe('gap');
    }
    for (const id of desk.clips!) expect(SPEECH.clips[id], id).toBeGreaterThan(0);
    const text = reads(desk);
    expect(OPENERS).toContain(text[0]);
    expect(text.slice(1, 5)).toEqual(['SWAT vans joined a police chase across the city this evening.', 'It started in Midtown.', 'It ended on Ocean Beach.', 'The police helicopter did not make it home.']);
    expect(SIGN_OFFS).toContain(text.at(-1));
    expect(room.stories[0]).toMatchObject({ aired: 1 });
  });

  it('airs a story twice at most, the second time 6 game hours on and by name, and lets it go after 24', () => {
    const { sim, room, nextDesk, poll } = newsroom();
    poll(0);
    const at = sim.clock.day * 24 + sim.clock.hours;
    room.file({ kind: 'sunk', at, zone: 'Gull Bay' });
    expect(reads(nextDesk()!.desk)).toContain('A car went into the water in Gull Bay.');
    // Nothing else is news: the forecast comes next (always clear in this sim), and nothing until it is due again.
    expect(HELD.clear).toContain(reads(nextDesk()!.desk)[2]);
    expect(nextDesk(300)).toBeNull();
    later(sim, REPEAT_AFTER);
    expect(reads(nextDesk()!.desk)[0]).toBe(AGAIN.sunk.today);
    expect(room.stories).toEqual([]);
    room.file({ kind: 'chase', at, stars: 2, from: 'Midtown', to: 'Westside', heli: false, outcome: 'busted' });
    room.file({ kind: 'chase', at: at - STORY_LIFE, stars: 2, from: 'Midtown', to: 'Westside', heli: false, outcome: 'busted' });
    poll(0);
    expect(room.stories.map((f) => f.story.at)).toEqual([at]);
  });

  it('keeps six stories, the least of them going first, and reads a mission before a chase before a sunk car', () => {
    const { room, nextDesk, poll } = newsroom();
    poll(0);
    room.file({ kind: 'sunk', at: 60, zone: 'Gull Bay' });
    room.file({ kind: 'sunk', at: 61, zone: 'Coral Bay' });
    room.file({ kind: 'chase', at: 62, stars: 2, from: 'Midtown', to: 'Westside', heli: false, outcome: 'evaded' });
    room.file({ kind: 'mission', at: 50, id: 'wheels', later: false });
    for (let i = 0; i < 3; i++) room.file({ kind: 'chase', at: 63 + i, stars: 3, from: 'Hillcrest', to: 'Westside', heli: false, outcome: 'evaded' });
    expect(room.stories).toHaveLength(6);
    expect(room.stories.map((f) => f.story)).not.toContainEqual(expect.objectContaining({ zone: 'Gull Bay' }));
    const first = nextDesk()!.desk;
    expect(first.clips).toContain(SPEECH.missionNews.wheels!.breaking);
    expect(reads(nextDesk()!.desk)).toContain('It started in Hillcrest.');
  });

  it('forecasts the next change, and says so when it comes, while the player listens', () => {
    const sim = makeSim({ police: false, weather: 'dynamic' });
    // A day with a change of weather later on.
    let found: { day: number; hours: number } | null = null;
    for (let day = 3; day < 60 && !found; day++) for (let hours = 0.5; hours < 20 && !found; hours += 3) if (sim.weather.forecast(day, hours)!.next) found = { day, hours };
    sim.clock.day = found!.day;
    sim.clock.hours = found!.hours;
    const p = sim.playerPos();
    sim.weather.update(1 / 60, sim.clock, sim.events, p);
    const { radio, nextDesk, poll } = newsroom(sim);
    poll(0);
    const f = sim.weather.forecast(sim.clock.day, sim.clock.hours)!;
    const text = reads(nextDesk()!.desk);
    expect(text).toContain(ARRIVAL[f.next!.kind](WHEN[daypart(f.next!.startHours)]));
    // The change comes, ramped in.
    sim.clock.hours = f.next!.startHours + 0.5;
    sim.weather.update(1 / 60, sim.clock, sim.events, p);
    expect(sim.weather.state.kind).toBe(f.next!.kind);
    radio.time += 10;
    expect(reads(nextDesk()!.desk)).toContain(PROMISED[f.next!.kind]);
  });
});
