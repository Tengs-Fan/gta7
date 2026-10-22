// Combat feel: NPC shooters hold the raised-gun aim between shots (no snap at the shot), lying bodies are hit along
// their drawn length (legs and hips, torso and head), and characters climbing into a car can be hit.

import { describe, expect, it, vi } from 'vitest';
import { rayCapsule } from '../../src/core/collision';
import type { V3 } from '../../src/core/math';
import { wrapAngle } from '../../src/core/math';
import { makeBrain } from '../../src/sim/brains';
import type { Character } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import { WEAPONS, type WeaponId } from '../../src/sim/specs';
import { input, makeSim, placeInCar, step, teleport } from './helpers';
import { internals, placeOnFoot } from './r2_police_helpers';

const DT = 1 / 60;
const DEG = 180 / Math.PI;

function openRoad(sim: Sim): { x: number; z: number; h: number } {
  for (const pr of sim.world.grid.colliders) if (pr.breakable || pr.tag === 'tree') pr.broken = true;
  for (const lane of sim.roads.lanes) {
    if (lane.length < 60) continue;
    const s = lane.length / 2;
    const x = lane.sx + lane.dx * s;
    const z = lane.sz + lane.dz * s;
    const rx = -Math.cos(lane.heading);
    const rz = Math.sin(lane.heading);
    let open = true;
    for (let a = -10; a <= 24 && open; a++) for (let l = -4; l <= 4 && open; l++) open = sim.world.isFree(x + lane.dx * a + rx * l, z + lane.dz * a + rz * l, 0.5);
    if (open) return { x, z, h: lane.heading };
  }
  throw new Error('no open road');
}

function stand(sim: Sim) {
  const r = openRoad(sim);
  teleport(sim, r.x, r.z);
  sim.player.heading = r.h;
  return { h: r.h, fx: Math.sin(r.h), fz: Math.cos(r.h), rx: -Math.cos(r.h), rz: Math.sin(r.h) };
}

/** The aimed shoulder camera (2.4 m back, 0.62 m right) looking along yaw and pitch. */
function shoulderAim(sim: Sim, yaw: number, pitch: number, over: Partial<PlayerInput> = {}): PlayerInput {
  const p = sim.player;
  const vx = Math.sin(yaw) * Math.cos(pitch);
  const vy = Math.sin(pitch);
  const vz = Math.cos(yaw) * Math.cos(pitch);
  const headY = p.pos.y + 1.58 * p.appearance.height;
  const ox = p.pos.x - vx * 2.4 - Math.cos(yaw) * 0.62;
  const oz = p.pos.z - vz * 2.4 + Math.sin(yaw) * 0.62;
  const o = { x: ox, y: Math.max(headY - vy * 2.4 + 0.18, sim.world.groundHeight(ox, oz) + 0.35), z: oz };
  return input({ aimOrigin: o, aimDir: { x: vx, y: vy, z: vz }, cameraYaw: yaw, aim: true, ...over });
}

/** The shoulder camera turned so that its crosshair ray runs through `target`. */
function crosshairOn(sim: Sim, target: V3, over: Partial<PlayerInput> = {}): PlayerInput {
  let yaw = Math.atan2(target.x - sim.player.pos.x, target.z - sim.player.pos.z);
  let pitch = 0;
  for (let i = 0; i < 80; i++) {
    const o = shoulderAim(sim, yaw, pitch).aimOrigin;
    yaw = Math.atan2(target.x - o.x, target.z - o.z);
    pitch = Math.atan2(target.y - o.y, Math.hypot(target.x - o.x, target.z - o.z));
  }
  return shoulderAim(sim, yaw, pitch, over);
}

function record<K extends keyof SimEvents>(sim: Sim, type: K): Array<SimEvents[K]> {
  const out: Array<SimEvents[K]> = [];
  sim.events.on(type, (e) => out.push(e));
  return out;
}

type Raise = { raiseGun(c: Character, x: number, y: number, z: number): unknown };
const raiser = (sim: Sim) => sim.combat as unknown as Raise;

/** Where an NPC's shot at `t` is aimed (as npcFire aims it): his car's roof line, or his chest. */
function aimPoint(t: Character): V3 {
  const tp = t.vehicle ? t.vehicle.pos : t.pos;
  return { x: tp.x, y: t.vehicle ? tp.y + 0.9 : tp.y + t.height * 0.62, z: tp.z };
}

/** How far (rad) the raised gun's yaw is from where raiseGun would put it now, for `t`'s current aim point. */
function raiseError(sim: Sim, c: Character, t: Character): number {
  const yaw = c.aimYaw;
  const pitch = c.aimPitch;
  const q = aimPoint(t);
  raiser(sim).raiseGun(c, q.x, q.y, q.z);
  const want = c.aimYaw;
  c.aimYaw = yaw;
  c.aimPitch = pitch;
  return Math.abs(wrapAngle(want - yaw));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

// ---------------------------------------------------------------------------
// Gun pose

describe('NPC shooters hold the raised gun at the target between shots', () => {
  function gangShooter(sim: Sim, weapon: WeaponId, x: number, z: number, target: Character): Character {
    const e = sim.spawnCharacter('gang', x, z);
    e.owner = 'mission';
    e.persistent = true;
    e.inventory.give(weapon, 9999);
    e.inventory.current = weapon;
    const b = makeBrain('fight');
    b.target = target;
    b.hostile = true;
    b.modeTimer = 999;
    b.accuracy = 1;
    e.brain = b;
    return e;
  }

  /** Per-shot yaw snaps (deg) of a shooter: his aim yaw on the frame of each shot against the frame before. */
  function snaps(sim: Sim, shooter: Character, seconds: number): number[] {
    let prev = NaN;
    const out: number[] = [];
    sim.events.on('weaponFired', (ev) => {
      if (ev.shooter === shooter && Number.isFinite(prev)) out.push(Math.abs(wrapAngle(shooter.aimYaw - prev)) * DEG);
    });
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      prev = shooter.aimYaw;
      sim.update(DT, input());
    }
    // The first shot raises the gun from wherever it was.
    return out.slice(1);
  }

  it('gang shooters: the median and largest snap at a shot are at most 0.5 deg for every gun at 1.2 to 12 m', () => {
    const rows: string[] = [];
    for (const weapon of ['smg', 'rifle', 'shotgun', 'pistol'] as WeaponId[]) {
      for (const dist of [1.2, 2, 3.5, 6, 12]) {
        const sim = makeSim({ police: false });
        sim.cheats.godMode = true;
        const f = stand(sim);
        const p = sim.player;
        const e = gangShooter(sim, weapon, p.pos.x + f.fx * dist, p.pos.z + f.fz * dist, p);
        e.heading = f.h + Math.PI;
        // Baseline before the fix: 11.3 deg median snap for the long guns at 1.2 m, 2.9 deg for the pistol.
        const deg = snaps(sim, e, weapon === 'shotgun' ? 4 : 2.5);
        rows.push(`${weapon} @${dist} m: ${deg.length} shots, median ${median(deg).toFixed(2)} max ${Math.max(...deg).toFixed(2)} deg`);
        expect(deg.length, `${weapon} @${dist}`).toBeGreaterThan(0);
        expect(median(deg), `${weapon} @${dist}`).toBeLessThanOrEqual(0.5);
        expect(Math.max(...deg), `${weapon} @${dist}`).toBeLessThanOrEqual(0.5);
      }
    }
    console.log(`[npcPose]\n${rows.join('\n')}`);
  });

  it('police shooters on foot: no snap at the shot either', () => {
    for (const weapon of ['pistol', 'smg', 'shotgun'] as WeaponId[]) {
      for (const dist of [2, 6]) {
        const sim = makeSim();
        sim.cheats.godMode = true;
        sim.missions.noBust = true;
        const f = stand(sim);
        const p = sim.player;
        const cop = sim.spawnCharacter('cop', p.pos.x + f.fx * dist, p.pos.z + f.fz * dist);
        internals(sim).equip(cop, null);
        placeOnFoot(sim, cop, p.pos.x + f.fx * dist, p.pos.z + f.fz * dist);
        cop.inventory.give(weapon, 9999);
        cop.inventory.current = weapon;
        cop.inventory.infinite = true;
        cop.heading = f.h + Math.PI;
        sim.wanted.setLevel(3);
        const deg = snaps(sim, cop, 3);
        expect(deg.length, `${weapon} @${dist}`).toBeGreaterThan(0);
        expect(Math.max(...deg), `${weapon} @${dist}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('the raised gun follows a target walking across, and a car driving across, every frame', () => {
    for (const inCar of [false, true]) {
      const sim = makeSim({ police: false });
      sim.cheats.godMode = true;
      const f = stand(sim);
      const p = sim.player;
      const car = inCar ? sim.spawnVehicle('sedan', p.pos.x, p.pos.z, f.h + Math.PI / 2) : null;
      if (car) placeInCar(sim, car);
      const e = gangShooter(sim, 'smg', p.pos.x + f.fx * 6, p.pos.z + f.fz * 6, p);
      e.heading = f.h + Math.PI;
      const start = { x: sim.playerPos().x, z: sim.playerPos().z };
      let worst = 0;
      let raised = 0;
      for (let i = 0; i < 150; i++) {
        // 1.5 m/s across the shooter's line of fire, moved before each frame so the frame aims at where he is.
        teleport(sim, start.x + f.rx * 1.5 * i * DT, start.z + f.rz * 1.5 * i * DT);
        if (car) car.heading = f.h + Math.PI / 2;
        sim.update(DT, input());
        if (i < 30 || !e.aiming) continue;
        raised++;
        worst = Math.max(worst, raiseError(sim, e, p));
      }
      expect(raised, inCar ? 'car' : 'on foot').toBeGreaterThan(100);
      expect(worst * DEG, inCar ? 'car' : 'on foot').toBeLessThanOrEqual(0.5);
    }
  });

  it('a still shooter and target do not re-raise the gun every frame; moving 2 cm or a weapon change does', () => {
    const sim = makeSim({ police: false });
    sim.cheats.godMode = true;
    const f = stand(sim);
    const p = sim.player;
    const e = gangShooter(sim, 'pistol', p.pos.x + f.fx * 5, p.pos.z + f.fz * 5, p);
    e.heading = f.h + Math.PI;
    step(sim, 1);
    const spy = vi.spyOn(raiser(sim), 'raiseGun');
    const fired = record(sim, 'weaponFired');
    step(sim, 1);
    // npcFire raises the gun for each shot (at once settled); nothing else does while neither moves.
    const shots = fired.filter((ev) => ev.shooter === e).length;
    expect(shots).toBeGreaterThan(0);
    expect(spy.mock.calls.filter((c) => c[0] === e).length).toBe(shots);
    spy.mockClear();
    fired.length = 0;
    teleport(sim, p.pos.x + f.rx * 0.03, p.pos.z + f.rz * 0.03);
    sim.update(DT, input());
    expect(spy.mock.calls.filter((c) => c[0] === e).length).toBeGreaterThan(fired.length);
    spy.mockClear();
    fired.length = 0;
    e.inventory.give('smg', 999);
    e.inventory.current = 'smg';
    step(sim, 0.3);
    expect(spy.mock.calls.filter((c) => c[0] === e).length).toBeGreaterThan(fired.filter((ev) => ev.shooter === e).length);
    spy.mockRestore();
  });

  it('a brawler with fists does not raise anything', () => {
    const sim = makeSim({ police: false });
    sim.cheats.godMode = true;
    const f = stand(sim);
    const p = sim.player;
    const e = gangShooter(sim, 'fists', p.pos.x + f.fx * 4, p.pos.z + f.fz * 4, p);
    const spy = vi.spyOn(raiser(sim), 'raiseGun');
    for (let i = 0; i < 90; i++) {
      sim.update(DT, input());
      expect(e.aiming).toBe(false);
    }
    expect(spy.mock.calls.filter((c) => c[0] === e).length).toBe(0);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Downed bodies

describe('rayCapsule', () => {
  it('hits the side, the end caps and passes beside; inside is 0; distances are in direction units', () => {
    // Capsule along x from 0 to 2 at y = 0, radius 0.5.
    const cap = [0, 0, 0, 2, 0, 0, 0.5] as const;
    expect(rayCapsule(1, 5, 0, 0, -1, 0, ...cap, 10)).toBeCloseTo(4.5, 9);
    expect(rayCapsule(1, 5, 0, 0, -2, 0, ...cap, 10)).toBeCloseTo(2.25, 9);
    expect(rayCapsule(-5, 0, 0, 1, 0, 0, ...cap, 10)).toBeCloseTo(4.5, 9);
    expect(rayCapsule(7, 0, 0, -1, 0, 0, ...cap, 10)).toBeCloseTo(4.5, 9);
    expect(rayCapsule(1, 5, 0.6, 0, -1, 0, ...cap, 10)).toBe(-1);
    expect(rayCapsule(1, 5, 0, 0, -1, 0, ...cap, 4)).toBe(-1);
    expect(rayCapsule(1, 0.2, 0, 0, 1, 0, ...cap, 10)).toBe(0);
    // Diagonally onto the cap at A.
    const d = Math.SQRT1_2;
    expect(rayCapsule(-3, 3, 0, d, -d, 0, ...cap, 10)).toBeCloseTo(Math.hypot(3, 3) - 0.5, 9);
  });
});

describe('a body on the ground is hit along its drawn length', () => {
  /** A gang member lying `dist` m in front of the player, his heading turned by `turn` from the player's. */
  function lying(state: 'knocked' | 'dead', dist: number, turn: number) {
    const sim = makeSim({ police: false });
    const f = stand(sim);
    const p = sim.player;
    p.inventory.give('pistol', 500);
    p.inventory.current = 'pistol';
    const e = sim.spawnCharacter('gang', p.pos.x + f.fx * dist, p.pos.z + f.fz * dist);
    e.owner = 'mission';
    e.persistent = true;
    e.armor = 1e6;
    e.heading = f.h + turn;
    e.state = state;
    e.knockTimer = 60;
    return { sim, p, e, f };
  }

  /** One aimed pistol shot at a point `along` m along the body's heading and `aside` m to its right, `y` m up. */
  function shootAt(state: 'knocked' | 'dead', dist: number, turn: number, along: number, aside = 0, y = 0.2) {
    const { sim, p, e } = lying(state, dist, turn);
    const tgt = () => ({
      x: e.pos.x + Math.sin(e.heading) * along - Math.cos(e.heading) * aside,
      y: e.pos.y + y,
      z: e.pos.z + Math.cos(e.heading) * along + Math.sin(e.heading) * aside,
    });
    step(sim, 0.2, () => crosshairOn(sim, tgt()));
    const shots = record(sim, 'shot');
    const damage = record(sim, 'damage');
    sim.update(DT, crosshairOn(sim, tgt(), { fire: true, firePressed: true }));
    const mine = shots.filter((s) => s.shooter === p);
    const hit = damage.find((d) => d.victim === e && d.attacker === p);
    // The dead take no damage (no damage event): the zone the round's own ray finds.
    let zone = hit?.zone ?? null;
    const s0 = mine[0];
    if (!zone && s0 && s0.hit === 'flesh') {
      const l = Math.hypot(s0.tx - s0.fx, s0.ty - s0.fy, s0.tz - s0.fz);
      const r = sim.combat.castRay(s0.fx, s0.fy, s0.fz, (s0.tx - s0.fx) / l, (s0.ty - s0.fy) / l, (s0.tz - s0.fz) / l, l + 0.5, p);
      if (r.character === e) zone = r.zone;
    }
    return { flesh: mine.filter((s) => s.hit === 'flesh').length, shots: mine.length, zone, loss: hit ? hit.armourLoss + hit.healthLoss : 0 };
  }

  const parts = { head: -1.35, shoulders: -1.05, chest: -0.8, hips: -0.5, knees: 0, feet: 0.4 } as const;

  it.each(['knocked', 'dead'] as const)('%s: head, shoulders, chest, hips, knees and feet are hit 12/12 (3 ranges x 4 headings)', (state) => {
    const rows: string[] = [];
    for (const [name, along] of Object.entries(parts)) {
      let hits = 0;
      let n = 0;
      for (const dist of [2.5, 4, 6]) {
        for (const turn of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          const r = shootAt(state, dist, turn, along);
          n += r.shots;
          hits += r.flesh;
        }
      }
      rows.push(`${state} ${name} (${along} m): ${hits}/${n}`);
      // Baseline before the fix: head 3/12, shoulders 4/12, chest 5/12.
      expect(hits, `${state} ${name}`).toBe(12);
      expect(n).toBe(12);
    }
    console.log(`[downed]\n${rows.join('\n')}`);
  });

  it.each(['knocked', 'dead'] as const)('%s: the head end is the head zone, the torso and the hips are the body, and a head hit hurts at least as much', (state) => {
    // Seen from the side (the line of fire across the body) and from the head end; from the feet end, at a low angle,
    // the chest is in the way of the head.
    for (const turn of [0, Math.PI / 2, -Math.PI / 2]) {
      const head = shootAt(state, 4, turn, -1.35);
      expect(head.zone, `turn ${turn}`).toBe('head');
      if (state === 'knocked') expect(head.loss).toBe(WEAPONS.pistol.damage * WEAPONS.pistol.headMul);
    }
    for (const turn of [Math.PI / 2, -Math.PI / 2]) {
      const head = shootAt(state, 4, turn, -1.35);
      for (const along of [-0.6, -0.8, -1.1, -0.5, 0]) {
        const r = shootAt(state, 4, turn, along);
        expect(r.zone, `turn ${turn} along ${along}`).toBe('body');
        expect(head.loss).toBeGreaterThanOrEqual(r.loss);
      }
    }
  });

  it.each(['knocked', 'dead'] as const)('%s: shots beside the body or beyond its head end miss it', (state) => {
    // At the ground 0.8 m to either side of the body seen lengthways, and beyond its head end seen from the side.
    const cases: Array<[number, number, number]> = [];
    for (const turn of [0, Math.PI]) for (const [along, aside] of [[-0.8, 0.8], [-0.8, -0.8], [0, 0.8], [0.3, -0.8], [-1.35, 0.8], [-1.35, -0.85]]) cases.push([turn, along!, aside!]);
    for (const turn of [Math.PI / 2, -Math.PI / 2]) for (const along of [-2, -2.1]) cases.push([turn, along, 0]);
    for (const [turn, along, aside] of cases) {
      const r = shootAt(state, 4, turn, along, aside, 0.02);
      expect(r.shots).toBe(1);
      expect(r.flesh, `turn ${turn} along ${along} aside ${aside}`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Getting into a car

describe('characters climbing into a car can be hit', () => {
  /** The player one step from the driver's door of a parked sedan (with a driver to pull out when `jack`), starting to get in. */
  function boarding(jack: boolean) {
    const sim = makeSim({ police: false });
    const r = openRoad(sim);
    const car = sim.spawnVehicle('sedan', r.x, r.z, r.h);
    let driver: Character | null = null;
    if (jack) {
      driver = sim.spawnCharacter('civilian', r.x, r.z);
      sim.seat(driver, car, 0);
    }
    const c = Math.cos(car.heading);
    const s = Math.sin(car.heading);
    const lx = car.halfW + 1.6;
    teleport(sim, car.pos.x + lx * c + 0.35 * s, car.pos.z - lx * s + 0.35 * c);
    sim.update(DT, input({ enterExit: true }));
    expect(sim.player.state).toBe('entering');
    // A gunman 6 m off the far side of the player.
    const g = sim.spawnCharacter('gang', car.pos.x + (lx + 6) * c, car.pos.z - (lx + 6) * s);
    g.owner = 'mission';
    g.persistent = true;
    g.inventory.give('pistol', 99);
    g.inventory.current = 'pistol';
    g.heading = Math.atan2(sim.player.pos.x - g.pos.x, sim.player.pos.z - g.pos.z);
    return { sim, car, driver, gunman: g };
  }

  /** Steps until the player is no longer climbing in (at most 2 s). */
  function settle(sim: Sim): void {
    for (let i = 0; i < 120 && sim.player.state === 'entering'; i++) sim.update(DT, input());
    step(sim, 0.2);
  }

  it.each([false, true])('a shot at the player mid-entry (carjack: %s) is a flesh hit that hurts, and he still gets in', (jack) => {
    const { sim, car, gunman } = boarding(jack);
    const p = sim.player;
    if (jack) step(sim, 0.3);
    expect(p.state).toBe('entering');
    const hp = p.health + p.armor;
    const shots = record(sim, 'shot');
    sim.combat.npcFire(gunman, p, 1);
    expect(shots.filter((s) => s.shooter === gunman).map((s) => s.hit)).toEqual(['flesh']);
    expect(p.health + p.armor).toBeLessThan(hp);
    settle(sim);
    expect(p.state).toBe('inVehicle');
    expect(p.vehicle).toBe(car);
    expect(car.driver).toBe(p);
    expect(p.enterTarget).toBeNull();
    for (const c of sim.characters) if (c !== p) expect(c.vehicle === car && c.seat === 0).toBe(false);
  });

  it('the crosshair and a player bullet find an NPC in the entering state, and a lethal hit leaves him dead on the ground outside', () => {
    const sim = makeSim({ police: false });
    const f = stand(sim);
    const p = sim.player;
    p.inventory.give('pistol', 99);
    p.inventory.current = 'pistol';
    const car = sim.spawnVehicle('sedan', p.pos.x + f.fx * 8 + f.rx * 3, p.pos.z + f.fz * 8 + f.rz * 3, f.h);
    const e = sim.spawnCharacter('gang', p.pos.x + f.fx * 6, p.pos.z + f.fz * 6);
    e.owner = 'mission';
    e.persistent = true;
    e.state = 'entering';
    e.enterTarget = car;
    const tgt = () => ({ x: e.pos.x, y: e.pos.y + e.height * 0.7, z: e.pos.z });
    e.health = 1;
    e.armor = 0;
    const shots = record(sim, 'shot');
    sim.update(DT, crosshairOn(sim, tgt(), { fire: true, firePressed: true }));
    expect(shots.filter((s) => s.shooter === p).map((s) => s.hit)).toEqual(['flesh']);
    expect(e.alive).toBe(false);
    expect(e.state).toBe('dead');
    expect(e.vehicle).toBeNull();
    expect(car.driver).toBeNull();
    step(sim, 0.5);
    expect(Math.abs(e.pos.y - sim.world.groundHeight(e.pos.x, e.pos.z))).toBeLessThan(0.05);
  });

  it('a lethal shot mid-entry leaves the player dead outside the car, WASTED runs, and the car is free for others', () => {
    const { sim, car, gunman } = boarding(false);
    const p = sim.player;
    p.health = 1;
    p.armor = 0;
    const wasted = record(sim, 'wasted');
    sim.combat.npcFire(gunman, p, 1);
    expect(p.alive).toBe(false);
    step(sim, 0.5);
    expect(p.state).toBe('dead');
    expect(p.vehicle).toBeNull();
    expect(p.enterTarget).toBeNull();
    expect(car.driver).toBeNull();
    expect(car.passengers.every((o) => o === null)).toBe(true);
    expect(wasted.length).toBe(1);
    expect(car.ai?.hold ?? false).toBe(false);
    // Somebody else can still get in and drive it off.
    const other = sim.spawnCharacter('civilian', car.pos.x, car.pos.z);
    sim.seat(other, car, 0);
    expect(car.driver).toBe(other);
  });

  it('a car driven into the player while he climbs into another one knocks him down and the entry is dropped', () => {
    const { sim, car } = boarding(false);
    const p = sim.player;
    const h = car.heading;
    // Another car coming up alongside the parked one, fast, straight at him.
    const from = { x: p.pos.x - Math.sin(h) * 4, z: p.pos.z - Math.cos(h) * 4 };
    const van = sim.spawnVehicle('sedan', from.x, from.z, h);
    van.vel.x = Math.sin(h) * 8;
    van.vel.z = Math.cos(h) * 8;
    van.speed = 8;
    const hp = p.health + p.armor;
    let knocked = false;
    for (let i = 0; i < 60; i++) {
      van.vel.x = Math.sin(h) * 8;
      van.vel.z = Math.cos(h) * 8;
      sim.update(DT, input());
      if (p.state === 'knocked') knocked = true;
      if (knocked) break;
    }
    expect(knocked).toBe(true);
    expect(p.health + p.armor).toBeLessThan(hp);
    step(sim, 0.1);
    expect(p.enterTarget).toBeNull();
    expect(p.vehicle).toBeNull();
    expect(car.driver).toBeNull();
  });
});
