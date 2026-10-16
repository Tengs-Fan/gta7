// All characters drawn with one InstancedMesh per body part, animated procedurally.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp } from '../core/math';
import type { Character } from '../sim/entities';
import { WEAPONS, type WeaponId } from '../sim/specs';

const MAX = 240;

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function mergeAll(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(gs.map((g) => g.toNonIndexed()), false);
  if (!m) throw new Error('merge failed');
  return m;
}

interface Part {
  mesh: THREE.InstancedMesh;
  n: number;
}

const tmp = {
  root: new THREE.Matrix4(),
  hip: new THREE.Matrix4(),
  torso: new THREE.Matrix4(),
  neck: new THREE.Matrix4(),
  limb: new THREE.Matrix4(),
  hand: new THREE.Matrix4(),
  out: new THREE.Matrix4(),
  t: new THREE.Matrix4(),
  r: new THREE.Matrix4(),
  s: new THREE.Matrix4(),
  c: new THREE.Color(),
};

export class CrowdView {
  readonly group = new THREE.Group();
  private readonly parts: Record<'torso' | 'head' | 'hair' | 'hat' | 'arm' | 'hand' | 'leg' | 'shoe' | 'neck', Part>;
  private readonly weapons = new Map<WeaponId, Part>();
  /** Per-character smoothed lying angle for knocked/dead animation. */
  private readonly lie = new Map<number, number>();
  /** Hide this character id (e.g. the player in first-person-ish shots). */
  hiddenId = -1;

  constructor() {
    this.group.name = 'crowd';
    const mat = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
    const make = (geo: THREE.BufferGeometry, count: number): Part => {
      const mesh = new THREE.InstancedMesh(geo, mat(), count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Allocate the colour buffer up front.
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      this.group.add(mesh);
      return { mesh, n: 0 };
    };
    this.parts = {
      torso: make(mergeAll([box(0.44, 0.6, 0.25, 0, 0.3, 0), box(0.4, 0.1, 0.24, 0, 0.62, 0)]), MAX),
      head: make(box(0.23, 0.26, 0.25, 0, 0.15, 0), MAX),
      hair: make(mergeAll([box(0.25, 0.08, 0.27, 0, 0.3, -0.005), box(0.25, 0.18, 0.06, 0, 0.19, -0.11)]), MAX),
      hat: make(mergeAll([box(0.26, 0.09, 0.27, 0, 0.32, 0), box(0.23, 0.03, 0.14, 0, 0.28, 0.18)]), MAX),
      arm: make(box(0.12, 0.54, 0.13, 0, -0.27, 0), MAX * 2),
      hand: make(box(0.1, 0.1, 0.1, 0, -0.59, 0.01), MAX * 2),
      neck: make(box(0.11, 0.08, 0.11, 0, 0.62, 0), MAX),
      leg: make(box(0.17, 0.84, 0.18, 0, -0.42, 0), MAX * 2),
      shoe: make(box(0.17, 0.08, 0.27, 0, -0.84, 0.04), MAX * 2),
    };
    const weaponGeo: Record<Exclude<WeaponId, 'fists'>, THREE.BufferGeometry> = {
      pistol: mergeAll([box(0.05, 0.08, 0.22, 0, 0, 0.1), box(0.045, 0.13, 0.06, 0, -0.07, 0.02)]),
      smg: mergeAll([box(0.06, 0.1, 0.42, 0, 0, 0.16), box(0.05, 0.16, 0.06, 0, -0.1, 0.06), box(0.04, 0.12, 0.05, 0, -0.08, 0.2)]),
      shotgun: mergeAll([box(0.06, 0.08, 0.9, 0, 0, 0.3), box(0.06, 0.12, 0.25, 0, -0.04, -0.12)]),
      rifle: mergeAll([box(0.06, 0.1, 0.85, 0, 0, 0.28), box(0.05, 0.18, 0.06, 0, -0.12, 0.12), box(0.06, 0.12, 0.22, 0, -0.03, -0.14)]),
      rocket: mergeAll([new THREE.CylinderGeometry(0.09, 0.09, 1.15, 10).rotateX(Math.PI / 2).translate(0, 0.08, 0.2), box(0.05, 0.14, 0.06, 0, -0.06, 0.1)]),
    };
    for (const [id, geo] of Object.entries(weaponGeo) as Array<[Exclude<WeaponId, 'fists'>, THREE.BufferGeometry]>) {
      const p = make(geo, MAX);
      (p.mesh.material as THREE.MeshStandardMaterial).color.setHex(id === 'rocket' ? 0x3d4a2f : 0x1e1e20);
      (p.mesh.material as THREE.MeshStandardMaterial).metalness = 0.6;
      (p.mesh.material as THREE.MeshStandardMaterial).roughness = 0.4;
      this.weapons.set(id, p);
    }
  }

  private put(part: Part, m: THREE.Matrix4, color: number): void {
    if (part.n >= part.mesh.instanceMatrix.count) return;
    part.mesh.setMatrixAt(part.n, m);
    part.mesh.setColorAt(part.n, tmp.c.setHex(color));
    part.n++;
  }

  sync(chars: readonly Character[], camX: number, camZ: number, dt: number): void {
    for (const p of Object.values(this.parts)) p.n = 0;
    for (const p of this.weapons.values()) p.n = 0;
    const seen = new Set<number>();
    for (const c of chars) {
      if (c.removed || c.state === 'inVehicle' || c.id === this.hiddenId) continue;
      if ((c.pos.x - camX) ** 2 + (c.pos.z - camZ) ** 2 > 200 * 200) continue;
      seen.add(c.id);
      this.pose(c, dt);
    }
    for (const id of this.lie.keys()) if (!seen.has(id)) this.lie.delete(id);
    const finish = (p: Part) => {
      p.mesh.count = p.n;
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    };
    for (const p of Object.values(this.parts)) finish(p);
    for (const p of this.weapons.values()) finish(p);
  }

  private pose(c: Character, dt: number): void {
    const a = c.appearance;
    const h = a.height;
    const bw = a.build;
    const M = tmp;
    const lying = c.state === 'dead' || c.state === 'knocked';
    let lie = this.lie.get(c.id) ?? 0;
    const lieTarget = lying ? 1 : 0;
    lie += clamp(lieTarget - lie, -dt * 3, dt * (c.onGround ? 5 : 2.2));
    this.lie.set(c.id, lie);

    const speed = c.speed;
    const ph = c.animPhase;
    const swimming = c.state === 'swimming';
    const airborne = !c.onGround && !lying;
    const run = clamp((speed - 2) / 5, 0, 1);
    const amp = speed < 0.3 ? 0 : 0.35 + run * 0.55;
    const swing = Math.sin(ph) * amp;
    const bob = lying || swimming ? 0 : Math.abs(Math.sin(ph)) * 0.05 * clamp(speed / 3, 0, 1);

    M.root.makeRotationY(c.heading);
    M.root.setPosition(c.pos.x, c.pos.y, c.pos.z);
    const hipY = 0.84 * h;
    if (swimming) {
      M.hip.copy(M.root).multiply(M.t.makeTranslation(0, 1.2, 0)).multiply(M.r.makeRotationX(1.25));
    } else if (lie > 0.001) {
      // Interpolate from standing to lying on the back.
      M.hip.copy(M.root)
        .multiply(M.t.makeTranslation(0, hipY * (1 - lie) + 0.16 * lie, -0.5 * lie))
        .multiply(M.r.makeRotationX(-Math.PI / 2 * lie));
    } else {
      M.hip.copy(M.root).multiply(M.t.makeTranslation(0, hipY + bob, 0));
    }

    const lean = lying || swimming ? 0 : run * 0.22 + (c.aiming ? 0.05 : 0);
    M.torso.copy(M.hip).multiply(M.r.makeRotationX(lean));
    M.out.copy(M.torso).multiply(M.s.makeScale(bw, h, bw));
    this.put(this.parts.torso, M.out, a.shirt);
    this.put(this.parts.neck, M.out, a.skin);

    M.neck.copy(M.torso).multiply(M.t.makeTranslation(0, 0.64 * h, 0));
    const headPitch = c.aiming ? -c.aimPitch * 0.5 : 0;
    M.out.copy(M.neck).multiply(M.r.makeRotationX(headPitch)).multiply(M.s.makeScale(h, h, h));
    this.put(this.parts.head, M.out, a.skin);
    if (a.hat) this.put(this.parts.hat, M.out, a.hat);
    else this.put(this.parts.hair, M.out, a.hair);

    // Arms.
    const weapon = c.inventory.current;
    const armed = weapon !== 'fists';
    const twoHanded = armed && WEAPONS[weapon].twoHanded;
    const aimAngle = -(Math.PI / 2 + c.aimPitch);
    for (const side of [-1, 1]) {
      // side = 1 is the character's right (local -X).
      let ax = 0;
      let az = side * 0.06;
      if (c.state === 'dead') {
        ax = -0.3;
        az = side * 1.25;
      } else if (lying) {
        ax = -1.0 + Math.sin(ph * 2) * 0.2;
        az = side * 0.7;
      } else if (swimming) {
        ax = Math.sin(ph * 0.8 + (side > 0 ? 0 : Math.PI)) * 2.2 - 1;
      } else if (c.state === 'entering') {
        ax = side > 0 ? -1.1 : -0.2;
      } else if (c.aiming && armed && (side > 0 || twoHanded)) {
        ax = aimAngle;
        az = side > 0 ? -0.04 : 0.45;
      } else if (c.punchTimer > 0 && side > 0) {
        const t = c.punchTimer / 0.32;
        ax = -Math.PI / 2 * Math.sin(Math.PI * clamp(1 - t, 0, 1)) - 0.2;
      } else if (airborne) {
        ax = -2.4;
        az = side * 0.35;
      } else {
        ax = -swing * side * 0.9 - run * 0.3;
        if (c.aiming && !armed && side < 0) ax = -0.6;
      }
      M.limb.copy(M.torso)
        .multiply(M.t.makeTranslation(-side * (0.22 * bw + 0.065), 0.6 * h, 0))
        .multiply(M.r.makeRotationX(ax))
        // az already carries the side sign; negating it spreads arms away from the body.
        .multiply(M.s.makeRotationZ(-az));
      M.out.copy(M.limb).multiply(M.s.makeScale(1, h, 1));
      this.put(this.parts.arm, M.out, a.shirt);
      this.put(this.parts.hand, M.out, a.skin);
      if (side > 0 && armed && c.state !== 'dead') {
        const wp = this.weapons.get(weapon);
        if (wp) {
          M.hand.copy(M.limb).multiply(M.t.makeTranslation(0, -0.6 * h, 0.02)).multiply(M.r.makeRotationX(Math.PI / 2));
          this.put(wp, M.hand, 0xffffff);
        }
      }
    }

    // Legs.
    for (const side of [-1, 1]) {
      let lx = swing * side;
      let lz = 0;
      if (c.state === 'dead') {
        lx = 0.05;
        lz = side * 0.22;
      } else if (lying) {
        lx = -0.4 + Math.sin(ph * 2 + side) * 0.3;
      } else if (swimming) {
        lx = Math.sin(ph * 2.5 + side * 1.5) * 0.35;
      } else if (airborne) {
        lx = side > 0 ? -0.9 : 0.3;
      }
      M.limb.copy(M.hip)
        .multiply(M.t.makeTranslation(-side * 0.11 * bw, 0, 0))
        .multiply(M.r.makeRotationX(lx))
        .multiply(M.s.makeRotationZ(-lz));
      M.out.copy(M.limb).multiply(M.s.makeScale(1, h, 1));
      this.put(this.parts.leg, M.out, a.pants);
      this.put(this.parts.shoe, M.out, 0x1a1a1a);
    }
  }
}
