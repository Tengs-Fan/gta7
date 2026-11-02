// The Lazy Q Ranch's horses and sheep (livestock.ts moves them), drawn: each animal is a few rigid parts, instanced across
// the herd, whose matrices are set each frame from its state, so a horse's head goes down to graze and comes up, its
// tail flicks and its legs swing in a walk, and a sheep nods over the grass, hops as it runs and trots back. A handful of
// draws, hidden past the county's reach; presentation only, they read the sim (its cars and its players) and write nothing.

import * as THREE from 'three';
import type { ViewState } from '../../sim/viewState';
import { rectCX, rectCZ } from '../../world/layout';
import { Rng } from '../../core/rng';
import { box, cyl, ModelBuilder } from '../furniture';
import { Flock, makeHorse, stepHorse, type Horse, type Threat } from './livestock';
import type { CountryView } from './index';

/** The coats, chestnut to grey. */
const COATS = [0x8d4a28, 0x26211f, 0xd8b268, 0x6a3a22, 0xb4b3ae] as const;
/** The neck's base, the tail's root and the hips and shoulders the legs swing from (horse frame: +z forward). */
const NECK = new THREE.Vector3(0, 1.38, 0.62);
const DOCK = new THREE.Vector3(0, 1.36, -0.88);
const LEGS = [[-0.17, 0.95, 0.5], [0.17, 0.95, 0.5], [-0.17, 0.95, -0.62], [0.17, 0.95, -0.62]] as const;
/** The head's greatest bow (rad) at the grass. */
const HEAD_BOW = 1.2;
/** The sheep's neck, where the head turns. */
const SHEEP_NECK = new THREE.Vector3(0, 0.66, 0.42);
/** The animals are not updated or drawn farther than this (m) from the ranch's middle. */
const REACH = 420;

const white = 0xffffff;

function horseBody(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('barrel', box(0.58, 0.66, 1.5, 0, 1.12, -0.05), white);
  b.add('chest', box(0.52, 0.72, 0.5, 0, 1.12, 0.55), white, 0.97);
  b.add('rump', box(0.54, 0.6, 0.52, 0, 1.2, -0.7), white, 0.97);
  b.add('belly', box(0.5, 0.2, 1.2, 0, 0.82, -0.05), white, 0.85);
  return b.build('horse-body');
}

/** The neck and head, built round the neck's base so they turn about it. */
function horseFront(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('neck', box(0.26, 0.74, 0.3, 0, 0.3, 0.2).rotateX(-0.62), white, 0.98);
  b.add('head', box(0.2, 0.26, 0.6, 0, 0.5, 0.62).rotateX(0.5), white);
  b.add('muzzle', box(0.17, 0.17, 0.18, 0, 0.3, 0.92).rotateX(0.5), 0x3a302c);
  for (const s of [-1, 1]) b.add('ear', box(0.05, 0.14, 0.05, s * 0.07, 0.72, 0.4), white, 0.9);
  b.add('mane', box(0.06, 0.62, 0.1, 0, 0.36, 0.02).rotateX(-0.62), 0x2a201a);
  return b.build('horse-front');
}

function horseTail(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('dock', box(0.1, 0.5, 0.1, 0, -0.25, -0.04).rotateX(-0.2), 0x2a201a);
  b.add('tuft', box(0.15, 0.5, 0.13, 0, -0.68, -0.14).rotateX(-0.2), 0x2a201a);
  return b.build('horse-tail');
}

/** A leg from the hip down. */
function horseLeg(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('upper', box(0.15, 0.5, 0.17, 0, -0.25, 0), white, 0.97);
  b.add('lower', box(0.1, 0.4, 0.1, 0, -0.7, 0), white, 0.9);
  b.add('hoof', box(0.12, 0.1, 0.15, 0, -0.9, 0.01), 0x1f1a17);
  return b.build('horse-leg');
}

function sheepBody(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('wool', new THREE.IcosahedronGeometry(0.42, 1).scale(0.78, 0.7, 1.15).translate(0, 0.62, 0), 0xefe9dc);
  b.add('rump', new THREE.IcosahedronGeometry(0.3, 1).translate(0, 0.62, -0.44), 0xe8e1d2);
  for (const [x, z] of [[-0.18, 0.3], [0.18, 0.3], [-0.18, -0.32], [0.18, -0.32]] as const) b.add('leg', cyl(0.035, 0.03, 0.38, 5, x, 0, z), 0x2e2724);
  return b.build('sheep-body');
}

/** The head, built round the neck so it turns about it. */
function sheepHead(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('head', box(0.17, 0.2, 0.27, 0, -0.03, 0.15), 0x3a312b);
  b.add('wool', new THREE.IcosahedronGeometry(0.1, 0).translate(0, 0.1, 0.05), 0xefe9dc);
  for (const s of [-1, 1]) b.add('ear', box(0.12, 0.04, 0.07, s * 0.13, 0.03, 0.06), 0x3a312b);
  return b.build('sheep-head');
}

export class RanchView {
  readonly flock: Flock;
  readonly horses: Horse[];
  private readonly rng = new Rng(0x40e5e);
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly horseBodies: THREE.InstancedMesh;
  private readonly horseFronts: THREE.InstancedMesh;
  private readonly horseTails: THREE.InstancedMesh;
  private readonly horseLegs: THREE.InstancedMesh;
  private readonly sheepBodies: THREE.InstancedMesh;
  private readonly sheepHeads: THREE.InstancedMesh;
  private readonly centre: { x: number; z: number };
  private readonly threats: Threat[] = [];
  private last = 0;
  private readonly m = new THREE.Matrix4();
  private readonly base = new THREE.Matrix4();
  private readonly part = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly p = new THREE.Vector3();

  constructor(private readonly view: CountryView) {
    const ranch = view.world.layout.country.valley.ranch;
    this.flock = new Flock(ranch.pasture, ranch.sheep, 0x5eed1);
    this.horses = ranch.horses.map((h, i) => makeHorse(h.x, h.z, h.coat, ranch.roam[h.paddock]!, 100 + i));
    this.centre = { x: rectCX(ranch.yard), z: rectCZ(ranch.pasture) };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85 });
    mat.name = 'ranch-animals';
    const make = (geo: THREE.BufferGeometry, count: number): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.name = geo.name;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // They move all over the paddocks: bound them by hand.
      mesh.frustumCulled = false;
      mesh.visible = false;
      view.moving.add(mesh);
      this.meshes.push(mesh);
      return mesh;
    };
    const n = this.horses.length;
    this.horseBodies = make(horseBody(), n);
    this.horseFronts = make(horseFront(), n);
    this.horseTails = make(horseTail(), n);
    this.horseLegs = make(horseLeg(), n * 4);
    this.sheepBodies = make(sheepBody(), this.flock.sheep.length);
    this.sheepHeads = make(sheepHead(), this.flock.sheep.length);
    const c = new THREE.Color();
    this.horses.forEach((h, i) => {
      c.setHex(COATS[h.coat]!);
      for (const mesh of [this.horseBodies, this.horseFronts, this.horseTails]) mesh.setColorAt(i, c);
      for (let k = 0; k < 4; k++) this.horseLegs.setColorAt(i * 4 + k, c);
    });
    // Each sheep a shade of its own.
    const rng = new Rng(0x5eed2);
    for (let i = 0; i < this.flock.sheep.length; i++) {
      c.setScalar(rng.range(0.82, 1.05));
      this.sheepBodies.setColorAt(i, c);
      this.sheepHeads.setColorAt(i, c.setScalar(rng.range(0.8, 1.15)));
    }
    for (const mesh of this.meshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** The cars and the people near the flock, as the flock sees them: those within the pasture's reach and a car's scare of it. */
  private gather(sim: ViewState): Threat[] {
    const t = this.threats;
    t.length = 0;
    const p = this.flock.pasture;
    const near = (x: number, z: number) => x > p.minX - 40 && x < p.maxX + 40 && z > p.minZ - 40 && z < p.maxZ + 40;
    for (const v of sim.vehicles) {
      if (v.removed || v.owner === 'parked' || !near(v.pos.x, v.pos.z)) continue;
      t.push({ x: v.pos.x, z: v.pos.z, speed: Math.hypot(v.vel.x, v.vel.z) });
    }
    for (const pl of sim.players) {
      const pos = pl.pos();
      if (near(pos.x, pos.z)) t.push({ x: pos.x, z: pos.z, speed: 0 });
    }
    return t;
  }

  /** Each frame at `time`, with the camera at (x, z) and the sim (null on a menu: no cars, no people). */
  update(time: number, x: number, z: number, sim: ViewState | null): void {
    const far = Math.hypot(this.centre.x - x, this.centre.z - z) > REACH;
    for (const mesh of this.meshes) mesh.visible = !far;
    this.last = far ? time : this.last;
    if (far) return;
    const dt = Math.min(0.1, Math.max(0, time - this.last));
    this.last = time;
    this.flock.update(dt, sim ? this.gather(sim) : []);
    for (const h of this.horses) stepHorse(h, dt, time, this.rng);
    this.setHorses();
    this.setSheep(time);
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  private place(x: number, z: number, heading: number, y = 0, lift = 0): THREE.Matrix4 {
    return this.base.compose(this.p.set(x, y + lift, z), this.q.setFromAxisAngle(this.up, heading), this.one);
  }

  private setHorses(): void {
    const ground = this.view.world;
    this.horses.forEach((h, i) => {
      const y = ground.baseGround(h.x, h.z);
      const bob = h.mode === 'walk' ? Math.abs(Math.sin(h.stride)) * 0.03 : 0;
      const base = this.place(h.x, h.z, h.heading, y, bob);
      this.horseBodies.setMatrixAt(i, base);
      // The head turns about the neck's base: down to graze, a little sway as it breathes, nodding at a walk.
      const nod = h.head * HEAD_BOW + (h.mode === 'walk' ? Math.sin(h.stride * 2) * 0.06 : 0);
      this.part.makeTranslation(NECK.x, NECK.y, NECK.z).multiply(this.m.makeRotationX(nod));
      this.horseFronts.setMatrixAt(i, this.m.copy(base).multiply(this.part));
      // The tail's root, swinging to one side and back.
      this.part.makeTranslation(DOCK.x, DOCK.y, DOCK.z).multiply(this.m.makeRotationZ(h.tail * 0.7)).multiply(this.m.makeRotationX(-0.1 + (h.mode === 'walk' ? Math.sin(h.stride) * 0.05 : 0)));
      this.horseTails.setMatrixAt(i, this.m.copy(base).multiply(this.part));
      // A walk's diagonal pairs: the near fore with the far hind.
      LEGS.forEach(([lx, ly, lz], k) => {
        const swing = h.mode === 'walk' ? Math.sin(h.stride + (k === 1 || k === 2 ? Math.PI : 0)) * 0.5 : 0;
        this.part.makeTranslation(lx, ly, lz).multiply(this.m.makeRotationX(swing));
        this.horseLegs.setMatrixAt(i * 4 + k, this.m.copy(base).multiply(this.part));
      });
    });
  }

  private setSheep(time: number): void {
    const ground = this.view.world;
    this.flock.sheep.forEach((s, i) => {
      const y = ground.baseGround(s.x, s.z);
      // A hop at a run, a slight roll at a walk.
      const hop = s.mode === 'run' ? Math.abs(Math.sin(time * 11 + s.phase)) * 0.22 : s.speed > 0 ? Math.abs(Math.sin(time * 4 + s.phase)) * 0.025 : 0;
      const base = this.place(s.x, s.z, s.heading, y, hop);
      this.sheepBodies.setMatrixAt(i, base);
      // The head down over the grass for a while, up to look round, with a chew's small nod.
      const grazing = s.mode === 'graze' && !s.wander;
      const nod = grazing ? (Math.sin(time * 0.31 + s.phase) > -0.25 ? 0.75 + Math.sin(time * 3 + s.phase) * 0.06 : 0.05) : s.mode === 'run' ? -0.15 : 0.1;
      this.part.makeTranslation(SHEEP_NECK.x, SHEEP_NECK.y, SHEEP_NECK.z).multiply(this.m.makeRotationX(nod));
      this.sheepHeads.setMatrixAt(i, this.m.copy(base).multiply(this.part));
    });
  }
}
