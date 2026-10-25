// Lighting track: garage interiors darker than outdoors (VAL-LIT-008), street-lamp haze stronger in rain (VAL-LIT-004),
// wet-road reflections in their light's colour (VAL-LIT-005), contact shadows under people (VAL-LIT-009), the night
// black level and sunset grade (VAL-LIT-003, -007), and the lighting tier table (VAL-LIT-010). Headless, with the stub
// header of light_sprites.test.ts.

import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FOOT_CAPACITY, FOOT_RANGE, FootShadows } from '../../src/render/contactShadows';
import { gradeAt, NIGHT_LIFT } from '../../src/render/grade';
import { DOOR_IN, DOOR_OUT, INTERIOR_REFLECT, INTERIOR_SKY, INTERIOR_SUN, insideness, installInteriorLight, interiorLight, interiorLightInstalled, interiorsOf } from '../../src/render/interiorLight';
import { GLOW, HAZE_RAIN_GAIN, HAZE_RAIN_SIZE, hazeLevel, LightSprites } from '../../src/render/lightSprites';
import { LIGHTING_TIERS, type LightingTier } from '../../src/render/quality';
import { GameRenderer } from '../../src/render/renderer';
import { SIGNAL_STREAK, StreetLighting } from '../../src/render/streetLighting';
import { loadAssetsFromDisk, unloadAssets } from '../../src/render/assets/testing';
import type { StaticWorld } from '../../src/world/staticWorld';
import { world } from './helpers';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    compile(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});


const HDR = { renderer: '', halfFloat: true };
const SOFT = { renderer: 'Google SwiftShader', halfFloat: true };
const canvas = (): HTMLCanvasElement => document.createElement('canvas') as unknown as HTMLCanvasElement;

let W: StaticWorld;
beforeAll(async () => {
  W = world();
  await loadAssetsFromDisk({ filter: (e) => e.id === 'env.sky' });
});
afterAll(() => unloadAssets());

function hsv(r: number, g: number, b: number): { h: number; s: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max > 0 ? d / max : 0 };
}
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('garage interiors', () => {
  it('a point inside a garage gets the reduced sky and sun light, a point outside does not', () => {
    const list = interiorsOf(W.layout.garages, (x, z) => W.groundHeight(x, z));
    expect(list.length).toBeGreaterThanOrEqual(4);
    for (const r of list) {
      const cx = (r.minX + r.maxX) / 2;
      const cz = (r.minZ + r.maxZ) / 2;
      const y = r.floor + 0.5;
      const inside = interiorLight(list, cx, y, cz);
      expect(inside[0]).toBeCloseTo(INTERIOR_SKY, 9);
      expect(inside[1]).toBeCloseTo(INTERIOR_SUN, 9);
      expect(inside[2]).toBeCloseTo(INTERIOR_REFLECT, 9);
      // The roof's underside is inside, its top is not.
      expect(insideness(list, cx, r.ceiling, cz)).toBeCloseTo(1, 9);
      expect(insideness(list, cx, r.ceiling + 0.4, cz)).toBeLessThan(1e-6);
      // Outdoors beyond the door: back to full light within a metre of the door line.
      const out = { N: [cx, r.minZ - 1], S: [cx, r.maxZ + 1], E: [r.maxX + 1, cz], W: [r.minX - 1, cz] }[r.door]!;
      for (const v of interiorLight(list, out[0]!, y, out[1]!)) expect(v).toBeCloseTo(1, 9);
      const atDoor = { N: [cx, r.minZ - DOOR_OUT], S: [cx, r.maxZ + DOOR_OUT], E: [r.maxX + DOOR_OUT, cz], W: [r.minX - DOOR_OUT, cz] }[r.door]!;
      expect(insideness(list, atDoor[0]!, y, atDoor[1]!)).toBeLessThan(1e-6);
      const inDoor = { N: [cx, r.minZ + DOOR_IN], S: [cx, r.maxZ - DOOR_IN], E: [r.maxX - DOOR_IN, cz], W: [r.minX + DOOR_IN, cz] }[r.door]!;
      expect(insideness(list, inDoor[0]!, y, inDoor[1]!)).toBeCloseTo(1, 9);
      // The outer faces of the closed walls keep the daylight.
      const back = { N: [cx, r.maxZ], S: [cx, r.minZ], E: [r.minX, cz], W: [r.maxX, cz] }[r.door]!;
      expect(insideness(list, back[0]!, y, back[1]!)).toBeLessThan(1e-6);
      // Driving out, the light changes smoothly: no step of more than 15% per 10 cm.
      let prev = insideness(list, inDoor[0]!, y, inDoor[1]!);
      for (let k = 1; k <= 30; k++) {
        const t = k / 30;
        const x = inDoor[0]! + (atDoor[0]! - inDoor[0]!) * t;
        const z = inDoor[1]! + (atDoor[1]! - inDoor[1]!) * t;
        const v = insideness(list, x, y, z);
        expect(Math.abs(v - prev)).toBeLessThan(0.15);
        prev = v;
      }
    }
    expect(interiorLight(list, 0, 1, 0)).toEqual([1, 1, 1]);
  });

  it('is patched into three\'s lighting chunks in order, with the interiors in the lit shaders\' uniforms', () => {
    new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    expect(interiorLightInstalled()).toBe(true);
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    const resolve = (s: string): string => s.replace(/#include <(\w+)>/g, (_m, name: string) => resolve(chunks[name] ?? ''));
    for (const id of ['standard', 'physical', 'lambert', 'phong', 'toon'] as const) {
      const fs = resolve(THREE.ShaderLib[id].fragmentShader);
      const def = fs.indexOf('vec3 gta7Interior(');
      const call = fs.indexOf('vec3 gta7In = gta7Interior( geometryPosition );');
      const use = fs.indexOf('irradiance *= gta7In.x;');
      expect(def, id).toBeGreaterThan(0);
      expect(call, id).toBeGreaterThan(def);
      expect(use, id).toBeGreaterThan(call);
      expect(fs.includes('directLight.color *= gta7In.y;'), id).toBe(true);
      const u = THREE.ShaderLib[id].uniforms as Record<string, THREE.IUniform>;
      expect(u.gta7InteriorCount!.value).toBe(W.layout.garages.length);
      expect((u.gta7InteriorLight!.value as THREE.Vector3).toArray()).toEqual([INTERIOR_SKY, INTERIOR_SUN, INTERIOR_REFLECT]);
      expect(INTERIOR_SKY).toBeLessThan(0.7);
    }
    // Installing again (a second renderer) does not patch twice.
    installInteriorLight(interiorsOf(W.layout.garages, (x, z) => W.groundHeight(x, z)));
    expect(chunks.lights_fragment_end!.split('gta7-interior').length).toBe(2);
  });
});

describe('street-lamp haze', () => {
  it('is off by day, on at night, and at least 1.3 times as strong in rain', () => {
    expect(hazeLevel(0, 0).gain).toBe(0);
    expect(hazeLevel(0.2, 1).gain).toBe(0);
    const clear = hazeLevel(1, 0);
    const rain = hazeLevel(1, 1);
    expect(clear.gain).toBe(1);
    expect(rain.gain / clear.gain).toBeCloseTo(HAZE_RAIN_GAIN, 6);
    expect(rain.size / clear.size).toBeCloseTo(HAZE_RAIN_SIZE, 6);
    expect(rain.gain / clear.gain).toBeGreaterThanOrEqual(1.3);
    expect(rain.size / clear.size).toBeGreaterThanOrEqual(1.3);
  });

  it('shares the lamp halos\' attributes, so every standing lamp has haze and a knocked-down one none, and is compiled by the warm-up', () => {
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    const halos = r.props.group.getObjectByName('lampHalos') as THREE.Points;
    const haze = r.lightSprites.haze.points!;
    expect(haze).toBeTruthy();
    expect(haze.geometry.getAttribute('position')).toBe(halos.geometry.getAttribute('position'));
    expect(haze.geometry.getAttribute('color')).toBe(halos.geometry.getAttribute('color'));
    const lamps = W.layout.props.filter((p) => p.kind === 'lamp').length;
    expect(haze.geometry.getAttribute('position').count).toBe(lamps);
    const index = W.layout.props.findIndex((p) => p.kind === 'lamp');
    r.props.breakProp(index, 1, 0);
    const on = haze.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect([on.getX(0), on.getY(0), on.getZ(0)]).toEqual([0, 0, 0]);
    // Day: hidden. Night: shown.
    r.lightSprites.haze.update(0, 0, 800);
    expect(haze.visible).toBe(false);
    r.lightSprites.haze.update(1, 0, 800);
    expect(haze.visible).toBe(true);
    // The warm-up compiles it although it is hidden by day.
    const seen: boolean[] = [];
    (r.renderer as unknown as { compile: () => void }).compile = () => seen.push(haze.visible);
    (r.renderer as unknown as { setRenderTarget: () => void }).setRenderTarget = () => {};
    r.lightSprites.haze.update(0, 0, 800);
    r.setQuality('medium');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(haze.visible).toBe(false);
  });
});

describe('wet-road reflections in their light\'s colour', () => {
  /** The colour of the streak LightSprites lays for one light of colour c. */
  function streakOf(c: readonly [number, number, number]): THREE.Color {
    const ls = new LightSprites();
    ls.wet = 1;
    ls.dark = 1;
    ls.begin(new THREE.Vector3(0, 1.6, 0), 800);
    ls.offerStreakLight(0, 5, 20, c[0], c[1], c[2]);
    ls.finish(() => 0);
    expect(ls.counts.streaks).toBe(1);
    const out = new THREE.Color();
    ls.streaks.getColorAt(0, out);
    return out;
  }

  it('keeps the hue (within 20 degrees) and at least half the saturation of white, sodium, tail-lamp and signal lights', () => {
    const sources: Array<[string, readonly [number, number, number]]> = [
      ['white', [1, 1, 0.96]], ['sodium', [0.65, 0.52, 0.33]], ['tail', GLOW.tail.color], ['brake', GLOW.brake.color],
      ['red', SIGNAL_STREAK.red], ['yellow', SIGNAL_STREAK.yellow], ['green', SIGNAL_STREAK.green], ['shop sign magenta', [0.9, 0.1, 0.7]],
    ];
    for (const [name, c] of sources) {
      const s = streakOf(c);
      const a = hsv(c[0], c[1], c[2]);
      const b = hsv(s.r, s.g, s.b);
      if (a.s > 0.05) expect(hueGap(a.h, b.h), name).toBeLessThanOrEqual(20);
      expect(b.s, name).toBeGreaterThanOrEqual(0.5 * a.s);
    }
  });

  it('every standing traffic signal near the camera offers its lit bulb in its colour; a knocked-down one none', () => {
    const lights = new StreetLighting(W);
    const index = W.layout.props.findIndex((p) => p.kind === 'signal');
    const p = W.layout.props[index]!;
    const offered: Array<[number, number, number, number, number, number]> = [];
    const sprites = { offerStreakLight: (...a: [number, number, number, number, number, number]) => offered.push(a) } as unknown as LightSprites;
    const cam = new THREE.Vector3(p.x + 10, 1.6, p.z);
    for (const t of [0, 7, 15, 23, 31]) {
      offered.length = 0;
      lights.offerSignalStreaks(sprites, cam, t);
      const near = offered.find((o) => Math.hypot(o[0] - p.x, o[2] - p.z) < 0.5);
      expect(near, `signal at t=${t}`).toBeTruthy();
      const col = near!.slice(3) as [number, number, number];
      expect(Object.values(SIGNAL_STREAK).some((s) => s.every((v, i) => v === col[i]))).toBe(true);
      expect(near![1]).toBeGreaterThan(p.y + 4);
    }
    const collider = W.grid.colliders[W.propColliders[index]!]!;
    collider.broken = true;
    try {
      offered.length = 0;
      lights.offerSignalStreaks(sprites, cam, 0);
      expect(offered.find((o) => Math.hypot(o[0] - p.x, o[2] - p.z) < 0.5)).toBeUndefined();
    } finally {
      collider.broken = false;
    }
  });
});

describe('contact shadows under people', () => {
  it('lays one blob per standing character within range, nearest first up to the cap, none for drivers, the dead or swimmers', () => {
    const f = new FootShadows();
    const cam = new THREE.Vector3(0, 2, 0);
    const people = [
      { id: 1, state: 'normal', pos: { x: 1, y: 0, z: 2 } },
      { id: 2, state: 'inVehicle', pos: { x: 2, y: 0, z: 2 } },
      { id: 3, state: 'dead', pos: { x: 3, y: 0, z: 2 } },
      { id: 4, state: 'swimming', pos: { x: 4, y: 0, z: 2 } },
      { id: 5, state: 'normal', pos: { x: FOOT_RANGE + 5, y: 0, z: 0 } },
      { id: 6, state: 'entering', pos: { x: 5, y: 1.2, z: 5 } },
      { id: 7, state: 'normal', pos: { x: 6, y: 0, z: 6 }, removed: true },
    ];
    f.update(people, cam);
    expect(f.count).toBe(2);
    const m = new THREE.Matrix4();
    f.mesh.getMatrixAt(1, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect(p.y).toBeCloseTo(1.22, 6);
    f.update(people, cam, 1);
    expect(f.count).toBe(1);
    const crowd = Array.from({ length: FOOT_CAPACITY + 40 }, (_, i) => ({ id: 100 + i, state: 'normal', pos: { x: (i % 20) - 10, y: 0, z: Math.floor(i / 20) * 2 } }));
    f.update(crowd, cam);
    expect(f.count).toBe(FOOT_CAPACITY);
    let farthest = 0;
    for (let i = 0; i < f.count; i++) {
      f.mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      farthest = Math.max(farthest, Math.hypot(p.x, p.z));
    }
    const kept = crowd.map((c) => Math.hypot(c.pos.x, c.pos.z)).sort((a, b) => a - b)[FOOT_CAPACITY - 1]!;
    expect(farthest).toBeLessThanOrEqual(kept + 1e-6);
    // Multiplies the frame (darkens, adds no light), drawn after the opaque scene and kept out of the GTAO depth pass.
    const mat = f.mesh.material;
    expect(mat.blending).toBe(THREE.CustomBlending);
    expect([mat.blendSrc, mat.blendDst]).toEqual([THREE.ZeroFactor, THREE.SrcColorFactor]);
    expect(mat.transparent && !mat.depthWrite).toBe(true);
  });

  it('is in the scene on every tier, software included', () => {
    for (const q of ['high', 'medium', 'low'] as const) {
      const r = new GameRenderer(canvas(), W, { quality: q, fov: 68, gpu: HDR });
      expect(r.scene.getObjectByName('foot-shadows')).toBe(r.footShadows.mesh);
    }
    const s = new GameRenderer(canvas(), W, { quality: 'low', fov: 68, gpu: SOFT });
    expect(s.software).toBe(true);
    expect(s.scene.getObjectByName('foot-shadows')).toBe(s.footShadows.mesh);
  });
});

describe('night black level and sunset grade', () => {
  it('lifts the black level at night only, without a step', () => {
    expect(gradeAt(12).lift).toBe(0);
    expect(gradeAt(9).lift).toBe(0);
    expect(gradeAt(16).lift).toBe(0);
    for (const h of [22.5, 23, 0, 3]) expect(gradeAt(h).lift).toBeCloseTo(NIGHT_LIFT, 9);
    let worst = 0;
    for (let m = 1; m <= 1440; m++) worst = Math.max(worst, Math.abs(gradeAt(m / 60).lift - gradeAt((m - 1) / 60).lift));
    expect(worst).toBeLessThan(2e-4);
  });

  it('leans the golden hour towards yellow rather than magenta, still warmer than noon', () => {
    for (const h of [18.4, 18.8, 19, 19.3]) {
      const g = gradeAt(h);
      expect(g.tint[1], `${h} h`).toBeGreaterThanOrEqual((g.tint[0] + g.tint[2]) / 2);
      expect(g.tint[0] / g.tint[2], `${h} h`).toBeGreaterThan(1);
      expect(g.sat).toBeLessThanOrEqual(gradeAt(12).sat);
    }
  });
});

describe('lighting tier table', () => {
  const tiers: LightingTier[] = ['high', 'medium', 'low', 'software'];

  it('gives every lighting feature a behaviour on every tier', () => {
    for (const [feature, row] of Object.entries(LIGHTING_TIERS)) for (const t of tiers) expect(row[t], `${feature} on ${t}`).toMatch(/\S/);
  });

  it('matches what each tier\'s renderer builds', () => {
    const post = (r: GameRenderer) => (r as unknown as { finish: { material: THREE.ShaderMaterial } | null }).finish;
    const contact = (r: GameRenderer) => (r as unknown as { contactShadows: unknown }).contactShadows;
    for (const q of ['high', 'medium', 'low'] as const) {
      const r = new GameRenderer(canvas(), W, { quality: q, fov: 68, gpu: HDR });
      expect(r.env.envSource, q).toBe('hdri');
      expect(post(r)?.material.uniforms.uLift, q).toBeTruthy();
      expect(contact(r) !== null, q).toBe(q === 'high');
      expect(r.lightSprites.haze.points, q).toBeTruthy();
      expect(interiorLightInstalled()).toBe(true);
      r.dispose();
    }
    const s = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: SOFT });
    expect(s.env.envSource).toBe('fill');
    expect(post(s)).toBeNull();
    expect(s.lightSprites.haze.points).toBeTruthy();
    expect(LIGHTING_TIERS.hdriIbl.software).toMatch(/none/);
    expect(LIGHTING_TIERS.contactShadows.high).toMatch(/GTAO/);
    expect(LIGHTING_TIERS.contactShadows.medium).not.toMatch(/GTAO/);
  });
});
