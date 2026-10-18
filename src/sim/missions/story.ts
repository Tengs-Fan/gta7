// The San Azura story: six missions for two contacts.

import { clamp } from '../../core/math';
import type { Objective } from '../activities';
import { makeBrain } from '../brains';
import { DriverAI } from '../driver';
import type { Character, Vehicle } from '../entities';
import type { Sim } from '../sim';
import type { MissionCtx, MissionDef, Script, Wait } from './runner';
import { missionSpots } from './spots';

const LOU = 'Mama Lou';
const LOU_PHONE = 'Mama Lou (phone)';
const DEX = 'Dex Moreau';
/** Tiburones teal: their vans and cars. */
const TIBURONES = 0x0e7c7b;
/** Police officers on foot the bank alarm keeps around the bank at most (see The Big Score). */
const MAX_RESPONDERS = 6;

/**
 * The car a mission ends in, the moment it is accepted, with the player about to be locked inside it: its fire
 * is put out (it would blow up with him in it) and it is stopped dead (the lock leaves him only the handbrake).
 */
function secureCar(v: Vehicle | null): void {
  if (!v || v.removed || v.destroyed) return;
  v.burning = false;
  v.burnTimer = 0;
  // At <= 0 HP any stray hit would set it alight again.
  v.health = Math.max(v.health, 1);
  v.vel.x = 0;
  v.vel.z = 0;
  v.angVel = 0;
  v.controls.handbrake = true;
}

/** Ends a garage delivery: the player steps out on the sidewalk, Lou keeps the car. */
function* handOver(m: MissionCtx, v: Vehicle | null): Script {
  const sim = m.sim;
  // Lou's crew kills the fire the moment the car is accepted.
  secureCar(v);
  sim.controlLock = 1.4;
  sim.events.emit('fade', { duration: 1.4 });
  yield* m.wait(0.7);
  const spots = missionSpots(sim.world);
  if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
  const p = sim.player;
  p.pos.x = spots.lou.x;
  p.pos.z = spots.lou.z;
  p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
  p.heading = spots.lou.heading;
  if (v && !v.removed) {
    // Park the delivered car neatly inside the garage.
    v.vel.x = 0;
    v.vel.z = 0;
    v.angVel = 0;
    v.pos.x = spots.louBay.x;
    v.pos.z = spots.louBay.z;
    v.heading = spots.lou.heading + Math.PI;
    v.controls.handbrake = true;
  }
  yield* m.wait(0.7);
}

/**
 * Drives a car into Lou's garage (`opts` as for goTo). Lou takes no car with the police after it, which would
 * follow it in and arrest the player during the hand-over: while he is wanted, getting there does not count
 * and the objective says to lose them first. Returns goTo's result.
 */
function* toLouGarage(m: MissionCtx, objective: string, opts: Parameters<MissionCtx['goTo']>[2]): Generator<Wait, boolean, undefined> {
  const sim = m.sim;
  const spots = missionSpots(sim.world);
  const wanted = () => sim.wanted.level > 0;
  let shown = '';
  const show = () => {
    const text = wanted() ? 'Lose the cops first' : objective;
    if (text === shown) return;
    shown = text;
    m.objective(text);
  };
  show();
  const watch = m.watch(show);
  try {
    return yield* m.goTo(spots.louBay.x, spots.louBay.z, { ...opts, area: spots.lou.bay!, label: "Lou's garage", radius: 4, hold: wanted });
  } finally {
    m.unwatch(watch);
  }
}

/**
 * The bank's alarm: the wanted level rises to `n` stars and is pinned there, never lowered, nor the heat behind it,
 * and the police learn where the player is (setLevel's sighting), even when he already has `n` stars or more.
 */
function pinWanted(sim: Sim, n: number): void {
  const w = sim.wanted;
  w.floor = n;
  const heat = w.heat;
  w.setLevel(Math.max(w.level, n));
  w.heat = Math.max(w.heat, heat);
}

/** A Tiburones car sent after the player from `minD`-`maxD` m away (out of his view when possible). */
function sendChaser(m: MissionCtx, kind: 'muscle' | 'sedan', minD: number, maxD: number): Vehicle | null {
  const spot = m.laneSpotNear(minD, maxD);
  if (!spot) return null;
  const v = m.spawnDriver(kind, spot.lane, spot.s, 'gang', 'chase');
  v.color = TIBURONES;
  v.ai!.target = m.sim.player;
  return v;
}

/** The car is still after the player: in one piece and driven by the crew it was sent with. */
function chasing(v: Vehicle | null, crew: Character | null): boolean {
  return !!v && !!crew && !v.removed && v.drivable && v.driver === crew && crew.alive;
}

/** Red markers on cars sent after the player, each taken off once its car is out of the chase. */
function markChasers(m: MissionCtx, cars: Vehicle[]): number {
  const crews = cars.map((v) => v.driver);
  const marks: Array<Objective | null> = cars.map((v) => m.markEnemy(v, 'Tiburones'));
  return m.watch(() => {
    cars.forEach((v, i) => {
      const mk = marks[i];
      if (mk && !chasing(v, crews[i] ?? null)) {
        m.unmark(mk);
        marks[i] = null;
      }
    });
  });
}

/** A van's crew, those still by it, piles in and drives off away from the player (a new driver if none is). */
function makeRun(m: MissionCtx, v: Vehicle, crew: Character[]): void {
  const sim = m.sim;
  const free = crew.filter((c) => !c.removed && c.alive && c.state === 'normal' && Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z) < 15);
  const driver = free.shift();
  if (driver) {
    driver.aiming = false;
    sim.seat(driver, v, 0);
    v.ai = new DriverAI(sim, v, 'flee');
  } else {
    m.addDriver(v, 'gang', 'flee');
  }
  const mate = free.shift();
  if (mate && v.passengers.includes(null)) {
    mate.aiming = false;
    sim.seat(mate, v, v.passengers.indexOf(null) + 1);
  }
  v.ai!.target = sim.player;
}

/** Hot Delivery's drop: the radius of its marker, and how far from its centre the buyer waits. */
const DROP_RADIUS = 4;
/**
 * Outside the marker by more than a car's reach (the corner of the biggest car but the bus, 3.1 m, plus
 * his own 0.4 m): no car with its centre in the marker, where the delivery counts, can touch him.
 */
const BUYER_FROM_DROP = DROP_RADIUS + 3.5;

/**
 * Where the buyer waits: beside the drop, to one side of the way the GPS leads in (its last leg comes
 * from the junction nearest the drop, see gpsRoute), so that a car driven into the marker that way
 * neither passes through him nor runs on into him. At today's drop, in a park with a road on each side,
 * that puts him on a diagonal: straight in from any of the four roads misses him too.
 */
function buyerSpot(sim: Sim, drop: { x: number; z: number }): { x: number; z: number } {
  const w = sim.world;
  const node = sim.roads.nearestNode(drop.x, drop.z);
  const road = Math.atan2(node.x - drop.x, node.z - drop.z);
  for (const off of [0, 0.35, -0.35, 0.7, -0.7]) {
    for (const side of [1, -1]) {
      const a = road + side * (Math.PI / 2 + off);
      const x = drop.x + Math.sin(a) * BUYER_FROM_DROP;
      const z = drop.z + Math.cos(a) * BUYER_FROM_DROP;
      if (w.isFree(x, z, 0.5) && w.waterDepth(x, z) <= -0.1) return { x, z };
    }
  }
  // Nowhere free at that distance (not so at today's drop): the nearest free spot to the first choice.
  const a = road + Math.PI / 2;
  const x = drop.x + Math.sin(a) * BUYER_FROM_DROP;
  const z = drop.z + Math.cos(a) * BUYER_FROM_DROP;
  return w.findFreeSpot(x, z, 0.5, 4) ?? { x, z };
}

/** Seconds the buyer waits: the drive by road at 10 m/s plus 15 s, kept within 60-90 s. */
function deliveryTime(sim: Sim, from: { x: number; z: number }, to: { x: number; z: number }): number {
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
  return Math.round(clamp(len / 10 + 15, 60, 90));
}

const wheels: MissionDef = {
  id: 'wheels',
  title: 'Wheels',
  giver: 'lou',
  reward: 500,
  requires: [],
  blurb: 'Mama Lou needs a car. Any car.',
  *run(m) {
    const spots = missionSpots(m.sim.world);
    const pp = m.sim.playerPos();
    // Away from her garage (the New Game opening), Lou calls instead.
    if (Math.hypot(pp.x - spots.lou.x, pp.z - spots.lou.z) > 15) {
      yield* m.intro([
        [LOU_PHONE, 'Kai Navarro! Six years inside and not one postcard. Welcome home, baby.'],
        [LOU_PHONE, 'You need money, I need cars. Steal one and bring it to my garage in the Docks.'],
      ]);
    } else {
      yield* m.intro([
        [LOU, 'Kai Navarro! Six years inside and you still walk like you own the street.'],
        [LOU, "You need money, I need cars. Bring me one. Any car. I don't ask whose."],
      ]);
    }
    m.objective('Steal a car');
    yield m.until(() => !!m.playerVehicle()?.drivable);
    yield* toLouGarage(m, "Drive it into Lou's garage", { vehicle: 'any', maxSpeed: 5 });
    m.complete();
    const v = m.playerVehicle();
    if (v) m.vehicles.push(v);
    yield* handOver(m, v);
    yield* m.say(LOU, "Not bad, baby. Not bad at all. Come see me again, I'll have real work.");
  },
};

const delivery: MissionDef = {
  id: 'delivery',
  title: 'Hot Delivery',
  giver: 'lou',
  reward: 1200,
  requires: ['wheels'],
  blurb: 'Pick up a package in Midtown and get it to Hillcrest. Fast.',
  *run(m) {
    const sim = m.sim;
    const spots = missionSpots(sim.world);
    const pick = spots.packagePickup;
    const drop = spots.packageDrop;
    // The parcel waits in the parking lot, the buyer beside the drop, facing it.
    const parcel = m.spawnParcel(pick.x, pick.z);
    const at = buyerSpot(sim, drop);
    const buyer = m.spawnCharacter('mission', at.x, at.z, 'stand');
    buyer.heading = Math.atan2(drop.x - at.x, drop.z - at.z);
    const deal = m.failIf(() => buyer.removed || !buyer.alive, 'The buyer is dead.');
    yield* m.intro([
      [LOU, "One of my boys dropped a package in a Midtown parking lot. Don't ask what's in it."],
      [LOU, 'Buyer waits in Hillcrest. He gets nervous, he walks. Move it!'],
    ]);
    m.objective('Collect the package');
    const mk = m.mark(pick, 'Package', 0x3dd9ff, 1.5);
    yield m.until(() => !parcel.active || parcel.removed);
    m.unmark(mk);
    m.setTimer('DELIVERY', deliveryTime(sim, pick, drop), 'The buyer walked.');
    // The Tiburones saw the pickup: a car comes after the package. The buyer won't deal with it in tow.
    const tail = sendChaser(m, 'muscle', 80, 140);
    const crew = tail?.driver ?? null;
    const tailed = () => chasing(tail, crew) && sim.distToPlayer(tail!.pos.x, tail!.pos.z) < 60;
    const deliver = 'Deliver the package to Hillcrest';
    m.objective(deliver);
    const marks = tail ? markChasers(m, [tail]) : -1;
    let losing = false;
    let clear = 0;
    const lose = m.watch((dt) => {
      const near = tailed();
      clear = near ? 0 : clear + dt;
      if (near && !losing) {
        losing = true;
        m.objective('Lose the tail');
      } else if (losing && (clear > 1.5 || !chasing(tail, crew))) {
        losing = false;
        m.objective(deliver);
      }
    });
    yield* m.goTo(drop.x, drop.z, { radius: DROP_RADIUS, label: 'Buyer', hold: tailed });
    m.complete();
    // Delivered: what happens to the buyer now is his own business.
    m.clearFail(deal);
    m.unwatch(lose);
    m.unwatch(marks);
    m.clearTimer();
    yield* m.say(LOU, "Buyer's happy, I'm happy. Here's your cut.");
  },
};

const repo: MissionDef = {
  id: 'repo',
  title: 'Repo Man',
  giver: 'lou',
  reward: 2500,
  requires: ['delivery'],
  blurb: 'Steal a Nightjar GT from the Tiburones and bring it to Lou.',
  *run(m) {
    const sim = m.sim;
    const spots = missionSpots(sim.world);
    yield* m.intro([
      [LOU, 'The Tiburones owe me a car: a red Nightjar GT, parked in Westside with three of them babysitting it.'],
      [LOU, 'Take this. Bring the car back without too many holes in it.'],
    ]);
    m.givePlayer('pistol', 72);
    const car = m.spawnVehicle('sports', spots.repoCar.x, spots.repoCar.z, spots.repoCar.heading, 0xc0392b);
    for (const g of spots.repoGuards) m.spawnCharacter('gang', g.x, g.z, 'guard', 'pistol');
    const wreck = m.failIf(() => car.destroyed || car.removed || car.inWater, 'The Nightjar was wrecked.');
    // Whenever the player is out of the Nightjar, point back at it instead of at the garage.
    let stolen = false;
    let chasers = -1;
    for (;;) {
      if (sim.player.vehicle !== car) {
        const mk = m.mark(car, 'Nightjar GT', stolen ? 0x3dd9ff : 0xff3b3b);
        m.objective(stolen ? 'Get back in the Nightjar' : 'Steal the Nightjar GT');
        yield m.until(() => sim.player.vehicle === car);
        m.unmark(mk);
        stolen = true;
      }
      if (chasers < 0) {
        // The theft does not go unnoticed: two more Tiburones cars come for the Nightjar.
        const cars = [sendChaser(m, 'muscle', 100, 160), sendChaser(m, 'sedan', 100, 160)].filter((v): v is Vehicle => !!v);
        chasers = markChasers(m, cars);
      }
      const delivered = yield* toLouGarage(m, "Bring the Nightjar to Lou's garage", { vehicle: car, maxSpeed: 5, abortIf: () => sim.player.vehicle !== car });
      if (delivered) break;
    }
    // Lou pays less for a battered car (set before complete, which pays it).
    const condition = car.condition;
    if (condition < 0.5) m.reward = Math.round(m.def.reward * 0.6);
    m.complete();
    // Lou has the car now: whatever happens to it afterwards is her problem.
    m.clearFail(wreck);
    yield* handOver(m, car);
    yield* m.say(LOU, condition < 0.5 ? 'You call this a delivery? I pay for cars, not scrap. Less money.' : "Look at that paint. You're my favorite now.");
    yield* m.say(LOU, "A friend of mine, Dex Moreau, wants to meet you. Moreau Tower, downtown. Be nice to him.");
  },
};

const looseLips: MissionDef = {
  id: 'loose_lips',
  title: 'Loose Lips',
  giver: 'dex',
  reward: 4000,
  requires: ['repo'],
  blurb: 'Stop an informant before he reaches the police.',
  *run(m) {
    const sim = m.sim;
    yield* m.intro([
      [DEX, "So you are Lou's miracle worker. Charming. I have a problem with a mouth."],
      [DEX, 'Benny Two-Tone is driving to the police with my name in his notebook. Make sure he never arrives.'],
    ]);
    const police = sim.world.layout.pois.find((p) => p.id === 'police')!;
    // Benny starts a good drive away from the station, so there is time to catch him: by road, to
    // the end of his lane (no U-turns) and on to either end of the station's block.
    const roads = sim.roads;
    const street = roads.nearestLane(police.x, police.z).lane;
    const ends = [street.from, street.to].map((id) => ({ field: roads.distanceField(id), rest: Math.hypot(roads.nodes[id]!.x - police.x, roads.nodes[id]!.z - police.z) }));
    const byRoad = (v: Vehicle) => {
      const { lane, s } = roads.nearestLane(v.pos.x, v.pos.z, v.heading);
      return lane.length - s + Math.min(...ends.map((e) => e.field[lane.to]! + e.rest));
    };
    let target: Vehicle | null = null;
    let spare: Vehicle | null = null;
    for (let tries = 0; tries < 8 && !target; tries++) {
      const v = sim.traffic.trySpawnTraffic(90, 170, 'sedan');
      if (!v) {
        yield* m.wait(0.4);
      } else if (byRoad(v) >= 300) {
        target = v;
      } else if (!spare || byRoad(v) > byRoad(spare)) {
        // Too close to the station: keep the farthest one in case nothing better turns up.
        if (spare) sim.removeVehicle(spare);
        spare = v;
      } else {
        sim.removeVehicle(v);
      }
    }
    if (target && spare) sim.removeVehicle(spare);
    // Fallback: any clear lane point in range, even if the player can see it.
    target = target ?? spare ?? sim.traffic.spawnTrafficAnywhere(60, 260, 'sedan');
    if (!target) {
      yield* m.say(DEX, 'Benny slipped through my fingers today. Come back later.');
      m.failIf(() => true, 'Benny never showed up.');
      yield m.until(() => false);
      return;
    }
    const benny = target.driver!;
    target.owner = 'mission';
    target.persistent = true;
    target.missionTag = m.def.id;
    target.color = 0x6c3483;
    benny.owner = 'mission';
    benny.persistent = true;
    benny.missionTag = m.def.id;
    // Traffic drivers spawn without a brain: give Benny one so he can run once he is out of his car.
    benny.brain = makeBrain('wander');
    m.vehicles.push(target);
    m.characters.push(benny);
    const t = target;
    t.ai?.setDestination(police.x, police.z);
    // Track Benny himself, in his car or on foot (carjacked, bailed out).
    const bennyPos = () => benny.vehicle?.pos ?? benny.pos;
    // removed = drowned with a sinking car
    const bennyDown = () => !benny.alive || benny.removed;
    const mk = m.mark(benny, 'Benny');
    m.objective('Take out Benny');
    let farFor = 0;
    const escape = m.failIf((dt) => {
      const p = bennyPos();
      farFor = !bennyDown() && sim.distToPlayer(p.x, p.z) > 330 ? farFor + dt : 0;
      return farFor > 10;
    }, 'Benny got away.');
    const singing = m.failIf(() => {
      const p = bennyPos();
      return !bennyDown() && Math.hypot(p.x - police.x, p.z - police.z) < 25;
    }, 'Benny is singing to the SAPD.');
    const showDistance = () => {
      const left = t.ai && benny.vehicle === t ? t.ai.routeRemaining() : Infinity;
      m.counter = Number.isFinite(left) ? `BENNY TO SAPD ${Math.round(left / 10) * 10} m` : null;
    };
    showDistance();
    const counter = m.watch(showDistance);
    // He panics and flees once he notices you, and forgets about the police.
    yield m.until(() => {
      const p = bennyPos();
      return sim.distToPlayer(p.x, p.z) < 60 || bennyDown();
    });
    m.unwatch(counter);
    m.counter = null;
    m.clearFail(singing);
    if (t.ai && !bennyDown() && benny.vehicle === t) {
      t.ai.setPolicy('flee');
      t.ai.dest = null;
      t.ai.target = sim.player;
      sim.events.emit('message', { text: "Benny spotted you! Don't let him escape.", duration: 3 });
    }
    yield m.until(bennyDown);
    m.complete();
    m.clearFail(escape);
    m.unmark(mk);
    yield* m.say(DEX, 'Benny will be very quiet from now on. Come see me, there is more.');
  },
};

const heatwave: MissionDef = {
  id: 'heatwave',
  title: 'Heatwave',
  giver: 'dex',
  reward: 6000,
  requires: ['loose_lips'],
  blurb: 'Destroy three Tiburones vans spread across the city, then lose the heat.',
  *run(m) {
    const sim = m.sim;
    const spots = missionSpots(sim.world);
    if (m.resume < 1) {
      yield* m.intro([
        [DEX, 'The Tiburones keep three vans full of my merchandise. They stole it. I want it gone.'],
        [DEX, 'Burn every van. A gift for the job.'],
      ]);
      m.givePlayer('smg', 240);
      const vans = spots.vans.map((s) => m.spawnVehicle('van', s.x, s.z, s.heading, TIBURONES));
      // Two guards with SMGs at each van, one by either side.
      const crews = new Map<Vehicle, Character[]>();
      for (const v of vans) {
        const fx = Math.sin(v.heading);
        const fz = Math.cos(v.heading);
        const sx = Math.cos(v.heading);
        const sz = -Math.sin(v.heading);
        const crew: Character[] = [];
        for (const side of [1, -1]) {
          const x = v.pos.x + sx * side * (v.halfW + 1.4) + fx * side * 1.5;
          const z = v.pos.z + sz * side * (v.halfW + 1.4) + fz * side * 1.5;
          const g = sim.world.findFreeSpot(x, z, 0.5, 5);
          if (g) crew.push(m.spawnCharacter('gang', g.x, g.z, 'guard', 'smg'));
        }
        crews.set(v, crew);
      }
      const marks = vans.map((v) => m.mark(v, 'Van'));
      const gone = (v: Vehicle) => v.destroyed || v.removed || v.inWater;
      m.objective('Destroy the vans (0/3)');
      let last = 0;
      yield m.until(() => {
        const d = vans.filter(gone).length;
        if (d !== last) {
          last = d;
          vans.forEach((v, i) => {
            if (gone(v)) m.unmark(marks[i]!);
          });
          m.objective(`Destroy the vans (${d}/3)`);
          if (d === 1 && sim.wanted.level < 2) sim.wanted.setLevel(2);
          // The last crew makes a run for it.
          const runner = d === 2 ? vans.find((v) => !gone(v)) : undefined;
          if (runner && runner.drivable && !runner.driver) {
            makeRun(m, runner, crews.get(runner) ?? []);
            sim.events.emit('message', { text: 'The last van is making a run for it!', duration: 3 });
          }
        }
        return d >= 3;
      });
      m.checkpoint(1);
    } else {
      m.givePlayer('smg', 240);
    }
    if (sim.wanted.level < 2) sim.wanted.setLevel(2);
    m.objective('Lose the cops');
    yield m.until(() => sim.wanted.level === 0);
    m.complete();
    yield* m.say(DEX, 'I can smell it from my balcony. Wonderful. Now, the real job...');
  },
};

const bigScore: MissionDef = {
  id: 'big_score',
  title: 'The Big Score',
  giver: 'dex',
  reward: 25000,
  requires: ['heatwave'],
  blurb: 'Rob the First Azura Bank and escape to the Marina.',
  *run(m) {
    const sim = m.sim;
    const spots = missionSpots(sim.world);
    const bank = spots.bank;
    if (m.resume < 1) {
      // Two armed guards watch the door.
      const fx = Math.sin(bank.heading);
      const fz = Math.cos(bank.heading);
      const sx = Math.cos(bank.heading);
      const sz = -Math.sin(bank.heading);
      for (const side of [1, -1]) {
        const at = sim.world.findFreeSpot(bank.x + sx * side * 3 + fx * 1.5, bank.z + sz * side * 3 + fz * 1.5, 0.4, 4);
        if (!at) continue;
        const g = m.spawnCharacter('mission', at.x, at.z, 'guard', 'pistol');
        g.missionTag = 'enemy';
        g.brain!.hostile = true;
        g.brain!.brave = true;
        g.heading = bank.heading;
        g.appearance = { ...g.appearance, shirt: 0xc9ccd1, pants: 0x26282b, hat: 0x17181a };
      }
      yield* m.intro([
        [DEX, 'First Azura Bank. The vault opens on a timer: twenty seconds, and the whole city will hear it.'],
        [DEX, 'Hold the entrance, take the car outside, and my boat waits at the Marina. Do not be late.'],
      ]);
      m.givePlayer('rifle', 180);
      sim.player.armor = 100;
      m.objective('Go to the First Azura Bank');
      yield* m.goTo(bank.x, bank.z, { radius: 2.5, label: 'Bank', onFoot: true });
      m.objective('Hold the bank entrance while the vault opens');
      pinWanted(sim, 3);
      let progress = 0;
      let wave = 0;
      let swat = false;
      const responders: Character[] = [];
      yield m.until((dt) => {
        const p = sim.player;
        const inside = p.state === 'normal' && Math.hypot(p.pos.x - bank.x, p.pos.z - bank.z) < 9;
        progress = Math.max(0, progress + (inside ? dt : -0.5 * dt));
        m.counter = `VAULT ${Math.floor((progress / 20) * 100)}%`;
        // The alarm brings the police: officers on foot every few seconds, a SWAT team halfway through.
        if (sim.policeEnabled) {
          wave += dt;
          if (wave >= 4) {
            wave -= 4;
            const n = Math.min(2, MAX_RESPONDERS - responders.filter((c) => !c.removed && c.alive).length);
            if (n > 0) responders.push(...m.spawnResponders(bank.x, bank.z, n, 'cop'));
          }
          if (!swat && progress >= 10) swat = !!sim.police.spawnUnit('swat', true);
        }
        return progress >= 20;
      });
      m.counter = null;
      m.checkpoint(1);
    } else {
      // Back at the bank's door with the vault open and the alarm still ringing.
      m.givePlayer('rifle', 180);
      sim.player.armor = 100;
      const p = sim.player;
      const at = sim.world.findFreeSpot(bank.x, bank.z, 0.5, 6) ?? bank;
      p.pos.x = at.x;
      p.pos.z = at.z;
      p.pos.y = sim.world.groundHeight(at.x, at.z);
      p.heading = bank.heading;
    }
    pinWanted(sim, 4);
    const g = spots.getaway;
    const free = sim.world.findFreeSpot(g.x, g.z, 2.2, 14) ?? { x: g.x, z: g.z };
    for (const v of sim.vehicles) {
      if (!v.persistent && v.driver !== sim.player && Math.hypot(v.pos.x - free.x, v.pos.z - free.z) < 6) sim.removeVehicle(v);
    }
    const car = m.spawnVehicle('sports', free.x, free.z, g.heading, 0x1c1c1c);
    const mk = m.mark(car, 'Getaway car', 0x3dd9ff);
    m.objective('Get in the getaway car');
    yield m.until(() => sim.player.vehicle === car || car.destroyed || car.removed);
    m.unmark(mk);
    m.objective('Escape to the Marina');
    const marina = spots.marina;
    yield* m.goTo(marina.x, marina.z, { radius: 7, label: 'Marina' });
    m.complete();
    sim.wanted.floor = 0;
    sim.wanted.clear();
    // Dex's people take the car: they stop it dead on the deck (the marker is some 15 m from its open end, which
    // a car arriving at chase speed would run off under the lock) and put out any fire, before the lock keeps
    // the player in it. Until the lock ends, nothing (a pursuer running into it) moves it on.
    const v = m.playerVehicle();
    secureCar(v);
    sim.controlLock = 2.5;
    sim.events.emit('fade', { duration: 2.5 });
    const hold = m.watch(() => {
      if (v && sim.controlLock > 0) secureCar(v);
    });
    yield* m.say(DEX, 'Twenty-five grand for you, the rest for me. Welcome to the top of San Azura, Kai.');
    m.unwatch(hold);
  },
  // After MISSION PASSED, which the runner shows once the script is over.
  outro: { text: 'THE END', sub: 'Thanks for playing GTA 7: Grand Turbo Anarchy', duration: 6 },
};

export const STORY: readonly MissionDef[] = [wheels, delivery, repo, looseLips, heatwave, bigScore];
