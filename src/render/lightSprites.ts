// Vehicle lights that read at night without real light sources: camera-facing lamp glows, headlight pools on the road
// ahead of lit cars, and light streaks on a wet road. Three batches, one draw call each, on every tier (software too).

import * as THREE from 'three';

/** UnrealBloomPass's luminance threshold (GameRenderer). Every glow stays under it, so bloom never toggles on one. */
export const BLOOM_THRESHOLD = 2.6;

export type GlowKind = 'head' | 'tail' | 'brake' | 'reverse' | 'sirenRed' | 'sirenBlue';

type Rgb = readonly [number, number, number];

/**
 * Each glow's colour at its centre (linear, intensity included) and its size in metres. The brake glow is 2.2 times the
 * running tail glow; reverse lamps are white.
 */
export const GLOW: Readonly<Record<GlowKind, { readonly color: Rgb; readonly size: number }>> = {
  head: { color: [1.5, 1.38, 1.1], size: 1.15 },
  tail: { color: [0.9, 0.06, 0.025], size: 0.8 },
  brake: { color: [1.98, 0.13, 0.055], size: 0.85 },
  reverse: { color: [1.1, 1.1, 1.05], size: 0.8 },
  sirenRed: { color: [3, 0.12, 0.05], size: 1.7 },
  sirenBlue: { color: [0.08, 0.35, 3.2], size: 1.7 },
};

/** One lamp's glow: its world position and the horizontal direction it shines (fx = fz = 0: all round). */
export interface LampGlow {
  kind: GlowKind;
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
}

export const GLOW_CAPACITY = 512;
export const STREAK_CAPACITY = 64;
/** Lights farther than this (m) from the camera, and ground drier than STREAK_MIN_WET, get no streak. */
export const STREAK_RANGE = 60;
const STREAK_MIN_WET = 0.01;
/** Streaks of lights nearer the camera than this (m) are faded out, full from three times as far. */
const STREAK_NEAR = 4;
/** Fixed lights (street lamps) offered for streaks in a frame. */
const LIGHT_CAPACITY = 512;
/** Glows and pools farther than this from the camera are not drawn (a few pixels, mostly fogged). */
export const GLOW_RANGE = 140;
export const POOL_RANGE = 90;
/** The headlight pool on the road: from POOL_START m ahead of the bumper, POOL_LENGTH m long, POOL_WIDTH m wide at its far end. */
export const POOL_START = 2;
export const POOL_LENGTH = 12;
export const POOL_WIDTH = 5.5;
/** A pool's colour at full strength (both head lamps, full night). */
const POOL_COLOR: Rgb = [0.5, 0.43, 0.31];
/** Glows never shrink under this many pixels, so a distant lamp does not flicker as it crosses pixel boundaries. */
const GLOW_MIN_PX = 3;
/** Depth-tested as if this much (m) nearer the camera, so the lamp's own lens does not cut into its glow. */
const GLOW_PULL = 0.3;

const FOG_FADE = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    a *= exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    a *= 1.0 - smoothstep( fogNear, fogFar, vFogDepth );
  #endif
#endif`;

const GLOW_VS = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uPixelsPerMetre;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_PointSize = max( aSize * uPixelsPerMetre / max( 0.05, - mvPosition.z ), ${GLOW_MIN_PX.toFixed(1)} );
  gl_Position = projectionMatrix * vec4( mvPosition.xyz * max( 0.0, 1.0 - ${GLOW_PULL.toFixed(2)} / length( mvPosition.xyz ) ), 1.0 );
  #include <fog_vertex>
}`;

const GLOW_FS = /* glsl */ `
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot( c, c );
  if ( r2 >= 1.0 ) discard;
  // A bright core in a soft skirt; 1 at the centre, so the centre colour is GLOW's.
  float skirt = ( 1.0 - r2 ) * ( 1.0 - r2 );
  float a = skirt * ( 0.3 + 0.7 * exp( - r2 * 9.0 ) );
  ${FOG_FADE}
  gl_FragColor = vec4( vColor * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Instanced flat decals: uv.x across, uv.y along (0 near the light, 1 far). */
const DECAL_VS = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = vec3( 1.0 );
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #endif
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const POOL_FS = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  float t = vUv.y;
  float s = abs( vUv.x - 0.5 ) * 2.0;
  // A cone opening from a third of the width at the near end, soft at its edges and both ends.
  float w = 0.32 + 0.68 * t;
  float a = ( 1.0 - smoothstep( 0.45 * w, w, s ) ) * smoothstep( 0.0, 0.22, t ) * ( 1.0 - smoothstep( 0.4, 1.0, t ) );
  ${FOG_FADE}
  gl_FragColor = vec4( vColor * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const STREAK_FS = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  float s = abs( vUv.x - 0.5 ) * 2.0;
  float t = abs( vUv.y - 0.5 ) * 2.0;
  float a = ( 1.0 - smoothstep( 0.2, 1.0, s ) ) * ( 1.0 - smoothstep( 0.3, 1.0, t ) );
  ${FOG_FADE}
  gl_FragColor = vec4( vColor * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function additive(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, uniforms]),
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

/** A unit decal on the ground plane: x across (-0.5..0.5), z along (0..1), uv.y running with z. */
function decalGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2).translate(0, 0, 0.5);
}

/** Luminance with the weights of three's bloom high pass. */
export function glowLuminance(kind: GlowKind): number {
  const w = THREE.ColorManagement.getLuminanceCoefficients(new THREE.Vector3());
  const [r, g, b] = GLOW[kind].color;
  return w.x * r + w.y * g + w.z * b;
}

/** A car offering a headlight pool: bumper position on the ground, heading, strength 0..1, squared distance to the camera. */
interface PoolCandidate {
  x: number;
  z: number;
  heading: number;
  strength: number;
  d2: number;
}

export class LightSprites {
  readonly group = new THREE.Group();
  readonly glows: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly pools: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly streaks: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Ground wetness 0..1 (set before begin): streaks are drawn only on a wet road. */
  wet = 0;
  private glowCount = 0;
  private poolCount = 0;
  private streakCount = 0;
  private poolCap = 40;
  /** Fixed lights offered this frame (offerStreakLight): x, y, z, r, g, b each. */
  private readonly lights = new Float32Array(LIGHT_CAPACITY * 6);
  private lightCount = 0;
  private readonly bestD = new Float32Array(STREAK_CAPACITY);
  private readonly bestI = new Int32Array(STREAK_CAPACITY);
  private readonly glowPos: THREE.BufferAttribute;
  private readonly glowColor: THREE.BufferAttribute;
  private readonly glowSize: THREE.BufferAttribute;
  /** Kept nearest first, at most poolCap long. */
  private readonly candidates: PoolCandidate[] = [];
  private readonly spare: PoolCandidate[] = [];
  private readonly cam = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor() {
    this.group.name = 'light-sprites';
    const geo = new THREE.BufferGeometry();
    this.glowPos = new THREE.BufferAttribute(new Float32Array(GLOW_CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.glowColor = new THREE.BufferAttribute(new Float32Array(GLOW_CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.glowSize = new THREE.BufferAttribute(new Float32Array(GLOW_CAPACITY), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.glowPos);
    geo.setAttribute('aColor', this.glowColor);
    geo.setAttribute('aSize', this.glowSize);
    geo.setDrawRange(0, 0);
    this.glows = new THREE.Points(geo, additive(GLOW_VS, GLOW_FS, { uPixelsPerMetre: { value: 800 } }));
    this.glows.name = 'lamp-glows';
    this.pools = this.decals('headlight-pools', POOL_FS, 64);
    this.streaks = this.decals('light-streaks', STREAK_FS, STREAK_CAPACITY);
    for (const o of [this.glows, this.pools, this.streaks]) {
      // Positions change every frame; the bounds would always be stale.
      o.frustumCulled = false;
      o.renderOrder = 2;
      this.group.add(o);
    }
  }

  private decals(name: string, fs: string, capacity: number): THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const mesh = new THREE.InstancedMesh(decalGeometry(), additive(DECAL_VS, fs), capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Created now so the instanced-colour variant is the one compiled at warm-up.
    mesh.setColorAt(0, this.c.setRGB(0, 0, 0));
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  }

  get counts(): { glows: number; pools: number; streaks: number } {
    return { glows: this.glowCount, pools: this.poolCount, streaks: this.streakCount };
  }

  /** The tier's cap on headlight pools (QUALITY.headlightPools). */
  setPoolCap(n: number): void {
    this.poolCap = Math.max(0, Math.min(this.pools.instanceMatrix.count, n));
  }

  get poolLimit(): number {
    return this.poolCap;
  }

  /** Starts a frame. `pixelsPerMetre`: drawing-buffer height / (2 tan(fov / 2)), a metre's size in pixels 1 m away. */
  begin(camera: THREE.Vector3, pixelsPerMetre: number): void {
    this.cam.copy(camera);
    this.glows.material.uniforms.uPixelsPerMetre!.value = pixelsPerMetre;
    this.glowCount = 0;
    this.lightCount = 0;
    for (const c of this.candidates) this.spare.push(c);
    this.candidates.length = 0;
  }

  /** Adds a lamp's glow, dimmed as it turns away from the camera; false when it is not drawn. */
  addGlow(g: LampGlow): boolean {
    if (this.glowCount >= GLOW_CAPACITY) return false;
    const dx = this.cam.x - g.x;
    const dy = this.cam.y - g.y;
    const dz = this.cam.z - g.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > GLOW_RANGE) return false;
    let k = 1;
    if (g.fx !== 0 || g.fz !== 0) {
      const h = Math.hypot(dx, dz) || 1;
      const facing = (dx * g.fx + dz * g.fz) / h;
      k = THREE.MathUtils.smoothstep(facing, -0.25, 0.35);
      if (k < 0.01) return false;
    }
    const spec = GLOW[g.kind];
    const i = this.glowCount++;
    this.glowPos.setXYZ(i, g.x, g.y, g.z);
    this.glowColor.setXYZ(i, spec.color[0] * k, spec.color[1] * k, spec.color[2] * k);
    this.glowSize.setX(i, spec.size);
    return true;
  }

  /** Offers a lit car's headlight pool; only the poolCap nearest the camera are kept. */
  offerPool(x: number, z: number, heading: number, strength: number): void {
    if (strength <= 0 || this.poolCap === 0) return;
    const d2 = (x - this.cam.x) ** 2 + (z - this.cam.z) ** 2;
    if (d2 > POOL_RANGE * POOL_RANGE) return;
    const list = this.candidates;
    if (list.length >= this.poolCap && d2 >= list[list.length - 1]!.d2) return;
    let i = list.length;
    while (i > 0 && list[i - 1]!.d2 > d2) i--;
    const c = this.spare.pop() ?? { x: 0, z: 0, heading: 0, strength: 0, d2: 0 };
    c.x = x;
    c.z = z;
    c.heading = heading;
    c.strength = strength;
    c.d2 = d2;
    list.splice(i, 0, c);
    if (list.length > this.poolCap) this.spare.push(list.pop()!);
  }

  /** Writes the frame's pools (laid on `ground`) and, on a wet road, the streaks under the nearest glows. */
  finish(ground: (x: number, z: number) => number): void {
    const glowGeo = this.glows.geometry;
    glowGeo.setDrawRange(0, this.glowCount);
    // An empty update range would upload the whole array (WebGL 2 bufferSubData reads a length of 0 as "to the end").
    if (this.glowCount > 0) for (const a of [this.glowPos, this.glowColor, this.glowSize]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.glowCount * a.itemSize);
      a.needsUpdate = true;
    }
    const pools = this.pools;
    this.candidates.forEach((c, i) => {
      const fx = Math.sin(c.heading);
      const fz = Math.cos(c.heading);
      const x0 = c.x + fx * POOL_START;
      const z0 = c.z + fz * POOL_START;
      const y0 = ground(x0, z0);
      const y1 = ground(x0 + fx * POOL_LENGTH, z0 + fz * POOL_LENGTH);
      // Follows the slope; a drop (a ramp's end, the quay) would leave the far end hanging, so it never tips down past the near end's ground.
      const pitch = -Math.atan2(Math.max(y1 - y0, -1.5), POOL_LENGTH);
      this.q.setFromEuler(this.e.set(pitch, c.heading, 0, 'YXZ'));
      this.m.compose(this.p.set(x0, y0 + 0.05, z0), this.q, this.s.set(POOL_WIDTH, 1, POOL_LENGTH));
      pools.setMatrixAt(i, this.m);
      const k = c.strength;
      pools.setColorAt(i, this.c.setRGB(POOL_COLOR[0] * k, POOL_COLOR[1] * k, POOL_COLOR[2] * k));
    });
    this.poolCount = this.candidates.length;
    pools.count = this.poolCount;
    if (this.poolCount > 0) {
      pools.instanceMatrix.needsUpdate = true;
      pools.instanceColor!.needsUpdate = true;
    }
    this.layStreaks(ground);
  }

  /**
   * Offers a fixed light (a street lamp's head) for a wet-road streak this frame: its position and linear colour. The
   * streaks go to the STREAK_CAPACITY lights nearest the camera, these and the vehicle glows together.
   */
  offerStreakLight(x: number, y: number, z: number, r: number, g: number, b: number): void {
    if (this.wet <= STREAK_MIN_WET || this.lightCount >= LIGHT_CAPACITY) return;
    const dx = x - this.cam.x;
    const dz = z - this.cam.z;
    if (dx * dx + dz * dz > STREAK_RANGE * STREAK_RANGE) return;
    const L = this.lights;
    const o = this.lightCount++ * 6;
    L[o] = x;
    L[o + 1] = y;
    L[o + 2] = z;
    L[o + 3] = r;
    L[o + 4] = g;
    L[o + 5] = b;
  }

  /** Keeps candidate `id` at squared distance d2 if it is among the STREAK_CAPACITY nearest so far. */
  private rank(id: number, d2: number, n: number): number {
    const bd = this.bestD;
    const bi = this.bestI;
    if (n >= STREAK_CAPACITY && d2 >= bd[n - 1]!) return n;
    let i = Math.min(n, STREAK_CAPACITY - 1);
    while (i > 0 && bd[i - 1]! > d2) {
      bd[i] = bd[i - 1]!;
      bi[i] = bi[i - 1]!;
      i--;
    }
    bd[i] = d2;
    bi[i] = id;
    return Math.min(n + 1, STREAK_CAPACITY);
  }

  /**
   * Wet-road reflections: a flat streak under each of the nearest lights, centred on the mirror point (h / (h + c) of
   * the way from the light's foot to the camera's, h the light's height and c the camera's) and stretched towards the
   * camera. Their brightness follows the wetness.
   */
  private layStreaks(ground: (x: number, z: number) => number): void {
    const s = this.streaks;
    let n = 0;
    if (this.wet > STREAK_MIN_WET) {
      const pos = this.glowPos.array as Float32Array;
      const cam = this.cam;
      let ranked = 0;
      for (let i = 0; i < this.glowCount; i++) {
        const d2 = (cam.x - pos[i * 3]!) ** 2 + (cam.z - pos[i * 3 + 2]!) ** 2;
        if (d2 <= STREAK_RANGE * STREAK_RANGE) ranked = this.rank(i, d2, ranked);
      }
      const L = this.lights;
      for (let j = 0; j < this.lightCount; j++) ranked = this.rank(GLOW_CAPACITY + j, (cam.x - L[j * 6]!) ** 2 + (cam.z - L[j * 6 + 2]!) ** 2, ranked);
      const col = this.glowColor.array as Float32Array;
      for (let r = 0; r < ranked; r++) {
        const id = this.bestI[r]!;
        const glow = id < GLOW_CAPACITY;
        const src = glow ? pos : L;
        const o = glow ? id * 3 : (id - GLOW_CAPACITY) * 6;
        const x = src[o]!;
        const y = src[o + 1]!;
        const z = src[o + 2]!;
        const dx = cam.x - x;
        const dz = cam.z - z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.5) continue;
        const gy = ground(x, z);
        const h = Math.max(0.05, y - gy);
        const c = Math.max(0.2, cam.y - gy);
        const t = h / (h + c);
        const length = Math.min(12, dist * 0.5, 1 + h * 5);
        const heading = Math.atan2(dx, dz);
        const mx = x + dx * t;
        const mz = z + dz * t;
        this.q.setFromEuler(this.e.set(0, heading, 0, 'YXZ'));
        this.m.compose(this.p.set(mx - (Math.sin(heading) * length) / 2, ground(mx, mz) + 0.04, mz - (Math.cos(heading) * length) / 2), this.q, this.s.set(0.55, 1, length));
        s.setMatrixAt(n, this.m);
        // Faded out close to the camera, where the mirror point runs under it and a streak would fill the view.
        const k = this.wet * 0.5 * THREE.MathUtils.smoothstep(dist, STREAK_NEAR, STREAK_NEAR * 3);
        if (glow) s.setColorAt(n, this.c.setRGB(col[o]! * k, col[o + 1]! * k, col[o + 2]! * k));
        else s.setColorAt(n, this.c.setRGB(L[o + 3]! * k, L[o + 4]! * k, L[o + 5]! * k));
        n++;
      }
    }
    this.lightCount = 0;
    this.streakCount = n;
    s.count = n;
    if (n > 0) {
      s.instanceMatrix.needsUpdate = true;
      s.instanceColor!.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const o of [this.glows, this.pools, this.streaks]) {
      o.geometry.dispose();
      o.material.dispose();
    }
    this.pools.dispose();
    this.streaks.dispose();
  }
}
