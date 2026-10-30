// Dex Moreau's missions.

import type { Character, Vehicle } from '../entities';
import { makeBrain } from '../brains';
import { DriverAI } from '../driver';
import type { Sim } from '../sim';
import { guideOnFoot, secureCar, TIBURONES } from './helpers';
import type { MissionCtx, MissionDef } from './runner';
import { missionSpots } from './spots';

const DEX_NAME = 'Dex Moreau';
/** Police officers on foot the bank alarm keeps around the bank at most (see The Big Score). */
const MAX_RESPONDERS = 6;

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
      [DEX_NAME, "So you are Lou's miracle worker. Charming. I have a problem with a mouth."],
      [DEX_NAME, 'Benny Two-Tone is driving to the police with my name in his notebook. Make sure he never arrives.'],
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
      yield* m.say(DEX_NAME, 'Benny slipped through my fingers today. Come back later.');
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
    // Removed: gone from the world some other way (a sinking car's occupants now swim out or drown, see sinking.ts).
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
    yield* m.say(DEX_NAME, 'Benny will be very quiet from now on. Come see me, there is more.');
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
        [DEX_NAME, 'The Tiburones keep three vans full of my merchandise. They stole it. I want it gone.'],
        [DEX_NAME, 'Burn every van. A gift for the job.'],
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
    yield* m.say(DEX_NAME, 'I can smell it from my balcony. Wonderful. Now, the real job...');
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
        [DEX_NAME, 'First Azura Bank. The vault opens on a timer: twenty seconds, and the whole city will hear it.'],
        [DEX_NAME, 'Hold the entrance, take the car outside, and my boat waits at the Marina. Do not be late.'],
      ]);
      m.givePlayer('rifle', 180);
      sim.player.armor = 100;
      const bankGuide = guideOnFoot(m, bank, 'Go to the First Azura Bank', 'Get out of the car and reach the bank entrance');
      yield* m.goTo(bank.x, bank.z, { radius: 2.5, label: 'Bank', onFoot: true });
      m.unwatch(bankGuide);
      m.objective('Hold the bank entrance while the vault opens');
      pinWanted(sim, 3);
      let progress = 0;
      let wave = 0;
      let swat: Vehicle | null = null;
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
          // Another if the police recycle the first before it gets here (one placed heading away lags and goes).
          if (progress >= 10 && (!swat || swat.removed)) swat = sim.police.spawnUnit('swat', true);
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
    yield* m.say(DEX_NAME, 'Twenty-five grand for you, the rest for me. Welcome to the top of San Azura, Kai.');
    m.unwatch(hold);
  },
  // After MISSION PASSED, which the runner shows once the script is over. Chapter 2 (Vera Salgado) opens with it.
  outro: { text: 'CHAPTER 1 COMPLETE', sub: 'Vera Salgado has work: the lime V, Hotel Salgado', duration: 6 },
};

export const DEX: MissionDef[] = [looseLips, heatwave, bigScore];
