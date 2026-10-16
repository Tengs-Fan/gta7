import { clamp, smoothstep } from '../core/math';

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
