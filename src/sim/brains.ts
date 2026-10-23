// AI state for on-foot NPCs (civilians, gangs, cops). Behaviour lives in peds.ts / police.ts.

import type { Character, Vehicle } from './entities';

export type PedMode =
  | 'wander' // follow the sidewalk graph
  | 'cross' // waiting to use a crosswalk
  | 'idle'
  | 'flee'
  | 'cower'
  | 'fight' // melee / shoot a target
  | 'guard' // stand around a post, attack the player when provoked or close
  | 'chase' // cops: run to the player
  | 'return' // cops: walk back to their car
  | 'stand' // mission characters waiting for something
  | 'phone'; // a witness on the phone to the police (see witnesses.ts)

export interface PedBrain {
  mode: PedMode;
  /** Sidewalk graph edge being walked. */
  fromNode: number;
  toNode: number;
  /** Sideways offset from the sidewalk centre line. */
  lateral: number;
  waitTimer: number;
  modeTimer: number;
  threat: Character | null;
  threatX: number;
  threatZ: number;
  target: Character | null;
  /** Fights back instead of fleeing. */
  brave: boolean;
  /** Always hostile to the player (gang members on a mission, rampage targets). */
  hostile: boolean;
  speedMul: number;
  car: Vehicle | null;
  homeX: number;
  homeZ: number;
  /** Cops: the spot being checked while searching for a player who got away. */
  searchX: number;
  searchZ: number;
  /** Shooting accuracy 0..1. */
  accuracy: number;
  burst: number;
  stuckTimer: number;
  lastX: number;
  lastZ: number;
  /**
   * Gunmen on foot: the way (1 or -1; 0 before the first) they last side-stepped for a clear line of fire, and whether
   * they have turned back since they last had one or went after the target (see PedSystem.stepSide).
   */
  stepSide: number;
  stepTurned: boolean;
  /**
   * Gang members (gangs.ts): when they turned on the player for coming armed into their turf (-Infinity: not so), and
   * whether he attacked them or their crew (then leaving the turf does not calm them).
   */
  turfAggroAt: number;
  provoked: boolean;
  /** A driver who got out of his car angry after the player hit it (angryDrivers.ts), and the car he left. */
  angryCar: Vehicle | null;
}

export function makeBrain(mode: PedMode): PedBrain {
  return {
    mode,
    fromNode: -1,
    toNode: -1,
    lateral: 0,
    waitTimer: 0,
    modeTimer: 0,
    threat: null,
    threatX: 0,
    threatZ: 0,
    target: null,
    brave: false,
    hostile: false,
    speedMul: 1,
    car: null,
    homeX: 0,
    homeZ: 0,
    searchX: 0,
    searchZ: 0,
    accuracy: 0.5,
    burst: 0,
    stuckTimer: 0,
    lastX: 0,
    lastZ: 0,
    stepSide: 0,
    stepTurned: false,
    turfAggroAt: -Infinity,
    provoked: false,
    angryCar: null,
  };
}
