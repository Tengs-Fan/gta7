// Particles (instanced billboards), bullet tracers, skid marks, flash lights and rockets in flight.

import * as THREE from 'three';
import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import type { Character, Projectile, Vehicle } from '../sim/entities';
import { flashSizeOf, WEAPONS, type WeaponId } from '../sim/specs';
import { registerDebug } from '../debug';
import { FoamRings } from './foamRings';
import { burntMaterial } from './fx/burnt';
import { FX_BUDGETS, FX_POOL_SIZES, type FxBudget, type FxTier } from './fx/budget';
import { Debris, type DebrisShape, type DebrisWorld } from './fx/debris';
import { FIREBALL_LIFE, FIREBALL_SCALE, fireballLobes, lobeAt, type FireballLobe, type LobeState } from './fx/fireball';
import { hash01 } from './fx/noise';
import { PuffKind, PuffLayer } from './fx/puffs';
import { ScorchDecals, type ScorchGround } from './fx/scorch';

/** Muzzle flash size (m, across the star) per weapon: WeaponSpec.flashSize, DEFAULT_FLASH_SIZE for a weapon without. */
export const flashSize = flashSizeOf;
/** The current weapons' flash sizes, by weapon (read from the specs when this module loads); flashSize also answers weapons added later. */
export const FLASH_SIZE: { readonly [K in WeaponId]: number } = Object.fromEntries(
  Object.values(WEAPONS).map((w) => [w.id, flashSizeOf(w.id)]),
) as { readonly [K in WeaponId]: number };
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

/**
 * A vehicle wading (its wheels on the sand under WADE_MIN to WADE_MAX m of the sea; deeper, the sim floods it) throws
 * spray off each wheel and leaves a wake (Effects.wade): at most these many particles a second (per wheel, per side of
 * the wake), reached at WADE_FULL_SPEED m/s and WADE_MAX deep. Nothing below WADE_MIN_SPEED.
 */
export const WADE_MIN = 0.1;
const WADE_MAX = 0.8;
const WADE_SPRAY_RATE = 60;
const WADE_WAKE_RATE = 16;
const WADE_MIN_SPEED = 1.5;
const WADE_FULL_SPEED = 14;
/** Tyre spray on a wet road (Effects.tyreSpray): from this speed (m/s), full at TYRE_SPRAY_FULL, particles a second per wheel. */
export const TYRE_SPRAY_SPEED = 8;
const TYRE_SPRAY_FULL = 28;
const TYRE_SPRAY_RATE = 45;

/**
 * A boat under way (Effects.boatWake) leaves foam behind its stern and throws spray off its bow: from BOAT_WAKE_MIN m/s,
 * full at BOAT_WAKE_FULL; particles a second per emitter at full strength.
 */
export const BOAT_WAKE_MIN = 1.5;
const BOAT_WAKE_FULL = 18;
const BOAT_FOAM_RATE = 34;
const BOAT_SPRAY_RATE = 40;
const BOAT_TAIL_RATE = 30;

/** How strong a boat's wake is at `speed` m/s, 0 (none: at rest or drifting) to 1. */
export function boatWakeLevel(speed: number): number {
  return clamp((speed - BOAT_WAKE_MIN) / (BOAT_WAKE_FULL - BOAT_WAKE_MIN), 0, 1);
}

/** How big a splash is: a bullet, a person falling in, a car or a crash, a blast on the water. */
export type SplashSize = 'small' | 'body' | 'big' | 'plume';
/** Per size: scale of the droplet crown, droplets, mist puffs, and the foam ring's final radius (m) and life (s). */
const SPLASH: Readonly<Record<SplashSize, { k: number; drops: number; mist: number; ring: number; ringLife: number }>> = {
  small: { k: 0.5, drops: 10, mist: 2, ring: 1.5, ringLife: 1.5 },
  body: { k: 0.8, drops: 18, mist: 4, ring: 2.4, ringLife: 1.8 },
  big: { k: 1.2, drops: 34, mist: 8, ring: 4, ringLife: 2.4 },
  plume: { k: 1.8, drops: 44, mist: 14, ring: 7, ringLife: 3.2 },
};
const DROPLET_STYLE: EmitStyle = { align: true };

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
  /** How many may be alive (a tier's cap, at most `max`). */
  private cap: number;

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
    this.cap = max;
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
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size0: number, size1: number, color0: number, color1: number, alpha: number, gravity = 0, drag = 0, spin = 0, stretch = 1, rot = Math.random() * 6.28, style?: EmitStyle): number {
    const glow0 = style?.glow ?? 1;
    const glow1 = style?.glowEnd ?? 1;
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
    return i;
  }

  /** Moves live particle i by (dx, dy, dz) (a muzzle flash riding its kicking gun). */
  shift(i: number, dx: number, dy: number, dz: number): void {
    if (!(this.life[i]! > 0)) return;
    this.px[i] = this.px[i]! + dx;
    this.py[i] = this.py[i]! + dy;
    this.pz[i] = this.pz[i]! + dz;
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

  /** The tier's cap; particles past a lowered cap go at once. */
  setCap(cap: number): void {
    this.cap = Math.max(1, Math.min(this.max, cap));
    for (let i = this.cap; i < this.max; i++) this.life[i] = 0;
    if (this.next >= this.cap) this.next = 0;
  }

  get capacity(): number {
    return this.cap;
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
  private count = 0;
  private newest = -Infinity;
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
    g.setDrawRange(0, 0);
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
    this.mesh.visible = false;
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
    this.count = Math.min(this.max, this.count + 1);
    this.newest = now;
    const yy = y + 0.025;
    this.pos.set([prev.x + nx, prev.y + 0.025, prev.z + nz, prev.x - nx, prev.y + 0.025, prev.z - nz, x - nx, yy, z - nz, x + nx, yy, z + nz], i * 12);
    this.birth.fill(now, i * 4, i * 4 + 4);
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.count * 6);
    this.mesh.visible = true;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aBirth') as THREE.BufferAttribute).needsUpdate = true;
    this.last.set(key, { x, y, z, t: now });
  }

  break(key: string): void {
    this.last.delete(key);
  }

  update(now: number): void {
    this.mat.uniforms.uNow!.value = now;
    if (now - this.newest >= 40) {
      this.mesh.visible = false;
      this.mesh.geometry.setDrawRange(0, 0);
      this.count = 0;
      this.next = 0;
    }
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
    this.count = 0;
    this.newest = -Infinity;
    this.mesh.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
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

  /** Moves the start of the tracers leaving (x, y, z) that are still held at the muzzle by (dx, dy, dz). */
  shiftHeld(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.max; i++) {
      if (this.state[i] === 0 || this.age[i]! > TRACER_HOLD) continue;
      const o = i * 3;
      if (Math.abs(this.from[o]! - x) + Math.abs(this.from[o + 1]! - y) + Math.abs(this.from[o + 2]! - z) > 1e-4) continue;
      this.from[o] = this.from[o]! + dx;
      this.from[o + 1] = this.from[o + 1]! + dy;
      this.from[o + 2] = this.from[o + 2]! + dz;
    }
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

/** Body parts a hard crash knocks off, and the debris shape each is drawn with. */
const PART_SHAPES = { bumper: 'bumper', hood: 'panel', mirror: 'mirror' } as const;
export type PartKind = keyof typeof PART_SHAPES;
/** Crash parts lie on the road this long, then shrink away over PART_FADE. */
const PART_LIFE = 8;
const PART_FADE = 1;
/** Explosion debris lies longer. */
const DEBRIS_LIFE = 12;
const DEBRIS_FADE = 1.5;
const BURNT_COLOR = 0x1d1b19;
/** Wreck smoke and flames thin out over this last stretch of the sim's burn (wreckTime < 25). */
const WRECK_BURN = 25;
const WRECK_THIN = 15;
/** Drift of smoke plumes (m/s): a light sea breeze. */
const WIND_X = 0.55;
const WIND_Z = 0.25;
/** Scorch radius per metre of blast radius, and the least a blast near the ground leaves. */
const SCORCH_PER_RADIUS = 0.5;

interface Fireball {
  x: number;
  y: number;
  z: number;
  ground: number;
  R: number;
  age: number;
  fresh: boolean;
  lobes: FireballLobe[];
}

/** The world the effects land in: ground height, water, walls (StaticWorld). */
export type EffectsWorld = DebrisWorld & ScorchGround;

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
  private readonly smoke = new ParticleLayer(3000, false, true, true);
  readonly skids = new SkidMarks(3000);
  private readonly tracers = new Tracers(160);
  private readonly parts = new Debris(FX_POOL_SIZES.debris);
  private readonly puffs = new PuffLayer(FX_POOL_SIZES.puffs, FX_POOL_SIZES.fireballs * FX_POOL_SIZES.fireballPuffs);
  readonly scorch = new ScorchDecals(FX_POOL_SIZES.scorches);
  private readonly fireballs: Fireball[] = [];
  private readonly fireballPool: Fireball[] = [];
  private readonly lobe: LobeState = { x: 0, y: 0, z: 0, size: 0, heat: 0, alpha: 0, rot: 0 };
  private budget: FxBudget = FX_BUDGETS.high;
  private tierName: FxTier = 'high';
  private world: EffectsWorld | null = null;
  /** Presentation seeds: a count of blasts, hashed (never the sim's rng). */
  private blasts = 0;
  private readonly tmpColor = new THREE.Color();
  private readonly tmpColor2 = new THREE.Color();
  private readonly tmpSpin = new THREE.Vector3();
  /** Peaks of the per-type counters since the last stats read (debug, budgets). */
  private readonly peak = { fireballs: 0, puffs: 0, debris: 0, sparks: 0, scorches: 0 };
  /** The latest muzzle flash: its sprites and point, kept on the shooter's drawn muzzle while it kicks (trackMuzzles). */
  private readonly flashTrack = { shooter: null as Character | null, a: 0, b: 0, x: 0, y: 0, z: 0, age: 0 };
  private shadowProbeGroup: THREE.Group | null = null;
  private warmupProbeGroup: THREE.Group | null = null;
  private muzzleOf: ((c: Character) => { x: number; y: number; z: number } | null) | null = null;
  readonly foam = new FoamRings();
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
  /** Boats that left a wake, and the wake particles they emitted, in the last update (boatWake counts into the open frame). */
  wakeBoats = 0;
  wakeSprites = 0;
  private wakeBoatsOpen = 0;
  private wakeSpritesOpen = 0;

  constructor() {
    this.group.add(this.glow.mesh, this.smoke.mesh, this.skids.mesh, this.tracers.mesh);
    this.group.add(this.parts.mesh, this.foam.mesh, this.puffs.mesh, this.scorch.mesh);
    for (let i = 0; i < FX_POOL_SIZES.fireballs; i++) this.fireballPool.push({ x: 0, y: 0, z: 0, ground: 0, R: 1, age: 0, fresh: false, lobes: [] });
    this.flash = new THREE.PointLight(0xffa040, 0, 40, 1.6);
    this.muzzle = new THREE.PointLight(0xffd080, 0, 12, 2);
    this.group.add(this.flash, this.muzzle);
    // One pooled rocket up front, so the renderer's warm-up compiles its materials.
    this.rocketPool.push(this.newRocket());
    // __gta7.ext.fx: counters and caps, live fireball lobes (world spheres), debris and scorch lives.
    registerDebug('fx', {
      stats: () => this.stats(),
      lobes: () => this.liveLobes(),
      debris: () => this.debrisProbe(),
      scorches: () => ({ clock: this.scorch.clock, lives: this.scorch.lives() }),
      scorchAt: (x: number, z: number, r: number, k?: number) => this.scorchAt(x, z, r, k),
    });
  }

  /**
   * Clears per-simulation state when a new simulation is attached (props are restored then): nothing
   * of the last session's smoke, fire, skid marks or flash lights carries over into the next one.
   */
  reset(): void {
    this.sprays.length = 0;
    this.wakeBoats = this.wakeSprites = this.wakeBoatsOpen = this.wakeSpritesOpen = 0;
    this.syncRockets([]);
    this.tracers.clear();
    this.parts.clear();
    this.puffs.clear();
    this.scorch.clear();
    while (this.fireballs.length) this.fireballPool.push(this.fireballs.pop()!);
    this.blasts = 0;
    for (const k of Object.keys(this.peak) as Array<keyof typeof this.peak>) this.peak[k] = 0;
    this.foam.clear();
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
    this.flashTrack.shooter = null;
  }

  /**
   * The scene's light level relative to noon (Environment.smokeLight): smoke, spray, dust, debris, blood
   * and skid marks are drawn in it, while fire, sparks, flashes and tracers glow by themselves.
   */
  setLight(c: THREE.Color): void {
    this.smoke.light!.copy(c);
    this.puffs.light.copy(c);
    this.skids.light.copy(c);
    this.foam.light.copy(c);
  }

  private r(a: number, b: number): number {
    return this.rng.range(a, b);
  }

  /** The tier's effect caps (fx/budget.ts): pools keep their size, only the caps change. */
  setTier(tier: FxTier): void {
    this.tierName = tier;
    this.budget = FX_BUDGETS[tier];
    this.puffs.setCap(this.budget.puffs);
    this.parts.setCap(this.budget.debris, this.budget.debrisShadows);
    this.scorch.setCap(this.budget.scorches);
    this.glow.setCap(this.budget.sparks);
    while (this.fireballs.length > this.budget.fireballs) this.fireballPool.push(this.fireballs.shift()!);
  }

  get tier(): FxTier {
    return this.tierName;
  }

  /** Where a character's drawn gun has its muzzle now (CrowdView.muzzleOf): flashes and held tracers follow its recoil. */
  trackMuzzles(fn: ((c: Character) => { x: number; y: number; z: number } | null) | null): void {
    this.muzzleOf = fn;
  }

  /** Keeps the latest flash's sprites and held tracers on its shooter's drawn muzzle as the gun kicks. */
  private followMuzzle(dt: number): void {
    const t = this.flashTrack;
    if (!t.shooter || !this.muzzleOf) return;
    t.age += dt;
    if (t.age > FLASH_LIFE * 2) {
      t.shooter = null;
      return;
    }
    const p = this.muzzleOf(t.shooter);
    if (!p || !Number.isFinite(p.x + p.y + p.z)) return;
    const dx = p.x - t.x;
    const dy = p.y - t.y;
    const dz = p.z - t.z;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-6 || Math.hypot(dx, dy, dz) > 0.6) return;
    this.glow.shift(t.a, dx, dy, dz);
    this.glow.shift(t.b, dx, dy, dz);
    this.tracers.shiftHeld(t.x, t.y, t.z, dx, dy, dz);
    // The light stays where the shot placed it (shotLanded, the shooter's head limit).
    t.x = p.x;
    t.y = p.y;
    t.z = p.z;
  }

  /** The world blasts land in (ground heights for scorches and debris, water, walls). */
  bindWorld(world: EffectsWorld | null): void {
    this.world = world;
  }

  /** Live counts and caps of every effect type (state().render.effects). */
  stats(): Record<string, number | string> {
    const b = this.budget;
    const c = this.puffs.counts;
    const live = { fireballs: this.fireballs.length, puffs: this.puffs.active, debris: this.parts.active, sparks: this.glow.active, scorches: this.scorch.live };
    for (const k of Object.keys(live) as Array<keyof typeof live>) this.peak[k] = Math.max(this.peak[k], live[k]);
    return {
      tier: this.tierName,
      ...live,
      fireballPuffs: c.fireball, flamePuffs: c.flame, smokePuffs: c.smoke, dustPuffs: c.dust,
      fireballCap: b.fireballs, puffCap: this.puffs.capacity, debrisCap: this.parts.capacity, sparkCap: this.glow.capacity, scorchCap: this.scorch.capacity,
      peakFireballs: this.peak.fireballs, peakPuffs: this.peak.puffs, peakDebris: this.peak.debris, peakSparks: this.peak.sparks, peakScorches: this.peak.scorches,
      scorchesPlaced: this.scorch.placed,
    };
  }

  /** Debris pieces now: lowest point, ground under it, resting (tests and the debug hook). */
  debrisProbe(): ReturnType<Debris['probe']> {
    return this.parts.probe();
  }

  /**
   * Stand-ins compiled by the renderer's warm-up (added to the scene only while it compiles): the debris shadow
   * material, and the burnt-wreck material as a plain mesh, an instanced one (far batches) and a fade copy.
   */
  warmupProbes(fade: (m: THREE.Material) => THREE.Material): THREE.Group {
    // Built once and kept (like shadowProbes): every warm-up (tier switch, context restore) reuses them, and the fade
    // copy keeps its program alive for the session.
    if (this.warmupProbeGroup) return this.warmupProbeGroup;
    const g = new THREE.Group();
    g.name = 'fx-warmup';
    const box = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const burnt = burntMaterial();
    const inst = new THREE.InstancedMesh(box, burnt, 1);
    inst.setMatrixAt(0, new THREE.Matrix4());
    const meshes: THREE.Mesh[] = [new THREE.Mesh(box, burnt), inst, new THREE.Mesh(box, fade(burnt))];
    for (const m of meshes) {
      m.position.set(0, -60, 0);
      m.frustumCulled = false;
      g.add(m);
    }
    this.warmupProbeGroup = g;
    return g;
  }

  /**
   * Stand-ins for the shadow pass of instanced meshes with their own depth material (the debris; the vehicle parts' far
   * bodies, passed in): compiling the scene builds no shadow programs. The shadow pass draws back faces (shadowSide) with
   * no fog, so these stand-ins are back-sided, fog-less copies, compiled with the scene's lights (compile's targetScene).
   */
  shadowProbes(instancedDepth: Iterable<THREE.Material>): THREE.Group {
    // Built once and kept: a program lives only while a material using it does, so the copies stay for the session.
    if (this.shadowProbeGroup) return this.shadowProbeGroup;
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    geo.setAttribute('instanceFade', new THREE.InstancedBufferAttribute(new Float32Array([1]), 1));
    const copy = (d: THREE.Material): THREE.Material => {
      const c = d.clone();
      c.onBeforeCompile = d.onBeforeCompile;
      c.customProgramCacheKey = d.customProgramCacheKey;
      c.side = THREE.BackSide;
      // The shadow pass draws without fog.
      (c as THREE.Material & { fog: boolean }).fog = false;
      return c;
    };
    for (const d of [...instancedDepth, this.parts.depth]) {
      // Instanced, tinted (instance colours, as the paint batches) and plain, each with its own copy: compiling builds
      // a material's program for its first object only.
      const m = new THREE.InstancedMesh(geo, copy(d), 1);
      m.setMatrixAt(0, new THREE.Matrix4());
      const tinted = new THREE.InstancedMesh(geo, copy(d), 1);
      tinted.setMatrixAt(0, new THREE.Matrix4());
      tinted.setColorAt(0, new THREE.Color(1, 1, 1));
      for (const o of [m, tinted, new THREE.Mesh(geo, copy(d))]) {
        o.position.set(0, -60, 0);
        o.frustumCulled = false;
        g.add(o);
      }
    }
    this.shadowProbeGroup = g;
    return g;
  }

  /** A flame tongue at (x, y, z) `size` m across, rising and cooling into a wisp of smoke. */
  private flame(x: number, y: number, z: number, size: number, vy: number, life: number, ground: number): void {
    const c = this.tmpColor.setRGB(0.06, 0.055, 0.05);
    this.puffs.emit(PuffKind.Flame, x, y, z, this.r(-0.25, 0.25), vy, this.r(-0.25, 0.25), life, size, size * this.r(0.45, 0.7), this.r(0.85, 1.05), this.r(0.05, 0.2), 0.95, c, this.rng.next(), this.r(0, 6.28), this.r(-1.5, 1.5), 0.8, -1.2, ground);
  }

  /** A puff of thick dark smoke at (x, y, z), `s0` -> `s1` m across over `life` s. */
  private smokePuff(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, alpha: number, grey: number, ground: number, heat = 0): void {
    const c = this.tmpColor.setRGB(grey, grey * 0.96, grey * 0.92);
    this.puffs.emit(PuffKind.Smoke, x, y, z, vx, vy, vz, life, s0, s1, heat, 0, alpha, c, this.rng.next(), this.r(0, 6.28), this.r(-0.25, 0.25), 0.18, -0.32, ground);
  }

  /** The surface under (x, z): ground, a deck, or the sea's surface over water. */
  private groundAt(x: number, y: number, z: number): number {
    const g = this.world?.groundHeight(x, z);
    if (g === undefined || !Number.isFinite(g) || g > y + 0.5) return y - 0.6;
    const depth = this.world?.waterDepth?.(x, z) ?? -1;
    return depth > 0 ? g + depth : g;
  }

  private overWater(x: number, z: number): boolean {
    return (this.world?.waterDepth?.(x, z) ?? -1) > 0;
  }

  /**
   * A muzzle flash `size` m across (FLASH_SIZE) at the barrel tip (x, y, z): two crossed, stretched glow sprites and a
   * short light that fades with them. Given the shot (`aim`), the light shines from FLASH_LIGHT_AHEAD further along it
   * (less once its shots land: shotLanded) and is dimmed to throw at most FLASH_HEAD_LIGHT on the shooter's own head.
   */
  muzzleFlash(x: number, y: number, z: number, size: number, aim: FlashAim | null = null): void {
    if (!(size > 0) || !Number.isFinite(x + y + z)) return;
    const rot = Math.random() * Math.PI;
    const ids = [rot, rot + Math.PI / 2].map((r) => this.glow.emit(x, y, z, 0, 0, 0, FLASH_LIFE, size, size * 1.3, 0xfff0b0, 0xff8020, 1, 0, 0, 0, 3, r));
    const tr = this.flashTrack;
    tr.shooter = aim?.shooter ?? null;
    tr.a = ids[0]!;
    tr.b = ids[1]!;
    tr.x = x;
    tr.y = y;
    tr.z = z;
    tr.age = 0;
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
    // Spark streaks off the hit, falling and gone within 0.45 s.
    for (let i = 0; i < n; i++) this.glow.emit(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, nx * 4 + this.r(-2.5, 2.5), ny * 4 + this.r(0.5, 3.5), nz * 4 + this.r(-2.5, 2.5), this.r(0.18, 0.4), this.r(0.18, 0.28), 0.06, 0xfff0c0, 0xff6a00, 1, 14, 0.6, 0, 4, 0, SPARK_STYLE);
    if (kind === 'world') for (let i = 0; i < 3; i++) this.smoke.emit(x, y, z, nx + this.r(-0.4, 0.4), ny * 0.6 + this.r(0, 0.6), nz + this.r(-0.4, 0.4), this.r(0.5, 0.9), 0.15, 0.7, 0x9a958a, 0x7a766e, 0.55, 0, 1.5);
  }

  /**
   * A blast at (x, y, z) of `radius` m. `water`: on the sea's surface, a column of water and spray instead. Otherwise a
   * fireball (fx/fireball.ts) scaled to the radius, spark streaks, a dust ring along the ground, the first dark smoke,
   * the flash light, and a scorch mark when it went off near the ground.
   */
  explosion(x: number, y: number, z: number, radius: number, water = false): void {
    if (!Number.isFinite(x + y + z + radius)) return;
    const s = radius / 7.5;
    if (water) {
      this.waterPlume(x, y, z, s);
      return;
    }
    const ground = this.groundAt(x, y, z);
    const seed = Math.floor(hash01(++this.blasts * 7919 + Math.round(x * 3) * 31 + Math.round(z * 3)) * 1e6);
    this.addFireball(x, Math.max(y, ground + 0.4), z, ground, radius * FIREBALL_SCALE, seed);
    // A short white flash core under the fireball (it blooms) on the first frames.
    this.glow.emit(x, y + 0.6, z, 0, 0, 0, 0.09, 2 * s, 4.5 * s, 0xffd890, 0xff8030, 0.55, 0, 0, 0, 1, 0, { instant: true });
    // Sparks and burning bits flung out, falling and gone within 0.6 s.
    const sparks = Math.round(26 * Math.min(1.5, Math.max(0.6, s)));
    for (let i = 0; i < sparks; i++) {
      const a = this.r(0, Math.PI * 2);
      const sp = this.r(7, 17) * Math.sqrt(s);
      this.glow.emit(x, y + 0.5, z, Math.cos(a) * sp, this.r(4, 14), Math.sin(a) * sp, this.r(0.3, 0.6), this.r(0.3, 0.5) * Math.sqrt(s), 0.1, 0xfff4cc, 0xff6010, 1, 16, 0.4, 0, 6, 0, SPARK_STYLE);
    }
    // Dust and grit thrown along the ground in a ring (not off the sea's surface).
    const dust = this.tmpColor2.setRGB(0.22, 0.2, 0.17);
    for (let i = this.overWater(x, z) ? 10 : 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + this.r(-0.2, 0.2);
      const sp = this.r(6, 10) * s;
      this.puffs.emit(PuffKind.Dust, x + Math.cos(a) * 0.8 * s, ground + 0.5 * s, z + Math.sin(a) * 0.8 * s, Math.cos(a) * sp, this.r(0.3, 1.2), Math.sin(a) * sp, this.r(1.3, 2.2), 1.2 * s, 3.4 * s, 0, 0, 0.42, dust, this.rng.next(), this.r(0, 6.28), this.r(-0.4, 0.4), 2.6, -0.1, ground);
    }
    // The first of the smoke: dark, still warm, rolling up through the fireball.
    for (let i = 0; i < 8; i++) {
      this.smokePuff(x + this.r(-1.2, 1.2) * s, y + this.r(1.5, 3.5) * s, z + this.r(-1.2, 1.2) * s, this.r(-1, 1) + WIND_X, this.r(3, 5.5), this.r(-1, 1) + WIND_Z, this.r(3.5, 5.5), this.r(2, 3) * s, this.r(5.5, 8) * s, 0.85, this.r(0.03, 0.055), ground, this.r(0.08, 0.14));
    }
    this.flash.position.set(x, y + 2, z);
    this.flash.intensity = 900 * s;
    this.flashLife = 0.5;
    this.flashFresh = true;
    // A blast near the ground scorches it (not one high on a wall or in the air).
    if (y - ground < Math.max(1.5, radius * 0.6)) this.scorchAt(x, z, Math.max(1.4, radius * SCORCH_PER_RADIUS), Math.min(1, 0.65 + s * 0.3));
  }

  /** A scorch mark `radius` m round at (x, z), darkness 0..1 (nothing over water). */
  scorchAt(x: number, z: number, radius: number, strength = 0.85): boolean {
    if (!this.world) return false;
    return this.scorch.add(x, z, radius, strength, this.r(0, Math.PI * 2), this.world);
  }

  private addFireball(x: number, y: number, z: number, ground: number, R: number, seed: number): void {
    if (this.fireballs.length >= this.budget.fireballs) this.fireballPool.push(this.fireballs.shift()!);
    const f = this.fireballPool.pop();
    if (!f) return;
    f.x = x;
    f.y = y;
    f.z = z;
    f.ground = ground;
    f.R = R;
    f.age = 0;
    f.fresh = true;
    fireballLobes(seed, this.budget.fireballPuffs, f.lobes);
    this.fireballs.push(f);
  }

  /**
   * A vehicle blew up: modelled debris (fx/debris.ts) flung out of it, panels in its scorched paint, wheels, struts and
   * charred chunks, which bounce, settle on the ground and shrink away after DEBRIS_LIFE.
   */
  vehicleExploded(v: Vehicle): void {
    const n = this.budget.vehicleDebris;
    const paint = this.tmpColor.set(v.color);
    const char = this.tmpColor2.set(BURNT_COLOR);
    // A boat has no wheels or axles to lose.
    const kinds: DebrisShape[] = v.spec.class === 'boat'
      ? ['panel', 'panel', 'chunk', 'panel', 'chunk', 'chunk', 'panel', 'chunk', 'mirror', 'chunk', 'panel', 'chunk']
      : ['panel', 'panel', 'bumper', 'wheel', 'chunk', 'chunk', 'strut', 'panel', 'chunk', 'mirror', 'chunk', 'wheel'];
    const world: DebrisWorld | ((x: number, z: number) => number) = this.world ?? (() => v.pos.y - v.spec.height * 0.5);
    const scale = Math.min(1.3, Math.max(0.55, (v.halfL * 2) / 4.6));
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const kind = kinds[i % kinds.length]!;
      const a = (i / n) * Math.PI * 2 + this.r(-0.35, 0.35);
      const sp = this.r(5, 11);
      const spin = this.tmpSpin.set(this.r(-12, 12), this.r(-8, 8), this.r(-12, 12));
      // Panels keep some of their paint under the soot; the rest is charred.
      if (kind === 'panel' || kind === 'bumper' || kind === 'mirror') col.copy(paint).lerp(char, this.r(0.25, 0.55));
      else if (kind === 'wheel' || kind === 'strut') col.setRGB(1, 1, 1);
      else col.copy(char).multiplyScalar(this.r(0.9, 1.6));
      const px = v.pos.x + Math.cos(a) * v.halfW * 0.6;
      const pz = v.pos.z + Math.sin(a) * v.halfW * 0.6;
      this.parts.spawn(kind, px, v.pos.y + v.spec.height * this.r(0.4, 0.9), pz, Math.cos(a) * sp + v.vel.x, this.r(5, 12), Math.sin(a) * sp + v.vel.z, spin, scale * this.r(0.8, 1.15), col, DEBRIS_LIFE + this.r(0, 2), DEBRIS_FADE, world);
    }
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

  /**
   * A shot-down helicopter on its way down (called every frame): flames on the fuselage and a puff of thick smoke each
   * frame, which hang where it was and so trail behind the fall. The particle systems are the tier's own (fewer and
   * simpler on Low and software renderers).
   */
  heliCrash(x: number, y: number, z: number, dt: number): void {
    const flames = 1 + (this.rng.next() < dt * 30 ? 1 : 0);
    for (let i = 0; i < flames; i++) this.glow.emit(x + this.r(-1, 1), y + this.r(-0.4, 0.8), z + this.r(-1, 1), this.r(-0.6, 0.6), this.r(0.5, 2), this.r(-0.6, 0.6), this.r(0.3, 0.6), this.r(1.1, 1.7), this.r(0.3, 0.5), 0xffc040, 0xd02000, 1, -0.5, 1, this.r(-1, 1));
    const k = this.budget.plumeRate;
    const ground = y - 3;
    for (let i = this.count(26 * k, dt); i > 0; i--) this.flame(x + this.r(-1, 1), y + this.r(-0.3, 0.6), z + this.r(-1, 1), this.r(1.2, 1.9), this.r(1.5, 3), this.r(0.5, 0.8), ground);
    for (let i = this.count(12 * k, dt); i > 0; i--) this.smokePuff(x + this.r(-0.6, 0.6), y + this.r(0.3, 1), z + this.r(-0.6, 0.6), this.r(-0.4, 0.4) + WIND_X, this.r(1, 2.5), this.r(-0.4, 0.4) + WIND_Z, this.r(4, 5.5), 1.8, 6.5, 0.88, this.r(0.03, 0.05), ground);
  }

  /** Damaged / burning vehicle emitters (called per frame). */
  /** `wreckAge`: seconds since it blew up, or -1 when it has not. */
  vehicleSmoke(x: number, y: number, z: number, condition: number, burning: boolean, wreck: boolean, dt: number, wreckAge = -1): void {
    if (burning || wreck) {
      if (this.rng.next() < dt * (wreck ? 18 : 40)) this.glow.emit(x + this.r(-0.5, 0.5), y + this.r(0, 0.3), z + this.r(-0.5, 0.5), this.r(-0.4, 0.4), this.r(1.5, 3.2), this.r(-0.4, 0.4), this.r(0.4, 0.8), this.r(0.6, 1.0), this.r(0.2, 0.4), 0xffc040, 0xd02000, 1, -0.5, 1, this.r(-1, 1));
      // A burnt-out wreck burns hard, then dies down over its last WRECK_THIN..WRECK_BURN seconds; a car on fire burns smaller.
      const k = this.budget.plumeRate * (wreck ? Math.max(0.15, Math.min(1, (WRECK_BURN - wreckAge) / (WRECK_BURN - WRECK_THIN))) : 0.55);
      const ground = y - 1.2;
      for (let i = this.count(16 * k, dt); i > 0; i--) this.flame(x + this.r(-0.7, 0.7), y + this.r(-0.2, 0.3), z + this.r(-0.7, 0.7), this.r(0.9, 1.4), this.r(1.8, 3), this.r(0.55, 0.9), ground);
      // The plume: thick, dark, rising well above the wreck and widening as it goes.
      for (let i = this.count(10 * k, dt); i > 0; i--) {
        this.smokePuff(x + this.r(-0.5, 0.5), y + this.r(0.8, 1.4), z + this.r(-0.5, 0.5), this.r(-0.8, 0.8) + WIND_X, this.r(3.8, 4.8), this.r(-0.8, 0.8) + WIND_Z, this.r(6.5, 8), this.r(1.5, 2.2), this.r(8.5, 12), 0.92, this.r(0.03, 0.055), ground);
      }
    } else if (wreckAge >= WRECK_BURN) {
      // Burnt out: the last thin wisps for a few seconds, then nothing (not a damaged car's grey smoke).
      const k = Math.max(0, 1 - (wreckAge - WRECK_BURN) / 6);
      if (k > 0 && this.rng.next() < dt * 4 * k) this.smokePuff(x + this.r(-0.4, 0.4), y + 0.6, z + this.r(-0.4, 0.4), WIND_X, this.r(1.5, 2.2), WIND_Z, this.r(3, 4), 0.8, 3.5, 0.45 * k, 0.07, y - 1.2);
    } else if (condition < 0.45) {
      const dark = condition < 0.25;
      if (this.rng.next() < dt * (dark ? 16 : 7)) this.smoke.emit(x + this.r(-0.3, 0.3), y, z + this.r(-0.3, 0.3), this.r(-0.3, 0.3), this.r(0.9, 1.8), this.r(-0.3, 0.3), this.r(1.2, 2.2), 0.4, 1.8, dark ? 0x3a3836 : 0x9a9894, dark ? 0x55524e : 0xb8b6b2, dark ? 0.6 : 0.4, -0.2, 0.6);
    }
  }

  /**
   * Lends the explosion light to a fire at (x, y, z) for this frame, while no explosion flash needs it (a fire needs no
   * light of its own, so the scene's light count, and every shader, stays as it was). Returns whether it took it.
   */
  fireLight(x: number, y: number, z: number, intensity: number): boolean {
    if (this.flashFresh || this.flashLife > 0) return false;
    this.flash.position.set(x, y, z);
    this.flash.intensity = intensity;
    return true;
  }

  /**
   * Burning ground (a patch of a molotov's fire, radius r) or a person on fire (a small r) at (x, y, z): flames licking up
   * from points across it, and a little dark smoke. `strength` 0..1 thins the flames as the patch dies down.
   */
  groundFire(x: number, y: number, z: number, r: number, dt: number, strength = 1): void {
    let n = dt * (14 + 12 * r) * strength;
    for (; n > 0; n--) {
      if (n < 1 && this.rng.next() >= n) break;
      const a = this.r(0, Math.PI * 2);
      const d = Math.sqrt(this.rng.next()) * r * 0.85;
      this.glow.emit(x + Math.sin(a) * d, y + this.r(0, 0.15), z + Math.cos(a) * d, this.r(-0.3, 0.3), this.r(1.2, 2.6), this.r(-0.3, 0.3), this.r(0.35, 0.7), this.r(0.45, 0.8) * (0.6 + 0.4 * strength), this.r(0.15, 0.3), 0xffc040, 0xd02000, 1, -0.5, 1, this.r(-1, 1));
    }
    if (this.rng.next() < dt * 3 * r * strength) this.smoke.emit(x + this.r(-r, r) * 0.5, y + 1, z + this.r(-r, r) * 0.5, this.r(-0.4, 0.4), this.r(1.2, 2), this.r(-0.4, 0.4), this.r(2, 3.2), 0.6, 2.6, 0x1a1816, 0x3a3836, 0.55, -0.3, 0.3);
    // Flame tongues and a smaller dark plume (a molotov's fire is flames, not a fireball).
    const k = this.budget.plumeRate * strength;
    for (let i = this.count((4 + 6 * r) * k, dt); i > 0; i--) {
      const a = this.r(0, Math.PI * 2);
      const d = Math.sqrt(this.rng.next()) * r * 0.8;
      this.flame(x + Math.sin(a) * d, y + 0.2, z + Math.cos(a) * d, this.r(0.5, 0.85) * (0.55 + 0.45 * Math.min(1, r)), this.r(1.2, 2.2), this.r(0.4, 0.7), y);
    }
    if (r > 0.3) for (let i = this.count(2.2 * r * k, dt); i > 0; i--) this.smokePuff(x + this.r(-r, r) * 0.4, y + 1.2, z + this.r(-r, r) * 0.4, this.r(-0.3, 0.3) + WIND_X * 0.6, this.r(1.8, 2.6), this.r(-0.3, 0.3) + WIND_Z * 0.6, this.r(3.5, 4.5), 0.9, 3.6, 0.8, this.r(0.04, 0.06), y);
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
      this.parts.spawn(PART_SHAPES[kinds[i]!], px, py, pz, vx, this.r(2.5, 5), vz, spin, kinds[i] === 'hood' ? 0.85 : 1, this.tmpColor.set(color), PART_LIFE, PART_FADE, this.world ?? ground);
    }
  }

  get partCount(): number {
    return this.parts.active;
  }

  tireSmoke(x: number, y: number, z: number): void {
    this.smoke.emit(x + this.r(-0.2, 0.2), y + 0.15, z + this.r(-0.2, 0.2), this.r(-0.6, 0.6), this.r(0.4, 1.0), this.r(-0.6, 0.6), this.r(0.8, 1.6), 0.5, 2.2, 0xd8d8d8, 0xeeeeee, 0.32, -0.1, 0.8);
  }

  /**
   * Something hit the water at (x, y, z) (`big` true: a car or a crash, false: a person): a crown of droplets streaking
   * out and falling back, a mist puff, and a foam ring spreading on the surface. On the smoke layer, in the scene's light.
   */
  splash(x: number, y: number, z: number, size: boolean | SplashSize): void {
    const kind: SplashSize = size === true ? 'big' : size === false ? 'body' : size;
    const p = SPLASH[kind];
    const k = p.k;
    for (let i = 0; i < p.drops; i++) {
      const a = this.r(0, Math.PI * 2);
      const out = this.r(0.8, 2.6) * k;
      const r0 = this.r(0.05, 0.25) * k;
      this.smoke.emit(x + Math.cos(a) * r0, y + 0.05, z + Math.sin(a) * r0, Math.cos(a) * out, this.r(2.5, 5.5) * Math.sqrt(k), Math.sin(a) * out, this.r(0.45, 0.85), this.r(0.07, 0.12) * k, 0.05, 0xffffff, 0xd6eaf4, 0.85, 9.8, 0.4, 0, 4, 0, DROPLET_STYLE);
    }
    if (kind !== 'small') {
      // The column thrown straight up by a body or a car.
      const n = kind === 'body' ? 8 : 18;
      for (let i = 0; i < n; i++) this.smoke.emit(x + this.r(-0.4, 0.4) * k, y + 0.1, z + this.r(-0.4, 0.4) * k, this.r(-1, 1), this.r(3, 6.5) * k, this.r(-1, 1), this.r(0.6, 1.1), 0.25 * k, 0.7 * k, 0xffffff, 0xcfe8f5, 0.75, 12, 0.3);
    }
    for (let i = 0; i < p.mist; i++) {
      this.smoke.emit(x + this.r(-0.3, 0.3) * k, y + this.r(0.1, 0.4) * k, z + this.r(-0.3, 0.3) * k, this.r(-0.4, 0.4), this.r(0.3, 0.9), this.r(-0.4, 0.4), this.r(1.2, 2), 0.4 * k, 1.8 * k, 0xf2f8fb, 0xdfeaf0, 0.28, 0, 1.2, this.r(-0.3, 0.3));
    }
    this.foam.add(x, z, p.ring, p.ringLife);
  }

  /** A blast on the water: a white column, a ring of spray, a drifting cloud of mist and a wide foam ring. */
  private waterPlume(x: number, y: number, z: number, s: number): void {
    for (let i = 0; i < 34; i++) {
      const a = this.r(0, Math.PI * 2);
      const r0 = this.r(0, 1.2) * s;
      this.smoke.emit(x + Math.cos(a) * r0, y + this.r(0, 1.5) * s, z + Math.sin(a) * r0, this.r(-1.2, 1.2), this.r(8, 17) * s, this.r(-1.2, 1.2), this.r(1.3, 2.3), this.r(0.6, 1) * s, this.r(1.8, 3) * s, 0xffffff, 0xd9e9f2, 0.85, 9.8, 0.5, this.r(-0.5, 0.5));
    }
    this.splash(x, y, z, 'plume');
    for (let i = 0; i < 40; i++) {
      const a = this.r(0, Math.PI * 2);
      const out = this.r(5, 11) * s;
      this.smoke.emit(x + Math.cos(a) * 0.8 * s, y + 0.2, z + Math.sin(a) * 0.8 * s, Math.cos(a) * out, this.r(3, 7) * s, Math.sin(a) * out, this.r(0.7, 1.2), this.r(0.14, 0.22) * s, 0.1, 0xffffff, 0xd2e4ee, 0.8, 9.8, 0.3, 0, 5, 0, DROPLET_STYLE);
    }
    for (let i = 0; i < 12; i++) {
      this.smoke.emit(x + this.r(-2.5, 2.5) * s, y + this.r(1, 6) * s, z + this.r(-2.5, 2.5) * s, this.r(-1, 1), this.r(0.4, 1.4), this.r(-1, 1), this.r(2.8, 4.2), this.r(2, 3) * s, this.r(6, 9) * s, 0xeef5f9, 0xd8e3ea, 0.32, -0.1, 0.6, this.r(-0.3, 0.3));
    }
  }

  /**
   * Spray off the wheels and a wake behind a vehicle wading through `depth` m of water (from WADE_MIN until it floods),
   * whose surface is at `surfaceY`. Both grow with its speed and with the depth. The spray is thrown out and up from
   * each wheel (back from the trailing ones) and trails the vehicle; the wake is foam spreading out on the surface from
   * its trailing end (its nose when it reverses), in flat sprites. Each particle starts somewhere along the way its
   * wheel went this frame, so the trail is even at any frame rate. On the smoke layer: in the scene's light.
   */
  wade(v: Vehicle, surfaceY: number, depth: number, dt: number): void {
    const go = clamp((Math.hypot(v.vel.x, v.vel.z) - WADE_MIN_SPEED) / (WADE_FULL_SPEED - WADE_MIN_SPEED), 0, 1);
    if (!(go > 0) || !(dt > 0) || !(depth >= WADE_MIN)) return;
    const deep = clamp((depth - WADE_MIN) / (WADE_MAX - WADE_MIN), 0, 1);
    const k = go * (0.25 + 0.75 * deep);
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    // The vehicle's left (its local +X).
    const lx = fz;
    const lz = -fx;
    // 1 going forwards, -1 reversing: the end it leaves behind.
    const dir = v.vel.x * fx + v.vel.z * fz < 0 ? -1 : 1;
    const along = v.halfL * 0.62;
    const across = v.halfW - 0.18;
    for (const front of [1, -1]) {
      for (const side of [1, -1]) {
        const wx = v.pos.x + fx * along * front + lx * across * side;
        const wz = v.pos.z + fz * along * front + lz * across * side;
        for (let n = this.count(WADE_SPRAY_RATE * k, dt); n > 0; n--) {
          const lag = this.r(0, dt);
          const out = this.r(0.6, 2.2) * (0.5 + 0.5 * k);
          const up = this.r(1.2, 3.4) * (0.45 + 0.75 * k);
          // The trailing wheels' rooster tail.
          const tail = front === dir ? 0 : this.r(0.5, 2) * dir;
          this.smoke.emit(
            wx - v.vel.x * lag + this.r(-0.15, 0.15),
            surfaceY + 0.05,
            wz - v.vel.z * lag + this.r(-0.15, 0.15),
            v.vel.x * 0.5 + lx * side * out - fx * tail,
            up,
            v.vel.z * 0.5 + lz * side * out - fz * tail,
            this.r(0.3, 0.6),
            0.1,
            0.3 + 0.25 * k,
            0xf4faff,
            0xd0e6f2,
            0.35 + 0.2 * k,
            9.8,
            0.8,
            0,
            1,
            this.r(0, Math.PI * 2),
          );
        }
      }
    }
    for (const side of [1, -1]) {
      const cx = v.pos.x - fx * dir * (v.halfL + 0.3) + lx * v.halfW * 0.8 * side;
      const cz = v.pos.z - fz * dir * (v.halfL + 0.3) + lz * v.halfW * 0.8 * side;
      for (let n = this.count(WADE_WAKE_RATE * k, dt); n > 0; n--) {
        const lag = this.r(0, dt);
        const out = this.r(0.4, 1.3) * (0.4 + 0.6 * k);
        // Four times wider than tall and level on screen: foam lying on the water.
        this.smoke.emit(
          cx - v.vel.x * lag + this.r(-0.2, 0.2),
          surfaceY + 0.06,
          cz - v.vel.z * lag + this.r(-0.2, 0.2),
          v.vel.x * 0.12 + lx * side * out,
          0,
          v.vel.z * 0.12 + lz * side * out,
          this.r(0.9, 1.5),
          0.6,
          1.2 + 1.0 * deep,
          0xeef7fb,
          0xd6e8f0,
          0.22 + 0.2 * deep,
          0,
          1.4,
          0,
          4,
          0,
        );
      }
    }
  }

  /**
   * The wake of a boat under way over a sea whose surface is `surfaceY` here: foam spreading from its stern (its bow when
   * it backs), spray thrown out and up off the bow, and a mist tail behind it at speed. All grow with its speed
   * (boatWakeLevel). Flat foam and spray on the smoke layer, so in the scene's light; the layer is a fixed pool, so
   * nothing is allocated here.
   */
  boatWake(v: Vehicle, surfaceY: number, dt: number): void {
    const k = boatWakeLevel(Math.hypot(v.vel.x, v.vel.z));
    if (!(k > 0)) return;
    this.wakeBoatsOpen++;
    if (!(dt > 0)) return;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const lx = fz;
    const lz = -fx;
    // 1 going forwards, -1 backing: which end trails.
    const dir = v.vel.x * fx + v.vel.z * fz < 0 ? -1 : 1;
    const hl = v.halfL;
    const hw = v.halfW;
    const y = surfaceY + 0.06;
    let n = 0;
    for (const side of [1, -1, 0]) {
      const sx = v.pos.x - fx * dir * hl * 0.92 + lx * hw * 0.7 * side;
      const sz = v.pos.z - fz * dir * hl * 0.92 + lz * hw * 0.7 * side;
      for (let c = this.count(BOAT_FOAM_RATE * k * (side === 0 ? 1 : 0.7), dt); c > 0; c--, n++) {
        const lag = this.r(0, dt);
        const out = this.r(0.3, 1.1) * (0.4 + 0.6 * k);
        this.smoke.emit(sx - v.vel.x * lag + this.r(-0.2, 0.2), y, sz - v.vel.z * lag + this.r(-0.2, 0.2), v.vel.x * 0.1 + lx * side * out, 0, v.vel.z * 0.1 + lz * side * out, this.r(1.3, 2.2), hw * 0.45, hw * (0.9 + 1.4 * k), 0xf2f9fc, 0xd6e8f0, 0.2 + 0.22 * k, 0, 1.2, 0, 4, 0);
      }
    }
    for (const side of [1, -1]) {
      const bx = v.pos.x + fx * dir * hl * 0.75 + lx * hw * 0.9 * side;
      const bz = v.pos.z + fz * dir * hl * 0.75 + lz * hw * 0.9 * side;
      for (let c = this.count(BOAT_SPRAY_RATE * k, dt); c > 0; c--, n++) {
        const lag = this.r(0, dt);
        const out = this.r(1, 2.8) * (0.5 + 0.5 * k);
        this.smoke.emit(bx - v.vel.x * lag + this.r(-0.1, 0.1), y, bz - v.vel.z * lag + this.r(-0.1, 0.1), v.vel.x * 0.45 + lx * side * out, this.r(1.8, 4) * (0.5 + 0.5 * k), v.vel.z * 0.45 + lz * side * out, this.r(0.4, 0.75), 0.07 + 0.05 * k, 0.04, 0xffffff, 0xd6eaf4, 0.7, 9.8, 0.5, 0, 4, 0, DROPLET_STYLE);
      }
    }
    if (k > 0.45) {
      const tx = v.pos.x - fx * dir * (hl + 0.2);
      const tz = v.pos.z - fz * dir * (hl + 0.2);
      for (let c = this.count(BOAT_TAIL_RATE * (k - 0.45), dt); c > 0; c--, n++) {
        const lag = this.r(0, dt);
        this.smoke.emit(tx - v.vel.x * lag + this.r(-hw, hw) * 0.4, y, tz - v.vel.z * lag + this.r(-hw, hw) * 0.4, v.vel.x * 0.3 - fx * dir * this.r(0.5, 2), this.r(1.5, 3.2) * k, v.vel.z * 0.3 - fz * dir * this.r(0.5, 2), this.r(0.5, 0.9), 0.3, 0.9 + 0.8 * k, 0xf4faff, 0xdce9f0, 0.3, 4, 1, this.r(-0.5, 0.5));
      }
    }
    this.wakeSpritesOpen += n;
  }

  /**
   * Spray thrown up behind the rear wheels of a car driving on a wet road (`wet` 0..1): none below TYRE_SPRAY_SPEED,
   * growing with speed to TYRE_SPRAY_FULL and with wetness. A fine mist on the smoke layer, so in the scene's light.
   */
  tyreSpray(v: Vehicle, wet: number, dt: number): void {
    const speed = Math.hypot(v.vel.x, v.vel.z);
    const k = clamp((speed - TYRE_SPRAY_SPEED) / (TYRE_SPRAY_FULL - TYRE_SPRAY_SPEED), 0, 1) * clamp(wet, 0, 1);
    if (!(k > 0) || !(dt > 0)) return;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const lx = fz;
    const lz = -fx;
    // The wheels trailing the motion (the front ones when reversing).
    const back = v.vel.x * fx + v.vel.z * fz < 0 ? 1 : -1;
    const along = v.halfL * 0.62 * back;
    const across = v.halfW - 0.18;
    const ux = v.vel.x / speed;
    const uz = v.vel.z / speed;
    for (const side of [1, -1]) {
      const wx = v.pos.x + fx * along + lx * across * side;
      const wz = v.pos.z + fz * along + lz * across * side;
      for (let n = this.count(TYRE_SPRAY_RATE * k, dt); n > 0; n--) {
        const lag = this.r(0, dt);
        const out = this.r(0.2, 1.2);
        this.smoke.emit(
          wx - v.vel.x * lag + this.r(-0.15, 0.15),
          v.pos.y + 0.12,
          wz - v.vel.z * lag + this.r(-0.15, 0.15),
          v.vel.x * 0.35 - ux * this.r(1, 3) + lx * side * out,
          this.r(0.6, 1.8) * (0.5 + 0.5 * k),
          v.vel.z * 0.35 - uz * this.r(1, 3) + lz * side * out,
          this.r(0.45, 0.9),
          0.25,
          1.1 + 0.9 * k,
          0xe6edf2,
          0xc8d2da,
          0.16 + 0.16 * k,
          1.5,
          1.6,
          this.r(-0.5, 0.5),
        );
      }
    }
  }

  /** How many particles `rate` a second makes over dt: its whole part, and one more with the chance of the rest. */
  private count(rate: number, dt: number): number {
    const n = rate * dt;
    const whole = Math.floor(n);
    return whole + (this.rng.next() < n - whole ? 1 : 0);
  }

  hydrantSpray(x: number, y: number, z: number): void {
    this.sprays.push({ x, y, z, t: 12, acc: 0 });
  }

  debris(x: number, y: number, z: number): void {
    for (let i = 0; i < 8; i++) this.smoke.emit(x, y + 0.8, z, this.r(-3, 3), this.r(2, 5), this.r(-3, 3), this.r(0.4, 0.8), 0.12, 0.08, 0x555555, 0x333333, 1, 16);
  }

  /** Every drawn lobe of the live fireballs: world centre, quad size, heat and opacity. */
  liveLobes(): Array<{ x: number; y: number; z: number; size: number; heat: number; alpha: number; age: number }> {
    const out: Array<{ x: number; y: number; z: number; size: number; heat: number; alpha: number; age: number }> = [];
    for (const f of this.fireballs) {
      for (const l of f.lobes) {
        const s = lobeAt(l, f.R, f.age, this.lobe);
        if (s.alpha > 0.002 && s.size > 0) out.push({ x: f.x + s.x, y: f.y + s.y, z: f.z + s.z, size: s.size, heat: s.heat, alpha: s.alpha, age: f.age });
      }
    }
    return out;
  }

  /** Ages the fireballs and hands this frame's lobes to the puff layer. */
  private updateFireballs(dt: number): void {
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i]!;
      // Drawn at its very start on its first frame, whatever the frame time.
      if (f.fresh) {
        if (dt > 0) f.fresh = false;
      } else {
        f.age += dt;
      }
      if (f.age >= FIREBALL_LIFE) {
        this.fireballs.splice(i, 1);
        this.fireballPool.push(f);
        continue;
      }
      for (const l of f.lobes) {
        const s = lobeAt(l, f.R, f.age, this.lobe);
        if (s.alpha <= 0.002 || s.size <= 0) continue;
        const d = this.puffs.push();
        if (!d) return;
        d.x = f.x + s.x;
        d.y = f.y + s.y;
        d.z = f.z + s.z;
        d.size = s.size;
        d.rot = s.rot;
        d.heat = s.heat;
        d.alpha = s.alpha;
        d.seed = l.seed;
        d.r = l.grey;
        d.g = l.grey * 0.96;
        d.b = l.grey * 0.92;
        d.ground = f.ground;
      }
    }
  }

  update(dt: number, now: number, eye: THREE.Vector3 | null = null): void {
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
    this.wakeBoats = this.wakeBoatsOpen;
    this.wakeSprites = this.wakeSpritesOpen;
    this.wakeBoatsOpen = this.wakeSpritesOpen = 0;
    this.followMuzzle(dt);
    this.glow.update(dt, 1);
    this.smoke.update(dt, 1);
    this.updateFireballs(dt);
    this.puffs.update(dt, eye);
    this.scorch.update(dt);
    this.parts.update(dt);
    this.foam.update(dt);
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
    return this.glow.active + this.smoke.active + this.puffs.counts.total;
  }

  /** Fireballs burning now. */
  get fireballCount(): number {
    return this.fireballs.length;
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
