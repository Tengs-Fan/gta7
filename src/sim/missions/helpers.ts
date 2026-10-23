// Pieces of mission scripts that more than one contact's missions share.

import type { Vehicle } from '../entities';
import type { MissionCtx } from './runner';

/** Tiburones teal: their vans and cars. */
export const TIBURONES = 0x0e7c7b;

/**
 * The car a mission ends in, the moment it is accepted, with the player about to be locked inside it: its fire
 * is put out (it would blow up with him in it) and it is stopped dead (the lock leaves him only the handbrake).
 */
export function secureCar(v: Vehicle | null): void {
  if (!v || v.removed || v.destroyed) return;
  v.burning = false;
  v.burnTimer = 0;
  // At <= 0 HP any stray hit would set it alight again.
  v.health = Math.max(v.health, 1);
  v.vel.x = 0;
  v.vel.z = 0;
  v.angVel = 0;
  v.controls.handbrake = true;
}

/** Explain a foot-only objective when a driver reaches it, then restore the route instruction on leaving. */
export function guideOnFoot(m: MissionCtx, target: { x: number; z: number }, travel: string, arrive: string): number {
  const show = () => {
    const text = m.sim.player.vehicle && m.sim.distToPlayer(target.x, target.z) < 18 ? arrive : travel;
    if (m.objectiveText !== text) m.objective(text);
  };
  show();
  return m.watch(show);
}
