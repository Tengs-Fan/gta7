// Weather (src/sim/weather.ts): the pure per-seed schedule, overrides and their ramps, the clear mode, and lightning.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { GameClock } from '../../src/sim/clock';
import type { SimEvents } from '../../src/sim/events';
import { Sim } from '../../src/sim/sim';
import { RAMP_HOURS, scheduledWeather, SLOT_HOURS, slotKind, WeatherSystem, type WeatherKind, type WeatherState } from '../../src/sim/weather';
import { input, world } from './helpers';

const FIELDS = ['cloud', 'rain', 'storm', 'wet', 'dim', 'fog', 'seaState'] as const;
const PLAYER = { x: 0, y: 0, z: 0 };

/** Every game minute of days `from`..`to`. */
function* minutes(from: number, to: number): Generator<[number, number]> {
  for (let day = from; day <= to; day++) for (let m = 0; m < 24 * 60; m++) yield [day, m / 60];
}

function rig(mode: 'dynamic' | 'clear', day = 1, hours = 12) {
  const clock = new GameClock(hours);
  clock.day = day;
  const events = new Emitter<SimEvents>();
  const strikes: Array<{ x: number; z: number; dist: number; t: number }> = [];
  let t = 0;
  events.on('lightning', (e) => strikes.push({ ...e, t }));
  const w = new WeatherSystem(7, mode);
  const run = (seconds: number, dt = 1 / 60) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      t += dt;
      clock.update(dt);
      w.update(dt, clock, events, PLAYER);
    }
  };
  return { clock, events, w, run, strikes };
}

/** The first scheduled hour (day >= 2) of a kind for seed 7. */
function findSlot(kind: WeatherKind, seed = 7): { day: number; hours: number } {
  for (let g = 16; g < 8 * 400; g++) if (slotKind(seed, g) === kind && slotKind(seed, g + 1) === kind) return { day: Math.floor(g / 8), hours: (g % 8) * 3 + 2 };
  throw new Error(`no ${kind} slot`);
}

describe('weather schedule', () => {
  it('is deterministic per seed and differs between seeds', () => {
    let differs = 0;
    for (const [day, h] of minutes(2, 6)) {
      expect(scheduledWeather(11, day, h)).toEqual(scheduledWeather(11, day, h));
      if (scheduledWeather(11, day, h).kind !== scheduledWeather(12, day, h).kind) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });

  it('is continuous: no field moves more than 0.05 from one game minute to the next over 30 days', () => {
    let prev: WeatherState | null = null;
    let worst = 0;
    for (const [day, h] of minutes(1, 30)) {
      const s = scheduledWeather(7, day, h);
      if (prev) for (const f of FIELDS) worst = Math.max(worst, Math.abs(s[f] - prev[f]));
      prev = s;
    }
    expect(worst).toBeLessThanOrEqual(0.05);
    expect(worst).toBeGreaterThan(0);
  });

  it('rains or storms 8-25 % of days 2-30, and storms only next to rain or overcast', () => {
    const shares: number[] = [];
    for (const seed of [1, 7, 42, 1234, 99999]) {
      let wet = 0;
      let n = 0;
      for (let g = 16; g < 31 * 8; g++) {
        const k = slotKind(seed, g);
        n++;
        if (k === 'rain' || k === 'storm') wet++;
        if (k === 'storm') {
          const prev = slotKind(seed, g - 1);
          expect(['rain', 'overcast', 'storm']).toContain(prev);
        }
      }
      shares.push(wet / n);
    }
    for (const s of shares) {
      expect(s).toBeGreaterThanOrEqual(0.08);
      expect(s).toBeLessThanOrEqual(0.25);
    }
    const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
    expect(mean).toBeGreaterThanOrEqual(0.08);
    expect(mean).toBeLessThanOrEqual(0.2);
  });

  it('keeps day 1 clear for every seed, every minute', () => {
    for (let seed = 0; seed < 24; seed++) {
      for (const [day, h] of minutes(1, 1)) {
        const s = scheduledWeather(seed * 7919 + 3, day, h);
        expect(s.kind).toBe('clear');
        expect(s.rain).toBe(0);
        expect(s.storm).toBe(0);
        expect(s.cloud).toBe(0);
      }
    }
  });

  it('has wet ground after rain that dries over a few game hours, and dark skies in rain', () => {
    const { day, hours } = findSlot('rain');
    const raining = scheduledWeather(7, day, hours);
    expect(raining.rain).toBe(1);
    expect(raining.wet).toBe(1);
    expect(raining.dim).toBeGreaterThanOrEqual(0.5);
    // Find the end of that rain and look a little later.
    let T = day * 24 + hours;
    while (scheduledWeather(7, Math.floor(T / 24), T % 24).rain > 0) T += 1 / 60;
    const after = (dh: number) => scheduledWeather(7, Math.floor((T + dh) / 24), (T + dh) % 24).wet;
    expect(after(0)).toBeGreaterThan(0.55);
    expect(after(0.5)).toBeGreaterThan(0.3);
    expect(after(0.5)).toBeLessThan(1);
    expect(after(4)).toBeLessThan(after(0.5));
  });
});

describe('weather system', () => {
  it('a Sim defaults to clear on any day, and consumes no sim randomness', () => {
    const plain = new Sim({ world: world(), ambient: false, police: false });
    expect(plain.weather.mode).toBe('clear');
    const { day, hours } = findSlot('rain');
    plain.clock.day = day;
    plain.clock.set(hours);
    plain.update(1 / 60, input());
    expect(plain.weather.state.kind).toBe('clear');
    expect(plain.weather.state.rain).toBe(0);

    const sims = (['dynamic', 'clear'] as const).map((weather) => {
      const s = new Sim({ world: world(), ambient: false, police: false, weather, startHour: hours });
      s.clock.day = day;
      return s;
    });
    for (let i = 0; i < 1000; i++) for (const s of sims) s.update(1 / 60, input());
    const rngState = (s: Sim) => (s.rng as unknown as { state: number }).state;
    expect(rngState(sims[0]!)).toBe(rngState(sims[1]!));
    expect(sims[0]!.weather.state.rain).toBeGreaterThan(0.5);
    expect(sims[1]!.weather.state.rain).toBe(0);
  });

  it('two sims with the same seed report the same weather', () => {
    const { day, hours } = findSlot('storm');
    const sims = [0, 1].map(() => {
      const s = new Sim({ world: world(), ambient: false, police: false, weather: 'dynamic', startHour: hours - 1 });
      s.clock.day = day;
      return s;
    });
    for (let i = 0; i < 300; i++) for (const s of sims) s.update(1 / 30, input());
    expect(sims[0]!.weather.state).toEqual(sims[1]!.weather.state);
  });

  it('starts on the schedule with no ramp (a loaded save), then follows it', () => {
    const { day, hours } = findSlot('rain');
    const { w, run } = rig('dynamic', day, hours);
    run(1 / 60);
    expect(w.state.kind).toBe('rain');
    expect(w.state.rain).toBeCloseTo(1, 5);
    expect(w.state.wet).toBeCloseTo(1, 5);
  });

  it('an override ramps over its time, an instant one snaps, and null returns to the schedule', () => {
    const { w, run } = rig('dynamic', 1, 12);
    run(0.1);
    w.override('storm');
    run(10);
    expect(w.state.storm).toBeGreaterThan(0.3);
    expect(w.state.storm).toBeLessThan(0.7);
    run(10.1);
    expect(w.state.kind).toBe('storm');
    expect(w.state.storm).toBeCloseTo(1, 5);
    expect(w.overridden).toBe('storm');
    w.override('rain', 0);
    run(1 / 60);
    expect(w.state.kind).toBe('rain');
    expect(w.state.rain).toBeGreaterThanOrEqual(0.9);
    expect(w.state.storm).toBe(0);
    w.override(null, 0);
    run(1 / 60);
    expect(w.overridden).toBe(null);
    expect(w.state.kind).toBe('clear');
    expect(w.state.rain).toBe(0);
  });

  it('pins single fields until released', () => {
    const { w, run } = rig('dynamic', 1, 12);
    run(0.1);
    w.setFields({ seaState: 1 });
    run(0.1);
    expect(w.state.seaState).toBe(1);
    expect(w.state.kind).toBe('clear');
    w.override(null);
    run(0.1);
    expect(w.state.seaState).toBeCloseTo(0.3, 5);
  });

  it('the clear mode ramps rain away and holds it off through rainy slots; dynamic brings it back', () => {
    const { day, hours } = findSlot('rain');
    const { w, run } = rig('dynamic', day, hours - 1.5);
    // 100 game minutes on: well into the rain slot.
    run(100);
    expect(w.state.rain).toBeGreaterThan(0.9);
    w.mode = 'clear';
    run(5);
    expect(w.state.rain).toBeGreaterThan(0.5);
    run(20);
    expect(w.state.rain).toBe(0);
    expect(w.state.kind).toBe('clear');
    w.mode = 'dynamic';
    run(25);
    expect(w.state.rain).toBeGreaterThan(0.9);
  });

  it('wetness dries while held, and stays up while it rains', () => {
    const { w, run } = rig('clear', 3, 12);
    run(0.1);
    w.override('rain', 0);
    run(1);
    expect(w.state.wet).toBe(1);
    w.override('clear', 0);
    run(1);
    const soon = w.state.wet;
    run(60);
    expect(w.state.wet).toBeLessThan(soon);
    expect(w.state.wet).toBeGreaterThan(0);
  });
});

describe('lightning', () => {
  it('strikes only in storms, 300-1500 m away, identically in two runs', () => {
    const { day, hours } = findSlot('storm');
    const runs = [0, 1].map(() => {
      const r = rig('dynamic', day, hours - 2.5);
      let outside = 0;
      r.events.on('lightning', () => {
        if (r.w.state.kind !== 'storm') outside++;
      });
      r.run(60 * 6);
      return { strikes: r.strikes, outside };
    });
    expect(runs[0]!.strikes.length).toBeGreaterThan(3);
    expect(runs[0]!.strikes).toEqual(runs[1]!.strikes);
    expect(runs[0]!.outside).toBe(0);
    for (const s of runs[0]!.strikes) {
      expect(s.dist).toBeGreaterThanOrEqual(300);
      expect(s.dist).toBeLessThanOrEqual(1500);
      expect(Math.hypot(s.x, s.z)).toBeCloseTo(s.dist, 6);
    }
  });

  it('never strikes in clear, cloudy, overcast or rain weather', () => {
    for (const kind of ['clear', 'cloudy', 'overcast', 'rain'] as const) {
      const r = rig('dynamic', 4, 10);
      r.w.override(kind, 0);
      r.run(120);
      expect(r.strikes, kind).toEqual([]);
    }
  });

  it('strike() forces one, at a given spot or a hashed one in range', () => {
    const r = rig('clear', 1, 12);
    r.w.strike(r.events, PLAYER, 400, 300);
    r.w.strike(r.events, PLAYER);
    expect(r.strikes).toHaveLength(2);
    expect(r.strikes[0]!.dist).toBeCloseTo(500, 6);
    expect(r.strikes[1]!.dist).toBeGreaterThanOrEqual(300);
    expect(r.strikes[1]!.dist).toBeLessThanOrEqual(1500);
  });
});

describe('layering', () => {
  it('src/sim/weather.ts imports no three.js, DOM or storage', () => {
    const src = readFileSync(new URL('../../src/sim/weather.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const i of imports) expect(i).toMatch(/^\.\.?\//);
    expect(src).not.toMatch(/\b(window|document|localStorage)\b/);
  });
});

describe('forecast', () => {
  it('names the slot now, the first later slot today of another kind and tomorrow at midday, for seeds 1, 7 and 42', () => {
    for (const seed of [1, 7, 42]) {
      const w = new WeatherSystem(seed, 'dynamic');
      let changes = 0;
      for (let day = 1; day <= 40; day++) {
        for (let hours = 0; hours < 24; hours += 0.5) {
          const f = w.forecast(day, hours)!;
          const g = Math.floor((day * 24 + hours) / SLOT_HOURS);
          expect(f.now).toBe(slotKind(seed, g));
          expect(f.tomorrow).toBe(slotKind(seed, (day + 1) * 8 + 12 / SLOT_HOURS));
          const end = f.next ? day * 8 + f.next.startHours / SLOT_HOURS : (day + 1) * 8;
          for (let k = g + 1; k < end; k++) expect(slotKind(seed, k), `seed ${seed} day ${day} ${hours} h`).toBe(f.now);
          if (!f.next) continue;
          changes++;
          expect(f.next.startHours).toBeGreaterThan(hours);
          expect(f.next.startHours).toBeLessThan(24);
          expect(f.next.kind).toBe(slotKind(seed, end));
          expect(f.next.kind).not.toBe(f.now);
          // It comes true: once the change has ramped in, the schedule's weather is the kind forecast.
          expect(scheduledWeather(seed, day, f.next.startHours + RAMP_HOURS).kind).toBe(f.next.kind);
        }
      }
      expect(changes, `seed ${seed}`).toBeGreaterThan(200);
    }
  });

  it('is null while the weather is held: under an override and in the clear mode', () => {
    const w = new WeatherSystem(7, 'dynamic');
    expect(w.forecast(5, 12)).not.toBeNull();
    w.override('rain');
    expect(w.forecast(5, 12)).toBeNull();
    w.override(null);
    expect(w.forecast(5, 12)).not.toBeNull();
    w.mode = 'clear';
    expect(w.forecast(5, 12)).toBeNull();
  });
});
