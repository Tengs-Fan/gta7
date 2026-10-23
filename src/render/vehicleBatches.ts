// Draws the repeated parts of every vehicle (tyres, rims, lamps, light bars, taxi signs, and the glass, fittings and
// bodies of far cars) as a few instanced meshes shared by all cars, instead of one draw per part per car. VehicleView
// keeps each part as an ordinary mesh (its transform, material and visibility stay the source of truth for the
// simulation-facing code and the tests); those meshes live on PART_LAYER, which no camera renders, and are copied in
// here every frame.

import * as THREE from 'three';

/** Layer of the per-vehicle part meshes drawn through VehiclePartBatches (no camera renders it). */
export const PART_LAYER = 30;
/**
 * Layer of meshes that only cast shadows (a vehicle's merged shadow body). three tests an object's layers against the
 * main camera in the shadow pass too, so GameRenderer enables this layer on the camera for the shadow pass only.
 */
export const SHADOW_LAYER = 29;

/** Drawn for every box-shaped part, scaled per instance to the part's own box. */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

const START_CAPACITY = 32;

/** How a batch of instances is drawn. */
export interface PartStyle {
  /** Lit by the sun's shadow. */
  receiveShadow?: boolean;
  /** Casts into the sun's shadow (far bodies). */
  castShadow?: boolean;
  /** Kept out of the contact-shadow pass (far cars). */
  noContact?: boolean;
  /** Tinted per instance (a far body's paint). */
  tinted?: boolean;
}

interface Bucket {
  mesh: THREE.InstancedMesh;
  n: number;
  capacity: number;
  style: PartStyle;
  lamps: boolean;
}

/**
 * Whether a box part's material is plain (no maps or vertex colours): every such part, whatever its colour, glow or
 * finish, is drawn in one instanced draw that carries those per instance (lampMaterial).
 */
export function isPlainPart(m: THREE.Material): m is THREE.MeshStandardMaterial {
  return m instanceof THREE.MeshStandardMaterial && !m.map && !m.emissiveMap && !m.vertexColors && !m.transparent;
}

/**
 * The material of the plain-parts draw: base colour from the instance colour, and the emissive colour (times its
 * intensity), roughness and metalness from per-instance attributes. Patched into the standard (or the software tier's
 * Lambert) shader, so every lamp state is one program.
 */
function lampMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff });
  m.name = 'vehicle-lamps';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 partEmissive;\nattribute vec2 partFinish;\nvarying vec3 vPartEmissive;\nvarying vec2 vPartFinish;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvPartEmissive = partEmissive;\nvPartFinish = partFinish;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPartEmissive;\nvarying vec2 vPartFinish;')
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vPartEmissive;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPartFinish.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPartFinish.y;');
  };
  return m;
}

const styleKey = (s: PartStyle): string => `${s.receiveShadow ? 'r' : ''}${s.castShadow ? 'c' : ''}${s.noContact ? 'n' : ''}${s.tinted ? 't' : ''}`;

export class VehiclePartBatches {
  readonly group = new THREE.Group();
  /** Buckets drawing a part's own (shared) material, by geometry, material and style. */
  private readonly shared = new Map<string, Bucket>();
  /** All plain box parts (lamps, smashed and charred lamps, light bars). */
  private readonly lamps: Bucket;
  private readonly lampMat = lampMaterial();
  private readonly tmp = new THREE.Matrix4();
  /** Buckets created or regrown since the last call to takeChanged (their meshes are new objects). */
  private changed = false;

  constructor() {
    this.group.name = 'vehicle-parts';
    this.lamps = this.bucket(UNIT_BOX, this.lampMat, {}, true);
  }

  /** Starts a frame: every bucket empties. */
  begin(): void {
    for (const b of this.shared.values()) b.n = 0;
    this.lamps.n = 0;
  }

  /** Adds one instance of `geometry` drawn with `material` at `matrix` (world); `tint` for a tinted style. */
  add(geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4, style: PartStyle = {}, tint?: THREE.Color): void {
    const key = `${geometry.uuid}:${material.uuid}:${styleKey(style)}`;
    let b = this.shared.get(key);
    if (!b) {
      b = this.bucket(geometry, material, style, false);
      this.shared.set(key, b);
    }
    const i = b.n;
    this.push(b, matrix);
    if (style.tinted) (tint ?? WHITE).toArray(b.mesh.instanceColor!.array, i * 3);
  }

  /** Adds a box part: a unit box scaled to sx x sy x sz in the part's frame `matrix`. */
  addBox(material: THREE.Material, matrix: THREE.Matrix4, sx: number, sy: number, sz: number): void {
    const m = this.tmp.copy(matrix);
    const e = m.elements;
    e[0]! *= sx;
    e[1]! *= sx;
    e[2]! *= sx;
    e[4]! *= sy;
    e[5]! *= sy;
    e[6]! *= sy;
    e[8]! *= sz;
    e[9]! *= sz;
    e[10]! *= sz;
    if (!isPlainPart(material)) {
      this.add(UNIT_BOX, material, m);
      return;
    }
    const b = this.lamps;
    const i = b.n;
    this.push(b, m);
    const mesh = b.mesh;
    material.color.toArray(mesh.instanceColor!.array, i * 3);
    const em = mesh.geometry.getAttribute('partEmissive') as THREE.InstancedBufferAttribute;
    const k = material.emissiveIntensity;
    em.setXYZ(i, material.emissive.r * k, material.emissive.g * k, material.emissive.b * k);
    (mesh.geometry.getAttribute('partFinish') as THREE.InstancedBufferAttribute).setXY(i, material.roughness, material.metalness);
  }

  /** Ends a frame: uploads the instances added since begin and hides the empty buckets. */
  end(): void {
    for (const b of [...this.shared.values(), this.lamps]) {
      const mesh = b.mesh;
      mesh.count = b.n;
      mesh.visible = b.n > 0;
      if (b.n === 0) continue;
      for (const a of this.attributes(b)) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, b.n * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  /** Whether buckets were created or regrown since the last call (their meshes are new objects). */
  takeChanged(): boolean {
    const c = this.changed;
    this.changed = false;
    return c;
  }

  /** Draw meshes and instances currently in use, for stats and tests. */
  get counts(): { meshes: number; instances: number; buckets: number } {
    let meshes = 0;
    let instances = 0;
    let buckets = 0;
    for (const b of [...this.shared.values(), this.lamps]) {
      buckets++;
      if (b.n > 0) {
        meshes++;
        instances += b.n;
      }
    }
    return { meshes, instances, buckets };
  }

  /** Instances drawn this frame with `geometry` (any material; box parts all draw the unit box). */
  instancesOf(geometry: THREE.BufferGeometry): number {
    let n = 0;
    for (const b of this.shared.values()) if (b.mesh.geometry === geometry) n += b.n;
    return n;
  }

  dispose(): void {
    for (const b of [...this.shared.values(), this.lamps]) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    this.lamps.mesh.geometry.dispose();
    this.lampMat.dispose();
    this.shared.clear();
    this.lamps.n = 0;
  }

  /** The per-instance attributes of a bucket. */
  private attributes(b: Bucket): THREE.BufferAttribute[] {
    const out: THREE.BufferAttribute[] = [b.mesh.instanceMatrix];
    if (b.mesh.instanceColor) out.push(b.mesh.instanceColor);
    if (b.lamps) out.push(b.mesh.geometry.getAttribute('partEmissive') as THREE.BufferAttribute, b.mesh.geometry.getAttribute('partFinish') as THREE.BufferAttribute);
    return out;
  }

  private bucket(geometry: THREE.BufferGeometry, material: THREE.Material, style: PartStyle, lamps: boolean): Bucket {
    const b: Bucket = { mesh: this.instanced(geometry, material, START_CAPACITY, style, lamps), n: 0, capacity: START_CAPACITY, style, lamps };
    this.group.add(b.mesh);
    return b;
  }

  private instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, style: PartStyle, lamps: boolean): THREE.InstancedMesh {
    let geo = geometry;
    if (lamps) {
      // Its own copy of the unit box, carrying the per-instance glow and finish.
      geo = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'uv'] as const) geo.setAttribute(name, UNIT_BOX.getAttribute(name).clone());
      geo.setIndex(UNIT_BOX.getIndex()!.clone());
      geo.setAttribute('partEmissive', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('partFinish', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage));
    }
    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (lamps || style.tinted) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    mesh.name = 'vehicle-part';
    mesh.receiveShadow = style.receiveShadow === true;
    mesh.castShadow = style.castShadow === true;
    if (style.noContact) mesh.userData.contactShadow = false;
    // Instances span the whole city; GameRenderer only adds the parts of cars in view.
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    this.changed = true;
    return mesh;
  }

  private push(b: Bucket, matrix: THREE.Matrix4): void {
    if (b.n >= b.capacity) this.grow(b);
    matrix.toArray(b.mesh.instanceMatrix.array as Float32Array, b.n * 16);
    b.n++;
  }

  private grow(b: Bucket): void {
    const capacity = b.capacity * 2;
    const old = b.mesh;
    const grown = this.instanced(b.lamps ? UNIT_BOX : old.geometry, old.material as THREE.Material, capacity, b.style, b.lamps);
    const from = this.attributes(b);
    const bigger = { ...b, mesh: grown };
    this.attributes(bigger).forEach((to, k) => {
      (to.array as Float32Array).set((from[k]!.array as Float32Array).subarray(0, b.n * to.itemSize));
    });
    if (b.lamps) old.geometry.dispose();
    this.group.remove(old);
    old.dispose();
    this.group.add(grown);
    b.mesh = grown;
    b.capacity = capacity;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
