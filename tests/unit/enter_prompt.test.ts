// The on-foot prompt for taking a vehicle ("Press F to get in the Velora", "... to carjack the Velora", "... to board the
// Marlin"): it names the vehicle PlayerController.findEnterable picks, for the slot it is asked about, after the marker
// prompts and the retry offer, and never for a vehicle F would pass over.

import { describe, expect, it } from 'vitest';
import { CAB_ARRIVAL_LIMIT, cabState, callCab, type CabJob } from '../../src/sim/activities/cab';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import type { VehicleKind } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import { input, makeSim, placeInCar, roadPoint, step, teleport } from './helpers';

const DT = 1 / 60;

/** The player's own prompt (slot 0 by default). */
const prompt = (sim: Sim, slot = 0): string | null => sim.interactions.prompt(sim.players[slot]!);

/** Puts `who` on foot at the driver's door of `v`, as vehicle_entry.test.ts does. */
function atDoor(sim: Sim, v: Vehicle, who = sim.players[0]!.character): void {
  who.pos.x = v.pos.x + Math.cos(v.heading) * (v.halfW + 0.8);
  who.pos.z = v.pos.z - Math.sin(v.heading) * (v.halfW + 0.8);
  who.pos.y = sim.world.groundHeight(who.pos.x, who.pos.z);
}

/** A parked `kind` on a road, the player at its driver's door. */
function parkedWithPlayer(sim: Sim, kind: VehicleKind = 'sedan'): Vehicle {
  const rp = roadPoint(sim, 40, 30);
  const v = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
  v.owner = 'parked';
  atDoor(sim, v);
  return v;
}

/** The same, with a civilian at the wheel who has the car held at a stop (a light, a queue). */
function stoppedInTraffic(sim: Sim, kind: VehicleKind = 'sedan', role: 'civilian' | 'cop' = 'civilian'): { v: Vehicle; driver: ReturnType<Sim['addDriver']> } {
  const v = parkedWithPlayer(sim, kind);
  const driver = sim.addDriver(v, role, 'traffic');
  v.owner = 'traffic';
  v.ai!.hold = true;
  return { v, driver };
}

describe('the prompt for taking a vehicle', () => {
  it('an empty car in reach is offered with "get in", and nothing is offered out of reach', () => {
    const sim = makeSim({ police: false });
    const v = parkedWithPlayer(sim);
    expect(prompt(sim)).toBe('Press F to get in the Velora');
    teleport(sim, v.pos.x + 12, v.pos.z);
    expect(prompt(sim)).toBeNull();
  });

  it('a car with someone at the wheel is a carjacking, as long as it is slow enough to be taken', () => {
    const sim = makeSim({ police: false });
    const { v } = stoppedInTraffic(sim);
    expect(prompt(sim)).toBe('Press F to carjack the Velora');
    v.speed = 6.9;
    expect(prompt(sim)).toBe('Press F to carjack the Velora');
    // findEnterable refuses a car above 7 m/s: F would do nothing, so nothing is promised.
    v.speed = 7.1;
    expect(sim.playerCtl.findEnterable(sim.player)).toBeNull();
    expect(prompt(sim)).toBeNull();
  });

  it('a police car with an officer at the wheel is a carjacking too, with no stars in the text', () => {
    const sim = makeSim({ police: false });
    stoppedInTraffic(sim, 'police', 'cop');
    expect(prompt(sim)).toBe('Press F to carjack the Patrol Cruiser');
  });

  it('a boat is boarded from the water or the pier, and one with a skipper is a carjacking as F makes it one', () => {
    const sea = makeSim({ seed: 9 });
    const boat = sea.spawnVehicle('speedboat', 700, -300, 0);
    boat.pos.y = WATER_Y;
    const p = sea.player;
    p.pos.x = boat.pos.x + boat.halfW + 2;
    p.pos.z = boat.pos.z;
    p.pos.y = WATER_Y;
    step(sea, 1);
    expect(p.state).toBe('swimming');
    expect(prompt(sea)).toBe('Press F to board the Marlin');
    const skipper = sea.addDriver(boat, 'civilian', 'traffic');
    expect(prompt(sea)).toBe('Press F to carjack the Marlin');
    step(sea, 1 / 60, input({ enterExit: true }));
    step(sea, 2);
    expect(p.vehicle).toBe(boat);
    expect(skipper.vehicle).toBeNull();

    const marina = makeSim({ ambient: true, police: false, seed: 5 });
    const poi = marina.world.layout.pois.find((q) => q.kind === 'marina')!;
    teleport(marina, poi.x - 6, poi.z);
    step(marina, 1.2);
    const moored = marina.vehicles.find((v) => v.spec.class === 'boat' && v.spec.kind === 'dinghy')!;
    marina.player.pos.x = moored.pos.x + moored.halfW + 1.5;
    marina.player.pos.z = moored.pos.z;
    marina.player.pos.y = marina.world.groundHeight(marina.player.pos.x, marina.player.pos.z);
    step(marina, 0.2);
    expect(prompt(marina)).toBe('Press F to board the Puffin');
  });

  it('a marker under the player comes first, then the retry offer', () => {
    const sim = makeSim({ police: false });
    const save = sim.interactions.markers.find((m) => m.kind === 'save')!;
    const car = sim.spawnVehicle('sedan', save.x + 2.2, save.z, 0);
    car.owner = 'parked';
    teleport(sim, save.x, save.z);
    expect(sim.playerCtl.findEnterable(sim.player)).toBe(car);
    expect(prompt(sim)).toBe('Press E to save your game');

    expect(sim.missions.start('wheels', { retrying: true })).toBe(true);
    sim.missions.active!.fail('The car was destroyed.');
    step(sim, 0.1);
    const v = parkedWithPlayer(sim);
    expect(sim.playerCtl.findEnterable(sim.player)).toBe(v);
    expect(prompt(sim)).toBe('Press E to retry "Wheels"');
  });

  it('no prompt in a vehicle, while control is locked, or while down', () => {
    const sim = makeSim({ police: false });
    const v = parkedWithPlayer(sim);
    const slot = sim.players[0]!;
    expect(prompt(sim)).toBe('Press F to get in the Velora');
    slot.controlLock = 1;
    expect(prompt(sim)).toBeNull();
    slot.controlLock = 0;
    slot.deathKind = 'wasted';
    expect(prompt(sim)).toBeNull();
    slot.deathKind = null;
    expect(prompt(sim)).toBe('Press F to get in the Velora');

    // Behind the wheel of one car with another beside him, he is offered nothing; out of it again, the nearer car.
    const other = sim.spawnVehicle('compact', v.pos.x + v.halfW + 2.2, v.pos.z, v.heading);
    placeInCar(sim, other);
    expect(prompt(sim)).toBeNull();
    sim.playerCtl.ejectPlayer(true);
    expect(prompt(sim)).toMatch(/^Press F to get in the (Velora|Pipsqueak)$/);
  });

  it('is each slot\'s own: it names the vehicle that slot would enter, and never another player\'s car', () => {
    const sim = makeSim({ police: false });
    const a = parkedWithPlayer(sim);
    const b = sim.addPlayer(sim.player.pos.x + 40, sim.player.pos.z);
    const rp = roadPoint(sim, 41, 30);
    const other = sim.spawnVehicle('muscle', rp.x, rp.z, rp.heading);
    other.owner = 'parked';
    atDoor(sim, other, b.character);
    expect(prompt(sim, 0)).toBe('Press F to get in the Velora');
    expect(prompt(sim, 1)).toBe('Press F to get in the Thunderhoof');

    // Slot 1 takes the wheel of the car slot 0 stands beside: slot 0 is offered nothing, and slot 1 (seated) neither.
    sim.seat(b.character, a, 0);
    expect(prompt(sim, 0)).toBeNull();
    expect(prompt(sim, 1)).toBeNull();
    // Slot 0 at the wheel of it, slot 1 at its door: nothing for slot 1 either.
    sim.unseat(b.character);
    sim.seat(sim.player, a, 0);
    b.character.state = 'normal';
    atDoor(sim, a, b.character);
    expect(prompt(sim, 1)).toBeNull();
  });

  it.each([
    [3.2, 'Velora', 'sedan'],
    [3.9, 'Thunderhoof', 'muscle'],
  ])('F enters the vehicle named in the prompt: with two cars in reach, standing %s m along', (z, name, kind) => {
    const sim = makeSim({ police: false });
    const front = sim.spawnVehicle('sedan', 0, 0, 0);
    const back = sim.spawnVehicle('muscle', 0, 7, 0);
    for (const c of [front, back]) c.owner = 'parked';
    teleport(sim, front.halfW + 0.8, z);
    expect(prompt(sim)).toBe(`Press F to get in the ${name}`);
    const named = kind === 'sedan' ? front : back;
    const unnamed = named === front ? back : front;
    step(sim, DT, input({ enterExit: true }));
    expect(sim.player.state).toBe('entering');
    expect(sim.player.enterTarget).toBe(named);
    step(sim, 1.5);
    expect(sim.player.vehicle).toBe(named);
    expect(unnamed.driver).toBeNull();
  });

  it('F on a "carjack" prompt pulls the driver out and takes the car, which is the crime it names', () => {
    const sim = makeSim({ police: false });
    const { v, driver } = stoppedInTraffic(sim);
    const crimes: string[] = [];
    const crime = sim.wanted.crime.bind(sim.wanted);
    sim.wanted.crime = (type, x, z, by) => {
      crimes.push(type);
      return crime(type, x, z, by);
    };
    expect(prompt(sim)).toBe('Press F to carjack the Velora');
    step(sim, DT, input({ enterExit: true }));
    expect(sim.player.enterTarget).toBe(v);
    step(sim, 3);
    expect(sim.player.vehicle).toBe(v);
    expect(v.driver).toBe(sim.player);
    expect(driver.vehicle).toBeNull();
    expect(crimes).toContain('carjack');
    expect(prompt(sim)).toBeNull();
  });

  it('it does not read or move the sim: the same frames run with and without a prompt per frame end identically', () => {
    const run = (ask: boolean): string => {
      const sim = makeSim({ seed: 17, ambient: true });
      const { v } = stoppedInTraffic(sim);
      for (let f = 0; f < 240; f++) {
        if (ask) prompt(sim);
        sim.update(DT, input({ enterExit: f === 30, aimOrigin: { x: v.pos.x, y: 3, z: v.pos.z - 6 } }));
      }
      return JSON.stringify([sim.rng.next(), sim.player.pos, sim.vehicles.map((c) => [c.id, c.pos.x, c.pos.z, c.speed])]);
    };
    expect(run(true)).toBe(run(false));
  });
});

describe('a failed mission\'s retry beside a vehicle', () => {
  /** Fails Wheels (with `stars` on him) and puts the player at a parked Velora's door. */
  function failedAtCar(sim: Sim, stars: number): Vehicle {
    expect(sim.missions.start('wheels', { retrying: true })).toBe(true);
    sim.wanted.setLevel(stars);
    sim.missions.active!.fail('The car was destroyed.');
    step(sim, 0.1);
    return parkedWithPlayer(sim);
  }

  it('the offer, which is timed and names a key, comes before the vehicle prompt', () => {
    const sim = makeSim({ police: false });
    const v = failedAtCar(sim, 0);
    expect(sim.missions.retryOffer()?.id).toBe('wheels');
    expect(sim.playerCtl.findEnterable(sim.player)).toBe(v);
    expect(prompt(sim)).toBe('Press E to retry "Wheels"');
  });

  it('"Lose the cops before retrying." comes after it, so a wanted player beside a car is offered the car', () => {
    const sim = makeSim({ police: false });
    const v = failedAtCar(sim, 2);
    expect(sim.missions.retryOffer()).toBeNull();
    expect(sim.missions.retryAfterCops()?.id).toBe('wheels');
    expect(prompt(sim)).toBe('Press F to get in the Velora');
    teleport(sim, v.pos.x + 12, v.pos.z);
    expect(prompt(sim)).toBe('Lose the cops before retrying.');
    // Back at the car with the police lost: the offer, now open, goes first again.
    atDoor(sim, v);
    sim.wanted.clear();
    step(sim, 0.1);
    expect(prompt(sim)).toBe('Press E to retry "Wheels"');
  });

  it('the same notice for an offer that is open when the stars come, and "Finish the rampage first." likewise', () => {
    const sim = makeSim({ police: false });
    const v = failedAtCar(sim, 0);
    sim.wanted.setLevel(2);
    expect(sim.missions.retryOffer()?.id).toBe('wheels');
    expect(prompt(sim)).toBe('Press F to get in the Velora');
    teleport(sim, v.pos.x + 12, v.pos.z);
    expect(prompt(sim)).toBe('Lose the cops before retrying.');

    sim.wanted.clear();
    expect(sim.activities.startRampage('rampage:0')).toBe(true);
    atDoor(sim, v);
    expect(prompt(sim)).toBe('Press F to get in the Velora');
    teleport(sim, v.pos.x + 12, v.pos.z);
    expect(prompt(sim)).toBe('Finish the rampage first.');
  });
});

/** A cab the player called, waiting at the curb by the player's spot (he stands 6 m off the lane). */
function waitingCab(sim: Sim): CabJob {
  const lane = sim.roads.gridLanes[(1 * 37 + 11) % sim.roads.gridLanes.length]!;
  const x = lane.sx + lane.dx * (lane.length / 2);
  const z = lane.sz + lane.dz * (lane.length / 2);
  const spot = sim.world.findFreeSpot(x - lane.dz * 6, z + lane.dx * 6, 0.5, 8) ?? { x, z };
  teleport(sim, spot.x, spot.z);
  sim.update(DT, input());
  expect(callCab(sim).ok).toBe(true);
  for (let t = 0; t < CAB_ARRIVAL_LIMIT && cabState(sim)?.stage !== 'waiting'; t += DT) step(sim, DT);
  const j = cabState(sim)!;
  expect(j.stage).toBe('waiting');
  return j;
}

/** Puts `who` `off` m from the cab's centre line, on whichever side is free. */
function besideCab(sim: Sim, cab: Vehicle, off: number, who = sim.player): void {
  for (const side of [-1, 1]) {
    const x = cab.pos.x + Math.cos(cab.heading) * off * side;
    const z = cab.pos.z - Math.sin(cab.heading) * off * side;
    if (!sim.world.isFree(x, z, 0.4, true)) continue;
    who.pos.x = x;
    who.pos.z = z;
    who.pos.y = sim.world.groundHeight(x, z);
    return;
  }
  throw new Error('no free spot beside the cab');
}

describe('a cab the player called', () => {
  it('is "get in", not a carjacking: the cab system takes F and seats him as its passenger', () => {
    const sim = makeSim({ seed: 1, ambient: true, police: false });
    const j = waitingCab(sim);
    const side = sim.world.findFreeSpot(j.cab.pos.x - Math.cos(j.cab.heading) * 2.2, j.cab.pos.z + Math.sin(j.cab.heading) * 2.2, 0.4, 3)!;
    teleport(sim, side.x, side.z);
    expect(sim.playerCtl.findEnterable(sim.player)).toBe(j.cab);
    expect(j.cab.driver).toBe(j.driver);
    expect(prompt(sim)).toBe('Press F to get in the Azura Cab');
    step(sim, DT, input({ enterExit: true }));
    step(sim, 2);
    expect(sim.player.vehicle).toBe(j.cab);
    expect(sim.player.seat).toBeGreaterThan(0);
    expect(j.cab.driver).toBe(j.driver);
  });

  it('is named over a parked car nearer him, which F passes over for the cab', () => {
    const sim = makeSim({ seed: 1, ambient: true, police: false });
    const { cab } = waitingCab(sim);
    const fx = Math.sin(cab.heading);
    const fz = Math.cos(cab.heading);
    const sx = Math.cos(cab.heading);
    const sz = -Math.sin(cab.heading);
    // A Velora 6 m behind the cab, the player in the 1.3 m gap between them, 2.2 m out on the cab's side.
    const parked = sim.spawnVehicle('sedan', cab.pos.x - fx * 6, cab.pos.z - fz * 6, cab.heading);
    parked.owner = 'parked';
    teleport(sim, cab.pos.x - fx * 3.3 - sx * 2.2, cab.pos.z - fz * 3.3 - sz * 2.2);
    expect(sim.playerCtl.findEnterable(sim.player)).toBe(parked);
    expect(prompt(sim)).toBe('Press F to get in the Azura Cab');
    step(sim, DT, input({ enterExit: true }));
    step(sim, 2.5);
    expect(sim.player.vehicle).toBe(cab);
    expect(sim.player.seat).toBeGreaterThan(0);
    expect(parked.driver).toBeNull();
  });

  it.each([3.5, 4, 4.5])('is named from %s m off its side, further than the controller reaches, as long as the cab takes F there', (off) => {
    const sim = makeSim({ seed: 1, ambient: true, police: false });
    const { cab } = waitingCab(sim);
    besideCab(sim, cab, off);
    expect(sim.playerCtl.findEnterable(sim.player)).toBeNull();
    expect(prompt(sim)).toBe('Press F to get in the Azura Cab');
    step(sim, DT, input({ enterExit: true }));
    step(sim, 4);
    expect(sim.player.vehicle).toBe(cab);
    expect(sim.player.seat).toBeGreaterThan(0);
  });

  it('is not named from beyond the cab system\'s reach, and to a second player at its side it is a carjacking', () => {
    const sim = makeSim({ seed: 1, ambient: true, police: false });
    const { cab } = waitingCab(sim);
    besideCab(sim, cab, 6.5);
    expect(prompt(sim)).toBeNull();

    // The cab system takes slot 0's F only: another player's goes to the controller, which pulls the cabbie out.
    besideCab(sim, cab, 2.2);
    const b = sim.addPlayer(cab.pos.x, cab.pos.z);
    besideCab(sim, cab, 2.2, b.character);
    expect(prompt(sim, 0)).toBe('Press F to get in the Azura Cab');
    expect(prompt(sim, 1)).toBe('Press F to carjack the Azura Cab');
  });
});
