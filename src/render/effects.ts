// Particles (instanced billboards), bullet tracers, skid marks, flash lights and rockets in flight.

import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { Projectile } from '../sim/entities';

const PARTICLE_VS = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec2 iSizeRot;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = iColor;
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iSizeRot.y);
  float s = sin(iSizeRot.y);
  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSizeRot.x;
  mvPosition.xy += p;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const PARTICLE_FS = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
uniform float uSoft;
#include <fog_pars_fragment>
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = smoothstep(1.0, uSoft, d);
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  if (gl_FragColor.a < 0.004) discard;
  #include <fog_fragment>
}`;

class ParticleLayer {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly iPos: Float32Array;
  private readonly iColor: Float32Array;
  private readonly iSizeRot: Float32Array;
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
  private next = 0;
  active = 0;

  constructor(readonly max: number, additive: boolean) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.setAttribute('uv', base.getAttribute('uv'));
    this.iPos = new Float32Array(max * 3);
    this.iColor = new Float32Array(max * 4);
    this.iSizeRot = new Float32Array(max * 2);
    this.geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.iPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.iColor, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iSizeRot', new THREE.InstancedBufferAttribute(this.iSizeRot, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uSoft: { value: additive ? 0.0 : 0.25 } }]),
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
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
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size0: number, size1: number, color0: number, color1: number, alpha: number, gravity = 0, drag = 0, spin = 0): void {
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
    this.c0[i * 3] = ((color0 >> 16) & 255) / 255;
    this.c0[i * 3 + 1] = ((color0 >> 8) & 255) / 255;
    this.c0[i * 3 + 2] = (color0 & 255) / 255;
    this.c1[i * 3] = ((color1 >> 16) & 255) / 255;
    this.c1[i * 3 + 1] = ((color1 >> 8) & 255) / 255;
    this.c1[i * 3 + 2] = (color1 & 255) / 255;
    this.a0[i] = alpha;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.rot[i] = Math.random() * 6.28;
    this.spin[i] = spin;
  }

  update(dt: number, intensity: number): void {
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i] = this.life[i]! - dt;
      if (this.life[i]! <= 0) continue;
      const k = Math.exp(-this.drag[i]! * dt);
      this.vx[i] = this.vx[i]! * k;
      this.vy[i] = this.vy[i]! * k - this.grav[i]! * dt;
      this.vz[i] = this.vz[i]! * k;
      this.px[i] = this.px[i]! + this.vx[i]! * dt;
      this.py[i] = this.py[i]! + this.vy[i]! * dt;
      this.pz[i] = this.pz[i]! + this.vz[i]! * dt;
      this.rot[i] = this.rot[i]! + this.spin[i]! * dt;
      const t = 1 - this.life[i]! / this.maxLife[i]!;
      this.iPos[n * 3] = this.px[i]!;
      this.iPos[n * 3 + 1] = this.py[i]!;
      this.iPos[n * 3 + 2] = this.pz[i]!;
      this.iColor[n * 4] = (this.c0[i * 3]! + (this.c1[i * 3]! - this.c0[i * 3]!) * t) * intensity;
      this.iColor[n * 4 + 1] = (this.c0[i * 3 + 1]! + (this.c1[i * 3 + 1]! - this.c0[i * 3 + 1]!) * t) * intensity;
      this.iColor[n * 4 + 2] = (this.c0[i * 3 + 2]! + (this.c1[i * 3 + 2]! - this.c0[i * 3 + 2]!) * t) * intensity;
      // Fade in quickly, out smoothly.
      this.iColor[n * 4 + 3] = this.a0[i]! * Math.min(1, t * 8) * (1 - t * t);
      this.iSizeRot[n * 2] = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * t;
      this.iSizeRot[n * 2 + 1] = this.rot[i]!;
      n++;
    }
    this.active = n;
    this.geo.instanceCount = n;
    (this.geo.getAttribute('iPos') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('iColor') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('iSizeRot') as THREE.InstancedBufferAttribute).needsUpdate = true;
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
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4(0.04, 0.04, 0.04, vA);
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
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uNow: { value: 0 } }]),
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
}

class Tracers {
  readonly mesh: THREE.LineSegments;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly life: Float32Array;
  private readonly from: Float32Array;
  private readonly to: Float32Array;
  private next = 0;

  constructor(private readonly max: number) {
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    this.life = new Float32Array(max);
    this.from = new Float32Array(max * 3);
    this.to = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.mesh.frustumCulled = false;
  }

  add(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.from.set([fx, fy, fz], i * 3);
    this.to.set([tx, ty, tz], i * 3);
    this.life[i] = 0.07;
  }

  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      const l = this.life[i]!;
      if (l > 0) this.life[i] = l - dt;
      const a = Math.max(0, this.life[i]!) / 0.07;
      // Draw a short streak that moves along the bullet path.
      const t0 = 1 - a;
      const t1 = Math.min(1, t0 + 0.35);
      for (let k = 0; k < 3; k++) {
        const f = this.from[i * 3 + k]!;
        const t = this.to[i * 3 + k]!;
        this.pos[i * 6 + k] = f + (t - f) * t0;
        this.pos[i * 6 + 3 + k] = f + (t - f) * t1;
      }
      const b = a * 2.2;
      this.col.set([b, b * 0.85, b * 0.45, b * 0.6, b * 0.5, b * 0.25], i * 6);
    }
    const g = this.mesh.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
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
  private readonly glow = new ParticleLayer(2500, true);
  private readonly smoke = new ParticleLayer(3000, false);
  readonly skids = new SkidMarks(3000);
  private readonly tracers = new Tracers(160);
  readonly flash: THREE.PointLight;
  readonly muzzle: THREE.PointLight;
  private flashLife = 0;
  private muzzleLife = 0;
  private readonly rng = new Rng(5);
  private readonly sprays: Array<{ x: number; y: number; z: number; t: number; acc: number }> = [];
  private readonly rockets = new Map<number, RocketView>();
  private readonly rocketPool: RocketView[] = [];
  private readonly rocketSeen = new Set<number>();
  private readonly rocketDir = new THREE.Vector3();
  private launch: { x: number; y: number; z: number } | null = null;

  constructor() {
    this.group.add(this.glow.mesh, this.smoke.mesh, this.skids.mesh, this.tracers.mesh);
    this.flash = new THREE.PointLight(0xffa040, 0, 40, 1.6);
    this.muzzle = new THREE.PointLight(0xffd080, 0, 12, 2);
    this.group.add(this.flash, this.muzzle);
    // One pooled rocket up front, so the renderer's warm-up compiles its materials.
    this.rocketPool.push(this.newRocket());
  }

  /** Clears per-simulation state when a new simulation is attached (props are restored then). */
  reset(): void {
    this.sprays.length = 0;
    this.syncRockets([]);
  }

  private r(a: number, b: number): number {
    return this.rng.range(a, b);
  }

  muzzleFlash(x: number, y: number, z: number, big: boolean): void {
    this.glow.emit(x, y, z, 0, 0, 0, 0.05, big ? 0.9 : 0.5, big ? 1.3 : 0.7, 0xfff0b0, 0xff8020, 1);
    this.muzzle.position.set(x, y, z);
    this.muzzle.intensity = big ? 40 : 22;
    this.muzzleLife = 0.06;
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
    this.tracers.update(dt);
    this.skids.update(now);
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.intensity *= Math.exp(-8 * dt);
      if (this.flashLife <= 0) this.flash.intensity = 0;
    }
    if (this.muzzleLife > 0) {
      this.muzzleLife -= dt;
      if (this.muzzleLife <= 0) this.muzzle.intensity = 0;
    }
  }

  get particleCount(): number {
    return this.glow.active + this.smoke.active;
  }
}
