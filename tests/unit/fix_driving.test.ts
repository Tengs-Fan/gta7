import { describe, expect, it } from 'vitest';
import { throughAvenues, type DriverPolicy } from '../../src/sim/driver';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { axisOf, reverseDir, SIGNAL_CYCLE, SIGNAL_GREEN, SIGNAL_HALF, SIGNAL_YELLOW, type Lane } from '../../src/world/roads';
import { input, makeSim, placeInCar, step, teleport } from './helpers';

/** A one-lane street lane of 80 m or more ending at a signalled four-way junction. */
function streetLane(sim: Sim): Lane {
  return sim.roads.lanes.find((l) => !l.line.avenue && l.length >= 80 && sim.roads.nodes[l.to]!.signal && sim.roads.nodes[l.to]!.degree === 4)!;
}

/** The lane running the other way on the same stretch of road. */
function oppositeLane(sim: Sim, lane: Lane): Lane {
  return sim.roads.lanes.find((l) => l.from === lane.to && l.to === lane.from)!;
}

function signalsOff(sim: Sim): void {
  for (const n of sim.roads.nodes) n.signal = false;
}

/** Turns the signal at the end of `lane` red for its next 18 s. */
function holdRed(sim: Sim, lane: Lane): void {
  const redStart = SIGNAL_GREEN + SIGNAL_YELLOW + (axisOf(lane.dir) === 'NS' ? 0 : SIGNAL_HALF);
  sim.roads.nodes[lane.to]!.offset = (((redStart - sim.time) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
}

/** An AI-driven vehicle placed on `lane` at distance `s`, rolling at `speed`. */
function drive(sim: Sim, kind: VehicleKind, lane: Lane, s: number, speed = 0, policy: DriverPolicy = 'traffic'): Vehicle {
  const v = sim.spawnVehicle(kind, lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
  v.owner = 'traffic';
  sim.addDriver(v, 'civilian', policy);
  if (policy === 'traffic' || policy === 'route') v.ai!.speedMul = 1;
  v.ai!.setLane(lane, s);
  v.vel.x = lane.dx * speed;
  v.vel.z = lane.dz * speed;
  return v;
}

/** A car nobody drives, standing on `lane` at distance `s`. */
function abandon(sim: Sim, kind: VehicleKind, lane: Lane, s: number): Vehicle {
  return sim.spawnVehicle(kind, lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
}

/** Distance along the lane direction from its start. */
function along(lane: Lane, p: { x: number; z: number }): number {
  return (p.x - lane.sx) * lane.dx + (p.z - lane.sz) * lane.dz;
}

/** Sideways offset from the lane centre line. */
function across(lane: Lane, p: { x: number; z: number }): number {
  return (p.x - lane.sx) * -lane.dz + (p.z - lane.sz) * lane.dx;
}

/** Distance from a point to the vehicle body (negative inside). */
function bodyDistance(v: Vehicle, x: number, z: number): number {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const dx = x - v.pos.x;
  const dz = z - v.pos.z;
  const a = Math.abs(dx * fx + dz * fz) - v.halfL;
  const b = Math.abs(dx * -fz + dz * fx) - v.halfW;
  return Math.hypot(Math.max(a, 0), Math.max(b, 0)) + Math.min(Math.max(a, b), 0);
}

describe('driving fixes', () => {
  it('brakes for a person knocked down in the lane instead of running them over', () => {
    const sim = makeSim({ police: false });
    const lane = streetLane(sim);
    signalsOff(sim);
    const car = drive(sim, 'sedan', lane, 4, 11);
    const victim = sim.spawnCharacter('civilian', lane.sx + lane.dx * 44, lane.sz + lane.dz * 44);
    let hits = 0;
    sim.events.on('impact', (e) => {
      if (e.vehicle === car) hits++;
    });
    step(sim, 8, () => {
      // Keep them down for the whole approach.
      victim.state = 'knocked';
      victim.knockTimer = 5;
      return input();
    });
    expect(hits).toBe(0);
    expect(victim.health).toBe(victim.maxHealth);
    expect(car.speed).toBeLessThan(0.5);
  });

  it('waits in line at a red light without honking, overtaking or reversing', () => {
    for (const playerAtLine of [false, true]) {
      const sim = makeSim({ police: false });
      const lane = streetLane(sim);
      holdRed(sim, lane);
      let s = lane.length - 24;
      if (playerAtLine) {
        // The player's car waits at the line: there is no AI to ask why it stands there.
        placeInCar(sim, abandon(sim, 'sedan', lane, lane.length - 3.5));
        s -= 8;
      }
      const queue: Vehicle[] = [];
      for (let i = 0; i < 4; i++, s -= 10) queue.push(drive(sim, 'sedan', lane, s, 8));
      let honks = 0;
      let crashes = 0;
      let reversing = 0;
      let swerve = 0;
      sim.events.on('horn', (e) => {
        if (queue.includes(e.vehicle)) honks++;
      });
      sim.events.on('impact', (e) => {
        if (e.vehicle && queue.includes(e.vehicle)) crashes++;
      });
      step(sim, 17, () => {
        for (const v of queue) {
          if (v.forwardSpeed < -0.5) reversing++;
          swerve = Math.max(swerve, Math.abs(across(lane, v.pos)));
        }
        return input();
      });
      expect(honks).toBe(0);
      expect(reversing).toBe(0);
      expect(crashes).toBe(0);
      expect(swerve).toBeLessThan(0.5);
      // Every car stood still in the queue the whole red phase.
      for (const v of queue) expect(along(lane, v.pos) + v.halfL).toBeLessThan(lane.length);
    }
  });

  it('gets past a car abandoned in a one-lane street, starting from a standstill', () => {
    for (const follower of [false, true]) {
      const sim = makeSim({ police: false });
      const lane = streetLane(sim);
      signalsOff(sim);
      const parked = abandon(sim, 'van', lane, 40);
      const car = drive(sim, 'sedan', lane, 8, 8);
      // A second car queued right behind leaves no room to back up blindly.
      const behind = follower ? drive(sim, 'sedan', lane, 0.5, 6) : null;
      const cars = behind ? [car, behind] : [car];
      let contacts = 0;
      sim.events.on('impact', (e) => {
        if (e.vehicle && (cars.includes(e.vehicle) || e.vehicle === parked)) contacts++;
      });
      let stoppedAt = -1;
      const passedAt = new Map<Vehicle, number>();
      step(sim, 45, (t) => {
        if (stoppedAt < 0 && t > 1 && car.speed < 0.2) stoppedAt = t;
        for (const v of cars) {
          const past = along(lane, v.pos) - v.halfL > along(lane, parked.pos) + parked.halfL;
          if (!passedAt.has(v) && past && Math.abs(across(lane, v.pos)) < 1.5) passedAt.set(v, t);
        }
        return input();
      });
      expect(stoppedAt).toBeGreaterThan(0);
      for (const v of cars) {
        expect(passedAt.has(v)).toBe(true);
        expect(passedAt.get(v)! - stoppedAt).toBeLessThan(30);
      }
      expect(contacts).toBe(0);
    }
  });

  it('lets pursuers go around a queue at a red light from a standstill', () => {
    for (const policy of ['chase', 'flee'] as const) {
      const sim = makeSim({ police: false });
      const lane = streetLane(sim);
      holdRed(sim, lane);
      drive(sim, 'sedan', lane, lane.length - 3.5);
      drive(sim, 'sedan', lane, lane.length - 10.5);
      const unit = drive(sim, 'police', lane, 30, 10, policy);
      unit.ai!.target = sim.player;
      let crossed = -1;
      step(sim, 16, (t) => {
        if (crossed < 0 && along(lane, unit.pos) > lane.length) crossed = t;
        return input();
      });
      // The light stays red for 18 s: only going around the queue gets it there.
      expect(crossed).toBeGreaterThan(0);
      expect(crossed).toBeLessThan(12);
    }
  });

  it('stops with the front bumper behind the stop line, not on the crossing', () => {
    for (const kind of ['compact', 'sedan', 'van', 'bus'] as const) {
      const sim = makeSim({ police: false });
      const lane = sim.roads.lanes.find((l) => l.line.avenue && l.length >= 80 && sim.roads.nodes[l.to]!.signal && sim.roads.nodes[l.to]!.degree === 4)!;
      holdRed(sim, lane);
      const v = drive(sim, kind, lane, lane.length - 45, 10);
      step(sim, 12);
      // Positive: the nose is past the lane end, on the zebra (or a bus nose in the junction).
      const nose = along(lane, v.pos) + v.halfL - lane.length;
      expect(v.speed).toBeLessThan(0.3);
      expect(nose).toBeLessThan(0);
      expect(nose).toBeGreaterThan(-1.5);
    }
  });

  it('plans for the signal at the end of a lane longer than the planning horizon', () => {
    const sim = makeSim({ police: false });
    const lane = sim.roads.lanes.find((l) => l.length >= 80 && sim.roads.nodes[l.to]!.signal)!;
    holdRed(sim, lane);
    const v = drive(sim, 'sedan', lane, 3, 10);
    let furthest = -Infinity;
    step(sim, 15, () => {
      furthest = Math.max(furthest, along(lane, v.pos) + v.halfL);
      return input();
    });
    expect(furthest).toBeLessThan(lane.length);
  });

  it('follows avenue right turns without clipping the corner signal pole', () => {
    for (const kind of ['sedan', 'van'] as const) {
      const sim = makeSim({ police: false });
      let broken = 0;
      sim.events.on('propBroken', () => broken++);
      const lanes = sim.roads.lanes
        .filter((l) => l.line.avenue && l.index === l.lanesInDir - 1 && sim.roads.nodes[l.to]!.signal && sim.roads.nodes[l.to]!.degree === 4)
        .filter((l) => l.turns.some((t) => t.kind === 'right' && t.to.line.avenue))
        .slice(0, 4);
      expect(lanes.length).toBe(4);
      for (const lane of lanes) {
        const turn = lane.turns.find((t) => t.kind === 'right')!;
        const node = sim.roads.nodes[lane.to]!;
        // The pole of this approach stands on the inside corner of its right turn.
        const pole = sim.world.layout.props.find((p) => p.kind === 'signal' && p.node === node.id && p.dir === lane.dir)!;
        node.signal = false; // green
        const exit = sim.roads.nodes[turn.to.to]!;
        const car = drive(sim, kind, lane, lane.length - 35, 10, 'route');
        car.ai!.dest = { x: exit.x, z: exit.z };
        car.ai!.setLane(lane, lane.length - 35);
        let clearance = Infinity;
        step(sim, 8, () => {
          clearance = Math.min(clearance, bodyDistance(car, pole.x, pole.z) - 0.2);
          return input();
        });
        expect(along(turn.to, car.pos)).toBeGreaterThan(10);
        expect(clearance).toBeGreaterThan(0.3);
        sim.removeVehicle(car);
      }
      expect(broken).toBe(0);
    }
  });

  it('cruises without pulsing the brakes or holding throttle above the target speed', () => {
    for (const kind of ['compact', 'sedan', 'sports', 'police'] as const) {
      const sim = makeSim({ police: false });
      signalsOff(sim);
      // Straight up a north-south avenue, the city's whole depth: nothing to slow down for.
      const n = sim.roads.layout.n;
      const lane = sim.roads.lanes.find((l) => l.line.avenue && l.dir === 0 && l.index === 0 && sim.roads.nodes[l.from]!.j === n && sim.roads.nodes[l.from]!.degree === 3)!;
      const end = sim.roads.node(sim.roads.nodes[lane.from]!.i, 0);
      const v = drive(sim, kind, lane, 2, 12, 'route');
      v.ai!.dest = { x: end.x, z: end.z };
      v.ai!.setLane(lane, 2);
      step(sim, 4);
      const target = lane.speedLimit;
      let toggles = 0;
      let throttleAbove = 0;
      let braking = v.braking;
      step(sim, 3, () => {
        if (v.braking !== braking) toggles++;
        braking = v.braking;
        if (v.forwardSpeed > target + 0.05 && v.controls.throttle > 0) throttleAbove++;
        return input();
      });
      expect(toggles).toBe(0);
      expect(throttleAbove).toBe(0);
      expect(v.forwardSpeed).toBeGreaterThan(target - 0.5);
      expect(v.forwardSpeed).toBeLessThan(target + 0.3);
    }
  });

  it('keeps buses off side streets and slows them through turns tighter than their turning circle', () => {
    const sim = makeSim({ police: false });
    let broken = 0;
    sim.events.on('propBroken', () => broken++);
    // Free-roaming buses only take turns they can steer: they never end up in a side street. They start where traffic
    // puts buses: on avenues they can drive on for ever (not one cut short by a bay).
    const through = throughAvenues(sim.roads);
    const starts = sim.roads.lanes.filter((l) => through.has(l) && l.length >= 70).filter((_, i) => i % 9 === 0).slice(0, 6);
    const buses = starts.map((l) => drive(sim, 'bus', l, 10, 8));
    let onStreet = 0;
    step(sim, 60, () => {
      for (const b of buses) if (b.ai?.currentLane()?.line.avenue === false) onStreet++;
      return input();
    });
    expect(onStreet).toBe(0);
    for (const b of buses) sim.removeVehicle(b);

    // A bus made to take a tight turn into a side street crawls through the junction.
    const lane = sim.roads.lanes.find((l) => l.line.avenue && l.index === 0 && l.turns.some((t) => t.kind === 'left' && t.legal && !t.to.line.avenue))!;
    const turn = lane.turns.find((t) => t.kind === 'left' && !t.to.line.avenue)!;
    const node = sim.roads.nodes[lane.to]!;
    node.signal = false;
    const exit = sim.roads.nodes[turn.to.to]!;
    const bus = drive(sim, 'bus', lane, lane.length - 35, 8, 'route');
    bus.ai!.dest = { x: exit.x, z: exit.z };
    bus.ai!.setLane(lane, lane.length - 35);
    let boxSpeed = 0;
    step(sim, 25, () => {
      const turning = bus.ai?.currentLane() === null;
      if (turning && Math.abs(bus.pos.x - node.x) < node.halfX && Math.abs(bus.pos.z - node.z) < node.halfZ) boxSpeed = Math.max(boxSpeed, bus.speed);
      return input();
    });
    expect(boxSpeed).toBeGreaterThan(0);
    // Street furniture breaks above 3.5 m/s.
    expect(boxSpeed).toBeLessThan(3.5);
    expect(along(turn.to, bus.pos)).toBeGreaterThan(20);
    expect(broken).toBe(0);
  });

  it('never spawns traffic where the player can see it', () => {
    const sim = makeSim({ police: false });
    // Stand on an avenue sidewalk, looking down the avenue.
    const node = sim.roads.node(8, 2);
    teleport(sim, node.x + 10, node.z + 14);
    const p = sim.player;
    sim.cam.x = p.pos.x;
    sim.cam.y = p.pos.y + 2.5;
    sim.cam.z = p.pos.z - 4;
    sim.camDir.x = 0;
    sim.camDir.y = -0.03;
    sim.camDir.z = 1;
    let spawned = 0;
    let inView = 0;
    for (let i = 0; i < 80; i++) {
      const v = sim.traffic.trySpawnTraffic();
      if (!v) continue;
      spawned++;
      if (sim.isVisible(v.pos.x, 1, v.pos.z)) inView++;
    }
    expect(spawned).toBeGreaterThan(20);
    expect(inView).toBe(0);
  });

  it('clears away traffic stuck out of sight, but not cars waiting at a red light', () => {
    const sim = makeSim({ police: false, ambient: true });
    sim.traffic.density = 0;
    const lane = streetLane(sim);
    signalsOff(sim);
    // Both lanes of the street are closed: there is no way past.
    abandon(sim, 'van', lane, 40);
    const opp = oppositeLane(sim, lane);
    abandon(sim, 'van', opp, opp.length - 40);
    const car = drive(sim, 'sedan', lane, 8, 8);
    // The player stands 150 m away (towards the city centre), looking further away.
    const b = sim.world.layout.bounds;
    const sx = lane.sx + lane.dx * 33;
    const sz = lane.sz + lane.dz * 33;
    let rx = -lane.dz;
    let rz = lane.dx;
    if ((sx + rx - (b.cityMinX + b.cityMaxX) / 2) ** 2 + (sz + rz - (b.cityMinZ + b.cityMaxZ) / 2) ** 2 > (sx - (b.cityMinX + b.cityMaxX) / 2) ** 2 + (sz - (b.cityMinZ + b.cityMaxZ) / 2) ** 2) {
      rx = -rx;
      rz = -rz;
    }
    teleport(sim, sx + rx * 150, sz + rz * 150);
    const look = () => {
      const pp = sim.playerPos();
      return input({ aimOrigin: { x: pp.x - rx * 4, y: pp.y + 2.5, z: pp.z - rz * 4 }, aimDir: { x: rx, y: -0.02, z: rz } });
    };
    step(sim, 60, look);
    expect(car.removed).toBe(true);

    // Waiting through a whole red phase is not being stuck.
    const sim2 = makeSim({ police: false });
    const lane2 = streetLane(sim2);
    holdRed(sim2, lane2);
    const waiting = [drive(sim2, 'sedan', lane2, lane2.length - 30, 8), drive(sim2, 'sedan', lane2, lane2.length - 45, 8)];
    let stuck = 0;
    step(sim2, 17.5, () => {
      for (const v of waiting) stuck = Math.max(stuck, v.stuckTime);
      return input();
    });
    expect(stuck).toBeLessThan(1);
  });

  it('releases a hold that nobody clears (player died or was busted mid carjack)', () => {
    const sim = makeSim({ police: false });
    const lane = streetLane(sim);
    signalsOff(sim);
    const car = drive(sim, 'sedan', lane, 10);
    car.ai!.hold = true;
    const x0 = car.pos.x;
    const z0 = car.pos.z;
    step(sim, 1);
    // Held while someone climbs in...
    expect(Math.hypot(car.pos.x - x0, car.pos.z - z0)).toBeLessThan(0.1);
    step(sim, 9);
    // ...but not forever.
    expect(car.ai!.hold).toBe(false);
    expect(Math.hypot(car.pos.x - x0, car.pos.z - z0)).toBeGreaterThan(10);
  });

  it('keeps ambient traffic flowing without honking chains, crashes or knocked-over street furniture', () => {
    const sim = makeSim({ police: false, ambient: true, seed: 7 });
    const node = sim.roads.node(5, 5);
    teleport(sim, node.x + 11, node.z + 11);
    let honks = 0;
    let crashes = 0;
    let broken = 0;
    sim.events.on('horn', (e) => {
      if (e.vehicle.ai) honks++;
    });
    sim.events.on('impact', (e) => {
      if (e.vehicle?.ai && e.strength > 2.5) crashes++;
    });
    sim.events.on('propBroken', () => broken++);
    step(sim, 90);
    expect(sim.vehicles.filter((v) => v.owner === 'traffic').length).toBeGreaterThan(10);
    expect(honks).toBeLessThan(25);
    expect(crashes).toBeLessThanOrEqual(1);
    expect(broken).toBeLessThanOrEqual(1);
  });
});

/**
 * Nooks where a car fits nose-first between a building and a sidewalk lamp: the nose 0.3-0.6 m from
 * the wall, the lamp 1.4 m behind the rear bumper, nothing else in the way. Centre and heading.
 */
function lampNooks(sim: Sim, kind: VehicleKind): { x: number; z: number; heading: number }[] {
  const halfL = VEHICLE_SPECS[kind].length / 2;
  const halfW = VEHICLE_SPECS[kind].width / 2;
  const grid = sim.world.grid;
  const nooks: { x: number; z: number; heading: number }[] = [];
  for (const p of sim.world.layout.props) {
    if (p.kind !== 'lamp') continue;
    // Lamps face the street; the building is the other way.
    const nx = -Math.sin(p.rot);
    const nz = -Math.cos(p.rot);
    let wall = -1;
    for (let d = 0.3; d < 12 && wall < 0; d += 0.02) {
      const x = p.x + nx * d;
      const z = p.z + nz * d;
      grid.query(x, z, x, z, (c) => {
        if (c.tag === 'building' && x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ) wall = d;
      });
    }
    // The lamp post has a 0.17 m radius.
    const back = 0.17 + 1.4;
    const nose = wall - back - 2 * halfL;
    if (nose < 0.3 || nose > 0.6) continue;
    const x = p.x + nx * (back + halfL);
    const z = p.z + nz * (back + halfL);
    let clear = true;
    grid.query(x - 4, z - 4, x + 4, z + 4, (c) => {
      if (c.tag === 'building') return;
      const dx = c.cx - x;
      const dz = c.cz - z;
      if (Math.abs(dx * nx + dz * nz) < halfL + 0.3 + c.r && Math.abs(dx * nz - dz * nx) < halfW + 0.3 + c.r) clear = false;
    });
    if (clear) nooks.push({ x, z, heading: Math.atan2(nx, nz) });
  }
  return nooks;
}

describe('driving fixes, round 2', () => {
  it('gives way to a car entering the far end of the street while it overtakes', () => {
    for (const kind of ['sedan', 'van'] as const) {
      for (const delay of [0, 0.5, 1, 1.5, 2, 2.5]) {
        const sim = makeSim({ police: false });
        const lane = streetLane(sim);
        signalsOff(sim);
        const opp = oppositeLane(sim, lane);
        const parked = abandon(sim, 'sedan', lane, 45);
        const car = drive(sim, 'sedan', lane, 8, 8);
        let other: Vehicle | null = null;
        let impacts = 0;
        sim.events.on('impact', (e) => {
          if (e.vehicle === car || e.vehicle === parked || (other && e.vehicle === other)) impacts++;
        });
        const begin = along(lane, parked.pos) - parked.halfL;
        const end = along(lane, parked.pos) + parked.halfL;
        let start = -1;
        let carPast = -1;
        let otherPast = -1;
        let reverse = 0;
        step(sim, 45, (t) => {
          // The manoeuvre starts when the car backs up to pull out; the other car turns up `delay` s later.
          if (start < 0 && t > 1 && car.forwardSpeed < -0.2) start = t;
          if (start >= 0 && !other && t >= start + delay) other = drive(sim, kind, opp, 2, 12);
          reverse = Math.max(reverse, -car.forwardSpeed);
          if (carPast < 0 && along(lane, car.pos) - car.halfL > end && Math.abs(across(lane, car.pos)) < 1.5) carPast = t;
          if (other && otherPast < 0 && along(lane, other.pos) + other.halfL < begin - 1 && Math.abs(across(opp, other.pos)) < 1.5) otherPast = t;
          return input();
        });
        expect(start).toBeGreaterThan(0);
        expect(carPast).toBeGreaterThan(start);
        expect(otherPast).toBeGreaterThan(start);
        expect(carPast - start).toBeLessThan(30);
        expect(otherPast - start).toBeLessThan(30);
        expect(impacts).toBe(0);
        // Backing up around other cars stays below the speed at which street furniture breaks.
        expect(reverse).toBeLessThan(3.5);
      }
    }
  });

  it('backs the car that is out of its lane into it when it meets oncoming traffic nose to nose', () => {
    for (const parkedBehind of [false, true]) {
      const sim = makeSim({ police: false });
      const lane = streetLane(sim);
      signalsOff(sim);
      const opp = oppositeLane(sim, lane);
      // Standing out in the oncoming lane, 4 m to the left of its own.
      const outOfLane = (v: Vehicle) => {
        v.pos.x += lane.dz * 4;
        v.pos.z -= lane.dx * 4;
        return v;
      };
      const a = outOfLane(drive(sim, 'sedan', lane, 40));
      // With a car parked right behind it, it cannot back up: the oncoming one makes room instead.
      if (parkedBehind) outOfLane(abandon(sim, 'sedan', lane, 33.5));
      const b = drive(sim, 'sedan', opp, opp.length - 52);
      let impacts = 0;
      sim.events.on('impact', (e) => {
        if (e.vehicle === a || e.vehicle === b) impacts++;
      });
      let bPast = -1;
      let aBack = -1;
      step(sim, 20, (t) => {
        if (bPast < 0 && along(lane, b.pos) + b.halfL < along(lane, a.pos) - a.halfL - 1) bPast = t;
        if (aBack < 0 && Math.abs(across(lane, a.pos)) < 0.8 && along(lane, a.pos) > 45) aBack = t;
        return input();
      });
      expect(bPast).toBeGreaterThan(0);
      expect(bPast).toBeLessThan(15);
      expect(aBack).toBeGreaterThan(0);
      expect(aBack).toBeLessThan(15);
      expect(impacts).toBe(0);
    }
  });

  it('keeps traffic moving both ways past a car abandoned in a one-lane street', () => {
    for (const seed of [5, 17]) {
      const sim = makeSim({ police: false, ambient: true, seed });
      const lane = streetLane(sim);
      const parked = abandon(sim, 'sedan', lane, lane.length / 2);
      // The player stands on the sidewalk next to it.
      teleport(sim, parked.pos.x - lane.dz * 5, parked.pos.z + lane.dx * 5);
      const at = along(lane, parked.pos);
      const last = new Map<Vehicle, number>();
      // Per direction (0: the parked car's, 1: the other one): since when cars wait behind it with
      // none getting past, and the longest such stall.
      const since = [-1, -1];
      const stall = [0, 0];
      step(sim, 240, (t) => {
        const waiting = [false, false];
        for (const v of sim.vehicles) {
          if (v.removed || !v.ai || v.owner !== 'traffic') continue;
          const side = across(lane, v.pos);
          const a = along(lane, v.pos) - at;
          if (side < -7.5 || side > 3.5 || Math.abs(a) > 45) {
            last.delete(v);
            continue;
          }
          const dot = Math.sin(v.heading) * lane.dx + Math.cos(v.heading) * lane.dz;
          if (Math.abs(dot) < 0.5) continue;
          const d = dot > 0 ? 0 : 1;
          const before = last.get(v);
          last.set(v, a);
          const clear = parked.halfL + v.halfL;
          if (v.speed < 0.5 && (d === 0 ? a > -25 && a < 0 : a > 0 && a < 25)) waiting[d] = true;
          if (before !== undefined && (d === 0 ? before <= clear && a > clear : before >= -clear && a < -clear)) since[d] = -1;
        }
        for (const d of [0, 1]) {
          if (!waiting[d]) since[d] = -1;
          else if (since[d]! < 0) since[d] = t;
          else stall[d] = Math.max(stall[d]!, t - since[d]!);
        }
        return input();
      });
      expect(stall[0]).toBeLessThan(40);
      expect(stall[1]).toBeLessThan(40);
    }
  });

  it('clears the junction when the light turns red while it yields to turn left', () => {
    for (const kind of ['sedan', 'bus'] as const) {
      const sim = makeSim({ police: false });
      const roads = sim.roads;
      const oncomingLane = (l: Lane) => roads.laneFrom(roads.nodes[l.to]!.neighbors[l.dir]!, reverseDir(l.dir), 0);
      // The inner lane of an avenue into a signalled crossing with another avenue, turning left onto it.
      const lane = roads.lanes.find((l) => {
        const n = roads.nodes[l.to]!;
        if (!l.line.avenue || l.index !== 0 || l.length < 60 || !n.signal || n.degree !== 4) return false;
        const left = l.turns.find((t) => t.kind === 'left');
        const opp = oncomingLane(l);
        return !!left && left.legal && left.to.line.avenue && !!opp && opp.to === n.id && opp.length >= 60;
      })!;
      const node = roads.nodes[lane.to]!;
      const turn = lane.turns.find((t) => t.kind === 'left')!;
      const opp = oncomingLane(lane)!;
      const exit = roads.nodes[turn.to.to]!;
      const beyond = roads.nodes[node.neighbors[reverseDir(lane.dir)]!]!;
      // Our green ends in 3 s.
      const phase = (axisOf(lane.dir) === 'NS' ? 0 : SIGNAL_HALF) + SIGNAL_GREEN - 3;
      node.offset = (((phase - sim.time) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
      const route = (v: Vehicle, l: Lane, s: number, to: { x: number; z: number }) => {
        v.ai!.dest = { x: to.x, z: to.z };
        v.ai!.setLane(l, s);
        return v;
      };
      const car = route(drive(sim, kind, lane, lane.length - 30, 8, 'route'), lane, lane.length - 30, exit);
      let next = 0;
      let redAt = -1;
      let onCrossing = 0;
      let cleared = -1;
      step(sim, 30, (t) => {
        const red = roads.signalState(node.id, axisOf(lane.dir), sim.time) === 'red';
        // A steady stream of oncoming cars keeps it yielding until the yellow ends.
        if (!red && t >= next) {
          next = t + 1.2;
          if (sim.traffic.isClear(opp.sx + opp.dx * 25, opp.sz + opp.dz * 25, 8)) route(drive(sim, 'sedan', opp, 25, 13, 'route'), opp, 25, beyond);
        }
        if (red && redAt < 0) redAt = t;
        const nose = along(lane, car.pos) + car.halfL - lane.length;
        if (red && car.ai!.currentLane() === lane && nose > 0 && car.speed < 0.3) onCrossing += 1 / 60;
        if (cleared < 0 && car.ai!.currentLane() === turn.to && along(turn.to, car.pos) > 3) cleared = t;
        return input();
      });
      expect(redAt).toBeGreaterThan(0);
      // It waits out the last cars running the yellow, then completes the turn.
      expect(cleared).toBeGreaterThan(redAt);
      expect(cleared - redAt).toBeLessThan(15);
      expect(onCrossing).toBeLessThan(4);
    }
  });

  it('gets a car pinned between a building and a lamp post out within 8 s', () => {
    for (const [kind, policy] of [
      ['sedan', 'traffic'],
      ['police', 'chase'],
    ] as const) {
      const nooks = lampNooks(makeSim({ police: false }), kind);
      expect(nooks.length).toBeGreaterThanOrEqual(3);
      for (const nook of nooks.slice(0, 3)) {
        const sim = makeSim({ police: false });
        const car = sim.spawnVehicle(kind, nook.x, nook.z, nook.heading);
        car.owner = 'traffic';
        sim.addDriver(car, kind === 'police' ? 'cop' : 'civilian', policy);
        if (policy === 'chase') car.ai!.target = sim.player;
        let freeAt = -1;
        step(sim, 8, (t) => {
          if (freeAt < 0 && Math.hypot(car.pos.x - nook.x, car.pos.z - nook.z) > 4) freeAt = t;
          return input();
        });
        // A slow reverse ends against the lamp; the next one knocks it over.
        expect(freeAt).toBeGreaterThan(0);
      }
    }
  });

  it('routes a pursuer round the block to a goal behind it instead of on along the street', () => {
    const roads = makeSim({ police: false }).roads;
    const behind = (l: Lane) => roads.nodes[l.from]!.neighbors[reverseDir(l.dir)]!;
    const fourWay = (id: number) => id >= 0 && roads.nodes[id]!.degree === 4;
    const lanes = roads.lanes.filter((l) => l.lanesInDir === 1 && l.length >= 60 && fourWay(l.from) && fourWay(l.to) && fourWay(behind(l)));
    expect(lanes.length).toBeGreaterThanOrEqual(12);
    for (let k = 0; k < 12; k++) {
      const lane = lanes[Math.floor((k * lanes.length) / 12)]!;
      const sim = makeSim({ police: false });
      const unit = drive(sim, 'police', lane, 8, 0, 'chase');
      // A search point at the junction behind the one it just left: too far to drive straight at.
      const goal = sim.roads.nodes[behind(lane)]!;
      unit.ai!.dest = { x: goal.x, z: goal.z };
      unit.ai!.resetPath();
      const ahead = sim.roads.nodes[lane.to]!;
      let past = -Infinity;
      let reached = -1;
      step(sim, 40, (t) => {
        if (reached >= 0) return input();
        past = Math.max(past, (unit.pos.x - ahead.x) * lane.dx + (unit.pos.z - ahead.z) * lane.dz);
        if (Math.hypot(unit.pos.x - goal.x, unit.pos.z - goal.z) < 15) reached = t;
        return input();
      });
      // Lanes have no U-turn: it turns off at the junction ahead rather than carry on to the next one.
      expect(past).toBeLessThan(20);
      expect(reached).toBeGreaterThan(0);
      expect(reached).toBeLessThan(30);
    }
  });
});

/** Driver internals the round-3 tests look at. */
const internals = (v: Vehicle) => v.ai as unknown as { merging: boolean; blocker: unknown };

/**
 * A car abandoned in `lane` 35 m in, and a second one left in the oncoming lane facing its own way,
 * its front bumper `stagger` m past the first one's.
 */
function staggered(sim: Sim, lane: Lane, stagger: number): [Vehicle, Vehicle] {
  const opp = oppositeLane(sim, lane);
  const first = abandon(sim, 'sedan', lane, 35);
  const second = abandon(sim, 'sedan', opp, opp.length - (35 + first.halfL + stagger + VEHICLE_SPECS.sedan.length / 2));
  return [first, second];
}

describe('driving fixes, round 3', () => {
  it('drives on past a car left in the oncoming lane just beyond the one it overtakes', () => {
    for (const kind of ['sedan', 'van', 'compact'] as const) {
      for (const stagger of [16, 20, 24]) {
        const sim = makeSim({ police: false });
        const lane = streetLane(sim);
        signalsOff(sim);
        const [first, second] = staggered(sim, lane, stagger);
        const car = drive(sim, kind, lane, 8, 8);
        let contacts = 0;
        sim.events.on('impact', (e) => {
          if (e.vehicle === car || e.vehicle === first || e.vehicle === second) contacts++;
        });
        let pastFirst = -1;
        let past = -1;
        let still = 0;
        let longest = 0;
        step(sim, 30, (t) => {
          if (pastFirst < 0 && along(lane, car.pos) - car.halfL > along(lane, first.pos) + first.halfL) pastFirst = t;
          if (past < 0 && along(lane, car.pos) - car.halfL > along(lane, second.pos) + second.halfL && Math.abs(across(lane, car.pos)) < 1.5) past = t;
          still = pastFirst >= 0 && past < 0 && car.speed < 0.1 ? still + 1 / 60 : 0;
          longest = Math.max(longest, still);
          return input();
        });
        const what = `${kind}, ${stagger} m on`;
        expect(past, what).toBeGreaterThan(0);
        expect(contacts, what).toBe(0);
        // From 20 m on the second car stands well clear of its way back in: once round the first
        // one, nothing holds it up.
        if (stagger >= 20) expect(longest, what).toBeLessThan(1);
      }
    }
  });

  it('does not wait for good for a car that keeps coming its way while it pulls back in', () => {
    const sim = makeSim({ police: false });
    const lane = streetLane(sim);
    signalsOff(sim);
    const opp = oppositeLane(sim, lane);
    const [first, creeper] = staggered(sim, lane, 20);
    const x = creeper.pos.x;
    const z = creeper.pos.z;
    const car = drive(sim, 'sedan', lane, 8, 8);
    let level = false;
    let reported = false;
    let past = -1;
    step(sim, 30, (t) => {
      // Once the car has drawn level with the first one, the second rolls its way at walking pace,
      // pinned in place: it never gets any closer, so waiting for it to arrive is waiting for good.
      level ||= along(lane, car.pos) + car.halfL > along(lane, first.pos) - first.halfL + 1;
      if (level) {
        creeper.pos.x = x;
        creeper.pos.z = z;
        creeper.vel.x = opp.dx * 1.2;
        creeper.vel.z = opp.dz * 1.2;
      }
      if (car.speed < 0.3 && car.ai!.limiter === 'obstacle' && internals(car).blocker === creeper) reported = true;
      if (past < 0 && along(lane, car.pos) - car.halfL > along(lane, creeper.pos) + creeper.halfL && Math.abs(across(lane, car.pos)) < 1.5) past = t;
      return input();
    });
    // Kept standing by it, the car reports it as what blocks it, and before long drives on past it.
    expect(reported).toBe(true);
    expect(past).toBeGreaterThan(0);
  });

  it('never leaves a car frozen pulling back in after overtaking, in traffic past a car left in each lane', () => {
    for (const seed of [2, 3]) {
      const sim = makeSim({ police: false, ambient: true, seed });
      const lane = streetLane(sim);
      const opp = oppositeLane(sim, lane);
      const parked = abandon(sim, 'sedan', lane, lane.length * 0.45);
      abandon(sim, 'sedan', opp, opp.length * 0.25);
      // The player stands on the sidewalk next to the first one.
      teleport(sim, parked.pos.x - lane.dz * 5, parked.pos.z + lane.dx * 5);
      const merged = new Set<Vehicle>();
      const frozen = new Map<Vehicle, number>();
      let worst = 0;
      step(sim, 90, () => {
        for (const v of sim.vehicles) {
          if (v.removed || !v.ai) continue;
          const merging = internals(v).merging;
          if (merging) merged.add(v);
          const t = merging && v.speed < 0.3 ? (frozen.get(v) ?? 0) + 1 / 60 : 0;
          frozen.set(v, t);
          worst = Math.max(worst, t);
        }
        return input();
      });
      // Cars do go round the abandoned ones, and none is left standing out in the other lane.
      expect(merged.size, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(worst, `seed ${seed}`).toBeLessThan(20);
    }
  });
});
