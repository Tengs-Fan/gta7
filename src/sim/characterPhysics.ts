// On-foot locomotion and collisions for characters (player and NPCs).

import { circleVsAabb, circleVsObb, makeContact, type Contact, type OBB } from '../core/collision';
import { clamp } from '../core/math';
import { GRAVITY, SWIM_DEPTH, WATER_Y } from '../world/constants';
import type { StaticWorld } from '../world/staticWorld';
import type { Character, Vehicle } from './entities';
import { gaitPhaseStep } from './pose';
import { vehicleObb } from './vehiclePhysics';

/** The highest step (m) a character on foot walks up; higher ground stops him (the side of a deck from the sand). */
export const MAX_STEP = 0.55;
/** Swimmers float with the body this far below the water surface. */
export const SWIM_FLOAT = 1.3;
/**
 * Top swimming speeds (m/s): the player's crawl, and a little slower for NPCs, so a swimmer can hold his distance from
 * those after him (on land he outsprints them too). Whatever pace an AI asks for, running after someone, it swims at this.
 */
export const SWIM_SPEED = 2.4;
export const NPC_SWIM_SPEED = 2.2;

export interface CharacterPhysicsHost {
  world: StaticWorld;
  onCharacterHitByVehicle(c: Character, v: Vehicle, relSpeed: number, nx: number, nz: number): void;
  onCharacterLanded(c: Character, fallSpeed: number): void;
  onCharacterSplash(c: Character): void;
}

const contact: Contact = makeContact();
const obb: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };

export function stepCharacter(c: Character, dt: number, host: CharacterPhysicsHost): void {
  if (c.removed || c.state === 'inVehicle' || c.state === 'entering') return;
  const world = host.world;
  const controllable = c.state === 'normal' || c.state === 'swimming';

  if (controllable) {
    const top = c.state === 'swimming' ? Math.min(c.moveSpeed, c.isPlayer ? SWIM_SPEED : NPC_SWIM_SPEED) : c.moveSpeed;
    const tx = c.moveX * top;
    const tz = c.moveZ * top;
    const accel = c.state === 'swimming' ? 7 : c.onGround ? 30 : 7;
    const dvx = tx - c.vel.x;
    const dvz = tz - c.vel.z;
    const dl = Math.hypot(dvx, dvz);
    const md = accel * dt;
    if (dl <= md) {
      c.vel.x = tx;
      c.vel.z = tz;
    } else {
      c.vel.x += (dvx / dl) * md;
      c.vel.z += (dvz / dl) * md;
    }
    if (c.wantJump && c.onGround && c.state === 'normal') {
      c.vel.y = 7.4;
      c.onGround = false;
    }
  } else if (c.onGround) {
    // Knocked down or dead: slide to a stop.
    const k = Math.exp(-7 * dt);
    c.vel.x *= k;
    c.vel.z *= k;
  }
  c.wantJump = false;

  const oldX = c.pos.x;
  const oldZ = c.pos.z;
  let nx = c.pos.x + c.vel.x * dt;
  let nz = c.pos.z + c.vel.z * dt;
  const gyNew = world.groundHeight(nx, nz);
  if (c.state === 'swimming') {
    // Climb out where the shore or a quay is low enough above the water.
    if (gyNew > WATER_Y + 0.05) {
      if (gyNew - WATER_Y < 1.7) {
        c.state = 'normal';
        c.pos.y = gyNew;
        c.vel.y = 0;
        c.onGround = true;
        c.swimTime = 0;
      } else {
        nx = oldX;
        nz = oldZ;
      }
    }
  } else if (gyNew > c.pos.y + MAX_STEP) {
    nx = oldX;
    nz = oldZ;
    c.vel.x = 0;
    c.vel.z = 0;
  }
  c.pos.x = nx;
  c.pos.z = nz;

  const gy = world.groundHeight(c.pos.x, c.pos.z);
  const depth = WATER_Y - gy;
  if (c.state === 'swimming') {
    c.pos.y = WATER_Y - SWIM_FLOAT;
    c.vel.y = 0;
    c.onGround = true;
    c.swimTime += dt;
    if (depth < SWIM_DEPTH) {
      c.state = 'normal';
      c.swimTime = 0;
    }
  } else {
    c.vel.y -= GRAVITY * dt;
    c.pos.y += c.vel.y * dt;
    if (c.pos.y <= gy) {
      const fall = -c.vel.y;
      c.pos.y = gy;
      c.vel.y = 0;
      if (!c.onGround) host.onCharacterLanded(c, fall);
      c.onGround = true;
    } else if (c.pos.y > gy + 0.25) {
      c.onGround = false;
    } else if (c.onGround && c.vel.y <= 0) {
      // Small step down (curb) while walking: stick to the ground. Falls land in the branch above.
      c.pos.y = gy;
      c.vel.y = 0;
      c.onGround = true;
    }
    if (depth > SWIM_DEPTH && c.pos.y < WATER_Y - SWIM_FLOAT + 0.3) {
      // A knocked body can never land in deep water, so the water ends the knock.
      if (c.state === 'normal' || c.state === 'knocked') {
        c.state = 'swimming';
        c.knockTimer = 0;
        c.swimTime = 0;
        // Hitting the water kills most horizontal speed (no long glide after a fast bail).
        c.vel.x *= 0.35;
        c.vel.z *= 0.35;
        host.onCharacterSplash(c);
      }
      if (c.state === 'swimming') c.pos.y = WATER_Y - SWIM_FLOAT;
      else c.pos.y = Math.max(c.pos.y, WATER_Y - SWIM_FLOAT - 0.4);
      c.vel.y = 0;
      // The water carries the body: floating corpses slow down like bodies on the ground.
      c.onGround = true;
    }
  }

  const b = world.bounds;
  c.pos.x = clamp(c.pos.x, b.worldMinX + 3, b.worldMaxX - 3);
  c.pos.z = clamp(c.pos.z, b.worldMinZ + 3, b.worldMaxZ - 3);

  c.speed = Math.hypot(c.vel.x, c.vel.z);
  c.animPhase += gaitPhaseStep(c.speed, dt);
  if (c.animPhase > 1e6) c.animPhase = 0;
}

export function collideCharacterStatic(c: Character, world: StaticWorld): void {
  if (c.removed || c.state === 'inVehicle' || c.state === 'entering') return;
  const r = c.state === 'dead' || c.state === 'knocked' ? 0.3 : c.radius;
  const bottom = c.pos.y + 0.35;
  const top = c.pos.y + c.height;
  world.grid.query(c.pos.x - r, c.pos.z - r, c.pos.x + r, c.pos.z + r, (col) => {
    if (col.y1 < bottom || col.y0 > top) return;
    let hit: boolean;
    if (col.circle) {
      const dx = c.pos.x - col.cx;
      const dz = c.pos.z - col.cz;
      const rr = r + col.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) return;
      const d = Math.sqrt(d2) || 1e-6;
      contact.nx = d > 1e-6 ? dx / d : 1;
      contact.nz = d > 1e-6 ? dz / d : 0;
      contact.depth = rr - d;
      hit = true;
    } else {
      hit = circleVsAabb(c.pos.x, c.pos.z, r, col, contact);
    }
    if (!hit) return;
    c.pos.x += contact.nx * contact.depth;
    c.pos.z += contact.nz * contact.depth;
    const vn = c.vel.x * contact.nx + c.vel.z * contact.nz;
    if (vn < 0) {
      c.vel.x -= vn * contact.nx;
      c.vel.z -= vn * contact.nz;
    }
  });
}

/** Character vs vehicle: vehicles push characters away and run them over when fast. */
export function collideCharactersVehicles(chars: Character[], vehicles: Vehicle[], host: CharacterPhysicsHost): void {
  for (const v of vehicles) {
    if (v.removed) continue;
    const rv = Math.hypot(v.halfW, v.halfL) + 0.5;
    vehicleObb(v, obb);
    for (const c of chars) {
      if (c.removed || c.state === 'inVehicle' || c.state === 'entering' || c.state === 'dead') continue;
      const dx = c.pos.x - v.pos.x;
      const dz = c.pos.z - v.pos.z;
      if (dx * dx + dz * dz > rv * rv) continue;
      if (c.pos.y > v.pos.y + v.spec.height || c.pos.y + c.height < v.pos.y + 0.1) continue;
      if (!circleVsObb(c.pos.x, c.pos.z, c.radius, obb, contact)) continue;
      // Velocity of the vehicle at the contact point, towards the character.
      const px = contact.px - v.pos.x;
      const pz = contact.pz - v.pos.z;
      const vpx = v.vel.x + v.angVel * pz;
      const vpz = v.vel.z - v.angVel * px;
      // Only the vehicle's own motion towards the character can run them over:
      // a character sprinting into a parked car just stops.
      const approach = vpx * contact.nx + vpz * contact.nz;
      const vn = c.vel.x * contact.nx + c.vel.z * contact.nz;
      const rel = approach - vn;
      if (approach > 4.5 && rel > 4.5 && c.state === 'normal') {
        host.onCharacterHitByVehicle(c, v, rel, contact.nx, contact.nz);
      } else if (c.state === 'knocked' && approach > 6 && rel > 6) {
        host.onCharacterHitByVehicle(c, v, rel, contact.nx, contact.nz);
      }
      c.pos.x += contact.nx * contact.depth;
      c.pos.z += contact.nz * contact.depth;
      const vnAfter = c.vel.x * contact.nx + c.vel.z * contact.nz;
      const target = Math.max(approach, 0);
      if (vnAfter < target) {
        c.vel.x += (target - vnAfter) * contact.nx;
        c.vel.z += (target - vnAfter) * contact.nz;
      }
    }
  }
}

/** Soft separation between characters standing close together. */
export function collideCharacters(chars: Character[]): void {
  const n = chars.length;
  for (let i = 0; i < n; i++) {
    const a = chars[i]!;
    if (a.removed || !a.onFoot) continue;
    for (let j = i + 1; j < n; j++) {
      const b = chars[j]!;
      if (b.removed || !b.onFoot) continue;
      const dx = a.pos.x - b.pos.x;
      const dz = a.pos.z - b.pos.z;
      const rr = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || Math.abs(a.pos.y - b.pos.y) > 1.2) continue;
      const d = Math.sqrt(d2);
      const nx = d > 1e-6 ? dx / d : 1;
      const nz = d > 1e-6 ? dz / d : 0;
      const push = (rr - d) * 0.5;
      // The player is pushed less, so crowds cannot shove them around.
      const wa = a.isPlayer ? 0.25 : b.isPlayer ? 1.75 : 1;
      const wb = 2 - wa;
      a.pos.x += nx * push * wa;
      a.pos.z += nz * push * wa;
      b.pos.x -= nx * push * wb;
      b.pos.z -= nz * push * wb;
    }
  }
}
