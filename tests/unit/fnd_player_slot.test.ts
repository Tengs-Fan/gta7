// PlayerSlot and Sim.players: the single-player names alias slot 0, the update takes one input or one per slot,
// visibility and distance cover every slot, each slot has its own controller, and a crime goes to its culprit.

import { describe, expect, it } from 'vitest';
import { PlayerController } from '../../src/sim/player';
import { PlayerSlot } from '../../src/sim/playerSlot';
import type { Character } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import { input, makeSim, roadPoint, teleport } from './helpers';

const DT = 1 / 60;

/** Entity references in event payloads become ids; numbers stay exact. */
function serialise(type: string, payload: unknown): string {
  return `${type} ${JSON.stringify(payload, function (this: unknown, key, value: unknown) {
    if (key !== '' && value && typeof value === 'object' && 'id' in value && 'pos' in value) return `${'spec' in value ? 'V' : 'C'}${(value as { id: number }).id}`;
    return value;
  })}`;
}

function recordEvents(sim: Sim): string[] {
  const log: string[] = [];
  const emit = sim.events.emit.bind(sim.events);
  sim.events.emit = ((type: string, payload: unknown) => {
    log.push(`${sim.frame} ${serialise(type, payload)}`);
    (emit as (t: string, p: unknown) => void)(type, payload);
  }) as typeof sim.events.emit;
  return log;
}

/** A pose for the camera at a character, so visibility has something to work with. */
function lookAt(c: Character, over: Partial<PlayerInput> = {}): PlayerInput {
  return input({ aimOrigin: { x: c.pos.x, y: c.pos.y + 3, z: c.pos.z - 6 }, aimDir: { x: 0, y: -0.1, z: 1 }, ...over });
}

describe('Sim.players and the slot-0 aliases', () => {
  it('a new sim has one slot, id 0, and every old name is the same object or value as the slot’s', () => {
    const sim = makeSim();
    expect(sim.players.length).toBe(1);
    const slot = sim.players[0]!;
    expect(slot).toBeInstanceOf(PlayerSlot);
    expect(slot.id).toBe(0);
    expect(sim.player).toBe(slot.character);
    expect(sim.playerCtl).toBe(slot.ctl);
    expect(sim.wanted).toBe(slot.wanted);
    expect(sim.progress).toBe(slot.progress);
    expect(sim.cheats).toBe(slot.cheats);
    expect(sim.cam).toBe(slot.cam);
    expect(sim.camDir).toBe(slot.camDir);
    expect(sim.lastInput).toBe(slot.input);
    expect(sim.slotOf(sim.player)).toBe(slot);
    expect(sim.slotOf(sim.spawnCharacter('civilian', 5, 5))).toBeUndefined();
  });

  it('writes through an alias reach the slot', () => {
    const sim = makeSim();
    const slot = sim.players[0]!;
    sim.controlLock = 3;
    expect(slot.controlLock).toBe(3);
    slot.controlLock = 1;
    expect(sim.controlLock).toBe(1);
    sim.deathKind = 'busted';
    sim.deathTimer = 2.5;
    sim.deathLevel = 4;
    expect([slot.deathKind, slot.deathTimer, slot.deathLevel]).toEqual(['busted', 2.5, 4]);
    expect(sim.playerDown).toBe(true);
    slot.deathKind = null;
    expect(sim.deathKind).toBeNull();
    const next = input({ moveZ: 1 });
    sim.lastInput = next;
    expect(slot.input).toBe(next);
    sim.cam.x = 12;
    sim.camDir.z = -1;
    sim.cheats.godMode = true;
    expect([slot.cam.x, slot.camDir.z, slot.cheats.godMode]).toEqual([12, -1, true]);
    sim.update(DT, input({ aimOrigin: { x: 1, y: 2, z: 3 }, aimDir: { x: 0, y: 0, z: 1 } }));
    expect(slot.input).toBe(sim.lastInput);
    expect([slot.cam.x, slot.cam.y, slot.cam.z]).toEqual([1, 2, 3]);
  });

  it('each slot has its own controller, progress, wanted record and cheats', () => {
    const sim = makeSim();
    const b = sim.addPlayer(sim.player.pos.x + 10, sim.player.pos.z);
    expect(sim.players.length).toBe(2);
    expect(b.id).toBe(1);
    expect(sim.slotOf(b.character)).toBe(b);
    expect(b.ctl).toBeInstanceOf(PlayerController);
    expect(b.ctl).not.toBe(sim.players[0]!.ctl);
    expect(b.ctl.p).toBe(b);
    expect(sim.players[0]!.ctl.p).toBe(sim.players[0]);
    expect(b.wanted).not.toBe(sim.wanted);
    expect(b.progress).not.toBe(sim.progress);
    expect(b.cheats).not.toBe(sim.cheats);
    expect(b.character.isPlayer).toBe(true);
  });
});

describe('Sim.update with one input or a Map of inputs', () => {
  function scripted(asMap: boolean) {
    const sim = makeSim({ ambient: true, police: true, seed: 17 });
    const log = recordEvents(sim);
    sim.spawnVehicle('sedan', sim.player.pos.x + 4, sim.player.pos.z, 0);
    const checkpoints: string[] = [];
    for (let f = 0; f < 1200; f++) {
      let inp: PlayerInput;
      if (f < 120) inp = input({ moveZ: 1, sprint: f > 60 });
      else if (f === 120) inp = input({ enterExit: true });
      else if (f < 600) inp = input({ throttle: f % 200 < 150 ? 1 : 0, steer: Math.sin(f / 50) * 0.5 });
      else if (f === 600) inp = input({ enterExit: true });
      else {
        sim.player.inventory.give('pistol', 50);
        inp = input({ fire: f % 30 === 0, firePressed: f % 30 === 0, aim: true });
      }
      inp.aimOrigin = { x: sim.player.pos.x, y: sim.player.pos.y + 3, z: sim.player.pos.z - 6 };
      sim.update(DT, asMap ? new Map([[0, inp]]) : inp);
      if ((f + 1) % 60 === 0) {
        checkpoints.push(JSON.stringify({ p: sim.player.pos, v: sim.vehicles.map((v) => [v.id, v.pos.x, v.pos.z]), c: sim.characters.map((c) => [c.id, c.pos.x, c.pos.z]), w: sim.wanted.level, m: sim.progress.money, e: log.length }));
      }
    }
    return { checkpoints, log };
  }

  it('a Map holding slot 0’s input steps exactly like the single input', () => {
    const single = scripted(false);
    const viaMap = scripted(true);
    expect(single.checkpoints.length).toBe(20);
    expect(viaMap.checkpoints).toEqual(single.checkpoints);
    expect(viaMap.log).toEqual(single.log);
    expect(single.log.length).toBeGreaterThan(0);
  });

  it('a Map without slot 0 acts as neutral input: it does not throw and does not reuse the last input', () => {
    const sim = makeSim();
    sim.update(DT, input({ moveZ: 1, aimOrigin: { x: 5, y: 6, z: 7 } }));
    expect(sim.lastInput.moveZ).toBe(1);
    expect(() => sim.update(DT, new Map())).not.toThrow();
    expect(sim.lastInput.moveZ).toBe(0);
    expect(sim.cam).toMatchObject({ x: 0, y: 0, z: 0 });
    const idle = makeSim();
    const walkThenIdle = makeSim();
    walkThenIdle.update(DT, input({ moveZ: 1 }));
    for (let i = 0; i < 120; i++) {
      idle.update(DT, new Map<number, PlayerInput>());
      walkThenIdle.update(DT, new Map<number, PlayerInput>());
    }
    // Both started on the same spot; the one that walked one frame first has only that frame's slide to show for it.
    expect(Math.hypot(walkThenIdle.player.pos.x - idle.player.pos.x, walkThenIdle.player.pos.z - idle.player.pos.z)).toBeLessThan(0.5);
  });

  it('a single input drives slot 0 only; the other slots get neutral input', () => {
    const sim = makeSim();
    const b = sim.addPlayer(sim.player.pos.x + 10, sim.player.pos.z);
    const bx = b.character.pos.x;
    const bz = b.character.pos.z;
    for (let i = 0; i < 120; i++) sim.update(DT, input({ moveZ: 1 }));
    expect(Math.hypot(sim.player.pos.x - bx + 10, sim.player.pos.z - bz)).toBeGreaterThan(1);
    expect(Math.hypot(b.character.pos.x - bx, b.character.pos.z - bz)).toBeLessThan(0.1);
  });
});

describe('visibility and nearest-player helpers over every slot', () => {
  /** The pre-slot isVisible, for the one-slot comparison. */
  function baselineVisible(sim: Sim, x: number, y: number, z: number, maxDist = 320): boolean {
    const dx = x - sim.cam.x;
    const dy = y - sim.cam.y;
    const dz = z - sim.cam.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 6) return true;
    if (d > maxDist) return false;
    const cos = (dx * sim.camDir.x + dy * sim.camDir.y + dz * sim.camDir.z) / d;
    if (cos < 0.42) return false;
    return sim.world.lineOfSight(sim.cam.x, sim.cam.y, sim.cam.z, x, y + 1, z);
  }

  it('with one slot, every helper gives the pre-slot answer on a table of 14 points', () => {
    const sim = makeSim();
    // On a long straight road, so that some points are in the open and some are hidden.
    const road = roadPoint(sim, 40, 10);
    teleport(sim, road.x, road.z);
    const p = sim.player.pos;
    const yaw = road.heading;
    sim.update(DT, input({ aimOrigin: { x: p.x - Math.sin(yaw) * 6, y: p.y + 3, z: p.z - Math.cos(yaw) * 6 }, aimDir: { x: Math.sin(yaw) * 0.99, y: -0.1, z: Math.cos(yaw) * 0.99 } }));
    const points: Array<[number, number, number]> = [];
    for (const [dist, ang] of [[3, 0], [8, 0], [20, 0], [60, 0], [150, 0.3], [330, 0], [8, Math.PI], [40, Math.PI], [100, Math.PI / 2], [25, -Math.PI / 2], [200, Math.PI], [12, 1], [70, -0.4], [5, 2]] as const) {
      points.push([p.x + Math.sin(yaw + ang) * dist, p.y + 1, p.z + Math.cos(yaw + ang) * dist]);
    }
    expect(points.length).toBeGreaterThanOrEqual(10);
    let visible = 0;
    for (const [x, y, z] of points) {
      expect(sim.isVisible(x, y, z), `${x},${z}`).toBe(baselineVisible(sim, x, y, z));
      expect(sim.isVisible(x, y, z, 50)).toBe(baselineVisible(sim, x, y, z, 50));
      expect(sim.distToPlayer(x, z)).toBe(Math.hypot(x - sim.playerPos().x, z - sim.playerPos().z));
      expect(sim.nearestPlayer(x, z)).toBe(sim.players[0]);
      if (baselineVisible(sim, x, y, z)) visible++;
    }
    expect(visible).toBeGreaterThan(2);
    expect(visible).toBeLessThan(points.length);
  });

  it('with a second slot 400 m away, each helper looks at both', () => {
    const sim = makeSim();
    // Slot 1 stands on a long straight road, its camera on the road looking along it.
    const road = roadPoint(sim, 40, 10);
    const b = sim.addPlayer(road.x, road.z);
    const dir = { x: Math.sin(road.heading), z: Math.cos(road.heading) };
    const here = sim.player.pos;
    expect(Math.hypot(road.x - here.x, road.z - here.z)).toBeGreaterThan(200);
    // Put slot 0 far from slot 1: move it 400 m away along the road's line, if that is not it already.
    sim.player.pos.x = road.x + 400;
    sim.player.pos.z = road.z + 400;
    const cam1 = { x: road.x, y: sim.world.groundHeight(road.x, road.z) + 1.7, z: road.z };
    const inputs = new Map<number, PlayerInput>([
      [0, input({ aimOrigin: { x: sim.player.pos.x, y: sim.player.pos.y + 3, z: sim.player.pos.z - 6 }, aimDir: { x: 0, y: -0.1, z: 1 } })],
      [1, input({ aimOrigin: cam1, aimDir: { x: dir.x, y: 0, z: dir.z } })],
    ]);
    sim.update(DT, inputs);
    expect(b.cam).toMatchObject(cam1);
    const ahead = { x: cam1.x + dir.x * 20, z: cam1.z + dir.z * 20 };
    const gy = sim.world.groundHeight(ahead.x, ahead.z);
    const d0 = Math.hypot(ahead.x - sim.player.pos.x, ahead.z - sim.player.pos.z);
    expect(d0).toBeGreaterThan(300);
    expect(sim.isVisible(ahead.x, gy, ahead.z)).toBe(true);
    expect(sim.distToPlayer(ahead.x, ahead.z)).toBeCloseTo(Math.hypot(ahead.x - road.x, ahead.z - road.z), 6);
    expect(sim.distToPlayer(ahead.x, ahead.z)).toBeLessThan(25);
    expect(sim.nearestPlayer(ahead.x, ahead.z)).toBe(b);
    expect(sim.nearestPlayer(sim.player.pos.x + 3, sim.player.pos.z)).toBe(sim.players[0]);
    // Far from both players and in front of neither camera.
    const nowhere = { x: road.x - 500, z: road.z - 500 };
    expect(sim.isVisible(nowhere.x, sim.world.groundHeight(nowhere.x, nowhere.z), nowhere.z)).toBe(false);
    // Behind slot 1's camera, out of reach of slot 0's too.
    const behind = { x: cam1.x - dir.x * 80, z: cam1.z - dir.z * 80 };
    expect(sim.isVisible(behind.x, sim.world.groundHeight(behind.x, behind.z), behind.z)).toBe(false);
  });
});

describe('a controller, interactions and jobs for each slot', () => {
  it('slot 1 pressing interact at a marker uses it for slot 1 only', () => {
    const sim = makeSim();
    const shop = sim.interactions.markers.find((m) => m.kind === 'gunshop')!;
    const save = sim.interactions.markers.find((m) => m.kind === 'save')!;
    const b = sim.addPlayer(shop.x, shop.z);
    teleport(sim, save.x, save.z);
    const opened: Array<number | undefined> = [];
    sim.events.on('shopOpen', (e) => opened.push(e.playerId));
    expect(sim.interactions.current(b)?.id).toBe(shop.id);
    expect(sim.interactions.current(sim.players[0]!)?.kind).toBe('save');
    sim.update(DT, new Map([[1, lookAt(b.character, { interact: true })]]));
    expect(opened).toEqual([1]);
    // Slot 0 pressing it elsewhere changes nothing for slot 1.
    b.character.health = 40;
    sim.player.health = 40;
    const saved: Array<number | undefined> = [];
    sim.events.on('saveRequested', (e) => saved.push(e.playerId));
    sim.update(DT, new Map([[0, lookAt(sim.player, { interact: true })]]));
    expect(saved).toEqual([undefined]);
    expect(sim.player.health).toBe(sim.player.maxHealth);
    expect(b.character.health).toBe(40);
  });

  // Revised by mp-core: every slot now runs its own job (it used to be slot 0's only, so slot 1's key did nothing).
  it('slot 1 pressing the job key in a taxi starts slot 1’s own job; each key starts and ends only its own', () => {
    const sim = makeSim();
    const taxi = sim.spawnVehicle('taxi', 0, 0, 0);
    const other = sim.spawnVehicle('taxi', 20, 0, 0);
    const b = sim.addPlayer(20, 0);
    sim.seat(b.character, other, 0);
    expect(sim.activities.jobPrompt(b)).toBe('Press T to start a taxi job');
    sim.update(DT, new Map([[1, lookAt(b.character, { job: true })]]));
    expect(sim.activities.job).toBeNull();
    expect(sim.activities.jobOf(b)?.kind).toBe('taxi');
    expect(sim.activities.jobPrompt(b)).toBeNull();
    sim.seat(sim.player, taxi, 0);
    expect(sim.activities.jobPrompt(sim.players[0]!)).toBe('Press T to start a taxi job');
    sim.update(DT, new Map([[0, lookAt(sim.player, { job: true })]]));
    expect(sim.activities.job?.kind).toBe('taxi');
    // Slot 1's key ends slot 1's job, never slot 0's.
    sim.update(DT, new Map([[1, lookAt(b.character, { job: true })]]));
    expect(sim.activities.job?.kind).toBe('taxi');
    expect(sim.activities.jobOf(b)).toBeNull();
    sim.update(DT, new Map([[0, lookAt(sim.player, { job: true })]]));
    expect(sim.activities.job).toBeNull();
  });

  it('slot 1 pressing enter at a car seats slot 1’s character, and slot 0 is unaffected', () => {
    const sim = makeSim({ police: false });
    const b = sim.addPlayer(sim.player.pos.x + 12, sim.player.pos.z);
    const car = sim.spawnVehicle('sedan', b.character.pos.x + 3, b.character.pos.z, 0);
    car.pos.x = b.character.pos.x + car.halfW + 1.5;
    expect(b.ctl.findEnterable(b.character)).toBe(car);
    sim.update(DT, new Map([[1, lookAt(b.character, { enterExit: true })]]));
    for (let i = 0; i < 90; i++) sim.update(DT, new Map([[1, lookAt(b.character)]]));
    expect(b.character.vehicle).toBe(car);
    expect(car.driver).toBe(b.character);
    expect(sim.player.vehicle).toBeNull();
    expect(sim.player.state).toBe('normal');
    expect(car.usedByPlayer).toBe(true);
  });
});

describe('wanted.crime and its culprit', () => {
  it('a crime with no culprit, or by slot 0, goes to slot 0', () => {
    const sim = makeSim();
    const b = sim.addPlayer(sim.player.pos.x + 10, sim.player.pos.z);
    sim.wanted.crime('murder', 0, 0);
    expect(sim.wanted.level).toBeGreaterThan(0);
    expect(b.wanted.level).toBe(0);
    sim.wanted.clear();
    sim.wanted.crime('murder', 0, 0, sim.players[0]);
    expect(sim.wanted.level).toBeGreaterThan(0);
    sim.wanted.clear();
    sim.wanted.crime('murder', 0, 0, sim.player);
    expect(sim.wanted.level).toBeGreaterThan(0);
    expect(b.wanted.level).toBe(0);
  });

  it('a crime by slot 1 changes slot 1’s record, whichever system reports it', () => {
    const sim = makeSim();
    const b = sim.addPlayer(sim.player.pos.x + 10, sim.player.pos.z);
    const levels: Array<[number, number | undefined]> = [];
    sim.events.on('wanted', (e) => levels.push([e.level, e.playerId]));
    sim.wanted.crime('murder', 0, 0, b);
    expect(sim.wanted.level).toBe(0);
    expect(b.wanted.level).toBeGreaterThan(0);
    expect(levels).toEqual([[b.wanted.level, 1]]);
    sim.wanted.clear();
    b.wanted.clear();
    sim.wanted.crime('murder', 0, 0, 1);
    sim.wanted.crime('murder', 0, 0, b.character);
    expect(sim.wanted.level).toBe(0);
    expect(b.wanted.level).toBeGreaterThan(0);
    expect(b.progress.stats.maxWanted).toBeGreaterThan(0);
    expect(sim.progress.stats.maxWanted).toBe(0);
  });

  it('slot 1 punching or shooting a civilian records the crime against slot 1', () => {
    const sim = makeSim({ police: true });
    const b = sim.addPlayer(sim.player.pos.x + 10, sim.player.pos.z);
    const p = b.character;
    // A police officer close by, so that the assault is witnessed.
    sim.spawnCharacter('cop', p.pos.x, p.pos.z - 4);
    const victim = sim.spawnCharacter('civilian', p.pos.x + 2, p.pos.z);
    sim.combat.damageCharacter(victim, 5, p, 'melee', 1, 0, 0);
    expect(sim.wanted.level).toBe(0);
    expect(b.wanted.heat).toBeGreaterThan(0);
    expect(sim.wanted.heat).toBe(0);
    p.inventory.give('pistol', 50);
    p.inventory.current = 'pistol';
    const target = sim.spawnCharacter('civilian', p.pos.x + 8, p.pos.z);
    const heatBefore = b.wanted.heat;
    for (let i = 0; i < 30; i++) {
      const aim = aimAtCharacter(p, target);
      sim.update(DT, new Map([[1, { ...aim, aim: true, fire: i === 2, firePressed: i === 2 }]]));
    }
    expect(b.progress.stats.shotsFired).toBeGreaterThan(0);
    expect(sim.progress.stats.shotsFired).toBe(0);
    expect(b.wanted.heat).toBeGreaterThan(heatBefore);
    expect(sim.wanted.heat).toBe(0);
    expect(sim.wanted.level).toBe(0);
  });

  it('two culprits hitting one victim within the assault gap are each recorded', () => {
    const sim = makeSim({ police: true });
    const a = sim.players[0]!;
    const b = sim.addPlayer(a.character.pos.x + 1, a.character.pos.z);
    const p = b.character.pos;
    sim.spawnCharacter('cop', p.x, p.z - 4);
    const victim = sim.spawnCharacter('civilian', p.x + 2, p.z);
    sim.combat.damageCharacter(victim, 5, a.character, 'melee', 1, 0, 0);
    expect(a.wanted.heat).toBeGreaterThan(0);
    expect(b.wanted.heat).toBe(0);
    sim.combat.damageCharacter(victim, 5, b.character, 'melee', 1, 0, 0);
    expect(b.wanted.heat).toBeGreaterThan(0);
  });

  it('each culprit stays rate-limited on a shared victim: a repeat hit inside the gap adds no heat, one after it does', () => {
    const sim = makeSim({ police: true });
    const a = sim.players[0]!;
    const b = sim.addPlayer(a.character.pos.x + 1, a.character.pos.z);
    const p = b.character.pos;
    sim.spawnCharacter('cop', p.x, p.z - 4);
    const victim = sim.spawnCharacter('civilian', p.x + 2, p.z);
    const hit = (by: Character) => sim.combat.damageCharacter(victim, 1, by, 'melee', 1, 0, 0);
    hit(a.character);
    hit(b.character);
    const heat = [a.wanted.heat, b.wanted.heat];
    expect(heat[0]).toBeGreaterThan(0);
    expect(heat[1]).toBeGreaterThan(0);
    hit(a.character);
    hit(b.character);
    expect([a.wanted.heat, b.wanted.heat]).toEqual(heat);
    for (let i = 0; i < 20; i++) sim.update(DT, new Map([[0, input()], [1, input()]]));
    hit(b.character);
    expect(b.wanted.heat).toBeGreaterThan(heat[1]!);
    expect(a.wanted.heat).toBeLessThanOrEqual(heat[0]!);
  });

  it('every .crime( call in src/sim passes the attacker where it is known', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
    const sites: string[] = [];
    for (const f of walk(join(__dirname, '../../src/sim'))) {
      for (const line of readFileSync(f, 'utf8').split('\n')) if (/\.crime\(/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/crime\(type: CrimeType/.test(line) && !/culprit\.wanted\.crime\(type, x, z\)/.test(line)) sites.push(`${f.split('/src/sim/')[1]}: ${line.trim()}`);
    }
    expect(sites.length).toBeGreaterThan(10);
    // Each site names its culprit as a fourth argument, or reports through the slot's own system.
    const bare = sites.filter((s) => !/crime\([^()]*(\([^()]*\))?[^()]*,[^,()]+,[^,()]+,\s*[\w.!]+\)/.test(s));
    expect(bare).toEqual([]);
  });
});

function aimAtCharacter(from: Character, to: Character): PlayerInput {
  const o = { x: from.pos.x, y: from.pos.y + 1.6, z: from.pos.z };
  let dx = to.pos.x - o.x;
  let dy = to.pos.y + 1.2 - o.y;
  let dz = to.pos.z - o.z;
  const l = Math.hypot(dx, dy, dz) || 1;
  dx /= l;
  dy /= l;
  dz /= l;
  return input({ aimOrigin: { x: o.x - dx * 3, y: o.y - dy * 3, z: o.z - dz * 3 }, aimDir: { x: dx, y: dy, z: dz }, cameraYaw: Math.atan2(dx, dz) });
}

describe('a two-slot sim steps deterministically', () => {
  function run(swap: boolean) {
    const sim = makeSim({ ambient: true, police: true, seed: 9, weather: 'dynamic' });
    const log = recordEvents(sim);
    const home = sim.player.pos;
    const spot = sim.world.findFreeSpot(home.x + 10, home.z, 0.5, 6) ?? { x: home.x + 10, z: home.z };
    const b = sim.addPlayer(spot.x, spot.z);
    const start = { a: { ...sim.player.pos }, b: { ...b.character.pos } };
    const walker = swap ? sim.players[0]! : b;
    const idler = swap ? b : sim.players[0]!;
    const frames: string[] = [];
    for (let f = 0; f < 600; f++) {
      const w = walker.character;
      const walk = f < 300 ? input({ moveZ: 1, cameraYaw: 0 }) : input({ moveZ: 1, sprint: true, cameraYaw: Math.PI / 2 });
      walk.aimOrigin = { x: w.pos.x, y: w.pos.y + 3, z: w.pos.z - 6 };
      const idle = input({ aimOrigin: { x: idler.character.pos.x, y: idler.character.pos.y + 3, z: idler.character.pos.z - 6 } });
      sim.update(DT, new Map([[walker.id, walk], [idler.id, idle]]));
      if ((f + 1) % 60 === 0) {
        frames.push(JSON.stringify({ a: sim.players[0]!.character.pos, b: b.character.pos, v: sim.vehicles.map((v) => [v.id, v.pos.x, v.pos.y, v.pos.z]), c: sim.characters.map((c) => [c.id, c.pos.x, c.pos.y, c.pos.z]), w: sim.players.map((s) => s.wanted.level), e: log.length }));
      }
    }
    const moved = (s: PlayerSlot, from: { x: number; z: number }) => Math.hypot(s.character.pos.x - from.x, s.character.pos.z - from.z);
    return { frames, log, movedA: moved(sim.players[0]!, start.a), movedB: moved(b, start.b), walker: walker.id };
  }

  it('same seed, same inputs: identical sims, and slot 1 walks from its own input while slot 0 stands', () => {
    const one = run(false);
    const two = run(false);
    expect(one.frames).toEqual(two.frames);
    expect(one.log).toEqual(two.log);
    expect(one.frames.length).toBe(10);
    console.log(`[two-slot] slot 1 moved ${one.movedB.toFixed(1)} m, slot 0 moved ${one.movedA.toFixed(3)} m`);
    expect(one.movedB).toBeGreaterThan(15);
    expect(one.movedA).toBeLessThan(0.1);
  });

  it('with the inputs swapped, slot 0 moves and slot 1 stands', () => {
    const swapped = run(true);
    console.log(`[two-slot swapped] slot 0 moved ${swapped.movedA.toFixed(1)} m, slot 1 moved ${swapped.movedB.toFixed(3)} m`);
    expect(swapped.movedA).toBeGreaterThan(15);
    expect(swapped.movedB).toBeLessThan(0.1);
    expect(run(true).frames).toEqual(swapped.frames);
  });
});
