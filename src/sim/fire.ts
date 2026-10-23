// Ground fires (a molotov's): a burning area that spreads from where the bottle broke for a few seconds, sets people and
// cars in it alight, and then burns out. Spread is drawn from the fire's own generator (entityRng of its id), so the same
// seed and inputs give the same fire.

import { circleVsObb, makeContact } from '../core/collision';
import type { Rng } from '../core/rng';
import { entityRng, type Character, type Vehicle } from './entities';
import type { Sim } from './sim';
import { vehicleObb } from './vehiclePhysics';

/** Radius (m) of one burning patch; a new fire starts as one patch, so this is its initial radius. */
export const FIRE_PATCH_R = 1.2;
/** The fire never reaches further than this (m) from where it started (patch edges included). */
export const FIRE_MAX_R = 5.5;
/** For this long (s) after it starts the fire spreads, one round of new patches every FIRE_SPREAD_EVERY seconds. */
export const FIRE_SPREAD_TIME = 4;
const FIRE_SPREAD_EVERY = 0.4;
/** Chance per round that a patch lights a neighbour, and how far from it (m). */
const SPREAD_CHANCE = 0.6;
const SPREAD_MIN = 1.1;
const SPREAD_MAX = 1.7;
const MAX_PATCHES = 26;
/** Each patch burns this long (s, before the cap), and every patch of a fire is out FIRE_LIFE seconds after it started. */
const PATCH_LIFE_MIN = 6;
const PATCH_LIFE_MAX = 9;
export const FIRE_LIFE = 13;
/** Someone caught in the flames burns this long (s) after leaving them, taking BURN_DPS hit points a second. */
export const BURN_SECONDS = 3.5;
export const BURN_DPS = 14;
/** A car caught in the flames burns this long (s) before it blows up. */
const CAR_BURN_MIN = 4;
const CAR_BURN_MAX = 6;

const contact = makeContact();
const obb = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };

export interface FirePatch {
  x: number;
  y: number;
  z: number;
  r: number;
  /** Seconds since it caught, and how long it burns. */
  age: number;
  life: number;
}

export class FireArea {
  removed = false;
  age = 0;
  readonly patches: FirePatch[] = [];
  private spreadClock = 0;
  readonly rng: Rng;

  constructor(
    readonly id: number,
    readonly x: number,
    readonly y: number,
    readonly z: number,
    /** Who answers for what it burns (the thrower). */
    readonly owner: Character | null,
  ) {
    this.rng = entityRng(id);
  }

  /** How far (m) from where it started the burning patches reach now (0 once out). */
  get radius(): number {
    let r = 0;
    for (const p of this.patches) if (p.age < p.life) r = Math.max(r, Math.hypot(p.x - this.x, p.z - this.z) + p.r);
    return r;
  }

  /** Patches still burning. */
  get burning(): number {
    let n = 0;
    for (const p of this.patches) if (p.age < p.life) n++;
    return n;
  }

  /** The patch burning at (x, z) within `pad` of its edge, or null. */
  patchAt(x: number, z: number, pad = 0): FirePatch | null {
    for (const p of this.patches) if (p.age < p.life && Math.hypot(p.x - x, p.z - z) < p.r + pad) return p;
    return null;
  }

  addPatch(x: number, y: number, z: number): void {
    const life = Math.min(this.rng.range(PATCH_LIFE_MIN, PATCH_LIFE_MAX), FIRE_LIFE - this.age);
    this.patches.push({ x, y, z, r: FIRE_PATCH_R, age: 0, life });
  }

  /** Advances the patches and, while it may still spread, lights neighbours; `canBurn` vets each new spot. */
  step(dt: number, canBurn: (fromX: number, fromZ: number, x: number, z: number) => number | null): void {
    this.age += dt;
    for (const p of this.patches) p.age += dt;
    if (this.age <= FIRE_SPREAD_TIME) {
      this.spreadClock += dt;
      while (this.spreadClock >= FIRE_SPREAD_EVERY) {
        this.spreadClock -= FIRE_SPREAD_EVERY;
        const n = this.patches.length;
        for (let i = 0; i < n && this.patches.length < MAX_PATCHES; i++) {
          const p = this.patches[i]!;
          if (p.age >= p.life) continue;
          // Every draw is made whatever the outcome, so one blocked spot does not shift the rest of the fire.
          const go = this.rng.chance(SPREAD_CHANCE);
          const a = this.rng.range(0, Math.PI * 2);
          const d = this.rng.range(SPREAD_MIN, SPREAD_MAX);
          if (!go) continue;
          const x = p.x + Math.sin(a) * d;
          const z = p.z + Math.cos(a) * d;
          if (Math.hypot(x - this.x, z - this.z) + FIRE_PATCH_R > FIRE_MAX_R) continue;
          if (this.patchAt(x, z, -FIRE_PATCH_R * 0.6)) continue;
          const y = canBurn(p.x, p.z, x, z);
          if (y !== null) this.addPatch(x, y, z);
        }
      }
    }
    if (this.age >= FIRE_LIFE || this.burning === 0) this.removed = true;
  }
}

/** Every ground fire, stepped with the combat system. */
export class FireSystem {
  readonly areas: FireArea[] = [];

  constructor(private readonly sim: Sim) {}

  reset(): void {
    this.areas.length = 0;
  }

  /**
   * Starts a fire on the ground at (x, y, z), set by `owner`, and at once sets alight the vehicle or the man the bottle
   * broke on. None on water (or the wet sand at its edge). Returns the fire, or null.
   */
  ignite(x: number, _y: number, z: number, owner: Character | null, vehicle: Vehicle | null = null, character: Character | null = null): FireArea | null {
    const sim = this.sim;
    if (vehicle) this.igniteVehicle(vehicle, owner, entityRng(sim.frame + vehicle.id));
    if (character) this.igniteCharacter(character, owner);
    const spot = sim.world.findFreeSpot(x, z, 0.25, 2) ?? { x, z };
    if (sim.world.waterDepth(spot.x, spot.z) > -0.15) return null;
    const area = new FireArea(sim.newId(), spot.x, sim.world.groundHeight(spot.x, spot.z), spot.z, owner);
    area.addPatch(area.x, area.y, area.z);
    this.areas.push(area);
    sim.events.emit('fireStarted', { x: area.x, y: area.y, z: area.z });
    sim.peds.onViolence(area.x, area.z, owner, 20);
    return area;
  }

  update(dt: number): void {
    const sim = this.sim;
    const world = sim.world;
    const canBurn = (fx: number, fz: number, x: number, z: number): number | null => {
      if (world.waterDepth(x, z) > -0.15 || !world.isFree(x, z, 0.3)) return null;
      const y = world.groundHeight(x, z);
      // Not through a wall, nor up or down a step it cannot run over.
      if (Math.abs(y - world.groundHeight(fx, fz)) > 0.4 || !world.lineOfSight(fx, y + 0.3, fz, x, y + 0.3, z)) return null;
      return y;
    };
    for (const a of this.areas) {
      if (a.removed) continue;
      a.step(dt, canBurn);
      if (a.removed) continue;
      for (const c of sim.characters) {
        if (c.removed || !c.alive || c.state === 'inVehicle' || c.state === 'swimming') continue;
        const p = a.patchAt(c.pos.x, c.pos.z, c.radius * 0.5);
        if (p && Math.abs(c.pos.y - p.y) < 1.5) this.igniteCharacter(c, a.owner);
      }
      for (const v of sim.vehicles) {
        if (v.removed || v.burning || v.destroyed || v.inWater) continue;
        if (Math.hypot(v.pos.x - a.x, v.pos.z - a.z) > FIRE_MAX_R + v.halfL) continue;
        vehicleObb(v, obb);
        for (const p of a.patches) {
          if (p.age >= p.life || Math.abs(v.pos.y - p.y) > 1.5) continue;
          if (circleVsObb(p.x, p.z, p.r * 0.8, obb, contact)) {
            this.igniteVehicle(v, a.owner, a.rng);
            break;
          }
        }
      }
    }
    for (let i = this.areas.length - 1; i >= 0; i--) if (this.areas[i]!.removed) this.areas.splice(i, 1);
  }

  /** Sets `c` alight (or keeps him burning) for BURN_SECONDS; the thrower is charged once per victim, as for a blow. */
  private igniteCharacter(c: Character, owner: Character | null): void {
    const sim = this.sim;
    const fresh = !(c.burnTimer > 0);
    c.burnTimer = Math.max(c.burnTimer, BURN_SECONDS);
    c.burnBy = owner;
    if (!fresh) return;
    if (!c.isPlayer && c.brain) sim.peds.flee(c, c.pos.x, c.pos.z, null);
    if (owner && owner.isPlayer && c !== owner && !c.isPlayer) {
      sim.combat.reportAttack(c, c.isLaw ? 'assaultCop' : 'assault', c.pos.x, c.pos.z, owner);
    }
  }

  private igniteVehicle(v: Vehicle, owner: Character | null, rng: Rng): void {
    if (v.burning || v.destroyed || v.inWater) return;
    this.sim.combat.igniteVehicleBy(v, rng.range(CAR_BURN_MIN, CAR_BURN_MAX), owner);
  }

  /** The fire burning at (x, z), if any. */
  fireAt(x: number, z: number): FireArea | null {
    for (const a of this.areas) if (!a.removed && a.patchAt(x, z)) return a;
    return null;
  }
}
