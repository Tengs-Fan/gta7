// Pursuit units that sit jammed: direct-mode units held up by traffic go back to the lanes, crews get out round
// a player sitting in a stopped car, and units wedged far away are replaced (library F3).

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import type { Lane } from '../../src/world/roads';
import { allFinite, input, makeSim, placeInCar, step } from './helpers';
import { at, getaway, longestLane } from './r2_police_helpers';

interface DirectPriv {
  direct: boolean;
}
const direct = (v: Vehicle) => (v.ai as unknown as DirectPriv).direct;

/** A lane of an avenue with a clear view along it, long enough for the scenarios. */
function openLane(sim: Sim): Lane {
  return longestLane(sim, true);
}

/** A police car with a cop at the wheel, chasing the player, standing on `lane` at `s`. */
function cruiser(sim: Sim, lane: Lane, s: number): Vehicle {
  const p = at(lane, s);
  const v = sim.spawnVehicle('police', p.x, p.z, lane.heading);
  v.owner = 'police';
  sim.addDriver(v, 'cop', 'chase');
  v.ai!.target = sim.player;
  v.ai!.setLane(lane, s);
  return v;
}

describe('direct pursuit held up by a vehicle (A)', () => {
  it('drops direct mode after more than 1.2 s blocked, keeps to the lanes for 4 s, then may go direct again', () => {
    const sim = makeSim({ police: false });
    const lane = openLane(sim);
    const target = at(lane, 80);
    const car = sim.spawnVehicle('sedan', target.x, target.z, lane.heading);
    placeInCar(sim, car);
    const b = at(lane, 50);
    sim.spawnVehicle('van', b.x, b.z, lane.heading);
    const unit = cruiser(sim, lane, 42);
    const log: Array<{ t: number; direct: boolean; blocked: boolean; x: number; z: number }> = [];
    step(sim, 12, (t) => {
      log.push({ t, direct: direct(unit), blocked: unit.ai!.limiter === 'obstacle' && Math.abs(unit.forwardSpeed) < 1, x: unit.pos.x, z: unit.pos.z });
      return input({ handbrake: true });
    });
    // (Each entry is the state after the previous frame.)
    const k = log.findIndex((e, i) => i > 0 && log[i - 1]!.direct && !e.direct);
    expect(k).toBeGreaterThan(0);
    const dropped = log[k]!.t;
    // The unbroken stretch it stood blocked in direct mode just before.
    let j = k - 1;
    while (j > 0 && log[j - 1]!.direct && log[j - 1]!.blocked) j--;
    const blockedFor = dropped - log[j]!.t;
    expect(blockedFor).toBeGreaterThan(1.18);
    expect(blockedFor).toBeLessThan(1.3);
    // Off for the 4 s after that, following the lanes: it backs up and pulls out past the van.
    const off = log.filter((e) => e.t > dropped && e.t < dropped + 3.95);
    expect(off.every((e) => !e.direct)).toBe(true);
    const moved = Math.max(...off.map((e) => Math.hypot(e.x - log[k]!.x, e.z - log[k]!.z)));
    expect(moved).toBeGreaterThan(5);
    // Afterwards, with the player in sight within 55 m, the sight check may switch it on again.
    expect(log.some((e) => e.t > dropped + 4 && e.direct)).toBe(true);
  });

  it('does not drop direct mode for brief stops: the blocked time decays while the way is clear', () => {
    const sim = makeSim({ police: false });
    const lane = openLane(sim);
    const target = at(lane, 80);
    const car = sim.spawnVehicle('sedan', target.x, target.z, lane.heading);
    placeInCar(sim, car);
    const b = at(lane, 50);
    const blocker = sim.spawnVehicle('van', b.x, b.z, lane.heading);
    const unit = cruiser(sim, lane, 42);
    // Held up for 1 s at a time, with the blocker out of the way for 1.5 s in between.
    let dropped = false;
    let wasDirect = false;
    step(sim, 9, (t) => {
      const phase = t % 2.5;
      const away = phase >= 1;
      blocker.pos.x = away ? b.x + 200 : b.x;
      blocker.pos.z = away ? b.z + 200 : b.z;
      if (away) {
        // Keep the unit where it is, as if the way opened only briefly.
        unit.vel.x = unit.vel.z = 0;
        const p = at(lane, 42);
        unit.pos.x = p.x;
        unit.pos.z = p.z;
      }
      if (direct(unit)) wasDirect = true;
      else if (wasDirect && !away && phase > 0.1) dropped = true;
      return input({ handbrake: true });
    });
    expect(wasDirect).toBe(true);
    expect(dropped).toBe(false);
  });
});

/** A cruiser chasing a player who sits in his stopped car `gap` m ahead along the avenue, with a van wedged in between. */
function stoppedPlayerScene(gap: number, level = 4): { sim: Sim; unit: Vehicle; crew: () => number } {
  const sim = makeSim({ police: true });
  sim.cheats.godMode = true;
  sim.missions.noBust = true;
  const lane = openLane(sim);
  const pp = at(lane, 30 + gap);
  const car = sim.spawnVehicle('sedan', pp.x, pp.z, lane.heading);
  placeInCar(sim, car);
  sim.wanted.setLevel(level);
  const unit = sim.police.spawnUnit('police', true)!;
  const u = at(lane, 30);
  unit.pos.x = u.x;
  unit.pos.z = u.z;
  unit.heading = lane.heading;
  unit.vel.x = unit.vel.z = 0;
  unit.ai!.setLane(lane, 30);
  return { sim, unit, crew: () => unit.occupants().filter((c) => c.isLaw).length };
}

describe('crews deploy round a player stopped in a car (B)', () => {
  // The unit is pinned in place (as if wedged in traffic) so only the stuck rule can send its crew.
  const pin = (sim: Sim, unit: Vehicle, x: number, z: number, h: number) => {
    unit.pos.x = x;
    unit.pos.z = z;
    unit.heading = h;
    unit.vel.x = unit.vel.z = 0;
    void sim;
  };

  it('a unit stuck over 2.5 s within 55 m of a player sitting still in his car sends its crew on foot', () => {
    const { sim, unit, crew } = stoppedPlayerScene(45);
    const x = unit.pos.x;
    const z = unit.pos.z;
    const h = unit.heading;
    const before = crew();
    expect(before).toBeGreaterThan(1);
    const partners = unit.passengers.filter((c) => c !== null);
    let outAt = -1;
    step(sim, 9, (t) => {
      if (outAt < 0) {
        // (The driver, 45 m back, walks back to the car under the usual rule.)
        if (partners.every((c) => c.state !== 'inVehicle')) outAt = t;
        else pin(sim, unit, x, z, h);
      }
      return input({ handbrake: true });
    });
    expect(outAt).toBeGreaterThan(2.5);
    expect(outAt).toBeLessThan(3.5);
    // Its other officers keep on at the player on foot (rather than walk back to a car 45 m behind him) and close in.
    const pp = sim.playerPos();
    for (const c of partners) {
      expect(c.state).toBe('normal');
      expect(c.brain!.mode).toBe('chase');
      expect(Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z)).toBeLessThan(35);
    }
  });

  it('counts a player rocking back and forth in a car boxed in as stopped', () => {
    const { sim, unit, crew } = stoppedPlayerScene(45);
    const x = unit.pos.x;
    const z = unit.pos.z;
    const h = unit.heading;
    const pv = sim.player.vehicle!;
    const home = { x: pv.pos.x, z: pv.pos.z };
    const before = crew();
    step(sim, 4, (t) => {
      pin(sim, unit, x, z, h);
      // Rocking 2 m either way at up to 5 m/s.
      const v = 5 * Math.cos(t * 2.5);
      pv.pos.x = home.x + Math.sin(pv.heading) * 2 * Math.sin(t * 2.5);
      pv.pos.z = home.z + Math.cos(pv.heading) * 2 * Math.sin(t * 2.5);
      pv.vel.x = Math.sin(pv.heading) * v;
      pv.vel.z = Math.cos(pv.heading) * v;
      return input({ handbrake: true });
    });
    expect(crew()).toBeLessThan(before);
  });

  it('keeps the crew seated when the unit is beyond 55 m, when the player keeps moving, or when the unit is not stuck', () => {
    // Beyond 55 m.
    {
      const { sim, unit, crew } = stoppedPlayerScene(70);
      const x = unit.pos.x;
      const z = unit.pos.z;
      const h = unit.heading;
      step(sim, 8, () => {
        pin(sim, unit, x, z, h);
        return input({ handbrake: true });
      });
      expect(crew()).toBeGreaterThan(0);
    }
    // Player creeping along at 2 m/s (not stopped).
    {
      const { sim, unit, crew } = stoppedPlayerScene(45);
      const x = unit.pos.x;
      const z = unit.pos.z;
      const h = unit.heading;
      const pv = sim.player.vehicle!;
      step(sim, 8, () => {
        pin(sim, unit, x, z, h);
        pv.vel.x = Math.sin(pv.heading) * 2;
        pv.vel.z = Math.cos(pv.heading) * 2;
        return input({ handbrake: true });
      });
      expect(crew()).toBeGreaterThan(0);
    }
    // Making progress: every 2 s it gets 6 m on (and is put back), so it never counts as stuck.
    {
      const { sim, unit, crew } = stoppedPlayerScene(45);
      const x = unit.pos.x;
      const z = unit.pos.z;
      const h = unit.heading;
      step(sim, 8, (t) => {
        const on = Math.floor(t / 2) % 2 === 1 ? 6 : 0;
        pin(sim, unit, x + Math.sin(h) * on, z + Math.cos(h) * on, h);
        return input({ handbrake: true });
      });
      expect(crew()).toBeGreaterThan(0);
    }
  });

  /** Every original crew member of `unit`, and whether each is still seated in it. */
  const seated = (unit: Vehicle) => {
    const crew = [...unit.occupants()];
    return { crew, all: () => crew.every((c) => c.state === 'inVehicle' && c.vehicle === unit) };
  };

  it('keeps every original crew member seated while the player drives steadily forward at 2 m/s', () => {
    // 40 m apart at first: driving on at 2 m/s, the player is about 45 m off by the time the unit counts as stuck.
    const { sim, unit } = stoppedPlayerScene(40);
    const x = unit.pos.x;
    const z = unit.pos.z;
    const h = unit.heading;
    const pv = sim.player.vehicle!;
    const fx = Math.sin(pv.heading);
    const fz = Math.cos(pv.heading);
    pv.vel.x = fx * 2;
    pv.vel.z = fz * 2;
    pv.speed = pv.forwardSpeed = 2;
    const start = { x: pv.pos.x, z: pv.pos.z };
    const { crew, all } = seated(unit);
    expect(crew.length).toBeGreaterThan(1);
    let deployed = false;
    let minSpeed = Infinity;
    let maxSpeed = -Infinity;
    let prev = 0;
    let minStep = Infinity;
    step(sim, 6, (t) => {
      pin(sim, unit, x, z, h);
      if (!all()) deployed = true;
      const along = (pv.pos.x - start.x) * fx + (pv.pos.z - start.z) * fz;
      if (t > 0) {
        minSpeed = Math.min(minSpeed, pv.speed);
        maxSpeed = Math.max(maxSpeed, pv.speed);
        minStep = Math.min(minStep, along - prev);
      }
      prev = along;
      // Real throttle input holding 2 m/s against rolling resistance; no writes to the car after the start.
      const throttle = (0.35 + 0.012 * pv.speed + 2 * (2 - pv.speed)) / (pv.spec.accel * (1 - (pv.speed / pv.spec.maxSpeed) ** 2));
      return input({ throttle, handbrake: false });
    });
    expect(minSpeed).toBeGreaterThan(1.9);
    expect(maxSpeed).toBeLessThan(2.1);
    expect(minStep).toBeGreaterThan(0);
    expect(unit.stuckTime).toBeGreaterThan(2.5);
    expect(Math.hypot(pv.pos.x - unit.pos.x, pv.pos.z - unit.pos.z)).toBeLessThan(55);
    expect(deployed).toBe(false);
    for (const c of crew) {
      expect(c.state).toBe('inVehicle');
      expect(c.vehicle).toBe(unit);
    }
  });

  it('still sends the crew out round a boxed-in player rocking back and forth at up to 5 m/s', () => {
    const { sim, unit } = stoppedPlayerScene(40);
    const x = unit.pos.x;
    const z = unit.pos.z;
    const h = unit.heading;
    const pv = sim.player.vehicle!;
    const home = { x: pv.pos.x, z: pv.pos.z };
    const { crew } = seated(unit);
    const passengers = crew.filter((c) => c !== unit.driver);
    expect(passengers.length).toBeGreaterThan(0);
    let outAt = -1;
    step(sim, 5, (t) => {
      pin(sim, unit, x, z, h);
      if (outAt < 0 && passengers.every((c) => c.state !== 'inVehicle')) outAt = t;
      const v = 5 * Math.cos(t * 2.5);
      pv.pos.x = home.x + Math.sin(pv.heading) * 2 * Math.sin(t * 2.5);
      pv.pos.z = home.z + Math.cos(pv.heading) * 2 * Math.sin(t * 2.5);
      pv.vel.x = Math.sin(pv.heading) * v;
      pv.vel.z = Math.cos(pv.heading) * v;
      return input({ handbrake: true });
    });
    expect(outAt).toBeGreaterThan(2.5);
    expect(outAt).toBeLessThan(4);
  });

  it('keeps the crew seated while the police search', () => {
    const { sim, unit, crew } = stoppedPlayerScene(45);
    const x = unit.pos.x;
    const z = unit.pos.z;
    const h = unit.heading;
    step(sim, 8, () => {
      sim.wanted.searching = true;
      pin(sim, unit, x, z, h);
      return input({ handbrake: true });
    });
    expect(crew()).toBeGreaterThan(0);
  });
});

describe('hopeless stuck units (C)', () => {
  /** The camera behind the player looking along +x (or at `look`), fixed, so what is in view does not change. */
  const camera = (sim: Sim, look?: { x: number; z: number }) => {
    const p = sim.playerPos();
    let dx = 1;
    let dz = 0;
    if (look) {
      const l = Math.hypot(look.x - p.x, look.z - p.z) || 1;
      dx = (look.x - p.x) / l;
      dz = (look.z - p.z) / l;
    }
    return input({ aimOrigin: { x: p.x - dx * 4, y: p.y + 2.5, z: p.z - dz * 4 }, aimDir: { x: dx, y: -0.02, z: dz }, cameraYaw: Math.atan2(dx, dz) });
  };

  /** A crewed unit on a lane about `d` m from the player, in view or out of it (with the camera as `camera` puts it). */
  function wedged(d: number, visible: boolean, tol = 8): { sim: Sim; unit: Vehicle; spot: { x: number; z: number; h: number } } {
    const sim = makeSim({ ambient: true, police: true, seed: 5 });
    sim.traffic.updateStreaming = () => {};
    sim.peds.updateStreaming = () => {};
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.wanted.setLevel(3);
    // Let the sim take the camera pose.
    step(sim, 0.1, () => camera(sim));
    const p = sim.player.pos;
    for (const lane of sim.roads.lanes) {
      for (const s of [lane.length / 2, lane.length / 4, (3 * lane.length) / 4]) {
        const pt = at(lane, s);
        const dd = Math.hypot(pt.x - p.x, pt.z - p.z);
        if (Math.abs(dd - d) > tol || sim.isVisible(pt.x, 1, pt.z) !== visible || !sim.traffic.isClear(pt.x, pt.z, 9)) continue;
        const unit = sim.police.spawnUnit('police', true);
        if (!unit) continue;
        unit.pos.x = pt.x;
        unit.pos.z = pt.z;
        unit.heading = lane.heading;
        unit.ai!.setLane(lane, s);
        return { sim, unit, spot: { x: pt.x, z: pt.z, h: lane.heading } };
      }
    }
    throw new Error('no spot');
  }

  /** Steps with the unit pinned where it is (wedged: it tries to drive on but makes no progress). */
  const pinned = (sim: Sim, unit: Vehicle, spot: { x: number; z: number; h: number }, seconds: number, look?: { x: number; z: number }) =>
    step(sim, seconds, () => {
      if (!unit.removed) {
        unit.pos.x = spot.x;
        unit.pos.z = spot.z;
        unit.heading = spot.h;
        unit.vel.x = unit.vel.z = 0;
      }
      return camera(sim, look);
    });

  it('removes a unit stuck over 12 s, more than 60 m away and out of view; dispatch sends another', () => {
    const { sim, unit, spot } = wedged(90, false);
    const crew = unit.occupants().filter((c) => c.isLaw);
    // One of its officers stands outside, still assigned to it.
    const walker = crew[crew.length - 1]!;
    sim.unseat(walker);
    walker.state = 'normal';
    walker.brain!.car = unit;
    pinned(sim, unit, spot, 11);
    expect(unit.removed).toBe(false);
    expect(unit.stuckTime).toBeGreaterThan(10);
    pinned(sim, unit, spot, 3);
    expect(unit.removed).toBe(true);
    expect(walker.brain!.car).toBeNull();
    // Dispatch (which only runs with ambient life) fills the slot while the police still have him in sight.
    const before = new Set(sim.vehicles.map((v) => v.id));
    let sent = false;
    step(sim, 12, () => {
      sim.wanted.lastSeen = sim.time;
      if (sim.vehicles.some((v) => !v.removed && !before.has(v.id) && v.owner === 'police' && v.driver?.isLaw)) sent = true;
      return camera(sim);
    });
    expect(sent).toBe(true);
    expect(allFinite(sim)).toBe(true);
  });

  it("never removes a visible unit, one within 60 m, or the player's own cruiser", () => {
    {
      const { sim, unit, spot } = wedged(90, true);
      pinned(sim, unit, spot, 16, spot);
      expect(unit.stuckTime).toBeGreaterThan(12);
      expect(sim.isVisible(unit.pos.x, unit.pos.y, unit.pos.z)).toBe(true);
      expect(unit.removed).toBe(false);
    }
    {
      // (Beyond the 55 m at which a unit stuck near a player on foot sends its crew out.)
      const { sim, unit, spot } = wedged(58, false, 2);
      pinned(sim, unit, spot, 16);
      expect(unit.stuckTime).toBeGreaterThan(12);
      expect(unit.removed).toBe(false);
    }
    {
      // A cruiser the player took and sits in, out of view and stuck.
      const sim = makeSim({ police: true });
      sim.wanted.setLevel(3);
      const lane = openLane(sim);
      const p = at(lane, 40);
      const v = sim.spawnVehicle('police', p.x, p.z, lane.heading);
      v.owner = 'police';
      placeInCar(sim, v);
      step(sim, 3, () => {
        v.stuckTime = 20;
        return input({ handbrake: true });
      });
      expect(v.removed).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Reduced-seed pursuit measurement (the full one is 20 seeds x 180 s: research/gameplay/police.measure.ts).

interface Jam {
  stuck: number;
  unitSec: number;
  worst: number;
  near60: number;
  samples: number;
}

function chase(level: number, seed: number, seconds: number): Jam {
  const sim = makeSim({ ambient: true, seed });
  sim.cheats.godMode = true;
  sim.missions.noBust = true;
  const { bot } = getaway(sim, seed);
  sim.wanted.setLevel(level);
  const r: Jam = { stuck: 0, unitSec: 0, worst: 0, near60: 0, samples: 0 };
  const dt = 1 / 60;
  const frames = Math.round(seconds / dt);
  for (let f = 0; f < frames; f++) {
    if (sim.wanted.level < level) sim.wanted.setLevel(level);
    step(sim, dt, bot(dt));
    if (f % 30 !== 0) continue;
    r.samples++;
    const pp = sim.playerPos();
    let near = false;
    for (const v of sim.vehicles) {
      if (v.removed || v.owner !== 'police' || !v.ai || !v.driver?.isLaw || !v.drivable) continue;
      const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
      if (d < 60) near = true;
      if (d > 200) continue;
      r.unitSec += 0.5;
      if (v.stuckTime > 5) r.stuck += 0.5;
      r.worst = Math.max(r.worst, v.stuckTime);
    }
    if (near) r.near60++;
  }
  return r;
}

describe('5-star pursuit jams (reduced measurement)', () => {
  it('keeps the stuck share low and no unit stuck for long, with units still close to the player', () => {
    // Seeds that jammed worst before the fix (baseline: 21-28% stuck, worst 89-120 s over 20 seeds).
    const runs = [1, 4, 7, 15].map((s) => chase(5, s, 120));
    const sum = (k: keyof Jam) => runs.reduce((a, r) => a + r[k], 0);
    const share = sum('stuck') / sum('unitSec');
    const worst = Math.max(...runs.map((r) => r.worst));
    const near = sum('near60') / sum('samples');
    console.log(`[police_unjam] 5* x${runs.length} x 120 s: stuck>5s ${(100 * share).toFixed(1)}%, worst ${worst.toFixed(0)} s, unit within 60 m ${(100 * near).toFixed(0)}%`);
    expect(share).toBeLessThan(0.08);
    expect(worst).toBeLessThan(40);
    expect(near).toBeGreaterThan(0.4);
  }, 120_000);
});
