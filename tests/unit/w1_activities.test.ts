// Wave-1 activities: ambulance, firefighter, courier and car export as registry entries, played headless.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { activityKinds, getActivity, type AmbulanceJob, type CourierJob, type FireJob } from '../../src/sim/activities';
import { patientsFor, rewardFor as ambulanceReward, timeFor as ambulanceTime } from '../../src/sim/activities/ambulance';
import { COURIER_BASE, COURIER_BONUS, COURIER_DROPS, courierPay } from '../../src/sim/activities/courier';
import { EXPORT_KEY, EXPORT_LIST, EXPORT_LIST_BONUS, exportDone } from '../../src/sim/activities/carExport';
import { EXTINGUISH_RATE, firesFor, rewardFor as fireReward, timeFor as fireTime } from '../../src/sim/activities/firefighter';
import { places } from '../../src/sim/activities/places';
import { ACTIVITY_RECORDS_KEY, activityRecords } from '../../src/sim/activities/records';
import { applySave, parseSave, SAVE_VERSION, serialize } from '../../src/sim/progress';
import { applyExt, serializeExt } from '../../src/sim/saveExt';
import { LEAVE_GRACE } from '../../src/sim/activities/service';
import type { Vehicle } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { input, makeSim, placeInCar, step, teleport, legacyLane } from './helpers';

function carAt(sim: Sim, kind: VehicleKind, x: number, z: number, heading = 0, color?: number): Vehicle {
  const v = sim.spawnVehicle(kind, x, z, heading, color);
  placeInCar(sim, v);
  return v;
}

function moveCar(sim: Sim, v: Vehicle, x: number, z: number): void {
  v.pos.x = x;
  v.pos.z = z;
  v.pos.y = sim.world.groundHeight(x, z);
  v.vel.x = 0;
  v.vel.z = 0;
  v.angVel = 0;
}

function ambulanceSim(seed = 3): { sim: Sim; car: Vehicle } {
  const sim = makeSim({ seed });
  const d = places(sim.world).depots.find((p) => p.kind === 'ambulance')!;
  const car = carAt(sim, 'ambulance', d.x, d.z, d.heading);
  return { sim, car };
}

function fireSim(seed = 5): { sim: Sim; truck: Vehicle } {
  const sim = makeSim({ seed });
  const d = places(sim.world).depots.find((p) => p.kind === 'firetruck')!;
  const truck = carAt(sim, 'firetruck', d.x, d.z, d.heading);
  return { sim, truck };
}

/** Picks up every waiting patient (stopping beside each) and drives to the hospital bay. */
function playAmbulanceLevel(sim: Sim, car: Vehicle): void {
  const j = sim.activities.job as AmbulanceJob;
  while (j.waiting.length > 0) {
    const c = j.waiting[0]!;
    moveCar(sim, car, c.pos.x + 3.2, c.pos.z);
    step(sim, 1.3);
  }
  const drop = places(sim.world).hospitalDrop;
  moveCar(sim, car, drop.x, drop.z);
  step(sim, 0.2);
}

/** Water from the truck's cannon at (x, z): fire held, the camera looking there. */
function sprayAt(truck: Vehicle, x: number, z: number): PlayerInput {
  const dx = x - truck.pos.x;
  const dz = z - truck.pos.z;
  const l = Math.hypot(dx, dz) || 1;
  return input({ fire: true, aimDir: { x: dx / l, y: -0.05, z: dz / l }, aimOrigin: { x: truck.pos.x - (dx / l) * 6, y: truck.pos.y + 4, z: truck.pos.z - (dz / l) * 6 } });
}

/** Parks the truck 12 m from the fire and sprays it until it is out (or `cap` s); returns the seconds of water. */
function douseFire(sim: Sim, truck: Vehicle, f: { x: number; z: number; strength: number }, cap = 6): number {
  moveCar(sim, truck, f.x + 12, f.z);
  let t = 0;
  while (f.strength > 0 && t < cap) {
    step(sim, 1 / 60, sprayAt(truck, f.x, f.z));
    t += 1 / 60;
  }
  return t;
}

describe('wave-1 activity registry', () => {
  it('registers ambulance, firefighter, courier and car export next to the four existing activities', () => {
    // The phone's cab (ui track) sits after the street run.
    expect(activityKinds()).toEqual(['taxi', 'vigilante', 'rampage', 'ambulance', 'firefighter', 'courier', 'carExport', 'streetRun', 'cab']);
    for (const kind of ['ambulance', 'firefighter', 'courier', 'carExport']) {
      const def = getActivity(kind)!;
      for (const m of ['canStart', 'prompt', 'start', 'update', 'end', 'objectives', 'status'] as const) expect(typeof def[m], `${kind}.${m}`).toBe('function');
    }
  });

  it('offers each vehicle job by the job key T, only where it applies', () => {
    const { sim, car } = ambulanceSim();
    car.speed = 0;
    expect(sim.activities.jobPrompt()).toBe('Press T to start a paramedic job');
    const t = makeSim();
    const truck = carAt(t, 'firetruck', 0, 0);
    truck.speed = 0;
    expect(t.activities.jobPrompt()).toBe('Press T to start a firefighter job');
    const c = makeSim();
    const office = places(c.world).courier;
    const sedan = carAt(c, 'sedan', office.x, office.z, office.heading);
    sedan.speed = 0;
    expect(c.activities.jobPrompt()).toBe('Press T to start an Azura Express courier run');
    moveCar(c, sedan, office.x, office.z - 40);
    expect(c.activities.jobPrompt()).toBe('Press T to start a street run');
  });
});

describe('fire truck kind', () => {
  it('is one car-class spec entry with a water cannon, drawn from spec data, that drives', () => {
    const s = VEHICLE_SPECS.firetruck;
    expect(s.class).toBe('car');
    expect(s.waterCannon).toBe(true);
    expect(s.bodyProfile).toBeDefined();
    expect(s.engine).toBeDefined();
    const sim = makeSim();
    const lane = legacyLane(sim, 40);
    const v = carAt(sim, 'firetruck', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
    step(sim, 3, input({ throttle: 1 }));
    expect(v.speed).toBeGreaterThan(8);
  });

  it('sprays water instead of firing a drive-by', () => {
    const sim = makeSim();
    const v = carAt(sim, 'firetruck', 0, 0);
    sim.player.inventory.give('pistol', 50);
    sim.player.inventory.current = 'pistol';
    const fired: unknown[] = [];
    sim.events.on('weaponFired', (e) => fired.push(e));
    step(sim, 0.5, input({ fire: true, firePressed: true, aimDir: { x: 0, y: 0, z: 1 } }));
    expect(fired).toEqual([]);
    expect(v.removed).toBe(false);
  });
});

describe('ambulance', () => {
  it('plays three levels: patients per level, the time each adds and the pay each level', () => {
    const { sim, car } = ambulanceSim();
    const out: string[] = [];
    sim.activities.toggleJob();
    const j = sim.activities.job as AmbulanceJob;
    expect(j.kind).toBe('ambulance');
    for (let level = 1; level <= 3; level++) {
      expect(j.level).toBe(level);
      expect(j.waiting.length).toBe(patientsFor(level));
      const timer = j.timer;
      const money = sim.progress.money;
      playAmbulanceLevel(sim, car);
      expect(sim.progress.money - money, `level ${level} pay`).toBe(ambulanceReward(level));
      expect(j.level).toBe(level + 1);
      out.push(`level ${level}: patients ${patientsFor(level)}, time added ${ambulanceTime(level)} s, reward $${ambulanceReward(level)}`);
      const before = j.timer;
      step(sim, 2.1);
      // The next level's clock is what was left plus that level's time.
      expect(j.timer).toBeCloseTo(before + ambulanceTime(level + 1), 0);
      expect(timer).toBeGreaterThan(0);
    }
    expect([ambulanceTime(1), ambulanceTime(2), ambulanceTime(3)]).toEqual([70, 95, 120]);
    expect(activityRecords(sim.progress).ambulanceLevel).toBe(3);
    expect(activityRecords(sim.progress).patientsSaved).toBe(6);
    console.log(out.join('\n'));
  });

  const endCases: Array<[string, (sim: Sim, car: Vehicle) => void]> = [
    ['the timer reaches zero', (sim) => step(sim, ambulanceTime(1) + 1)],
    ['the player stays out of the vehicle past the grace time', (sim) => {
      sim.playerCtl.ejectPlayer(false);
      step(sim, LEAVE_GRACE + 0.5);
    }],
    ['the vehicle is destroyed', (sim, car) => {
      sim.combat.explodeVehicle(car);
      step(sim, 0.1);
    }],
    ['the job key cancels it', (sim) => sim.activities.toggleJob()],
  ];

  it.each(endCases)('ends cleanly when %s, with no patient left aboard and no markers', (_name, end) => {
    const { sim, car } = ambulanceSim();
    sim.cheats.godMode = true;
    sim.activities.toggleJob();
    const j = sim.activities.job as AmbulanceJob;
    // One aboard and (from level 2) none waiting: board the level-1 patient first.
    const c = j.waiting[0]!;
    moveCar(sim, car, c.pos.x + 3.2, c.pos.z);
    step(sim, 1.3);
    expect(j.aboard).toHaveLength(1);
    const patients = [...j.aboard];
    const messages: string[] = [];
    sim.events.on('message', (e) => messages.push(e.text));
    end(sim, car);
    expect(sim.activities.job).toBeNull();
    expect(sim.activities.objectives()).toEqual([]);
    expect(sim.activities.status()).toBeNull();
    expect(messages.length).toBeGreaterThan(0);
    for (const p of patients) {
      expect(p.vehicle).toBeNull();
      expect(p.persistent).toBe(false);
      expect(p.missionTag).toBe('');
    }
    expect(car.passengers.every((p) => p === null || p.removed)).toBe(true);
  });

  it('keeps a boarded patient aboard when the player gets out and back in with F, and delivers him', () => {
    const { sim, car } = ambulanceSim();
    sim.activities.toggleJob();
    const j = sim.activities.job as AmbulanceJob;
    const patient = j.waiting[0]!;
    moveCar(sim, car, patient.pos.x + 3.2, patient.pos.z);
    step(sim, 1.3);
    expect(patient.vehicle).toBe(car);
    sim.update(1 / 60, input({ enterExit: true }));
    expect(sim.player.vehicle).toBeNull();
    step(sim, 0.25);
    sim.update(1 / 60, input({ enterExit: true }));
    let t = 0;
    for (; t < 8 && sim.player.vehicle !== car; t += 1 / 60) sim.update(1 / 60, input());
    expect(sim.player.vehicle, 'back at the wheel').toBe(car);
    expect(t).toBeLessThan(LEAVE_GRACE);
    expect(patient.vehicle, 'the patient stays in his seat').toBe(car);
    expect(j.aboard).toEqual([patient]);
    const money = sim.progress.money;
    const drop = places(sim.world).hospitalDrop;
    moveCar(sim, car, drop.x, drop.z);
    step(sim, 0.2);
    expect(sim.progress.money - money).toBe(ambulanceReward(1));
    expect(activityRecords(sim.progress).patientsSaved).toBe(1);
    expect(patient.removed).toBe(true);
  });

  it('pays nothing for a patient who is no longer in the ambulance, and has him picked up again', () => {
    const { sim, car } = ambulanceSim();
    sim.activities.toggleJob();
    const j = sim.activities.job as AmbulanceJob;
    const patient = j.waiting[0]!;
    moveCar(sim, car, patient.pos.x + 3.2, patient.pos.z);
    step(sim, 1.3);
    expect(j.aboard).toEqual([patient]);
    // Out of his seat by some other way (not the job's), left behind as the ambulance drives on to the hospital.
    sim.unseat(patient);
    const money = sim.progress.money;
    const saved = activityRecords(sim.progress).patientsSaved;
    const drop = places(sim.world).hospitalDrop;
    moveCar(sim, car, drop.x, drop.z);
    step(sim, 0.5);
    expect(Math.hypot(patient.pos.x - drop.x, patient.pos.z - drop.z)).toBeGreaterThan(drop.radius);
    expect(sim.progress.money).toBe(money);
    expect(activityRecords(sim.progress).patientsSaved).toBe(saved);
    expect(patient.removed).toBe(false);
    expect(j.level).toBe(1);
    expect(j.aboard).toEqual([]);
    expect(j.waiting).toEqual([patient]);
    expect(sim.activities.status()).toMatch(/ABOARD 0/);
  });

  it('keeps waiting while the player is out of the ambulance for less than the grace time', () => {
    const { sim } = ambulanceSim();
    sim.activities.toggleJob();
    sim.playerCtl.ejectPlayer(false);
    step(sim, LEAVE_GRACE - 2);
    expect(sim.activities.job?.kind).toBe('ambulance');
    expect(sim.activities.status()).toMatch(/GET BACK IN THE AMBULANCE/);
  });
});

describe('firefighter', () => {
  it('plays two levels: fires per level, time to put each out and the pay', () => {
    const { sim, truck } = fireSim();
    sim.cheats.godMode = true;
    sim.activities.toggleJob();
    const j = sim.activities.job as FireJob;
    expect(j.kind).toBe('firefighter');
    const out: string[] = [];
    for (let level = 1; level <= 2; level++) {
      expect(j.level).toBe(level);
      expect(j.fires.length).toBe(firesFor(level));
      expect(sim.activities.objectives()).toHaveLength(firesFor(level));
      const money = sim.progress.money;
      const times: number[] = [];
      for (const f of [...j.fires]) {
        const t = douseFire(sim, truck, f);
        expect(f.strength, 'fire out').toBe(0);
        times.push(t);
        if (f.vehicle) expect(f.vehicle.burning).toBe(false);
      }
      // A fire takes 1 / EXTINGUISH_RATE seconds of water.
      for (const t of times) expect(t).toBeCloseTo(1 / EXTINGUISH_RATE, 0);
      expect(sim.progress.money - money).toBe(fireReward(level));
      out.push(`level ${level}: fires ${firesFor(level)} (${times.map((t) => t.toFixed(2)).join(', ')} s of water), time added ${fireTime(level)} s, reward $${fireReward(level)}`);
      step(sim, 2.6);
    }
    expect(sim.wanted.level).toBe(0);
    expect(activityRecords(sim.progress).fireLevel).toBe(2);
    console.log(out.join('\n'));
  });

  it('does not complete a level while a fire still burns, and fires do not burn out by themselves', () => {
    const { sim } = fireSim();
    sim.cheats.godMode = true;
    sim.activities.toggleJob();
    const j = sim.activities.job as FireJob;
    const money = sim.progress.money;
    step(sim, 20);
    expect(j.fires.every((f) => f.strength === 1)).toBe(true);
    for (const f of j.fires) if (f.vehicle) expect(f.vehicle.destroyed).toBe(false);
    expect(sim.progress.money).toBe(money);
    expect(j.level).toBe(1);
  });

  it('lets go of a fire car destroyed by something else, so the wreck streams out after the job', () => {
    const { sim, truck } = fireSim();
    sim.cheats.godMode = true;
    sim.activities.toggleJob();
    const j = sim.activities.job as FireJob;
    const target = j.fires.find((f) => f.vehicle)?.vehicle;
    expect(target, 'level 1 has a burning car').toBeDefined();
    sim.combat.damageVehicle(target!, target!.spec.health * 2, null, 'explosion');
    step(sim, 1 / 60);
    expect(target!.destroyed).toBe(true);
    expect(target!.persistent).toBe(false);
    expect(target!.owner).toBe('none');
    expect(target!.missionTag).toBe('');
    step(sim, 2.6);
    sim.activities.toggleJob();
    expect(sim.activities.job).toBeNull();
    // Far away with ambient streaming on, the wreck is cleaned up like any other.
    sim.ambient = true;
    const far = [...sim.world.layout.pois].sort((a, b) => Math.hypot(b.x - target!.pos.x, b.z - target!.pos.z) - Math.hypot(a.x - target!.pos.x, a.z - target!.pos.z))[0]!;
    const spot = sim.world.findFreeSpot(far.x, far.z, 0.4, 8) ?? far;
    moveCar(sim, truck, spot.x, spot.z);
    step(sim, 50);
    expect(target!.removed).toBe(true);
  });

  const endCases: Array<[string, (sim: Sim, truck: Vehicle) => void]> = [
    ['the timer reaches zero', (sim) => step(sim, fireTime(1) + 1)],
    ['the player stays out of the truck past the grace time', (sim) => {
      sim.playerCtl.ejectPlayer(false);
      step(sim, LEAVE_GRACE + 0.5);
    }],
    ['the truck is destroyed', (sim, truck) => {
      sim.combat.explodeVehicle(truck);
      step(sim, 0.1);
    }],
    ['the job key cancels it', (sim) => sim.activities.toggleJob()],
  ];

  it.each(endCases)('ends when %s, its fires put out and no wanted level', (_name, end) => {
    const { sim, truck } = fireSim(8);
    sim.cheats.godMode = true;
    sim.activities.toggleJob();
    const j = sim.activities.job as FireJob;
    const fires = [...j.fires];
    end(sim, truck);
    expect(sim.activities.job).toBeNull();
    expect(sim.activities.objectives()).toEqual([]);
    for (const f of fires) {
      expect(f.strength).toBe(0);
      if (f.vehicle && !f.vehicle.removed) {
        expect(f.vehicle.burning).toBe(false);
        expect(f.vehicle.missionTag).toBe('');
      }
    }
    step(sim, 8);
    expect(sim.wanted.level).toBe(0);
    for (const f of fires) if (f.vehicle && !f.vehicle.removed) expect(f.vehicle.burning).toBe(false);
  });
});

describe('courier', () => {
  function courierSim(seed = 4): { sim: Sim; car: Vehicle; j: CourierJob } {
    const sim = makeSim({ seed });
    const office = places(sim.world).courier;
    const car = carAt(sim, 'sedan', office.x, office.z, office.heading);
    car.speed = 0;
    sim.activities.toggleJob();
    return { sim, car, j: sim.activities.job as CourierJob };
  }

  it('gives at least three drop-offs, one at a time, each paying the base plus $4 a second left', () => {
    const { sim, car, j } = courierSim();
    expect(j.kind).toBe('courier');
    expect(j.drops.length).toBeGreaterThanOrEqual(3);
    expect(COURIER_DROPS).toBe(3);
    expect(sim.activities.objectives()).toHaveLength(1);
    const pays: number[] = [];
    for (let i = 0; i < j.drops.length; i++) {
      const d = j.drops[i]!;
      expect(sim.activities.objectives()[0]).toMatchObject({ x: d.x, z: d.z });
      const left = j.timer;
      const money = sim.progress.money;
      moveCar(sim, car, d.x, d.z);
      step(sim, 1 / 60);
      const paid = sim.progress.money - money;
      pays.push(paid);
      const expected = courierPay(left - 1 / 60) + (i === j.drops.length - 1 ? 150 : 0);
      expect(paid).toBe(expected);
    }
    expect(sim.activities.job).toBeNull();
    expect(activityRecords(sim.progress).courierRuns).toBe(1);
    console.log(`courier pays ${pays.join(', ')}`);
  });

  it('pays more the more time is left: two runs differing only in time left differ by $4 a second', () => {
    const run = (wait: number): { paid: number; left: number } => {
      const { sim, car, j } = courierSim(9);
      step(sim, wait);
      const left = j.timer;
      const money = sim.progress.money;
      const d = j.drops[0]!;
      moveCar(sim, car, d.x, d.z);
      step(sim, 1 / 60);
      return { paid: sim.progress.money - money, left: left - 1 / 60 };
    };
    const fast = run(1);
    const slow = run(11);
    expect(Math.floor(fast.left) - Math.floor(slow.left)).toBe(10);
    expect(fast.paid - slow.paid).toBe(10 * COURIER_BONUS);
    expect(slow.paid).toBe(COURIER_BASE + COURIER_BONUS * Math.floor(slow.left));
    console.log(`courier: ${fast.left.toFixed(2)} s left pays $${fast.paid}; ${slow.left.toFixed(2)} s left pays $${slow.paid}`);
  });

  it('ends on time-out with a message and pays nothing more', () => {
    const { sim, j } = courierSim();
    const msgs: string[] = [];
    sim.events.on('message', (e) => msgs.push(e.text));
    const money = sim.progress.money;
    step(sim, j.timer + 1);
    expect(sim.activities.job).toBeNull();
    expect(msgs.some((m) => m.startsWith('Too slow!'))).toBe(true);
    expect(sim.progress.money).toBe(money);
  });

  it('cannot skip a drop: the second drop-off pays nothing while the first is open', () => {
    const { sim, car, j } = courierSim();
    const money = sim.progress.money;
    moveCar(sim, car, j.drops[1]!.x, j.drops[1]!.z);
    step(sim, 0.5);
    expect(j.index).toBe(0);
    expect(sim.progress.money).toBe(money);
  });
});

describe('car export', () => {
  function exportSim(): Sim {
    const sim = makeSim();
    const board = places(sim.world).exportBoard;
    sim.player.pos.x = board.x;
    sim.player.pos.z = board.z;
    sim.interactions.interact();
    return sim;
  }

  function deliver(sim: Sim, kind: VehicleKind, color?: number): Vehicle {
    const crane = places(sim.world).crane;
    if (sim.player.vehicle) sim.playerCtl.ejectPlayer(false);
    const v = carAt(sim, kind, (crane.minX + crane.maxX) / 2, (crane.minZ + crane.maxZ) / 2, 0, color);
    step(sim, 0.2);
    return v;
  }

  it('is taken at Lou\'s board and lists eight cars', () => {
    const sim = exportSim();
    expect(sim.activities.job?.kind).toBe('carExport');
    expect(EXPORT_LIST).toHaveLength(8);
    expect(new Set(EXPORT_LIST.map((e) => e.id)).size).toBe(8);
    for (const e of EXPORT_LIST) expect(VEHICLE_SPECS[e.kind]).toBeDefined();
  });

  it('ships a matching car once, refuses non-matching and repeat cars without removing them', () => {
    const sim = exportSim();
    const msgs: string[] = [];
    sim.events.on('message', (e) => msgs.push(e.text));
    const red = EXPORT_LIST.find((e) => e.id === 'sports-red')!;
    let money = sim.progress.money;
    const a = deliver(sim, 'sports', red.color);
    expect(a.removed).toBe(true);
    expect(sim.progress.money - money).toBe(red.reward);
    expect(exportDone(sim.progress).has('sports-red')).toBe(true);
    // The same again: already shipped.
    money = sim.progress.money;
    const b = deliver(sim, 'sports', red.color);
    expect(b.removed).toBe(false);
    expect(sim.progress.money).toBe(money);
    expect(msgs.at(-1)).toMatch(/Already shipped/);
    // The wrong colour, and a kind not on the list.
    const c = deliver(sim, 'sedan', 0xeeeeee);
    expect(c.removed).toBe(false);
    expect(msgs.at(-1)).toMatch(/Not on my list/);
    const police = deliver(sim, 'police');
    expect(police.removed).toBe(false);
    expect(sim.progress.money).toBe(money);
    expect(exportDone(sim.progress).size).toBe(1);
  });

  it('pays the list bonus for the eighth car and records it', () => {
    const sim = exportSim();
    const money = sim.progress.money;
    for (const e of EXPORT_LIST) deliver(sim, e.kind, e.color ?? VEHICLE_SPECS[e.kind].colors[0]);
    const total = EXPORT_LIST.reduce((s, e) => s + e.reward, 0);
    expect(sim.progress.money - money).toBe(total + EXPORT_LIST_BONUS);
    expect(activityRecords(sim.progress).exportCars).toBe(8);
    expect(activityRecords(sim.progress).exportLists).toBe(1);
    expect(sim.activities.job).toBeNull();
    console.log(`export: 8 cars $${total} + bonus $${EXPORT_LIST_BONUS}`);
  });
});

describe('wasted, busted and missions end the new activities', () => {
  const starters: Array<[string, () => Sim]> = [
    ['ambulance', () => {
      const { sim } = ambulanceSim();
      sim.activities.toggleJob();
      return sim;
    }],
    ['firefighter', () => {
      const { sim } = fireSim();
      sim.activities.toggleJob();
      return sim;
    }],
    ['courier', () => {
      const sim = makeSim();
      const office = places(sim.world).courier;
      carAt(sim, 'sedan', office.x, office.z, office.heading).speed = 0;
      sim.activities.toggleJob();
      return sim;
    }],
    ['carExport', () => {
      const sim = makeSim();
      sim.activities.startExport();
      return sim;
    }],
  ];

  for (const [kind, make] of starters) {
    it(`${kind}: wasted, busted and a mission start each end it with nothing left behind`, () => {
      for (const how of ['wasted', 'busted', 'mission'] as const) {
        const sim = make();
        expect(sim.activities.job?.kind, kind).toBe(kind);
        const tagged = () => sim.characters.filter((c) => c.missionTag === 'patient' && !c.removed).length + sim.vehicles.filter((v) => v.missionTag === 'fire' && !v.removed && v.burning).length;
        if (how === 'wasted') sim.combat.damageCharacter(sim.player, 5000, null, 'fall', 0, -1, 0);
        else if (how === 'busted') sim.bustPlayer();
        else {
          if (sim.player.vehicle) sim.playerCtl.ejectPlayer(false);
          expect(sim.missions.start('wheels')).toBe(true);
        }
        expect(sim.activities.job, `${kind} ${how}`).toBeNull();
        expect(sim.activities.objectives()).toEqual([]);
        expect(tagged(), `${kind} ${how} leftovers`).toBe(0);
      }
    });
  }
});

describe('determinism', () => {
  function scripted(kind: string, seed: number): string {
    const out: unknown[] = [];
    if (kind === 'ambulance') {
      const { sim, car } = ambulanceSim(seed);
      sim.activities.toggleJob();
      playAmbulanceLevel(sim, car);
      step(sim, 3);
      const j = sim.activities.job as AmbulanceJob;
      out.push(sim.progress.money, j.level, j.waiting.map((c) => [c.pos.x, c.pos.z]), car.pos);
    } else if (kind === 'firefighter') {
      const { sim, truck } = fireSim(seed);
      sim.activities.toggleJob();
      const j = sim.activities.job as FireJob;
      for (const f of [...j.fires]) douseFire(sim, truck, f);
      step(sim, 3);
      out.push(sim.progress.money, j.level, j.fires.map((f) => [f.x, f.z, f.strength]), truck.pos);
    } else if (kind === 'courier') {
      const sim = makeSim({ seed });
      const office = places(sim.world).courier;
      const car = carAt(sim, 'sedan', office.x, office.z, office.heading);
      car.speed = 0;
      sim.activities.toggleJob();
      const j = sim.activities.job as CourierJob;
      step(sim, 2, input({ throttle: 0.6 }));
      moveCar(sim, car, j.drops[0]!.x, j.drops[0]!.z);
      step(sim, 0.5);
      out.push(sim.progress.money, j.index, j.drops, car.pos);
    } else {
      const sim = makeSim({ seed });
      sim.activities.startExport();
      const crane = places(sim.world).crane;
      const v = carAt(sim, 'pickup', (crane.minX + crane.maxX) / 2, (crane.minZ + crane.maxZ) / 2);
      step(sim, 1);
      out.push(sim.progress.money, [...exportDone(sim.progress)], v.removed, sim.player.pos);
    }
    return JSON.stringify(out);
  }

  it.each(['ambulance', 'firefighter', 'courier', 'carExport'])('%s: two same-seed runs give the same money, levels and positions', (kind) => {
    expect(scripted(kind, 21)).toBe(scripted(kind, 21));
  });
});

describe('export list save extension', () => {
  const legacy = () => JSON.parse(readFileSync(new URL('./fixtures/legacy_v1.save.json', import.meta.url), 'utf8'));

  function saved(sim: Sim): unknown {
    return JSON.parse(JSON.stringify(serialize(sim.progress, [], 0, 12, 1, serializeExt(sim))));
  }

  it('round-trips two delivered entries through the save ext, the other six open', () => {
    const a = makeSim();
    exportDone(a.progress).add('taxi');
    exportDone(a.progress).add('muscle');
    const raw = saved(a) as { ext: Record<string, unknown>; version: number };
    expect(raw.version).toBe(SAVE_VERSION);
    expect(SAVE_VERSION).toBe(1);
    expect(raw.ext[EXPORT_KEY]).toEqual({ done: ['muscle', 'taxi'] });
    const parsed = parseSave(raw)!;
    const b = makeSim();
    applySave(b.progress, parsed);
    applyExt(b, parsed.ext);
    expect([...exportDone(b.progress)].sort()).toEqual(['muscle', 'taxi']);
    expect(EXPORT_LIST.filter((e) => !exportDone(b.progress).has(e.id))).toHaveLength(6);
    console.log('save ext excerpt', JSON.stringify(raw.ext));
  });

  it('a legacy save without ext loads with a fresh list and its core unchanged', () => {
    const parsed = parseSave(legacy())!;
    expect(parsed.ext).toBeUndefined();
    const sim = makeSim();
    applySave(sim.progress, parsed);
    applyExt(sim, parsed.ext);
    expect(exportDone(sim.progress).size).toBe(0);
    expect(sim.progress.money).toBe(18450);
    expect(activityRecords(sim.progress)).toEqual({ ambulanceLevel: 0, patientsSaved: 0, fireLevel: 0, firesOut: 0, courierRuns: 0, parcelsDelivered: 0, exportCars: 0, exportLists: 0 });
  });

  it.each([
    ['a string', 'nope', []],
    ['done not an array', { done: 7 }, []],
    ['unknown car kinds dropped', { done: ['taxi', 'boat-blue', 3, 'taxi'] }, ['taxi']],
  ])('a corrupt export entry (%s) keeps the core save and resets or drops the bad entries', (_n, entry, expected) => {
    const parsed = parseSave({ ...legacy(), ext: { [EXPORT_KEY]: entry, [ACTIVITY_RECORDS_KEY]: { ambulanceLevel: 'x', fireLevel: 4 } } })!;
    expect(parsed).not.toBeNull();
    expect(parsed.money).toBe(18450);
    const sim = makeSim();
    applySave(sim.progress, parsed);
    applyExt(sim, parsed.ext);
    expect([...exportDone(sim.progress)]).toEqual(expected);
    expect(activityRecords(sim.progress).fireLevel).toBe(4);
    expect(activityRecords(sim.progress).ambulanceLevel).toBe(0);
  });

  it('records the activity stats in the save ext', () => {
    const a = makeSim();
    Object.assign(activityRecords(a.progress), { ambulanceLevel: 3, courierRuns: 2, exportCars: 5 });
    const parsed = parseSave(saved(a))!;
    const b = makeSim();
    applyExt(b, parsed.ext);
    expect(activityRecords(b.progress)).toMatchObject({ ambulanceLevel: 3, courierRuns: 2, exportCars: 5 });
  });
});

describe('service vehicle depots', () => {
  it('stand ready near the player in the game sim only, and are streamed out like parked cars once he is far away', () => {
    expect(makeSim().serviceVehicles).toBe(false);
    const sim = makeSim({ serviceVehicles: true, ambient: true, police: false });
    const d = places(sim.world).depots.find((p) => p.kind === 'ambulance')!;
    teleport(sim, d.x + 120, d.z - 60);
    step(sim, 1.2);
    const amb = sim.vehicles.find((v) => v.kind === 'ambulance' && !v.removed);
    expect(amb).toBeDefined();
    expect(amb!.persistent).toBe(false);
    expect(Math.hypot(amb!.pos.x - d.x, amb!.pos.z - d.z)).toBeLessThan(0.5);
    teleport(sim, d.x - 600, d.z + 300);
    step(sim, 6);
    expect(amb!.removed).toBe(true);
    // And back when he returns to the neighbourhood.
    teleport(sim, d.x + 120, d.z - 60);
    step(sim, 1.2);
    expect(sim.vehicles.some((v) => v.kind === 'ambulance' && !v.removed)).toBe(true);
  });
});
