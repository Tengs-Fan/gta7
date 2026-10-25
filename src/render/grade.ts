// Time-of-day colour grade applied by FinishPass in linear HDR, before three's ACES tone mapping.
// Pure and three-free. Keys are spaced so no parameter moves more than 1e-3 per game minute.

export interface GradeWeather {
  cloud: number;
  rain: number;
  storm: number;
}

export interface Grade {
  /** White balance; FinishPass normalises it to unit luminance, so it shifts hue, not brightness. */
  tint: [number, number, number];
  sat: number;
  /** Exponent of a log-space contrast curve around mid grey (0.18). */
  contrast: number;
  /** Corner darkening, 0..1. */
  vignette: number;
  /** Cool shadows / warm highlights, as a mix amount. */
  splitTone: number;
  /**
   * Night black level: scene-linear light added before tone mapping (in a cool moonlit grey), so dark asphalt and
   * shadows read as surfaces at night instead of the ACES toe's black. 0 by day.
   */
  lift: number;
}

export const CLEAR_WEATHER: Readonly<GradeWeather> = { cloud: 0, rain: 0, storm: 0 };

interface Key {
  h: number;
  sat: number;
  contrast: number;
  tint: readonly [number, number, number];
  vignette: number;
  splitTone: number;
  lift: number;
}

/** Night black level (Grade.lift) at full night. */
export const NIGHT_LIFT = 0.0165;

const NIGHT = { sat: 0.92, contrast: 1.06, tint: [0.95, 0.99, 1.06], vignette: 0.26, splitTone: 0.04, lift: NIGHT_LIFT } as const;
const DAY = { sat: 1.03, contrast: 1.02, tint: [1, 1, 1], vignette: 0.1, splitTone: 0, lift: 0 } as const;

// The golden hour leans yellow (green kept up against red and blue) rather than towards magenta, and saturates less:
// the low sun's red sky already colours the scene.
const KEYS: readonly Key[] = [
  { h: 0, ...NIGHT },
  { h: 3.5, ...NIGHT },
  { h: 6, sat: 1.04, contrast: 1.03, tint: [1.03, 1.01, 0.95], vignette: 0.18, splitTone: 0.03, lift: 0.002 },
  { h: 9, ...DAY },
  { h: 16, ...DAY },
  { h: 18.4, sat: 0.98, contrast: 1.04, tint: [0.99, 1.04, 0.9], vignette: 0.15, splitTone: 0.02, lift: 0 },
  { h: 19.3, sat: 0.94, contrast: 1.05, tint: [0.95, 1.06, 0.95], vignette: 0.19, splitTone: 0.03, lift: 0.003 },
  { h: 21.2, ...NIGHT },
  { h: 24, ...NIGHT },
];

const OVERCAST = [0.97, 1, 1.03] as const;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The grade at a time of day (hours, any range) and weather (clear by default). Writes into `out` when given. */
export function gradeAt(hours: number, weather: Readonly<GradeWeather> = CLEAR_WEATHER, out?: Grade): Grade {
  const h = ((hours % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]!.h <= h) i++;
  const a = KEYS[i]!;
  const b = KEYS[i + 1]!;
  const t = clamp01((h - a.h) / (b.h - a.h));
  const cloud = clamp01(weather.cloud);
  const rain = clamp01(weather.rain);
  const storm = clamp01(weather.storm);
  const g = out ?? { tint: [1, 1, 1], sat: 1, contrast: 1, vignette: 0, splitTone: 0, lift: 0 };
  const toward = 0.6 * cloud;
  for (let c = 0; c < 3; c++) g.tint[c] = lerp(lerp(a.tint[c]!, b.tint[c]!, t), OVERCAST[c]!, toward);
  g.sat = lerp(a.sat, b.sat, t) * (1 - 0.15 * cloud) * (1 - 0.05 * storm);
  g.contrast = lerp(a.contrast, b.contrast, t) * (1 - 0.05 * cloud);
  g.vignette = lerp(a.vignette, b.vignette, t) + 0.05 * rain + 0.03 * storm;
  g.splitTone = lerp(a.splitTone, b.splitTone, t);
  // A cloud deck lit by the city is already brighter than a clear night sky: a little less lift under it.
  g.lift = lerp(a.lift, b.lift, t) * (1 - 0.1 * cloud);
  return g;
}
