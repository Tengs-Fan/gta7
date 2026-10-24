// Multiplayer street-crime ownership (scrutiny MP-SCR-CORE-001..004): concurrent rampages each own their enemies, a
// roadblock's cruisers join the chase only within the target pursuit's unit cap, and a departing player's delayed
// witness calls and angry-driver grievances end with him instead of landing on whoever holds or keeps slot 0.

import { describe, expect, it } from 'vitest';
import { Room, type Member, type Peer } from '../../server/room';
import { makeBrain } from '../../src/sim/brains';
import type { Character, Vehicle } from '../../src/sim/entities';
import { neutralInput, type PlayerInput } from '../../src/sim/input';
import type { PlayerSlot } from '../../src/sim/playerSlot';
import { Sim } from '../../src/sim/sim';
import { StaticWorld } from '../../src/world/staticWorld';

const DT = 1 / 60;
const UNITS_BY_LEVEL = [0, 2, 3, 4, 6, 7];

const peer = (): Peer => ({ bufferedAmount: 0, send() {}, close() {} });

function join(r: Room, id: number): Member {
  const m = r.join(id, `P${id}`, peer());
  if (m === 'full') throw new Error('room full');
  return m;
}

function slotOf(r: Room, m: Member): PlayerSlot {
  return r.sim.players.find((s) => s.id === m.slot)!;
}

function put(sim: Sim, s: PlayerSlot, x: number, z: number): void {
  const o = s.character.vehicle ?? s.character;
  o.pos.x = x;
  o.pos.z = z;
  o.pos.y = sim.world.groundHeight(x, z);
  o.vel.x = 0;
  o.vel.z = 0;
}

/** A camera looking back over the player (away from anything placed ahead of him). */
function lookBack(s: PlayerSlot): PlayerInput {
  const p = s.pos();
  const h = s.character.vehicle?.heading ?? s.character.heading;
  return {
    ...neutralInput(),
    handbrake: !!s.character.vehicle,
    aimOrigin: { x: p.x + Math.sin(h) * 6, y: p.y + 3, z: p.z + Math.cos(h) * 6 },
    aimDir: { x: -Math.sin(h), y: -0.1, z: -Math.cos(h) },
    cameraYaw: h,
  };
}

function tick(sim: Sim): void {
  sim.update(DT, new Map(sim.activePlayers().map((s) => [s.id, lookBack(s)])));
}

/** A wandering civilian a couple of metres from `s`, in clear sight of him. */
function bystander(r: Room, s: PlayerSlot): Character {
  const p = s.pos();
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
    const at = r.world.findFreeSpot(p.x + dx, p.z + dz, 0.4, 2);
    if (!at || !r.world.lineOfSight(at.x, r.world.groundHeight(at.x, at.z) + 1.6, at.z, p.x, p.y + 1.2, p.z)) continue;
    const c = r.sim.spawnCharacter('civilian', at.x, at.z);
    c.brain = makeBrain('wander');
    return c;
  }
  throw new Error('no spot for a witness');
}

describe('witness calls end with the player who committed the crime (MP-SCR-CORE-003)', () => {
  it('a call pending when slot 0’s player leaves never reaches the next player in slot 0', () => {
    const r = new Room('witness', 7, { realtime: false, log() {}, sim: { ambient: false } });
    const a = join(r, 1);
    const b = join(r, 2);
    const first = slotOf(r, a);
    expect(first.id).toBe(0);
    expect(r.sim.streetCrime.witnesses).toBe(true);
    const caller = bystander(r, first);
    const p = first.pos();
    first.wanted.crime('assault', p.x, p.z);
    expect(r.sim.witnesses.calls.length).toBe(1);
    const call = r.sim.witnesses.calls[0]!;
    expect(call.caller).toBe(caller);
    r.leave(a);
    const c = join(r, 3);
    const next = slotOf(r, c);
    expect(next).toBe(first);
    for (let k = 0; k < 9 * 60; k++) r.step();
    expect(call.state).toBe('lost');
    expect(next.wanted.level).toBe(0);
    expect(slotOf(r, b).wanted.level).toBe(0);
    expect(r.sim.witnesses.calls.length).toBe(0);
    expect(r.tickErrors).toBe(0);
    r.close();
  });

  it('a player in another slot leaving drops his calls, and the remaining player’s own call still goes through', () => {
    const r = new Room('witness2', 7, { realtime: false, log() {}, sim: { ambient: false } });
    const a = join(r, 1);
    const b = join(r, 2);
    const stays = slotOf(r, a);
    const goes = slotOf(r, b);
    put(r.sim, goes, stays.pos().x + 120, stays.pos().z);
    bystander(r, stays);
    bystander(r, goes);
    stays.wanted.crime('assault', stays.pos().x, stays.pos().z);
    goes.wanted.crime('assault', goes.pos().x, goes.pos().z);
    expect(r.sim.witnesses.calls.map((c) => c.slot.id).sort()).toEqual([0, 1]);
    const theirs = r.sim.witnesses.calls.find((c) => c.slot === goes)!;
    const mine = r.sim.witnesses.calls.find((c) => c.slot === stays)!;
    r.leave(b);
    expect(theirs.state).toBe('lost');
    for (let k = 0; k < 9 * 60 && mine.state === 'calling'; k++) r.step();
    expect(mine.state).toBe('reported');
    expect(stays.wanted.level).toBe(1);
    expect(r.tickErrors).toBe(0);
    r.close();
  });
});

/** Rams civilian cars into one another from `rammer`'s car until a driver decides to get out and fight. */
function angryDriver(r: Room, rammer: PlayerSlot, near: PlayerSlot) {
  const lane = r.sim.roads.lanes[40]!;
  put(r.sim, near, lane.sx + lane.dx * 25 + 4, lane.sz + lane.dz * 25 + 4);
  const driven = r.sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
  r.sim.seat(rammer.character, driven, 0);
  for (let k = 0; k < 20; k++) {
    const s = 30 + k * 12;
    const v = r.sim.spawnVehicle('sedan', lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
    v.owner = 'traffic';
    r.sim.addDriver(v, 'civilian', 'traffic');
    r.sim.onVehicleImpact(v, driven, 5, v.pos.x, v.pos.z, true);
    const g = r.sim.angryDrivers.active.find((x) => x.car === v && x.fights);
    if (g) return g;
  }
  throw new Error('no driver got out to fight');
}

describe('an angry driver’s grievance ends with the player who rammed him (MP-SCR-CORE-004)', () => {
  it('control: with the rammer still here the driver comes at him', () => {
    const r = new Room('angry0', 7, { realtime: false, log() {}, sim: { ambient: false } });
    const innocent = slotOf(r, join(r, 1));
    const rammer = slotOf(r, join(r, 2));
    const g = angryDriver(r, rammer, innocent);
    expect(g.state).toBe('waiting');
    r.step();
    expect(g.state).toBe('fighting');
    expect(g.driver.brain?.target).toBe(rammer.character);
    r.close();
  });

  it('a rammer in slot 1 leaving before the driver gets out never sets him on slot 0', () => {
    const r = new Room('angry1', 7, { realtime: false, log() {}, sim: { ambient: false } });
    const innocent = slotOf(r, join(r, 1));
    const b = join(r, 2);
    const rammer = slotOf(r, b);
    const g = angryDriver(r, rammer, innocent);
    r.leave(b);
    for (let k = 0; k < 4 * 60; k++) {
      r.step();
      expect(g.driver.brain?.target === innocent.character && g.driver.brain.mode === 'fight').toBe(false);
    }
    expect(g.state).not.toBe('fighting');
    expect(r.sim.angryDrivers.active.includes(g)).toBe(false);
    expect(r.tickErrors).toBe(0);
    r.close();
  });

  it('a fighting driver whose rammer leaves stops fighting and heads back', () => {
    const r = new Room('angry2', 7, { realtime: false, log() {}, sim: { ambient: false } });
    const innocent = slotOf(r, join(r, 1));
    const b = join(r, 2);
    const rammer = slotOf(r, b);
    const g = angryDriver(r, rammer, innocent);
    r.step();
    expect(g.state).toBe('fighting');
    r.leave(b);
    expect(g.driver.brain?.mode).not.toBe('fight');
    expect(g.driver.brain?.target ?? null).toBe(null);
    for (let k = 0; k < 4 * 60; k++) {
      r.step();
      expect(g.driver.brain?.mode === 'fight' && g.driver.brain.target === innocent.character).toBe(false);
    }
    expect(r.tickErrors).toBe(0);
    r.close();
  });

  it('slot 0’s rammer leaving and a newcomer taking slot 0 does not hand the newcomer the grievance', () => {
    const r = new Room('angry3', 7, { realtime: false, log() {}, sim: { ambient: false } });
    const a = join(r, 1);
    const rammer = slotOf(r, a);
    const other = slotOf(r, join(r, 2));
    const g = angryDriver(r, rammer, other);
    r.leave(a);
    const next = slotOf(r, join(r, 3));
    expect(next).toBe(rammer);
    for (let k = 0; k < 4 * 60; k++) {
      r.step();
      expect(g.driver.brain?.mode === 'fight' && !!g.driver.brain.target?.isPlayer).toBe(false);
    }
    expect(r.sim.angryDrivers.active.includes(g)).toBe(false);
    expect(r.tickErrors).toBe(0);
    r.close();
  });
});

function twoRampages(seed = 7) {
  const sim = new Sim({ world: new StaticWorld(), seed, multiplayer: true, streetCrime: true, ambient: false, police: false });
  const a = sim.players[0]!;
  const b = sim.addPlayer(a.pos().x + 500, a.pos().z);
  const icons = sim.pickups.filter((p) => p.kind === 'rampage');
  return { sim, a, b, icons };
}

describe('concurrent rampages own their enemies (MP-SCR-CORE-001)', () => {
  it('slot 0 dying mid-rampage leaves slot 1’s enemies tagged, hostile and counting for slot 1', () => {
    const { sim, a, b, icons } = twoRampages();
    put(sim, a, icons[0]!.pos.x, icons[0]!.pos.z);
    put(sim, b, icons[1]!.pos.x, icons[1]!.pos.z);
    tick(sim);
    const jobB = sim.activities.jobOf(b)!;
    expect(sim.activities.jobOf(a)?.kind).toBe('rampage');
    expect(jobB.kind).toBe('rampage');
    const enemyA = sim.characters.find((c) => c.missionTag === 'rampage' && c.brain?.target === a.character)!;
    const enemyB = sim.characters.find((c) => c.missionTag === 'rampage' && c.brain?.target === b.character)!;
    expect(enemyA).toBeTruthy();
    expect(enemyB).toBeTruthy();
    sim.combat.damageCharacter(a.character, 5000, null, 'fall', 0, -1, 0);
    expect(a.deathKind).toBe('wasted');
    expect(sim.activities.jobOf(a)).toBe(null);
    // Slot 0's own enemy goes back to the city; slot 1's stays on the job.
    expect(enemyA.missionTag).toBe('');
    expect(enemyB.missionTag).toBe('rampage');
    expect(enemyB.brain!.hostile).toBe(true);
    expect(enemyB.brain!.mode).toBe('fight');
    sim.combat.damageCharacter(enemyB, 5000, b.character, 'bullet', 1, 0, 0);
    expect(sim.activities.jobOf(b)).toBe(jobB);
    expect(jobB.kind === 'rampage' ? jobB.kills : -1).toBe(1);
  });

  it('slot 0’s seven live enemies do not keep slot 1’s rampage from spawning its own', () => {
    const { sim, a, b, icons } = twoRampages();
    put(sim, a, icons[0]!.pos.x, icons[0]!.pos.z);
    put(sim, b, icons[1]!.pos.x, icons[1]!.pos.z + 10);
    sim.pickupSys.update(DT);
    for (let k = 0; k < 10 * 60; k++) sim.activities.update(DT);
    expect(sim.characters.filter((c) => c.missionTag === 'rampage' && c.alive && c.brain?.target === a.character).length).toBe(7);
    put(sim, b, icons[1]!.pos.x, icons[1]!.pos.z);
    sim.pickupSys.update(DT);
    expect(sim.activities.jobOf(b)?.kind).toBe('rampage');
    for (let k = 0; k < 3 * 60; k++) sim.activities.update(DT);
    expect(sim.characters.filter((c) => c.missionTag === 'rampage' && c.alive && c.brain?.target === b.character).length).toBeGreaterThan(0);
    // Each rampage still tops out at seven of its own.
    for (let k = 0; k < 10 * 60; k++) sim.activities.update(DT);
    expect(sim.characters.filter((c) => c.missionTag === 'rampage' && c.alive && c.brain?.target === b.character).length).toBe(7);
    expect(sim.characters.filter((c) => c.missionTag === 'rampage' && c.alive && c.brain?.target === a.character).length).toBe(7);
  });

  it('killing another player’s rampage enemy counts for neither rampage', () => {
    const { sim, a, b, icons } = twoRampages();
    put(sim, a, icons[0]!.pos.x, icons[0]!.pos.z);
    put(sim, b, icons[1]!.pos.x, icons[1]!.pos.z);
    tick(sim);
    const jobA = sim.activities.jobOf(a)!;
    const jobB = sim.activities.jobOf(b)!;
    const enemyA = sim.characters.find((c) => c.missionTag === 'rampage' && c.brain?.target === a.character)!;
    sim.combat.damageCharacter(enemyA, 5000, b.character, 'bullet', 1, 0, 0);
    expect(jobA.kind === 'rampage' ? jobA.kills : -1).toBe(0);
    expect(jobB.kind === 'rampage' ? jobB.kills : -1).toBe(0);
  });
});

describe('a roadblock making way stays within its target pursuit’s unit cap (MP-SCR-CORE-002)', () => {
  it('three stars: four units on the chase and a unit held up by the roadblock never make more than four', () => {
    const sim = new Sim({ world: new StaticWorld(), seed: 7, multiplayer: true, streetCrime: true, ambient: true, police: true });
    sim.missions.noBust = true;
    const a = sim.players[0]!;
    const b = sim.addPlayer(a.pos().x + 500, a.pos().z);
    a.cheats.godMode = true;
    b.cheats.godMode = true;
    const lane = sim.roads.lanes
      .filter((l) => l.line.avenue && Math.abs(l.dx) < 0.1 && l.dz > 0 && l.sz < -150 && l.sz > -260 && l.length > 60)
      .sort((x, y) => Math.abs(x.line.pos) - Math.abs(y.line.pos))[0]!;
    const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 4, lane.sz + lane.dz * 4, lane.heading);
    sim.seat(a.character, car, 0);
    car.usedByPlayer = true;
    put(sim, b, car.pos.x - 500, car.pos.z);
    a.wanted.setLevel(3);
    for (const s of sim.players) {
      const i = lookBack(s);
      Object.assign(s.cam, i.aimOrigin);
      Object.assign(s.camDir, i.aimDir);
    }
    const rb = sim.roadblocks.place(3)!;
    expect(rb).toBeTruthy();
    put(sim, a, rb.x + rb.ux * 80 + lane.sx - lane.line.pos, rb.z + rb.uz * 80);
    put(sim, b, a.pos().x - 80, a.pos().z);
    a.wanted.setLevel(3);
    const units: Vehicle[] = [];
    for (let k = 0; k < 40 && units.length < 4; k++) {
      const v = sim.police.spawnUnit('police', true, a);
      if (v) units.push(v);
    }
    expect(units.length).toBe(4);
    const onDuty = () =>
      sim.vehicles.filter(
        (v) =>
          !v.removed &&
          v.owner === 'police' &&
          v.drivable &&
          (!v.driver || v.driver.isLaw) &&
          sim.police.targetSlotOf(v) === a.id &&
          (v.occupants().some((c) => c.isLaw && c.alive) || sim.characters.some((c) => !c.removed && c.isLaw && c.alive && c.brain?.car === v)),
      ).length;
    expect(onDuty()).toBe(4);
    // One of the four right behind a roadblock cruiser: DriverAI finds itself held up by it.
    const blocked = units[0]!;
    const barrier = rb.cars[0]!;
    const gap = blocked.halfL + barrier.halfL + 1;
    blocked.pos.x = barrier.pos.x - rb.ux * gap;
    blocked.pos.z = barrier.pos.z - rb.uz * gap;
    blocked.pos.y = sim.world.groundHeight(blocked.pos.x, blocked.pos.z);
    blocked.heading = Math.atan2(rb.ux, rb.uz);
    blocked.vel.x = 0;
    blocked.vel.z = 0;
    const near = sim.roads.nearestLane(blocked.pos.x, blocked.pos.z, blocked.heading);
    blocked.ai!.setLane(near.lane, near.s);
    let max = 0;
    let held = 0;
    for (let k = 0; k < 10 * 60; k++) {
      tick(sim);
      if (blocked.ai?.heldUpBy && rb.cars.includes(blocked.ai.heldUpBy)) held++;
      if (a.wanted.level === 3) max = Math.max(max, onDuty());
    }
    expect(held).toBeGreaterThan(150);
    // The roadblock made way (no cruiser of it is parked across the road any more) ...
    expect(rb.cars.every((v) => !sim.roadblocks.isParked(v))).toBe(true);
    // ... without its cruisers taking the pursuit past what three stars send.
    expect(max).toBeLessThanOrEqual(UNITS_BY_LEVEL[3]!);
  });

  it('a pursuit with room takes the roadblock’s cruisers on, up to its cap', () => {
    const sim = new Sim({ world: new StaticWorld(), seed: 7, multiplayer: true, streetCrime: true, ambient: false, police: true });
    const a = sim.players[0]!;
    sim.addPlayer(a.pos().x + 500, a.pos().z);
    a.wanted.setLevel(3);
    expect(sim.police.hasRoom(a.id)).toBe(true);
    for (let k = 0; k < 40; k++) sim.police.spawnUnit('police', true, a);
    let n = 0;
    for (const v of sim.vehicles) if (!v.removed && v.owner === 'police' && v.driver?.isLaw && sim.police.targetSlotOf(v) === a.id) n++;
    expect(n).toBeGreaterThanOrEqual(UNITS_BY_LEVEL[3]!);
    expect(sim.police.hasRoom(a.id)).toBe(false);
    // Another player's pursuit is not filled up by slot 0's units.
    const b = sim.players[1]!;
    b.wanted.setLevel(3);
    expect(sim.police.hasRoom(b.id)).toBe(true);
    // Nor has a player with no stars, or one who is not in the sim, any room.
    b.wanted.clear();
    expect(sim.police.hasRoom(b.id)).toBe(false);
    expect(sim.police.hasRoom(9)).toBe(false);
  });
});
