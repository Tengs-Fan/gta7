// Volume puffs: camera-facing quads shaded with tileable noise into billowing, self-shadowed lumps that burn (an HDR
// temperature ramp) or smoke (a lit, dark albedo). One instanced draw for every fireball, flame and smoke puff, drawn
// back to front with premultiplied alpha so hot cores glow while cool smoke occludes. Puffs fade where they meet the
// ground and when the eye is inside them, so a plume shows no hard line against the road.

import * as THREE from 'three';
import { puffNoiseTexture } from './noise';

const VS = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iParam;
attribute vec4 iTint;
varying vec2 vUv;
varying vec4 vParam;
varying vec3 vTint;
varying float vAbove;
varying float vNear;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vParam = iParam;
  vTint = iTint.rgb;
  float size = iPos.w;
  vec4 mvPosition = modelViewMatrix * vec4(iPos.xyz, 1.0);
  float c = cos(iParam.x);
  float s = sin(iParam.x);
  vec2 q = position.xy * size;
  vec2 r = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  mvPosition.xy += r;
  // World height of this corner: the quad lies in the view plane (camera right and up are viewMatrix rows).
  float wy = iPos.y + r.x * viewMatrix[1][0] + r.y * viewMatrix[1][1];
  vAbove = (wy - iTint.w) / max(size * 0.3, 0.05);
  vNear = -mvPosition.z / max(size, 0.05);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FS = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uLight;
uniform float uFire;
varying vec2 vUv;
varying vec4 vParam;
varying vec3 vTint;
varying float vAbove;
varying float vNear;
#include <fog_pars_fragment>
vec3 fireRamp(float t) {
  vec3 c = mix(vec3(0.0), vec3(0.55, 0.06, 0.01), smoothstep(0.0, 0.3, t));
  c = mix(c, vec3(1.0, 0.3, 0.035), smoothstep(0.25, 0.55, t));
  c = mix(c, vec3(1.0, 0.68, 0.22), smoothstep(0.5, 0.85, t));
  return mix(c, vec3(1.0, 0.93, 0.78), smoothstep(0.85, 1.15, t));
}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float seed = vParam.w;
  vec2 o = vec2(fract(seed * 13.17), fract(seed * 7.73));
  vec4 a = texture2D(uNoise, vUv * 0.55 + o);
  vec4 b = texture2D(uNoise, vUv * 1.3 + o.yx * 1.7);
  float n = a.r * 0.6 + b.g * 0.4;
  // A lumpy outline: the radius pushed in and out by the noise.
  float shape = 1.0 - r + (n - 0.5) * 0.85 + (a.a - 0.5) * 0.3;
  // Never cut by the quad's circle: the density always falls to 0 before r = 1.
  float dens = smoothstep(0.02, 0.38, shape) * smoothstep(1.0, 0.72, r);
  float cover = dens * vParam.z * clamp(vAbove, 0.0, 1.0) * smoothstep(0.15, 0.6, vNear);
  if (cover < 0.003) discard;
  // Lit from above: the quad's up on screen in texture space is (sin rot, cos rot).
  vec2 up = vec2(sin(vParam.x), cos(vParam.x));
  float shade = 0.5 + 0.5 * clamp(dot(p, up) * 0.55 + 0.45 + (n - 0.5) * 0.7, 0.0, 1.0);
  float heat = vParam.y;
  float t = heat * (0.3 + 0.95 * n + 0.3 * b.b) * (1.0 - 0.5 * r);
  float hot = smoothstep(0.08, 0.5, t);
  vec3 smoke = vTint * shade * uLight;
  vec3 col = mix(smoke, fireRamp(t) * (0.9 + 3.2 * t * t) * uFire, hot);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
  // Premultiplied: fire a little see-through, smoke opaque where dense.
  gl_FragColor = vec4(gl_FragColor.rgb * cover, cover * mix(1.0, 0.7, hot));
}`;

/** What a puff is, for the counters (Effects.stats). */
export const PuffKind = { Flame: 0, Smoke: 1, Dust: 2 } as const;
export type PuffKind = (typeof PuffKind)[keyof typeof PuffKind];

/** One puff to draw this frame (fireballs are computed, not simulated, and hand theirs over through `push`). */
export interface PuffDraw {
  x: number;
  y: number;
  z: number;
  size: number;
  rot: number;
  heat: number;
  alpha: number;
  seed: number;
  r: number;
  g: number;
  b: number;
  ground: number;
}

export class PuffLayer {
  readonly mesh: THREE.Mesh;
  readonly light: THREE.Color;
  private readonly fire: { value: number };
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly iPos: Float32Array;
  private readonly iParam: Float32Array;
  private readonly iTint: Float32Array;
  // Simulated puffs.
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly h0: Float32Array;
  private readonly h1: Float32Array;
  private readonly a0: Float32Array;
  private readonly col: Float32Array;
  private readonly seed: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;
  private readonly ground: Float32Array;
  private readonly kind: Uint8Array;
  private readonly fresh: Uint8Array;
  private next = 0;
  /** How many simulated puffs may be alive (the tier's cap, at most `max`). */
  private cap: number;
  // Per-frame draw list (simulated + pushed), sorted back to front.
  private readonly order: Uint32Array;
  private readonly depth: Float32Array;
  private readonly extra: PuffDraw[] = [];
  private extraCount = 0;
  /** Drawn this frame, by kind; and pushed (fireball) puffs. */
  readonly counts = { flame: 0, smoke: 0, dust: 0, fireball: 0, total: 0 };

  constructor(readonly max: number, readonly maxExtra: number) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.setAttribute('uv', base.getAttribute('uv'));
    const n = max + maxExtra;
    this.iPos = new Float32Array(n * 4);
    this.iParam = new Float32Array(n * 4);
    this.iTint = new Float32Array(n * 4);
    this.geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.iPos, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iParam', new THREE.InstancedBufferAttribute(this.iParam, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iTint', new THREE.InstancedBufferAttribute(this.iTint, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      name: 'fx-puffs',
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uNoise: { value: null }, uLight: { value: new THREE.Color(1, 1, 1) }, uFire: { value: 1 } }]),
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      fog: true,
    });
    mat.uniforms.uNoise!.value = puffNoiseTexture();
    this.light = mat.uniforms.uLight!.value as THREE.Color;
    this.fire = mat.uniforms.uFire as { value: number };
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'fx-puffs';
    const f = () => new Float32Array(max);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.life = f();
    this.maxLife = f();
    this.s0 = f();
    this.s1 = f();
    this.h0 = f();
    this.h1 = f();
    this.a0 = f();
    this.col = new Float32Array(max * 3);
    this.seed = f();
    this.rot = f();
    this.spin = f();
    this.drag = f();
    this.grav = f();
    this.ground = f();
    this.kind = new Uint8Array(max);
    this.fresh = new Uint8Array(max);
    this.order = new Uint32Array(n);
    this.depth = new Float32Array(n);
    this.cap = max;
    for (let i = 0; i < maxExtra; i++) this.extra.push({ x: 0, y: 0, z: 0, size: 0, rot: 0, heat: 0, alpha: 0, seed: 0, r: 0, g: 0, b: 0, ground: 0 });
  }

  /** The tier's cap on simulated puffs; puffs past a lowered cap go at once. */
  setCap(cap: number): void {
    this.cap = Math.max(1, Math.min(this.max, cap));
    for (let i = this.cap; i < this.max; i++) this.life[i] = 0;
    if (this.next >= this.cap) this.next = 0;
  }

  get capacity(): number {
    return this.cap;
  }

  /** Brightness of the flames: 1 with an HDR target (bloom), lower when drawn straight to the 8-bit canvas. */
  setFireGain(k: number): void {
    this.fire.value = k;
  }

  /**
   * A simulated puff: size s0 -> s1 and heat h0 -> h1 over its life, opacity `alpha`, albedo `color` (sRGB hex, lit by
   * the scene light), `grav` > 0 pulls down (negative: buoyant), `ground` is the height its bottom fades out at.
   */
  emit(kind: PuffKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, h0: number, h1: number, alpha: number, color: THREE.Color, seed: number, rot: number, spin: number, drag: number, grav: number, ground: number): void {
    if (life <= 0) return;
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.h0[i] = h0;
    this.h1[i] = h1;
    this.a0[i] = alpha;
    this.col[i * 3] = color.r;
    this.col[i * 3 + 1] = color.g;
    this.col[i * 3 + 2] = color.b;
    this.seed[i] = seed;
    this.rot[i] = rot;
    this.spin[i] = spin;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.ground[i] = ground;
    this.kind[i] = kind;
    this.fresh[i] = 1;
  }

  /** A computed puff for this frame only (fireballs); dropped past `maxExtra`. */
  push(): PuffDraw | null {
    return this.extraCount < this.maxExtra ? this.extra[this.extraCount++]! : null;
  }

  /** Simulated puffs alive now. */
  get active(): number {
    let n = 0;
    for (let i = 0; i < this.max; i++) if (this.life[i]! > 0) n++;
    return n;
  }

  /** Ages the simulated puffs, then writes them with this frame's pushed ones, sorted back to front from `eye`. */
  update(dt: number, eye: THREE.Vector3 | null): void {
    const c = this.counts;
    c.flame = c.smoke = c.dust = 0;
    let n = 0;
    const ex = eye?.x ?? 0;
    const ey = eye?.y ?? 0;
    const ez = eye?.z ?? 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i]! <= 0) continue;
      let step = dt;
      if (this.fresh[i] && dt > 0) {
        this.fresh[i] = 0;
        step = Math.min(dt, this.maxLife[i]! * 0.1);
      }
      this.life[i] = this.life[i]! - step;
      if (this.life[i]! <= 0) continue;
      const k = Math.exp(-this.drag[i]! * step);
      this.vx[i] = this.vx[i]! * k;
      this.vy[i] = this.vy[i]! * k - this.grav[i]! * step;
      this.vz[i] = this.vz[i]! * k;
      this.px[i] = this.px[i]! + this.vx[i]! * step;
      this.py[i] = this.py[i]! + this.vy[i]! * step;
      this.pz[i] = this.pz[i]! + this.vz[i]! * step;
      this.rot[i] = this.rot[i]! + this.spin[i]! * step;
      const t = 1 - this.life[i]! / this.maxLife[i]!;
      const o = n * 4;
      // Grows fast at first and slower later (smoke billowing out), whatever the sizes.
      const g = 1 - (1 - t) * (1 - t);
      this.iPos[o] = this.px[i]!;
      this.iPos[o + 1] = this.py[i]!;
      this.iPos[o + 2] = this.pz[i]!;
      this.iPos[o + 3] = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * g;
      this.iParam[o] = this.rot[i]!;
      this.iParam[o + 1] = this.h0[i]! + (this.h1[i]! - this.h0[i]!) * t;
      // Quick fade in, long fade out.
      this.iParam[o + 2] = this.a0[i]! * Math.min(1, t * 12) * (1 - t) * (1 + t);
      this.iParam[o + 3] = this.seed[i]!;
      this.iTint[o] = this.col[i * 3]!;
      this.iTint[o + 1] = this.col[i * 3 + 1]!;
      this.iTint[o + 2] = this.col[i * 3 + 2]!;
      this.iTint[o + 3] = this.ground[i]!;
      const kd = this.kind[i]!;
      if (kd === PuffKind.Flame) c.flame++;
      else if (kd === PuffKind.Smoke) c.smoke++;
      else c.dust++;
      n++;
    }
    for (let j = 0; j < this.extraCount; j++) {
      const p = this.extra[j]!;
      if (!(p.alpha > 0.002) || !(p.size > 0)) continue;
      const o = n * 4;
      this.iPos[o] = p.x;
      this.iPos[o + 1] = p.y;
      this.iPos[o + 2] = p.z;
      this.iPos[o + 3] = p.size;
      this.iParam[o] = p.rot;
      this.iParam[o + 1] = p.heat;
      this.iParam[o + 2] = p.alpha;
      this.iParam[o + 3] = p.seed;
      this.iTint[o] = p.r;
      this.iTint[o + 1] = p.g;
      this.iTint[o + 2] = p.b;
      this.iTint[o + 3] = p.ground;
      n++;
    }
    c.fireball = n - c.flame - c.smoke - c.dust;
    c.total = n;
    this.extraCount = 0;
    if (eye && n > 1) this.sort(n, ex, ey, ez);
    this.geo.instanceCount = n;
    (this.geo.getAttribute('iPos') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('iParam') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('iTint') as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /** Reorders the first n instances far to near (blending needs it). */
  private sort(n: number, ex: number, ey: number, ez: number): void {
    const order = this.order;
    const depth = this.depth;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      depth[i] = -((this.iPos[o]! - ex) ** 2 + (this.iPos[o + 1]! - ey) ** 2 + (this.iPos[o + 2]! - ez) ** 2);
      order[i] = i;
    }
    const sub = order.subarray(0, n);
    sub.sort((a, b) => depth[a]! - depth[b]!);
    // Permute in place through a scratch copy of the three attributes.
    const tmp = scratch(n * 12);
    for (let i = 0; i < n; i++) {
      const s = sub[i]! * 4;
      const d = i * 12;
      for (let k = 0; k < 4; k++) {
        tmp[d + k] = this.iPos[s + k]!;
        tmp[d + 4 + k] = this.iParam[s + k]!;
        tmp[d + 8 + k] = this.iTint[s + k]!;
      }
    }
    for (let i = 0; i < n; i++) {
      const d = i * 4;
      const s = i * 12;
      for (let k = 0; k < 4; k++) {
        this.iPos[d + k] = tmp[s + k]!;
        this.iParam[d + k] = tmp[s + 4 + k]!;
        this.iTint[d + k] = tmp[s + 8 + k]!;
      }
    }
  }

  clear(): void {
    this.life.fill(0);
    this.fresh.fill(0);
    this.next = 0;
    this.extraCount = 0;
    this.geo.instanceCount = 0;
    const c = this.counts;
    c.flame = c.smoke = c.dust = c.fireball = c.total = 0;
  }
}

let scratchBuf = new Float32Array(0);
function scratch(n: number): Float32Array {
  if (scratchBuf.length < n) scratchBuf = new Float32Array(n);
  return scratchBuf;
}
