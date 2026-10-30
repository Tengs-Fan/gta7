// Hails: a pedestrian at the curb ahead of a taxi a player drives waves it down, his arm up, calling out for it, and
// the cab stopping beside him makes him the fare (taxi.ts takeHailer): the taxi job starts with him, or he takes the
// place of the fare the job was sending the player to. One hailer per player at a time, and none for a player with
// more stars than the cab's theft gets him, in a story mission, with a full cab or a fare aboard. Draws from its own
// random generator, and only while a player drives a taxi, so other play is unchanged.

import { moveAngleTowards } from '../../core/math';
import { Rng } from '../../core/rng';
import type { Character, Vehicle } from '../entities';
import type { PlayerSlot } from '../playerSlot';
import type { Sim } from '../sim';
import { registerSystem } from '../systems';
import { BOARD_RANGE, CAB_STOPPED, takeHailer } from './taxi';

/**
 * A player with more stars than this is not waved down: one is what stealing the cab gets him (someone who saw it
 * calls it in); with more, the police are on his tail.
 */
export const HAIL_STARS = 1;
/** Seconds between looks for someone to wave the cab down. */
const SCAN = 0.5;
/** A hailer stands this far ahead of the cab along its heading (m)... */
const AHEAD_MIN = 18;
const AHEAD_MAX = 45;
/**
 * ...and no further than this to either side of it (m): at the curb of the road it drives, close enough that the cab
 * stopped level with him in its own lane is within BOARD_RANGE of him (not across an avenue's oncoming lanes).
 */
const SIDE = BOARD_RANGE - 0.5;
/** Only a cab going faster than this is waved down (m/s): one standing still is the job key's (taxi.ts prompt). */
const MOVING = 4;
/** The first hail comes this long after the player takes the wheel of a taxi (s)... */
const FIRST_HAIL_MIN = 3;
const FIRST_HAIL_MAX = 6;
/** ...and each next one this long after the last one ended (s). */
const NEXT_HAIL_MIN = 8;
const NEXT_HAIL_MAX = 16;
/** A hailer gives up after waving this long (s)... */
const HAIL_MAX = 15;
/** ...or once the cab is this far from him (m)... */
const HAIL_FAR = 70;
/** ...or has gone this far past him (m) and not stopped. */
const PASSED = 10;

/** One player's hail. */
interface Hail {
  /** The taxi he drives, null out of one: taking the wheel of another starts the wait for the first hail over. */
  cab: Vehicle | null;
  /** Seconds until someone may wave the cab down. */
  cooldown: number;
  /** Who is waving it down now. */
  ped: Character | null;
  /** Sim time he started. */
  since: number;
}

interface HailState {
  rng: Rng;
  scan: number;
  /** By slot id. */
  slots: Map<number, Hail>;
}

const states = new WeakMap<Sim, HailState>();

function update(sim: Sim, dt: number): void {
  let st = states.get(sim);
  if (!st) {
    st = { rng: new Rng(((sim.seed * 2246822519) ^ 0x74617869) >>> 0), scan: SCAN, slots: new Map() };
    states.set(sim, st);
  }
  st.scan -= dt;
  const scanning = st.scan <= 0;
  if (scanning) st.scan = SCAN;
  for (const slot of sim.players) {
    let h = st.slots.get(slot.id);
    if (!h) {
      h = { cab: null, cooldown: 0, ped: null, since: 0 };
      st.slots.set(slot.id, h);
    }
    const me = slot.character;
    const v = me.vehicle;
    if (!v || v.kind !== 'taxi' || v.driver !== me || !v.drivable || slot.down || slot.parked) {
      if (h.ped) giveUp(sim, st, h, true);
      h.cab = null;
      continue;
    }
    if (v !== h.cab) {
      h.cab = v;
      h.cooldown = st.rng.range(FIRST_HAIL_MIN, FIRST_HAIL_MAX);
    }
    h.cooldown -= dt;
    const job = sim.activities.jobOf(slot);
    // Free for a fare: a star at most, no story mission, a seat for him, and no job but the taxi's, on its way to one.
    const open = slot.wanted.level <= HAIL_STARS && !(slot.id === 0 && sim.missions.active) && v.passengers.includes(null) && (!job || (job.kind === 'taxi' && job.stage === 'pickup' && job.taxi === v));
    if (h.ped) follow(sim, st, slot, h, v, open, dt);
    else if (open && scanning && h.cooldown <= 0 && v.speed > MOVING) look(sim, h, v);
  }
}

/** The nearest pedestrian ahead at the curb, walking or standing about in plain sight of the cab, starts waving it down. */
function look(sim: Sim, h: Hail, v: Vehicle): void {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  let best: Character | null = null;
  let nearest = Infinity;
  for (const c of sim.characters) {
    if (c.removed || c.role !== 'civilian' || c.owner !== 'ped' || c.persistent || c.state !== 'normal' || c.hailTimer !== 0) continue;
    const b = c.brain;
    if (!b || (b.mode !== 'wander' && b.mode !== 'idle')) continue;
    const dx = c.pos.x - v.pos.x;
    const dz = c.pos.z - v.pos.z;
    const ahead = dx * fx + dz * fz;
    if (ahead < AHEAD_MIN || ahead > AHEAD_MAX || ahead >= nearest || Math.abs(dx * fz - dz * fx) > SIDE) continue;
    if (sim.world.isOnRoad(c.pos.x, c.pos.z)) continue;
    best = c;
    nearest = ahead;
  }
  if (!best || !sim.world.lineOfSight(best.pos.x, best.pos.y + 1.6, best.pos.z, v.pos.x, v.pos.y + 1.2, v.pos.z)) return;
  // He stands still for it; idle keeps him reacting to a gun or gunfire as he would on his walk (peds.ts), and its
  // timer outlasts the hail, so it is this system that sends him on his way.
  const b = best.brain!;
  b.mode = 'idle';
  b.modeTimer = HAIL_MAX + 1;
  best.hailTimer = HAIL_MAX;
  h.ped = best;
  h.since = sim.time;
  sim.events.emit('taxiHail', { caller: best, x: best.pos.x, y: best.pos.y + 1.6, z: best.pos.z, started: true, missed: false });
}

/** The hailer waves on, turned to the cab, until it stops beside him or leaves him standing. */
function follow(sim: Sim, st: HailState, slot: PlayerSlot, h: Hail, v: Vehicle, open: boolean, dt: number): void {
  const c = h.ped!;
  // Scared off (a gun, gunfire, a hit) or hurt: no grumbling after the cab.
  if (c.removed || c.state !== 'normal' || c.brain!.mode !== 'idle') {
    giveUp(sim, st, h, false);
    return;
  }
  const dx = c.pos.x - v.pos.x;
  const dz = c.pos.z - v.pos.z;
  const d = Math.hypot(dx, dz);
  const ahead = dx * Math.sin(v.heading) + dz * Math.cos(v.heading);
  if (!open || sim.time - h.since > HAIL_MAX || d > HAIL_FAR || (ahead < -PASSED && v.speed > CAB_STOPPED)) {
    giveUp(sim, st, h, true);
    return;
  }
  if (d < BOARD_RANGE && v.speed < CAB_STOPPED) {
    c.hailTimer = 0;
    h.ped = null;
    h.cooldown = st.rng.range(NEXT_HAIL_MIN, NEXT_HAIL_MAX);
    takeHailer(sim.activities.hostOf(slot), v, c);
    return;
  }
  c.hailTimer = HAIL_MAX - (sim.time - h.since);
  c.heading = moveAngleTowards(c.heading, Math.atan2(-dx, -dz), 6 * dt);
}

/** The hailer lowers his arm and walks on (from where his walk left off), grumbling when the cab left him standing. */
function giveUp(sim: Sim, st: HailState, h: Hail, missed: boolean): void {
  const c = h.ped!;
  c.hailTimer = 0;
  const b = c.brain!;
  if (b.mode === 'idle') b.mode = 'wander';
  sim.events.emit('taxiHail', { caller: c, x: c.pos.x, y: c.pos.y + 1.6, z: c.pos.z, started: false, missed });
  h.ped = null;
  h.cooldown = st.rng.range(NEXT_HAIL_MIN, NEXT_HAIL_MAX);
}

registerSystem({ id: 'taxiHail', slot: 'afterMissions', update, reset: (sim) => states.delete(sim) });
