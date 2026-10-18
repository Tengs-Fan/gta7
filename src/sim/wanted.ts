// Wanted level: crimes generate heat, heat maps to stars, and breaking line of
// sight with the police for long enough clears it.

import { clamp } from '../core/math';
import { darkness } from './clock';
import type { Helicopter } from './entities';
import type { Sim } from './sim';

export type CrimeType =
  | 'carjack'
  | 'stealPoliceCar'
  | 'hitPed'
  | 'assault'
  | 'assaultCop'
  | 'murder'
  | 'killGang'
  | 'killCop'
  | 'gunfire'
  | 'explosion'
  | 'destroyVehicle'
  | 'destroyPolice'
  | 'hitPolice';

interface CrimeDef {
  heat: number;
  /** 'cop': only counts when the police witness it. 'none': always reported. */
  witness: 'cop' | 'none';
  minLevel: number;
}

export const CRIMES: Readonly<Record<CrimeType, CrimeDef>> = {
  carjack: { heat: 70, witness: 'cop', minLevel: 1 },
  stealPoliceCar: { heat: 300, witness: 'none', minLevel: 2 },
  hitPed: { heat: 50, witness: 'cop', minLevel: 1 },
  assault: { heat: 40, witness: 'cop', minLevel: 1 },
  assaultCop: { heat: 70, witness: 'none', minLevel: 1 },
  murder: { heat: 140, witness: 'none', minLevel: 1 },
  killGang: { heat: 60, witness: 'cop', minLevel: 1 },
  killCop: { heat: 300, witness: 'none', minLevel: 2 },
  gunfire: { heat: 25, witness: 'cop', minLevel: 1 },
  explosion: { heat: 90, witness: 'none', minLevel: 1 },
  destroyVehicle: { heat: 60, witness: 'cop', minLevel: 1 },
  destroyPolice: { heat: 520, witness: 'none', minLevel: 2 },
  hitPolice: { heat: 40, witness: 'none', minLevel: 1 },
};

/** Crimes against the police themselves: officers shoot back at any level for a while (see PoliceSystem). */
const COP_ASSAULTS: ReadonlySet<CrimeType> = new Set<CrimeType>(['assaultCop', 'killCop', 'hitPolice']);

/** Heat needed for each star (index = stars). */
export const STAR_HEAT = [0, 1, 260, 720, 1500, 3000] as const;
export const MAX_STARS = 5;
/** Crimes raise the level at once up to this many stars; above it, by one star per RISE_GAP seconds since the last rise. */
export const RISE_CAP_ABOVE = 2;
export const RISE_GAP = 8;
/** After every rise the units called in know where the player is for RESPONSE_BASE + RESPONSE_PER_STAR * stars seconds. */
export const RESPONSE_BASE = 4;
export const RESPONSE_PER_STAR = 3;
/** Hiding inside the search area clears the stars too, after this many times the evade time. */
const HIDE_FACTOR = 2.6;
/** How far (m) officers see the player, in a car or on foot, given a clear line of sight. */
export const COP_SIGHT = 80;
/**
 * How far (m, along the ground) the helicopter crew sees (see heliSees): a car that outruns the helicopter
 * gets away from it. At night they make out only what is close below (HELI_NIGHT_SIGHT, straight-line) or in
 * the spotlight (within SPOT_SEE of its centre).
 */
export const HELI_SIGHT = 60;
export const HELI_NIGHT_SIGHT = 60;
/** Radius (m) of the spotlight's pool of light on the ground (markers.ts draws it this size). */
export const SPOT_RADIUS = 5;
/**
 * The darkness (sim/clock.ts darkness) from which the helicopter shines its spotlight (markers.ts draws the beam from
 * then on) and its crew sees as at night (see heliSees): from about 18:53 to 06:02.
 */
export const SPOTLIGHT_DARK = 0.25;
/**
 * At night the crew makes out anything within this distance (m) of the spotlight's centre: the pool and its
 * glare. Close below the helicopter they see without it too (HELI_NIGHT_SIGHT).
 */
export const SPOT_SEE = 2 * SPOT_RADIUS;
/**
 * Seconds unseen outside the search area that lose the stars, per level (index = stars). The P10 fallback table:
 * 9 + 5 per star left 1-star escapes sticky (a flee-bot median of 29-30 s over 21 seeds, at the 30 s bound).
 */
const EVADE_TIME = [0, 10, 18, 28, 40, 55] as const;

export class WantedSystem {
  level = 0;
  heat = 0;
  lastSeen = -999;
  lastSeenX = 0;
  lastSeenZ = 0;
  /** True while the police have lost sight of the player (stars flash). */
  searching = false;
  private sightTimer = 0;
  /** Missions can pin a minimum wanted level (e.g. during a heist). */
  floor = 0;
  /** Seconds spent unseen outside the search area. */
  private evadeClock = 0;
  /** Sim time until which the police know where the player is: the response phase after the level rises. */
  responseUntil = -Infinity;
  /** Sim time of the player's last attack on the police (assaultCop, killCop, hitPolice). */
  lastCopAssaultAt = -Infinity;
  /** The most serious crime reported in the latest frame that had one, this chase (the dispatcher names it). */
  lastCrime: CrimeType | null = null;
  private lastCrimeFrame = -1;
  /** Sim time of the last rise of the level, whatever raised it. */
  private lastRiseAt = -Infinity;
  /** How many times the player has shaken the police off. */
  evasions = 0;

  constructor(private readonly sim: Sim) {}

  evadeTime(level = this.level): number {
    return EVADE_TIME[Math.max(0, Math.min(MAX_STARS, Math.round(level)))]!;
  }

  /** Reports a crime by the player at (x, z). */
  crime(type: CrimeType, x: number, z: number): void {
    const sim = this.sim;
    if (!sim.policeEnabled || sim.cheats.neverWanted || sim.playerDown) return;
    const def = CRIMES[type];
    if (def.witness === 'cop' && !this.copWitness(x, z)) return;
    if (this.lastCrime === null || this.lastCrimeFrame !== sim.frame || def.heat >= CRIMES[this.lastCrime].heat) {
      this.lastCrime = type;
      this.lastCrimeFrame = sim.frame;
    }
    if (COP_ASSAULTS.has(type)) this.lastCopAssaultAt = sim.time;
    this.heat = Math.max(this.heat + def.heat, STAR_HEAT[Math.max(def.minLevel, this.level)]);
    this.see(x, z);
    this.rise(Math.max(this.heatLevel(), def.minLevel));
  }

  /** Sets the level directly (missions, cheats, tests): no step-by-step rise. */
  setLevel(level: number): void {
    const lvl = Math.max(0, Math.min(MAX_STARS, Math.round(level)));
    this.heat = STAR_HEAT[lvl];
    const pp = this.sim.playerPos();
    this.see(pp.x, pp.z);
    this.apply(lvl, true);
  }

  /** Drops the wanted level, but never below a mission's floor (missions reset the floor themselves). */
  clear(): void {
    this.heat = STAR_HEAT[this.floor];
    this.apply(this.floor, true);
  }

  /** Stars the heat is worth. */
  private heatLevel(): number {
    for (let s = MAX_STARS; s >= 1; s--) if (this.heat >= STAR_HEAT[s]) return s;
    return 0;
  }

  /**
   * Raises the level towards `want`: up to RISE_CAP_ABOVE stars at once, above that one star at a time,
   * at least RISE_GAP seconds after the last rise (update() applies the rest of the heat later).
   */
  private rise(want: number): void {
    const target = Math.min(MAX_STARS, want);
    if (target <= this.level) return;
    if (target <= RISE_CAP_ABOVE) this.apply(target);
    else if (this.level < RISE_CAP_ABOVE) this.apply(RISE_CAP_ABOVE);
    else if (this.sim.time - this.lastRiseAt >= RISE_GAP) this.apply(this.level + 1);
  }

  private apply(level: number, force = false): void {
    if (level === this.level) return;
    if (!force && level < this.level) return;
    const prev = this.level;
    const sim = this.sim;
    this.level = level;
    this.searching = false;
    if (level > prev) {
      this.lastRiseAt = sim.time;
      this.responseUntil = sim.time + RESPONSE_BASE + RESPONSE_PER_STAR * level;
    } else if (level === 0) {
      this.responseUntil = -Infinity;
      this.lastCrime = null;
    }
    if (level > sim.progress.stats.maxWanted) sim.progress.stats.maxWanted = level;
    sim.events.emit('wanted', { level, previous: prev });
  }

  private see(x: number, z: number): void {
    this.lastSeen = this.sim.time;
    this.lastSeenX = x;
    this.lastSeenZ = z;
    this.searching = false;
    this.evadeClock = 0;
  }

  /** Radius of the police search area around the last sighting. */
  searchRadius(level = this.level): number {
    return 60 + level * 25;
  }

  /** Centre of the search area: the last sighting. */
  get searchCenter(): { x: number; z: number } {
    return { x: this.lastSeenX, z: this.lastSeenZ };
  }

  /** The player is beyond the search area around his last sighting. */
  get outside(): boolean {
    const pp = this.sim.playerPos();
    return Math.hypot(pp.x - this.lastSeenX, pp.z - this.lastSeenZ) > this.searchRadius();
  }

  /** The response phase after a rise: the police know where the player is, so he cannot slip away yet. */
  get inResponse(): boolean {
    return this.level > 0 && this.sim.time < this.responseUntil;
  }

  /**
   * How far the player is towards losing the stars, 0..1: unseen outside the search area for the evade
   * time, or unseen anywhere for HIDE_FACTOR times as long. 0 right after a sighting, during the response
   * phase and while a mission pins the level; the stars clear the moment it reaches 1.
   */
  evadeProgress(): number {
    if (this.level === 0 || this.floor > 0 || this.inResponse) return 0;
    return clamp(this.evadeRatio(), 0, 1);
  }

  private evadeRatio(): number {
    const t = this.evadeTime();
    return Math.max(this.evadeClock / t, (this.sim.time - this.lastSeen) / (HIDE_FACTOR * t));
  }

  /**
   * Any police officer, patrol car or helicopter that can see (x, z)? Officers within `range`, the helicopter within
   * HELI_SIGHT. Officers within `near` notice what happens there through a wall too (they hear a crime that close).
   */
  copWitness(x: number, z: number, range = 48, near = 8): boolean {
    const sim = this.sim;
    const gy = sim.world.groundHeight(x, z) + 1.2;
    for (const c of sim.characters) {
      if (c.removed || !c.isLaw || !c.alive) continue;
      const p = c.vehicle ? c.vehicle.pos : c.pos;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > range) continue;
      if (d < near || sim.world.lineOfSight(p.x, p.y + 1.6, p.z, x, gy, z)) return true;
    }
    for (const h of sim.helis) if (this.heliSees(h, x, z)) return true;
    return false;
  }

  /**
   * Can the crew of helicopter `h` make out (x, z)? Within HELI_SIGHT along the ground, with a clear line of
   * sight; at night (from SPOTLIGHT_DARK, while the beam is drawn) only in the spotlight (within SPOT_SEE of its
   * centre) or close below (HELI_NIGHT_SIGHT).
   */
  heliSees(h: Helicopter, x: number, z: number): boolean {
    const sim = this.sim;
    if (h.removed || h.destroyed || Math.hypot(h.pos.x - x, h.pos.z - z) > HELI_SIGHT) return false;
    const gy = sim.world.groundHeight(x, z) + 1.2;
    if (darkness(sim.clock.hours) > SPOTLIGHT_DARK && Math.hypot(h.spotlight.x - x, h.spotlight.z - z) > SPOT_SEE && Math.hypot(h.pos.x - x, h.pos.y - gy, h.pos.z - z) > HELI_NIGHT_SIGHT) return false;
    return sim.world.lineOfSight(h.pos.x, h.pos.y - 1.5, h.pos.z, x, gy, z);
  }

  update(dt: number): void {
    const sim = this.sim;
    if (this.floor > this.level && !sim.playerDown) this.setLevel(this.floor);
    if (this.level === 0 || sim.playerDown) return;
    const pp = sim.playerPos();
    if (sim.time < this.responseUntil) {
      // The units just called in are told where he is.
      this.see(pp.x, pp.z);
    } else {
      this.sightTimer -= dt;
      if (this.sightTimer <= 0) {
        this.sightTimer = 0.3;
        // Only in sight: an officer on the far side of a wall, however near, does not see where the player hides (one
        // holding off from an armed player there kept the stars up for ever, never flashing, see PoliceSystem STANDOFF).
        if (this.copWitness(pp.x, pp.z, COP_SIGHT, 0)) this.see(pp.x, pp.z);
      }
    }
    this.searching = sim.time - this.lastSeen > 2.5;
    // Heat that came in faster than the stars may rise: the next star once the police have him in sight.
    if (!this.searching && this.level >= RISE_CAP_ABOVE && this.heatLevel() > this.level && sim.time - this.lastRiseAt >= RISE_GAP) this.apply(this.level + 1);
    // The evasion clock only counts once the player has left the search area
    // around their last known position (or after a long time hiding).
    if (this.outside) this.evadeClock += dt;
    if (this.evadeRatio() >= 1 && this.floor === 0) {
      this.heat = 0;
      this.evasions++;
      this.apply(0, true);
      sim.events.emit('message', { text: 'You lost the cops.', duration: 3 });
    }
  }
}
