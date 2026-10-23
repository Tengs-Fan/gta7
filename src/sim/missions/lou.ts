// Mama Lou's missions.

import { clamp } from '../../core/math';
import type { Objective } from '../activities';
import type { Character, Vehicle } from '../entities';
import type { Sim } from '../sim';
import { guideOnFoot, secureCar, TIBURONES } from './helpers';
import type { MissionCtx, MissionDef, Script, Wait } from './runner';
import { missionSpots } from './spots';

const MAMA_LOU = 'Mama Lou';
const MAMA_LOU_PHONE = 'Mama Lou (phone)';

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
        [MAMA_LOU_PHONE, 'Kai Navarro! Six years inside and not one postcard. Welcome home, baby.'],
        [MAMA_LOU_PHONE, 'You need money, I need cars. Steal one and bring it to my garage in the Docks.'],
      ]);
    } else {
      yield* m.intro([
        [MAMA_LOU, 'Kai Navarro! Six years inside and you still walk like you own the street.'],
        [MAMA_LOU, "You need money, I need cars. Bring me one. Any car. I don't ask whose."],
      ]);
    }
    m.objective('Steal a car');
    yield m.until(() => !!m.playerVehicle()?.drivable);
    yield* toLouGarage(m, "Drive it into Lou's garage", { vehicle: 'any', maxSpeed: 5 });
    m.complete();
    const v = m.playerVehicle();
    if (v) m.vehicles.push(v);
    yield* handOver(m, v);
    yield* m.say(MAMA_LOU, "Not bad, baby. Not bad at all. Come see me again, I'll have real work.");
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
      [MAMA_LOU, "One of my boys dropped a package in a Midtown parking lot. Don't ask what's in it."],
      [MAMA_LOU, 'Buyer waits in Hillcrest. He gets nervous, he walks. Move it!'],
    ]);
    const collectGuide = guideOnFoot(m, pick, 'Collect the package', 'Get out of the car and collect the package');
    const mk = m.mark(pick, 'Package', 0x3dd9ff, 1.5);
    yield m.until(() => !parcel.active || parcel.removed);
    m.unwatch(collectGuide);
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
    yield* m.say(MAMA_LOU, "Buyer's happy, I'm happy. Here's your cut.");
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
      [MAMA_LOU, 'The Tiburones owe me a car: a red Nightjar GT, parked in Westside with three of them babysitting it.'],
      [MAMA_LOU, 'Take this. Bring the car back without too many holes in it.'],
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
    yield* m.say(MAMA_LOU, condition < 0.5 ? 'You call this a delivery? I pay for cars, not scrap. Less money.' : "Look at that paint. You're my favorite now.");
    yield* m.say(MAMA_LOU, "A friend of mine, Dex Moreau, wants to meet you. Moreau Tower, downtown. Be nice to him.");
  },
};

export const LOU: MissionDef[] = [wheels, delivery, repo];
