import * as THREE from 'three';

/** About one city block: a batch stays large enough to amortise a draw but small enough to cull. */
export const STATIC_CHUNK_SIZE = 128;

export function spatialKey(x: number, z: number, size = STATIC_CHUNK_SIZE): string {
  return `${Math.floor(x / size)},${Math.floor(z / size)}`;
}

/**
 * Split a static, single-material triangle mesh without cutting its triangles or changing UVs,
 * normals, colours or custom attributes. Centroid ownership prevents duplicates at cell borders;
 * actual geometry bounds (not cell bounds) keep large triangles visible across those borders.
 * The input remains owned by the caller. Small / single-cell meshes are returned unchanged.
 */
export function spatialGeometry(source: THREE.BufferGeometry, size = STATIC_CHUNK_SIZE): THREE.BufferGeometry[] {
  const position = source.getAttribute('position');
  if (!position || position.count < 12 || !Number.isFinite(size)) return [source];
  const index = source.index;
  const count = index?.count ?? position.count;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < count; i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;
    const key = spatialKey((position.getX(a) + position.getX(b) + position.getX(c)) / 3, (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3, size);
    let vertices = buckets.get(key);
    if (!vertices) buckets.set(key, vertices = []);
    vertices.push(a, b, c);
  }
  if (buckets.size < 2) return [source];
  const out: THREE.BufferGeometry[] = [];
  for (const vertices of buckets.values()) {
    const geometry = new THREE.BufferGeometry();
    const remap = new Map<number, number>();
    const original: number[] = [];
    const indices = vertices.map((v) => {
      let n = remap.get(v);
      if (n === undefined) {
        n = original.length;
        original.push(v);
        remap.set(v, n);
      }
      return n;
    });
    for (const [name, attr] of Object.entries(source.attributes)) {
      // City geometry uses ordinary BufferAttributes, including its per-building aSeed.
      const values = new Float32Array(original.length * attr.itemSize);
      original.forEach((v, n) => {
        for (let k = 0; k < attr.itemSize; k++) values[n * attr.itemSize + k] = attr.getComponent(v, k);
      });
      geometry.setAttribute(name, new THREE.BufferAttribute(values, attr.itemSize));
    }
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    out.push(geometry);
  }
  return out;
}

/** Distance culling complements three's frustum culling on the software renderer. */
export class StaticVisibility {
  private readonly items: Array<{ object: THREE.Object3D; bounds: THREE.Box3 }> = [];

  add(object: THREE.Mesh, padding = 0): void {
    object.updateWorldMatrix(true, false);
    this.items.push({ object, bounds: new THREE.Box3().setFromObject(object).expandByScalar(padding) });
  }

  update(x: number, z: number, distance: number): void {
    const d2 = distance * distance;
    for (const { object, bounds } of this.items) {
      const dx = Math.max(bounds.min.x - x, 0, x - bounds.max.x);
      const dz = Math.max(bounds.min.z - z, 0, z - bounds.max.z);
      object.visible = dx * dx + dz * dz <= d2;
    }
  }
}

/**
 * A static single-material surface with a compact visible index list. Software GPUs pay dearly
 * for many draw submissions: this keeps one draw per material while retaining cell culling.
 * Vertex attributes never move; only indices change when the set of visible cells changes.
 * It is used without shadow maps, because its index selection belongs to the main camera.
 */
export class CulledStaticMesh extends THREE.Mesh {
  private readonly cells: Array<{ indices: number[]; bounds: THREE.Box3; sphere: THREE.Sphere; visible: boolean }> = [];
  private readonly indices: THREE.BufferAttribute;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, size = STATIC_CHUNK_SIZE) {
    super(geometry, material);
    this.frustumCulled = false;
    const p = geometry.getAttribute('position');
    const original = geometry.index;
    const count = original?.count ?? p.count;
    const cells = new Map<string, (typeof this.cells)[number]>();
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i += 3) {
      const a = original ? original.getX(i) : i;
      const b = original ? original.getX(i + 1) : i + 1;
      const c = original ? original.getX(i + 2) : i + 2;
      const key = spatialKey((p.getX(a) + p.getX(b) + p.getX(c)) / 3, (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3, size);
      let cell = cells.get(key);
      if (!cell) cells.set(key, cell = { indices: [], bounds: new THREE.Box3(), sphere: new THREE.Sphere(), visible: false });
      cell.indices.push(a, b, c);
      for (const j of [a, b, c]) cell.bounds.expandByPoint(v.fromBufferAttribute(p, j));
    }
    for (const cell of cells.values()) {
      cell.bounds.getBoundingSphere(cell.sphere);
      this.cells.push(cell);
    }
    this.indices = new THREE.BufferAttribute(p.count > 65535 ? new Uint32Array(count) : new Uint16Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setIndex(this.indices);
    geometry.setDrawRange(0, 0);
  }

  prepare(frustum: THREE.Frustum, x: number, z: number, distance: number): void {
    let changed = false;
    for (const cell of this.cells) {
      const b = cell.bounds;
      const dx = Math.max(b.min.x - x, 0, x - b.max.x);
      const dz = Math.max(b.min.z - z, 0, z - b.max.z);
      const visible = dx * dx + dz * dz <= distance * distance && frustum.intersectsSphere(cell.sphere);
      if (visible !== cell.visible) changed = true;
      cell.visible = visible;
    }
    if (!changed) return;
    let count = 0;
    const indices = this.indices.array as Uint16Array | Uint32Array;
    for (const cell of this.cells) {
      if (!cell.visible) continue;
      indices.set(cell.indices, count);
      count += cell.indices.length;
    }
    this.indices.clearUpdateRanges();
    this.indices.addUpdateRange(0, count);
    this.indices.needsUpdate = true;
    this.geometry.setDrawRange(0, count);
    this.visible = count > 0;
  }
}
