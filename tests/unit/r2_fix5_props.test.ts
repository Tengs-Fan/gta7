// Fix pass 5, props: street lamps glow by themselves (their own halos, as the Ferris wheel's lights have), so their glow no
// longer blinks on and off with the bloom pass catching a 1-2 px bulb; and the Ferris wheel is drawn as the world is solid:
// legs that stand in the sea and meet the hub, gondolas high enough over the open deck for a bus, posts on the drawn legs.
// The render modules run headless with the canvas/WebGL stubs of fix_render.test.ts.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LAMP_HEAD, PropsView } from '../../src/render/props';
import { GameRenderer } from '../../src/render/renderer';
import { VEHICLE_SPECS } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import type { Prop } from '../../src/world/layout';
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
    // Every other 2D call is a no-op; property writes are kept.
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
    readonly capabilities = { getMaxAnisotropy: () => 16 };
    readonly xr = { enabled: false };
    readonly coordinateSystem = actual.WebGLCoordinateSystem;
    autoClear = true;
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas ?? new EventTarget();
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    compile(): void {}
    getRenderTarget(): unknown {
      return null;
    }
    setRenderTarget(): void {}
    getActiveCubeFace(): number {
      return 0;
    }
    getActiveMipmapLevel(): number {
      return 0;
    }
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

/** The bloom pass's threshold (render/renderer.ts) and its luminance weights (three's LuminosityHighPassShader). */
const BLOOM_THRESHOLD = 2.6;
const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

type PropsPriv = { poolMat: THREE.MeshBasicMaterial; bulbMat: THREE.MeshBasicMaterial; ferris: { gondolas: THREE.InstancedMesh; y: number } };
const priv = (p: PropsView): PropsPriv => p as unknown as PropsPriv;

/** A lamp prop's lens centre in world space (render/props.ts buildLamps: a 2.5 cm plate with its underside at LAMP_HEAD). */
function bulbOf(p: Prop): THREE.Vector3 {
  const { y, reach } = LAMP_HEAD;
  return new THREE.Vector3(p.x + Math.sin(p.rot) * reach * p.scale, p.y + (y + 0.0125) * p.scale, p.z + Math.cos(p.rot) * reach * p.scale);
}

describe('street lamps glow by themselves', () => {
  let props: PropsView;
  let lamps: number[];
  let halos: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  beforeAll(() => {
    props = new PropsView(world());
    lamps = world()
      .layout.props.map((p, i) => (p.kind === 'lamp' ? i : -1))
      .filter((i) => i >= 0);
    halos = props.group.getObjectByName('lampHalos') as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  });

  it('one halo per lamp, just under its bulb', () => {
    expect(halos, 'a lampHalos Points').toBeInstanceOf(THREE.Points);
    expect(lamps.length).toBeGreaterThan(500);
    const pos = halos.geometry.getAttribute('position');
    expect(pos.count).toBe(lamps.length);
    const L = world().layout.props;
    const bad: string[] = [];
    lamps.forEach((pi, k) => {
      const b = bulbOf(L[pi]!);
      const h = new THREE.Vector3().fromBufferAttribute(pos, k);
      // Centred under the bulb's middle, a few cm below its lower face (6.27 m), so the lamp head cannot cut into it.
      if (Math.hypot(h.x - b.x, h.z - b.z) > 0.01 || b.y - h.y < 0.04 || b.y - h.y > 0.15) bad.push(`lamp ${pi}: halo at ${h.toArray().map((a) => a.toFixed(2))}, bulb at ${b.toArray().map((a) => a.toFixed(2))}`);
    });
    expect(bad).toEqual([]);
  });

  it('at night the halos are drawn, at least 3 px across, and bulb and halo stay under the bloom threshold', () => {
    props.update(3, 1, 0);
    expect(halos.visible).toBe(true);
    const m = halos.material;
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthWrite).toBe(false);
    expect(m.sizeAttenuation).toBe(true);
    expect(m.size).toBeGreaterThan(1);
    expect(m.size).toBeLessThan(2.5);
    // The lamp pools' glow texture, on the GPU from the first frame.
    expect(m.map).toBe(priv(props).poolMat.map);
    expect(lum(m.color)).toBeGreaterThan(0.3);
    // The bulb with its halo's centre added on top: under the bloom threshold on every channel, so that bloom no longer
    // switches on and off with the bulb's sub-pixel position.
    const top = priv(props).bulbMat.color.clone().add(m.color);
    expect(Math.max(top.r, top.g, top.b)).toBeLessThan(BLOOM_THRESHOLD);
    // Still a bright light where it is drawn (ACES takes it to a near-white core).
    expect(lum(priv(props).bulbMat.color)).toBeGreaterThan(1);
    // Never under 3 px on screen: the point size floor patched into the vertex shader.
    const shader = { vertexShader: THREE.ShaderLib.points.vertexShader, fragmentShader: THREE.ShaderLib.points.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('#include <fog_vertex>\ngl_PointSize = max( gl_PointSize, 3.0 );');
    // Depth-tested a little nearer the camera than the bulb, so the lamp's own head does not cut a dark band through it.
    expect(shader.vertexShader).toMatch(/gl_Position = projectionMatrix \* vec4\( mvPosition\.xyz \* max\( 0\.0, 1\.0 - 0\.\d+ \/ length\( mvPosition\.xyz \) \), 1\.0 \);\s*}\s*$/);
    // Dusk: dimmer, still drawn.
    const full = lum(m.color);
    props.update(3, 0.3, 0);
    expect(halos.visible).toBe(true);
    expect(lum(m.color)).toBeCloseTo(0.3 * full, 6);
    // By day they are not drawn.
    props.update(3, 0, 0);
    expect(halos.visible).toBe(false);
  });

  it('on every quality tier, with or without bloom', () => {
    const r = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, world(), { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: true } });
    const h = r.props.group.getObjectByName('lampHalos') as THREE.Points;
    expect(h).toBeTruthy();
    for (const tier of ['high', 'medium', 'low'] as const) {
      r.setQuality(tier);
      r.props.update(3, 1, 0);
      expect(h.visible, tier).toBe(true);
    }
  });

  it('a knocked-over lamp\'s halo goes dark, and a new game lights it again', () => {
    const c = halos.geometry.getAttribute('color');
    const k = 7;
    props.breakProp(lamps[k]!, 1, 0);
    for (let i = 0; i < lamps.length; i++) {
      const v = c.getX(i) + c.getY(i) + c.getZ(i);
      if (i === k) expect(v).toBe(0);
      else expect(v).toBe(3);
    }
    props.restoreAll();
    for (let i = 0; i < lamps.length; i++) expect(c.getX(i) + c.getY(i) + c.getZ(i)).toBe(3);
  });
});

describe('the Ferris wheel as drawn', () => {
  let props: PropsView;
  let f: Prop;
  let deckY: number;
  beforeAll(() => {
    props = new PropsView(world());
    props.group.updateMatrixWorld(true);
    f = world().layout.props.find((p) => p.kind === 'ferris')!;
    deckY = world().layout.decks.find((d) => d.name === 'Azura Pier')!.y;
  });

  it('its gondolas pass high enough over the open deck for a bus', () => {
    const g = priv(props).ferris.gondolas;
    g.geometry.computeBoundingBox();
    const bottom = g.geometry.boundingBox!.min.y;
    const m = new THREE.Matrix4();
    const at = new THREE.Vector3();
    let lowest = Infinity;
    // A gondola comes round every 2 PI / 16 of a turn, at 0.06 rad/s: 6.5 s.
    for (let t = 0; t < 7; t += 0.05) {
      props.update(t, 0, 0);
      for (let i = 0; i < g.count; i++) {
        g.getMatrixAt(i, m);
        at.setFromMatrixPosition(m);
        lowest = Math.min(lowest, at.y + bottom);
      }
    }
    expect(lowest - deckY).toBeGreaterThan(VEHICLE_SPECS.bus.height + 0.5);
  });

  /** Each leg's axis (its end faces' middles) in world space: four boxes of 36 vertices in the merged leg mesh. */
  function legAxes(): Array<{ bottom: THREE.Vector3; top: THREE.Vector3 }> {
    // The one plain mesh standing at the prop's own position and height.
    const legs = props.group.children.find((o) => o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh) && o.position.distanceTo(new THREE.Vector3(f.x, f.y, f.z)) < 1e-6) as THREE.Mesh;
    expect(legs, 'the legs').toBeInstanceOf(THREE.Mesh);
    legs.updateMatrixWorld(true);
    const pos = legs.geometry.getAttribute('position');
    expect(pos.count).toBe(4 * 36);
    const out: Array<{ bottom: THREE.Vector3; top: THREE.Vector3 }> = [];
    for (let l = 0; l < 4; l++) {
      const pts: THREE.Vector3[] = [];
      for (let i = l * 36; i < (l + 1) * 36; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(legs.matrixWorld));
      pts.sort((a, b) => a.y - b.y);
      const mid = (list: THREE.Vector3[]) => list.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / list.length);
      // The 4 corners of each end face come 6 times each over the 12 triangles of a box.
      out.push({ bottom: mid(pts.slice(0, 12)), top: mid(pts.slice(-12)) });
    }
    return out;
  }

  it('its legs meet the hub and stand in the sea, beside the deck', () => {
    const hubY = priv(props).ferris.y;
    const deck = world().layout.decks.find((d) => d.name === 'Azura Pier')!.rect;
    const bad: string[] = [];
    for (const { bottom, top } of legAxes()) {
      // The wheel turns on an axle along the pier (x) at the hub's height: each leg's top on that line, at the axle's end.
      if (Math.abs(top.z - f.z) > 0.3 || Math.abs(top.y - hubY) > 0.3 || Math.abs(Math.abs(top.x - f.x) - 3.2) > 0.3) bad.push(`top at ${top.toArray().map((a) => a.toFixed(2))}`);
      // Its foot under the water, off the deck.
      if (bottom.y > WATER_Y - 1 || (bottom.z > deck.minZ && bottom.z < deck.maxZ)) bad.push(`foot at ${bottom.toArray().map((a) => a.toFixed(2))}`);
    }
    expect(bad).toEqual([]);
    // The axle reaches out to the legs.
    const wheel = (props as unknown as { ferris: { wheel: THREE.Group } }).ferris.wheel;
    const rim = wheel.children.find((o) => o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) as THREE.Mesh;
    rim.geometry.computeBoundingBox();
    expect(rim.geometry.boundingBox!.max.z).toBeGreaterThan(3.2 + 0.25);
  });

  it('the world\'s posts stand on the drawn legs where they meet the water, through a swimmer\'s band', () => {
    const posts = world().grid.colliders.filter((c) => c.tag === 'pillar' && Math.abs(c.cx - f.x) < 8 && Math.abs(c.cz - f.z) < 20);
    expect(posts.length).toBe(4);
    const bad: string[] = [];
    for (const { bottom, top } of legAxes()) {
      // A swimmer's body: from his feet 1.3 m under the surface, 0.35 m up, to his head 0.5 m over it.
      for (let y = WATER_Y - 0.95; y <= WATER_Y + 0.5; y += 0.05) {
        const t = (y - bottom.y) / (top.y - bottom.y);
        const x = bottom.x + (top.x - bottom.x) * t;
        const z = bottom.z + (top.z - bottom.z) * t;
        const near = Math.min(...posts.map((c) => Math.hypot(c.cx - x, c.cz - z) - c.r));
        if (near > 0) bad.push(`the leg at y ${y.toFixed(2)} (${x.toFixed(2)}, ${z.toFixed(2)}) is ${near.toFixed(2)} m outside its post`);
      }
    }
    expect(bad).toEqual([]);
  });
});
