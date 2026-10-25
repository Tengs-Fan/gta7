// Grenades and molotovs in flight, the aiming arc of a throw, and molotov fires (flames, burning people, the fire light).

import * as THREE from 'three';
import type { Character } from '../sim/entities';
import type { FireArea } from '../sim/fire';
import { WEAPONS, weaponKindOf } from '../sim/specs';
import { predictThrow, throwLaunch, type Thrown } from '../sim/throwables';
import type { ViewState } from '../sim/viewState';
import type { Effects } from './effects';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const MAX_THROWN = 32;
const ARC_POINTS = 160;
/** Dots drawn along the aiming arc, this far apart (m), so it reads at any distance; and the most of them. */
const DOT_STEP = 0.55;
const MAX_DOTS = 140;
/** Spike strip plates (m long) and the most drawn. */
const STRIP_PLATE = 1.1;
const MAX_PLATES = 64;
/** The fire light's intensity at the fire nearest the camera, flickering. */
const FIRE_LIGHT = 9;
/** A fire scorches the ground this far round (m) when first seen, and again once it has spread past that. */
const FIRE_SCORCH = 2.2;

export class ThrowView {
  readonly group = new THREE.Group();
  private readonly grenades: THREE.InstancedMesh;
  private readonly molotovs: THREE.InstancedMesh;
  private readonly arc: THREE.Line;
  private readonly arcPos: Float32Array;
  private readonly ring: THREE.Mesh;
  private readonly dots: THREE.InstancedMesh;
  /** Police spike strips: hinged plates across the road, each with a row of spikes. */
  private readonly stripPlates: THREE.InstancedMesh;
  private readonly stripSpikes: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  /** Whether a fire holds the light this frame, and held it last frame (it is put out once the fire is). */
  fireLit = false;
  /** The scorch radius laid for each fire so far, by fire id. */
  private readonly scorched = new Map<number, number>();
  private lightHeld = false;
  /** Whether the arc was shown last frame (for tests and the debug state). */
  arcShown = false;
  /** Where the shown arc ends. */
  readonly arcEnd = new THREE.Vector3();

  constructor() {
    this.group.name = 'throws';
    const grenadeGeo = new THREE.SphereGeometry(0.05, 8, 6).scale(1, 1.25, 1);
    const molotovGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8);
    this.grenades = new THREE.InstancedMesh(grenadeGeo, new THREE.MeshStandardMaterial({ color: 0x4c5a2c, roughness: 0.6, metalness: 0.3 }), MAX_THROWN);
    this.molotovs = new THREE.InstancedMesh(molotovGeo, new THREE.MeshStandardMaterial({ color: 0x3d7a42, roughness: 0.2, metalness: 0.1, emissive: 0x401800 }), MAX_THROWN);
    for (const m of [this.grenades, this.molotovs]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
    }
    this.arcPos = new Float32Array(ARC_POINTS * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.arcPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.arc = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xfff1c0, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }));
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    this.arc.name = 'throw-arc';
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1.0, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    this.ring.visible = false;
    this.ring.name = 'throw-landing';
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff0a0, toneMapped: false }), MAX_DOTS);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.dots.name = 'throw-arc-dots';
    this.stripPlates = new THREE.InstancedMesh(new THREE.BoxGeometry(STRIP_PLATE, 0.05, 0.42), new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.5, metalness: 0.6 }), MAX_PLATES);
    this.stripSpikes = new THREE.InstancedMesh(new THREE.ConeGeometry(0.035, 0.12, 5).translate(0, 0.06, 0), new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.3, metalness: 0.8 }), MAX_PLATES * 4);
    for (const m of [this.stripPlates, this.stripSpikes]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.receiveShadow = true;
    }
    this.stripPlates.name = 'spike-strip';
    this.group.add(this.grenades, this.molotovs, this.arc, this.ring, this.dots, this.stripPlates, this.stripSpikes);
  }

  /**
   * Mirrors the throws and fires of `view` and, while `me` holds a throwable up with the aim button, the arc it would fly
   * along the crosshair ray `aimDir`. Flames go to `fx`.
   */
  sync(view: ViewState, me: Character, aimDir: { x: number; y: number; z: number }, fx: Effects, dt: number, time: number, cam: THREE.Vector3): void {
    const throws = view.combat.throws?.list ?? [];
    let ng = 0;
    let nm = 0;
    for (const t of throws) {
      if (t.removed) continue;
      const mesh = t.weapon === 'molotov' ? this.molotovs : this.grenades;
      const i = t.weapon === 'molotov' ? nm++ : ng++;
      if (i >= MAX_THROWN) continue;
      this.place(t);
      mesh.setMatrixAt(i, this.m);
      // The molotov's lit rag.
      if (t.weapon === 'molotov' && dt > 0) fx.groundFire(t.pos.x, t.pos.y + 0.1, t.pos.z, 0.05, dt, 0.5);
    }
    this.grenades.count = Math.min(ng, MAX_THROWN);
    this.molotovs.count = Math.min(nm, MAX_THROWN);
    this.grenades.instanceMatrix.needsUpdate = true;
    this.molotovs.instanceMatrix.needsUpdate = true;

    // Fires: flames on every burning patch and person, one light at the fire nearest the camera.
    const fires = view.combat.fire?.areas ?? [];
    let best: FireArea | null = null;
    let bd = Infinity;
    for (const a of fires) {
      if (a.removed) {
        this.scorched.delete(a.id);
        continue;
      }
      for (const p of a.patches) {
        if (p.age >= p.life) continue;
        const left = p.life - p.age;
        if (dt > 0) fx.groundFire(p.x, p.y, p.z, p.r, dt, Math.min(1, left / 1.5) * Math.min(1, 0.4 + p.age * 1.5));
      }
      // A burnt patch under it, and a wider one once it spreads.
      const laid = this.scorched.get(a.id) ?? 0;
      const want = Math.max(FIRE_SCORCH, a.radius + 0.8);
      if (want > laid * 1.4 && fx.scorchAt(a.x, a.z, want, 0.8)) this.scorched.set(a.id, want);
      const d = Math.hypot(a.x - cam.x, a.z - cam.z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    if (dt > 0) {
      for (const c of view.characters) {
        if (c.removed || !(c.burnTimer > 0) || c.state === 'inVehicle') continue;
        const lying = c.state === 'knocked' || c.state === 'dead';
        fx.groundFire(c.pos.x, c.pos.y + (lying ? 0.2 : 0.7), c.pos.z, lying ? 0.6 : 0.35, dt, 0.8);
      }
    }
    // The fire light borrows the explosion flash light (Effects.fireLight); dark on tiers without dynamic lights.
    this.fireLit = false;
    if (best && bd < 120) {
      const flicker = 0.75 + 0.25 * Math.sin(time * 23) * Math.sin(time * 7.3 + 1);
      this.fireLit = fx.fireLight(best.x, best.y + 1.2, best.z, FIRE_LIGHT * Math.min(1, best.burning / 3 + 0.4) * flicker);
    } else if (this.lightHeld) fx.fireLight(0, 0, 0, 0);
    this.lightHeld = this.fireLit;

    this.syncStrips(view);

    // The aiming arc.
    const w = me.inventory.current;
    const show = me.aimZoom && me.state === 'normal' && me.alive && weaponKindOf(w) === 'thrown';
    this.arcShown = false;
    this.arc.visible = false;
    this.ring.visible = false;
    this.dots.count = 0;
    if (!show) return;
    const spec = WEAPONS[w].thrown!;
    const l = Math.hypot(aimDir.x, aimDir.y, aimDir.z) || 1;
    const launch = throwLaunch(view.world, me, { x: aimDir.x / l, y: aimDir.y / l, z: aimDir.z / l }, spec);
    const arc = predictThrow(view, launch.pos, launch.vel);
    const n = Math.min(ARC_POINTS, arc.points.length);
    for (let i = 0; i < n; i++) {
      const p = arc.points[i]!;
      this.arcPos[i * 3] = p.x;
      this.arcPos[i * 3 + 1] = p.y;
      this.arcPos[i * 3 + 2] = p.z;
    }
    const geo = this.arc.geometry;
    geo.setDrawRange(0, n);
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.arc.visible = true;
    this.arcShown = true;
    // Dots at even steps along the arc, growing a little with the distance from the eye so far ones still show.
    let nd = 0;
    let carry = 0;
    for (let i = 1; i < n && nd < MAX_DOTS; i++) {
      const a = arc.points[i - 1]!;
      const b = arc.points[i]!;
      const seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      let s = DOT_STEP - carry;
      while (s <= seg && nd < MAX_DOTS) {
        const k = s / seg;
        this.v.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
        const size = 1 + this.v.distanceTo(cam) / 25;
        this.s.set(size, size, size);
        this.m.compose(this.v, this.q.identity(), this.s);
        this.dots.setMatrixAt(nd++, this.m);
        s += DOT_STEP;
      }
      carry = seg - (s - DOT_STEP);
    }
    this.s.set(1, 1, 1);
    this.dots.count = nd;
    this.dots.instanceMatrix.needsUpdate = true;
    const end = arc.points[n - 1]!;
    this.arcEnd.set(end.x, end.y, end.z);
    if (arc.landing) {
      this.ring.position.set(arc.landing.x, arc.landing.y + 0.04, arc.landing.z);
      this.ring.visible = true;
    }
  }

  /** Each strip as plates end to end across the road, a hair above it, with spikes along each plate. */
  private syncStrips(view: ViewState): void {
    let np = 0;
    let ns = 0;
    for (const s of view.roadblocks?.strips ?? []) {
      if (s.removed) continue;
      const n = Math.max(1, Math.round((s.halfLen * 2) / STRIP_PLATE));
      // Plates run across the road (w), each turned to it.
      const wx = -s.uz;
      const wz = s.ux;
      this.q.setFromAxisAngle(Y_AXIS, Math.atan2(wx, wz) + Math.PI / 2);
      for (let i = 0; i < n && np < MAX_PLATES; i++) {
        const k = (i + 0.5) / n - 0.5;
        const x = s.x + wx * k * s.halfLen * 2;
        const z = s.z + wz * k * s.halfLen * 2;
        this.v.set(x, s.y + 0.03, z);
        this.m.compose(this.v, this.q, this.s);
        this.stripPlates.setMatrixAt(np++, this.m);
        for (let j = 0; j < 4 && ns < MAX_PLATES * 4; j++) {
          const kk = (j - 1.5) * 0.25;
          this.v.set(x + wx * kk, s.y + 0.05, z + wz * kk);
          this.m.compose(this.v, this.q, this.s);
          this.stripSpikes.setMatrixAt(ns++, this.m);
        }
      }
    }
    this.stripPlates.count = np;
    this.stripSpikes.count = ns;
    this.stripPlates.instanceMatrix.needsUpdate = true;
    this.stripSpikes.instanceMatrix.needsUpdate = true;
  }

  private place(t: Thrown): void {
    // Tumbling in the air, still once it lies on the ground.
    const spin = t.resting || t.inWater ? 0 : t.age * 9 + t.id;
    this.e.set(spin, t.id * 0.7, spin * 0.6 + (t.resting ? Math.PI / 2 : 0));
    this.q.setFromEuler(this.e);
    this.v.set(t.pos.x, t.pos.y + (t.resting ? 0.04 : 0), t.pos.z);
    this.m.compose(this.v, this.q, this.s);
  }

  reset(): void {
    this.scorched.clear();
    this.grenades.count = 0;
    this.molotovs.count = 0;
    this.arc.visible = false;
    this.ring.visible = false;
    this.dots.count = 0;
    this.fireLit = false;
    this.lightHeld = false;
  }

  dispose(): void {
    for (const o of [this.grenades, this.molotovs, this.arc, this.ring, this.dots, this.stripPlates, this.stripSpikes]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}
