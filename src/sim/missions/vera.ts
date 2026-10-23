// Vera Salgado's missions: chapter 2, offered once The Big Score is done.

import type { Character, Vehicle } from '../entities';
import type { Sim } from '../sim';
import type { VehicleKind, WeaponId } from '../specs';
import { guideOnFoot, secureCar, TIBURONES } from './helpers';
import type { MissionCtx, MissionDef, Script, Wait } from './runner';
import { chapter2Spots, type LaneSpot } from './spots';

const VERA = 'Vera Salgado';
// Every mission here requires big_score as well as the one before it, so that no set of done missions without The Big
// Score (a hand-edited save, say) ever offers one of them.
const VERA_PHONE = 'Vera Salgado (phone)';

/** Shadow Play: closer than this to the courier for longer than SPOT_GRACE, and he has seen the tail. */
export const TAIL_SPOT_DIST = 15;
export const TAIL_SPOT_GRACE = 3;
/** Farther than this for longer than LOST_GRACE, and he is gone. */
export const TAIL_LOST_DIST = 110;
export const TAIL_LOST_GRACE = 4;
/** The courier keeps to this speed (m/s), so that a car can follow him through town. */
const COURIER_SPEED = 11;

/** Room Service: the hotel entrance falls once attackers have stood in this radius for HOTEL_FALLS seconds. */
export const HOTEL_RADIUS = 8;
export const HOTEL_FALLS = 6;
/** Attackers per wave. */
export const WAVES = [3, 4, 5];

/** Showroom Condition: delivered below this condition, the collector pays half. */
export const SHOWROOM_CONDITION = 0.7;

/** Off the Road: a target at or below this condition is off the road; farther than ESCAPE_DIST for ESCAPE_GRACE, it got away. */
export const RAM_DISABLED = 0.4;
export const RAM_ESCAPE_DIST = 260;
export const RAM_ESCAPE_GRACE = 5;
export const RAM_TARGETS = 2;

/** Last Call: the stars the impound alarm pins the player at. */
export const LAST_CALL_STARS = 3;

/** The attempt of each mission that last ran in a Sim: its entities are cleared when it is started again. */
const lastAttempt = new WeakMap<Sim, Map<string, MissionCtx>>();

/**
 * Removes what the previous attempt of this mission left in the world (cleanup only releases it): on a retry, behind
 * its fade, everything, so the step starts with fresh entities and no duplicates; on a fresh start, what the player
 * cannot see, and never a car he has driven since.
 */
function clearLeftovers(m: MissionCtx): void {
  const sim = m.sim;
  let per = lastAttempt.get(sim);
  if (!per) lastAttempt.set(sim, (per = new Map()));
  const prev = per.get(m.def.id);
  per.set(m.def.id, m);
  if (!prev || prev === m) return;
  const unseen = (x: number, z: number) => !sim.isVisible(x, 1, z);
  for (const v of prev.vehicles) {
    if (v.removed || v.occupants().some((c) => c.isPlayer)) continue;
    if (m.retrying || (!v.usedByPlayer && unseen(v.pos.x, v.pos.z))) sim.removeVehicle(v);
  }
  for (const c of prev.characters) {
    if (c.removed || c.isPlayer || c.vehicle) continue;
    if (m.retrying || unseen(c.pos.x, c.pos.z)) sim.removeCharacter(c);
  }
}

/** The wanted level rises to `n` stars and is held there (see The Big Score's alarm). */
function pinWanted(sim: Sim, n: number): void {
  const w = sim.wanted;
  w.floor = n;
  const heat = w.heat;
  w.setLevel(Math.max(w.level, n));
  w.heat = Math.max(w.heat, heat);
}

/** The car Vera leaves on the lane in front of the hotel (or at `at`) for a job. */
function curbCar(m: MissionCtx, kind: VehicleKind, color: number, at?: LaneSpot): Vehicle {
  const p = at ?? chapter2Spots(m.sim.world).curb;
  return m.spawnVehicle(kind, p.x, p.z, p.heading, color);
}

/** Waits until the player drives a car (Vera's `car` or any other), pointing at hers meanwhile. */
function* getIn(m: MissionCtx, car: Vehicle, name: string, objective = `Get in the ${name}`): Script {
  const sim = m.sim;
  const driving = () => !!sim.player.vehicle && sim.player.vehicle.drivable && sim.player.vehicle.driver === sim.player;
  if (driving()) return;
  const mk = m.mark(car, name, 0x3dd9ff);
  m.objective(objective);
  yield m.until(driving);
  m.unmark(mk);
}

/**
 * Drives to a point, but while the police are after the player it does not count (nobody takes a delivery with
 * the cops in tow) and the objective says to lose them first. Returns goTo's result.
 */
function* deliverClean(m: MissionCtx, objective: string, x: number, z: number, opts: Parameters<MissionCtx['goTo']>[2]): Generator<Wait, boolean, undefined> {
  const sim = m.sim;
  const wanted = () => sim.wanted.level > 0;
  let shown = '';
  const show = () => {
    const text = wanted() ? 'Lose the cops first' : objective;
    if (text === shown) return;
    shown = text;
    m.objective(text);
  };
  show();
  const w = m.watch(show);
  try {
    return yield* m.goTo(x, z, { ...opts, hold: wanted });
  } finally {
    m.unwatch(w);
  }
}

/** The driving distance by road between two points (straight to and from the nearest nodes). */
function roadDistance(sim: Sim, from: { x: number; z: number }, to: { x: number; z: number }): number {
  const roads = sim.roads;
  const a = roads.nearestNode(from.x, from.z);
  const b = roads.nearestNode(to.x, to.z);
  const route = roads.findRoute(a.id, b.id) ?? [a.id, b.id];
  let len = Math.hypot(a.x - from.x, a.z - from.z) + Math.hypot(b.x - to.x, b.z - to.z);
  for (let i = 1; i < route.length; i++) {
    const p = roads.nodes[route[i - 1]!]!;
    const q = roads.nodes[route[i]!]!;
    len += Math.hypot(q.x - p.x, q.z - p.z);
  }
  return len;
}

/** Rush Hour's clock for driving from `from` through `stops`: the road distance at 12 m/s plus 10 s a stop. */
export function rushTime(sim: Sim, from: { x: number; z: number }, stops: ReadonlyArray<{ x: number; z: number }>): number {
  let len = 0;
  let at = from;
  for (const s of stops) {
    len += roadDistance(sim, at, s);
    at = s;
  }
  return Math.round(len / 12 + 10 * stops.length);
}

// --- 1. Shadow Play: tail a courier without being seen ------------------------

const shadowPlay: MissionDef = {
  id: 'shadow_play',
  title: 'Shadow Play',
  giver: 'vera',
  reward: 7000,
  requires: ['big_score'],
  blurb: 'Tail a Tiburones courier to his buyer without being seen.',
  retryAt(world) {
    return chapter2Spots(world).tailResume;
  },
  outro: { text: 'THE COURIER TALKED', sub: 'Vera knows who buys from the Tiburones', duration: 4 },
  *run(m) {
    const sim = m.sim;
    const spots = chapter2Spots(sim.world);
    clearLeftovers(m);
    yield* m.intro([
      [VERA, 'So you are the one who emptied the First Azura. Dex talks too much, but he was right about you.'],
      [VERA, 'A Tiburones courier leaves from up the street. Follow him to his buyer. Close enough to see, never close enough to be seen.'],
    ]);
    const resumed = m.resume >= 1;
    const car = curbCar(m, 'compact', 0x2e4053, resumed ? spots.tailResumeCar : undefined);
    const from = resumed ? spots.tailMeet : spots.tailStart;
    const courier = m.spawnDriver('sedan', from.lane, from.s, 'mission', 'route', resumed ? spots.tailEnd : spots.tailMeet);
    courier.color = TIBURONES;
    const ai = courier.ai!;
    ai.maxSpeed = COURIER_SPEED;
    const driver = courier.driver!;
    const mk = m.mark(courier, 'Courier');
    const dist = () => {
      const p = sim.playerPos();
      return Math.hypot(p.x - courier.pos.x, p.z - courier.pos.z);
    };
    m.failIf(() => courier.destroyed || courier.removed || !driver.alive || driver.vehicle !== courier, 'You blew your cover.');
    let close = 0;
    m.failIf((dt) => {
      close = dist() < TAIL_SPOT_DIST ? close + dt : 0;
      return close > TAIL_SPOT_GRACE;
    }, 'The courier spotted you.');
    let moving = false;
    let far = 0;
    m.failIf((dt) => {
      far = moving && dist() > TAIL_LOST_DIST ? far + dt : 0;
      return far > TAIL_LOST_GRACE;
    }, 'You lost the courier.');
    // He waits at the kerb until the player has a car.
    const wait = m.watch(() => {
      if (!moving) ai.hold = true;
    });
    const counter = m.watch(() => {
      const d = dist();
      m.counter = `COURIER ${Math.round(d)} m${d < TAIL_SPOT_DIST + 5 ? ' - TOO CLOSE' : d > TAIL_LOST_DIST - 20 ? ' - FALLING BEHIND' : ''}`;
    });
    yield* getIn(m, car, 'Pipsqueak', 'Tail the courier: take the Pipsqueak first');
    moving = true;
    ai.hold = false;
    m.unwatch(wait);
    const tail = `Tail the courier (stay ${TAIL_SPOT_DIST}-${TAIL_LOST_DIST} m back)`;
    m.objective(tail);
    if (!resumed) {
      yield m.until(() => ai.arrived);
      sim.events.emit('message', { text: 'The courier is meeting someone. Keep your distance.', duration: 3 });
      yield* m.wait(5);
      m.checkpoint(1);
      ai.setDestination(spots.tailEnd.x, spots.tailEnd.z);
      ai.maxSpeed = COURIER_SPEED;
      m.objective(tail);
    }
    yield m.until(() => ai.arrived);
    m.unwatch(counter);
    m.counter = null;
    m.unmark(mk);
    m.complete();
    yield* m.say(VERA_PHONE, 'An SAPD sergeant buying from the Tiburones. That is worth more than money. Come by the hotel.');
  },
};

// --- 2. Room Service: hold the hotel against waves ----------------------------

/** A wave of Tiburones at free sidewalk spots 30-45 m from the hotel, out of the player's view when possible. */
function spawnWave(m: MissionCtx, n: number, wave: number): Character[] {
  const sim = m.sim;
  const hotel = chapter2Spots(sim.world).vera;
  const out: Character[] = [];
  for (let tries = 0; tries < n * 12 && out.length < n; tries++) {
    const pt = sim.world.walk.randomPointNear(sim.rng, hotel.x, hotel.z, 30, 45);
    const spot = pt && sim.world.findFreeSpot(pt.x, pt.z, 0.4, 4);
    if (!spot || sim.world.waterDepth(spot.x, spot.z) > -0.1) continue;
    const d = Math.hypot(spot.x - hotel.x, spot.z - hotel.z);
    if (d < 28 || d > 47 || (tries < n * 8 && sim.isVisible(spot.x, 1, spot.z))) continue;
    const weapon: WeaponId = wave > 0 && out.length % 2 === 1 ? 'smg' : 'pistol';
    const c = m.spawnCharacter('gang', spot.x, spot.z, 'guard', weapon);
    // They march on the entrance (guard mode walks to its post), and fight whoever stands in their way.
    c.brain!.homeX = hotel.x + ((out.length % 3) - 1) * 2;
    c.brain!.homeZ = hotel.z + (Math.floor(out.length / 3) - 0.5) * 2;
    c.heading = Math.atan2(hotel.x - spot.x, hotel.z - spot.z);
    out.push(c);
  }
  return out;
}

const roomService: MissionDef = {
  id: 'room_service',
  title: 'Room Service',
  giver: 'vera',
  reward: 8000,
  requires: ['big_score', 'shadow_play'],
  blurb: 'The Tiburones come for Hotel Salgado. Hold the entrance.',
  outro: { text: 'HOTEL SALGADO STANDS', sub: 'The Tiburones will think twice', duration: 4 },
  *run(m) {
    const sim = m.sim;
    const hotel = chapter2Spots(sim.world).vera;
    clearLeftovers(m);
    yield* m.intro([
      [VERA, 'The sergeant told the Tiburones who was watching. Now they are coming here. To my hotel.'],
      [VERA, 'Take this and hold the door. Nobody walks into Hotel Salgado without a reservation.'],
    ]);
    m.givePlayer('smg', 300);
    sim.player.armor = 100;
    let attackers: Character[] = [];
    const up = (c: Character) => !c.removed && c.alive;
    let held = 0;
    m.failIf((dt) => {
      const inside = attackers.some((c) => up(c) && Math.hypot(c.pos.x - hotel.x, c.pos.z - hotel.z) < HOTEL_RADIUS);
      held = inside ? held + dt : Math.max(0, held - dt * 0.5);
      return held >= HOTEL_FALLS;
    }, 'The Tiburones took the hotel.');
    // Near the hotel they go for the player; with him gone, back to the entrance.
    const tactics = m.watch(() => {
      const p = sim.player;
      const pp = sim.playerPos();
      const near = p.alive && Math.hypot(pp.x - hotel.x, pp.z - hotel.z) < 35;
      for (const c of attackers) {
        const b = c.brain;
        if (!up(c) || !b) continue;
        if (near && b.mode === 'guard' && Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z) < 30) sim.peds.fight(c, p);
        else if (!near && b.mode === 'fight') {
          b.mode = 'guard';
          b.target = null;
          c.aiming = false;
        }
      }
    });
    for (let w = m.resume; w < WAVES.length; w++) {
      attackers = spawnWave(m, WAVES[w]!, w);
      const marks = attackers.map((c) => m.markEnemy(c, 'Tiburones'));
      const label = `Defend the hotel entrance (wave ${w + 1}/${WAVES.length})`;
      m.objective(label);
      const counter = m.watch(() => {
        const left = attackers.filter(up).length;
        attackers.forEach((c, i) => {
          if (!up(c)) m.unmark(marks[i]!);
        });
        m.counter = `WAVE ${w + 1}/${WAVES.length} - ${left} LEFT${held > 0 ? ` - ENTRANCE ${Math.round((held / HOTEL_FALLS) * 100)}%` : ''}`;
      });
      yield m.until(() => !attackers.some(up));
      m.unwatch(counter);
      if (w + 1 < WAVES.length) {
        m.checkpoint(w + 1);
        m.counter = `WAVE ${w + 2}/${WAVES.length} INCOMING`;
        sim.events.emit('message', { text: 'Wave cleared. More are coming.', duration: 3 });
        yield* m.wait(4);
      }
    }
    m.unwatch(tactics);
    m.counter = null;
    m.complete();
    yield* m.say(VERA, 'Not one of them got through the door. I like you, Kai. I have a buyer who will like you too.');
  },
};

// --- 3. Showroom Condition: steal a specific car, deliver it undamaged -------

/** The yellow of the Nightjar the collector wants. */
const SHOWROOM_YELLOW = 0xf1c40f;

const showroom: MissionDef = {
  id: 'showroom',
  title: 'Showroom Condition',
  giver: 'vera',
  reward: 9000,
  requires: ['big_score', 'room_service'],
  blurb: 'Steal a yellow Nightjar GT in Hillcrest and bring it in without a scratch.',
  retryAt(world) {
    return chapter2Spots(world).stealResume;
  },
  outro: { text: 'SOLD', sub: 'One yellow Nightjar GT, one happy collector', duration: 4 },
  *run(m) {
    const sim = m.sim;
    const spots = chapter2Spots(sim.world);
    clearLeftovers(m);
    yield* m.intro([
      [VERA, 'A collector wants a yellow Nightjar GT. One is parked in Hillcrest, with two Tiburones minding it.'],
      [VERA, `He pays for showroom condition. Below ${Math.round(SHOWROOM_CONDITION * 100)} percent, he pays half. Drive like it is your mother's.`],
    ]);
    const car = m.spawnVehicle('sports', spots.stealCar.x, spots.stealCar.z, spots.stealCar.heading, SHOWROOM_YELLOW);
    if (m.resume < 1) for (const g of spots.stealGuards) m.spawnCharacter('gang', g.x, g.z, 'guard', 'pistol');
    const wreck = m.failIf(() => car.destroyed || car.removed || car.inWater, 'The Nightjar was destroyed.');
    const condition = m.watch(() => {
      m.counter = sim.player.vehicle === car ? `NIGHTJAR CONDITION ${Math.round(car.condition * 100)}%` : null;
    });
    let stolen = m.resume >= 1;
    for (;;) {
      if (sim.player.vehicle !== car) {
        const mk = m.mark(car, 'Yellow Nightjar GT', stolen ? 0x3dd9ff : 0xff3b3b);
        m.objective(stolen ? 'Get back in the Nightjar' : 'Steal the yellow Nightjar GT');
        yield m.until(() => sim.player.vehicle === car);
        m.unmark(mk);
      }
      if (!stolen) {
        stolen = true;
        m.checkpoint(1);
      }
      const delivered = yield* deliverClean(
        m,
        `Deliver the yellow Nightjar GT to Hotel Salgado (below ${Math.round(SHOWROOM_CONDITION * 100)}% the buyer pays half)`,
        spots.curb.x,
        spots.curb.z,
        { radius: 5, label: 'Hotel Salgado', vehicle: car, maxSpeed: 6, abortIf: () => sim.player.vehicle !== car },
      );
      if (delivered) break;
    }
    const delivered = car.condition;
    if (delivered < SHOWROOM_CONDITION) m.reward = Math.round(m.def.reward / 2);
    m.unwatch(condition);
    m.counter = null;
    m.complete();
    m.clearFail(wreck);
    // The collector's driver takes the car: the player steps out at the hotel door.
    secureCar(car);
    sim.controlLock = 1.2;
    sim.events.emit('fade', { duration: 1.2 });
    yield* m.wait(0.6);
    if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
    const p = sim.player;
    p.pos.x = spots.vera.x;
    p.pos.z = spots.vera.z;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    p.heading = spots.vera.heading + Math.PI;
    yield* m.wait(0.6);
    yield* m.say(VERA, delivered < SHOWROOM_CONDITION ? 'He looked at the dents and paid half. Half, Kai.' : 'Not a scratch. The collector cried a little. Here is your money.');
  },
};

// --- 4. Off the Road: chase and ram the targets off the road --------------------

/** A target is off the road: wrecked, flipped or sunk, battered down to RAM_DISABLED, or its driver gone. */
export function rammedOff(v: Vehicle, driver: Character): boolean {
  return v.removed || !v.drivable || v.condition <= RAM_DISABLED || !driver.alive || driver.vehicle !== v;
}

const offTheRoad: MissionDef = {
  id: 'off_the_road',
  title: 'Off the Road',
  giver: 'vera',
  reward: 10000,
  requires: ['big_score', 'showroom'],
  blurb: 'Run two Tiburones cars carrying the sergeant\'s money off the road.',
  outro: { text: 'SPECIAL DELIVERY', sub: "The sergeant's money is Vera's now", duration: 4 },
  *run(m) {
    const sim = m.sim;
    clearLeftovers(m);
    yield* m.intro([
      [VERA, 'The Tiburones pay the sergeant tonight. Two cars, one envelope of cash in each.'],
      [VERA, 'The Dustrunner outside is heavier than anything they drive. Push them off the road.'],
    ]);
    const truck = curbCar(m, 'pickup', 0x7d6608);
    yield* getIn(m, truck, 'Dustrunner');
    for (let i = m.resume; i < RAM_TARGETS; i++) {
      const spot = m.laneSpotNear(110, 170);
      const target = spot ? m.spawnDriver('sedan', spot.lane, spot.s, 'gang', 'traffic') : null;
      if (!target) {
        // Nowhere clear to put one (never so far): the mission cannot go on.
        m.failIf(() => true, 'The Tiburones changed their plans.');
        yield m.until(() => false);
        return;
      }
      target.color = TIBURONES;
      const driver = target.driver!;
      const mk = m.mark(target, 'Tiburones car');
      m.objective(`Ram the Tiburones car off the road (${i + 1}/${RAM_TARGETS})`);
      const dist = () => {
        const p = sim.playerPos();
        return Math.hypot(p.x - target.pos.x, p.z - target.pos.z);
      };
      let far = 0;
      const escape = m.failIf((dt) => {
        far = dist() > RAM_ESCAPE_DIST ? far + dt : 0;
        return far > RAM_ESCAPE_GRACE;
      }, 'The Tiburones car escaped.');
      let fleeing = false;
      const chase = m.watch(() => {
        m.counter = `TARGET ${Math.round(target.condition * 100)}%`;
        if (!fleeing && dist() < 60 && target.ai) {
          fleeing = true;
          target.ai.setPolicy('flee');
          target.ai.target = sim.player;
          sim.events.emit('message', { text: 'He has seen you! Do not let him get away.', duration: 3 });
        }
      });
      yield m.until(() => rammedOff(target, driver));
      m.unwatch(chase);
      m.clearFail(escape);
      m.unmark(mk);
      m.counter = null;
      // Off the road, he stays put until the mission is over.
      m.watch(() => {
        if (target.ai && !target.removed) target.ai.hold = true;
      });
      if (i + 1 < RAM_TARGETS) {
        sim.events.emit('message', { text: 'One down. The second car is on its way.', duration: 3 });
        m.checkpoint(i + 1);
      }
    }
    m.complete();
    yield* m.say(VERA_PHONE, 'Both envelopes, and the sergeant has nothing to pay his debts with. Beautiful work.');
  },
};

// --- 5. Rush Hour: a timed run of pickups ---------------------------------------

const rushHour: MissionDef = {
  id: 'rush_hour',
  title: 'Rush Hour',
  giver: 'vera',
  reward: 12000,
  requires: ['big_score', 'off_the_road'],
  blurb: 'Collect three envelopes across town and bring them back before the clock runs out.',
  outro: { text: 'BANKED', sub: 'Every envelope home before the banks closed', duration: 4 },
  *run(m) {
    const sim = m.sim;
    const spots = chapter2Spots(sim.world);
    clearLeftovers(m);
    yield* m.intro([
      [VERA, 'Three of my runners hold envelopes for me across town. The banks close soon, and the envelopes must be here first.'],
      [VERA, 'Take the Thunderhoof. Do not stop to admire the view.'],
    ]);
    const car = curbCar(m, 'muscle', 0x1a5276);
    yield* getIn(m, car, 'Thunderhoof');
    const stops = [...spots.pickupStops, spots.curb];
    const total = stops.length;
    const first = m.resume >= 1 ? 2 : 0;
    m.setTimer('RUSH HOUR', rushTime(sim, sim.playerPos(), stops.slice(first)), 'Out of time: the banks closed.');
    for (let i = first; i < total; i++) {
      const s = stops[i]!;
      const last = i === total - 1;
      m.objective(last ? `Bring the envelopes back to Vera (stop ${i + 1}/${total})` : `Collect the envelope (stop ${i + 1}/${total})`);
      yield* m.goTo(s.x, s.z, { radius: 5, label: last ? 'Hotel Salgado' : `Stop ${i + 1}`, vehicle: 'any', maxSpeed: 9 });
      if (!last) sim.events.emit('message', { text: `Envelope ${i + 1}/${total - 1} collected`, duration: 2 });
      if (i === 1) m.checkpoint(1);
    }
    m.clearTimer();
    m.complete();
    yield* m.say(VERA, 'With time to spare. Now, Kai, the real job. The sergeant keeps his ledger in the SAPD impound.');
  },
};

// --- 6. Last Call: the finale, with 3 stars and a getaway -----------------------

const lastCall: MissionDef = {
  id: 'last_call',
  title: 'Last Call',
  giver: 'vera',
  reward: 15000,
  requires: ['big_score', 'rush_hour'],
  blurb: "Steal the sergeant's ledger from the SAPD impound lot, then lose the police.",
  outro: { text: 'CHAPTER 2 COMPLETE', sub: 'San Azura answers to Vera Salgado, and to you', duration: 6 },
  *run(m) {
    const sim = m.sim;
    const spots = chapter2Spots(sim.world);
    clearLeftovers(m);
    yield* m.intro([
      [VERA, 'The sergeant keeps a ledger: every payment, every name. Mine too. It sits in an evidence box in the impound lot by SAPD Central.'],
      [VERA, 'The moment you touch it the whole station comes out. Take the rifle, grab the box, and lose them.'],
    ]);
    m.givePlayer('rifle', 180);
    sim.player.armor = 100;
    if (m.resume < 1) {
      const ev = spots.evidence;
      const box = m.spawnParcel(ev.x, ev.z);
      const mk = m.mark(ev, 'Evidence box', 0x3dd9ff, 1.5);
      const guide = guideOnFoot(m, ev, 'Steal the evidence box from the SAPD impound lot', 'Get out of the car and grab the evidence box');
      // The alarm goes as he walks into the lot: the stars come before the box does, and stay while he is there.
      let alarm = false;
      const alarmWatch = m.watch(() => {
        if (alarm || sim.distToPlayer(ev.x, ev.z) > 30) return;
        alarm = true;
        pinWanted(sim, LAST_CALL_STARS);
        sim.events.emit('message', { text: 'The impound alarm is ringing!', duration: 3 });
      });
      yield m.until(() => !box.active || box.removed);
      m.unwatch(guide);
      m.unwatch(alarmWatch);
      m.unmark(mk);
      if (!alarm) pinWanted(sim, LAST_CALL_STARS);
      m.objective('Get to a car');
      yield m.until(() => !!sim.player.vehicle && sim.player.vehicle.drivable);
      m.checkpoint(1);
    } else {
      // Back with the ledger and the police still looking: a car at the hotel door.
      const car = curbCar(m, 'sports', 0x1c1c1c);
      sim.wanted.setLevel(LAST_CALL_STARS);
      yield* getIn(m, car, 'Nightjar GT', 'Get in the Nightjar GT');
    }
    sim.wanted.floor = 0;
    m.objective('Lose the cops');
    yield m.until(() => sim.wanted.level === 0);
    m.complete();
    yield* m.say(VERA_PHONE, 'The ledger is in my safe and the sergeant is on a plane. San Azura is ours, Kai.');
  },
};

export const VERA_MISSIONS: MissionDef[] = [shadowPlay, roomService, showroom, offTheRoad, rushHour, lastCall];
