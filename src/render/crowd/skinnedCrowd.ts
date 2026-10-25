// Draws the recorded character poses (rig.ts) with the skinned models: the nearest few as SkinnedMeshes (one draw each
// per pass, three's own skinning, each with its bone texture), every other one through one BatchedMesh whose shader
// reads per-instance bone matrices from a shared float texture (one draw per pass for the whole crowd, whatever the
// number of people or looks). Both read the same per-character bone block, so a character moving between the two
// keeps his look and pose exactly.
import * as THREE from 'three';
import type { LookTemplate } from './characterModels';
import { BONES_PER_CHAR, FLOATS_PER_CHAR, poseBones, rigRoot, type RigPose } from './rig';
import { characterDepthMaterial, characterMaterial, crowdUniforms } from './shader';

/** SkinnedMeshes in the near pool, and how near the camera a character must be to get one (m). */
export const NEAR_MAX = 8;
export const NEAR_RANGE = 16;
/** Most characters the batched crowd draws. */
export const CROWD_MAX = 240;
/** Bounding radius about the pelvis of any pose (lying, arms overhead), for the crowd's per-instance culling. */
const POSE_RADIUS = 1.6;
const TEXTURE_WIDTH = 1024;

/** A skeleton whose bone matrices are written directly (rig.ts), never computed from bone objects. */
class DirectSkeleton extends THREE.Skeleton {
  override update(): void {
    // The matrices are already in boneMatrices; the texture upload is flagged where they are written.
  }
}

interface PoolSlot {
  mesh: THREE.SkinnedMesh;
  skeleton: DirectSkeleton;
  /** Character id drawn last frame (-1 none). */
  id: number;
  /** This slot's index in the pool. */
  index: number;
}

export interface SkinnedStats {
  near: number;
  crowd: number;
  /** Bone-matrix time of the last frame (ms), CPU. */
  boneMs: number;
}

export class SkinnedCrowd {
  readonly group = new THREE.Group();
  readonly nearMaterial = characterMaterial();
  readonly crowdMaterial = characterMaterial();
  readonly nearDepth = characterDepthMaterial();
  readonly crowdDepth = characterDepthMaterial();
  readonly pool: PoolSlot[] = [];
  readonly batched: THREE.BatchedMesh;
  readonly boneTexture: THREE.DataTexture;
  private readonly crowdData: Float32Array;
  private readonly geometryIds: number[] = [];
  private readonly root = new THREE.Vector3();
  private readonly instMatrix = new THREE.Matrix4();
  /** Crowd instances drawn last frame. */
  private drawn = 0;
  /** Per character id drawn this frame: 'near' pool slot or crowd instance (tests, browser checks). */
  readonly where = new Map<number, { near: boolean; index: number }>();
  /** The `where` values, reused frame to frame (valid until the next draw). */
  private readonly whereEntries: Array<{ near: boolean; index: number }> = [];
  private placed = 0;
  readonly stats: SkinnedStats = { near: 0, crowd: 0, boneMs: 0 };
  private warming = false;

  constructor(readonly templates: readonly LookTemplate[]) {
    this.group.name = 'skinned-characters';
    let vertices = 0;
    let indices = 0;
    for (const t of templates) {
      vertices += t.geometry.getAttribute('position').count;
      indices += t.geometry.index!.count;
    }
    this.batched = new THREE.BatchedMesh(CROWD_MAX, vertices, indices, this.crowdMaterial);
    this.batched.name = 'character-crowd';
    this.batched.sortObjects = false;
    this.batched.perObjectFrustumCulled = true;
    this.batched.castShadow = true;
    this.batched.receiveShadow = true;
    this.batched.customDepthMaterial = this.crowdDepth;
    this.batched.frustumCulled = false;
    const sphere = new THREE.Sphere();
    for (const t of templates) {
      const id = this.batched.addGeometry(t.geometry);
      this.geometryIds.push(id);
      // The cached bounds are the rest pose's; widen them to any pose about the pelvis (see rigRoot).
      this.batched.getBoundingSphereAt(id, sphere);
      const info = (this.batched as unknown as { _geometryInfo: Array<{ boundingSphere: THREE.Sphere | null }> })._geometryInfo[id];
      if (info?.boundingSphere) info.boundingSphere.set(new THREE.Vector3(0, 0.95, 0), POSE_RADIUS);
    }
    for (let i = 0; i < CROWD_MAX; i++) {
      const inst = this.batched.addInstance(this.geometryIds[0]!);
      this.batched.setVisibleAt(inst, false);
    }
    const rows = Math.ceil((CROWD_MAX * BONES_PER_CHAR * 4) / TEXTURE_WIDTH);
    this.crowdData = new Float32Array(TEXTURE_WIDTH * rows * 4);
    this.boneTexture = new THREE.DataTexture(this.crowdData, TEXTURE_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
    this.boneTexture.name = 'character-crowd-bones';
    this.boneTexture.needsUpdate = true;
    crowdUniforms.crowdBones.value = this.boneTexture;
    this.group.add(this.batched);

    for (let i = 0; i < NEAR_MAX; i++) {
      const bones = Array.from({ length: BONES_PER_CHAR }, () => new THREE.Bone());
      const skeleton = new DirectSkeleton(bones, bones.map(() => new THREE.Matrix4()));
      skeleton.computeBoneTexture();
      skeleton.boneTexture!.name = 'character-bones';
      const mesh = new THREE.SkinnedMesh(templates[0]!.geometry, this.nearMaterial);
      mesh.name = 'character-near';
      mesh.bindMode = THREE.DetachedBindMode;
      mesh.bind(skeleton, new THREE.Matrix4());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = this.nearDepth;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.pool.push({ mesh, skeleton, id: -1, index: this.pool.length });
    }
  }

  /** Index of a template's look in the batched geometry list (look index). */
  geometryOf(look: number): THREE.BufferGeometry {
    return (this.templates[look] ?? this.templates[0]!).geometry;
  }

  /**
   * Draws `n` recorded poses. The `near` of them nearest the camera (and inside NEAR_RANGE) get pool meshes, keeping the
   * slot they had; the rest go to the crowd.
   */
  draw(poses: readonly RigPose[], n: number, camX: number, camZ: number): void {
    if (this.warming) return;
    const t0 = performance.now();
    this.where.clear();
    this.placed = 0;
    // Nearest first, for the pool.
    const order = SCRATCH.order;
    order.length = 0;
    for (let i = 0; i < n; i++) {
      const p = poses[i]!;
      const e = SCRATCH.entries[i] ?? (SCRATCH.entries[i] = { i: 0, d: 0 });
      e.i = i;
      e.d = (p.pelvis.x - camX) ** 2 + (p.pelvis.z - camZ) ** 2;
      order.push(e);
    }
    order.sort((a, b) => a.d - b.d);
    const nearIds = SCRATCH.near;
    nearIds.clear();
    for (let k = 0; k < order.length && nearIds.size < NEAR_MAX; k++) {
      if (order[k]!.d > NEAR_RANGE * NEAR_RANGE) break;
      nearIds.add(order[k]!.i);
    }
    // Pool: characters already in a slot keep it.
    const slotOf = SCRATCH.slotOf;
    slotOf.clear();
    const free = SCRATCH.free;
    free.length = 0;
    const wanted = SCRATCH.wanted;
    wanted.clear();
    for (const i of nearIds) wanted.set(poses[i]!.id, i);
    for (const s of this.pool) {
      if (s.id >= 0 && wanted.has(s.id)) slotOf.set(wanted.get(s.id)!, s);
      else free.push(s);
    }
    for (const i of nearIds) {
      if (slotOf.has(i)) continue;
      const s = free.pop()!;
      slotOf.set(i, s);
    }
    for (const s of free) {
      s.id = -1;
      s.mesh.visible = false;
    }
    let crowd = 0;
    const batched = this.batched;
    for (let i = 0; i < n; i++) {
      const p = poses[i]!;
      rigRoot(p, this.root);
      const slot = slotOf.get(i);
      if (slot) {
        slot.id = p.id;
        const geo = this.geometryOf(p.look);
        if (slot.mesh.geometry !== geo) slot.mesh.geometry = geo;
        slot.mesh.position.copy(this.root);
        slot.mesh.visible = true;
        poseBones(p, slot.skeleton.boneMatrices!, 0, this.root);
        slot.skeleton.boneTexture!.needsUpdate = true;
        this.place(p.id, true, slot.index);
        continue;
      }
      if (crowd >= CROWD_MAX) continue;
      const inst = crowd++;
      poseBones(p, this.crowdData, inst * FLOATS_PER_CHAR, this.root);
      batched.setGeometryIdAt(inst, this.geometryIds[p.look] ?? this.geometryIds[0]!);
      batched.setMatrixAt(inst, this.instMatrix.makeTranslation(this.root.x, this.root.y, this.root.z));
      batched.setVisibleAt(inst, true);
      this.place(p.id, false, inst);
    }
    for (let i = crowd; i < this.drawn; i++) batched.setVisibleAt(i, false);
    this.drawn = crowd;
    if (crowd > 0) {
      // Only the rows the crowd uses this frame go up: the whole texture is 21 rows of floats, and uploading it every
      // frame cost about 0.7 ms of render JS in a busy plaza (40 batched characters use 4 rows).
      const rowFloats = TEXTURE_WIDTH * 4;
      const rows = Math.ceil((crowd * FLOATS_PER_CHAR) / rowFloats);
      // A frame whose batch was not drawn left its ranges unsent; only this frame's rows matter, so they replace them.
      this.boneTexture.clearUpdateRanges();
      for (let r = 0; r < rows; r++) this.boneTexture.addUpdateRange(r * rowFloats, rowFloats);
      this.boneTexture.needsUpdate = true;
    }
    this.stats.near = nearIds.size;
    this.stats.crowd = crowd;
    this.stats.boneMs = performance.now() - t0;
  }

  private place(id: number, near: boolean, index: number): void {
    const e = this.whereEntries[this.placed] ?? (this.whereEntries[this.placed] = { near, index });
    this.placed++;
    e.near = near;
    e.index = index;
    this.where.set(id, e);
  }

  /** The bone block a character was drawn with this frame (its pool skeleton or its crowd row), or null. */
  bonesOf(id: number): { data: Float32Array; offset: number; root: THREE.Vector3 } | null {
    const w = this.where.get(id);
    if (!w) return null;
    if (w.near) {
      const s = this.pool[w.index]!;
      return { data: s.skeleton.boneMatrices!, offset: 0, root: s.mesh.position.clone() };
    }
    const m = new THREE.Matrix4();
    this.batched.getMatrixAt(w.index, m);
    return { data: this.crowdData, offset: w.index * FLOATS_PER_CHAR, root: new THREE.Vector3().setFromMatrixPosition(m) };
  }

  /**
   * For the renderer's warm-up: one pool mesh and one crowd instance, whole and parked below the map, so both materials
   * (and their depth variants through probes) compile before play; restored by endWarmup.
   */
  beginWarmup(): THREE.Object3D[] {
    this.warming = true;
    const parked = SCRATCH.pose;
    const s = this.pool[0]!;
    s.mesh.visible = true;
    s.mesh.position.set(0, -60, 0);
    const block = new Float32Array(FLOATS_PER_CHAR);
    identityBlock(block);
    s.skeleton.boneMatrices!.set(block);
    s.skeleton.boneTexture!.needsUpdate = true;
    this.crowdData.set(block, 0);
    this.batched.setVisibleAt(0, true);
    this.batched.setMatrixAt(0, this.instMatrix.makeTranslation(0, -60, 0));
    this.boneTexture.needsUpdate = true;
    void parked;
    // The shadow passes draw them with the depth materials: compile those as surfaces of stand-ins.
    const nearProbe = new THREE.SkinnedMesh(this.templates[0]!.geometry, this.nearDepth);
    nearProbe.bindMode = THREE.DetachedBindMode;
    nearProbe.bind(s.skeleton, new THREE.Matrix4());
    nearProbe.position.set(0, -60, 0);
    nearProbe.frustumCulled = false;
    const crowdProbe = new THREE.BatchedMesh(1, this.templates[0]!.geometry.getAttribute('position').count, this.templates[0]!.geometry.index!.count, this.crowdDepth);
    crowdProbe.addInstance(crowdProbe.addGeometry(this.templates[0]!.geometry));
    crowdProbe.position.set(0, -60, 0);
    crowdProbe.frustumCulled = false;
    crowdProbe.perObjectFrustumCulled = false;
    return [nearProbe, crowdProbe];
  }

  endWarmup(probes: readonly THREE.Object3D[]): void {
    this.warming = false;
    this.pool[0]!.mesh.visible = false;
    this.pool[0]!.id = -1;
    this.batched.setVisibleAt(0, false);
    for (const p of probes) if (p instanceof THREE.BatchedMesh) p.dispose();
  }

  /** Hides everything (a frame with no skinned characters). */
  clear(): void {
    for (const s of this.pool) {
      s.id = -1;
      s.mesh.visible = false;
    }
    for (let i = 0; i < this.drawn; i++) this.batched.setVisibleAt(i, false);
    this.drawn = 0;
    this.where.clear();
  }
}

function identityBlock(out: Float32Array): void {
  out.fill(0);
  for (let b = 0; b < BONES_PER_CHAR; b++) {
    const o = b * 16;
    out[o] = 1;
    out[o + 5] = 1;
    out[o + 10] = 1;
    out[o + 15] = 1;
  }
  // Data: whole (fade 1), no lens dissolve, white slots.
  const d = (BONES_PER_CHAR - 2) * 16;
  out.fill(1, d, d + 32);
  out[d + 1] = 0;
}

const SCRATCH = {
  order: [] as Array<{ i: number; d: number }>,
  entries: [] as Array<{ i: number; d: number }>,
  free: [] as PoolSlot[],
  wanted: new Map<number, number>(),
  near: new Set<number>(),
  slotOf: new Map<number, PoolSlot>(),
  pose: null as RigPose | null,
};
