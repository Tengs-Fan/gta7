// Scorch decals: a dark soot mark draped over the ground under a blast or a fire. Each decal is a 17x17 grid laid on
// the ground's height (roads, kerbs, sidewalks, decks, sand), lifted a centimetre and depth-offset, so it hugs the
// surface without z-fighting. Grid points over water or beside a step (a kerb) drop out, so nothing floats over the
// sea or across the kerb's face. The mark multiplies what is drawn under it (wet sheen, night light and all).
// Every decal is in one geometry and one draw; a fixed cap with the oldest fading first.

import * as THREE from 'three';
import { scorchTexture } from './noise';

/** Grid points across a decal. */
export const SCORCH_GRID = 17;
/** Full strength for SCORCH_LIFE s, then a SCORCH_FADE s fade-out. */
export const SCORCH_LIFE = 26;
export const SCORCH_FADE = 4;
/** Lift above the ground (m) and the largest height step between neighbouring grid points still drawn across. */
const LIFT = 0.012;
const STEP = 0.045;

export interface ScorchGround {
  groundHeight(x: number, z: number): number;
  waterDepth?(x: number, z: number): number;
}

const VS = /* glsl */ `
attribute vec4 aInfo;
varying vec2 vUv;
varying vec4 vInfo;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vInfo = aInfo;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FS = /* glsl */ `
uniform sampler2D uMap;
uniform float uTime;
uniform float uFade;
varying vec2 vUv;
varying vec4 vInfo;
#include <fog_pars_fragment>
void main() {
  float life = clamp((uTime - vInfo.y) / 0.3, 0.0, 1.0) * clamp((vInfo.z - uTime) / uFade, 0.0, 1.0);
  vec4 t = texture2D(uMap, vUv);
  float d = t.r * vInfo.x;
  d = (1.0 - (1.0 - d) * (1.0 - d)) * life;
  if (d < 0.004) discard;
  vec3 soot = mix(vec3(0.12, 0.11, 0.1), vec3(0.015, 0.013, 0.012), t.r) * (0.85 + 0.3 * t.g);
  vec3 mult = mix(vec3(1.0), soot, d);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    mult = mix(mult, vec3(1.0), fogFactor);
  #endif
  gl_FragColor = vec4(mult, 1.0);
  // Straight to the canvas the multiplier is encoded like the colours it scales (sRGB); never tone-mapped (toneMapped
  // is off), so 1 stays 1 and the decal's clear edge leaves the ground as it was.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Slot {
  birth: number;
  death: number;
  alive: boolean;
}

export class ScorchDecals {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly pos: THREE.BufferAttribute;
  private readonly uv: THREE.BufferAttribute;
  private readonly info: THREE.BufferAttribute;
  private readonly time: { value: number };
  private readonly slots: Slot[] = [];
  private readonly heights = new Float32Array(SCORCH_GRID * SCORCH_GRID);
  private cap: number;
  private now = 0;
  /** Decals placed since the session began (debug, tests). */
  placed = 0;

  constructor(readonly max: number) {
    const per = SCORCH_GRID * SCORCH_GRID;
    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(max * per * 3).fill(-1e4), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(max * per * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.info = new THREE.BufferAttribute(new Float32Array(max * per * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('uv', this.uv);
    this.geo.setAttribute('aInfo', this.info);
    const cells = SCORCH_GRID - 1;
    const index = new Uint32Array(max * cells * cells * 6);
    let k = 0;
    for (let d = 0; d < max; d++) {
      const o = d * per;
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          const a = o + j * SCORCH_GRID + i;
          const b = a + 1;
          const c = a + SCORCH_GRID;
          const e = c + 1;
          index.set([a, c, b, b, c, e], k);
          k += 6;
        }
      }
    }
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    // Placed anywhere in the world: never culled as a whole.
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const map = scorchTexture();
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    const mat = new THREE.ShaderMaterial({
      name: 'fx-scorch',
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uTime: { value: 0 }, uFade: { value: SCORCH_FADE } }]),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      fog: true,
      toneMapped: false,
    });
    mat.uniforms.uMap!.value = map;
    this.time = mat.uniforms.uTime as { value: number };
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'fx-scorch';
    for (let i = 0; i < max; i++) this.slots.push({ birth: 0, death: 0, alive: false });
    this.cap = max;
  }

  setCap(cap: number): void {
    this.cap = Math.max(1, Math.min(this.max, cap));
    // Over a lowered cap the oldest go first.
    while (this.live > this.cap) this.kill(this.oldest()!);
  }

  get capacity(): number {
    return this.cap;
  }

  get live(): number {
    let n = 0;
    for (const s of this.slots) if (s.alive) n++;
    return n;
  }

  /** Birth and death times (s, on this view's clock) of the live decals, oldest first. */
  lives(): Array<{ birth: number; death: number }> {
    return this.slots.filter((s) => s.alive).map((s) => ({ birth: s.birth, death: s.death })).sort((a, b) => a.birth - b.birth);
  }

  get clock(): number {
    return this.now;
  }

  private oldest(): number | null {
    let best: number | null = null;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.alive && (best === null || s.birth < this.slots[best]!.birth)) best = i;
    }
    return best;
  }

  private kill(i: number): void {
    const s = this.slots[i]!;
    s.alive = false;
    const per = SCORCH_GRID * SCORCH_GRID;
    const arr = this.pos.array as Float32Array;
    arr.fill(-1e4, i * per * 3, (i + 1) * per * 3);
    this.pos.addUpdateRange(i * per * 3, per * 3);
    this.pos.needsUpdate = true;
  }

  /**
   * A scorch `radius` m round (the mark's outer edge) at (x, z) with darkness `strength` 0..1, its grain turned by
   * `angle`. Nothing is laid over water.
   */
  add(x: number, z: number, radius: number, strength: number, angle: number, ground: ScorchGround): boolean {
    if (!Number.isFinite(x + z + radius) || !(radius > 0)) return false;
    if ((ground.waterDepth?.(x, z) ?? -1) > 0) return false;
    let slot = this.slots.findIndex((s, i) => !s.alive && i < this.cap);
    if (slot < 0) {
      slot = this.oldest()!;
      this.kill(slot);
    }
    const s = this.slots[slot]!;
    s.alive = true;
    s.birth = this.now;
    s.death = this.now + SCORCH_LIFE + SCORCH_FADE;
    const G = SCORCH_GRID;
    const per = G * G;
    const h = this.heights;
    const wet = new Uint8Array(per);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const wx = x + (i / (G - 1) - 0.5) * 2 * radius;
        const wz = z + (j / (G - 1) - 0.5) * 2 * radius;
        h[j * G + i] = ground.groundHeight(wx, wz);
        wet[j * G + i] = (ground.waterDepth?.(wx, wz) ?? -1) > 0 ? 1 : 0;
      }
    }
    const p = this.pos.array as Float32Array;
    const u = this.uv.array as Float32Array;
    const inf = this.info.array as Float32Array;
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const k = j * G + i;
        const v = slot * per + k;
        const hk = h[k]!;
        // A step to any neighbour (a kerb) or water drops the point out.
        let step = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= G || nj >= G) continue;
          step = Math.max(step, Math.abs(h[nj * G + ni]! - hk));
        }
        const a = wet[k] || step > STEP ? 0 : strength;
        p[v * 3] = x + (i / (G - 1) - 0.5) * 2 * radius;
        p[v * 3 + 1] = hk + LIFT;
        p[v * 3 + 2] = z + (j / (G - 1) - 0.5) * 2 * radius;
        const lu = i / (G - 1) - 0.5;
        const lv = j / (G - 1) - 0.5;
        u[v * 2] = 0.5 + lu * c - lv * sn;
        u[v * 2 + 1] = 0.5 + lu * sn + lv * c;
        inf[v * 4] = a;
        inf[v * 4 + 1] = s.birth;
        inf[v * 4 + 2] = s.death;
        inf[v * 4 + 3] = 0;
      }
    }
    for (const [attr, n] of [[this.pos, 3], [this.uv, 2], [this.info, 4]] as const) {
      attr.addUpdateRange(slot * per * n, per * n);
      attr.needsUpdate = true;
    }
    this.placed++;
    // At the cap the oldest starts fading now, so it is gone gently before it would have to be dropped.
    if (this.live >= this.cap) this.fadeOldest();
    return true;
  }

  private fadeOldest(): void {
    let best: number | null = null;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (!s.alive || s.death <= this.now + SCORCH_FADE) continue;
      if (best === null || s.birth < this.slots[best]!.birth) best = i;
    }
    if (best === null) return;
    const s = this.slots[best]!;
    s.death = this.now + SCORCH_FADE;
    const per = SCORCH_GRID * SCORCH_GRID;
    const inf = this.info.array as Float32Array;
    for (let k = 0; k < per; k++) inf[(best * per + k) * 4 + 2] = s.death;
    this.info.addUpdateRange(best * per * 4, per * 4);
    this.info.needsUpdate = true;
  }

  update(dt: number): void {
    this.now += Math.max(0, dt);
    this.time.value = this.now;
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i]!.alive && this.slots[i]!.death <= this.now) this.kill(i);
  }

  clear(): void {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i]!.alive) this.kill(i);
    this.now = 0;
    this.time.value = 0;
    this.placed = 0;
  }
}
