// The sea surface: the Gerstner waves (render/waves.ts) and the analytic shoreline patched into the sea's standard
// material, the camera-snapped wave grid drawn on High and Medium, and the software sea's shader. The sea is lit as
// water: a dark body, and the sky it mirrors by Fresnel above the horizon; the sun and moon glint in its ripples, light
// glows through its crests and whitecaps break on the steep ones in a storm. The body's colour follows a render-only
// shelf that keeps falling offshore (turquoise shallows, dark open water), its five ripple layers are warped and
// modulated by low-frequency noise so their tiles do not line up and fade with distance into its roughness, and foam
// rings the piers' pilings. Las Lomas County's beaches come from a depth map baked from its ground (countyShore), sampled
// once per fragment; the waves' shelter and depth from the shelter map (render/seaShelter.ts).

import * as THREE from 'three';
import { BEACH_W, CURB_H, SAND_DROP, SEABED_Y, WATER_Y } from '../world/constants';
import { countryGround, type Country } from '../world/country';
import { rectContains, type Bounds, type Rect } from '../world/layout';
import { WATER_TILT } from './textures';
import {
  CALM_SEA, COARSE_CELL, COARSE_EXTENT, FINE_EXTENT, OPEN_SEA, SEA_SLOPE2_GLSL, SEA_WAVES_GLSL, SKIRT_EXTENT, SURF_DEPTH, SURF_GAMMA, SURF_K, SURF_SHOAL, SWELL, seaHeight,
  surfPhase, wavePhases, type SeaSurface, type ShelterMap, type WaveUniform,
} from './waves';

/** The sand's drop-off into deep water past the beach's end (CityView.buildCoast), m. */
const DROP_OFF = 25;
/** Shallows colour over sand, and the wet sand seen through the thinnest water (sRGB). */
const SHALLOW = 0x2fa89e;
const SAND_TINT = 0x86a89a;
/**
 * The water's own colour by the quays (the material's), in open water past ~9 m and far offshore (sRGB): the light
 * scattered back up out of the water body, dark and greyed, so that most of what open water shows is the sky's
 * reflection (seaShallows).
 */
export const SEA_MID = 0x0e4656;
const DEEP = 0x0a2c40;
const ABYSS = 0x061a29;
/** Water's reflectance looking straight down (Schlick's F0 for an index of 1.33). */
export const SEA_F0 = 0.02;
/**
 * The water's own roughness, under the ripples it draws: near the floor three allows (0.0525), so the sun and moon
 * glint in the ripples round the camera; the ripples faded out with distance add theirs on top (patchSeaMaterial).
 */
export const SEA_ROUGHNESS = 0.06;
/**
 * The baked sky's sun (Environment's envMat): its colour times gain times pow(cos, pow) of the angle from it, a glow
 * some 28 degrees across, far brighter than the dome's own (SKY_SUN_HALO). The sea takes `taken` of it back out of the
 * sky it reflects (seaSkyRadiance), widened as the lookup blurs it, and mirrors the dome's glow instead: the sun's own
 * light glints off the ripples, sharply, as the key light, and the map's glow would smear a second sun path under it.
 * The map holds a little less of it than the formula gives (at 16:00 taking all of it clamped some 12,000 pixels of
 * the sun path to black, taking 0.8 none), so less is taken.
 */
export const SKY_SUN_GLOW = { pow: 24, gain: 2.5, taken: 0.7 } as const;
/**
 * The dome's own glow round the sun (Environment's sky): its colour times the sum of gain times pow(cos, pow) of the
 * angle from it, a tight and a wide part, as the sun shows (sunVisibility). The sea mirrors it, so the water round the
 * sun's glitter is lit as the sky round the sun is.
 */
export const SKY_SUN_HALO = { tight: { pow: 12, gain: 0.35 }, wide: { pow: 3, gain: 0.12 } } as const;
/**
 * The sky dome's glows (Environment's sky) fall off with the sine of the elevation at these rates: the night's glow
 * all round the horizon, and the city's light over it (half strength about 6 degrees up). The environment map holds
 * neither, so the sea adds them to the sky it reflects as the dome draws them.
 */
export const SKY_GLOW_FALL = { horizon: 9, city: 6.5 } as const;
/**
 * How much of those night glows the sea mirrors. The city's light lies over the land, so the water takes it only looking
 * towards the city (gathered as the dome gathers it off the land, by the cube of the cosine of the bearing), broken by
 * bearing into the lights along the shore (CITY_STREAKS), each of which the ripples draw out into a warm streak; the glow
 * all round the horizon it takes faintly, so the open night sea stays blue-black rather than mirroring the warm horizon
 * band on every ripple turned away from the eye.
 */
export const SEA_NIGHT_GLOW = { horizon: 0.1, city: 1.2 } as const;
/**
 * The shore's lights as the night sea mirrors them: the city's glow on the water varies with the bearing in cells of
 * 360 / cells degrees, each cell's strength a random number to this power times gain (mean gain / (power + 1)).
 */
export const CITY_STREAKS = { cells: 160, power: 4, gain: 3 } as const;
/**
 * The moon's halo on the sea: `gain` times the dome's (SKY_MOON_HALO), and stretched in elevation (an elevation
 * difference counts `stretch` of its size). The halo stands in for the moonlight the waves' unresolved slopes spread
 * round its glints, which the drawn ripples alone leave sparse; at grazing angles a slope spreads a reflection up and
 * down far more than sideways, so the halo is drawn out into a column from the glints to the horizon.
 */
export const SEA_MOON_PATH = { gain: 5, stretch: 0.3 } as const;
/**
 * By night the sea's mirrored sky takes this colour (at its own luminance): the moonlit blue of the night sky's light
 * (Environment's NIGHT_SKY_LIGHT) under the dark clouds the dome draws by night, rather than the map's dusk palette,
 * which still mixes in the sunset's red at 20:30 and turned the night sea mauve.
 */
export const SEA_NIGHT_SKY = [0.78, 0.99, 1.73] as const;
/**
 * The dome's moon halo (Environment's sky): its colour, and the strength and falloff with the distance from the moon of
 * its tight and wide parts. The environment map has no moon, so the sea adds the halo to the sky it reflects: the
 * moon's glints sit in a soft column of its light.
 */
export const SKY_MOON_HALO = { color: [0.55, 0.62, 0.8], tight: { gain: 0.16, fall: 30 }, wide: { gain: 0.05, fall: 6 } } as const;
/**
 * The brightest a sun or moon glint on the sea is drawn (linear, before exposure): its true peak is a hundred times
 * this, and bloom spreads anything that bright into a solid white column.
 */
export const SEA_GLINT_MAX = 6;
/**
 * Whitecaps break on the crests whose compression (seaWave's steep, the sum of Gerstner's steepness times slope: how near
 * they are to breaking) passes the first of these, and cover them by the second. The crests reach at most 0.09 at calm
 * and in plain rain (sea state 0.3: no whitecaps), 0.66 in a storm; they start breaking from about sea state 0.5.
 */
export const WHITECAP_STEEP = [0.2, 0.45] as const;
/**
 * The light that shines through a thin crest towards an eye looking into the sun or moon (linear, per unit of light):
 * the water's green-blue glow on the backs of the waves (SEA_DIRECT_GLSL).
 */
export const CREST_GLOW = [0.02, 0.16, 0.12] as const;
/**
 * The software sea draws its body unlit: the shallows' colour times this share of daylight, about what the sun and sky
 * give the lit sea's water body at noon.
 */
export const SOFTWARE_BODY = 1.5;
/** The ripples' normal scale (the material's): chop steep enough to break the sky's reflection up round the camera. */
export const SEA_RIPPLE = 0.36;
/**
 * The drawn seabed keeps falling offshore past the sim's flat SEABED_Y (render only; the sim's waterDepth stays as it
 * is): SHELF_SLOPE m per m beyond SHELF_START m outside the land rectangle (where the beach's drop-off ends).
 */
export const SHELF_SLOPE = 0.11;
export const SHELF_START = DROP_OFF;

/** The piers' pilings (CityView.buildCoast): along each deck from minX + PILING_START every PILING_STEP m, PILING_INSET in from both long sides. */
export const PILING_START = 2;
export const PILING_STEP = 7;
export const PILING_INSET = 0.6;
export const PILING_RADIUS = 0.25;
/** Decks the sea shader looks for pilings under (the layout has six). */
export const MAX_PILING_DECKS = 8;
/** Water bodies cut into the land (layout.water) the quay foam keeps out of. */
export const MAX_SEA_CUTS = 8;
/** Points along each side of Las Lomas County's depth map (countyShore): about 1.9 m apart across it, 2.4 m along it. */
export const COUNTY_TEXELS = 512;
/** Rectangles of the county's land the drawn shelf falls away from (it has six). */
export const MAX_COUNTY_LAND = 8;
/** Water depths (m) over which the beach's surf bands fade in seaward of the swash (4.1-7.6 m out on the 1:34 sand). */
export const SURF_BAND_FADE = [0.12, 0.22] as const;
/** Piling foam reaches at most this far (m) out from a piling's side. */
export const PILING_FOAM = 0.7;
/**
 * Far off, the ring widens to cover at least PILING_FOAM_PX screen pixels (its footprint, m per pixel, grows with
 * distance and grazing angle), up to PILING_FOAM_FAR m: at 0.7 m it thins to a pixel at 30 m and vanishes.
 */
export const PILING_FOAM_PX = 2.5;
export const PILING_FOAM_FAR = 1.1;
/**
 * Foam scatters the sky's light more than the water's albedo does: its indirect light is raised by this share. Under a
 * deck (in the sun's shadow) that keeps it a white ring rather than a faint arc against the sky the water reflects;
 * at night it scales the dim sky light, so it does not glow.
 */
export const FOAM_SKY_LIFT = 1.6;

/**
 * World-space scales of the sea's ripple warp and macro modulation samples (1 / m), see patchSeaMaterial. The gains
 * (in ripple tiles) keep the warp gentle enough not to fold the tile: about twice these fold it into streaks that fan
 * out across the foreground, and a third of them leaves the tiles' repeats lined up a few metres apart.
 */
export const RIPPLE_WARP = { a: 1 / 263, b: 1 / 97, gainA: 1.1, gainB: 0.35, macro: 1 / 181 } as const;
/** The third ripple layer: its tile (m) against the first layer's 6000 / 900 m, and its turn. */
export const RIPPLE_C = { tile: 2.43, cos: 0.37, sin: 0.93, weight: 0.5 } as const;
/**
 * The fourth ripple layer: the first layer's tile turned 53 degrees the other way and shrunk by `scale` (tile 4.0 m;
 * against the other layers 1.66, 4.46 and 1.65 times, all far from whole numbers). Its share of the ripple power, with
 * the first two layers turned down by RIPPLE_AB_GAIN, keeps the longest trains of the first layer from showing as a
 * regular pattern a few metres across.
 */
export const RIPPLE_D = { scale: 1.66, cos: 0.6, sin: 0.8, weight: 0.55 } as const;
/** The first two (Environment) ripple layers' strength under the third and fourth. */
export const RIPPLE_AB_GAIN = 0.8;
/** The first ripple layer's tile (m): the 6 km plane's UV repeated 900 times (Environment). */
export const RIPPLE_A_TILE = 6000 / 900;
/**
 * The fifth and finest ripple layer, the capillary ripples that glitter round the camera: its tile (m; against the
 * others' 7.66, 20.6, 2.79 and 4.6 times) and its turn.
 */
export const RIPPLE_E = { tile: 0.87, cos: -0.83, sin: 0.56, weight: 0.45 } as const;
/**
 * Each ripple layer fades out as a pixel's footprint on the water grows from the first to the second of these shares
 * of its tile (a tile holds 4 to 14 ripples), before its ripples shrink to a pixel and shimmer; the first two layers
 * fade together, as one tile of RIPPLE_AB_TILE m. What a layer loses goes into the roughness instead (seaLost), so
 * the far sea calms into a sheen whose sun path widens rather than vanishing.
 */
export const RIPPLE_FADE = [0.04, 0.25] as const;
export const RIPPLE_AB_TILE = 10.7;
/**
 * The ripples' strength by sea state: this share of the material's normal scale at sea state 0, rising by
 * RIPPLE_SEA_GAIN at 1 (a storm's chop is rougher than a calm's).
 */
export const RIPPLE_SEA_BASE = 0.75;
export const RIPPLE_SEA_GAIN = 0.5;

/** Centres of a deck's pilings that stand in water deeper than -0.1 m (as drawn by CityView.buildCoast). */
export function pilingCentres(rect: Rect, baseGround: (x: number, z: number) => number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let x = rect.minX + PILING_START; x < rect.maxX; x += PILING_STEP) {
    for (const z of [rect.minZ + PILING_INSET, rect.maxZ - PILING_INSET]) if (WATER_Y > baseGround(x, z) - 0.1) out.push({ x, z });
  }
  return out;
}

/** CPU twin of the shader's seaShelf: the drawn seabed's depth at sim depth `simDepth`, `outside` m out of the land rectangle. */
export function seaShelfDepth(simDepth: number, outside: number): number {
  return simDepth + SHELF_SLOPE * Math.max(0, outside - SHELF_START);
}

/**
 * Las Lomas County's shore as the sea draws it: the water depth over its land and beaches (Country.bounds) on a
 * COUNTY_TEXELS square lattice from corner to corner, rounded to the half floats its texture holds, and the land's
 * rectangles the shelf falls away from.
 */
export interface CountyShore {
  box: Rect;
  /** WATER_Y less the county's ground (m, negative on land), row by row along +x, the rows going +z. */
  depth: Float32Array;
  land: readonly Rect[];
}

/**
 * Bakes the county's shore from its ground: countryGround is baseGround off the city's land, but for the causeway,
 * whose quay walls are no beach (its headland's ground would draw swash along them up to the box's edge).
 */
export function countyShore(country: Country): CountyShore {
  const N = COUNTY_TEXELS;
  const b = country.bounds;
  const depth = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = b.minZ + ((b.maxZ - b.minZ) * j) / (N - 1);
    for (let i = 0; i < N; i++) {
      const x = b.minX + ((b.maxX - b.minX) * i) / (N - 1);
      depth[j * N + i] = THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(WATER_Y - countryGround(country, x, z)));
    }
  }
  return { box: b, depth, land: country.land };
}

/** CPU twin of the shader's seaCountyDepth: the county's map sampled bilinearly at (x, z) inside its box, else Infinity. */
export function countyDepthAt(c: CountyShore, x: number, z: number): number {
  const b = c.box;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return Infinity;
  const N = COUNTY_TEXELS;
  const u = ((x - b.minX) / (b.maxX - b.minX)) * (N - 1);
  const v = ((z - b.minZ) / (b.maxZ - b.minZ)) * (N - 1);
  const i = Math.min(Math.floor(u), N - 2);
  const j = Math.min(Math.floor(v), N - 2);
  const tu = u - i;
  const tv = v - j;
  const d = c.depth;
  const k = j * N + i;
  return (d[k]! * (1 - tu) + d[k + 1]! * tu) * (1 - tv) + (d[k + N]! * (1 - tu) + d[k + N + 1]! * tu) * tv;
}

/** Distance (m) of (x, z) outside the county's land (the shader's seaCountyOut). */
export function outsideCounty(c: CountyShore, x: number, z: number): number {
  let d2 = Infinity;
  for (const r of c.land) {
    const dx = Math.max(r.minX - x, 0, x - r.maxX);
    const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
    d2 = Math.min(d2, dx * dx + dz * dz);
  }
  return Math.sqrt(d2);
}

/**
 * Distance (m) of (x, z) outside the land rectangle with the beach (the shader's seaQuay); with `county`, outside the
 * county's land where that is nearer (seaShelf's distance).
 */
export function outsideLand(b: Bounds, x: number, z: number, county?: CountyShore): number {
  const dx = Math.max(b.landMinX - x, x - b.beachEndX, 0);
  const dz = Math.max(b.landMinZ - z, z - b.landMaxZ, 0);
  const city = Math.hypot(dx, dz);
  return county ? Math.min(city, outsideCounty(county, x, z)) : city;
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * CPU twin of the shader's seaDepthAt: the analytic water depth over the beach slope, its drop-off and the deep; with
 * `county`, the county's map where it is shallower.
 */
export function seaDepthCpu(b: Bounds, x: number, z: number, county?: CountyShore): number {
  const xc = clamp(x, b.beachStartX, b.beachEndX + DROP_OFF);
  const endY = CURB_H - SAND_DROP;
  const sand = xc <= b.beachEndX ? CURB_H - ((xc - b.beachStartX) / BEACH_W) * SAND_DROP : endY + (SEABED_Y - endY) * ((xc - b.beachEndX) / DROP_OFF);
  const out = Math.hypot(x - xc, z - clamp(z, b.landMinZ, b.landMaxZ));
  const shelf = WATER_Y - sand;
  const depth = shelf + (WATER_Y - SEABED_Y - shelf) * smooth(0, 40, out);
  return county ? Math.min(depth, countyDepthAt(county, x, z)) : depth;
}

/** The depth the sea's colour is drawn with at (x, z): seaDepthCpu, falling on along the shelf offshore. */
export function seaDrawnDepth(b: Bounds, x: number, z: number, county?: CountyShore): number {
  return seaShelfDepth(seaDepthCpu(b, x, z, county), outsideLand(b, x, z, county));
}

/** CPU twin of the shader's seaOnBeach: 1 where the surf bands and the swash may run, fading to 0 off the city's beach. */
export function seaOnBeach(b: Bounds, x: number, z: number, county?: CountyShore): number {
  if (county && rectContains(county.box, x, z)) return 1;
  const xc = clamp(x, b.beachStartX, b.beachEndX + DROP_OFF);
  return 1 - smooth(0, 4, Math.hypot(x - xc, z - clamp(z, b.landMinZ, b.landMaxZ)));
}

/**
 * CPU twin of the shader's seaShallows: the sea's albedo over water `depth` m deep with the drawn shelf `shelf` m deep,
 * for the material's own colour `mid` (linear), into `out`.
 */
export function seaShallowsCpu(u: SeaUniforms, mid: THREE.Color, depth: number, shelf: number, out: THREE.Color): THREE.Color {
  out.copy(u.uShallow.value).lerp(mid, smooth(0, 3, depth));
  out.lerp(u.uSeaDeep.value, smooth(3, 9, shelf));
  out.lerp(u.uSeaAbyss.value, smooth(9, 30, shelf));
  return out.lerpColors(u.uSandTint.value, out, smooth(0, 0.15, depth));
}

/**
 * The analytic sky's colours and strength: the sky the sea reflects where there is no environment map (no float colour
 * buffers), and the gradient it regrades the map's sky to.
 */
export interface SeaSky {
  top: { value: THREE.Color };
  horizon: { value: THREE.Color };
  intensity: { value: number };
}

/**
 * The waves' uniforms (SEA_WAVES_GLSL), shared by every material that follows the sea: the sea itself, and the foam
 * rings and boat wakes on it. uSeaShelter's `map` is the shelter map the texture holds, for the CPU twin.
 */
export interface SeaWaveUniforms {
  uWavePhase: { value: THREE.Vector4 };
  uChopPhase: { value: THREE.Vector4 };
  uSeaAmp: { value: number };
  uDisplace: { value: number };
  uSeaOrigin: { value: THREE.Vector2 };
  /** The breakers' and the surf bands' phase (surfPhase). */
  uSurfPhase: { value: number };
  uSeaShelter: { value: THREE.DataTexture; map: ShelterMap | null };
  uSeaShelterBox: { value: THREE.Vector4 };
}

/** Uniforms shared by the sea's own materials: the waves', and the shore's and the sky's. */
export interface SeaUniforms extends SeaWaveUniforms {
  /** The quay-foam pulse's phase (rad, wrapped after its own rate), and the foam noise's drift. */
  uQuayPhase: { value: number };
  uFoamDrift: { value: THREE.Vector2 };
  /** landMinX, landMinZ, landMaxZ, beachEndX. */
  uShoreLand: { value: THREE.Vector4 };
  /** beachStartX, BEACH_W, SAND_DROP, CURB_H. */
  uShoreBeach: { value: THREE.Vector4 };
  uShallow: { value: THREE.Color };
  uSandTint: { value: THREE.Color };
  uSeaDeep: { value: THREE.Color };
  uSeaAbyss: { value: THREE.Color };
  /** Deck rectangles (minX, minZ, maxX, maxZ) whose pilings get foam; unused slots lie far away. */
  uPilings: { value: THREE.Vector4[] };
  /** Bounds of the water cut into the land, where the land rectangle's edge is no quay (unused slots lie far away). */
  uSeaCuts: { value: THREE.Vector4[] };
  /** The baked sky's sun as the environment map holds it (colour, and direction), for the sea to take back out of it. */
  uSkySun: { value: THREE.Color };
  uSkySunDir: { value: THREE.Vector3 };
  /** The dome's sun glow colour as it shows (SKY_SUN_HALO), for the sea to mirror. */
  uSkySunHalo: { value: THREE.Color };
  /**
   * What lifts the reflected environment map (or baked sky) back to the sky dome's own brightness by day, 1 / the
   * scene's daytime environment intensity: grazing water mirrors the sky as brightly as it shines, with no seam.
   */
  uSkyLift: { value: number };
  /** The sky dome's horizon glow and city glow (shared with it: SKY_GLOW_FALL), and its bearing to the city. */
  uSkyGlow: { value: THREE.Color };
  uCityGlow: { value: THREE.Color };
  uCityGlowDir: { value: THREE.Vector2 };
  /** The moon's direction and the strength of its disc and halo on the dome (shared with it: SKY_MOON_HALO), and the darkness. */
  uMoonDir: { value: THREE.Vector3 };
  uMoon: { value: number };
  uNight: { value: number };
  /** Las Lomas County's depth map (countyShore; none until setCountyShore), and its box: minX, minZ, 1 / width, 1 / depth. */
  uCountyDepth: { value: THREE.DataTexture | null };
  uCountyBox: { value: THREE.Vector4 };
  /** The county's land rectangles (minX, minZ, maxX, maxZ) the drawn shelf falls away from; unused slots lie far away. */
  uCountyLand: { value: THREE.Vector4[] };
}

/** The shelter map's texture: its four values per point as half floats, filtered bilinearly, clamped at its edge. */
function shelterTexture(data: Float32Array, nx: number, nz: number): THREE.DataTexture {
  const half = new Uint16Array(data.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]!);
  const tex = new THREE.DataTexture(half, nx, nz, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Fresh wave uniforms: calm, flat, and open sea everywhere until setSeaShelter. */
export function seaWaveUniforms(): SeaWaveUniforms {
  return {
    uWavePhase: { value: new THREE.Vector4() },
    uChopPhase: { value: new THREE.Vector4() },
    uSeaAmp: { value: CALM_SEA },
    uDisplace: { value: 0 },
    uSeaOrigin: { value: new THREE.Vector2() },
    uSurfPhase: { value: 0 },
    uSeaShelter: { value: shelterTexture(new Float32Array(OPEN_SEA), 1, 1), map: null },
    uSeaShelterBox: { value: new THREE.Vector4(0, 0, 1, 1) },
  };
}

/** The wave uniforms of `u`, for a material that follows the sea to share. */
export function waveUniformsOf(u: SeaWaveUniforms): Pick<SeaWaveUniforms, WaveUniform> {
  return { uWavePhase: u.uWavePhase, uChopPhase: u.uChopPhase, uSeaAmp: u.uSeaAmp, uDisplace: u.uDisplace, uSeaOrigin: u.uSeaOrigin, uSurfPhase: u.uSurfPhase, uSeaShelter: u.uSeaShelter, uSeaShelterBox: u.uSeaShelterBox };
}

export function seaUniforms(): SeaUniforms {
  return {
    ...seaWaveUniforms(),
    uQuayPhase: { value: 0 },
    uFoamDrift: { value: new THREE.Vector2() },
    // No land until setShore: deep water everywhere.
    uShoreLand: { value: new THREE.Vector4(1e6, 1e6, -1e6, -1e6) },
    uShoreBeach: { value: new THREE.Vector4(1e6, BEACH_W, SAND_DROP, CURB_H) },
    uShallow: { value: new THREE.Color(SHALLOW) },
    uSandTint: { value: new THREE.Color(SAND_TINT) },
    uSeaDeep: { value: new THREE.Color(DEEP) },
    uSeaAbyss: { value: new THREE.Color(ABYSS) },
    uPilings: { value: Array.from({ length: MAX_PILING_DECKS }, () => new THREE.Vector4(1e6, 1e6, 1e6, 1e6)) },
    uSeaCuts: { value: Array.from({ length: MAX_SEA_CUTS }, () => new THREE.Vector4(1e6, 1e6, 1e6, 1e6)) },
    uSkySun: { value: new THREE.Color(0, 0, 0) },
    uSkySunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSkySunHalo: { value: new THREE.Color(0, 0, 0) },
    uSkyLift: { value: 1 },
    uSkyGlow: { value: new THREE.Color(0, 0, 0) },
    uCityGlow: { value: new THREE.Color(0, 0, 0) },
    uCityGlowDir: { value: new THREE.Vector2() },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoon: { value: 0 },
    uNight: { value: 0 },
    uCountyDepth: { value: null },
    uCountyBox: { value: new THREE.Vector4(1e6, 1e6, 1, 1) },
    uCountyLand: { value: Array.from({ length: MAX_COUNTY_LAND }, () => new THREE.Vector4(1e6, 1e6, 1e6, 1e6)) },
  };
}

/** Feeds the shoreline the layout's land rectangle and beach (staticWorld.baseGround's terrain). */
export function setShore(u: SeaUniforms, b: Bounds): void {
  u.uShoreLand.value.set(b.landMinX, b.landMinZ, b.landMaxZ, b.beachEndX);
  u.uShoreBeach.value.set(b.beachStartX, BEACH_W, SAND_DROP, CURB_H);
}

/**
 * Feeds the sea Las Lomas County's shore (countyShore): its depth map as a half-float texture, filtered bilinearly with
 * no mipmaps (the caller disposes it), its box and its land.
 */
export function setCountyShore(u: SeaUniforms, c: CountyShore): void {
  const half = new Uint16Array(c.depth.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(c.depth[i]!);
  const tex = new THREE.DataTexture(half, COUNTY_TEXELS, COUNTY_TEXELS, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  u.uCountyDepth.value = tex;
  const b = c.box;
  u.uCountyBox.value.set(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ));
  u.uCountyLand.value.forEach((v, i) => {
    const r = c.land[i];
    if (r) v.set(r.minX, r.minZ, r.maxX, r.maxZ);
    else v.set(1e6, 1e6, 1e6, 1e6);
  });
}

/** Feeds the waves the shelter map (render/seaShelter.ts) and its box: a new texture (the caller disposes the old). */
export function setSeaShelter(u: SeaWaveUniforms, m: ShelterMap): void {
  u.uSeaShelter.value = shelterTexture(m.data, m.nx, m.nz);
  u.uSeaShelter.map = m;
  u.uSeaShelterBox.value.set(m.minX, m.minZ, 1 / (m.nx * m.cell), 1 / (m.nz * m.cell));
}

/** Feeds the quay foam the bounds of the water cut into the land (layout.water). */
export function setSeaCuts(u: SeaUniforms, cuts: readonly Rect[]): void {
  u.uSeaCuts.value.forEach((v, i) => {
    const r = cuts[i];
    if (r) v.set(r.minX, r.minZ, r.maxX, r.maxZ);
    else v.set(1e6, 1e6, 1e6, 1e6);
  });
}

/** Feeds the piling foam the piers' deck rectangles (layout.decks). */
export function setPilings(u: SeaUniforms, decks: ReadonlyArray<{ rect: Rect }>): void {
  u.uPilings.value.forEach((v, i) => {
    const d = decks[i];
    if (d) v.set(d.rect.minX, d.rect.minZ, d.rect.maxX, d.rect.maxZ);
    else v.set(1e6, 1e6, 1e6, 1e6);
  });
}

const tmpPhases = wavePhases(0);
/** The quay foam's pulse (rad/s). */
const QUAY_RATE = 1.68;

/**
 * The surf's phase (the breakers' and the foam bands', surfPhase: in step with the swell over the east beach, whose
 * start is `beachStartX`) and the quay pulse's at renderer time `time`, each wrapped to [0, 2pi).
 */
export function surfPhases(time: number, beachStartX: number): { surf: number; quay: number } {
  return { surf: surfPhase(wavePhases(time, tmpPhases)[0]!, beachStartX), quay: (time * QUAY_RATE) % (Math.PI * 2) };
}

/** Per frame: the waves' phases at renderer time `time`, the sea state, and the grid's centre. */
export function updateSea(u: SeaUniforms, time: number, seaState: number, originX: number, originZ: number): void {
  const p = wavePhases(time, tmpPhases);
  u.uWavePhase.value.set(p[0]!, p[1]!, p[2]!, p[3]!);
  u.uChopPhase.value.set(p[SWELL]!, p[SWELL + 1]!, p[SWELL + 2]!, p[SWELL + 3]!);
  u.uSeaAmp.value = Math.min(1, Math.max(0, seaState));
  u.uSeaOrigin.value.set(originX, originZ);
  const phases = surfPhases(time, u.uShoreBeach.value.x);
  u.uSurfPhase.value = phases.surf;
  u.uQuayPhase.value = phases.quay;
  u.uFoamDrift.value.set((time * 0.013) % 1, (time * 0.009) % 1);
}

/** The sea as the CPU twin needs it this frame, read off the wave uniforms (into `out`). */
export function seaSurface(u: SeaWaveUniforms, out: SeaSurface = { phases: wavePhases(0), surf: 0, sea: 0, ox: 0, oz: 0, shelter: null }): SeaSurface {
  const a = u.uWavePhase.value;
  const b = u.uChopPhase.value;
  const p = out.phases;
  p[0] = a.x;
  p[1] = a.y;
  p[2] = a.z;
  p[3] = a.w;
  p[SWELL] = b.x;
  p[SWELL + 1] = b.y;
  p[SWELL + 2] = b.z;
  p[SWELL + 3] = b.w;
  out.surf = u.uSurfPhase.value;
  out.sea = u.uSeaAmp.value;
  out.ox = u.uSeaOrigin.value.x;
  out.oz = u.uSeaOrigin.value.y;
  out.shelter = u.uSeaShelter.map;
  return out;
}

const scratchSurface = seaSurface(seaWaveUniforms());

/** The drawn sea's height over WATER_Y at world (x, z) (seaHeight); 0 everywhere where the sea is drawn flat. */
export function seaHeightAt(u: SeaWaveUniforms | null, x: number, z: number): number {
  const displace = u ? u.uDisplace.value : 0;
  if (!u || displace <= 0) return 0;
  return seaHeight(seaSurface(u, scratchSurface), x, z) * displace;
}

const n = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * Water depth over the analytic terrain (staticWorld.baseGround): the beach's sand slope and its drop-off, deep
 * water elsewhere. Off the beach's ends the sand fades into the deep over SHORE_BLEND m so the shallows do not
 * end in a hard edge. Las Lomas County's beaches come from its depth map inside its box, whose edge lies where its
 * seabed is already flat.
 */
export const SHORE_GLSL = /* glsl */ `
uniform vec4 uShoreLand;
uniform vec4 uShoreBeach;
uniform sampler2D uCountyDepth;
uniform vec4 uCountyBox;
uniform vec4 uCountyLand[${MAX_COUNTY_LAND}];
uniform float uQuayPhase;
uniform vec2 uFoamDrift;
uniform vec3 uShallow;
uniform vec3 uSandTint;
uniform vec3 uSeaDeep;
uniform vec3 uSeaAbyss;
uniform vec4 uPilings[${MAX_PILING_DECKS}];
uniform vec4 uSeaCuts[${MAX_SEA_CUTS}];
/** 0 where the sea comes into the land (the land rectangle's edge there is open water), else 1. */
float seaOffCut(vec2 p) {
  for (int i = 0; i < ${MAX_SEA_CUTS}; i++) {
    vec4 r = uSeaCuts[i];
    if (p.x > r.x - 3.0 && p.x < r.z + 3.0 && p.y > r.y - 3.0 && p.y < r.w + 3.0) return 0.0;
  }
  return 1.0;
}
/** 1 inside Las Lomas County's box (its land and beaches), else 0. */
float seaInCounty(vec2 p) {
  vec2 t = (p - uCountyBox.xy) * uCountyBox.zw;
  return step(0.0, min(t.x, t.y)) * step(max(t.x, t.y), 1.0);
}
/**
 * The county's water depth from its map (countyShore), its first and last texels' centres on the box's edges; 1e3 off
 * the box. Fetched everywhere, so the lookup stays in uniform control flow.
 */
float seaCountyDepth(vec2 p) {
  float d = textureLod(uCountyDepth, (p - uCountyBox.xy) * uCountyBox.zw * ${n((COUNTY_TEXELS - 1) / COUNTY_TEXELS)} + ${n(0.5 / COUNTY_TEXELS)}, 0.0).r;
  return seaInCounty(p) > 0.5 ? d : 1e3;
}
/** Distance outside the county's land (0 on it). */
float seaCountyOut(vec2 p) {
  float best = 1e12;
  for (int i = 0; i < ${MAX_COUNTY_LAND}; i++) {
    vec4 r = uCountyLand[i];
    vec2 q = max(max(r.xy - p, p - r.zw), 0.0);
    best = min(best, dot(q, q));
  }
  return sqrt(best);
}
float seaBeachOut(vec2 p) {
  vec2 c = vec2(clamp(p.x, uShoreBeach.x, uShoreLand.w + ${n(DROP_OFF)}), clamp(p.y, uShoreLand.y, uShoreLand.z));
  return length(p - c);
}
/** 1 where the surf bands and the swash may run: over the city's beach and off its ends, and round the county, all beach. */
float seaOnBeach(vec2 p) {
  return max(1.0 - smoothstep(0.0, 4.0, seaBeachOut(p)), seaInCounty(p));
}
float seaDepthAt(vec2 p) {
  float x = clamp(p.x, uShoreBeach.x, uShoreLand.w + ${n(DROP_OFF)});
  float endY = uShoreBeach.w - uShoreBeach.z;
  float sand = x <= uShoreLand.w
    ? uShoreBeach.w - (x - uShoreBeach.x) / uShoreBeach.y * uShoreBeach.z
    : mix(endY, ${n(SEABED_Y)}, (x - uShoreLand.w) / ${n(DROP_OFF)});
  float shelf = ${n(WATER_Y)} - sand;
  return min(mix(shelf, ${n(WATER_Y - SEABED_Y)}, smoothstep(0.0, 40.0, seaBeachOut(p))), seaCountyDepth(p));
}
/** Distance outside the land rectangle (0 inside), and how much of it is a quay wall rather than the beach. */
float seaQuay(vec2 p) {
  float dx = max(max(uShoreLand.x - p.x, p.x - uShoreLand.w), 0.0);
  float dz = max(max(uShoreLand.y - p.y, p.y - uShoreLand.z), 0.0);
  return length(vec2(dx, dz));
}
/** The drawn seabed's depth: the sim's near land, falling on along the shelf offshore of the city or the county (seaShelfDepth). */
float seaShelf(vec2 p, float depth) {
  return depth + ${n(SHELF_SLOPE)} * max(min(seaQuay(p), seaCountyOut(p)) - ${n(SHELF_START)}, 0.0);
}
/** Foam 0..1 round the pilings of the decks in uPilings (the lattice of CityView.buildCoast); px: m per screen pixel. */
float seaPilingFoam(vec2 p, float noise, float px) {
  float best = 1e3;
  for (int i = 0; i < ${MAX_PILING_DECKS}; i++) {
    vec4 r = uPilings[i];
    if (p.x < r.x - 2.0 || p.x > r.z + 2.0 || p.y < r.y - 2.0 || p.y > r.w + 2.0) continue;
    float last = floor((r.z - r.x - ${n(PILING_START)} - 1e-3) / ${n(PILING_STEP)});
    float k = clamp(floor((p.x - r.x - ${n(PILING_START)}) / ${n(PILING_STEP)} + 0.5), 0.0, last);
    float z0 = r.y + ${n(PILING_INSET)};
    float z1 = r.w - ${n(PILING_INSET)};
    vec2 c = vec2(r.x + ${n(PILING_START)} + ${n(PILING_STEP)} * k, abs(p.y - z0) < abs(p.y - z1) ? z0 : z1);
    best = min(best, length(p - c));
  }
  float side = best - ${n(PILING_RADIUS)};
  float far = smoothstep(0.03, 0.15, px);
  float width = max(min(0.3 + 0.35 * noise, ${n(PILING_FOAM)}), min(${n(PILING_FOAM_PX)} * px, ${n(PILING_FOAM_FAR)}));
  float pulse = mix(0.75 + 0.25 * sin(uQuayPhase * 1.3 - best * 5.0), 1.0, far);
  return clamp((1.0 - smoothstep(width * 0.55, width, side)) * step(-0.05, side) * pulse * (0.8 + 0.4 * mix(noise, 1.0, far)), 0.0, 1.0);
}
float seaWaterlineX() {
  return uShoreBeach.x + uShoreBeach.y * (uShoreBeach.w - ${n(WATER_Y)}) / uShoreBeach.z;
}
/**
 * Foam 0..1: surf bands moving shoreward over the beach from where the waves break (the depth that caps the breakers,
 * seaShoal, at the shelter here), the swash along the waterline, a pulsing strip along the quay walls, and rings round
 * the pilings (px: m per screen pixel).
 */
float seaFoam(vec2 p, float depth, float shelter, float noise, float sea, float px) {
  float onBeach = seaOnBeach(p);
  float reach = min(${n(SURF_DEPTH[1])}, shelter * seaHalfHeight() * ${n(SURF_SHOAL / SURF_GAMMA)});
  float shore = 1.0 - smoothstep(0.0, reach, depth);
  float band = 0.5 + 0.5 * sin(depth * ${n(SURF_K)} + uSurfPhase + noise * 2.0);
  // The bands ride the breakers' fronts (seaSurfPhase lags them by SURF_LAG) and dissolve 4-8 m out (0.12-0.22 m deep),
  // short of the swash, so they never merge with it into a sheet and the foam at the waterline stays a band that hugs it.
  float bands = smoothstep(0.55, 0.9, band + (noise - 0.5) * 0.5) * shore * smoothstep(${n(SURF_BAND_FADE[0])}, ${n(SURF_BAND_FADE[1])}, depth);
  // The swash surges up the sand and draws back with the surf phase (1.3-2.5 m out at sea state 0.3).
  float surge = 0.5 + 0.5 * sin(uSurfPhase + 1.7 + noise * 1.5);
  float swash = 1.0 - smoothstep(0.0, (0.04 + 0.06 * sea) * (0.65 + 0.6 * surge), depth);
  float beach = clamp((bands * (0.55 + 0.6 * sea) + swash * 0.8) * onBeach, 0.0, 1.0);
  float d = seaQuay(p);
  float width = 0.5 + 1.0 * smoothstep(0.3, 0.7, noise);
  float pulse = 0.8 + 0.2 * sin(uQuayPhase + (p.x + p.y) * 0.21);
  float notBeach = 1.0 - smoothstep(seaWaterlineX() - 5.0, seaWaterlineX() + 10.0, p.x);
  float quay = (1.0 - smoothstep(width * 0.4, width, d)) * step(1e-3, d) * pulse * notBeach * seaOffCut(p) * (0.85 + 0.3 * sea) * (0.75 + 0.5 * noise);
  return clamp(max(max(beach, quay), seaPilingFoam(p, noise, px)), 0.0, 1.0);
}
/**
 * The sea's albedo by depth: wet sand through the thinnest water, turquoise shallows, the material's own colour (mid)
 * by 3 m, then the dark open-water body by 9 m (the quays' 7 m water is most of the way there) and the darker
 * offshore one as the drawn shelf falls away (seaShelf).
 */
vec3 seaShallows(vec3 mid, float depth, vec2 p) {
  float shelf = seaShelf(p, depth);
  vec3 c = mix(uShallow, mid, smoothstep(0.0, 3.0, depth));
  // Overlapping ramps, so the colour keeps darkening steadily with depth rather than pausing between them.
  c = mix(c, uSeaDeep, smoothstep(3.0, 9.0, shelf));
  c = mix(c, uSeaAbyss, smoothstep(9.0, 30.0, shelf));
  return mix(uSandTint, c, smoothstep(0.0, 0.15, depth));
}
`;

/**
 * The sea's direct light, in place of three's RE_Direct_Physical: a Beckmann specular lobe, the Gaussian slopes of a
 * wind-blown sea (Cox and Munk) that end where GGX's long tails would spread a low sun across the whole sea, capped at
 * SEA_GLINT_MAX; three's Lambert diffuse for the water body under it; and the glow through the crests (seaGlow, set
 * by the patch per fragment) for an eye that looks towards the light.
 */
const SEA_DIRECT_GLSL = /* glsl */ `
float seaGlow;
void RE_Direct_Sea( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
  float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
  vec3 halfDir = normalize( directLight.direction + geometryViewDir );
  float dotNH = saturate( dot( geometryNormal, halfDir ) );
  float F = F_Schlick( ${n(SEA_F0)}, 1.0, saturate( dot( geometryViewDir, halfDir ) ) );
  float alpha = pow2( material.roughness );
  float a2 = pow2( alpha );
  float c2 = max( dotNH * dotNH, 1e-4 );
  float D = exp( ( c2 - 1.0 ) / ( a2 * c2 ) ) / ( PI * a2 * c2 * c2 );
  vec3 irradiance = dotNL * directLight.color;
  reflectedLight.directSpecular += min( irradiance * F * V_GGX_SmithCorrelated( alpha, dotNL, dotNV ) * D, vec3( ${n(SEA_GLINT_MAX)} ) );
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  float through = pow4( saturate( dot( - geometryViewDir, directLight.direction ) ) );
  reflectedLight.directDiffuse += directLight.color * vec3( ${CREST_GLOW.map(n).join(', ')} ) * through * seaGlow;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Sea
`;

/**
 * The sky along the sea's reflected ray, as bright as the sky dome draws it (uSkyLift): the environment map less most
 * of its sun's glow (SKY_SUN_GLOW) and regraded from the horizon up as the dome grades it (uSkyTop, uSkyHorizon), or without
 * one the analytic sky graded as the dome grades it (uSkyI too); by night in the night sky's blue (SEA_NIGHT_SKY); with
 * a share of the dome's night glows (SKY_GLOW_FALL, SEA_NIGHT_GLOW), the city's broken into its lights (CITY_STREAKS),
 * its moon halo drawn out into a path (SKY_MOON_HALO, SEA_MOON_PATH) and its sun glow (SKY_SUN_HALO) on top. A ripple turned away from the eye
 * reflects the face of the next wave rather than the sky under the horizon, which the map holds as a dark haze: the ray
 * folds back up, so grazing water shows the bright horizon sky and never dark blotches.
 */
const SEA_SKY_GLSL = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform float uSkyI;
uniform vec3 uSkySun;
uniform vec3 uSkySunDir;
uniform vec3 uSkySunHalo;
uniform float uSkyLift;
uniform vec3 uSkyGlow;
uniform vec3 uCityGlow;
uniform vec2 uCityGlowDir;
uniform vec3 uMoonDir;
uniform float uMoon;
uniform float uNight;
vec3 seaSkyRadiance( vec3 viewDir, vec3 normal, float roughness ) {
  vec3 r = transformDirectionByInverseViewMatrix( reflect( - viewDir, normal ), viewMatrix );
  r.y = abs( r.y );
  // The ray's bearing, defined even straight up (where atan( 0, 0 ) is not).
  vec2 bearingDir = normalize( r.xz + vec2( 1e-5 ) );
  float toCity = max( dot( bearingDir, uCityGlowDir ), 0.0 );
  float toSun = max( dot( r, uSkySunDir ), 0.0 );
  float moonUp = r.y - uMoonDir.y;
  vec3 moonOff = r - uMoonDir;
  float moon = sqrt( max( dot( moonOff, moonOff ) - moonUp * moonUp, 0.0 ) + moonUp * moonUp * ${n(SEA_MOON_PATH.stretch * SEA_MOON_PATH.stretch)} );
  float bearing = atan( bearingDir.y, bearingDir.x ) * ${n(CITY_STREAKS.cells / (2 * Math.PI))};
  float cell = floor( bearing );
  float lights = mix( fract( sin( cell * 12.9898 ) * 43758.5453 ), fract( sin( ( cell + 1.0 ) * 12.9898 ) * 43758.5453 ), smoothstep( 0.0, 1.0, bearing - cell ) );
  vec3 glow = uSkyGlow * ${n(SEA_NIGHT_GLOW.horizon)} * exp( - r.y * ${n(SKY_GLOW_FALL.horizon)} )
    + uCityGlow * ${n(SEA_NIGHT_GLOW.city)} * toCity * toCity * toCity * pow( lights, ${n(CITY_STREAKS.power)} ) * ${n(CITY_STREAKS.gain)} * exp( - r.y * ${n(SKY_GLOW_FALL.city)} )
    + vec3( ${SKY_MOON_HALO.color.map(n).join(', ')} ) * ( ${n(SKY_MOON_HALO.tight.gain)} * exp( - moon * ${n(SKY_MOON_HALO.tight.fall)} ) + ${n(SKY_MOON_HALO.wide.gain)} * exp( - moon * ${n(SKY_MOON_HALO.wide.fall)} ) ) * ${n(SEA_MOON_PATH.gain)} * uMoon
    + uSkySunHalo * ( ${n(SKY_SUN_HALO.tight.gain)} * pow( toSun, ${n(SKY_SUN_HALO.tight.pow)} ) + ${n(SKY_SUN_HALO.wide.gain)} * pow( toSun, ${n(SKY_SUN_HALO.wide.pow)} ) );
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  // The map's sun glow as the lookup blurs it: a Gaussian lobe of variance 1 / pow per axis, widened by the GGX lobe's
  // 2 alpha^2 and dimmed to keep its light.
  float sunPow = 1.0 / ( ${n(1 / SKY_SUN_GLOW.pow)} + 2.0 * pow4( roughness ) );
  vec3 sun = uSkySun * ${n(SKY_SUN_GLOW.gain * SKY_SUN_GLOW.taken / SKY_SUN_GLOW.pow)} * sunPow * pow( toSun, sunPow );
  // The map grades its sky from the horizon colour by smoothstep( 0, 0.6, h ), the dome by pow( h, 0.55 ): a few degrees
  // up the map is still the horizon's colour where the dome has turned towards its top. Regraded as the dome draws it,
  // up to some 20 degrees: higher, the map has reached its top colour while the dome still holds some of the horizon's,
  // and the ratio of a near-black channel would multiply the clouds and the sun's glow several times over.
  vec3 dome = mix( mix( uSkyHorizon, uSkyTop, pow( r.y, 0.55 ) ) / mix( uSkyHorizon, uSkyTop, smoothstep( 0.0, 0.6, r.y ) ), vec3( 1.0 ), smoothstep( 0.3, 0.5, r.y ) );
  vec3 sky = max( textureCubeUV( envMap, envMapRotation * r, roughness ).rgb - sun, 0.0 ) * dome * envMapIntensity;
#else
  vec3 sky = mix( uSkyHorizon, uSkyTop, pow( r.y, 0.55 ) ) * uSkyI;
#endif
  sky = mix( sky, dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) ) * vec3( ${SEA_NIGHT_SKY.map(n).join(', ')} ), uNight );
  return sky * uSkyLift + glow;
}
`;

/**
 * The whitecaps on the waves' crests, 0..1 (WHITECAP_STEEP), from the crests' compression here (steep) and where every
 * crest meets (most; seaWave): broken into patches by the foam noise and lace, and softened, as a pixel grows past
 * their size (px: m per pixel), into a faint even cover as thick as the sea's tallest crests break.
 */
const SEA_CREST_GLSL = /* glsl */ `
float seaWhitecap(float steep, float most, float noise, float lace, float px) {
  // The noise and lace are ripple slopes, a few hundredths either side of 0.5: stretched to about -1..1.
  float patchy = (noise - 0.5) * 12.0;
  float fine = (lace - 0.5) * 8.0;
  float cap = smoothstep(${n(WHITECAP_STEEP[0])}, ${n(WHITECAP_STEEP[1])}, steep + 0.05 * patchy);
  // Holes open in the lace where the cap thins out, and its thin edges let the water show through.
  cap *= smoothstep(-0.4, 0.6, fine + cap - 0.6);
  return 0.75 * mix(cap, 0.08 * smoothstep(${n(WHITECAP_STEEP[0])}, ${n(WHITECAP_STEEP[1])}, 0.6 * most), smoothstep(0.6, 2.5, px));
}
`;

/**
 * Patches the sea's (already ripple-patched) standard material: world-anchored ripple UVs (the mesh follows the
 * camera), vertex displacement scaled by uDisplace (sheltered and shoaled in seaDisplace), the ripples warped and their
 * strength modulated by low-frequency samples of the ripple tile itself and by the sea state, a third, fourth and fifth
 * ripple layer, every layer faded out with distance into the roughness (RIPPLE_FADE), the wave slopes added to the
 * ripple normal, the shallows' colour and foam, water's reflectance (SEA_F0), its direct light (SEA_DIRECT_GLSL) and the sky
 * it reflects (SEA_SKY_GLSL; `sky`, the analytic sky's colours). Three's lighting then splits each pixel by
 * Fresnel between the dark body looking down and the sky towards the horizon. Only uniforms change at runtime: the
 * grid on or off and the sea state never rebuild the program.
 */
export function patchSeaMaterial(mat: THREE.MeshStandardMaterial, u: SeaUniforms, sky: SeaSky): void {
  const ripples = mat.onBeforeCompile.bind(mat);
  const key = mat.customProgramCacheKey.bind(mat);
  const c = RIPPLE_C;
  const cScale = RIPPLE_A_TILE / c.tile;
  const d = RIPPLE_D;
  const e = RIPPLE_E;
  const eScale = RIPPLE_A_TILE / e.tile;
  /** GLSL: 1 for the layer with this tile (m) while the pixel's footprint seaPx is small against it, fading to 0. */
  const kept = (tile: number) => `( 1.0 - smoothstep( ${n(RIPPLE_FADE[0] * tile)}, ${n(RIPPLE_FADE[1] * tile)}, seaPx ) )`;
  mat.onBeforeCompile = (shader, renderer) => {
    ripples(shader, renderer);
    Object.assign(shader.uniforms, u);
    Object.assign(shader.uniforms, { uSkyTop: sky.top, uSkyHorizon: sky.horizon, uSkyI: sky.intensity });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SEA_WAVES_GLSL}\n${SHORE_GLSL}\nattribute vec2 aEdge;\nvarying vec2 vSeaXZ;`)
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
  vec4 seaBase = modelMatrix * vec4( position, 1.0 );
  vSeaXZ = seaBase.xz;
#ifdef USE_NORMALMAP
  // The ripple tile is anchored to the world (one plane 6 km across had UV 0..1), not to the moving mesh.
  vNormalMapUv = ( normalMapTransform * vec3( seaBase.x / 6000.0 + 0.5, 0.5 - seaBase.z / 6000.0, 1.0 ) ).xy;
#endif`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed += uDisplace * seaDisplaceEdge( seaBase.xz, aEdge );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${SEA_WAVES_GLSL}\n${SHORE_GLSL}\n${SEA_SKY_GLSL}\n${SEA_CREST_GLSL}\nvarying vec2 vSeaXZ;`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${SEA_DIRECT_GLSL}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n  material.specularColor = vec3( ${n(SEA_F0)} );\n  material.specularColorBlended = material.specularColor;`)
      .replace(
        '#include <lights_fragment_maps>',
        `#if defined( RE_IndirectDiffuse ) && defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  iblIrradiance += getIBLIrradiance( geometryNormal );
#endif
#ifdef RE_IndirectSpecular
  radiance += seaSkyRadiance( geometryViewDir, geometryNormal, material.roughness );
  // The ripples faded into the roughness blur the sky they mirror but do not dim it: drawn as normals near the camera,
  // the same slopes reflect by Schlick's Fresnel, unmasked, so the far sea is weighed at the water's own roughness too.
  material.dfg = texture2D( dfgLUT, vec2( ${n(SEA_ROUGHNESS)}, dotNVms ) ).rg;
#endif`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float seaDepth = seaDepthAt( vSeaXZ );
  // Metres of water per screen pixel.
  float seaPx = length( fwidth( vSeaXZ ) );
  float seaFoamAmt = 0.0;
  SeaWave seaW = seaWave( vSeaXZ, dFdx( vSeaXZ ), dFdy( vSeaXZ ) );
  // Thin crests glow when the eye looks through them into the light; steep ones more.
  seaGlow = saturate( seaW.height ) * saturate( seaW.height ) * ( 0.3 + 0.7 * smoothstep( 0.0, ${n(WHITECAP_STEEP[1])}, seaW.steep ) );
#ifdef USE_NORMALMAP
  {
    vec2 fuv = vSeaXZ * 0.031 + uFoamDrift;
    float seaNoise = texture2D( normalMap, fuv ).x * 0.6 + texture2D( normalMap, fuv * 2.37 + 0.31 ).y * 0.4;
    seaFoamAmt = seaFoam( vSeaXZ, seaDepth, seaShelterAt( vSeaXZ ).x, seaNoise, uSeaAmp, seaPx );
    float seaLace = texture2D( normalMap, vSeaXZ * 0.21 + uFoamDrift.yx * 4.0 ).y;
    seaFoamAmt = max( seaFoamAmt, seaWhitecap( seaW.steep, seaW.most, seaNoise, seaLace, seaPx ) * smoothstep( 0.5, 2.0, seaDepth ) );
  }
#endif
  diffuseColor.rgb = mix( seaShallows( diffuseColor.rgb, seaDepth, vSeaXZ ), vec3( 0.82, 0.86, 0.86 ), seaFoamAmt );`,
      )
      .replace('#include <aomap_fragment>', `reflectedLight.indirectDiffuse *= 1.0 + ${n(FOAM_SKY_LIFT)} * seaFoamAmt;\n#include <aomap_fragment>`)
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
#ifdef USE_NORMALMAP
  // Low-frequency samples of the ripple tile warp its UV (so its repeats never line up) and scale its strength.
  vec2 seaWarp = ( texture2D( normalMap, vSeaXZ * ${n(RIPPLE_WARP.a)} + vec2( 0.21, 0.57 ) ).xy - 0.5 ) * ${n(RIPPLE_WARP.gainA)}
    + ( texture2D( normalMap, vSeaXZ * ${n(RIPPLE_WARP.b)} + vec2( 0.63, 0.12 ) ).yx - 0.5 ) * ${n(RIPPLE_WARP.gainB)};
  vec2 seaRippleUv = vNormalMapUv + seaWarp;
  vec2 seaNormalScale = normalScale * ( 0.85 + 0.3 * smoothstep( 0.4, 0.6, texture2D( normalMap, vSeaXZ * ${n(RIPPLE_WARP.macro)} + vec2( 0.4, 0.9 ) ).x ) )
    * ( ${n(RIPPLE_SEA_BASE)} + ${n(RIPPLE_SEA_GAIN)} * uSeaAmp );
  float seaKeptAB = ${kept(RIPPLE_AB_TILE)};
  vec2 seaNormalScaleAB = seaNormalScale * ${n(RIPPLE_AB_GAIN)} * seaKeptAB;
#define vNormalMapUv seaRippleUv
#define normalScale seaNormalScaleAB
#endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `{
    vec2 seaS = seaW.slope * ( 1.0 - 0.6 * seaFoamAmt );
    // The mean square slope of everything faded out with distance, which the roughness takes over.
    float seaLost = seaW.lost;
#ifdef USE_NORMALMAP
    // A third, finer ripple layer, turned and drifting its own way (uFoamDrift wraps at 1: whole tiles of this layer).
    float seaKeptC = ${kept(c.tile)};
    vec2 seaCuv = mat2( ${n(c.cos)}, ${n(-c.sin)}, ${n(c.sin)}, ${n(c.cos)} ) * seaRippleUv * ${n(cScale)} + uFoamDrift.yx * 3.0;
    seaS += ( texture2D( normalMap, seaCuv ).xy * 2.0 - 1.0 ) * seaNormalScale * ${n(c.weight)} * seaKeptC;
    // A fourth layer at the first one's scale, turned the other way (uFoamDrift times a whole number wraps by whole tiles).
    float seaKeptD = ${kept(RIPPLE_A_TILE / d.scale)};
    vec2 seaDuv = mat2( ${n(d.cos)}, ${n(d.sin)}, ${n(-d.sin)}, ${n(d.cos)} ) * seaRippleUv * ${n(d.scale)} - uFoamDrift * 2.0 + vec2( 0.37, 0.71 );
    seaS += ( texture2D( normalMap, seaDuv ).xy * 2.0 - 1.0 ) * seaNormalScale * ${n(d.weight)} * seaKeptD;
    // The fine capillary ripples, near the camera only.
    float seaKeptE = ${kept(e.tile)};
    vec2 seaEuv = mat2( ${n(e.cos)}, ${n(-e.sin)}, ${n(e.sin)}, ${n(e.cos)} ) * seaRippleUv * ${n(eScale)} + uFoamDrift * 5.0;
    seaS += ( texture2D( normalMap, seaEuv ).xy * 2.0 - 1.0 ) * seaNormalScale * ${n(e.weight)} * seaKeptE;
    // A layer at normal scale s has a mean square slope of (WATER_TILT s)^2; the first two sum to one layer's.
    seaLost += ${n(WATER_TILT * WATER_TILT)} * seaNormalScale.x * seaNormalScale.x * (
      ${n(RIPPLE_AB_GAIN * RIPPLE_AB_GAIN)} * ( 1.0 - seaKeptAB * seaKeptAB ) + ${n(c.weight * c.weight)} * ( 1.0 - seaKeptC * seaKeptC )
      + ${n(d.weight * d.weight)} * ( 1.0 - seaKeptD * seaKeptD ) + ${n(e.weight * e.weight)} * ( 1.0 - seaKeptE * seaKeptE ) );
#endif
    // Gerstner's normal rises less at a crest, where the water bunches up (seaW.kept): the crests sharpen.
    normal = normalize( normal + mat3( viewMatrix ) * vec3( -seaS.x, - min( seaW.kept, 0.6 ) * ( 1.0 - 0.6 * seaFoamAmt ), -seaS.y ) );
    // Beckmann's alpha squared is the facets' mean square slope: the lost slopes add to the material's own (alpha = r^2).
    roughnessFactor = mix( sqrt( sqrt( pow4( roughnessFactor ) + seaLost ) ), 0.85, seaFoamAmt );
  }
#include <emissivemap_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => `${key()}-waves`;
}

/**
 * The software sea: two waves on a warped ripple, the shallows and the beach's surf, unlit but for the key light's glint:
 * its body (the shallows' colour under a fixed share of daylight, SOFTWARE_BODY) and the baked sky's gradient, folded
 * above the horizon, lifted to the dome's brightness and by night in the night sky's blue (SEA_NIGHT_SKY), split by
 * Schlick's Fresnel. Shares SeaUniforms (the night
 * among them); `extra` brings the ripple tile and its drift, the sky's colours and the key light (uKeyDir, uKeyLight:
 * colour times intensity).
 */
export function softwareSeaMaterial(u: SeaUniforms, extra: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  const mid = new THREE.Color(SEA_MID);
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog!), ...extra, ...u },
    vertexShader: `varying vec3 vWorld;\n#include <common>\n#include <fog_pars_vertex>
      void main() { vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `varying vec3 vWorld;
      uniform sampler2D uNormal; uniform vec2 uDrift;
      uniform vec3 uTop, uHorizon; uniform float uNight, uSkyLift;
      uniform vec3 uKeyDir, uKeyLight;
      #include <common>
      #include <fog_pars_fragment>
      ${SEA_WAVES_GLSL}
      ${SEA_SLOPE2_GLSL}
      ${SHORE_GLSL}
      void main() {
        vec2 warp = (texture2D(uNormal, vWorld.xz * ${n(RIPPLE_WARP.a)} + vec2(0.21, 0.57)).xy - 0.5) * ${n(RIPPLE_WARP.gainA)};
        vec3 ripple = texture2D(uNormal, vWorld.xz * 0.15 + uDrift + warp).xyz;
        vec2 wave = ripple.xy * 2.0 - 1.0;
        vec2 swell = seaSlope2(vWorld.xz);
        vec3 n = normalize(vec3(wave.x * 0.18 - swell.x, 1.0, wave.y * 0.18 - swell.y));
        vec3 eye = normalize(cameraPosition - vWorld);
        vec3 reflection = reflect(-eye, n);
        reflection.y = abs(reflection.y);
        vec3 sky = mix(uHorizon, uTop, pow(reflection.y, 0.55)) * uSkyLift;
        sky = mix(sky, dot(sky, vec3(0.2126, 0.7152, 0.0722)) * vec3(${SEA_NIGHT_SKY.map(n).join(', ')}), uNight);
        float fresnel = ${n(SEA_F0)} + ${n(1 - SEA_F0)} * pow(1.0 - max(dot(n, eye), 0.0), 5.0);
        float depth = seaDepthAt(vWorld.xz);
        float light = 1.0 - uNight * 0.94;
        vec3 sea = seaShallows(vec3(${[mid.r, mid.g, mid.b].map((c) => c.toFixed(4)).join(', ')}), depth, vWorld.xz) * ${n(SOFTWARE_BODY)} * light;
        float onBeach = seaOnBeach(vWorld.xz);
        float shore = 1.0 - smoothstep(0.0, min(${n(SURF_DEPTH[1])}, seaShelterAt(vWorld.xz).x * seaHalfHeight() * ${n(SURF_SHOAL / SURF_GAMMA)}), depth);
        float band = smoothstep(0.6, 0.9, 0.5 + 0.5 * sin(depth * ${n(SURF_K)} + uSurfPhase + ripple.z * 2.0));
        float foam = clamp(band * shore * onBeach * (0.55 + 0.6 * uSeaAmp), 0.0, 1.0);
        vec3 glint = uKeyLight * pow(max(dot(reflection, uKeyDir), 0.0), 600.0) * 40.0 * fresnel;
        vec3 col = mix(sea, sky, fresnel * (1.0 - foam)) + min(glint, vec3(${n(SEA_GLINT_MAX)})) * (1.0 - foam);
        gl_FragColor = vec4(mix(col, vec3(0.8) * light, foam), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
/** The plane drawn on Low (and on software), centred on the camera like the grid. */
export function seaPlane(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(SKIRT_EXTENT * 2, SKIRT_EXTENT * 2).rotateX(-Math.PI / 2);
  g.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}

/**
 * The wave grid (High and Medium) in XZ around its centre: 1 m cells to FINE_EXTENT, COARSE_CELL cells to
 * COARSE_EXTENT, then a flat skirt to SKIRT_EXTENT whose inner rim shares the coarse ring's vertices. The fine ring's rim
 * vertices that fall between coarse ones carry aEdge (the rim's direction), so the shader puts them on the coarse ring's
 * edges. The mesh is moved in whole COARSE_CELL steps (Environment), so every vertex stays on a fixed world lattice.
 */
export function seaGrid(): THREE.BufferGeometry {
  const pos: number[] = [];
  const edge: number[] = [];
  const index: number[] = [];
  const vertex = (x: number, z: number, ex = 0, ez = 0): number => {
    pos.push(x, 0, z);
    edge.push(ex, ez);
    return pos.length / 3 - 1;
  };
  const grid = (half: number, cell: number, hole: number, rim: boolean): void => {
    const cells = Math.round((half * 2) / cell);
    const ids: number[] = [];
    for (let j = 0; j <= cells; j++) {
      for (let i = 0; i <= cells; i++) {
        const x = -half + i * cell;
        const z = -half + j * cell;
        if (Math.max(Math.abs(x), Math.abs(z)) < hole) {
          ids.push(-1);
          continue;
        }
        let ex = 0;
        let ez = 0;
        if (rim) {
          // On the rim and between two coarse vertices: slide along the rim.
          if (Math.abs(z) === half && x % COARSE_CELL !== 0) ex = 1;
          else if (Math.abs(x) === half && z % COARSE_CELL !== 0) ez = 1;
        }
        ids.push(vertex(x, z, ex, ez));
      }
    }
    const at = (i: number, j: number) => ids[j * (cells + 1) + i]!;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const cx = -half + (i + 0.5) * cell;
        const cz = -half + (j + 0.5) * cell;
        if (Math.max(Math.abs(cx), Math.abs(cz)) < hole) continue;
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i, j + 1);
        const d = at(i + 1, j + 1);
        // Counter-clockwise seen from above (+y).
        index.push(a, c, b, b, c, d);
      }
    }
  };
  grid(FINE_EXTENT, 1, 0, true);
  grid(COARSE_EXTENT, COARSE_CELL, FINE_EXTENT, false);
  // The skirt: per side, a strip of quads from the coarse rim out to SKIRT_EXTENT, flat (the waves have faded out).
  const steps = Math.round((COARSE_EXTENT * 2) / COARSE_CELL);
  const k = SKIRT_EXTENT / COARSE_EXTENT;
  const sides: Array<(t: number) => [number, number]> = [
    (t) => [t, -COARSE_EXTENT],
    (t) => [COARSE_EXTENT, t],
    (t) => [-t, COARSE_EXTENT],
    (t) => [-COARSE_EXTENT, -t],
  ];
  for (const side of sides) {
    for (let i = 0; i < steps; i++) {
      const [x0, z0] = side(-COARSE_EXTENT + i * COARSE_CELL);
      const [x1, z1] = side(-COARSE_EXTENT + (i + 1) * COARSE_CELL);
      const a = vertex(x0, z0);
      const b = vertex(x1, z1);
      const c = vertex(x0 * k, z0 * k);
      const d = vertex(x1 * k, z1 * k);
      index.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  const count = pos.length / 3;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  // Never read (the shader works the ripple UV out from the world position), but three's shader declares it.
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 2));
  g.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKIRT_EXTENT * Math.SQRT2);
  return g;
}

/** Where the grid's centre goes for a camera at (x, z): whole COARSE_CELL steps, so its vertices never swim. */
export function snapSea(v: number): number {
  return Math.round(v / COARSE_CELL) * COARSE_CELL;
}
