// Particles (instanced billboards), bullet tracers, skid marks, flash lights and rockets in flight.

import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { Character, Projectile, Vehicle } from '../sim/entities';
import type { WeaponId } from '../sim/specs';

/** Muzzle flash size (m, across the star) per weapon. */
export const FLASH_SIZE: Readonly<Record<WeaponId, number>> = { fists: 0, pistol: 0.3, smg: 0.32, rifle: 0.4, shotgun: 0.55, rocket: 0.6 };
/** The muzzle light's intensity per metre of flash, and its cap (a shotgun used to white the screen out). */
const FLASH_LIGHT = 55;
const FLASH_LIGHT_MAX = 30;
/** How long a muzzle flash (its sprites and its light) lasts (s). */
const FLASH_LIFE = 0.05;
/**
 * The muzzle light shines from this far ahead of the barrel tip along the shot, out in the flash's plume:
 * at the tip itself it sat a hand's breadth from the shooter's face.
 */
const FLASH_LIGHT_AHEAD = 0.6;
/** ...but stays this far short of the first thing the shot hits (Effects.shotLanded), so a wall in front of the gun is lit. */
const FLASH_LIGHT_CLEAR = 0.15;
/**
 * Most light the flash may throw on the shooter's own head (irradiance; the noon sun gives 3.3).
 * The light is dimmed to keep under it, so a short gun held close to the face does not burn the head out to white.
 */
const FLASH_HEAD_LIGHT = 6;

/** Which way a shot went and who fired it, for placing its muzzle light (a 'weaponFired' event fits). */
export interface FlashAim {
  dx: number;
  dy: number;
  dz: number;
  shooter: Character | null;
}

/** Where a shooter's head is, near enough for lighting: over his feet when standing, over his seat when riding. */
function headOf(c: Character): { x: number; y: number; z: number } {
  return { x: c.pos.x, y: c.pos.y + c.height * (c.vehicle ? 0.55 : 0.9), z: c.pos.z };
}

/**
 * Tracer streak: its head flies at TRACER_SPEED (m/s), the tail TRACER_STREAK (m) behind.
 * On the frame it is fired the streak reaches TRACER_REACH of the way to the hit (TRACER_REACH_MAX m at most):
 * a shot seen from behind the shooter runs almost straight away from the view, and only a streak over most of its
 * path shows on screen (from the hip camera a 3 m one is a few pixels). That long streak stays up for TRACER_HOLD
 * (s, about two frames) before its tail leaves the muzzle; its head waits there until the tail has caught up to the
 * usual streak, which flies on.
 * Ribbons are TRACER_WIDTH (m) wide, but never under TRACER_MIN_PX pixels.
 */
const TRACER_SPEED = 300;
const TRACER_STREAK = 3;
const TRACER_HOLD = 0.03;
const TRACER_REACH = 0.8;
const TRACER_REACH_MAX = 20;
const TRACER_WIDTH = 0.03;
const TRACER_MIN_PX = 1.5;
/** HDR orange, far above the bloom threshold. */
const TRACER_COLOR = new THREE.Color(6, 3, 1);
/**
 * Grinding sparks: streaks this many times longer than wide along their flight, born at full strength this many times
 * brighter than white-hot (past the renderer's 2.6 bloom threshold, so they glow) before they cool to a bright orange.
 */
const SPARK_STRETCH = 6;
const SPARK_GLOW = 3.5;
const SPARK_STYLE: EmitStyle = { align: true, glow: SPARK_GLOW, glowEnd: 1.5, instant: true };

const PARTICLE_VS = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec3 iSizeRot;
#ifdef ALIGN
attribute vec4 iVel;
#endif
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = iColor;
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  // iSizeRot: size (the long side), rotation, and how many times longer than wide the sprite is.
  float rot = iSizeRot.y;
  float width = iSizeRot.x / iSizeRot.z;
  float len = iSizeRot.x;
  #ifdef ALIGN
  if (iVel.w > 0.5) {
    // A streak along its motion on screen: d/dt of xy / -z for a point at mvPosition moving with v (view space).
    vec3 v = (modelViewMatrix * vec4(iVel.xyz, 0.0)).xyz;
    vec2 sv = v.xy * -mvPosition.z + mvPosition.xy * v.z;
    float sl = length(sv);
    if (sl > 1e-6) rot = atan(sv.y, sv.x);
    // Flying straight at or away from the camera it shortens, to a third of its length end on.
    len *= mix(0.35, 1.0, clamp(sl / max(length(v) * -mvPosition.z, 1e-6), 0.0, 1.0));
    // Sparks thrown back past the camera fade out rather than flare up across the view.
    vColor.a *= smoothstep(1.5, 4.0, -mvPosition.z);
  }
  #endif
  float c = cos(rot);
  float s = sin(rot);
  vec2 q = vec2(position.x * len, position.y * width);
  mvPosition.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const PARTICLE_FS = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
uniform float uSoft;
#ifdef LIT
uniform vec3 uLight;
#endif
#include <fog_pars_fragment>
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = smoothstep(1.0, uSoft, d);
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  #ifdef LIT
  // Smoke, spray and dust scatter the scene's light (Effects.setLight): dim at night, tinted at dusk.
  gl_FragColor.rgb *= uLight;
  #endif
  if (gl_FragColor.a < 0.004) discard;
  // No-ops when three draws into its HDR target (its output pass tone-maps); else this is the output.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Optional looks of a particle (ParticleLayer.emit). */
interface EmitStyle {
  /** Streak along the way it moves on screen (on a layer made `aligned`); emit's `stretch` sets its length:width. */
  align?: boolean;
  /** Scale the starting and the final colour, which may so go past 1 (HDR, to bloom). */
  glow?: number;
  glowEnd?: number;
  /** At full strength from its first frame, without the fade-in over the first eighth of its life. */
  instant?: boolean;
}

class ParticleLayer {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly iPos: Float32Array;
  private readonly iColor: Float32Array;
  private readonly iSizeRot: Float32Array;
  /** Velocity and whether to streak along it (w = 1), on a layer that can (`aligned`). */
  private readonly iVel: Float32Array | null;
  // Simulation state.
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
  private readonly c0: Float32Array;
  private readonly c1: Float32Array;
  private readonly a0: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly stretch: Float32Array;
  private readonly align: Uint8Array;
  private readonly instant: Uint8Array;
  /** Emitted since the last update: not aged before it is first drawn. */
  private readonly fresh: Uint8Array;
  private next = 0;
  active = 0;

  /** The scene light the particles scatter (a `lit` layer's uniform), or null for a self-lit layer. */
  readonly light: THREE.Color | null;

  /**
   * `aligned` lets particles streak along their motion on screen (emit's `align`). A `lit` layer
   * multiplies its colours by the scene's light level (setLight); the others glow by themselves.
   */
  constructor(readonly max: number, additive: boolean, aligned = false, lit = false) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.setAttribute('uv', base.getAttribute('uv'));
    this.iPos = new Float32Array(max * 3);
    this.iColor = new Float32Array(max * 4);
    this.iSizeRot = new Float32Array(max * 3);
    this.iVel = aligned ? new Float32Array(max * 4) : null;
    this.geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.iPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.iColor, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iSizeRot', new THREE.InstancedBufferAttribute(this.iSizeRot, 3).setUsage(THREE.DynamicDrawUsage));
    if (this.iVel) this.geo.setAttribute('iVel', new THREE.InstancedBufferAttribute(this.iVel, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    const defines: Record<string, string> = {};
    if (aligned) defines.ALIGN = '';
    if (lit) defines.LIT = '';
    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uSoft: { value: additive ? 0.0 : 0.25 } }, lit ? { uLight: { value: new THREE.Color(1, 1, 1) } } : {}]),
      defines,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.light = lit ? (mat.uniforms.uLight!.value as THREE.Color) : null;
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 5 : 4;
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
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.a0 = f();
    this.grav = f();
    this.drag = f();
    this.rot = f();
    this.spin = f();
    this.stretch = f();
    this.align = new Uint8Array(max);
    this.instant = new Uint8Array(max);
    this.fresh = new Uint8Array(max);
  }

  /** `stretch` > 1 draws an elongated sprite (length:width), turned by `rot` on screen (or see `style.align`). */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size0: number, size1: number, color0: number, color1: number, alpha: number, gravity = 0, drag = 0, spin = 0, stretch = 1, rot = Math.random() * 6.28, style?: EmitStyle): void {
    const glow0 = style?.glow ?? 1;
    const glow1 = style?.glowEnd ?? 1;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = size0;
    this.s1[i] = size1;
    this.c0[i * 3] = (((color0 >> 16) & 255) / 255) * glow0;
    this.c0[i * 3 + 1] = (((color0 >> 8) & 255) / 255) * glow0;
    this.c0[i * 3 + 2] = ((color0 & 255) / 255) * glow0;
    this.c1[i * 3] = (((color1 >> 16) & 255) / 255) * glow1;
    this.c1[i * 3 + 1] = (((color1 >> 8) & 255) / 255) * glow1;
    this.c1[i * 3 + 2] = ((color1 & 255) / 255) * glow1;
    this.a0[i] = alpha;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.rot[i] = rot;
    this.spin[i] = spin;
    this.stretch[i] = Math.max(1, stretch);
    this.align[i] = style?.align && this.iVel ? 1 : 0;
    this.instant[i] = style?.instant ? 1 : 0;
    this.fresh[i] = 1;
  }

  update(dt: number, intensity: number): void {
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i]! <= 0) continue;
      // Drawn at least once whatever the frame time.
      // On the frame it was emitted a particle ages at most through its fade-in (an eighth of its life),
      // which leaves even a 0.05 s flash visible at 10 fps.
      let step = dt;
      if (this.fresh[i] && dt > 0) {
        this.fresh[i] = 0;
        step = Math.min(dt, this.maxLife[i]! * 0.125);
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
      this.iPos[n * 3] = this.px[i]!;
      this.iPos[n * 3 + 1] = this.py[i]!;
      this.iPos[n * 3 + 2] = this.pz[i]!;
      this.iColor[n * 4] = (this.c0[i * 3]! + (this.c1[i * 3]! - this.c0[i * 3]!) * t) * intensity;
      this.iColor[n * 4 + 1] = (this.c0[i * 3 + 1]! + (this.c1[i * 3 + 1]! - this.c0[i * 3 + 1]!) * t) * intensity;
      this.iColor[n * 4 + 2] = (this.c0[i * 3 + 2]! + (this.c1[i * 3 + 2]! - this.c0[i * 3 + 2]!) * t) * intensity;
      // Fade in quickly, out smoothly.
      this.iColor[n * 4 + 3] = this.a0[i]! * (this.instant[i] ? 1 : Math.min(1, t * 8)) * (1 - t * t);
      this.iSizeRot[n * 3] = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * t;
      this.iSizeRot[n * 3 + 1] = this.rot[i]!;
      this.iSizeRot[n * 3 + 2] = this.stretch[i]!;
      const vel = this.iVel;
      if (vel) {
        vel[n * 4] = this.vx[i]!;
        vel[n * 4 + 1] = this.vy[i]!;
        vel[n * 4 + 2] = this.vz[i]!;
        vel[n * 4 + 3] = this.align[i]!;
      }
      n++;
    }
    this.active = n;
    this.geo.instanceCount = n;
    (this.geo.getAttribute('iPos') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('iColor') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('iSizeRot') as THREE.InstancedBufferAttribute).needsUpdate = true;
    if (this.iVel) (this.geo.getAttribute('iVel') as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /** Drops every particle (a new session). */
  clear(): void {
    this.life.fill(0);
    this.fresh.fill(0);
    this.next = 0;
    this.active = 0;
    this.geo.instanceCount = 0;
  }
}

const SKID_VS = /* glsl */ `
attribute float aBirth;
uniform float uNow;
varying float vA;
#include <fog_pars_vertex>
void main() {
  vA = clamp(1.0 - (uNow - aBirth) / 40.0, 0.0, 1.0) * 0.55;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const SKID_FS = /* glsl */ `
varying float vA;
uniform vec3 uLight;
#include <fog_pars_fragment>
void main() {
  // Rubber on the road takes the scene's light like the road does: not lighter than the asphalt at night.
  gl_FragColor = vec4(vec3(0.04) * uLight, vA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly birth: Float32Array;
  private next = 0;
  private readonly mat: THREE.ShaderMaterial;
  private readonly last = new Map<string, { x: number; y: number; z: number; t: number }>();

  constructor(private readonly max: number) {
    this.pos = new Float32Array(max * 4 * 3);
    this.birth = new Float32Array(max * 4).fill(-1e6);
    const idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) {
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SKID_VS,
      fragmentShader: SKID_FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uNow: { value: 0 }, uLight: { value: new THREE.Color(1, 1, 1) } }]),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      fog: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
  }

  /** Adds a segment for wheel `key` if it moved enough since its previous point. */
  add(key: string, x: number, y: number, z: number, now: number): void {
    const prev = this.last.get(key);
    if (!prev || now - prev.t > 0.25 || Math.hypot(x - prev.x, z - prev.z) > 4) {
      this.last.set(key, { x, y, z, t: now });
      return;
    }
    const dx = x - prev.x;
    const dz = z - prev.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.35) return;
    const w = 0.13;
    const nx = (-dz / l) * w;
    const nz = (dx / l) * w;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const yy = y + 0.025;
    this.pos.set([prev.x + nx, prev.y + 0.025, prev.z + nz, prev.x - nx, prev.y + 0.025, prev.z - nz, x - nx, yy, z - nz, x + nx, yy, z + nz], i * 12);
    this.birth.fill(now, i * 4, i * 4 + 4);
    const g = this.mesh.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aBirth') as THREE.BufferAttribute).needsUpdate = true;
    this.last.set(key, { x, y, z, t: now });
  }

  break(key: string): void {
    this.last.delete(key);
  }

  update(now: number): void {
    this.mat.uniforms.uNow!.value = now;
  }

  /** The scene light the marks are seen in (Effects.setLight). */
  get light(): THREE.Color {
    return this.mat.uniforms.uLight!.value as THREE.Color;
  }

  /** Wipes every mark and forgets every wheel's last point (a new session). */
  clear(): void {
    this.birth.fill(-1e6);
    (this.mesh.geometry.getAttribute('aBirth') as THREE.BufferAttribute).needsUpdate = true;
    this.last.clear();
    this.next = 0;
  }
}

const TRACER_VS = /* glsl */ `
uniform float uHalfWidth;
uniform float uMinPx;
uniform float uViewH;
attribute vec3 iFrom;
attribute vec3 iTo;
varying float vAlong;
varying float vAcross;
#include <fog_pars_vertex>
void main() {
  // position.x: 0 at the tail, 1 at the head; position.y: -1 / +1 for the two edges of the ribbon.
  vec4 a = modelViewMatrix * vec4(iFrom, 1.0);
  vec4 b = modelViewMatrix * vec4(iTo, 1.0);
  vec4 mvPosition = mix(a, b, position.x);
  // Face the camera: widen across both the streak and the line of sight.
  vec3 side = cross(b.xyz - a.xyz, mvPosition.xyz);
  float sl = length(side);
  side = sl > 1e-9 ? side / sl : vec3(1.0, 0.0, 0.0);
  // One pixel at this depth (projectionMatrix[1][1] is 1 / tan(fov / 2)): far streaks keep a minimum width.
  float px = 2.0 * max(-mvPosition.z, 0.01) / (projectionMatrix[1][1] * uViewH);
  mvPosition.xyz += side * position.y * max(uHalfWidth, uMinPx * 0.5 * px);
  vAlong = position.x;
  vAcross = position.y;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const TRACER_FS = /* glsl */ `
uniform vec3 uColor;
varying float vAlong;
varying float vAcross;
#include <fog_pars_fragment>
void main() {
  // Brightest at the head, fading to the tail and to the edges.
  float a = (0.15 + 0.85 * vAlong * vAlong) * (1.0 - vAcross * vAcross);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      a *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Bullet tracers: camera-facing ribbons (one instanced draw).
 * Each streak's tail leaves the muzzle at TRACER_SPEED once the tracer is TRACER_HOLD old. On the frame it is fired the
 * head is already most of the way to the hit (TRACER_REACH); it stays there until it is TRACER_STREAK ahead of the tail,
 * and then keeps that lead. The tracer ends when the tail reaches the hit.
 * A tracer is drawn from the muzzle on the frame it was fired, however long that frame was.
 */
class Tracers {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly iFrom: Float32Array;
  private readonly iTo: Float32Array;
  private readonly from: Float32Array;
  private readonly dir: Float32Array;
  private readonly len: Float32Array;
  private readonly age: Float32Array;
  /** 0 = free, 1 = flying, 2 = fired since the last update (not aged yet). */
  private readonly state: Uint8Array;
  private readonly size = new THREE.Vector2();
  private next = 0;
  active = 0;

  constructor(private readonly max: number) {
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3));
    this.geo.setIndex([0, 2, 1, 1, 2, 3]);
    this.iFrom = new Float32Array(max * 3);
    this.iTo = new Float32Array(max * 3);
    this.geo.setAttribute('iFrom', new THREE.InstancedBufferAttribute(this.iFrom, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iTo', new THREE.InstancedBufferAttribute(this.iTo, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: TRACER_VS,
      fragmentShader: TRACER_FS,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: TRACER_COLOR.clone() }, uHalfWidth: { value: TRACER_WIDTH / 2 }, uMinPx: { value: TRACER_MIN_PX }, uViewH: { value: 720 } },
      ]),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    // The minimum width is in pixels of whatever the frame is drawn at.
    this.mesh.onBeforeRender = (renderer) => {
      this.mat.uniforms.uViewH!.value = Math.max(1, renderer.getDrawingBufferSize(this.size).y);
    };
    this.from = new Float32Array(max * 3);
    this.dir = new Float32Array(max * 3);
    this.len = new Float32Array(max);
    this.age = new Float32Array(max);
    this.state = new Uint8Array(max);
  }

  add(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
    const dx = tx - fx;
    const dy = ty - fy;
    const dz = tz - fz;
    const l = Math.hypot(dx, dy, dz);
    if (!(l > 1e-3) || !Number.isFinite(l + fx + fy + fz)) return;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.from.set([fx, fy, fz], i * 3);
    this.dir.set([dx / l, dy / l, dz / l], i * 3);
    this.len[i] = l;
    this.age[i] = 0;
    this.state[i] = 2;
  }

  update(dt: number): void {
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      const st = this.state[i]!;
      if (st === 0) continue;
      if (st === 2) this.state[i] = 1;
      else this.age[i] = this.age[i]! + dt;
      const l = this.len[i]!;
      const tail = TRACER_SPEED * Math.max(0, this.age[i]! - TRACER_HOLD);
      if (tail >= l) {
        this.state[i] = 0;
        continue;
      }
      const head = Math.min(l, Math.max(tail + TRACER_STREAK, Math.min(TRACER_REACH_MAX, l * TRACER_REACH)));
      for (let k = 0; k < 3; k++) {
        const f = this.from[i * 3 + k]!;
        const d = this.dir[i * 3 + k]!;
        this.iFrom[n * 3 + k] = f + d * tail;
        this.iTo[n * 3 + k] = f + d * head;
      }
      n++;
    }
    this.active = n;
    this.geo.instanceCount = n;
    (this.geo.getAttribute('iFrom') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('iTo') as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.state.fill(0);
    this.active = 0;
    this.geo.instanceCount = 0;
  }
}

/** Body parts a hard crash knocks off: sizes (x, y, z) of the shared unit box. */
const PART_SIZES = { bumper: [1.6, 0.25, 0.15], hood: [1.2, 0.05, 0.9], mirror: [0.15, 0.1, 0.08] } as const;
export type PartKind = keyof typeof PART_SIZES;
const MAX_PARTS = 16;
/** Parts lie on the road this long, then shrink away over PART_FADE. */
const PART_LIFE = 8;
const PART_FADE = 1;
const PART_GRAVITY = 12;
const BURNT_COLOR = 0x1d1b19;
const UP = new THREE.Vector3(0, 1, 0);

interface Part {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  spin: THREE.Vector3;
  size: THREE.Vector3;
  color: THREE.Color;
  age: number;
  resting: boolean;
}

/** Up to MAX_PARTS rigid parts (one InstancedMesh, per-instance scale and colour) that tumble, bounce and settle flat. */
class BodyParts {
  readonly mesh: THREE.InstancedMesh;
  private readonly parts: Part[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  /** Ground height under the parts (the world of the latest crash; reset() drops the parts with their world). */
  private ground: (x: number, z: number) => number = () => 0;

  constructor() {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.5 }), MAX_PARTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Creates the colour attribute up front, so the shader compiled at warm-up is the one used later.
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'bodyParts';
  }

  get active(): number {
    return this.parts.length;
  }

  spawn(kind: PartKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, color: number, spin: THREE.Vector3, ground: (x: number, z: number) => number): void {
    // A full pool recycles its oldest part.
    if (this.parts.length >= MAX_PARTS) this.parts.shift();
    this.ground = ground;
    const sz = PART_SIZES[kind];
    this.parts.push({
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(vx, vy, vz),
      quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(spin.x * 0.1, Math.atan2(vx, vz), spin.z * 0.1)),
      spin: spin.clone(),
      size: new THREE.Vector3(sz[0], sz[1], sz[2]),
      color: new THREE.Color(color),
      age: 0,
      resting: false,
    });
  }

  /** Half the height of a part's rotated box: how far its lowest corner is below its centre. */
  private halfHeight(p: Part): number {
    this.m.makeRotationFromQuaternion(p.quat);
    const e = this.m.elements;
    // Row 1 of the rotation matrix: the world Y of each local axis.
    return (Math.abs(e[1]!) * p.size.x + Math.abs(e[5]!) * p.size.y + Math.abs(e[9]!) * p.size.z) / 2;
  }

  /** Rotation that lays the part on its largest face: its thinnest local axis turned straight up or down. */
  private flatten(p: Part): THREE.Quaternion {
    this.m.makeRotationFromQuaternion(p.quat);
    const e = this.m.elements;
    const size = [p.size.x, p.size.y, p.size.z];
    let k = 0;
    for (let i = 1; i < 3; i++) if (size[i]! < size[k]!) k = i;
    this.axis.set(e[k * 4]!, e[k * 4 + 1]!, e[k * 4 + 2]!).normalize();
    return this.q.setFromUnitVectors(this.axis, e[k * 4 + 1]! >= 0 ? UP : this.s.set(0, -1, 0)).multiply(p.quat);
  }

  update(dt: number): void {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]!;
      p.age += dt;
      if (p.age >= PART_LIFE + PART_FADE) {
        this.parts.splice(i, 1);
        continue;
      }
      if (dt <= 0) continue;
      if (!p.resting) {
        p.vel.y -= PART_GRAVITY * dt;
        p.pos.addScaledVector(p.vel, dt);
        const w = p.spin.length();
        if (w > 1e-6) p.quat.premultiply(this.q.setFromAxisAngle(this.axis.copy(p.spin).divideScalar(w), w * dt));
      } else {
        // Settle flat on the road.
        p.quat.slerp(this.flatten(p), 1 - Math.exp(-14 * dt));
      }
      const floor = this.ground(p.pos.x, p.pos.z) + this.halfHeight(p);
      if (p.pos.y < floor || p.resting) {
        p.pos.y = floor;
        if (!p.resting) {
          if (p.vel.y < 0) p.vel.y = -p.vel.y * 0.35;
          p.vel.x *= 0.65;
          p.vel.z *= 0.65;
          p.spin.multiplyScalar(0.55);
          if (Math.hypot(p.vel.x, p.vel.z) < 0.7 && p.vel.y < 1.2) {
            p.resting = true;
            p.vel.set(0, 0, 0);
            p.spin.set(0, 0, 0);
          }
        }
      }
    }
    let n = 0;
    for (const p of this.parts) {
      const k = p.age > PART_LIFE ? Math.max(0, 1 - (p.age - PART_LIFE) / PART_FADE) : 1;
      this.m.compose(p.pos, p.quat, this.s.copy(p.size).multiplyScalar(Math.max(1e-4, k)));
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, p.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    this.parts.length = 0;
    this.mesh.count = 0;
    this.ground = () => 0;
  }
}

// Rocket parts, shared by every rocket view. The body points along local +Z.
const rocketBodyGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.62, 8).rotateX(Math.PI / 2);
const rocketNoseGeo = new THREE.ConeGeometry(0.075, 0.2, 8).rotateX(Math.PI / 2).translate(0, 0, 0.41);
const rocketFinGeo = new THREE.BoxGeometry(0.3, 0.02, 0.14).translate(0, 0, -0.24);
const rocketFlameGeo = new THREE.SphereGeometry(0.1, 8, 6).scale(1, 1, 2.2).translate(0, 0, -0.5);
const rocketBodyMat = new THREE.MeshStandardMaterial({ color: 0x3d4a2f, roughness: 0.5, metalness: 0.5 });
// Far above the bloom threshold so the exhaust glows.
const rocketFlameMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 4.6, 1.4) });
const ROCKET_FWD = new THREE.Vector3(0, 0, 1);
/** Distance between trail puffs, so the trail is continuous at any frame rate. */
const ROCKET_PUFF = 0.6;

interface RocketView {
  group: THREE.Group;
  /** Tail position at the last frame, and distance travelled since the last puff. */
  x: number;
  y: number;
  z: number;
  carry: number;
}

export class Effects {
  readonly group = new THREE.Group();
  private readonly glow = new ParticleLayer(2500, true, true);
  private readonly smoke = new ParticleLayer(3000, false, false, true);
  readonly skids = new SkidMarks(3000);
  private readonly tracers = new Tracers(160);
  private readonly parts = new BodyParts();
  readonly flash: THREE.PointLight;
  readonly muzzle: THREE.PointLight;
  private flashLife = 0;
  /** Age of the muzzle light (s) and its intensity when lit; it fades out over FLASH_LIFE. */
  private muzzleAge = FLASH_LIFE;
  private muzzlePeak = 0;
  /** The explosion / muzzle light was lit since the last update: it is not aged before its first frame. */
  private flashFresh = false;
  private muzzleFresh = false;
  /**
   * The trigger pull the muzzle light was last placed for: its flash point, unit shot direction (`aimed` when it has one),
   * how far ahead of the flash the light sits, its unshaded intensity and the shooter. Its shots land right after it.
   */
  private readonly pull = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, aimed: false, ahead: 0, peak: 0, shooter: null as Character | null };
  private readonly rng = new Rng(5);
  private readonly sprays: Array<{ x: number; y: number; z: number; t: number; acc: number }> = [];
  private readonly rockets = new Map<number, RocketView>();
  private readonly rocketPool: RocketView[] = [];
  private readonly rocketSeen = new Set<number>();
  private readonly rocketDir = new THREE.Vector3();
  private launch: { x: number; y: number; z: number } | null = null;

  constructor() {
    this.group.add(this.glow.mesh, this.smoke.mesh, this.skids.mesh, this.tracers.mesh);
    this.group.add(this.parts.mesh);
    this.flash = new THREE.PointLight(0xffa040, 0, 40, 1.6);
    this.muzzle = new THREE.PointLight(0xffd080, 0, 12, 2);
    this.group.add(this.flash, this.muzzle);
    // One pooled rocket up front, so the renderer's warm-up compiles its materials.
    this.rocketPool.push(this.newRocket());
  }

  /**
   * Clears per-simulation state when a new simulation is attached (props are restored then): nothing
   * of the last session's smoke, fire, skid marks or flash lights carries over into the next one.
   */
  reset(): void {
    this.sprays.length = 0;
    this.syncRockets([]);
    this.tracers.clear();
    this.parts.clear();
    this.glow.clear();
    this.smoke.clear();
    this.skids.clear();
    this.flash.intensity = 0;
    this.flashLife = 0;
    this.flashFresh = false;
    this.muzzle.intensity = 0;
    this.muzzlePeak = 0;
    this.muzzleAge = FLASH_LIFE;
    this.muzzleFresh = false;
    this.launch = null;
    // The last pull belongs to the old simulation (and holds on to its shooter).
    this.pull.aimed = false;
    this.pull.shooter = null;
  }

  /**
   * The scene's light level relative to noon (Environment.smokeLight): smoke, spray, dust, debris, blood
   * and skid marks are drawn in it, while fire, sparks, flashes and tracers glow by themselves.
   */
  setLight(c: THREE.Color): void {
    this.smoke.light!.copy(c);
    this.skids.light.copy(c);
  }

  private r(a: number, b: number): number {
    return this.rng.range(a, b);
  }

  /**
   * A muzzle flash `size` m across (FLASH_SIZE) at the barrel tip (x, y, z): two crossed, stretched glow sprites and a
   * short light that fades with them. Given the shot (`aim`), the light shines from FLASH_LIGHT_AHEAD further along it
   * (less once its shots land: shotLanded) and is dimmed to throw at most FLASH_HEAD_LIGHT on the shooter's own head.
   */
  muzzleFlash(x: number, y: number, z: number, size: number, aim: FlashAim | null = null): void {
    if (!(size > 0) || !Number.isFinite(x + y + z)) return;
    const rot = Math.random() * Math.PI;
    for (const r of [rot, rot + Math.PI / 2]) this.glow.emit(x, y, z, 0, 0, 0, FLASH_LIFE, size, size * 1.3, 0xfff0b0, 0xff8020, 1, 0, 0, 0, 3, r);
    const p = this.pull;
    p.x = x;
    p.y = y;
    p.z = z;
    p.peak = Math.min(FLASH_LIGHT_MAX, FLASH_LIGHT * size);
    p.shooter = aim?.shooter ?? null;
    const l = aim ? Math.hypot(aim.dx, aim.dy, aim.dz) : 0;
    p.aimed = !!aim && l > 1e-6 && Number.isFinite(l);
    p.dx = p.aimed ? aim!.dx / l : 0;
    p.dy = p.aimed ? aim!.dy / l : 0;
    p.dz = p.aimed ? aim!.dz / l : 0;
    p.ahead = p.aimed ? FLASH_LIGHT_AHEAD : 0;
    this.placeMuzzleLight();
    this.muzzleAge = 0;
    this.muzzleFresh = true;
  }

  /**
   * A bullet or pellet that left (fx, fy, fz) hit a surface at (tx, ty, tz) facing (nx, ny, nz). When it belongs to the
   * latest muzzle flash (it left from that flash point), the light is kept FLASH_LIGHT_CLEAR in front of that surface:
   * pushed on past a wall (or a car, or a man) right in front of the gun, it would light the far side of it and leave
   * its face dark.
   */
  shotLanded(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, nx: number, ny: number, nz: number): void {
    const p = this.pull;
    if (!p.aimed || this.muzzleAge > 0 || Math.abs(fx - p.x) + Math.abs(fy - p.y) + Math.abs(fz - p.z) > 1e-6) return;
    // How far in front of the flash the surface lies, and how fast the light's way along the shot closes on it.
    const depth = (fx - tx) * nx + (fy - ty) * ny + (fz - tz) * nz;
    const closing = -(p.dx * nx + p.dy * ny + p.dz * nz);
    if (!(closing > 1e-3) || !Number.isFinite(depth)) return;
    const ahead = Math.max(0, (depth - FLASH_LIGHT_CLEAR) / closing);
    if (ahead >= p.ahead) return;
    p.ahead = ahead;
    // Moved after it was lit (the same frame): its first frame keeps full strength.
    this.placeMuzzleLight();
  }

  /** Puts the muzzle light where the latest pull's flash and first hit leave it, dimmed for the shooter's head. */
  private placeMuzzleLight(): void {
    const p = this.pull;
    const lx = p.x + p.dx * p.ahead;
    const ly = p.y + p.dy * p.ahead;
    const lz = p.z + p.dz * p.ahead;
    let intensity = p.peak;
    if (p.aimed && p.shooter) {
      const h = headOf(p.shooter);
      const d2 = (lx - h.x) ** 2 + (ly - h.y) ** 2 + (lz - h.z) ** 2;
      if (Number.isFinite(d2)) intensity = Math.min(intensity, FLASH_HEAD_LIGHT * d2);
    }
    this.muzzle.position.set(lx, ly, lz);
    this.muzzle.intensity = intensity;
    this.muzzlePeak = intensity;
  }

  tracer(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
    this.tracers.add(fx, fy, fz, tx, ty, tz);
  }

  impact(x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: 'world' | 'vehicle' | 'flesh'): void {
    if (kind === 'flesh') {
      for (let i = 0; i < 6; i++) this.smoke.emit(x, y, z, nx * 1.5 + this.r(-1, 1), ny + this.r(0, 1.5), nz * 1.5 + this.r(-1, 1), this.r(0.3, 0.6), 0.12, 0.35, 0x8a0e0e, 0x4a0606, 0.9, 6, 1);
      return;
    }
    const n = kind === 'vehicle' ? 7 : 4;
    for (let i = 0; i < n; i++) this.glow.emit(x, y, z, nx * 4 + this.r(-2.5, 2.5), ny * 4 + this.r(0, 3), nz * 4 + this.r(-2.5, 2.5), this.r(0.15, 0.35), 0.08, 0.03, 0xffd27a, 0xff6a00, 1, 14);
    if (kind === 'world') for (let i = 0; i < 3; i++) this.smoke.emit(x, y, z, nx + this.r(-0.4, 0.4), ny * 0.6 + this.r(0, 0.6), nz + this.r(-0.4, 0.4), this.r(0.5, 0.9), 0.15, 0.7, 0x9a958a, 0x7a766e, 0.55, 0, 1.5);
  }

  explosion(x: number, y: number, z: number, radius: number): void {
    const s = radius / 7.5;
    // Flash, rolling fireball, dark smoke column, sparks.
    this.glow.emit(x, y + 0.6, z, 0, 0, 0, 0.16, 3 * s, 9 * s, 0xffd890, 0xff7020, 0.8);
    for (let i = 0; i < 36; i++) {
      const a = this.r(0, Math.PI * 2);
      const sp = this.r(2, 8) * s;
      const hot = i % 4 === 0;
      this.glow.emit(x + Math.cos(a) * this.r(0, 1.5) * s, y + this.r(0, 2) * s, z + Math.sin(a) * this.r(0, 1.5) * s, Math.cos(a) * sp, this.r(3, 10) * s, Math.sin(a) * sp, this.r(0.5, 1.1), this.r(1.8, 3.4) * s, this.r(3.5, 6.5) * s, hot ? 0xffc860 : 0xff8a28, 0x801200, 0.55, -1.5, 2.6, this.r(-1.5, 1.5));
    }
    for (let i = 0; i < 22; i++) {
      this.smoke.emit(x + this.r(-2, 2) * s, y + this.r(0.5, 3) * s, z + this.r(-2, 2) * s, this.r(-2.5, 2.5), this.r(2, 5.5), this.r(-2.5, 2.5), this.r(2.5, 4.5), this.r(1.8, 3) * s, this.r(5, 8) * s, 0x24201c, 0x55514c, 0.6, -0.7, 0.7, this.r(-0.4, 0.4));
    }
    for (let i = 0; i < 18; i++) {
      this.glow.emit(x, y + 0.5, z, this.r(-14, 14), this.r(5, 16), this.r(-14, 14), this.r(0.6, 1.4), 0.15, 0.08, 0xffe0a0, 0xff5000, 1, 18);
    }
    this.flash.position.set(x, y + 2, z);
    this.flash.intensity = 900 * s;
    this.flashLife = 0.5;
    this.flashFresh = true;
  }

  /** Muzzle point of a rocket just fired, where the next new rocket's trail starts. */
  rocketLaunched(x: number, y: number, z: number): void {
    this.launch = { x, y, z };
  }

  /** Mirrors the rockets in flight: a pooled body oriented along the velocity plus a smoke trail. */
  syncRockets(projectiles: readonly Projectile[]): void {
    const seen = this.rocketSeen;
    seen.clear();
    const dir = this.rocketDir;
    for (const p of projectiles) {
      if (p.removed) continue;
      const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
      if (sp > 1e-6) dir.set(p.vel.x / sp, p.vel.y / sp, p.vel.z / sp);
      else dir.copy(ROCKET_FWD);
      const tx = p.pos.x - dir.x * 0.4;
      const ty = p.pos.y - dir.y * 0.4;
      const tz = p.pos.z - dir.z * 0.4;
      seen.add(p.id);
      let r = this.rockets.get(p.id);
      if (!r) {
        r = this.rocketPool.pop() ?? this.newRocket();
        // The sim has already moved the rocket once, so start the trail at the launcher.
        const from = this.launch;
        this.launch = null;
        r.x = from ? from.x - dir.x * 0.4 : tx;
        r.y = from ? from.y - dir.y * 0.4 : ty;
        r.z = from ? from.z - dir.z * 0.4 : tz;
        r.carry = 0;
        r.group.visible = true;
        this.rockets.set(p.id, r);
      }
      r.group.position.set(p.pos.x, p.pos.y, p.pos.z);
      r.group.quaternion.setFromUnitVectors(ROCKET_FWD, dir);
      r.carry = this.rocketTrail(r, tx, ty, tz);
    }
    for (const [id, r] of this.rockets) {
      if (seen.has(id)) continue;
      r.group.visible = false;
      this.rocketPool.push(r);
      this.rockets.delete(id);
    }
    // A rocket that exploded before it was ever drawn must not hand its launch point to the next one.
    this.launch = null;
  }

  /** Lays puffs every ROCKET_PUFF metres from the view's last tail position to (x, y, z); returns the leftover distance. */
  private rocketTrail(r: RocketView, x: number, y: number, z: number): number {
    const dx = x - r.x;
    const dy = y - r.y;
    const dz = z - r.z;
    const len = Math.hypot(dx, dy, dz);
    r.x = x;
    r.y = y;
    r.z = z;
    if (len < 1e-6) return r.carry;
    let d = ROCKET_PUFF - r.carry;
    for (; d <= len; d += ROCKET_PUFF) {
      const k = d / len - 1;
      const px = x + dx * k;
      const py = y + dy * k;
      const pz = z + dz * k;
      this.smoke.emit(px, py, pz, this.r(-0.25, 0.25), this.r(0.1, 0.5), this.r(-0.25, 0.25), this.r(1.2, 2), 0.3, 1.6, 0xe2ded6, 0x9a968e, 0.55, -0.2, 1.2, this.r(-0.5, 0.5));
      this.glow.emit(px, py, pz, 0, 0, 0, 0.1, 0.35, 0.12, 0xffe0a0, 0xff6a10, 0.9);
    }
    return len - (d - ROCKET_PUFF);
  }

  private newRocket(): RocketView {
    const g = new THREE.Group();
    g.name = 'rocket';
    const fin = new THREE.Mesh(rocketFinGeo, rocketBodyMat);
    const fin2 = new THREE.Mesh(rocketFinGeo, rocketBodyMat);
    fin2.rotation.z = Math.PI / 2;
    g.add(new THREE.Mesh(rocketBodyGeo, rocketBodyMat), new THREE.Mesh(rocketNoseGeo, rocketBodyMat), fin, fin2, new THREE.Mesh(rocketFlameGeo, rocketFlameMat));
    g.visible = false;
    this.group.add(g);
    return { group: g, x: 0, y: 0, z: 0, carry: 0 };
  }

  /** Damaged / burning vehicle emitters (called per frame). */
  vehicleSmoke(x: number, y: number, z: number, condition: number, burning: boolean, wreck: boolean, dt: number): void {
    if (burning || wreck) {
      if (this.rng.next() < dt * (wreck ? 18 : 40)) this.glow.emit(x + this.r(-0.5, 0.5), y + this.r(0, 0.3), z + this.r(-0.5, 0.5), this.r(-0.4, 0.4), this.r(1.5, 3.2), this.r(-0.4, 0.4), this.r(0.4, 0.8), this.r(0.6, 1.0), this.r(0.2, 0.4), 0xffc040, 0xd02000, 1, -0.5, 1, this.r(-1, 1));
      if (this.rng.next() < dt * 14) this.smoke.emit(x + this.r(-0.4, 0.4), y + 0.8, z + this.r(-0.4, 0.4), this.r(-0.5, 0.5), this.r(1.5, 2.5), this.r(-0.5, 0.5), this.r(2.5, 4), 0.8, 3.2, 0x1a1816, 0x3a3836, 0.7, -0.3, 0.3);
    } else if (condition < 0.45) {
      const dark = condition < 0.25;
      if (this.rng.next() < dt * (dark ? 16 : 7)) this.smoke.emit(x + this.r(-0.3, 0.3), y, z + this.r(-0.3, 0.3), this.r(-0.3, 0.3), this.r(0.9, 1.8), this.r(-0.3, 0.3), this.r(1.2, 2.2), 0.4, 1.8, dark ? 0x3a3836 : 0x9a9894, dark ? 0x55524e : 0xb8b6b2, dark ? 0.6 : 0.4, -0.2, 0.6);
    }
  }

  /**
   * Sparks of metal grinding on a wall or another car, thrown along (vx, vz): streaks along their flight on screen,
   * white-hot past the bloom threshold at first (SPARK_GLOW), cooling to orange, short-lived.
   */
  sparks(x: number, y: number, z: number, n: number, vx = 0, vz = 0): void {
    for (let i = 0; i < n; i++) {
      this.glow.emit(x + this.r(-0.15, 0.15), y + this.r(-0.1, 0.15), z + this.r(-0.15, 0.15), vx + this.r(-1.5, 1.5), this.r(1, 4.5), vz + this.r(-1.5, 1.5), this.r(0.25, 0.45), this.r(0.35, 0.5), 0.12, 0xfff4cc, 0xff7a14, 1, 14, 0.8, 0, SPARK_STRETCH, 0, SPARK_STYLE);
    }
  }

  /**
   * Sparks for a vehicle scraping at (x, y, z) at `speed`: more the faster it grinds. They are shed along the body face
   * the contact is on, behind the contact, and trail the sliding motion along that face at about half its speed, so
   * they stream out behind the vehicle instead of dying under its body (or inside it when it slides sideways).
   */
  scrapeSparks(v: Vehicle, x: number, y: number, z: number, speed: number): void {
    const n = Math.round(Math.min(24, Math.max(4, speed / 1.2)));
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const ox = x - v.pos.x;
    const oz = z - v.pos.z;
    const along = ox * fx + oz * fz;
    const across = ox * fz - oz * fx;
    // Outward normal of the face the contact is on: a side (local +-X) or an end.
    const onSide = Math.abs(across) / v.halfW > Math.abs(along) / v.halfL;
    const nx = onSide ? fz * Math.sign(across) : fx * Math.sign(along);
    const nz = onSide ? -fx * Math.sign(across) : fz * Math.sign(along);
    // Only the sliding part of the velocity, along that face.
    const vn = v.vel.x * nx + v.vel.z * nz;
    const tx = v.vel.x - vn * nx;
    const tz = v.vel.z - vn * nz;
    const tl = Math.hypot(tx, tz);
    const reach = onSide ? v.halfL : v.halfW;
    for (let i = 0; i < n; i++) {
      const back = tl > 1e-3 ? this.r(0.3, 1) * reach : 0;
      const k = this.r(0.45, 0.75);
      this.sparks(x - (back * tx) / (tl || 1), y + this.r(0, 0.2), z - (back * tz) / (tl || 1), 1, tx * k, tz * k);
    }
  }

  /** A burst of light blue glass fragments from a smashed window. */
  glassShards(x: number, y: number, z: number): void {
    for (let i = 0; i < 16; i++) {
      this.smoke.emit(x + this.r(-0.35, 0.35), y + this.r(0, 0.45), z + this.r(-0.35, 0.35), this.r(-3, 3), this.r(1.5, 4.5), this.r(-3, 3), this.r(0.5, 0.95), this.r(0.05, 0.09), 0.04, 0xe4f4ff, 0x9fc8e6, 0.95, 9, 0.6, this.r(-9, 9));
    }
  }

  /**
   * Knocks 1-3 body parts in the vehicle's colour off a hard crash at (x, y, z): bumpers and the hood from the ends,
   * mirrors from the sides. Crushed off between the car and what it hit, they squeeze out from the contact sideways, up
   * and back towards the car (never into the obstacle) on top of the car's own velocity, then bounce and settle.
   */
  shedParts(v: Vehicle, x: number, y: number, z: number, strength: number, ground: (x: number, z: number) => number): void {
    const n = Math.max(1, Math.min(3, 1 + Math.floor((strength - 20) / 8)));
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const dx = x - v.pos.x;
    const dz = z - v.pos.z;
    const along = dx * fx + dz * fz;
    const across = dx * fz - dz * fx;
    const end = Math.abs(along) / v.halfL >= Math.abs(across) / v.halfW;
    const kinds: PartKind[] = end ? (along > 0 ? ['bumper', 'hood', 'mirror'] : ['bumper', 'mirror', 'mirror']) : ['mirror', 'bumper', 'mirror'];
    // Outward through the hit face (from the centre, or straight up for a hit at the centre, e.g. a landing).
    const hl = Math.hypot(dx, dz);
    const ox = hl > 1e-6 ? dx / hl : 0;
    const oz = hl > 1e-6 ? dz / hl : 0;
    const color = v.destroyed ? BURNT_COLOR : v.color;
    for (let i = 0; i < n; i++) {
      const side = (i % 2 === 0 ? 1 : -1) * this.r(1.5, 4);
      const back = this.r(0.3, 1.5);
      const spin = new THREE.Vector3(this.r(-9, 9), this.r(-6, 6), this.r(-9, 9));
      const px = x + this.r(-0.2, 0.2);
      const pz = z + this.r(-0.2, 0.2);
      const py = Math.max(y + 0.1, ground(px, pz) + 0.3);
      const vx = v.vel.x - oz * side - ox * back + this.r(-0.5, 0.5);
      const vz = v.vel.z + ox * side - oz * back + this.r(-0.5, 0.5);
      this.parts.spawn(kinds[i]!, px, py, pz, vx, this.r(2.5, 5), vz, color, spin, ground);
    }
  }

  get partCount(): number {
    return this.parts.active;
  }

  tireSmoke(x: number, y: number, z: number): void {
    this.smoke.emit(x + this.r(-0.2, 0.2), y + 0.15, z + this.r(-0.2, 0.2), this.r(-0.6, 0.6), this.r(0.4, 1.0), this.r(-0.6, 0.6), this.r(0.8, 1.6), 0.5, 2.2, 0xd8d8d8, 0xeeeeee, 0.32, -0.1, 0.8);
  }

  splash(x: number, y: number, z: number, big: boolean): void {
    const n = big ? 40 : 14;
    for (let i = 0; i < n; i++) this.smoke.emit(x + this.r(-1, 1), y + 0.1, z + this.r(-1, 1), this.r(-3, 3), this.r(3, big ? 9 : 5), this.r(-3, 3), this.r(0.6, 1.2), 0.3, 0.8, 0xffffff, 0xcfe8f5, 0.8, 14, 0.2);
  }

  hydrantSpray(x: number, y: number, z: number): void {
    this.sprays.push({ x, y, z, t: 12, acc: 0 });
  }

  debris(x: number, y: number, z: number): void {
    for (let i = 0; i < 8; i++) this.smoke.emit(x, y + 0.8, z, this.r(-3, 3), this.r(2, 5), this.r(-3, 3), this.r(0.4, 0.8), 0.12, 0.08, 0x555555, 0x333333, 1, 16);
  }

  update(dt: number, now: number): void {
    for (let i = this.sprays.length - 1; i >= 0; i--) {
      const s = this.sprays[i]!;
      s.t -= dt;
      if (s.t <= 0) {
        this.sprays.splice(i, 1);
        continue;
      }
      // A fixed rate (3 per frame at 60 Hz) rather than per call: nothing while paused, same at any frame rate.
      s.acc += dt * 180;
      for (; s.acc >= 1; s.acc--) this.smoke.emit(s.x + this.r(-0.1, 0.1), s.y + 0.6, s.z + this.r(-0.1, 0.1), this.r(-0.8, 0.8), this.r(7, 10), this.r(-0.8, 0.8), this.r(1, 1.6), 0.2, 0.7, 0xffffff, 0xd8ecf8, 0.75, 9, 0.1);
    }
    this.glow.update(dt, 1);
    this.smoke.update(dt, 1);
    this.parts.update(dt);
    this.tracers.update(dt);
    this.skids.update(now);
    if (this.flashFresh) {
      if (dt > 0) this.flashFresh = false;
    } else if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.intensity *= Math.exp(-8 * dt);
      if (this.flashLife <= 0) this.flash.intensity = 0;
    }
    if (this.muzzleFresh) {
      if (dt > 0) this.muzzleFresh = false;
    } else if (this.muzzleAge < FLASH_LIFE) {
      // Fades with the flash sprites (quadratically, so the second frame is already well down).
      this.muzzleAge += dt;
      const k = Math.max(0, 1 - this.muzzleAge / FLASH_LIFE);
      this.muzzle.intensity = this.muzzlePeak * k * k;
    }
  }

  get particleCount(): number {
    return this.glow.active + this.smoke.active;
  }

  /** Glow particles (flashes, sparks, fire) drawn this frame. */
  get glowCount(): number {
    return this.glow.active;
  }

  /** Tracer streaks drawn this frame. */
  get tracerCount(): number {
    return this.tracers.active;
  }
}
