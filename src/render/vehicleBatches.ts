// Draws the repeated parts of every vehicle (tyres, rims, lamps, light bars, taxi signs, and the glass, fittings and
// bodies of far cars) as a few instanced meshes shared by all cars, instead of one draw per part per car. VehicleView
// keeps each part as an ordinary mesh (its transform, material and visibility stay the source of truth for the
// simulation-facing code and the tests); those meshes live on PART_LAYER, which no camera renders, and are copied in
// here every frame. A car fading out stays in the same draws: each instance carries its own fade.

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
  /** Drawn before the other transparent draws (the shade under the cars, under any glass seen over it). */
  first?: boolean;
}

interface Bucket {
  mesh: THREE.InstancedMesh;
  n: number;
  capacity: number;
  style: PartStyle;
  lamps: boolean;
  /** The part geometry the instances draw (the mesh draws it through a geometry of its own, see wrap). */
  geometry: THREE.BufferGeometry;
  /** The part material the instances draw, and the bucket's own copy of it that the mesh is drawn with. */
  source: THREE.Material;
  material: THREE.Material;
  key: string;
  /** Retires the bucket once its part material or geometry is disposed. */
  onGone: () => void;
}

/**
 * Whether a box part's material is plain (no maps or vertex colours): every such part, whatever its colour, glow or
 * finish, is drawn in one instanced draw that carries those per instance (lampMaterial).
 */
export function isPlainPart(m: THREE.Material): m is THREE.MeshStandardMaterial {
  return m instanceof THREE.MeshStandardMaterial && !m.map && !m.emissiveMap && !m.vertexColors && !m.transparent;
}

/**
 * Each instance keeps its `instanceFade` (0..1) share of its pixels through a 4x4 Bayer dither (as the characters do,
 * crowd.ts): a car fading out stays in the shared draws, opaque, with no extra draw and no other program.
 */
function fadeByInstance(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float instanceFade;\nvarying float vInstanceFade;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceFade = instanceFade;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
varying float vInstanceFade;
float partBayer4( vec2 frag ) {
  const float m[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  ivec2 p = ivec2( mod( floor( frag ), 4.0 ) );
  return ( m[ p.x + p.y * 4 ] + 0.5 ) / 16.0;
}`,
    )
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
if ( vInstanceFade < 1.0 && partBayer4( gl_FragCoord.xy ) >= vInstanceFade ) discard;`,
    );
}

/** One key for every bucket's copy, so a bucket made mid-game draws with a program its kind already compiled. */
const PART_PROGRAM_KEY = 'vehicle-part-fade';

/** The bucket's copy of a part material: the same surface, with the per-instance fade. */
function partMaterial(source: THREE.Material): THREE.Material {
  const m = source.clone();
  const own = source.onBeforeCompile;
  const ownKey = source.customProgramCacheKey();
  m.onBeforeCompile = (shader, renderer) => {
    own.call(source, shader, renderer);
    fadeByInstance(shader);
  };
  m.customProgramCacheKey = () => `${PART_PROGRAM_KEY}:${ownKey}`;
  return m;
}

/** Keeps a bucket's copy in step with what the views (and local reflections) do to the part material. */
function syncMaterial(to: THREE.Material, from: THREE.Material): void {
  to.opacity = from.opacity;
  to.visible = from.visible;
  if (to instanceof THREE.MeshStandardMaterial && from instanceof THREE.MeshStandardMaterial) {
    to.color.copy(from.color);
    to.emissive.copy(from.emissive);
    to.emissiveIntensity = from.emissiveIntensity;
    to.roughness = from.roughness;
    to.metalness = from.metalness;
    to.map = from.map;
    to.envMap = from.envMap;
    to.envMapIntensity = from.envMapIntensity;
  }
}

/** The shadow of the far bodies: three's depth material with the same per-instance fade. */
function partDepthMaterial(): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.name = 'vehicle-part-depth';
  m.onBeforeCompile = fadeByInstance;
  m.customProgramCacheKey = () => `${PART_PROGRAM_KEY}-depth`;
  return m;
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
    fadeByInstance(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 partEmissive;\nattribute vec2 partFinish;\nvarying vec3 vPartEmissive;\nvarying vec2 vPartFinish;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvPartEmissive = partEmissive;\nvPartFinish = partFinish;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPartEmissive;\nvarying vec2 vPartFinish;')
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vPartEmissive;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPartFinish.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPartFinish.y;');
  };
  m.customProgramCacheKey = () => `${PART_PROGRAM_KEY}-lamps`;
  return m;
}

/**
 * A geometry of the bucket's own over a part geometry: it shares the part's vertex buffers (uploaded once for every
 * bucket and view drawing them) and adds the per-instance attributes the bucket fills.
 */
function wrap(geometry: THREE.BufferGeometry, capacity: number, lamps: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geometry.attributes)) g.setAttribute(name, a);
  g.setIndex(geometry.index);
  for (const group of geometry.groups) g.addGroup(group.start, group.count, group.materialIndex);
  g.setDrawRange(geometry.drawRange.start, geometry.drawRange.count);
  g.setAttribute('instanceFade', new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1).setUsage(THREE.DynamicDrawUsage));
  if (lamps) {
    g.setAttribute('partEmissive', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('partFinish', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage));
  }
  return g;
}

/**
 * Frees a wrap geometry's own buffers. The shared ones are detached first: three deletes the buffers of every
 * attribute a disposed geometry holds, and the part geometry still draws with them.
 */
function release(g: THREE.BufferGeometry, part: THREE.BufferGeometry): void {
  const shared = new Set<unknown>(Object.values(part.attributes));
  for (const [name, a] of Object.entries(g.attributes)) if (shared.has(a)) g.deleteAttribute(name);
  g.setIndex(null);
  g.dispose();
}

const styleKey = (s: PartStyle): string => `${s.receiveShadow ? 'r' : ''}${s.castShadow ? 'c' : ''}${s.noContact ? 'n' : ''}${s.tinted ? 't' : ''}${s.first ? 'f' : ''}`;

export class VehiclePartBatches {
  readonly group = new THREE.Group();
  /** Buckets drawing a part's own (shared) material, by geometry, material and style. */
  private readonly shared = new Map<string, Bucket>();
  /** All plain box parts (smashed and charred gear, light bars, service gear). */
  private readonly lamps: Bucket;
  /**
   * Plain parts of a shape of their own (the lamp lenses), one draw per shape for every car, drawn like the box parts:
   * colour, glow and finish per instance.
   */
  private readonly shaped = new Map<THREE.BufferGeometry, Bucket>();
  private readonly lampMat = lampMaterial();
  private readonly depthMat = partDepthMaterial();
  private readonly tmp = new THREE.Matrix4();
  /** Buckets created or regrown since the last call to takeChanged (their meshes are new objects). */
  private changed = false;
  /** Buckets whose part material or geometry was disposed: retired at the next begin, after the frame they drew in. */
  private readonly retiring = new Set<Bucket>();
  /** Bucket materials retired since the last call to takeRetired. */
  private retired: THREE.Material[] = [];

  constructor() {
    this.group.name = 'vehicle-parts';
    this.lamps = this.bucket(UNIT_BOX, this.lampMat, {}, true, '');
  }

  /** Starts a frame: every bucket empties, and those of disposed parts are freed. */
  begin(): void {
    for (const b of this.retiring) this.retire(b);
    this.retiring.clear();
    for (const b of this.all()) b.n = 0;
  }

  /** Adds one instance of `geometry` drawn with `material` at `matrix` (world); `tint` for a tinted style; `fade` 0..1. */
  add(geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4, style: PartStyle = {}, tint?: THREE.Color, fade = 1): void {
    const key = `${geometry.uuid}:${material.uuid}:${styleKey(style)}`;
    let b = this.shared.get(key);
    if (!b) {
      b = this.bucket(geometry, material, style, false, key);
      this.shared.set(key, b);
    }
    const i = b.n;
    this.push(b, matrix, fade);
    if (style.tinted) (tint ?? WHITE).toArray(b.mesh.instanceColor!.array, i * 3);
  }

  /** Adds a box part: a unit box scaled to sx x sy x sz in the part's frame `matrix`; `fade` 0..1. */
  addBox(material: THREE.Material, matrix: THREE.Matrix4, sx: number, sy: number, sz: number, fade = 1): void {
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
      this.add(UNIT_BOX, material, m, {}, undefined, fade);
      return;
    }
    this.pushPlain(this.lamps, material, m, fade);
  }

  /**
   * Adds a part of shape `geometry` (shared by many cars, scaled and placed by `matrix`); `fade` 0..1. A plain material
   * joins the shape's one draw for every car, carrying its colour, glow and finish per instance (like addBox).
   */
  addShaped(geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4, fade = 1): void {
    if (!isPlainPart(material)) {
      this.add(geometry, material, matrix, {}, undefined, fade);
      return;
    }
    let b = this.shaped.get(geometry);
    if (!b) {
      b = this.bucket(geometry, this.lampMat, {}, true, '');
      this.shaped.set(geometry, b);
    }
    this.pushPlain(b, material, matrix, fade);
  }

  private pushPlain(b: Bucket, material: THREE.MeshStandardMaterial, matrix: THREE.Matrix4, fade: number): void {
    const i = b.n;
    this.push(b, matrix, fade);
    const mesh = b.mesh;
    material.color.toArray(mesh.instanceColor!.array, i * 3);
    const em = mesh.geometry.getAttribute('partEmissive') as THREE.InstancedBufferAttribute;
    const k = material.emissiveIntensity;
    em.setXYZ(i, material.emissive.r * k, material.emissive.g * k, material.emissive.b * k);
    (mesh.geometry.getAttribute('partFinish') as THREE.InstancedBufferAttribute).setXY(i, material.roughness, material.metalness);
  }

  /** Every bucket: the shared ones, the box parts' and the shaped parts'. */
  private all(): Bucket[] {
    return [...this.shared.values(), this.lamps, ...this.shaped.values()];
  }

  /** Ends a frame: uploads the instances added since begin and hides the empty buckets. */
  end(): void {
    for (const b of this.all()) {
      const mesh = b.mesh;
      mesh.count = b.n;
      mesh.visible = b.n > 0;
      if (b.n === 0) continue;
      if (!b.lamps) syncMaterial(b.material, b.source);
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

  /** The bucket materials freed since the last call (for the software tier to drop its stand-ins). */
  takeRetired(): THREE.Material[] {
    const r = this.retired;
    this.retired = [];
    return r;
  }

  /** Draw meshes and instances currently in use, for stats and tests. */
  get counts(): { meshes: number; instances: number; buckets: number } {
    let meshes = 0;
    let instances = 0;
    let buckets = 0;
    for (const b of this.all()) {
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
    for (const b of this.shared.values()) if (b.geometry === geometry) n += b.n;
    n += this.shaped.get(geometry)?.n ?? 0;
    return n;
  }

  /** The part geometry and material an instanced mesh of the batches draws (for tests). */
  partOf(mesh: THREE.Object3D): { geometry: THREE.BufferGeometry; material: THREE.Material } | null {
    for (const b of this.all()) if (b.mesh === mesh) return { geometry: b.geometry, material: b.source };
    return null;
  }

  dispose(): void {
    for (const b of this.all()) this.free(b);
    this.lampMat.dispose();
    this.depthMat.dispose();
    this.shared.clear();
    this.shaped.clear();
    this.retiring.clear();
    this.retired = [];
    this.lamps.n = 0;
  }

  /** Takes a bucket of a disposed part out of the batches and frees its mesh, geometry and material copy. */
  private retire(b: Bucket): void {
    if (this.shared.get(b.key) !== b) return;
    this.shared.delete(b.key);
    this.free(b);
    this.retired.push(b.material);
  }

  private free(b: Bucket): void {
    b.source.removeEventListener('dispose', b.onGone);
    b.geometry.removeEventListener('dispose', b.onGone);
    this.group.remove(b.mesh);
    b.mesh.dispose();
    release(b.mesh.geometry, b.geometry);
    if (!b.lamps) b.material.dispose();
  }

  /** The per-instance attributes of a bucket. */
  private attributes(b: Bucket): THREE.BufferAttribute[] {
    const g = b.mesh.geometry;
    const out: THREE.BufferAttribute[] = [b.mesh.instanceMatrix];
    if (b.mesh.instanceColor) out.push(b.mesh.instanceColor);
    out.push(g.getAttribute('instanceFade') as THREE.BufferAttribute);
    if (b.lamps) out.push(g.getAttribute('partEmissive') as THREE.BufferAttribute, g.getAttribute('partFinish') as THREE.BufferAttribute);
    return out;
  }

  private bucket(geometry: THREE.BufferGeometry, source: THREE.Material, style: PartStyle, lamps: boolean, key: string): Bucket {
    const material = lamps ? source : partMaterial(source);
    const b: Bucket = { mesh: this.instanced(geometry, material, START_CAPACITY, style, lamps), n: 0, capacity: START_CAPACITY, style, lamps, geometry, source, material, key, onGone: () => {} };
    if (!lamps) {
      b.onGone = () => this.retiring.add(b);
      source.addEventListener('dispose', b.onGone);
      geometry.addEventListener('dispose', b.onGone);
    }
    this.group.add(b.mesh);
    return b;
  }

  private instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, style: PartStyle, lamps: boolean): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(wrap(geometry, capacity, lamps), material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (lamps || style.tinted) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    mesh.name = 'vehicle-part';
    mesh.receiveShadow = style.receiveShadow === true;
    mesh.castShadow = style.castShadow === true;
    if (mesh.castShadow) mesh.customDepthMaterial = this.depthMat;
    if (style.noContact) mesh.userData.contactShadow = false;
    if (style.first) mesh.renderOrder = -1;
    // Instances span the whole city; GameRenderer only adds the parts of cars in view.
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    this.changed = true;
    return mesh;
  }

  private push(b: Bucket, matrix: THREE.Matrix4, fade: number): void {
    if (b.n >= b.capacity) this.grow(b);
    matrix.toArray(b.mesh.instanceMatrix.array as Float32Array, b.n * 16);
    (b.mesh.geometry.getAttribute('instanceFade').array as Float32Array)[b.n] = fade;
    b.n++;
  }

  private grow(b: Bucket): void {
    const capacity = b.capacity * 2;
    const old = b.mesh;
    // The bucket's material, not the mesh's: on software GPUs the mesh draws a stand-in, reapplied to new meshes.
    const grown = this.instanced(b.geometry, b.material, capacity, b.style, b.lamps);
    const from = this.attributes(b);
    const bigger = { ...b, mesh: grown };
    this.attributes(bigger).forEach((to, k) => {
      (to.array as Float32Array).set((from[k]!.array as Float32Array).subarray(0, b.n * to.itemSize));
    });
    this.group.remove(old);
    old.dispose();
    release(old.geometry, b.geometry);
    this.group.add(grown);
    b.mesh = grown;
    b.capacity = capacity;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
