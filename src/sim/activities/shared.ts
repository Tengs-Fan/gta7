import type { Character } from '../entities';

/** Hands a mission-tagged character back to the ambient systems. */
export function releaseCharacter(c: Character): void {
  c.persistent = false;
  c.missionTag = '';
  c.owner = 'ped';
  if (c.state === 'inVehicle') return;
  if (c.brain) {
    c.brain.hostile = false;
    // Someone running from danger (a fare out of a burning cab) keeps running.
    if (c.brain.mode !== 'flee') {
      c.brain.mode = 'wander';
      c.brain.toNode = -1;
    }
  }
}
