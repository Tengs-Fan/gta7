// Storefronts: which shop front goes on each frontage (no identical front within 40 m, never the same shop twice
// in a row), their awnings, and the storefront material, whose glass shows a room behind it (interior mapping on
// the interior atlas) that shifts with the view and lights up at night.

import * as THREE from 'three';
import { hashInts, type Building, type CityLayout, type Side } from '../../world/layout';
import { ATLAS_CELLS, ATLAS_SIZE, INTERIORS, SHOPS, interiorUv, type StorefrontAtlas } from '../textures';
import { patchBuildingFog, type BuildingUniforms } from './facadeShader';
import { frontageSplit } from './buildings';

export type AwningStyle = 'none' | 'slope' | 'striped' | 'dome' | 'box';

export interface FrontDesign {
  /** Shop atlas cell (SHOPS index). */
  shop: number;
  awning: AwningStyle;
  /** Awning colour (packed sRGB); -1 with no awning. */
  color: number;
}

export interface ShopFrontage extends FrontDesign {
  building: number;
  side: Side;
  /** Index of the quad along its wall. */
  index: number;
  /** Centre of the quad at the foot of the wall. */
  x: number;
  z: number;
}

/** Awning colours offered besides a shop's own. */
const PALETTE = [0xc0392b, 0x1e7b46, 0x1f4e79, 0xf2c14e, 0x6b3f2a, 0x2b2b2b, 0x8e44ad, 0xe67e22, 0x16a085, 0xe85a9a];
const NEUTRAL = [0x2b2b2b, 0x4a4f55, 0x6b3f2a, 0x1f4e79, 0x7b1e1e];

/** The awning styles and colours a shop's front may take, its own colour first. */
export function frontVariants(shop: number): Array<{ awning: AwningStyle; color: number }> {
  const own = SHOPS[shop]!.awning;
  const out: Array<{ awning: AwningStyle; color: number }> = [];
  if (own >= 0) {
    for (const awning of ['striped', 'slope', 'dome', 'box'] as const) out.push({ awning, color: own });
    for (const c of PALETTE) if (c !== own) for (const awning of ['slope', 'dome', 'striped', 'box'] as const) out.push({ awning, color: c });
  } else {
    out.push({ awning: 'none', color: -1 });
    for (const c of NEUTRAL) for (const awning of ['box', 'slope'] as const) out.push({ awning, color: c });
  }
  return out;
}

const SIDE_INDEX: Record<Side, number> = { N: 0, E: 1, S: 2, W: 3 };
/** Fronts that count as near each other (centre distance, m). */
export const FRONT_REPEAT_DISTANCE = 40;

export function frontKey(b: number, side: Side, i: number): string {
  return `${b}:${side}:${i}`;
}

/** The street walls of a building's first tier, walked as the ground floor is drawn. */
function walls(b: Building): Array<{ side: Side; x0: number; z0: number; x1: number; z1: number }> {
  const t = b.tiers[0]!;
  return [
    { side: 'S' as Side, x0: t.minX, z0: t.maxZ, x1: t.maxX, z1: t.maxZ },
    { side: 'E' as Side, x0: t.maxX, z0: t.maxZ, x1: t.maxX, z1: t.minZ },
    { side: 'N' as Side, x0: t.maxX, z0: t.minZ, x1: t.minX, z1: t.minZ },
    { side: 'W' as Side, x0: t.minX, z0: t.minZ, x1: t.minX, z1: t.maxZ },
  ].filter((w) => b.groundSides.includes(w.side));
}

const BEACH_SHOPS = SHOPS.map((s, i) => (s.beach ? i : -1)).filter((i) => i >= 0);
const INLAND_SHOPS = SHOPS.map((s, i) => (s.name === 'SURF SHOP' ? -1 : i)).filter((i) => i >= 0);

/**
 * Every shop frontage in the layout with its design, in a fixed order (building, wall, quad), chosen greedily:
 * a shop not seen within FRONT_REPEAT_DISTANCE if one is left in the district's pool, else the same shop in an
 * awning style and colour not used by that shop within the distance; never the shop of the quad before it.
 */
export function storefrontPlan(layout: CityLayout): ShopFrontage[] {
  const out: ShopFrontage[] = [];
  const cell = FRONT_REPEAT_DISTANCE;
  const grid = new Map<string, ShopFrontage[]>();
  const near = (x: number, z: number): ShopFrontage[] => {
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    const res: ShopFrontage[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const f of grid.get(`${gx + i},${gz + j}`) ?? []) if (Math.hypot(f.x - x, f.z - z) <= cell) res.push(f);
    return res;
  };
  for (const b of layout.buildings) {
    if (b.ground !== 'shops' || b.special === 'gunshop' || b.tiers.length === 0) continue;
    let prev = -1;
    for (const wl of walls(b)) {
      const len = Math.hypot(wl.x1 - wl.x0, wl.z1 - wl.z0);
      const ux = (wl.x1 - wl.x0) / len;
      const uz = (wl.z1 - wl.z0) / len;
      const split = frontageSplit(len, null);
      for (let i = 0; i + 1 < split.edges.length; i++) {
        const mid = (split.edges[i]! + split.edges[i + 1]!) / 2;
        const x = wl.x0 + ux * mid;
        const z = wl.z0 + uz * mid;
        const h = hashInts(b.id, SIDE_INDEX[wl.side], i, 0xf00d);
        const rnd = (k: number) => hashInts(h, k) / 4294967296;
        const pool = b.district === 'beachfront' && rnd(2) < 0.75 ? BEACH_SHOPS : INLAND_SHOPS;
        const start = Math.floor(rnd(3) * pool.length);
        const around = near(x, z);
        let choice: FrontDesign | null = null;
        // First a shop nobody shows nearby, in its usual dress (or another at random).
        for (let k = 0; k < pool.length && !choice; k++) {
          const shop = pool[(start + k) % pool.length]!;
          if (shop === prev || around.some((f) => f.shop === shop)) continue;
          const vs = frontVariants(shop);
          const v = rnd(4) < 0.6 ? vs[0]! : vs[Math.floor(rnd(5) * Math.min(vs.length, 12))]!;
          choice = { shop, ...v };
        }
        // Else the same shop in a dress no nearby front of it wears.
        for (let k = 0; k < pool.length && !choice; k++) {
          const shop = pool[(start + k) % pool.length]!;
          if (shop === prev) continue;
          for (const v of frontVariants(shop)) {
            if (around.some((f) => f.shop === shop && f.awning === v.awning && f.color === v.color)) continue;
            choice = { shop, ...v };
            break;
          }
        }
        if (!choice) choice = { shop: pool[start]!, awning: 'none', color: -1 };
        const f: ShopFrontage = { ...choice, building: b.id, side: wl.side, index: i, x, z };
        out.push(f);
        const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(f);
        prev = f.shop;
      }
    }
  }
  return out;
}

/** Fragment block run where three samples the colour map: the room behind a storefront's glass. */
const STORE_MAIN = /* glsl */ `
vec4 sTex = texture2D(map, vMapUv);
vec2 sDux = dFdx(vMapUv);
vec2 sDuy = dFdy(vMapUv);
vec4 sInt = texture2D(uIntMap, vMapUv);
vec3 sAlb = sTex.rgb;
vec2 sEmUv = vMapUv;
float sGlass = step(0.5, sInt.a);
float sRoomLight = 1.0;
float sNearK = 0.0;
{
  vec3 N = normalize(vSNormal);
  vec3 Uw = vec3(N.z, 0.0, -N.x);
  float sgn = dot(dFdx(vSWorld), Uw) * sDux.x + dot(dFdy(vSWorld), Uw) * sDuy.x;
  sgn = sgn < 0.0 ? -1.0 : 1.0;
  float dist = length(vSWorld - cameraPosition);
  float nearK = (1.0 - smoothstep(55.0, 85.0, dist)) * uParallax * sGlass;
  float col = floor(vMapUv.x * ${ATLAS_SIZE.cols.toFixed(1)});
  float row = floor((1.0 - vMapUv.y) * ${(ATLAS_SIZE.h / ATLAS_SIZE.cellH).toFixed(5)});
  int idx = int(row * ${ATLAS_SIZE.cols.toFixed(1)} + col);
  if (nearK > 0.001 && idx >= 0 && idx < ${ATLAS_CELLS}) {
    vec4 R = uSRect[idx];
    vec4 room = uSRoom[idx];
    if (room.x > 0.0) {
      // Room coordinates in metres: x along the window, y up from its sill, z into the room.
      vec2 scale = room.yz;
      vec2 p = (vMapUv - R.xy) * scale;
      vec2 size = (R.zw - R.xy) * scale;
      vec3 V = normalize(vSWorld - cameraPosition);
      vec3 Vt = vec3(dot(V, Uw) * sgn, V.y, max(-dot(V, N), 0.05));
      float D = room.x;
      float tb = D / Vt.z;
      float tx = abs(Vt.x) > 1e-5 ? ((Vt.x > 0.0 ? size.x : 0.0) - p.x) / Vt.x : 1e6;
      float ty = abs(Vt.y) > 1e-5 ? ((Vt.y > 0.0 ? size.y : 0.0) - p.y) / Vt.y : 1e6;
      tx = max(tx, 0.0);
      ty = max(ty, 0.0);
      float t = min(tb, min(tx, ty));
      vec3 hit = vec3(p + Vt.xy * t, Vt.z * t);
      vec2 hp = clamp(hit.xy, vec2(0.02), size - 0.02);
      vec2 backUv = R.xy + hp / scale;
      vec3 c;
      float depthK = hit.z / D;
      // Room surfaces other than the back wall glow with the light at the top of the window.
      // Samples for the walls, floor and ceiling keep clear of the window's frame and mullions.
      vec2 inner = clamp(hp, vec2(0.35), size - 0.35);
      vec2 lightUv = R.xy + vec2(inner.x, size.y - 0.35) / scale;
      vec2 emUv = lightUv;
      float emK = 1.0;
      if (t >= tb) {
        c = textureGrad(uIntMap, backUv, sDux, sDuy).rgb;
        emUv = backUv;
      } else if (tx < ty) {
        // Side wall: the back wall's edge colour, darker towards the glass.
        vec2 edgeUv = R.xy + vec2(Vt.x > 0.0 ? size.x - 0.35 : 0.35, inner.y) / scale;
        c = textureGrad(uIntMap, edgeUv, sDux, sDuy).rgb * mix(0.62, 0.85, depthK);
        emK = 0.8;
      } else if (Vt.y < 0.0) {
        // Floor: the room's lower colour, in tiles.
        vec2 fUv = R.xy + vec2(inner.x, 0.35) / scale;
        float tile = mod(floor(hit.x / 0.6) + floor(hit.z / 0.6), 2.0);
        c = textureGrad(uIntMap, fUv, sDux, sDuy).rgb * (0.45 + 0.08 * tile);
        emK = 0.6;
      } else {
        // Ceiling with downlights.
        vec2 cUv = R.xy + vec2(inner.x, size.y - 0.35) / scale;
        vec2 cell = fract(vec2(hit.x, hit.z) / 1.6) - 0.5;
        float spot = 1.0 - smoothstep(0.06, 0.16, length(cell));
        c = textureGrad(uIntMap, cUv, sDux, sDuy).rgb * 0.8 + spot * 0.6;
        emK = 1.0 + spot * 1.5;
      }
      // A little dimmer deep inside and towards the room's edges.
      c *= mix(1.0, 0.78, depthK);
      sAlb = mix(sAlb, c, nearK);
      sEmUv = mix(vMapUv, emUv, nearK);
      sRoomLight = mix(1.0, emK, nearK);
      sNearK = nearK;
    }
  }
}
diffuseColor.rgb *= sAlb;
`;

const STORE_EMISSIVE = /* glsl */ `
#ifdef USE_EMISSIVEMAP
  vec3 sEm = textureGrad(emissiveMap, sEmUv, sDux, sDuy).rgb;
  // Inside a lit room the light shows the room's own colours rather than a flat glow.
  sEm = mix(sEm, sEm * (0.55 + sAlb * 1.3), sNearK);
  totalEmissiveRadiance *= sEm * sRoomLight;
#endif`;

export const STOREFRONT_PROGRAM = 'gta7-storefront-v3';

/**
 * The storefront material: the colour atlas, its emissive atlas and the interior atlas. `night` is the block that
 * decides per frontage (aSeed) whether its lights are on.
 */
export function createStorefrontMaterial(atlas: StorefrontAtlas, uniforms: Record<string, { value: number }>, night: string, nightHash: string, bu: BuildingUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: atlas.map,
    emissiveMap: atlas.emissive,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0,
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.05,
  });
  mat.name = 'storefronts';
  mat.userData.interior = atlas.interior;
  const rects: THREE.Vector4[] = [];
  const rooms: THREE.Vector4[] = [];
  for (let c = 0; c < ATLAS_CELLS; c++) {
    const uv = interiorUv(c);
    const room = INTERIORS[c];
    if (uv && room) {
      rects.push(new THREE.Vector4(uv[0], uv[1], uv[2], uv[3]));
      rooms.push(new THREE.Vector4(room.depth, room.w / (uv[2] - uv[0]), room.h / (uv[3] - uv[1]), 0));
    } else {
      rects.push(new THREE.Vector4());
      rooms.push(new THREE.Vector4());
    }
  }
  const all = { ...uniforms, uIntMap: { value: atlas.interior }, uSRect: { value: rects }, uSRoom: { value: rooms }, uParallax: bu.parallax };
  const decl = Object.keys(uniforms).map((k) => `uniform float ${k};`).join('\n');
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, all);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSeed;\nflat varying float vSeed;\nvarying vec3 vSWorld;\nvarying vec3 vSNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeed = aSeed;\nvSWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nflat varying float vSeed;\nvarying vec3 vSWorld;\nvarying vec3 vSNormal;\nuniform sampler2D uIntMap;\nuniform vec4 uSRect[${ATLAS_CELLS}];\nuniform vec4 uSRoom[${ATLAS_CELLS}];\nuniform float uParallax;\n${decl}\n${nightHash}`)
      .replace('#include <map_fragment>', STORE_MAIN)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.08, sGlass);')
      .replace('#include <emissivemap_fragment>', `${STORE_EMISSIVE}\nif (dot(totalEmissiveRadiance, vec3(1.0)) > 0.001) ${night}`);
    patchBuildingFog(shader, bu);
  };
  mat.customProgramCacheKey = () => STOREFRONT_PROGRAM;
  return mat;
}
