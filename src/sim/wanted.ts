// Wanted level: crimes generate heat, heat maps to stars, and breaking line of
// sight with the police for long enough clears it.

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
  assaultCop: { heat: 150, witness: 'none', minLevel: 1 },
  murder: { heat: 140, witness: 'none', minLevel: 1 },
  killGang: { heat: 60, witness: 'cop', minLevel: 1 },
  killCop: { heat: 480, witness: 'none', minLevel: 2 },
  gunfire: { heat: 25, witness: 'cop', minLevel: 1 },
  explosion: { heat: 90, witness: 'none', minLevel: 1 },
  destroyVehicle: { heat: 60, witness: 'cop', minLevel: 1 },
  destroyPolice: { heat: 520, witness: 'none', minLevel: 2 },
  hitPolice: { heat: 40, witness: 'none', minLevel: 1 },
};

/** Heat needed for each star (index = stars). */
export const STAR_HEAT = [0, 1, 260, 720, 1500, 3000] as const;
export const MAX_STARS = 5;

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

  constructor(private readonly sim: Sim) {}

  evadeTime(level = this.level): number {
    return 9 + level * 5;
  }

  /** Reports a crime by the player at (x, z). */
  crime(type: CrimeType, x: number, z: number): void {
    const sim = this.sim;
    if (!sim.policeEnabled || sim.cheats.neverWanted || sim.playerDown) return;
    const def = CRIMES[type];
    if (def.witness === 'cop' && !this.copWitness(x, z)) return;
    this.heat += def.heat;
    let lvl = 0;
    for (let s = MAX_STARS; s >= 1; s--) {
      if (this.heat >= STAR_HEAT[s]) {
        lvl = s;
        break;
      }
    }
    lvl = Math.max(lvl, def.minLevel, this.level);
    this.heat = Math.max(this.heat, STAR_HEAT[lvl]);
    this.see(x, z);
    this.apply(Math.min(MAX_STARS, lvl));
  }

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

  private apply(level: number, force = false): void {
    if (level === this.level) return;
    if (!force && level < this.level) return;
    const prev = this.level;
    this.level = level;
    this.searching = false;
    if (level > this.sim.progress.stats.maxWanted) this.sim.progress.stats.maxWanted = level;
    this.sim.events.emit('wanted', { level, previous: prev });
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

  /** Any police officer, patrol car or helicopter that can see (x, z)? */
  copWitness(x: number, z: number, range = 48): boolean {
    const sim = this.sim;
    for (const c of sim.characters) {
      if (c.removed || !c.isLaw || !c.alive) continue;
      const p = c.vehicle ? c.vehicle.pos : c.pos;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > range) continue;
      if (d < 8 || sim.world.lineOfSight(p.x, p.y + 1.6, p.z, x, sim.world.groundHeight(x, z) + 1.2, z)) return true;
    }
    for (const h of sim.helis) {
      if (h.removed || h.destroyed || Math.hypot(h.pos.x - x, h.pos.z - z) >= 110) continue;
      if (sim.world.lineOfSight(h.pos.x, h.pos.y, h.pos.z, x, sim.world.groundHeight(x, z) + 1.2, z)) return true;
    }
    return false;
  }

  update(dt: number): void {
    const sim = this.sim;
    if (this.floor > this.level && !sim.playerDown) this.setLevel(this.floor);
    if (this.level === 0 || sim.playerDown) return;
    this.sightTimer -= dt;
    if (this.sightTimer <= 0) {
      this.sightTimer = 0.3;
      const pp = sim.playerPos();
      if (this.copWitness(pp.x, pp.z, 80)) this.see(pp.x, pp.z);
    }
    const unseen = sim.time - this.lastSeen;
    this.searching = unseen > 2.5;
    // The evasion clock only counts once the player has left the search area
    // around their last known position (or after a long time hiding).
    const pp = sim.playerPos();
    const away = Math.hypot(pp.x - this.lastSeenX, pp.z - this.lastSeenZ) > this.searchRadius();
    if (away) this.evadeClock += dt;
    if ((this.evadeClock > this.evadeTime() || unseen > this.evadeTime() * 2.6) && this.floor === 0) {
      this.heat = 0;
      this.apply(0, true);
      sim.events.emit('message', { text: 'You lost the cops.', duration: 3 });
    }
  }
}
