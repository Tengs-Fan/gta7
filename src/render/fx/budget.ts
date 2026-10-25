// Per-tier caps of the explosion, fire and smoke effects (Effects.setTier). Pools are sized for High once; a lower
// tier only lowers the caps, so switching tiers allocates nothing and frees nothing.

export type FxTier = 'high' | 'medium' | 'low' | 'software';

export interface FxBudget {
  /** Fireballs alive at once (each a cluster of volume puffs). */
  fireballs: number;
  /** Volume puffs per fireball. */
  fireballPuffs: number;
  /** Simulated volume puffs alive at once: flames, smoke plumes, blast dust. */
  puffs: number;
  /** Debris pieces alive at once, and how many a vehicle explosion throws. */
  debris: number;
  vehicleDebris: number;
  /** Spark streaks (and the other glow sprites: flashes, embers) alive at once. */
  sparks: number;
  /** Scorch decals alive at once. */
  scorches: number;
  /** Emission rate scale of smoke plumes and flames (1 = High). */
  plumeRate: number;
  /** Debris casts shadows. */
  debrisShadows: boolean;
}

export const FX_BUDGETS: Readonly<Record<FxTier, Readonly<FxBudget>>> = {
  high: { fireballs: 12, fireballPuffs: 14, puffs: 1600, debris: 64, vehicleDebris: 12, sparks: 2500, scorches: 24, plumeRate: 1, debrisShadows: true },
  medium: { fireballs: 10, fireballPuffs: 11, puffs: 1100, debris: 48, vehicleDebris: 10, sparks: 2000, scorches: 18, plumeRate: 0.7, debrisShadows: true },
  low: { fireballs: 8, fireballPuffs: 8, puffs: 650, debris: 32, vehicleDebris: 9, sparks: 1300, scorches: 12, plumeRate: 0.45, debrisShadows: false },
  software: { fireballs: 6, fireballPuffs: 6, puffs: 360, debris: 20, vehicleDebris: 8, sparks: 800, scorches: 8, plumeRate: 0.3, debrisShadows: false },
};

/** The largest cap of each pool over all tiers: what the pools are built with. */
export const FX_POOL_SIZES = {
  fireballs: Math.max(...Object.values(FX_BUDGETS).map((b) => b.fireballs)),
  fireballPuffs: Math.max(...Object.values(FX_BUDGETS).map((b) => b.fireballPuffs)),
  puffs: Math.max(...Object.values(FX_BUDGETS).map((b) => b.puffs)),
  debris: Math.max(...Object.values(FX_BUDGETS).map((b) => b.debris)),
  sparks: Math.max(...Object.values(FX_BUDGETS).map((b) => b.sparks)),
  scorches: Math.max(...Object.values(FX_BUDGETS).map((b) => b.scorches)),
} as const;

/**
 * What each effect and the gun models look like per tier (docs/graphics.md "Effects and weapons" has the same rows; a
 * unit test keeps them equal). Cells read High / Medium / Low / software.
 */
export const FX_TIERS: Readonly<Record<string, Readonly<Record<FxTier, string>>>> = {
  guns: { high: 'modelled, lit, shadows', medium: 'modelled, lit, shadows', low: 'modelled, lit', software: 'modelled, vertex-lit' },
  fireball: { high: '14 noise puffs, HDR core', medium: '11 noise puffs, HDR core', low: '8 noise puffs', software: '6 noise puffs' },
  flames: { high: 'noise puffs + embers', medium: 'noise puffs (0.7x) + embers', low: 'noise puffs (0.45x) + embers', software: 'noise puffs (0.3x) + embers' },
  smoke: { high: 'dense plume, 1600 puffs cap', medium: 'plume 0.7x, 1100 cap', low: 'plume 0.45x, 650 cap', software: 'plume 0.3x, 360 cap' },
  debris: { high: '12 per car, 64 cap, shadows', medium: '10 per car, 48 cap, shadows', low: '9 per car, 32 cap', software: '8 per car, 20 cap' },
  sparks: { high: 'streaks, 2500 cap', medium: 'streaks, 2000 cap', low: 'streaks, 1300 cap', software: 'streaks, 800 cap' },
  scorch: { high: 'draped decal, 24 cap', medium: 'draped decal, 18 cap', low: 'draped decal, 12 cap', software: 'draped decal, 8 cap' },
  wreck: { high: 'burnt material (soot, char, bare metal)', medium: 'burnt material', low: 'burnt material', software: 'burnt material, vertex-lit' },
};
