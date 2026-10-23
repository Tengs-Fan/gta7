// Wave 1 NPCs (VAL-NPC-001..005): witnesses who phone crimes in, and drivers who get out angry after a hard hit.

import { describe, expect, it } from 'vitest';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { CALL_MAX, CALL_MIN } from '../../src/sim/witnesses';
import { GIVE_UP } from '../../src/sim/angryDrivers';
import { aimAt, input, makeSim, placeInCar, step, teleport } from './helpers';

const FULL = process.env.W1_FULL === '1';

/** The player on foot on a stretch of road clear for 30 m ahead and 6 m to either side, facing along it. */
function openRoad(sim: Sim) {
  for (const lane of sim.roads.lanes) {
    if (lane.length < 60) continue;
    const x = lane.sx + lane.dx * 15;
    const z = lane.sz + lane.dz * 15;
    const rx = -Math.cos(lane.heading);
    const rz = Math.sin(lane.heading);
    let open = true;
    for (let a = -6; a <= 32 && open; a += 2) for (let l = -6; l <= 6 && open; l++) open = sim.world.isFree(x + lane.dx * a + rx * l, z + lane.dz * a + rz * l, 0.5) && sim.world.waterDepth(x + lane.dx * a, z + lane.dz * a) < -0.5;
    if (!open) continue;
    teleport(sim, x, z);
    sim.player.heading = lane.heading;
    return { x, z, h: lane.heading, fx: Math.sin(lane.heading), fz: Math.cos(lane.heading), rx, rz, lane };
  }
  throw new Error('no open road');
}

function civ(sim: Sim, x: number, z: number): Character {
  const c = sim.spawnCharacter('civilian', x, z);
  c.owner = 'ped';
  c.persistent = true;
  c.brain = sim.peds.makeGangBrain(x, z);
  c.brain.brave = false;
  c.brain.mode = 'idle';
  c.brain.modeTimer = 1e6;
  return c;
}

/** A witness scene: the player, a victim 1.2 m ahead and a witness 10 m off to the side; no police about. */
function scene(witnesses = 1) {
  const sim = makeSim({ ambient: false, police: true, streetCrime: true });
  const f = openRoad(sim);
  const victim = civ(sim, f.x + f.fx * 1.2, f.z + f.fz * 1.2);
  victim.heading = f.h + Math.PI;
  const ws = Array.from({ length: witnesses }, (_, k) => civ(sim, f.x + f.rx * (8 + k * 1.5) + f.fx * 2, f.z + f.rz * (8 + k * 1.5) + f.fz * 2));
  const levelAt: number[] = [];
  let last = 0;
  sim.events.on('wanted', (e) => {
    if (e.level > last) levelAt.push(sim.time);
    last = e.level;
  });
  return { sim, f, victim, ws, levelAt };
}

describe('VAL-NPC-001: witnesses phone in a crime after a delay', () => {
  it('a punch seen by a civilian only: no star at once, he takes out his phone, the star comes 2-10 s later', () => {
    const { sim, ws, levelAt } = scene();
    const t0 = sim.time;
    sim.combat.melee(sim.player);
    expect(sim.wanted.level).toBe(0);
    step(sim, 0.2);
    expect(ws[0]!.phoneTimer).toBeGreaterThan(0);
    expect(ws[0]!.brain!.mode).toBe('phone');
    expect(sim.wanted.level).toBe(0);
    step(sim, 12);
    expect(sim.wanted.level).toBe(1);
    const dt = levelAt[0]! - t0;
    console.log(`[witness] punch at ${t0.toFixed(2)} s, star at ${levelAt[0]!.toFixed(2)} s (+${dt.toFixed(2)} s)`);
    expect(dt).toBeGreaterThanOrEqual(2);
    expect(dt).toBeLessThanOrEqual(10);
    expect(CALL_MIN).toBeGreaterThanOrEqual(2);
    expect(CALL_MAX).toBeLessThanOrEqual(10);
    expect(ws[0]!.phoneTimer).toBe(0);
  });

  it('gunfire seen by a civilian is phoned in too', () => {
    const { sim, f, ws, levelAt } = scene();
    sim.player.inventory.give('pistol', 30);
    sim.player.inventory.current = 'pistol';
    const t0 = sim.time;
    const at = { x: f.x + f.fx * 15, y: sim.world.groundHeight(f.x + f.fx * 15, f.z + f.fz * 15), z: f.z + f.fz * 15 };
    step(sim, 1 / 60, aimAt(sim, at, { aim: true, fire: true, firePressed: true }));
    expect(sim.wanted.level).toBe(0);
    step(sim, 0.3);
    expect(ws[0]!.phoneTimer).toBeGreaterThan(0);
    step(sim, 12);
    expect(sim.wanted.level).toBe(1);
    expect(levelAt[0]! - t0).toBeGreaterThanOrEqual(2);
    expect(levelAt[0]! - t0).toBeLessThanOrEqual(10);
  });

  it('a crime a police officer sees raises the level at once, as before', () => {
    const { sim, f } = scene();
    const cop = sim.spawnCharacter('cop', f.x - f.fx * 6, f.z - f.fz * 6);
    cop.owner = 'mission';
    sim.combat.melee(sim.player);
    expect(sim.wanted.level).toBe(1);
  });
});

describe('VAL-NPC-002: stopping the witness prevents the call', () => {
  it('killing or knocking him down before the call gets through: no star; a later crime counts normally', () => {
    for (const how of ['kill', 'knock'] as const) {
      const { sim, f, ws } = scene();
      sim.combat.melee(sim.player);
      step(sim, 1);
      const w = ws[0]!;
      expect(w.phoneTimer).toBeGreaterThan(0);
      if (how === 'kill') sim.combat.damageCharacter(w, 1000, null, 'fall', 0, 0, 0);
      else {
        w.state = 'knocked';
        w.knockTimer = 2;
      }
      step(sim, 15);
      expect(sim.wanted.level, how).toBe(0);
      expect(sim.witnesses.log[0]!.state).toBe('lost');
      // A later crime in front of another witness counts.
      const w2 = civ(sim, sim.player.pos.x + f.rx * 9, sim.player.pos.z + f.rz * 9);
      void w2;
      const v2 = civ(sim, sim.player.pos.x + Math.sin(sim.player.heading) * 1.2, sim.player.pos.z + Math.cos(sim.player.heading) * 1.2);
      v2.heading = sim.player.heading + Math.PI;
      step(sim, 13);
      sim.combat.melee(sim.player);
      step(sim, 12);
      expect(sim.wanted.level, how).toBe(1);
    }
  });

  it('a witness who runs off out of the area still gets through', () => {
    const { sim, ws } = scene();
    sim.combat.melee(sim.player);
    step(sim, 0.5);
    const w = ws[0]!;
    sim.peds.flee(w, sim.player.pos.x, sim.player.pos.z, sim.player);
    step(sim, 12);
    expect(Math.hypot(w.pos.x - sim.player.pos.x, w.pos.z - sim.player.pos.z)).toBeGreaterThan(15);
    expect(sim.wanted.level).toBe(1);
  });

  it('several witnesses of the same crime raise the level once', () => {
    const { sim, levelAt } = scene(3);
    sim.combat.melee(sim.player);
    step(sim, 0.5);
    sim.combat.melee(sim.player);
    step(sim, 15);
    expect(sim.witnesses.log.length).toBe(1);
    expect(levelAt.length).toBe(1);
    expect(sim.wanted.level).toBe(1);
  });

  it('off (the default) no civilian calls', () => {
    const sim = makeSim({ ambient: false, police: true });
    const f = openRoad(sim);
    civ(sim, f.x + f.fx * 1.2, f.z + f.fz * 1.2).heading = f.h + Math.PI;
    civ(sim, f.x + f.rx * 8, f.z + f.rz * 8);
    sim.combat.melee(sim.player);
    step(sim, 12);
    expect(sim.wanted.level).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Angry drivers

/**
 * A civilian traffic car stopped on a lane and the player's sedan `gap` m behind it on the same lane, driving into it at
 * `closing` m/s. Returns once the hit has happened plus `after` s.
 */
function ram(seed: number, closing: number, kind: 'sedan' | 'police' | 'bus' = 'sedan', after = 6) {
  const sim = makeSim({ ambient: true, police: false, seed, streetCrime: true });
  sim.cheats.godMode = true;
  const lanes = sim.roads.lanes.filter((l) => l.length > 70 && (kind !== 'bus' || l.line.avenue));
  const lane = lanes[(seed * 7) % lanes.length]!;
  const tx = lane.sx + lane.dx * 50;
  const tz = lane.sz + lane.dz * 50;
  for (const v of sim.vehicles) if (!v.removed && Math.hypot(v.pos.x - tx, v.pos.z - tz) < 30) sim.removeVehicle(v);
  const target = sim.spawnVehicle(kind, tx, tz, lane.heading);
  target.owner = kind === 'police' ? 'police' : 'traffic';
  const driver = sim.addDriver(target, kind === 'police' ? 'cop' : 'civilian', 'traffic');
  driver.owner = target.owner;
  target.ai!.setLane(lane, 50);
  target.ai!.hold = true;
  const mine = sim.spawnVehicle('sedan', lane.sx + lane.dx * 30, lane.sz + lane.dz * 30, lane.heading);
  placeInCar(sim, mine);
  mine.vel.x = lane.dx * closing;
  mine.vel.z = lane.dz * closing;
  let hitAt = -1;
  let closingAtHit = 0;
  sim.events.on('impact', (e) => {
    if (hitAt < 0 && e.vehicle === target) {
      hitAt = sim.time;
      closingAtHit = closing;
    }
  });
  for (let i = 0; i < 60 * 6 && hitAt < 0; i++) {
    target.ai && (target.ai.hold = true);
    // Coast into it at the set speed.
    const sp = mine.vel.x * lane.dx + mine.vel.z * lane.dz;
    step(sim, 1 / 60, input({ throttle: sp < closing ? 1 : 0 }));
  }
  const t0 = sim.time;
  step(sim, after, input({ brake: 1 }));
  const outAt = driver.state !== 'inVehicle' ? sim.angryDrivers.log.find((l) => l.car === target.id)?.grievance?.outAt ?? -1 : -1;
  const g = sim.angryDrivers.log.find((l) => l.car === target.id);
  return { sim, target, driver, hitAt, closing: closingAtHit, out: driver.state !== 'inVehicle' && driver.vehicle === null, outWithin: outAt >= 0 ? outAt - hitAt : -1, fights: g?.fights ?? false, logged: !!g, t0 };
}

describe('VAL-NPC-004: drivers get out angry after a hard hit', () => {
  it('rams at 8+ m/s: a quarter or more get out within 5 s, some to fight and some to flee; gentle bumps never', () => {
    const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
    const rows: string[] = [];
    let out = 0;
    let fight = 0;
    let flee = 0;
    let hits = 0;
    for (const seed of seeds) {
      const r = ram(seed, 11);
      if (r.hitAt < 0) continue;
      hits++;
      const left = r.out && r.outWithin <= 5;
      if (left) {
        out++;
        if (r.driver.brain?.mode === 'fight' || r.fights) fight++;
        else flee++;
      }
      rows.push(`seed ${seed}: closing ${r.closing} m/s, out ${left ? `in ${r.outWithin.toFixed(1)} s, ${r.fights ? 'fights' : 'flees'}` : 'no'}`);
    }
    console.log(`[angry] ${hits} hard hits: ${out} got out (${fight} fight, ${flee} flee)\n` + rows.join('\n'));
    expect(hits).toBeGreaterThanOrEqual(18);
    expect(out / hits).toBeGreaterThanOrEqual(0.25);
    expect(fight).toBeGreaterThan(0);
    expect(flee).toBeGreaterThan(0);
    for (const seed of FULL ? seeds : seeds.slice(0, 8)) {
      const r = ram(seed, 2.2);
      expect(r.out, `gentle seed ${seed}`).toBe(false);
    }
  });

  it('police and bus drivers never get out angry', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const kind of ['police', 'bus'] as const) {
        const r = ram(seed, 12, kind);
        expect(r.out, `${kind} seed ${seed}`).toBe(false);
      }
    }
  });

  it('same seed, same outcome', () => {
    const a = ram(4, 11);
    const b = ram(4, 11);
    expect([b.out, b.fights, b.driver.pos.x, b.driver.pos.z]).toEqual([a.out, a.fights, a.driver.pos.x, a.driver.pos.z]);
  });
});

describe('VAL-NPC-005: angry-driver fights follow the existing combat and crime rules', () => {
  function fighter(): { r: ReturnType<typeof ram> } {
    for (let seed = 1; seed < 60; seed++) {
      const r = ram(seed, 11, 'sedan', 0.1);
      const g = r.sim.angryDrivers.log.find((l) => l.car === r.target.id);
      if (g?.out && g.fights) return { r };
    }
    throw new Error('no fighter');
  }

  it('he punches the player with his fists, which is no crime of the player; hitting back counts as usual', () => {
    const { r } = fighter();
    const { sim, driver } = r;
    const punches: number[] = [];
    sim.events.on('damage', (e) => {
      if (e.attacker === driver && e.victim === sim.player) punches.push(e.healthLoss);
    });
    // Out of the car and stand there.
    sim.cheats.godMode = false;
    sim.player.maxHealth = sim.player.health = 1000;
    if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
    for (let i = 0; i < 12 * 60 && punches.length === 0; i++) step(sim, 1 / 60, input({}));
    expect(driver.inventory.current).toBe('fists');
    expect(punches.length).toBeGreaterThan(0);
    expect(sim.wanted.level).toBe(0);
    // Hitting back in front of an officer is an assault, as ever.
    const cop = sim.spawnCharacter('cop', sim.player.pos.x + 5, sim.player.pos.z + 5);
    cop.owner = 'mission';
    sim.policeEnabled = true;
    sim.combat.damageCharacter(driver, 5, sim.player, 'melee', 1, 0, 0);
    expect(sim.wanted.lastCrime).toBe('assault');
    expect(sim.wanted.level).toBe(1);
  });

  it('once the player drives off past 40 m he stops chasing and goes back to his car or walks off', () => {
    const { r } = fighter();
    const { sim, driver, target } = r;
    step(sim, 1);
    expect(driver.brain!.mode).toBe('fight');
    // Drive off.
    const v = sim.player.vehicle!;
    const lane = sim.roads.nearestLane(v.pos.x, v.pos.z, v.heading).lane;
    v.pos.x -= lane.dx * (GIVE_UP + 25);
    v.pos.z -= lane.dz * (GIVE_UP + 25);
    v.vel.x = 0;
    v.vel.z = 0;
    step(sim, 14, input({ brake: 1 }));
    const g = sim.angryDrivers.log.find((l) => l.car === target.id)!.grievance!;
    expect(driver.brain?.mode === 'fight' && driver.brain.target === sim.player).toBe(false);
    expect(['drove', 'walked']).toContain(g.end);
    if (g.end === 'drove') {
      expect(target.driver).toBe(driver);
      expect(target.ai).not.toBeNull();
    }
    console.log(`[angry] after the player left: ${g.end}`);
  });
});

void (null as unknown as Vehicle);
