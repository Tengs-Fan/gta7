// Las Lomas County's beaches in the sea (render/sea.ts countyShore): the depth map baked from the county's ground, the
// CPU twins against main's frozen copies round the city, the waterline against baseGround, the shallows' colour, no quay
// foam off the beaches, the uniforms the sea reads, and the surf heard on the county's land (audio/ambience.ts).

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { ambienceTargets, countyCoast, shoreInfo, type AmbienceInput } from '../../src/audio/ambience';
import {
  COUNTY_TEXELS_X, COUNTY_TEXELS_Z, countyDepthAt, countyShore, MAX_COUNTY_LAND, outsideCounty, outsideLand, patchSeaMaterial, SEA_MID, SHELF_SLOPE, SHELF_START, SHORE_GLSL,
  seaDepthCpu, seaDrawnDepth, seaOnBeach, seaShallowsCpu, seaUniforms, setCountyShore, softwareSeaMaterial, type CountyShore,
} from '../../src/render/sea';
import { BEACH_W, CURB_H, SAND_DROP, SEABED_Y, WATER_Y } from '../../src/world/constants';
import { CAUSEWAY, countryGround, LAKE } from '../../src/world/country';
import { rectContains, type Bounds } from '../../src/world/layout';
import { world } from './helpers';

// main's CPU twins before the county's beaches (d831497), frozen: the sea round the city alone.
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function mainDepth(b: Bounds, x: number, z: number): number {
  const xc = clamp(x, b.beachStartX, b.beachEndX + 25);
  const endY = CURB_H - SAND_DROP;
  const sand = xc <= b.beachEndX ? CURB_H - ((xc - b.beachStartX) / BEACH_W) * SAND_DROP : endY + (SEABED_Y - endY) * ((xc - b.beachEndX) / 25);
  const out = Math.hypot(x - xc, z - clamp(z, b.landMinZ, b.landMaxZ));
  const shelf = WATER_Y - sand;
  return shelf + (WATER_Y - SEABED_Y - shelf) * smooth(0, 40, out);
}
function mainOutside(b: Bounds, x: number, z: number): number {
  return Math.hypot(Math.max(b.landMinX - x, x - b.beachEndX, 0), Math.max(b.landMinZ - z, z - b.landMaxZ, 0));
}
function mainDrawn(b: Bounds, x: number, z: number): number {
  return mainDepth(b, x, z) + SHELF_SLOPE * Math.max(0, mainOutside(b, x, z) - SHELF_START);
}
function mainOnBeach(b: Bounds, x: number, z: number): number {
  const xc = clamp(x, b.beachStartX, b.beachEndX + 25);
  return 1 - smooth(0, 4, Math.hypot(x - xc, z - clamp(z, b.landMinZ, b.landMaxZ)));
}

/** main's seaQuay, as SHORE_GLSL had it: the quay foam's distance stays the city's. */
const MAIN_SEA_QUAY = `float seaQuay(vec2 p) {
  float dx = max(max(uShoreLand.x - p.x, p.x - uShoreLand.w), 0.0);
  float dz = max(max(uShoreLand.y - p.y, p.y - uShoreLand.z), 0.0);
  return length(vec2(dx, dz));
}`;
/** The quay foam's strip reaches at most this far out (seaFoam: width 0.5 + 1.0 * smoothstep(...)). */
const QUAY_REACH = 1.5;

let b: Bounds;
let county: CountyShore;
/** The sim's water depth (WATER_Y less baseGround). */
const simDepth = (x: number, z: number): number => WATER_Y - world().baseGround(x, z);
/** Off the causeway, whose headland is baseGround's but no beach (countyShore bakes the county's ground under it). */
const offCauseway = (x: number, z: number): boolean => !rectContains(CAUSEWAY, x, z, 1);

beforeAll(() => {
  b = world().layout.bounds;
  county = countyShore(world().layout.country);
});

describe('the county\'s depth map', () => {
  it('covers the county\'s land and beaches corner to corner, its edge on the flat seabed, so the sea is continuous across it', () => {
    expect(county.box).toEqual(world().layout.country.bounds);
    expect(county.depth.length).toBe(COUNTY_TEXELS_X * COUNTY_TEXELS_Z);
    expect(county.land).toBe(world().layout.country.shelf);
    const box = county.box;
    let worst = 0;
    for (let t = 0; t <= 1; t += 1 / 997) {
      const x = box.minX + t * (box.maxX - box.minX);
      const z = box.minZ + t * (box.maxZ - box.minZ);
      for (const [px, pz, dx, dz] of [[box.minX, z, -1, 0], [box.maxX, z, 1, 0], [x, box.minZ, 0, -1], [x, box.maxZ, 0, 1]] as const) {
        worst = Math.max(worst, Math.abs(seaDepthCpu(b, px - dx * 0.01, pz - dz * 0.01, county) - seaDepthCpu(b, px + dx * 0.01, pz + dz * 0.01, county)));
      }
    }
    expect(worst).toBeLessThan(0.01);
    // A lattice point reads its own texel; between them the map is bilinear.
    const NX = COUNTY_TEXELS_X;
    const NZ = COUNTY_TEXELS_Z;
    const at = (i: number, j: number) => countyDepthAt(county, box.minX + ((box.maxX - box.minX) * i) / (NX - 1), box.minZ + ((box.maxZ - box.minZ) * j) / (NZ - 1));
    for (const [i, j] of [[0, 0], [NX - 1, NZ - 1], [300, 200], [1023, 17]] as const) expect(at(i, j)).toBeCloseTo(county.depth[j * NX + i]!, 5);
    expect(countyDepthAt(county, box.minX - 0.01, 0)).toBe(Infinity);
  });

  it('the twin agrees with baseGround at the county\'s waterline, and within 0.2 m over its surf zone', () => {
    const box = county.box;
    let crossings = 0;
    let worst = 0;
    // Along lines across the box both ways: where baseGround crosses WATER_Y, the twin's depth is within 9 cm of 0 (6 cm
    // but for Lake Lomas, whose rounded steps the 1.65 by 2.4 m texels follow a little less closely).
    const scan = (along: (s: number) => [number, number], from: number, to: number) => {
      let [px, pz] = along(from);
      let pd = simDepth(px, pz);
      for (let s = from + 0.5; s <= to; s += 0.5) {
        const [x, z] = along(s);
        const d = simDepth(x, z);
        if (d > 0 !== pd > 0 && offCauseway(x, z) && offCauseway(px, pz)) {
          let lo = s - 0.5;
          let hi = s;
          for (let k = 0; k < 40; k++) {
            const m = (lo + hi) / 2;
            const [mx, mz] = along(m);
            if (simDepth(mx, mz) > 0 === pd > 0) lo = m;
            else hi = m;
          }
          const [wx, wz] = along(lo);
          worst = Math.max(worst, Math.abs(seaDepthCpu(b, wx, wz, county)));
          crossings++;
        }
        [px, pz, pd] = [x, z, d];
      }
    };
    for (let z = box.minZ + 5; z < box.maxZ; z += 10) scan((s) => [s, z], box.minX, box.maxX);
    for (let x = box.minX + 5; x < box.maxX; x += 10) scan((s) => [x, s], box.minZ, box.maxZ);
    expect(crossings).toBeGreaterThan(400);
    expect(worst).toBeLessThan(0.09);
    let band = 0;
    let errs = 0;
    for (let z = box.minZ; z <= box.maxZ; z += 2.5) {
      for (let x = box.minX; x <= box.maxX; x += 2.5) {
        const sim = simDepth(x, z);
        if (!(sim > 0 && sim < 3) || !offCauseway(x, z)) continue;
        band++;
        errs = Math.max(errs, Math.abs(seaDepthCpu(b, x, z, county) - sim));
      }
    }
    // (0.15 m round the county's own coves; Lake Lomas's rounded shore, with its kinks where the disc's reach changes, reaches 0.17.)
    expect(band).toBeGreaterThan(5000);
    expect(errs).toBeLessThan(0.2);
  });
});

describe('the city\'s sea is main\'s', () => {
  it('everywhere off the county\'s box the depth and the beach foam are main\'s exactly, and so is the drawn shelf wherever the city\'s land is the nearer', () => {
    // Off the box the county only moves the shelf where its land is nearer: in Lomas Sound's west half and the sea
    // round the county, where main drew the abyss.
    let off = 0;
    let shelf = 0;
    let moved = 0;
    for (let x = b.worldMinX - 400; x <= b.worldMaxX + 400; x += 7.3) {
      for (let z = b.worldMinZ - 400; z <= b.worldMaxZ + 400; z += 7.3) {
        if (rectContains(county.box, x, z)) continue;
        off++;
        expect(seaDepthCpu(b, x, z, county)).toBe(mainDepth(b, x, z));
        expect(seaOnBeach(b, x, z, county)).toBe(mainOnBeach(b, x, z));
        if (mainOutside(b, x, z) <= outsideCounty(county, x, z)) {
          shelf++;
          expect(seaDrawnDepth(b, x, z, county)).toBe(mainDrawn(b, x, z));
        } else if (seaDrawnDepth(b, x, z, county) < mainDrawn(b, x, z)) moved++;
      }
    }
    expect(off).toBeGreaterThan(100_000);
    expect(shelf).toBeGreaterThan(off / 2);
    expect(moved).toBeGreaterThan(0);
  });

  it('over the city\'s coasts, 90 m out all round its land and its water cut into it, depth, shelf and beach foam are main\'s', () => {
    let n = 0;
    for (let x = b.landMinX - 90; x <= b.beachEndX + 90; x += 3.1) {
      for (let z = b.landMinZ - 90; z <= b.landMaxZ + 90; z += 3.1) {
        if (mainOutside(b, x, z) > 90) continue;
        expect(rectContains(county.box, x, z)).toBe(false);
        expect(seaDepthCpu(b, x, z, county)).toBe(mainDepth(b, x, z));
        expect(seaDrawnDepth(b, x, z, county)).toBe(mainDrawn(b, x, z));
        expect(seaOnBeach(b, x, z, county)).toBe(mainOnBeach(b, x, z));
        n++;
      }
    }
    expect(n).toBeGreaterThan(100_000);
    // Without the county the twins are main's everywhere.
    for (const [x, z] of [[-1000, 0], [-680, -100], [-1200, -520], [520, 0], [610, 40]] as const) {
      expect(seaDepthCpu(b, x, z)).toBe(mainDepth(b, x, z));
      expect(seaDrawnDepth(b, x, z)).toBe(mainDrawn(b, x, z));
      expect(outsideLand(b, x, z)).toBe(mainOutside(b, x, z));
    }
  });
});

describe('the county\'s beaches as the sea draws them', () => {
  it('the shallows read turquoise from the wet sand out to 20 m off the county\'s land, where main drew the deep', () => {
    const u = seaUniforms();
    // The sea material's own colour (Environment's water), linear.
    const mid = new THREE.Color(SEA_MID);
    const hsl = { h: 0, s: 0, l: 0 };
    const hue = (depth: number, shelf: number) => seaShallowsCpu(u, mid, depth, shelf, new THREE.Color()).convertLinearToSRGB().getHSL(hsl).h * 360;
    const box = county.box;
    let n = 0;
    for (let z = box.minZ; z <= box.maxZ; z += 2.5) {
      for (let x = box.minX; x <= box.maxX; x += 2.5) {
        const depth = seaDepthCpu(b, x, z, county);
        // Past the wet sand's tint (0.15 m) and no further than 20 m off the land; Lake Lomas has no shelf, as deep as the sim makes it.
        if (!(depth > 0.15) || outsideCounty(county, x, z) > 20 || rectContains(LAKE, x, z)) continue;
        n++;
        const h = hue(depth, seaDrawnDepth(b, x, z, county));
        expect(h, `${x}, ${z}`).toBeGreaterThan(160);
        expect(h, `${x}, ${z}`).toBeLessThan(190);
        // main drew the deep (past the material's own colour, towards the deep blue) here.
        expect(hue(mainDepth(b, x, z), mainDrawn(b, x, z))).toBeGreaterThan(195);
      }
    }
    expect(n).toBeGreaterThan(5000);
    // Further out the colour deepens as on the city's coasts: Lomas Sound's middle is past the material's colour.
    expect(hue(seaDepthCpu(b, -606, 0, county), seaDrawnDepth(b, -606, 0, county))).toBeGreaterThan(195);
  });

  it('the surf bands and the swash run round the county, and no quay foam: its beaches are far from the city\'s quay walls', () => {
    const box = county.box;
    let n = 0;
    for (let z = box.minZ; z <= box.maxZ; z += 3) {
      for (let x = box.minX; x <= box.maxX; x += 3) {
        if (!(seaDepthCpu(b, x, z, county) > 0)) continue;
        n++;
        // (Lake Lomas's box takes most of the surf off: see the lake's water below.)
        expect(seaOnBeach(b, x, z, county)).toBe(rectContains(LAKE, x, z) ? 1 - 0.85 : 1);
        // outsideLand without the county is the shader's seaQuay: the quay strip is out of reach.
        expect(outsideLand(b, x, z)).toBeGreaterThan(QUAY_REACH * 50);
      }
    }
    expect(n).toBeGreaterThan(20_000);
    // The quay foam reads main's seaQuay, the city's alone; the county only joins the shelf's distance.
    expect(SHORE_GLSL).toContain(MAIN_SEA_QUAY);
    expect(SHORE_GLSL).toContain('float d = seaQuay(p);');
    expect(SHORE_GLSL).toContain('max(min(seaQuay(p), seaCountyOut(p))');
    expect(SHORE_GLSL).toContain('float onBeach = seaOnBeach(p);');
  });

  it('the shader samples the map once per fragment: in seaDepthAt, its one fetch out of control flow', () => {
    const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
    expect(count(SHORE_GLSL, /texture/g)).toBe(1);
    expect(count(SHORE_GLSL, /textureLod\( ?uCountyDepth/g)).toBe(1);
    // Its definition and seaDepthAt's call; seaDepthAt is only defined here, and called once by each sea's fragment.
    expect(count(SHORE_GLSL, /seaCountyDepth\(/g)).toBe(2);
    expect(count(SHORE_GLSL, /seaDepthAt\(/g)).toBe(1);
    const u = seaUniforms();
    const mat = new THREE.MeshStandardMaterial();
    patchSeaMaterial(mat, u, { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, intensity: { value: 0 } });
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(count(shader.fragmentShader, /seaDepthAt\(/g)).toBe(2);
    expect(shader.uniforms.uCountyDepth).toBe(u.uCountyDepth);
    const soft = softwareSeaMaterial(u, {});
    expect(count(soft.fragmentShader, /seaDepthAt\(/g)).toBe(2);
    expect(soft.fragmentShader).toContain('float onBeach = seaOnBeach(vWorld.xz);');
    expect(soft.uniforms.uCountyBox).toBe(u.uCountyBox);
  });

  it('setCountyShore uploads the map as bilinear half floats and the box and land the shader reads', () => {
    const u = seaUniforms();
    // Before it, no county: the box lies far away.
    expect(u.uCountyDepth.value).toBeNull();
    expect(u.uCountyBox.value.x).toBeGreaterThan(1e5);
    setCountyShore(u, county);
    const tex = u.uCountyDepth.value!;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect([tex.image.width, tex.image.height]).toEqual([COUNTY_TEXELS_X, COUNTY_TEXELS_Z]);
    expect(tex.format).toBe(THREE.RedFormat);
    expect(tex.type).toBe(THREE.HalfFloatType);
    expect(tex.magFilter).toBe(THREE.LinearFilter);
    expect(tex.minFilter).toBe(THREE.LinearFilter);
    expect(tex.generateMipmaps).toBe(false);
    const half = tex.image.data as Uint16Array;
    for (let i = 0; i < half.length; i += 997) expect(THREE.DataUtils.fromHalfFloat(half[i]!)).toBe(county.depth[i]!);
    const box = county.box;
    const v = u.uCountyBox.value;
    expect([v.x, v.y]).toEqual([box.minX, box.minZ]);
    expect(v.z).toBeCloseTo(1 / (box.maxX - box.minX), 12);
    expect(v.w).toBeCloseTo(1 / (box.maxZ - box.minZ), 12);
    // The shader's loop runs over exactly the rectangles of the shelf's land: none unused, none left out.
    expect(county.land.length).toBe(MAX_COUNTY_LAND);
    u.uCountyLand.value.forEach((r, i) => {
      const land = county.land[i];
      expect([r.x, r.y, r.z, r.w]).toEqual(land ? [land.minX, land.minZ, land.maxX, land.maxZ] : [1e6, 1e6, 1e6, 1e6]);
    });
    tex.dispose();
  });
});

describe('Lake Lomas\'s water is fresh', () => {
  const u = seaUniforms();
  const mid = new THREE.Color(SEA_MID);
  const hsl = { h: 0, s: 0, l: 0 };
  const hue = (depth: number, lake: boolean) => seaShallowsCpu(u, mid, depth, depth, new THREE.Color(), lake).convertLinearToSRGB().getHSL(hsl).h * 360;

  it('its shallows are green where the sea\'s are turquoise, its thinnest water muddy where the sea\'s is sand-tinted, and its body darker', () => {
    expect(hue(1, false)).toBeGreaterThan(160);
    expect(hue(1, false)).toBeLessThan(190);
    expect(hue(1, true)).toBeGreaterThan(90);
    expect(hue(1, true)).toBeLessThan(150);
    const bed = (lake: boolean) => seaShallowsCpu(u, mid, 0, 0, new THREE.Color(), lake);
    expect(bed(true).equals(bed(false))).toBe(false);
    expect(bed(true).r).toBeGreaterThan(bed(true).b);
    const body = (lake: boolean) => seaShallowsCpu(u, mid, 6, 6, new THREE.Color(), lake);
    expect(body(true).getHSL(hsl).l).toBeLessThan(body(false).getHSL(hsl).l);
    expect(body(true).equals(body(false))).toBe(false);
  });

  it('has no surf line along its shore, and the sea\'s own beaches keep theirs', () => {
    const lake = world().layout.country.lake;
    const cx = (lake.minX + lake.maxX) / 2;
    const cz = (lake.minZ + lake.maxZ) / 2;
    expect(seaOnBeach(b, cx, cz, county)).toBeCloseTo(0.15, 12);
    expect(seaOnBeach(b, lake.minX - 5, cz, county)).toBe(1);
    expect(seaOnBeach(b, lake.maxX + 5, lake.maxZ + 5, county)).toBe(1);
  });

  it('the shader takes the box as a uniform, tests it in the shallows and the beach foam, and the county uploads it', () => {
    expect(SHORE_GLSL).toContain('float lake = seaInLake(p);');
    expect(SHORE_GLSL).toContain('* (1.0 - 0.85 * seaInLake(p))');
    const u2 = seaUniforms();
    expect(u2.uLakeBox.value.x).toBeGreaterThan(1e5);
    setCountyShore(u2, county);
    const l = county.lake;
    expect(u2.uLakeBox.value.toArray()).toEqual([l.minX, l.minZ, l.maxX, l.maxZ]);
    u2.uCountyDepth.value!.dispose();
  });
});

describe('the surf on the county\'s land', () => {
  const shore = (x: number, z: number) => shoreInfo(b, x, z, undefined, [], world().layout.country);

  it('its waterline is traced on the county\'s ground', () => {
    const segs = countyCoast(world().layout.country);
    expect(countyCoast(world().layout.country)).toBe(segs);
    expect(segs.length / 4).toBeGreaterThan(800);
    for (let k = 0; k < segs.length; k += 4) {
      const x = (segs[k]! + segs[k + 2]!) / 2;
      const z = (segs[k + 1]! + segs[k + 3]!) / 2;
      expect(rectContains(county.box, x, z)).toBe(true);
      // Within 0.2 m: where two rectangles' beaches meet round a cove the waterline turns a right angle, which the 4 m
      // lattice cuts by up to a metre (the valley's coves; 0.15 m in the county's).
      expect(Math.abs(countryGround(world().layout.country, x, z) - WATER_Y)).toBeLessThan(0.2);
      if (offCauseway(x, z)) expect(Math.abs(simDepth(x, z))).toBeLessThan(0.2);
    }
  });

  it('is heard from the waterline nearest, quiet in the middle of the fields, full over the water', () => {
    // 20 m inland of the east shore at z 0 (land to x -700, the waterline 8 m out): about 28 m, to the east.
    const east = shore(-720, 0);
    expect(east.dist).toBeGreaterThan(27);
    expect(east.dist).toBeLessThan(29);
    expect(east.dirX).toBeCloseTo(1, 3);
    const level = (shoreDist: number) => {
      const i: AmbienceInput = { district: 'country', hours: 12, shoreDist, height: 0, traffic: 0, inVehicle: false };
      return ambienceTargets(i).surf;
    };
    expect(level(east.dist)).toBeGreaterThan(0.8);
    // Each point on dry ground hears its nearest waterline, as far as baseGround's own: the distance to a point there
    // with water under it bounds it.
    for (const [x, z] of [[-1000, 0], [-1100, -500], [-1300, 300], [-760, 500], [-1500, -200]] as const) {
      const s = shore(x, z);
      expect(world().baseGround(x, z)).toBeGreaterThan(WATER_Y);
      expect(simDepth(x + s.dirX * (s.dist + 1), z + s.dirZ * (s.dist + 1))).toBeGreaterThan(0);
      expect(simDepth(x + s.dirX * (s.dist - 1), z + s.dirZ * (s.dist - 1))).toBeLessThan(0);
    }
    // Far from every beach the surf is gone; over the county's water it is full.
    expect(level(shore(-1000, 0).dist)).toBe(0);
    expect(shore(-690, 0)).toEqual({ dist: 0, dirX: 0, dirZ: 0 });
    expect(shore(-600, 0)).toEqual({ dist: 0, dirX: 0, dirZ: 0 });
  });

  it('round the city, to the county\'s box across Lomas Sound, it is what it was', () => {
    const water = world().layout.water.flatMap((w) => w.rects);
    expect(b.landMinX - 140).toBeGreaterThan(county.box.maxX);
    for (let x = b.landMinX - 140; x <= b.beachEndX + 200; x += 9.7) {
      for (let z = b.landMinZ - 200; z <= b.landMaxZ + 200; z += 9.7) {
        expect(shoreInfo(b, x, z, undefined, water, world().layout.country)).toEqual(shoreInfo(b, x, z, undefined, water));
      }
    }
  });
});
