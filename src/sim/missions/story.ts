// The San Azura story: six missions for two contacts.

import { rectContains } from '../../world/layout';
import type { Vehicle } from '../entities';
import type { MissionCtx, MissionDef, Script } from './runner';
import { missionSpots } from './spots';

const LOU = 'Mama Lou';
const DEX = 'Dex Moreau';

/** Ends a garage delivery: the player steps out on the sidewalk, Lou keeps the car. */
function* handOver(m: MissionCtx, v: Vehicle | null): Script {
  const sim = m.sim;
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

const wheels: MissionDef = {
  id: 'wheels',
  title: 'Wheels',
  giver: 'lou',
  reward: 500,
  requires: [],
  blurb: 'Mama Lou needs a car. Any car.',
  *run(m) {
    const spots = missionSpots(m.sim.world);
    const bay = spots.lou.bay!;
    yield* m.say(LOU, 'Kai Navarro! Six years inside and you still walk like you own the street.');
    yield* m.say(LOU, "You need money, I need cars. Bring me one. Any car. I don't ask whose.");
    m.objective('Steal a car');
    yield m.until(() => !!m.playerVehicle()?.drivable);
    m.objective("Drive it into Lou's garage");
    yield* m.goTo(spots.louBay.x, spots.louBay.z, { vehicle: 'any', maxSpeed: 5, area: bay, label: "Lou's garage", radius: 4 });
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
    const spots = missionSpots(m.sim.world);
    yield* m.say(LOU, "One of my boys dropped a package in a Midtown parking lot. Don't ask what's in it.");
    yield* m.say(LOU, 'Buyer waits in Hillcrest. He gets nervous, he walks. Move it!');
    m.objective('Collect the package');
    yield* m.goTo(spots.packagePickup.x, spots.packagePickup.z, { radius: 3, label: 'Package', color: 0x3dd9ff });
    m.sim.events.emit('pickup', { kind: 'package', x: spots.packagePickup.x, y: 0.3, z: spots.packagePickup.z });
    m.setTimer('DELIVERY', 160, 'The buyer walked.');
    m.objective('Deliver the package to Hillcrest');
    yield* m.goTo(spots.packageDrop.x, spots.packageDrop.z, { radius: 4, label: 'Buyer' });
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
    const bay = spots.lou.bay!;
    yield* m.say(LOU, "The Tiburones owe me a car: a red Nightjar GT, parked in Westside with three of them babysitting it.");
    yield* m.say(LOU, 'Take this. Bring the car back without too many holes in it.');
    m.givePlayer('pistol', 72);
    const car = m.spawnVehicle('sports', spots.repoCar.x, spots.repoCar.z, spots.repoCar.heading, 0xc0392b);
    for (const g of spots.repoGuards) m.spawnCharacter('gang', g.x, g.z, 'guard', 'pistol');
    m.failIf(() => car.destroyed || car.removed || car.inWater, 'The Nightjar was wrecked.');
    const mk = m.mark(car, 'Nightjar GT');
    m.objective('Steal the Nightjar GT');
    yield m.until(() => sim.player.vehicle === car);
    m.unmark(mk);
    m.objective("Bring the Nightjar to Lou's garage");
    yield* m.goTo(spots.louBay.x, spots.louBay.z, { vehicle: car, maxSpeed: 5, area: bay, label: "Lou's garage", radius: 4 });
    const condition = car.condition;
    if (condition < 0.5) m.reward = Math.round(m.def.reward * 0.6);
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
    yield* m.say(DEX, 'So you are Lou\'s miracle worker. Charming. I have a problem with a mouth.');
    yield* m.say(DEX, "Benny Two-Tone is driving to the police with my name in his notebook. Make sure he never arrives.");
    let target: Vehicle | null = null;
    for (let tries = 0; tries < 8 && !target; tries++) {
      target = sim.traffic.trySpawnTraffic(90, 170, 'sedan');
      if (!target) yield* m.wait(0.4);
    }
    // Fallback: any clear lane point in range, even if the player can see it.
    target = target ?? sim.traffic.spawnTrafficAnywhere(60, 260, 'sedan');
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
    m.vehicles.push(target);
    m.characters.push(benny);
    const t = target;
    m.mark(t, 'Benny');
    m.objective('Take out Benny');
    let farFor = 0;
    m.failIf(() => {
      const d = sim.distToPlayer(t.pos.x, t.pos.z);
      farFor = d > 330 ? farFor + 1 / 60 : 0;
      return farFor > 10;
    }, 'Benny got away.');
    // He panics and flees once he notices you.
    yield m.until(() => sim.distToPlayer(t.pos.x, t.pos.z) < 60 || t.destroyed || !benny.alive);
    if (t.ai && benny.alive && benny.vehicle === t) {
      t.ai.setPolicy('flee');
      t.ai.target = sim.player;
      sim.events.emit('message', { text: "Benny spotted you! Don't let him escape.", duration: 3 });
    }
    yield m.until(() => !benny.alive || t.destroyed);
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
    yield* m.say(DEX, 'The Tiburones keep three vans full of my merchandise. They stole it. I want it gone.');
    yield* m.say(DEX, 'Burn every van. A gift for the job.');
    m.givePlayer('smg', 240);
    const vans = spots.vans.map((s) => m.spawnVehicle('van', s.x, s.z, s.heading, 0x0e7c7b));
    for (const s of spots.vans) {
      const g = sim.world.findFreeSpot(s.x + 3, s.z + 2, 0.5, 5);
      if (g) m.spawnCharacter('gang', g.x, g.z, 'guard', 'pistol');
    }
    const marks = vans.map((v) => m.mark(v, 'Van'));
    const destroyed = () => vans.filter((v) => v.destroyed || v.removed || v.inWater).length;
    m.objective('Destroy the vans (0/3)');
    let last = 0;
    yield m.until(() => {
      const d = destroyed();
      if (d !== last) {
        last = d;
        vans.forEach((v, i) => {
          if (v.destroyed || v.removed) m.unmark(marks[i]!);
        });
        m.objective(`Destroy the vans (${d}/3)`);
        if (d === 1 && sim.wanted.level < 2) sim.wanted.setLevel(2);
      }
      return d >= 3;
    });
    if (sim.wanted.level < 2) sim.wanted.setLevel(2);
    m.objective('Lose the cops');
    yield m.until(() => sim.wanted.level === 0);
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
    yield* m.say(DEX, 'First Azura Bank. The vault opens on a timer: twenty seconds, and the whole city will hear it.');
    yield* m.say(DEX, 'Hold the entrance, take the car outside, and my boat waits at the Marina. Do not be late.');
    m.givePlayer('rifle', 180);
    sim.player.armor = 100;
    m.objective('Go to the First Azura Bank');
    yield* m.goTo(spots.bank.x, spots.bank.z, { radius: 2.5, label: 'Bank', onFoot: true });
    m.objective('Hold the bank entrance while the vault opens');
    sim.wanted.floor = 3;
    sim.wanted.setLevel(3);
    let progress = 0;
    yield m.until(() => {
      const p = sim.player;
      const inside = p.state === 'normal' && Math.hypot(p.pos.x - spots.bank.x, p.pos.z - spots.bank.z) < 9;
      progress = Math.max(0, progress + (inside ? 1 / 60 : -0.5 / 60));
      m.counter = `VAULT ${Math.floor((progress / 20) * 100)}%`;
      return progress >= 20;
    });
    m.counter = null;
    sim.wanted.floor = 4;
    sim.wanted.setLevel(4);
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
    sim.wanted.floor = 0;
    sim.wanted.clear();
    sim.controlLock = 2.5;
    sim.events.emit('fade', { duration: 2.5 });
    yield* m.say(DEX, 'Twenty-five grand for you, the rest for me. Welcome to the top of San Azura, Kai.');
    sim.events.emit('big', { text: 'THE END', sub: 'Thanks for playing GTA 7: Grand Turbo Anarchy', style: 'title', duration: 6 });
    void rectContains;
  },
};

export const STORY: readonly MissionDef[] = [wheels, delivery, repo, looseLips, heatwave, bigScore];
