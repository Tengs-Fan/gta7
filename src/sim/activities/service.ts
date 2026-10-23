// Pieces the wave-1 vehicle jobs share: the grace time out of the job's vehicle, and handing people back to the city.

import type { Character, Vehicle } from '../entities';
import type { ActivityHost } from './types';

/** Seconds the player may spend out of a job's vehicle before the job is over. */
export const LEAVE_GRACE = 10;

export interface VehicleJobState {
  /** Seconds the player has been out of the job's vehicle (0 while he is in it). */
  away: number;
}

/**
 * Whether the job waits this frame because the player is not at the wheel of its vehicle: it ends at once when the vehicle
 * is wrecked, gone, sunk or on its roof, and once he has been out of it for LEAVE_GRACE seconds.
 */
export function outOfVehicle(host: ActivityHost, job: VehicleJobState, car: Vehicle, wreckedText: string, leftText: string, dt: number): boolean {
  const sim = host.sim;
  if (car.removed || car.destroyed || car.inWater || car.flipped) {
    host.end(wreckedText);
    return true;
  }
  if (sim.player.vehicle === car && car.driver === sim.player) {
    job.away = 0;
    return false;
  }
  job.away += dt;
  if (job.away >= LEAVE_GRACE) host.end(leftText);
  return true;
}

/** The status line's warning while the player is out of the job's vehicle. */
export function awayStatus(job: VehicleJobState, what: string): string | null {
  return job.away > 0 ? `GET BACK IN THE ${what}  ${Math.max(0, Math.ceil(LEAVE_GRACE - job.away))}` : null;
}

/** Lets someone out of `v` beside it, standing, and hands him to the ambient systems. */
export function letOut(host: ActivityHost, c: Character, v: Vehicle): void {
  const sim = host.sim;
  if (c.removed) return;
  if (c.vehicle) sim.unseat(c);
  const side = -Math.cos(v.heading);
  const sz = Math.sin(v.heading);
  const spot = sim.world.findFreeSpot(v.pos.x + side * (v.halfW + 0.9), v.pos.z + sz * (v.halfW + 0.9), 0.4, 8) ?? { x: v.pos.x, z: v.pos.z };
  c.pos.x = spot.x;
  c.pos.z = spot.z;
  c.pos.y = sim.world.groundHeight(spot.x, spot.z);
  if (c.alive) c.state = 'normal';
}

/** A job's person goes back to the ambient city: a patient gets up and walks off. */
export function releasePerson(c: Character): void {
  if (c.removed) return;
  if (c.state === 'knocked') c.knockTimer = 0.6;
  c.persistent = false;
  c.missionTag = '';
  c.owner = 'ped';
  if (c.brain && c.state !== 'inVehicle') {
    c.brain.mode = 'wander';
    c.brain.toNode = -1;
  }
}
