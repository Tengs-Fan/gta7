import { clamp, lerp, smoothstep } from '../core/math';

/**
 * The sun's light over the day, as the renderer lights the scene with it (render/environment.ts): [hour, intensity] keys
 * from midnight to midnight, straight lines in between.
 */
const SUN_KEYS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [4.8, 0],
  [6, 1],
  [7.5, 2.3],
  [8.5, 2.8],
  [12, 3.3],
  [16.5, 2.9],
  [18.4, 1.7],
  [19.4, 0.3],
  [20.6, 0],
  [24, 0],
];

/** Intensity of the sun's light at a time of day (hours, any value): 3.3 at noon, 0 at night. */
export function sunIntensity(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  let i = 0;
  while (i < SUN_KEYS.length - 2 && SUN_KEYS[i + 1]![0] <= h) i++;
  const [h0, s0] = SUN_KEYS[i]!;
  const [h1, s1] = SUN_KEYS[i + 1]!;
  return lerp(s0, s1, clamp((h - h0) / (h1 - h0), 0, 1));
}

/**
 * How dark it is at a time of day (hours, any value), 0 by day to 1 at night: the one measure of night, for the renderer
 * (the sky, the lights, the helicopter's searchlight) and the simulation (what the helicopter's crew makes out).
 */
export function darkness(hours: number): number {
  return 1 - smoothstep(0.02, 0.45, sunIntensity(hours) / 3.3);
}

/** In-game time of day. One real second is one game minute by default. */
export class GameClock {
  /** Hours since midnight, 0..24. */
  hours: number;
  day = 1;
  rate = 1 / 60;

  constructor(hours = 16) {
    this.hours = hours;
  }

  update(dt: number): void {
    this.hours += dt * this.rate;
    while (this.hours >= 24) {
      this.hours -= 24;
      this.day++;
    }
  }

  set(hours: number): void {
    this.hours = ((hours % 24) + 24) % 24;
  }

  advance(hours: number): void {
    this.hours += hours;
    while (this.hours >= 24) {
      this.hours -= 24;
      this.day++;
    }
  }

  /** 1 at noon, 0 at night, smooth around dawn (5-7h) and dusk (18-20h). */
  get daylight(): number {
    const h = this.hours;
    return clamp(smoothstep(5, 7.2, h) * (1 - smoothstep(18.2, 20.3, h)), 0, 1);
  }

  get isNight(): boolean {
    return this.daylight < 0.35;
  }

  label(): string {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
  }
}
