// Streams ambient traffic and parked cars in and out around the player.

import type { Lane } from '../world/roads';
import { pointSegDist } from '../core/math';
import type { Vehicle } from './entities';
import type { Sim } from './sim';
import { PARKED_MIX, TRAFFIC_MIX, type VehicleKind } from './specs';

export class TrafficSystem {
  private timer = 0;
  private parkedTimer = 0;
  private laneTimer = 0;
  private nearLanes: Lane[] = [];
  readonly parkedBySpot = new Map<number, Vehicle>();
  /** Multiplier for traffic density (settings / tests). */
  density = 1;

  constructor(private readonly sim: Sim) {}

  get targetCount(): number {
    const h = this.sim.clock.hours;
    const base = h < 5 ? 14 : h < 7 ? 20 : h < 10 ? 30 : h < 16 ? 26 : h < 20 ? 30 : 20;
    return Math.round(base * this.density);
  }

  updateStreaming(dt: number): void {
    this.laneTimer -= dt;
    if (this.laneTimer <= 0) {
      this.laneTimer = 1.5;
      this.refreshNearLanes();
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.4;
      this.streamTraffic();
    }
    this.parkedTimer -= dt;
    if (this.parkedTimer <= 0) {
      this.parkedTimer = 1.1;
      this.streamParked();
    }
  }

  private streamTraffic(): void {
    const sim = this.sim;
    const pp = sim.playerPos();
    let count = 0;
    for (const v of sim.vehicles) {
      if (v.removed || v.persistent || v.owner === 'police' || v.owner === 'mission') continue;
      if (v.driver === sim.player) continue;
      const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
      if (v.destroyed) {
        if ((v.wreckTime > 40 && (d > 60 || !sim.isVisible(v.pos.x, v.pos.y, v.pos.z))) || d > 280) sim.removeVehicle(v);
        continue;
      }
      if (v.inWater && v.sinkTimer > 6) {
        sim.removeVehicle(v);
        continue;
      }
      if (v.owner === 'parked') continue; // handled by streamParked
      if (d > 240 || (d > 175 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z))) {
        sim.removeVehicle(v);
        continue;
      }
      if (v.owner === 'traffic' && v.driver) {
        if (d > 130 && v.stuckTime > 14 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
          sim.removeVehicle(v);
          continue;
        }
        count++;
      } else if (!v.driver && d > 200 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        // Abandoned cars (bailed-out drivers, old player cars).
        sim.removeVehicle(v);
      }
    }
    let spawned = 0;
    while (count < this.targetCount && spawned < 2) {
      if (!this.trySpawnTraffic()) break;
      spawned++;
      count++;
    }
  }

  private refreshNearLanes(): void {
    const pp = this.sim.playerPos();
    this.nearLanes = this.sim.roads.lanes.filter((l) => pointSegDist(pp.x, pp.z, l.sx, l.sz, l.ex, l.ez) < 235);
  }

  /** Spawns one moving car on a lane out of the player's view. */
  trySpawnTraffic(minDist = 45, maxDist = 165, kind?: VehicleKind): Vehicle | null {
    const sim = this.sim;
    if (this.nearLanes.length === 0 || maxDist > 230) this.refreshNearLanes();
    if (this.nearLanes.length === 0) return null;
    const pp = sim.playerPos();
    for (let tries = 0; tries < 12; tries++) {
      const lane = sim.rng.pick(this.nearLanes);
      if (lane.length < 16) continue;
      const s = sim.rng.range(6, lane.length - 6);
      const x = lane.sx + lane.dx * s;
      const z = lane.sz + lane.dz * s;
      const d = Math.hypot(x - pp.x, z - pp.z);
      if (d < minDist || d > maxDist) continue;
      if (d < 120 && sim.isVisible(x, 1, z)) continue;
      if (!this.isClear(x, z, 11)) continue;
      let k = kind ?? sim.rng.weighted(TRAFFIC_MIX);
      if (k === 'bus' && !lane.line.avenue) k = 'sedan';
      const v = sim.spawnVehicle(k, x, z, lane.heading);
      v.owner = 'traffic';
      const driver = sim.addDriver(v, 'civilian', 'traffic');
      driver.owner = 'traffic';
      v.ai!.setLane(lane, s);
      const sp = lane.speedLimit * 0.55;
      v.vel.x = lane.dx * sp;
      v.vel.z = lane.dz * sp;
      return v;
    }
    return null;
  }

  /** Like trySpawnTraffic but ignores visibility; scans every lane deterministically. */
  spawnTrafficAnywhere(minDist: number, maxDist: number, kind: VehicleKind): Vehicle | null {
    const sim = this.sim;
    const pp = sim.playerPos();
    for (const lane of sim.roads.lanes) {
      for (let s = 8; s < lane.length - 8; s += 12) {
        const x = lane.sx + lane.dx * s;
        const z = lane.sz + lane.dz * s;
        const d = Math.hypot(x - pp.x, z - pp.z);
        if (d < minDist || d > maxDist || !this.isClear(x, z, 8)) continue;
        const v = sim.spawnVehicle(kind, x, z, lane.heading);
        v.owner = 'traffic';
        const driver = sim.addDriver(v, 'civilian', 'traffic');
        driver.owner = 'traffic';
        v.ai!.setLane(lane, s);
        return v;
      }
    }
    return null;
  }

  isClear(x: number, z: number, r: number): boolean {
    for (const v of this.sim.vehicles) {
      if (!v.removed && Math.hypot(v.pos.x - x, v.pos.z - z) < r) return false;
    }
    for (const c of this.sim.characters) {
      if (!c.removed && c.state !== 'inVehicle' && Math.hypot(c.pos.x - x, c.pos.z - z) < 3) return false;
    }
    return true;
  }

  private streamParked(): void {
    const sim = this.sim;
    const pp = sim.playerPos();
    const spots = sim.world.layout.parking;
    for (const [i, v] of this.parkedBySpot) {
      if (v.removed || v.usedByPlayer || v.driver || v.owner !== 'parked') {
        this.parkedBySpot.delete(i);
        if (!v.removed && v.owner === 'parked') v.owner = 'none';
        continue;
      }
      const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
      if (d > 235 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        sim.removeVehicle(v);
        this.parkedBySpot.delete(i);
      }
    }
    for (let i = 0; i < spots.length; i++) {
      if (this.parkedBySpot.has(i)) continue;
      const s = spots[i]!;
      const d = Math.hypot(s.x - pp.x, s.z - pp.z);
      if (d > 175 || d < 35) continue;
      if (hash(i) % 100 >= 55) continue;
      if (d < 120 && sim.isVisible(s.x, 0.5, s.z)) continue;
      if (!this.isClear(s.x, s.z, 3.5)) continue;
      const kind = PARKED_MIX[hash(i * 7 + 3) % PARKED_MIX.length]![0];
      const v = sim.spawnVehicle(kind, s.x, s.z, s.heading);
      v.owner = 'parked';
      this.parkedBySpot.set(i, v);
    }
  }
}

function hash(i: number): number {
  let x = (i + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}
