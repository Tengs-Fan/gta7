// Per-kind engine character for the player's engine voice (engineVoice.ts) and horn.
// Pure data, plus the pure functions that turn a vehicle's state into voice parameters,
// so the numbers can be unit tested without Web Audio.

import { clamp } from '../core/math';
import { DEFAULT_HORN, engineProfileOf, VEHICLE_SPECS, type EngineProfile, type VehicleKind } from '../sim/specs';

export { DEFAULT_HORN, type EngineProfile };

/** The engine voice of `kind`: its spec's `engine`, else DEFAULT_ENGINE_PROFILE (the sedan's). */
export const engineProfile = engineProfileOf;

/** The current kinds' profiles, by kind (read from the specs when this module loads); engineProfile also answers kinds added later. */
export const ENGINE_PROFILES: { readonly [K in VehicleKind]: EngineProfile } = Object.fromEntries(
  Object.values(VEHICLE_SPECS).map((spec) => [spec.kind, engineProfileOf(spec.kind)]),
) as { readonly [K in VehicleKind]: EngineProfile };

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

export interface EngineParams {
  rpm: number;
  /** Firing pulses per second: rpm * cylinders / 120 (four-stroke). */
  firingHz: number;
  /** One four-stroke cycle (two revolutions, every cylinder fires once): the oscillator's fundamental. */
  cycleHz: number;
  /** Gain of the firing-pulse voice. */
  level: number;
  /** Throttle low-pass on the pulse voice, 600-4000 Hz. */
  lowpassHz: number;
  /** Centre of the exhaust noise band, 2-4x the firing frequency with throttle. */
  exhaustHz: number;
  exhaustLevel: number;
  /** Road roar (tyres on the surface), proportional to speed^1.2. */
  roar: number;
  /** Wind noise, (speed / 50)^2. */
  wind: number;
  /** Depth (Hz) of the random cycle-to-cycle wobble on the cycle frequency: no two combustion cycles are alike. */
  jitterHz: number;
}

/** Overall gain of the engine voice for a 0 dB profile. */
const ENGINE_BASE = 0.16;
const ROAR_K = 0.0021;
const WIND_K = 0.07;

/**
 * Voice parameters for a `kind` engine at `rpm01` (the sim's 0..1 rev position), `throttle` (0..1) and `speed` (m/s).
 * `soft` ground (sand, grass) makes the tyres roar 3 dB louder.
 */
export function engineParams(kind: VehicleKind, rpm01: number, throttle: number, speed: number, soft = false, out?: EngineParams): EngineParams {
  const p = engineProfileOf(kind);
  const r = clamp(rpm01, 0, 1);
  const th = clamp(throttle, 0, 1);
  const sp = clamp(Math.abs(speed), 0, 90);
  const rpm = p.idleRpm + r * (p.redlineRpm - p.idleRpm);
  const firingHz = (rpm * p.cylinders) / 120;
  const level = dbToGain(p.loudness) * ENGINE_BASE * (0.55 + 0.45 * th) * (0.8 + 0.2 * r);
  const lowpassHz = clamp(600 + 3400 * (0.7 * th + 0.3 * r) * (0.65 + 0.35 * p.brightness), 600, 4000);
  const o = out ?? ({} as EngineParams);
  o.rpm = rpm;
  o.firingHz = firingHz;
  o.cycleHz = rpm / 120;
  o.level = level;
  o.lowpassHz = lowpassHz;
  o.exhaustHz = clamp(firingHz * (2 + 2 * th), 60, 6000);
  o.exhaustLevel = level * (0.12 + 0.55 * th) * (0.7 + 0.6 * p.roughness);
  o.roar = Math.min(0.35, ROAR_K * Math.pow(sp, 1.2) * (soft ? dbToGain(3) : 1));
  o.wind = WIND_K * Math.min(1.5, (sp / 50) ** 2);
  o.jitterHz = o.cycleHz * (0.008 + 0.025 * p.roughness);
  return o;
}

export interface SquealParams {
  /** Gain of the two resonant squeal bands. */
  level: number;
  /** Centre of the lower squeal band (Hz); the upper one sits SQUEAL_OVERTONE above it. */
  hz: number;
  /** Gain of the broad rubber scrub under the squeal. */
  scrub: number;
  /** Depth of the stick-slip flutter on the squeal's amplitude (0..1). */
  flutter: number;
}

/** The upper squeal band, an inharmonic step above the lower one: no steady interval, so no bell. */
export const SQUEAL_OVERTONE = 1.94;

/**
 * Tyre noise for a slide: rubber sliding on asphalt squeals in narrow, wandering bands of noise between about 0.7 and
 * 1.6 kHz that rise with the slip (the sim's skid, 0..1) and the speed (m/s), over a broad scrub.
 * Braking straight groans lower and chatters more; sand and grass (`soft`) only scrub.
 */
export function squealParams(slip: number, speed: number, airborne: boolean, braking: boolean, soft: boolean, out?: SquealParams): SquealParams {
  const o = out ?? ({} as SquealParams);
  const s = airborne ? 0 : clamp((slip - 0.12) / 0.7, 0, 1);
  const sp = clamp(Math.abs(speed) / 25, 0.25, 1);
  o.level = soft ? 0 : 0.09 * Math.pow(s, 1.3) * (0.55 + 0.45 * sp);
  o.hz = (braking ? 600 : 700) + 450 * s + 10 * Math.min(Math.abs(speed), 40);
  o.scrub = 0.05 * s * (0.4 + 0.6 * sp) * (soft ? 2 : 1);
  o.flutter = (braking ? 0.55 : 0.3) + 0.15 * (1 - s);
  return o;
}

/**
 * Wheelspin off the line (0..1, added to the skid for the tyre voice): a car with a strong engine floored from a
 * standstill spins its tyres until it reaches about 8 m/s; the stronger the car, the harder.
 */
export function launchSlip(throttle: number, forwardSpeed: number, accel: number, reversing: boolean): number {
  if (reversing || throttle < 0.85 || accel < 13 || forwardSpeed < 0 || forwardSpeed >= 8) return 0;
  return 0.95 * (1 - forwardSpeed / 8) * Math.min(1, (accel - 11) / 3);
}

/** Number of harmonics in the engine PeriodicWave (enough for ~1.8 kHz of detail at a bus's idle). */
export const ENGINE_HARMONICS = 400;

/**
 * Fourier coefficients of one four-stroke cycle of exhaust pulses for a profile:
 * one damped pulse per cylinder, with deterministic cylinder-to-cylinder variation (roughness),
 * the uneven V8 spacing and the diesel click.
 * Played by an oscillator at the cycle frequency (rpm / 120), the pulses arrive at the firing frequency.
 * Built once per vehicle kind, never per frame.
 */
export function engineWave(p: EngineProfile, harmonics = ENGINE_HARMONICS): { real: Float32Array; imag: Float32Array } {
  const n = p.cylinders;
  // Decay time of a pulse as a fraction of the cycle: brighter engines fire sharper pulses.
  const w = (0.2 - 0.12 * p.brightness) / n;
  const pos: number[] = [];
  const amp: number[] = [];
  let seed = (n * 7919 + Math.round(p.idleRpm) * 31 + Math.round(p.roughness * 1000)) >>> 0;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let k = 0; k < n; k++) {
    let phase = k / n + p.roughness * 0.035 * rnd();
    let a = 1 + p.roughness * 0.9 * rnd();
    if (p.uneven && k % 2 === 1) {
      // Alternate pulses come late and weaker: the burble at half the firing frequency.
      phase += 0.22 / n;
      a *= 0.62;
    }
    pos.push(phase);
    amp.push(a);
  }
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  const knockW = w / 3;
  for (let h = 1; h <= harmonics; h++) {
    // Exhaust pulse: a sharp rise and an exponential decay, S = 1 / (1 + i a) with a = 2 pi h w.
    const a = 2 * Math.PI * h * w;
    const den = 1 + a * a;
    let sRe = 1 / den;
    let sIm = -a / den;
    if (p.diesel) {
      // First-order sharp click on top of each pulse.
      const b = 2 * Math.PI * h * knockW;
      const kd = 1 + b * b;
      sRe += 0.14 / kd;
      sIm += (0.14 * -b) / kd;
    }
    let cRe = 0;
    let cIm = 0;
    for (let k = 0; k < n; k++) {
      const th = -2 * Math.PI * h * pos[k]!;
      const c = Math.cos(th) * amp[k]!;
      const s = Math.sin(th) * amp[k]!;
      // (sRe + i sIm) * (c + i s)
      cRe += sRe * c - sIm * s;
      cIm += sRe * s + sIm * c;
    }
    real[h] = 2 * cRe;
    imag[h] = -2 * cIm;
  }
  // Unit RMS (Parseval) over the band up to ten times the firing frequency, which is what the throttle low-pass lets through,
  // so `loudness` alone sets the level and sharper or fewer pulses don't come out quieter.
  // The wave is used with normalisation disabled.
  let power = 0;
  for (let h = 1; h <= Math.min(harmonics, 10 * n); h++) power += (real[h]! * real[h]! + imag[h]! * imag[h]!) / 2;
  const k = power > 0 ? 1 / Math.sqrt(power) : 0;
  for (let h = 1; h <= harmonics; h++) {
    real[h] = real[h]! * k;
    imag[h] = imag[h]! * k;
  }
  return { real, imag };
}

/** Peak and RMS of one period of a wave given by its coefficients (sampled at `n` points). */
export function waveStats(real: Float32Array, imag: Float32Array, n = 2048): { peak: number; rms: number } {
  let peak = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    // Rotate a unit phasor instead of calling cos/sin per harmonic.
    const c1 = Math.cos(t);
    const s1 = Math.sin(t);
    let c = 1;
    let s = 0;
    let x = 0;
    for (let h = 1; h < real.length; h++) {
      const nc = c * c1 - s * s1;
      s = s * c1 + c * s1;
      c = nc;
      x += real[h]! * c + imag[h]! * s;
    }
    peak = Math.max(peak, Math.abs(x));
    ss += x * x;
  }
  return { peak, rms: Math.sqrt(ss / n) };
}
