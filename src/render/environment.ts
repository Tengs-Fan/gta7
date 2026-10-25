// Sky dome (clouds, stars, moon, hills across the bay), sun/moon lighting, fog, environment map and the ocean.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/math';
import { darkness, sunIntensity } from '../sim/clock';
import type { WeatherState } from '../sim/weather';
import { WATER_Y } from '../world/constants';
import type { Bounds } from '../world/layout';
import { patchSeaMaterial, seaGrid, seaPlane, seaUniforms, setShore, snapSea, softwareSeaMaterial, updateSea, type SeaUniforms } from './sea';
import { CLOUD_NOISE_CELLS, CLOUD_NOISE_SCALE, cloudNoiseTexture, waterNormalTexture } from './textures';
import { CALM_SEA } from './waves';
import { assets } from './assets';

interface Key {
  h: number;
  top: number;
  horizon: number;
  sun: number;
  hemiI: number;
  exposure: number;
}

// Palette keyframes over the day (hours). The warm morning light holds until about 08:30. The sun's intensity, and the
// darkness that follows from it, come from the simulation's clock (sim/clock.ts sunIntensity, darkness).
const KEYS: Key[] = [
  { h: 0, top: 0x03060f, horizon: 0x0b1530, sun: 0x8fa8ff, hemiI: 0.22, exposure: 1.0 },
  { h: 4.8, top: 0x060c1f, horizon: 0x1a2440, sun: 0x8fa8ff, hemiI: 0.25, exposure: 1.0 },
  { h: 6.0, top: 0x29457f, horizon: 0xf09a6a, sun: 0xffa060, hemiI: 0.5, exposure: 1.0 },
  { h: 7.5, top: 0x3a6fc0, horizon: 0xf2c49c, sun: 0xffc890, hemiI: 0.66, exposure: 1.0 },
  { h: 8.5, top: 0x3d7bd0, horizon: 0xd6dde6, sun: 0xffe2bc, hemiI: 0.74, exposure: 1.0 },
  { h: 12, top: 0x2b6cd4, horizon: 0xaed0f2, sun: 0xfff6e8, hemiI: 0.8, exposure: 1.0 },
  { h: 16.5, top: 0x3570cc, horizon: 0xf0d8b0, sun: 0xffe2b0, hemiI: 0.74, exposure: 1.0 },
  { h: 18.4, top: 0x34478a, horizon: 0xff8a4c, sun: 0xff8040, hemiI: 0.6, exposure: 1.08 },
  { h: 19.4, top: 0x161e44, horizon: 0xb44a3e, sun: 0xff5a30, hemiI: 0.36, exposure: 1.05 },
  { h: 20.6, top: 0x070c20, horizon: 0x1e2648, sun: 0x8fa8ff, hemiI: 0.24, exposure: 1.0 },
  { h: 24, top: 0x03060f, horizon: 0x0b1530, sun: 0x8fa8ff, hemiI: 0.22, exposure: 1.0 },
];

const cA = new THREE.Color();
const cB = new THREE.Color();

function sample(hours: number): { top: THREE.Color; horizon: THREE.Color; sun: THREE.Color; sunI: number; hemiI: number; exposure: number } {
  const h = ((hours % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]!.h <= h) i++;
  const a = KEYS[i]!;
  const b = KEYS[i + 1]!;
  const t = clamp((h - a.h) / (b.h - a.h), 0, 1);
  const mix = (x: number, y: number) => cA.setHex(x).lerp(cB.setHex(y), t).clone();
  return { top: mix(a.top, b.top), horizon: mix(a.horizon, b.horizon), sun: mix(a.sun, b.sun), sunI: sunIntensity(h), hemiI: lerp(a.hemiI, b.hemiI, t), exposure: lerp(a.exposure, b.exposure, t) };
}

/** Brightness 0..1 of the stars at a time of day (hours). */
export function starIntensity(hours: number): number {
  return starsAt(darkness(hours));
}

function starsAt(night: number): number {
  return smoothstep(0.5, 0.95, night);
}

/**
 * 0..1: the city's light glowing on the night sky above the horizon. Keyed on the clock rather than on darkness: it
 * rises over 3.2 h of dusk and falls over 3.1 h before dawn, so it never changes by more than 0.5% of its full value in
 * 0.01 h, and it is 0 through the day.
 */
export function cityGlow(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  return h >= 12 ? smoothstep(18.9, 22.1, h) : 1 - smoothstep(3.6, 6.7, h);
}

/** The city glow's colour on the sky at the horizon (linear), at full strength; it fades upwards over CITY_GLOW_FALL. */
const CITY_GLOW = new THREE.Color(0.1, 0.045, 0.006);
/** The glow's falloff with the sine of the elevation: half strength about 6 degrees up. */
const CITY_GLOW_FALL = 6.5;

/**
 * How much of the image-based light's map comes from the sky HDRI (src/assets/env/sky_1k.hdr) rather than the analytic
 * sky: HDRI_MAX at every hour, less under cloud (an overcast deck has no structure to show). The HDRI is recoloured and
 * scaled to the time-of-day sky at each bake, so by night it is as dark as the night sky: it gives the reflections
 * clouds and a horizon, never the daytime photo's light. The hour argument keeps the curve's signature for a future
 * time-of-day weight.
 */
export const HDRI_MAX = 0.92;
export function hdriWeight(_hours: number, cloud = 0): number {
  return HDRI_MAX * (1 - 0.7 * clamp(cloud, 0, 1));
}

/** Width (hours) of the Gaussian that smooths the HDRI part's brightness over the day. */
const IBL_SMOOTH_SIGMA = 1.0;
const IBL_TABLE_STEP = 0.05;
let iblTable: { raw: Float64Array; smooth: Float64Array } | null = null;

/** The effective image-based light at an hour in clear weather: the analytic sky's up radiance (skyIrradiance, sun included) x envIntensity. */
function clearSkyUp(hours: number): number {
  const s = sample(hours);
  const sunDir = new THREE.Vector3();
  skyPath(hours, sunDir, new THREE.Vector3());
  const sun = s.sun.clone().multiplyScalar(Math.min(1.5, s.sunI / 2) * sunVisibility(sunDir.y));
  const up = new THREE.Color();
  skyIrradiance(s.top, s.horizon, sun, sunDir.y, up, new THREE.Color());
  return luminance(up) * envIntensity(darkness(hours));
}

/**
 * The HDRI part of the bake does not follow the palette's brightness hour by hour: the effective light it gives is the
 * analytic sky's smoothed over the day (a Gaussian of IBL_SMOOTH_SIGMA h), so the steep fall of the sky light around
 * sunset (and its rise at dawn) is spread out. Returns smoothed / analytic at an hour; about 1 at noon and at night.
 */
export function iblSmoothing(hours: number): number {
  if (!iblTable) {
    const n = Math.round(24 / IBL_TABLE_STEP);
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) raw[i] = clearSkyUp(i * IBL_TABLE_STEP);
    const smooth = new Float64Array(n);
    const r = Math.ceil((3 * IBL_SMOOTH_SIGMA) / IBL_TABLE_STEP);
    for (let i = 0; i < n; i++) {
      let s = 0;
      let wsum = 0;
      for (let k = -r; k <= r; k++) {
        const w = Math.exp(-0.5 * ((k * IBL_TABLE_STEP) / IBL_SMOOTH_SIGMA) ** 2);
        s += w * raw[(((i + k) % n) + n) % n]!;
        wsum += w;
      }
      smooth[i] = s / wsum;
    }
    iblTable = { raw, smooth };
  }
  const { raw, smooth } = iblTable;
  const n = raw.length;
  const x = ((((hours % 24) + 24) % 24) / IBL_TABLE_STEP);
  const i = Math.floor(x) % n;
  const j = (i + 1) % n;
  const t = x - Math.floor(x);
  const a = raw[i]! + (raw[j]! - raw[i]!) * t;
  const b = smooth[i]! + (smooth[j]! - smooth[i]!) * t;
  return b / Math.max(a, 1e-5);
}

/** Size of the reduced, sun-clamped copy of the HDRI the bake samples (equirectangular, row 0 at the nadir). */
export const HDRI_W = 128;
export const HDRI_H = 64;
/** Texels brighter than this many times the upper hemisphere's mean luminance are clamped: the photo's own sun goes. */
const HDRI_CLAMP = 4;

export interface PreparedHdri {
  texture: THREE.DataTexture;
  /** Cosine-weighted mean radiance over the upper hemisphere (above the horizon blend): what an up-facing surface gets. */
  up: THREE.Color;
  /**
   * The same split by the analytic sky's gradient (top weight smoothstep(0, 0.6, elevation)): the up-facing light from
   * the HDRI's top part and from its horizon part (sum = up), and the mean radiance of each part by solid angle.
   */
  upTop: THREE.Color;
  upHorizon: THREE.Color;
  meanTop: THREE.Color;
  meanHorizon: THREE.Color;
}

/** Fades the HDRI in above the horizon; below it the bake keeps the analytic haze. Mirrored in the bake's shader. */
function hdriAbove(y: number): number {
  return smoothstep(-0.02, 0.06, y);
}

/**
 * Reduces the sky HDRI (an equirectangular DataTexture, half or full float, RGB or RGBA, rows top first as HDRLoader
 * writes them) to HDRI_W x HDRI_H, clamps its sun away, and measures its up-facing irradiance. Null when the texture
 * is not usable data.
 */
export function prepareHdri(src: THREE.Texture | null | undefined): PreparedHdri | null {
  const img = src?.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  const data = img?.data;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!data || w < HDRI_W || h < HDRI_H) return null;
  const ch = Math.round(data.length / (w * h));
  if (ch !== 3 && ch !== 4) return null;
  const half = data instanceof Uint16Array;
  const read = (i: number): number => (half ? THREE.DataUtils.fromHalfFloat(data[i]!) : data[i]!);
  const fx = w / HDRI_W;
  const fy = h / HDRI_H;
  const out = new Float32Array(HDRI_W * HDRI_H * 3);
  for (let j = 0; j < HDRI_H; j++) {
    // Output row j runs up from the nadir; the source's rows run down from the zenith.
    const sy0 = Math.floor((HDRI_H - 1 - j) * fy);
    for (let i = 0; i < HDRI_W; i++) {
      const sx0 = Math.floor(i * fx);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = sy0; y < Math.min(h, sy0 + Math.ceil(fy)); y++) {
        for (let x = sx0; x < Math.min(w, sx0 + Math.ceil(fx)); x++) {
          const o = (y * w + x) * ch;
          r += read(o);
          g += read(o + 1);
          b += read(o + 2);
          n++;
        }
      }
      const o = (j * HDRI_W + i) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  // Mean luminance of the upper hemisphere (by solid angle), then the clamp.
  const elev = (j: number) => ((j + 0.5) / HDRI_H - 0.5) * Math.PI;
  let lsum = 0;
  let wsum = 0;
  for (let j = HDRI_H / 2; j < HDRI_H; j++) {
    const sa = Math.cos(elev(j));
    for (let i = 0; i < HDRI_W; i++) {
      const o = (j * HDRI_W + i) * 3;
      lsum += (0.2126 * out[o]! + 0.7152 * out[o + 1]! + 0.0722 * out[o + 2]!) * sa;
      wsum += sa;
    }
  }
  const cap = HDRI_CLAMP * (lsum / Math.max(wsum, 1e-9));
  const up = new THREE.Color(0, 0, 0);
  const upTop = new THREE.Color(0, 0, 0);
  const upHorizon = new THREE.Color(0, 0, 0);
  const meanTop = new THREE.Color(0, 0, 0);
  const meanHorizon = new THREE.Color(0, 0, 0);
  let wt = 0;
  let wh = 0;
  let cw = 0;
  const texel = new Uint16Array(HDRI_W * HDRI_H * 4);
  for (let j = 0; j < HDRI_H; j++) {
    const e = elev(j);
    const y = Math.sin(e);
    // Solid angle x cosine to the zenith x the horizon blend: the up-facing irradiance the bake will see.
    const k = Math.cos(e) * Math.max(0, y) * hdriAbove(y);
    const st = smoothstep(0, 0.6, y);
    const sa = Math.cos(e) * hdriAbove(y) * (y > 0 ? 1 : 0);
    for (let i = 0; i < HDRI_W; i++) {
      const o = (j * HDRI_W + i) * 3;
      const l = 0.2126 * out[o]! + 0.7152 * out[o + 1]! + 0.0722 * out[o + 2]!;
      const s = l > cap ? cap / l : 1;
      const r = out[o]! * s;
      const g = out[o + 1]! * s;
      const b = out[o + 2]! * s;
      up.r += r * k;
      up.g += g * k;
      up.b += b * k;
      upTop.r += r * k * st;
      upTop.g += g * k * st;
      upTop.b += b * k * st;
      meanTop.r += r * sa * st;
      meanTop.g += g * sa * st;
      meanTop.b += b * sa * st;
      meanHorizon.r += r * sa * (1 - st);
      meanHorizon.g += g * sa * (1 - st);
      meanHorizon.b += b * sa * (1 - st);
      wt += sa * st;
      wh += sa * (1 - st);
      cw += Math.cos(e) * Math.max(0, y);
      const t = (j * HDRI_W + i) * 4;
      texel[t] = THREE.DataUtils.toHalfFloat(r);
      texel[t + 1] = THREE.DataUtils.toHalfFloat(g);
      texel[t + 2] = THREE.DataUtils.toHalfFloat(b);
      texel[t + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  up.multiplyScalar(1 / Math.max(cw, 1e-9));
  upTop.multiplyScalar(1 / Math.max(cw, 1e-9));
  upHorizon.copy(up).sub(upTop);
  meanTop.multiplyScalar(1 / Math.max(wt, 1e-9));
  meanHorizon.multiplyScalar(1 / Math.max(wh, 1e-9));
  const texture = new THREE.DataTexture(texel, HDRI_W, HDRI_H, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.name = 'sky-hdri-reduced';
  texture.needsUpdate = true;
  return { texture, up, upTop, upHorizon, meanTop, meanHorizon };
}

/** Share of the sky covered by cloud at a time of day (hours): about 0.35 by day and 0.25 at night. */
export function cloudCover(hours: number): number {
  return coverAt(hours, darkness(hours));
}

function coverAt(hours: number, night: number): number {
  return lerp(0.25, 0.35, 1 - night) + 0.03 * Math.sin((hours / 24) * Math.PI * 4);
}

/**
 * Standard deviation of the sky shader's cloud fbm (mean 0.5) per octave count, measured with
 * textures/misc.ts cloudFbm over the cloud noise texture (r2_city.test.ts checks these); the cloud
 * threshold for a coverage is mean + sd * probit(1 - coverage).
 */
export const CLOUD_SD: Readonly<Record<number, number>> = { 2: 0.1595, 3: 0.1399, 4: 0.1313, 5: 0.1272 };
/** Half-width of the cloud edge, in standard deviations of the fbm. */
const CLOUD_EDGE = 0.55;

/** Inverse of the standard normal CDF (Abramowitz and Stegun 26.2.23, error below 5e-4). */
function probit(p: number): number {
  const q = Math.min(Math.max(p < 0.5 ? p : 1 - p, 1e-6), 0.5);
  const t = Math.sqrt(-2 * Math.log(q));
  const z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  return p < 0.5 ? -z : z;
}

/** The cloud fbm value that a share `cover` of the sky exceeds (the shader's density is 0.5 there). */
export function cloudThreshold(cover: number, sd: number = CLOUD_SD[5]!): number {
  return 0.5 + sd * probit(1 - clamp(cover, 0.01, 0.99));
}

/** 0..1: how strongly a low sun paints the cloud undersides (dusk 17:30-19:30, and a little at dawn). */
export function goldenHour(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  const dusk = smoothstep(17.3, 18.2, h) * (1 - smoothstep(19.2, 19.8, h));
  const dawn = smoothstep(5.6, 6.2, h) * (1 - smoothstep(7.4, 8.4, h));
  return Math.max(dusk, dawn * 0.8);
}

/**
 * The key light at the horizon, by the sun's height (sunDir.y, the sine of its elevation): the sky's sun
 * disc and the sun's light fade out together between SUN_HI and SUN_LO, and the moonlight comes up only
 * once the sun's light is gone (between SUN_LO and MOON_LO; the other way round at dawn). The one light
 * so changes direction and colour while it is dark.
 */
const SUN_HI = 0.03;
const SUN_LO = -0.05;
const MOON_LO = -0.15;
/** Moonlight intensity at full night, and its colour. */
const MOON_I = 0.32;
const MOON_COLOR = new THREE.Color(0x9fb4ff);
/**
 * The low sun's light is golden rather than the sky's red: at golden hour (goldenHour) the key light's colour moves this
 * far towards KEY_GOLD, keeping its intensity. The sky dome and the baked sky keep the palette's sunset colours.
 */
const KEY_GOLD = new THREE.Color(1, 0.56, 0.22);
const KEY_GOLD_MIX = 0.85;
/**
 * The sun's light follows the sky's sun down to the horizon and stays level (this sine of its elevation)
 * while it fades out under it: light from below would let the pier deck and other casters shade the scene.
 */
const KEY_MIN_Y = 0;

/** 0..1: how much of the sun the sky shows, and how much of its light reaches the scene, at a sun height sunDir.y. */
export function sunVisibility(y: number): number {
  return smoothstep(SUN_LO, SUN_HI, y);
}

/** 0..1: how far the moonlight has come up at a sun height sunDir.y. */
function moonRamp(y: number): number {
  return 1 - smoothstep(MOON_LO, SUN_LO, y);
}

/**
 * Sun and moon directions at a time of day (hours). The sun rises in the east (+X) at 06:00 and sets in
 * the west at 19:00, tilted south; through the night it carries on below the horizon back to the east,
 * so both paths run on through midnight without a jump. The moon stands opposite it, never lower than
 * 0.25 (sine of its elevation).
 */
export function skyPath(hours: number, sunDir: THREE.Vector3, moonDir: THREE.Vector3): void {
  const h = ((hours % 24) + 24) % 24;
  let az: number;
  let elev: number;
  if (h >= 6 && h <= 19) {
    const t = (h - 6) / 13;
    az = t * Math.PI;
    elev = Math.sin(t * Math.PI) * 1.15;
  } else {
    const t = (h < 6 ? h + 5 : h - 19) / 11;
    az = Math.PI + t * Math.PI;
    elev = -Math.sin(t * Math.PI) * 1.15;
  }
  sunDir.set(Math.cos(az), Math.sin(elev), 0.35).normalize();
  moonDir.set(-Math.cos(az) * 0.8, Math.max(0.25, -Math.sin(elev) * 0.9), -0.35).normalize();
}

/** Night colours: a moonlit blue sky light, sodium-lit streets bouncing up, and the city's warm glow on the horizon. */
const NIGHT_SKY_LIGHT = new THREE.Color(0.36, 0.46, 0.8);
const NIGHT_GROUND_LIGHT = new THREE.Color(0.35, 0.27, 0.18);
const NIGHT_HORIZON_GLOW = new THREE.Color(0.16, 0.11, 0.08);
/** The hemisphere fill's floor at full night: the city's light scattered back down from the sky and the facades. */
const NIGHT_FILL = 0.45;
/** How much of that glow the night sky takes on at the horizon. */
const GLOW_STRENGTH = 0.45;
/** ...and the fog: less, so the sea and distant buildings stay darker than the glowing sky above them. */
const FOG_GLOW_STRENGTH = 0.25;
const WHITE = new THREE.Color(0xffffff);

/** The hemisphere fill for a palette sample and darkness: its sky and ground colours, and its intensity. */
function hemiLight(s: { top: THREE.Color; hemiI: number }, night: number, sky: THREE.Color, ground: THREE.Color): number {
  // Night fill: walls never go pitch black (moonlit sky above, sodium-lit streets below).
  sky.copy(s.top).lerp(WHITE, 0.45).lerp(NIGHT_SKY_LIGHT, night);
  ground.setRGB(0.32, 0.28, 0.24).multiplyScalar(0.6 + 0.4 * (1 - night)).lerp(NIGHT_GROUND_LIGHT, night);
  return Math.max(s.hemiI, NIGHT_FILL * night);
}

/**
 * Strength of the image-based light (the baked sky) for a darkness. three applies it, as
 * scene.environmentIntensity, to every material that has no environment map of its own (all of them
 * here), and it scales the sky's diffuse light as well as its reflections: it is the one reflection
 * knob, so no material sets an envMapIntensity of its own (three would ignore it).
 */
function envIntensity(night: number): number {
  return 0.4 + 0.35 * (1 - night);
}

/** Colour of the baked sky's lower half (envMat): a dark haze under the horizon. */
const HAZE = new THREE.Color(0.16, 0.15, 0.14);

/**
 * Average radiance of the baked sky (envMat) over the half a surface facing straight up sees, and the
 * half one facing down sees, each weighted by the cosine: the diffuse part of the image-based light.
 * Upwards mix(horizon, top, smoothstep(0, 0.6, h)) weighs the top 0.892 and the horizon 0.108, and
 * the sun's lobe (2.5 pow(cos, 24) of its colour `sun`) adds 0.2 of it times the sun's height;
 * downwards it is the haze. For the path without an environment map (see Environment.envFill).
 */
function skyIrradiance(top: THREE.Color, horizon: THREE.Color, sun: THREE.Color, sunY: number, up: THREE.Color, down: THREE.Color): void {
  const k = 0.2 * Math.max(0, sunY);
  up.setRGB(0.892 * top.r + 0.108 * horizon.r + k * sun.r, 0.892 * top.g + 0.108 * horizon.g + k * sun.g, 0.892 * top.b + 0.108 * horizon.b + k * sun.b);
  down.setRGB(HAZE.r * (horizon.r + 0.2), HAZE.g * (horizon.g + 0.2), HAZE.b * (horizon.b + 0.2));
}

/** Relative change of any sky colour (top, horizon, baked sun) since the last bake that triggers a re-bake. */
const BAKE_REL = 0.02;
/**
 * Shortest real-time gap (seconds) between colour-triggered bakes: about two a second. A little over
 * half a second, as the renderer's clock runs slightly ahead of the wall clock when extra frames are
 * rendered (the debug samplePixels does).
 */
const BAKE_INTERVAL = 0.55;
/** The HDRI's colour at golden hour leans this far towards DUSK_NEUTRAL (see refreshEnv). */
const DUSK_NEUTRAL = new THREE.Color(1.0, 0.86, 0.62);
const DUSK_NEUTRAL_MIX = 0.9;
/** A change of the HDRI's share this large since the last bake triggers a re-bake (same rate limit). */
const HDRI_REBAKE = 0.03;
/** Below this a colour counts as this bright, so near-black night skies do not re-bake all the time. */
const BAKE_FLOOR = 0.002;

function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Largest change of an RGB channel from b to a, relative to b's strongest channel: a weak channel
 * (the red of the noon sky) drifting by half its value is not a visible change of the light.
 */
function relDiff(a: THREE.Color, b: THREE.Color): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) / Math.max(b.r, b.g, b.b, BAKE_FLOOR);
}

/** The weather inputs the atmosphere reads (sim/weather.ts WeatherState). */
export type EnvWeather = Pick<WeatherState, 'cloud' | 'rain' | 'storm' | 'fog'> & { seaState?: number };
const CLEAR_SKY: Readonly<EnvWeather> = { cloud: 0, rain: 0, storm: 0, fog: 0 };
/** Extra cloud cover at full cloud. */
const WEATHER_COVER = 0.6;
/** How far the sky's colours go to grey at full cloud, and how much rain and storm darken it. */
const SKY_GREY = 0.8;
const RAIN_DARK = 0.35;
const STORM_DARK = 0.3;
/** The sun's light lost at full cloud, and the shadows' strength left. */
const CLOUD_SUN_LOSS = 0.8;
const CLOUD_SHADOW = 0.4;
/** Fog distances at full haze, as a share of the clear ones. */
const HAZE_FAR = 0.45;
const HAZE_NEAR = 0.5;
/** Exposure boost at full cloud: overcast light is flat, not dim. */
const CLOUD_EXPOSURE = 0.1;
/** Lightning: what a full flash adds to the hemisphere fill and to the sky (linear). */
const FLASH_HEMI = 1.0;

/** Moves a palette colour by `k` towards a cool grey of luminance `l`, then scales it. */
function weatherTint(c: THREE.Color, l: number, k: number, scale: number): void {
  c.lerp(cA.setRGB(l * 0.96, l, l * 1.05), k).multiplyScalar(scale);
}

/** Share of the key light a puff of smoke scatters, against a surface facing the light. */
const PUFF_KEY = 0.5;
/** The smoke light never drops below this luminance (lamps, headlights and lit windows light the smoke too). */
const SMOKE_FLOOR = 0.15;

/**
 * Light (linear RGB) a diffuse puff scatters towards the viewer per unit albedo, near enough, as three
 * lights a Lambertian surface: the hemisphere light's sky and ground colours half each (a puff faces
 * every way), a share of the key light, and the image-based light of the baked sky (envMat: its upper
 * half runs from the horizon colour to the top, its lower half is a dark haze).
 */
function puffLight(hemiSky: THREE.Color, hemiGround: THREE.Color, hemiI: number, key: THREE.Color, keyI: number, envI: number, top: THREE.Color, horizon: THREE.Color, out: THREE.Color): THREE.Color {
  const h = (0.5 * hemiI) / Math.PI;
  const k = (PUFF_KEY * keyI) / Math.PI;
  const sky = (a: number, b: number, haze: number) => 0.25 * (a + b) + 0.5 * haze * (b + 0.2);
  return out.setRGB(
    (hemiSky.r + hemiGround.r) * h + key.r * k + sky(top.r, horizon.r, 0.16) * envI,
    (hemiSky.g + hemiGround.g) * h + key.g * k + sky(top.g, horizon.g, 0.15) * envI,
    (hemiSky.b + hemiGround.b) * h + key.b * k + sky(top.b, horizon.b, 0.14) * envI,
  );
}

let noonPuff: THREE.Color | null = null;

/** puffLight at noon: the smoke light's reference, at which the smoke shows its own colours. */
function noonPuffLight(): THREE.Color {
  if (!noonPuff) {
    const s = sample(12);
    const sunDir = new THREE.Vector3();
    skyPath(12, sunDir, new THREE.Vector3());
    const night = darkness(12);
    const sky = new THREE.Color();
    const ground = new THREE.Color();
    const hemiI = hemiLight(s, night, sky, ground);
    noonPuff = puffLight(sky, ground, hemiI, s.sun, s.sunI * sunVisibility(sunDir.y), envIntensity(night), s.top, s.horizon, new THREE.Color());
  }
  return noonPuff;
}

/**
 * The sea samples its ripple tile twice: as mapped (one tile per 6.67 m), and turned by atan2(sin, cos)
 * (37 degrees) and enlarged by 1 / scale (2.69, far from any simple fraction), so the two repeats never
 * line up and the sum shows no lattice; the second sample drifts its own way (see update).
 */
export const RIPPLE_B = { scale: 0.3719, cos: 0.8, sin: 0.6 } as const;

/** How fast the first ripple sample drifts, in its tiles per second. */
const RIPPLE_A_DRIFT = [0.012, 0.008] as const;
/**
 * ...and the second, in its own tiles per second: the first one's drift turned and scaled into those
 * tiles, plus a drift of its own, so the two samples slide apart.
 */
const RIPPLE_B_DRIFT = [
  RIPPLE_B.scale * (RIPPLE_B.cos * RIPPLE_A_DRIFT[0] - RIPPLE_B.sin * RIPPLE_A_DRIFT[1]) - 0.0061,
  RIPPLE_B.scale * (RIPPLE_B.sin * RIPPLE_A_DRIFT[0] + RIPPLE_B.cos * RIPPLE_A_DRIFT[1]) + 0.0093,
] as const;

/** The baked sky's colours and strength, for the sea to reflect where there is no environment map. */
interface SkyReflection {
  top: { value: THREE.Color };
  horizon: { value: THREE.Color };
  intensity: { value: number };
}

/**
 * Patches the sea's standard material to sum the two ripple samples (see RIPPLE_B). Each sample adds its
 * own offset (`offsetA` in the first one's tiles, `offsetB` in the second one's) to the mapped UV, which
 * carries none (the normal map's own offset stays 0): an offset wraps by whole tiles of its own sample,
 * which that sample cannot show, but would move the other one by a fraction of its tile.
 * With `sky` (no environment map: no float colour buffers) the sea also reflects the baked sky's
 * gradient, worked out in the shader as envMat draws it, so it still takes the sky's colour (orange at
 * sunset) on that path.
 */
function twoLayerRipples(mat: THREE.MeshStandardMaterial, offsetA: { value: THREE.Vector2 }, offsetB: { value: THREE.Vector2 }, sky: SkyReflection | null): void {
  const { scale, cos, sin } = RIPPLE_B;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRippleA = offsetA;
    shader.uniforms.uRippleB = offsetB;
    if (sky) {
      shader.uniforms.uSkyTop = sky.top;
      shader.uniforms.uSkyHorizon = sky.horizon;
      shader.uniforms.uSkyI = sky.intensity;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uSkyTop;\nuniform vec3 uSkyHorizon;\nuniform float uSkyI;').replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular ) && ! defined( USE_ENVMAP )
  {
    vec3 skyR = inverseTransformDirection( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
    vec3 skyC = mix( uSkyHorizon, uSkyTop, smoothstep( 0.0, 0.6, skyR.y ) );
    skyC = mix( skyC, vec3( ${HAZE.r.toFixed(3)}, ${HAZE.g.toFixed(3)}, ${HAZE.b.toFixed(3)} ) * ( uSkyHorizon + 0.2 ), 1.0 - smoothstep( -0.25, 0.0, skyR.y ) );
    radiance += skyC * uSkyI;
  }
#endif`,
      );
    }
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec2 uRippleA;\nuniform vec2 uRippleB;').replace(
      '#include <normal_fragment_maps>',
      `#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 rippleA = texture2D( normalMap, vNormalMapUv + uRippleA ).xyz * 2.0 - 1.0;
  vec2 rippleUv = mat2( ${cos.toFixed(4)}, ${sin.toFixed(4)}, ${(-sin).toFixed(4)}, ${cos.toFixed(4)} ) * vNormalMapUv * ${scale.toFixed(4)} + uRippleB;
  vec3 rippleB = texture2D( normalMap, rippleUv ).xyz * 2.0 - 1.0;
  // The second sample's slopes, turned back into the first one's frame.
  rippleB.xy = mat2( ${cos.toFixed(4)}, ${(-sin).toFixed(4)}, ${sin.toFixed(4)}, ${cos.toFixed(4)} ) * rippleB.xy;
  vec3 mapN = vec3( ( rippleA.xy + rippleB.xy ) * 0.7071, ( rippleA.z + rippleB.z ) * 0.5 );
  mapN.xy *= normalScale;
  normal = normalize( tbn * mapN );
#else
#include <normal_fragment_maps>
#endif`,
    );
  };
  mat.customProgramCacheKey = () => (sky ? 'gta7-sea-ripples-sky' : 'gta7-sea-ripples');
}

/** The shadow map's texel grid is measured from a world point on a grid this coarse (m): see Environment.placeShadow. */
const SHADOW_ANCHOR = 64;
/** The shadow camera stands this far from its target, towards the light (m). */
const SHADOW_REACH = 220;

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  // The sphere is centred on the camera: the interpolated (not normalised) position is the exact
  // point of each pixel's view ray on its triangle, so patterns never bend at the triangle edges.
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // keep at far plane
}`;

const SKY_FS = /* glsl */ `
#define NOISE_TILE ${(1 / CLOUD_NOISE_CELLS).toFixed(6)}
#define NOISE_GAIN ${(1 / CLOUD_NOISE_SCALE).toFixed(6)}
#define SUN_LO ${SUN_LO.toFixed(4)}
#define SUN_HI ${SUN_HI.toFixed(4)}
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uCityGlow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uLightDir;
uniform float uLightAmt;
uniform float uStars;
uniform float uMoon;
uniform float uNight;
uniform float uGolden;
uniform float uCloudT;
uniform float uCloudW;
uniform float uHighT;
uniform sampler2D uNoise;
uniform float uTime;
uniform vec2 uCamXZ;
uniform float uCamY;
uniform vec2 uWind1;
uniform vec2 uWind2;
uniform int uOctaves;
uniform int uHighOctaves;
uniform float uLightTap;
// Weather: cloud greyness 0..1, darkening of rain clouds 0..1, lightning flash 0..1.
uniform float uOvercast;
uniform float uStormDark;
uniform float uFlash;
varying vec3 vDir;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Gradient noise from the tileable noise texture (lattice units in, about -0.7..0.7 out). Its
// mipmaps fade far, fine detail to the mean, so the clouds do not shimmer towards the horizon.
// Callers keep skyNoise in uniform control flow (implicit derivatives); skyNoise0 samples the top level
// and may be used anywhere.
float skyNoise(vec2 p) { return (texture2D(uNoise, p * NOISE_TILE).r - 0.5) * NOISE_GAIN; }
float skyNoise0(vec2 p) { return (textureLod(uNoise, p * NOISE_TILE, 0.0).r - 0.5) * NOISE_GAIN; }
// Each octave is rotated against the last. Mean 0.5; its spread per octave count is CLOUD_SD.
const mat2 OCTAVE = mat2(1.6, 1.2, -1.2, 1.6);
float fbm(vec2 p, int octaves) {
  float a = 0.5;
  float s = 0.0;
  float n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    s += a * skyNoise(p);
    n += a;
    p = OCTAVE * p + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return 0.5 + s / n;
}
float fbm0(vec2 p, int octaves) {
  float a = 0.5;
  float s = 0.0;
  float n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    s += a * skyNoise0(p);
    n += a;
    p = OCTAVE * p + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return 0.5 + s / n;
}

// One jittered point star per cell of a cube-face grid; sized in pixels via fwidth so stars stay
// 1-2 px wide at any field of view.
vec3 stars(vec3 d, float pix) {
  const float K = 180.0;
  vec3 a = abs(d);
  float face;
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) { face = d.x > 0.0 ? 0.0 : 1.0; uv = d.zy / a.x; }
  else if (a.y >= a.z) { face = d.y > 0.0 ? 2.0 : 3.0; uv = d.xz / a.y; }
  else { face = d.z > 0.0 ? 4.0 : 5.0; uv = d.xy / a.z; }
  vec2 cell = floor((uv * 0.5 + 0.5) * K);
  vec2 key = cell + vec2(face * 211.0, face * 97.0);
  if (hash12(key + 0.5) > 0.075) return vec3(0.0);
  vec2 jit = hash22(key);
  vec2 c = (cell + 0.25 + 0.5 * jit) / K * 2.0 - 1.0;
  vec3 s;
  if (face < 1.5) s = vec3(face < 0.5 ? 1.0 : -1.0, c.y, c.x);
  else if (face < 3.5) s = vec3(c.x, face < 2.5 ? 1.0 : -1.0, c.y);
  else s = vec3(c.x, c.y, face < 4.5 ? 1.0 : -1.0);
  float r = length(d - normalize(s)) / pix;
  float core = 1.0 - smoothstep(0.45, 1.25, r);
  float mag = pow(hash12(key * 1.7 + 3.1), 5.0);
  float tw = 0.78 + 0.22 * sin(uTime * (1.5 + 3.0 * jit.x) + jit.y * 40.0);
  vec3 tint = mix(vec3(0.72, 0.8, 1.0), vec3(1.0, 0.9, 0.74), hash12(key * 2.3));
  return tint * core * (0.22 + 1.7 * mag) * tw;
}

// Cloud layers on a virtual plane above the camera: rgb colour, a coverage.
vec4 clouds(vec3 d) {
#ifdef SOFTWARE_SKY
  vec2 q = d.xz / max(d.y, 0.05) * 0.065 + uWind1 * 0.035;
  float n = texture2D(uNoise, q).r;
  float a = smoothstep(0.52, 0.61, n) * smoothstep(0.01, 0.25, d.y);
  a = max(a, smoothstep(0.52 - 0.32 * uOvercast, 0.61 - 0.2 * uOvercast, n) * smoothstep(0.01, 0.25, d.y));
  vec3 day = mix(vec3(0.75, 0.78, 0.86), uSunColor * 1.1, uGolden * 0.8);
  day = mix(day, vec3(0.56, 0.58, 0.62), uOvercast) * (1.0 - uStormDark);
  return vec4(mix(day, vec3(0.025, 0.03, 0.045) + uGlow * 0.5, uNight), a);
#else
  vec2 p = d.xz / max(d.y, 0.03);
  vec2 q1 = (uCamXZ + p * 1500.0) / 900.0 + uWind1;
  // uCloudT is the fbm value that exactly uCloudCover of the sky exceeds (see cloudThreshold).
  float n1 = fbm(q1, uOctaves);
  float dens = smoothstep(uCloudT - uCloudW, uCloudT + uCloudW, n1);
  // Thin high streaks.
  vec2 q2 = (uCamXZ + p * 2400.0) / 400.0 * vec2(0.45, 1.0) + uWind2;
  float n2 = fbm(q2 + vec2(5.2, 1.3), uHighOctaves);
  float high = smoothstep(uHighT - 0.5 * uCloudW, uHighT + 2.0 * uCloudW, n2) * 0.4;
  // Light: compare the density one step towards the sun (or moon): denser there means shadowed here.
  // Same octaves as the density itself, so only the offset towards the light shades the cloud. The
  // contrast fades with the key light (uLightAmt), so the lit side changes over while it is dark.
  float lit = 0.6;
  if (uLightTap > 0.5) {
    vec2 toward = normalize(uLightDir.xz + vec2(1e-4)) * 0.22;
    float tap = smoothstep(uCloudT - uCloudW, uCloudT + uCloudW, fbm(q1 + toward, uOctaves));
    lit = clamp(0.62 + (dens - tap) * 1.1 * uLightAmt, 0.0, 1.0);
  }
  vec3 bright = mix(vec3(1.0), uSunColor, 0.35) * 1.12;
  vec3 shade = mix(uTop, vec3(0.72, 0.74, 0.78), 0.55) * 0.78;
  // Low sun: undersides and edges take its orange.
  shade = mix(shade, uSunColor * vec3(1.0, 0.6, 0.42) * 0.95, uGolden);
  bright = mix(bright, mix(uSunColor, vec3(1.0, 0.86, 0.7), 0.35) * 1.2, uGolden);
  // Overcast: flat grey decks, darker and heavier in rain and storms.
  bright = mix(bright, vec3(0.62, 0.64, 0.68), uOvercast) * (1.0 - uStormDark);
  shade = mix(shade, vec3(0.4, 0.42, 0.46), uOvercast) * (1.0 - 1.2 * uStormDark);
  // Night: dim moonlit tops; low clouds catch the city's glow from below.
  vec3 glowLit = max(uGlow + 0.5 * uCityGlow, vec3(0.0)) * exp(-d.y * 5.0);
  bright = mix(bright, vec3(0.04, 0.044, 0.058) + glowLit * 0.6, uNight);
  shade = mix(shade, vec3(0.02, 0.021, 0.028) + glowLit * 0.9, uNight);
  vec3 col = mix(shade, bright, lit);
  // An overcast night: the deck takes the city's light from below, a little brighter than the sky behind it.
  vec3 under = mix(uHorizon + uGlow, uTop, pow(clamp(d.y, 0.0, 1.0), 0.55)) * 1.15 + glowLit * 0.5;
  col = mix(col, under, uOvercast * uNight);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(sd, 10.0) * (1.0 - dens) * 0.9 * (1.0 - uNight);
  vec3 highCol = mix(bright, uHorizon, 0.25);
  float a = dens + high * (1.0 - dens);
  col = a > 0.0 ? (col * dens + highCol * high * (1.0 - dens)) / a : col;
  // Far clouds sink into the haze; none below the horizon.
  float fade = smoothstep(0.0, 0.2, d.y);
  col = mix(uHorizon + uGlow, col, smoothstep(0.02, 0.35, d.y));
  return vec4(col, a * fade);
#endif
}

// A ridge of hills at a distance (metres) with heights (metres above the sea) between lo and hi:
// 1 inside its silhouette, which sits on the sea at its true angle below the horizon.
float ridge(float h, vec2 hz, float dist, float lo, float hi, float present, float pix, float seed) {
#ifdef SOFTWARE_SKY
  float shape = 0.45 + 0.2 * sin(hz.x * 19.0 + seed) + 0.15 * sin(hz.y * 31.0 + seed);
  float top = (lo + (hi - lo) * shape) * present;
#else
  float top = (lo + (hi - lo) * fbm0(hz * (dist / 1100.0) + seed, 4)) * present;
#endif
  float above = (top - uCamY) / dist;
  float base = -uCamY / dist;
  return (1.0 - smoothstep(above - pix, above + pix, h)) * smoothstep(base - pix, base + pix, h) * step(0.001, present);
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  float t = pow(clamp(h, 0.0, 1.0), 0.55);
  // The city's warm glow hangs low over the horizon at night.
  vec3 horizon = uHorizon + uGlow;
  vec3 col = max(mix(uHorizon, uTop, t) + uGlow * exp(-max(h, 0.0) * 9.0) + uCityGlow * exp(-max(h, 0.0) * ${CITY_GLOW_FALL.toFixed(2)}), vec3(0.0));
  // Below the horizon fade towards a darker haze.
  if (h < 0.0) col = mix(horizon, horizon * 0.55, clamp(-h * 4.0, 0.0, 1.0));
  float pix = max(length(fwidth(d)), 1e-6);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 900.0) * 18.0 + pow(sd, 12.0) * 0.35 + pow(sd, 3.0) * 0.12) * smoothstep(SUN_LO, SUN_HI, uSunDir.y);
  if (h > 0.0 && uStars > 0.0) col += stars(d, pix) * uStars * smoothstep(0.02, 0.25, h);
  if (uMoon > 0.0) {
    vec3 md = d - uMoonDir;
    float m = length(md);
    const float R = 0.012;
    float disc = 1.0 - smoothstep(R - pix, R + pix, m);
    if (disc > 0.0) {
      vec3 mt = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
      vec3 mb = cross(mt, uMoonDir);
      vec2 l = vec2(dot(md, mt), dot(md, mb)) / R;
      float maria = 0.6 * vnoise(l * 2.6 + 3.0) + 0.4 * vnoise(l * 6.0 + 1.0);
      float limb = sqrt(max(0.0, 1.0 - dot(l, l)));
      col = mix(col, vec3(1.0, 0.97, 0.9) * (0.72 + 0.28 * limb) * (0.8 + 0.2 * maria) * 2.2, disc * uMoon);
    }
    col += vec3(0.55, 0.62, 0.8) * (exp(-m * 30.0) * 0.16 + exp(-m * 6.0) * 0.05) * uMoon;
  }
  // Evaluated everywhere (its texture lookups need uniform control flow); it fades out at the horizon.
  vec4 c = clouds(d);
  col = mix(col, c.rgb, c.a);
  // Hills across the bay to the north, west and south (the open ocean lies east): a far ridge about
  // 6 km out and a nearer one at 3.5 km, both standing on the sea, hazed towards the horizon colour.
  if (h < 0.12) {
    vec2 hz = normalize(d.xz + vec2(1e-5));
    float present = 1.0 - smoothstep(0.05, 0.85, hz.x);
    if (present > 0.0) {
      float lightK = 1.0 - 0.92 * uNight;
      vec3 land = vec3(0.2, 0.27, 0.21) * lightK;
      float far = ridge(h, hz, 6000.0, 120.0, 420.0, present, pix, 11.0);
      float near = ridge(h, hz, 3500.0, 42.0, 150.0, present, pix, 3.0);
      col = mix(col, mix(land, horizon, 0.74), far);
      vec3 nearCol = mix(land * 0.8, horizon, 0.52);
      // A few house lights on the nearer hills at night, a few pixels apart.
      float lights = smoothstep(0.5, 0.9, uNight);
      if (lights > 0.0 && near > 0.0) {
        // Azimuth with its wrap-around seam facing east, where there are no hills.
        vec2 g = vec2(atan(hz.y, -hz.x), h) * 300.0;
        vec2 cell = floor(g);
        if (hash12(cell + 3.7) < 0.035) {
          vec2 c = cell + 0.25 + 0.5 * hash22(cell + 7.0);
          float r = length(g - c) / 300.0 / pix;
          nearCol += vec3(1.0, 0.72, 0.42) * (1.0 - smoothstep(0.35, 1.0, r)) * 0.7 * lights;
        }
      }
      col = mix(col, nearCol, near);
    }
  }
  // Lightning lights the whole sky, the clouds most.
  col += vec3(0.55, 0.6, 0.75) * uFlash * (0.6 + 0.6 * c.a);
  gl_FragColor = vec4(col, 1.0);
  // No-ops when three draws into its HDR target (its output pass tone-maps); else this is the output.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

type SkyQuality = 'low' | 'medium' | 'high';

export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: THREE.Mesh;
  readonly water: THREE.Mesh;
  readonly fog: THREE.Fog;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly waterNormal: THREE.Texture;
  private readonly software: boolean;
  /** The waves and shoreline the sea (and the foam rings on it) are drawn with. */
  readonly sea: SeaUniforms = seaUniforms();
  private readonly seaPlane = seaPlane();
  /** High's wave grid, built when first shown (setWaterGrid). */
  private seaGridGeo: THREE.BufferGeometry | null = null;
  /** Offsets of the sea's two ripple samples (see RIPPLE_B), each in its own sample's tiles. */
  private readonly rippleA = { value: new THREE.Vector2() };
  private readonly rippleB = { value: new THREE.Vector2() };
  /** The sky the sea reflects without an environment map (see twoLayerRipples). */
  private readonly skyReflection: SkyReflection = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, intensity: { value: 0 } };
  private readonly cloudNoise = cloudNoiseTexture();
  /** The PMREM target holding the environment map: allocated by the first bake and refilled by every later one. */
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private cubeTarget: THREE.WebGLCubeRenderTarget | null = null;
  private cubeCamera: THREE.CubeCamera | null = null;
  night = 0;
  sunDir = new THREE.Vector3(0, 1, 0);
  moonDir = new THREE.Vector3(0, 1, 0);
  /** Where the key light (this.sun: the sun, or the moon at night) comes from. */
  readonly keyDir = new THREE.Vector3(0, 1, 0);
  /**
   * Light falling on a diffuse puff of smoke, spray or dust relative to noon, which is (1, 1, 1): the
   * unlit particle layers are multiplied by it, so they dim at night with everything lit, and take on
   * the light's tint (orange at sunset, blue under the moon). See updateSmokeLight.
   */
  readonly smokeLight = new THREE.Color(1, 1, 1);
  /**
   * Without float colour buffers (hdr false) there is no environment map: three's PMREM targets are
   * half-float and would come out black, logging GL errors at every bake. This second hemisphere
   * light then gives the scene the baked sky's diffuse light instead (skyIrradiance); only sharp
   * reflections are missing on that path. Null when the environment map is baked.
   */
  readonly envFill: THREE.HemisphereLight | null;
  shadowsEnabled = true;
  /** Spread of the sky shader's cloud fbm at the current octave counts (main and high layer). */
  private cloudSd = CLOUD_SD[5]!;
  private highSd = CLOUD_SD[4]!;
  private readonly onContextRestored = (): void => {
    // A restored WebGL context has lost the GPU copy of the environment map: re-bake on the next frame.
    this.envHours = Number.NaN;
    this.envSunVis = Number.NaN;
  };

  /** `hdr`: whether the GPU renders to half-float targets (probeGpu), which the environment map needs. */
  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    opts: { hdr?: boolean; software?: boolean; hdri?: PreparedHdri | null } = {},
  ) {
    this.software = opts.software ?? false;
    const hdr = opts.hdr ?? true;
    this.fog = new THREE.Fog(0xaed0f2, 180, 760);
    scene.fog = this.fog;

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      defines: this.software ? { SOFTWARE_SKY: 1 } : {},
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color(0, 0, 0) },
        uCityGlow: { value: new THREE.Color(0, 0, 0) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) },
        uLightAmt: { value: 1 },
        uStars: { value: 0 },
        uMoon: { value: 0 },
        uNight: { value: 0 },
        uGolden: { value: 0 },
        uCloudT: { value: 0.55 },
        uCloudW: { value: 0.07 },
        uHighT: { value: 0.6 },
        uNoise: { value: this.cloudNoise },
        uTime: { value: 0 },
        uCamXZ: { value: new THREE.Vector2() },
        uCamY: { value: 2 },
        uWind1: { value: new THREE.Vector2() },
        uWind2: { value: new THREE.Vector2() },
        uOctaves: { value: 5 },
        uHighOctaves: { value: 4 },
        uLightTap: { value: 1 },
        uOvercast: { value: 0 },
        uStormDark: { value: 0 },
        uFlash: { value: 0 },
      },
      side: THREE.BackSide,
      // Drawn after the opaque scene at the far plane: pixels already covered fail the depth test
      // and are never shaded.
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 1000;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -75;
    sc.right = 75;
    sc.top = 75;
    sc.bottom = -75;
    sc.near = 1;
    sc.far = 500;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6b5a48, 1);
    scene.add(this.hemi);
    this.envFill = hdr ? null : new THREE.HemisphereLight(0x000000, 0x000000, 1);
    if (this.envFill) scene.add(this.envFill);

    this.waterNormal = waterNormalTexture();
    this.waterNormal.repeat.set(900, 900);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x135a73, roughness: 0.22, metalness: 0.1, normalMap: this.waterNormal, normalScale: new THREE.Vector2(0.22, 0.22) });
    twoLayerRipples(waterMat, this.rippleA, this.rippleB, this.envFill ? this.skyReflection : null);
    patchSeaMaterial(waterMat, this.sea);
    const simpleWater = this.software
      ? softwareSeaMaterial(this.sea, {
          uNormal: { value: this.waterNormal }, uDrift: this.rippleA,
          uTop: this.skyReflection.top, uHorizon: this.skyReflection.horizon,
          uNight: this.skyMat.uniforms.uNight!,
        })
      : null;
    if (simpleWater) waterMat.dispose();
    const water = new THREE.Mesh(this.seaPlane, simpleWater ?? waterMat);
    // Displaced vertices leave the plane's bounds; the sea is always in view anyway.
    water.frustumCulled = false;
    water.position.y = WATER_Y;
    water.receiveShadow = true;
    // Streets/buildings cover most ocean pixels from within the city. Shade only exposed sea,
    // after opaque land has filled depth and before the sky at renderOrder 1000.
    water.renderOrder = 900;
    this.water = water;
    scene.add(water);

    // Image based lighting: a tiny sky scene re-baked whenever the palette changes. With the sky HDRI loaded, its
    // clouds and gradient replace the analytic sky above the horizon (uHdriMix), recoloured and scaled per channel and
    // by height (uHdriGain towards the zenith, uHdriGainH at the horizon, blended as the analytic gradient is) so that
    // surfaces facing up and sideways get the analytic sky's light: the HDRI adds structure to reflections, the time of
    // day keeps the colour and brightness.
    this.hdri = opts.hdri === undefined ? (hdr && !this.software ? prepareHdri(assets.texture('env.sky')) : null) : opts.hdri;
    this.noHdri = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.noHdri.needsUpdate = true;
    this.envMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSun: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uHdri: { value: this.hdri?.texture ?? this.noHdri }, uHdriMix: { value: 0 }, uHdriGain: { value: new THREE.Color(1, 1, 1) }, uHdriGainH: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSun; uniform vec3 uSunDir; varying vec3 vP;
        uniform sampler2D uHdri; uniform float uHdriMix; uniform vec3 uHdriGain; uniform vec3 uHdriGainH;
        void main(){ vec3 d = normalize(vP); float h = d.y;
          vec3 c = mix(uHorizon, uTop, smoothstep(0.0, 0.6, h));
          c = mix(c, vec3(0.16, 0.15, 0.14) * (uHorizon + 0.2), 1.0 - smoothstep(-0.25, 0.0, h));
          if (uHdriMix > 0.0) {
            vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(h, -1.0, 1.0)) * 0.31830989 + 0.5);
            vec3 gain = mix(uHdriGainH, uHdriGain, smoothstep(0.0, 0.6, h));
            c = mix(c, texture2D(uHdri, uv).rgb * gain, uHdriMix * smoothstep(-0.02, 0.06, h));
          }
          c += uSun * pow(max(dot(d, uSunDir), 0.0), 24.0) * 2.5;
          gl_FragColor = vec4(c, 1.0); }`,
    });
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), this.envMat));
    this.pmrem = null;
    if (hdr) {
      try {
        this.pmrem = new THREE.PMREMGenerator(renderer);
      } catch {
        this.pmrem = null;
      }
    }
    renderer.domElement?.addEventListener?.('webglcontextrestored', this.onContextRestored);
  }

  private readonly envScene = new THREE.Scene();
  /** The reduced sky HDRI the bake blends in (null: the analytic sky only, as without assets or on the software tier). */
  private readonly hdri: PreparedHdri | null;
  private readonly noHdri: THREE.DataTexture;
  /** The HDRI's share at the last bake, and now; and iblSmoothing at the last bake. */
  bakedHdriMix = 0;
  hdriMixNow = 0;
  private bakedRatio = 1;
  private ratioNow = 1;
  private bakedHourForTint = 12;
  private readonly tmpGrad = new THREE.Color();
  private readonly tmpTop = new THREE.Color();
  private readonly tmpHor = new THREE.Color();
  private readonly tmpGold = new THREE.Color();
  private readonly envMat: THREE.ShaderMaterial;
  private pmrem: THREE.PMREMGenerator | null;
  private envHours = Number.NaN;
  /** sunVisibility at the last bake: the reflected sun is re-baked as it sets, not only every quarter hour. */
  private envSunVis = Number.NaN;
  private readonly envUp = new THREE.Color();
  private readonly envDown = new THREE.Color();
  private readonly envSun = new THREE.Color();
  /** The analytic sky the environment map was last baked from (see update). */
  private readonly bakedTop = new THREE.Color();
  private readonly bakedHorizon = new THREE.Color();
  private readonly bakedSun = new THREE.Color();
  /** skyIrradiance (up) of the baked sky, and of the sky as it is now. */
  readonly bakedUp = new THREE.Color();
  readonly upNow = new THREE.Color();
  /** Renderer time (real seconds) of the last bake. */
  private lastBakeTime = -Infinity;
  /** Environment-map bakes so far. */
  envBakes = 0;
  /** What lights the scene's image-based light: 'hdri' (the sky HDRI blended with the analytic sky), 'analytic', or 'fill' (no environment map). */
  get envSource(): 'hdri' | 'analytic' | 'fill' {
    if (this.envFill || !this.pmrem) return 'fill';
    return this.hdri ? 'hdri' : 'analytic';
  }

  /** Game hour of the last bake (NaN until the first, and after a context restore). */
  get lastBakeHour(): number {
    return this.envHours;
  }

  /**
   * Re-bakes the environment map for the current sky (cheap: a 24-segment sphere). The sky is
   * rendered with one reused cube camera into one cube target, then prefiltered into the PMREM
   * target of the first bake, so scene.environment never changes identity and the env-mapped
   * materials never re-resolve their programs. Never without half-float targets (no PMREM then).
   */
  private refreshEnv(s: { top: THREE.Color; horizon: THREE.Color }, sun: THREE.Color, sunDir: THREE.Vector3): void {
    if (!this.pmrem) return;
    const u = this.envMat.uniforms;
    (u.uTop!.value as THREE.Color).copy(s.top);
    (u.uHorizon!.value as THREE.Color).copy(s.horizon);
    u.uHdriMix!.value = this.hdri ? this.bakedHdriMix : 0;
    if (this.hdri) {
      // Per channel: what the HDRI must give an up-facing surface so the whole map gives the analytic sky's light (sun
      // included) times bakedRatio (iblSmoothing): the gradient's share, plus the change of the whole, over the HDRI's.
      // At golden hour the HDRI's colour leans from the sunset sky's red and violet towards a warm neutral (same
      // luminance), so the light it gives the streets is warm rather than magenta; the analytic part keeps the sky's.
      const all = this.envUp;
      const d = this.bakedRatio - 1;
      const grad = this.tmpGrad.setRGB(0.892 * s.top.r + 0.108 * s.horizon.r, 0.892 * s.top.g + 0.108 * s.horizon.g, 0.892 * s.top.b + 0.108 * s.horizon.b);
      const k = DUSK_NEUTRAL_MIX * goldenHour(this.bakedHourForTint);
      if (k > 0) grad.lerp(this.tmpGold.copy(DUSK_NEUTRAL).multiplyScalar(luminance(grad) / luminance(DUSK_NEUTRAL)), k);
      // The zenith and horizon gains follow the analytic top and horizon colours over the HDRI's own means (the
      // golden-hour lean applied to both), then one factor per channel brings the up-facing light to the target.
      const hdri = this.hdri;
      const top = this.tmpTop.copy(s.top);
      const hor = this.tmpHor.copy(s.horizon);
      if (k > 0) {
        top.lerp(this.tmpGold.copy(DUSK_NEUTRAL).multiplyScalar(luminance(top) / luminance(DUSK_NEUTRAL)), k);
        hor.lerp(this.tmpGold.copy(DUSK_NEUTRAL).multiplyScalar(luminance(hor) / luminance(DUSK_NEUTRAL)), k);
      }
      const gt = u.uHdriGain!.value as THREE.Color;
      const gh = u.uHdriGainH!.value as THREE.Color;
      for (const c of ['r', 'g', 'b'] as const) {
        const t0 = top[c] / Math.max(hdri.meanTop[c], 1e-6);
        const h0 = hor[c] / Math.max(hdri.meanHorizon[c], 1e-6);
        const got = t0 * hdri.upTop[c] + h0 * hdri.upHorizon[c];
        const kc = Math.max(0, grad[c] + all[c] * d) / Math.max(got, 1e-6);
        gt[c] = t0 * kc;
        gh[c] = h0 * kc;
      }
    }
    (u.uSun!.value as THREE.Color).copy(sun);
    (u.uSunDir!.value as THREE.Vector3).copy(sunDir);
    try {
      if (!this.cubeTarget || !this.cubeCamera) {
        this.cubeTarget = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType });
        this.cubeCamera = new THREE.CubeCamera(0.1, 100, this.cubeTarget);
      }
      this.cubeCamera.update(this.renderer, this.envScene);
      const target = this.pmrem.fromCubemap(this.cubeTarget.texture, this.envTarget);
      if (target !== this.envTarget) {
        this.envTarget?.dispose();
        this.envTarget = target;
      }
      if (this.scene.environment !== target.texture) this.scene.environment = target.texture;
    } catch {
      this.scene.environment = null;
    }
  }

  /** The shoreline's terrain (the layout's land and beach). */
  setShore(b: Bounds): void {
    setShore(this.sea, b);
  }

  /**
   * High: the sea is the displaced wave grid; otherwise the flat plane with the same waves in its normals. Only the
   * geometry and a uniform change, so the sea's program is shared. Never on the software sea (it has no grid path).
   */
  setWaterGrid(on: boolean): void {
    const grid = on && !this.software;
    if (grid) {
      this.seaGridGeo ??= seaGrid();
      this.water.geometry = this.seaGridGeo;
    } else {
      this.water.geometry = this.seaPlane;
      // Frees its GPU buffers; it uploads again if High comes back.
      this.seaGridGeo?.dispose();
    }
    this.sea.uDisplace.value = grid ? 1 : 0;
  }

  get waterGrid(): boolean {
    return this.water.geometry === this.seaGridGeo && this.seaGridGeo !== null;
  }

  setShadows(on: boolean): void {
    this.shadowsEnabled = on;
    this.sun.castShadow = on;
  }

  /** Sky detail per graphics quality: low draws 2-octave clouds without the light tap. */
  setQuality(q: SkyQuality): void {
    const u = this.skyMat.uniforms;
    const octaves = q === 'high' ? 5 : q === 'medium' ? 4 : 2;
    const high = Math.max(2, octaves - 1);
    u.uOctaves!.value = octaves;
    u.uHighOctaves!.value = high;
    u.uLightTap!.value = q === 'low' ? 0 : 1;
    this.cloudSd = CLOUD_SD[octaves]!;
    this.highSd = CLOUD_SD[high]!;
  }

  /**
   * Updates lighting for the given time of day and weather (clear when absent), and moves the shadow frustum with the
   * camera focus. `flash` (0..1) is the lightning flash; the caller leaves it 0 when flashes are turned off.
   */
  update(hours: number, focus: THREE.Vector3, camera: THREE.Camera, time: number, renderer: THREE.WebGLRenderer, weather: Readonly<EnvWeather> = CLEAR_SKY, flash = 0): void {
    const s = sample(hours);
    const cloud = clamp(weather.cloud, 0, 1);
    const rain = clamp(weather.rain, 0, 1);
    const storm = clamp(weather.storm, 0, 1);
    const haze = clamp(weather.fog, 0, 1);
    if (cloud > 0 || rain > 0 || storm > 0) {
      // Cloud turns the sky one even grey; rain and storms darken it. Everything below (fog, fill, the baked sky) follows.
      const l = 0.5 * (luminance(s.top) + luminance(s.horizon));
      const darken = 1 - RAIN_DARK * rain - STORM_DARK * storm;
      // By night the zenith keeps its own darkness: a grey deck lit from below by the city, not a lighter sky.
      const n = darkness(hours);
      weatherTint(s.top, lerp(l * 0.85, luminance(s.top), n), SKY_GREY * cloud, darken);
      weatherTint(s.horizon, l * 1.05, SKY_GREY * cloud, darken);
    }
    skyPath(hours, this.sunDir, this.moonDir);
    const sunDir = this.sunDir;
    const moonDir = this.moonDir;
    this.night = darkness(hours);
    const night = this.night;
    // At night the city's light glows warm on the horizon and the fog blends part of the way towards
    // it, so distant buildings fade into a warm haze rather than a navy wall. Only once it is
    // properly dark, so the sunset keeps its colours.
    const dark = smoothstep(0.55, 1, night);
    const horizon = s.horizon.clone().lerp(NIGHT_HORIZON_GLOW, dark * GLOW_STRENGTH);
    // The sky adds the difference near the horizon only (it fades out with elevation).
    const glow = horizon.clone().sub(s.horizon);

    const u = this.skyMat.uniforms;
    (u.uTop!.value as THREE.Color).copy(s.top);
    (u.uHorizon!.value as THREE.Color).copy(s.horizon);
    (u.uGlow!.value as THREE.Color).copy(glow);
    // Overcast, the deck catches it from below instead (see clouds()); rain and storms keep it.
    (u.uCityGlow!.value as THREE.Color).copy(CITY_GLOW).multiplyScalar(cityGlow(hours) * (1 - 0.5 * cloud));
    (u.uSunDir!.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor!.value as THREE.Color).copy(s.sun);
    (u.uMoonDir!.value as THREE.Vector3).copy(moonDir);
    // The key light: the sun while the sky shows it, else the moon once the sun's light is gone (see SUN_LO).
    const sunVis = sunVisibility(sunDir.y);
    const sunI = s.sunI * sunVis * (1 - CLOUD_SUN_LOSS * cloud);
    const moonUp = moonRamp(sunDir.y);
    const moonI = MOON_I * night * moonUp * (1 - CLOUD_SUN_LOSS * cloud);
    const useMoon = moonI > sunI;
    (u.uLightDir!.value as THREE.Vector3).copy(useMoon ? moonDir : sunDir);
    u.uLightAmt!.value = (useMoon ? moonUp : sunVis) * (1 - 0.7 * cloud);
    u.uStars!.value = starsAt(night) * (1 - cloud);
    u.uMoon!.value = smoothstep(0.3, 0.85, night) * (1 - 0.8 * cloud);
    u.uNight!.value = night;
    u.uGolden!.value = goldenHour(hours) * (1 - 0.8 * cloud);
    u.uOvercast!.value = cloud;
    u.uStormDark!.value = RAIN_DARK * rain + STORM_DARK * storm;
    u.uFlash!.value = flash;
    const cover = Math.min(0.97, coverAt(hours, night) + WEATHER_COVER * cloud);
    u.uCloudT!.value = cloudThreshold(cover, this.cloudSd);
    u.uCloudW!.value = CLOUD_EDGE * this.cloudSd;
    u.uHighT!.value = cloudThreshold(cover * 0.5, this.highSd);
    // Wrapped daily: twinkle and wind stay precise in float32, and jump at most once a day.
    const t = time % 86400;
    u.uTime!.value = t;
    (u.uCamXZ!.value as THREE.Vector2).set(camera.position.x, camera.position.z);
    u.uCamY!.value = Math.max(0.5, camera.position.y - WATER_Y);
    // Wind drift in noise units (under 2000 after a day, where the hash is still exact enough).
    (u.uWind1!.value as THREE.Vector2).set(t * 0.0105, t * 0.0042);
    (u.uWind2!.value as THREE.Vector2).set(t * 0.021, t * 0.0085);
    this.sky.position.copy(camera.position);

    // Daylight sun, or a dim bluish moon at night.
    const lightDir = this.keyDir;
    if (useMoon) lightDir.copy(moonDir);
    else if (sunDir.y > KEY_MIN_Y) lightDir.copy(sunDir);
    else lightDir.set(sunDir.x, KEY_MIN_Y, sunDir.z).normalize();
    if (useMoon) this.sun.color.copy(MOON_COLOR);
    else this.sun.color.copy(s.sun).lerp(KEY_GOLD, KEY_GOLD_MIX * goldenHour(hours));
    this.sun.intensity = Math.max(sunI, moonI);
    // Under cloud the light is diffuse: softer shadows.
    this.sun.shadow.intensity = 1 - (1 - CLOUD_SHADOW) * cloud;
    this.placeShadow(focus, lightDir);

    this.hemi.intensity = hemiLight(s, night, this.hemi.color, this.hemi.groundColor) * (1 + 0.25 * cloud) * (1 - 0.15 * rain - 0.15 * storm) + FLASH_HEMI * flash;
    if (cloud > 0) weatherTint(this.hemi.color, luminance(this.hemi.color), 0.6 * cloud, 1);

    this.fog.color.copy(s.horizon).lerp(NIGHT_HORIZON_GLOW, dark * FOG_GLOW_STRENGTH).lerp(s.top, 0.15 * (1 - night));
    this.fog.near = (this.software ? lerp(70, 50, night) : lerp(180, 90, night)) * (1 - (1 - HAZE_NEAR) * haze);
    this.fog.far = (this.software ? 220 : lerp(780, 520, night)) * (1 - (1 - HAZE_FAR) * haze);
    const envI = envIntensity(night);
    // The baked sky's sun, which sets with the sky's own (sunVisibility).
    const envSun = this.envSun.copy(s.sun).multiplyScalar(Math.min(1.5, s.sunI / 2) * sunVis);
    skyIrradiance(s.top, s.horizon, envSun, sunDir.y, this.envUp, this.envDown);
    this.upNow.copy(this.envUp);
    if (this.hdri && !this.envFill) {
      // The map's up-facing light with the HDRI part brightened or dimmed to the smoothed curve (see iblSmoothing).
      this.hdriMixNow = hdriWeight(hours, cloud);
      this.ratioNow = iblSmoothing(hours);
      this.upNow.multiplyScalar(1 - this.hdriMixNow + this.hdriMixNow * this.ratioNow);
    }
    if (this.envFill) {
      this.scene.environmentIntensity = envI;
      // A hemisphere light's colour is irradiance; the sky's diffuse light is PI x its average radiance.
      this.envFill.color.copy(this.envUp).multiplyScalar(Math.PI * envI);
      this.envFill.groundColor.copy(this.envDown).multiplyScalar(Math.PI * envI);
      this.skyReflection.top.value.copy(s.top);
      this.skyReflection.horizon.value.copy(s.horizon);
      this.skyReflection.intensity.value = envI;
    } else {
      // Re-bake when the sky has visibly changed since the last bake or the sun has fully set or risen
      // (so its reflection is gone, or whole, with the sky's), at most every half real second (a bake
      // costs about a millisecond); and at once after a jump in time or a quarter game hour. NaN
      // (first frame, context restore) forces a bake.
      const diff = Math.abs(hours - this.envHours);
      const jumped = !(Math.min(diff, 24 - diff) <= 0.25);
      const settled = (sunVis === 0 || sunVis === 1) && sunVis !== this.envSunVis;
      const changed = relDiff(s.top, this.bakedTop) > BAKE_REL || relDiff(s.horizon, this.bakedHorizon) > BAKE_REL || relDiff(envSun, this.bakedSun) > BAKE_REL
        || Math.abs(this.hdriMixNow - this.bakedHdriMix) > HDRI_REBAKE;
      const due = time - this.lastBakeTime >= BAKE_INTERVAL || time < this.lastBakeTime;
      if (jumped || ((changed || settled) && due)) {
        this.envHours = hours;
        this.envSunVis = sunVis;
        this.lastBakeTime = time;
        this.envBakes++;
        this.bakedTop.copy(s.top);
        this.bakedHorizon.copy(s.horizon);
        this.bakedSun.copy(envSun);
        this.bakedUp.copy(this.upNow);
        this.bakedHdriMix = this.hdriMixNow;
        this.bakedRatio = this.ratioNow;
        this.bakedHourForTint = hours;
        this.refreshEnv(s, envSun, sunDir);
      }
      // Between bakes the map holds an older sky: scale its light by how much brighter the sky is now,
      // so the scene brightens and darkens every frame rather than in a step at each bake.
      const k = clamp(luminance(this.upNow) / Math.max(luminance(this.bakedUp), 1e-4), 0.5, 2);
      this.scene.environmentIntensity = envI * k;
    }
    this.updateSmokeLight(s);
    renderer.toneMappingExposure = s.exposure * (1 + CLOUD_EXPOSURE * cloud);

    // Each ripple sample's offset wraps by whole tiles of its own (see twoLayerRipples).
    this.rippleA.value.set((time * RIPPLE_A_DRIFT[0]) % 1, (time * RIPPLE_A_DRIFT[1]) % 1);
    this.rippleB.value.set((time * RIPPLE_B_DRIFT[0]) % 1, (time * RIPPLE_B_DRIFT[1]) % 1);
    const ox = snapSea(camera.position.x);
    const oz = snapSea(camera.position.z);
    this.water.position.set(ox, WATER_Y, oz);
    updateSea(this.sea, time, weather.seaState ?? CALM_SEA, ox, oz);
  }

  /**
   * Centres the shadow frustum on the focus, snapped to whole shadow-map texels in the shadow camera's
   * own frame, so static shadow edges are not re-rasterized as the camera moves. three aims that camera
   * along -L with +Y up, so its texel rows and columns run along ex = Y x L and ey = L x ex, and a texel
   * is the frustum's width over the live map size (1024 on Medium). The snap is measured from a world
   * point on a SHADOW_ANCHOR grid near the focus rather than from the origin: the light turns all the
   * time with the sun, which slides the texel grid under the scene in proportion to the distance from
   * that point. Moving the target along L changes nothing on the map.
   */
  private placeShadow(focus: THREE.Vector3, L: THREE.Vector3): void {
    const shadow = this.sun.shadow;
    const sc = shadow.camera;
    const texel = (sc.right - sc.left) / Math.max(1, shadow.mapSize.x);
    const ex = this.tmpEx.set(L.z, 0, -L.x);
    if (ex.lengthSq() < 1e-12) ex.set(1, 0, 0);
    else ex.normalize();
    const ey = this.tmpEy.crossVectors(L, ex);
    const ax = Math.round(focus.x / SHADOW_ANCHOR) * SHADOW_ANCHOR;
    const az = Math.round(focus.z / SHADOW_ANCHOR) * SHADOW_ANCHOR;
    const r = this.tmpR.set(focus.x - ax, focus.y, focus.z - az);
    const u = Math.round(r.dot(ex) / texel) * texel;
    const v = Math.round(r.dot(ey) / texel) * texel;
    const target = this.sun.target.position.set(ax, 0, az).addScaledVector(ex, u).addScaledVector(ey, v).addScaledVector(L, r.dot(L));
    this.sun.position.copy(target).addScaledVector(L, SHADOW_REACH);
    this.sun.target.updateMatrixWorld();
  }

  /** smokeLight from the lights just set: puffLight relative to noon, never darker than SMOKE_FLOOR. */
  private updateSmokeLight(s: { top: THREE.Color; horizon: THREE.Color }): void {
    const c = puffLight(this.hemi.color, this.hemi.groundColor, this.hemi.intensity, this.sun.color, this.sun.intensity, this.scene.environmentIntensity, s.top, s.horizon, this.smokeLight);
    const noon = noonPuffLight();
    c.setRGB(c.r / noon.r, c.g / noon.g, c.b / noon.b);
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    if (lum < SMOKE_FLOOR) c.multiplyScalar(SMOKE_FLOOR / Math.max(lum, 1e-6));
  }

  private readonly tmpEx = new THREE.Vector3();
  private readonly tmpEy = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();

  dispose(): void {
    this.renderer.domElement?.removeEventListener?.('webglcontextrestored', this.onContextRestored);
    this.cloudNoise.dispose();
    this.seaPlane.dispose();
    this.seaGridGeo?.dispose();
    this.cubeTarget?.dispose();
    this.envTarget?.dispose();
    this.pmrem?.dispose();
    this.hdri?.texture.dispose();
    this.noHdri.dispose();
    this.envMat.dispose();
  }

  /**
   * After a WebGL context restore the baked map is gone with the old context: drop it (disposing it
   * would delete objects of that context) and re-bake on the next update.
   */
  contextRestored(): void {
    this.envTarget = null;
    this.envHours = Number.NaN;
    this.envSunVis = Number.NaN;
  }
}
