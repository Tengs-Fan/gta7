// AzuraLink's $5 ride. E at the foot of a station's stairs waits for the next train; when it leaves, the fare is paid,
// the player's control is locked and he is taken to the other station's foot, where he stands out of sight while the
// camera rides beside the train (viewState.ts monorailRide). He steps out as it arrives, or at once with F. The ride
// holds the job slot, as the phone's cab does, and ends early on a mission start, wasted or busted. Single player only.

import { formatTime } from '../../core/math';
import { nextDeparture, runTime } from '../../world/monorail';
import type { Sim } from '../sim';
import { registerSystem } from '../systems';
import type { PlayerView } from '../viewState';
import type { ActivityDef, ActivityHost } from './types';

declare module './types' {
  interface JobKinds {
    monorail: MonorailJob;
  }
}

export interface MonorailJob {
  kind: 'monorail';
  /** The station he boards at (0 north, 1 south); the train takes him to the other. */
  from: number;
  stage: 'waiting' | 'riding';
  /** Sim time the train leaves, and arrives at the other station. */
  departs: number;
  arrives: number;
  /** Sim time at the last update, for the countdown. */
  now: number;
}

export const MONORAIL_FARE = 5;
/** Why the stations do nothing in a multiplayer game. */
export const MP_NO_MONORAIL = 'AzuraLink is single-player only.';
/** He waits for the train within this far (m) of the foot of the stairs; further, he has given up on it. */
const WAIT_REACH = 25;

/** The activity host of each Sim (Activities hands it to every def on attach). */
const hosts = new WeakMap<Sim, ActivityHost>();

function rideOf(sim: Sim): MonorailJob | null {
  const j = sim.activities.job;
  return j?.kind === 'monorail' ? j : null;
}

/** The far station's name: where the train from `from` goes. */
function destination(sim: Sim, from: number): string {
  return sim.world.layout.monorail.stations[1 - from]!.name;
}

/** Why `slot` cannot take the train right now, or null. */
export function monorailRefusal(sim: Sim, slot: PlayerView): string | null {
  if (sim.multiplayer || slot.id !== 0) return MP_NO_MONORAIL;
  if (slot.wanted.level > 0) return 'AzuraLink: no rides with the cops on your tail.';
  if (sim.missions.active) return 'AzuraLink: not during a mission.';
  const j = sim.activities.job;
  if (j && j.kind !== 'monorail') return 'Finish your job first.';
  if (slot.progress.money < MONORAIL_FARE) return `AzuraLink: the fare is $${MONORAIL_FARE}.`;
  return null;
}

/** What a station's marker says to `slot` standing on it: nothing while he is on the train (and out of sight on the far one's). */
export function monorailPrompt(sim: Sim, slot: PlayerView, station: number): string | null {
  const j = rideOf(sim);
  if (j?.stage === 'riding') return null;
  if (j && j.from === station) return `AzuraLink to ${destination(sim, station)}: the train leaves in ${formatTime(j.departs - sim.time)}.`;
  return monorailRefusal(sim, slot) ?? `Press E to ride AzuraLink to ${destination(sim, station)} ($${MONORAIL_FARE})`;
}

/** E on a station's marker: wait there for the next train, or hear why not. */
export function rideMonorail(sim: Sim, slot: PlayerView, station: number): void {
  const why = monorailRefusal(sim, slot);
  if (why) {
    sim.events.emit('message', { text: why, duration: 3, ...slot.tag });
    return;
  }
  if (rideOf(sim)) return;
  monorailActivity.start(hosts.get(sim)!, slot.character, null, String(station));
}

/** The train has left with him aboard: he pays, his control is locked, and he waits out of sight at the far station. */
function board(host: ActivityHost, j: MonorailJob): void {
  const sim = host.sim;
  const slot = host.slot;
  if (!slot.progress.spend(MONORAIL_FARE)) {
    host.end(`AzuraLink: the fare is $${MONORAIL_FARE}.`);
    return;
  }
  sim.events.emit('money', { amount: -MONORAIL_FARE });
  const foot = sim.world.layout.monorail.stations[1 - j.from]!.foot;
  const p = slot.character;
  p.pos.x = foot.x;
  p.pos.z = foot.z;
  p.pos.y = sim.world.groundHeight(foot.x, foot.z);
  p.vel.x = 0;
  p.vel.y = 0;
  p.vel.z = 0;
  p.heading = foot.heading;
  p.onGround = true;
  j.stage = 'riding';
  slot.controlLock = j.arrives - sim.time + 1;
  host.say(`AzuraLink to ${destination(sim, j.from)}. Press F to skip the ride.`, 6);
}

/** He steps out at the far station: control back. */
function arrive(host: ActivityHost, j: MonorailJob): void {
  host.slot.controlLock = 0;
  host.end(`AzuraLink: ${destination(host.sim, j.from)}. Mind the gap.`);
}

export const monorailActivity: ActivityDef<MonorailJob> = {
  kind: 'monorail',
  // Taken at a station's marker, never by the job key.
  priority: -2,
  onFoot: true,
  toggleEndText: 'You gave up on the train.',

  attach(host) {
    hosts.set(host.sim, host);
  },

  canStart: () => false,

  prompt: () => null,

  start(host, _slot, _vehicle, arg) {
    const sim = host.sim;
    const from = Number(arg);
    const departs = sim.time + nextDeparture(sim.world.layout.monorail, from, sim.time);
    const j: MonorailJob = { kind: 'monorail', from, stage: 'waiting', departs, arrives: departs + runTime(sim.world.layout.monorail), now: sim.time };
    host.job = j;
    host.say(`AzuraLink to ${destination(sim, from)}: the train leaves in ${formatTime(departs - sim.time)}. Wait here.`, 4);
    return true;
  },

  update(host, j) {
    const sim = host.sim;
    const slot = host.slot;
    j.now = sim.time;
    if (j.stage === 'waiting') {
      const p = slot.character;
      const foot = sim.world.layout.monorail.stations[j.from]!.foot;
      if (slot.wanted.level > 0) host.end('AzuraLink: no rides with the cops on your tail.');
      else if (p.state !== 'normal' || Math.hypot(p.pos.x - foot.x, p.pos.z - foot.z) > WAIT_REACH) host.end('You left the station.');
      else if (sim.time >= j.departs) board(host, j);
      return;
    }
    // Stars on the way (a witness's call): he is let off at once.
    if (sim.time >= j.arrives || slot.wanted.level > 0) arrive(host, j);
  },

  end(host, j) {
    // Ended by the game (a mission starting, wasted, busted) on the way: his control is his again.
    if (j.stage === 'riding') host.slot.controlLock = 0;
  },

  objectives: () => [],

  status(j) {
    if (j.stage === 'waiting') return `AZURALINK  ·  TRAIN IN ${formatTime(j.departs - j.now)}`;
    return `AZURALINK  ·  ${formatTime(j.arrives - j.now)}`;
  },

  abortText: () => '',
};

/** F on the train skips to the arrival. Runs before the player's controller, which does nothing while control is locked. */
registerSystem({
  id: 'monorail',
  slot: 'preInput',
  update(sim: Sim) {
    const j = rideOf(sim);
    const slot = sim.players[0]!;
    if (!j || j.stage !== 'riding' || !slot.input.enterExit || slot.down) return;
    slot.input.enterExit = false;
    arrive(hosts.get(sim)!, j);
  },
});
