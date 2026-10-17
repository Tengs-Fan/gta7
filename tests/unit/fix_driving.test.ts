import { describe, expect, it } from 'vitest';
import type { DriverPolicy } from '../../src/sim/driver';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import type { VehicleKind } from '../../src/sim/specs';
import { axisOf, SIGNAL_CYCLE, SIGNAL_GREEN, SIGNAL_HALF, SIGNAL_YELLOW, type Lane } from '../../src/world/roads';
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
      // Straight down a north-south avenue: nothing to slow down for.
      const lane = sim.roads.lanes.find((l) => l.line.avenue && l.dir === 2 && l.index === 0 && sim.roads.nodes[l.from]!.j === 0 && sim.roads.nodes[l.from]!.degree === 3)!;
      const end = sim.roads.node(sim.roads.nodes[lane.from]!.i, sim.roads.layout.n);
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
    // Free-roaming buses only take turns they can steer: they never end up in a side street.
    const starts = sim.roads.lanes.filter((l) => l.line.avenue && l.length >= 70).filter((_, i) => i % 9 === 0).slice(0, 6);
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
