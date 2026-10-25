// Builds the drawable geometry of every look (looks.ts): the fitted model (boneMap.ts) recoloured into outfit slots,
// minus dropped parts, plus its accessories, merged into one indexed geometry so a character is one draw.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assets, type AssetLibrary } from '../assets';
import { accessory, type BodyMeasure } from './accessories';
import { restHands } from './hands';
import { fitCharacter, type FittedModel } from './boneMap';
import { LOOKS, type Look, type SlotName } from './looks';
import { BONE, REST, SLOT, type RigBone } from './rig';

export interface LookTemplate {
  look: Look;
  geometry: THREE.BufferGeometry;
  measure: BodyMeasure;
  /** The fitted model it was built from (rest pose). */
  model: FittedModel;
  /** Vertices of the body itself, first in the geometry (accessories follow). */
  bodyVertices: number;
}

const SLOT_OF: Readonly<Record<SlotName, number>> = SLOT;

function dominant(g: THREE.BufferGeometry, i: number): number {
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  let best = 0;
  let bw = -1;
  for (let k = 0; k < 4; k++) {
    const w = sw.getComponent(i, k);
    if (w > bw) {
      bw = w;
      best = si.getComponent(i, k);
    }
  }
  return best;
}

function boxOf(model: FittedModel, accept: (material: string, bone: number) => boolean): THREE.Box3 {
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const p of model.primitives) {
    const pos = p.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) if (accept(p.material, dominant(p.geometry, i))) b.expandByPoint(v.fromBufferAttribute(pos, i));
  }
  return b;
}

/** Ring of the trunk at height y (vertices on `bones` within dy): half width, front, back. */
function ring(model: FittedModel, y: number, dy: number, bones: readonly number[], maxX = 0.3): { x: number; front: number; back: number } {
  let x = 0;
  let front = -Infinity;
  let back = Infinity;
  const v = new THREE.Vector3();
  for (const p of model.primitives) {
    const pos = p.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (Math.abs(v.y - y) > dy || Math.abs(v.x) > maxX || !bones.includes(dominant(p.geometry, i))) continue;
      x = Math.max(x, Math.abs(v.x));
      front = Math.max(front, v.z);
      back = Math.min(back, v.z);
    }
  }
  if (!Number.isFinite(front)) return { x: 0.16, front: 0.11, back: -0.11 };
  return { x, front, back };
}

const SKIN_MATERIALS = new Set(['Skin', 'Skin_Darker']);
const EYE_MATERIALS = new Set(['Eye', 'Brown']);

export function measureBody(model: FittedModel): BodyMeasure {
  const head = BONE.head;
  const skull = boxOf(model, (m, b) => b === head && SKIN_MATERIALS.has(m));
  const headTop = boxOf(model, (_m, b) => b === head || b === BONE.neck);
  headTop.min.y = Math.max(headTop.min.y, skull.min.y);
  let eyes = boxOf(model, (m, b) => b === head && EYE_MATERIALS.has(m));
  if (eyes.isEmpty()) eyes = new THREE.Box3(new THREE.Vector3(-0.05, REST.head[1] + 0.1, 0.1), new THREE.Vector3(0.05, REST.head[1] + 0.12, 0.13));
  const beltY = REST.hips[1] + 0.1;
  const waist = ring(model, beltY, 0.02, [BONE.hips, BONE.abdomen]);
  const chestY = REST.chest[1] + 0.03;
  const chest = ring(model, chestY, 0.025, [BONE.torso, BONE.chest, BONE.abdomen], 0.26);
  const neck = ring(model, REST.neck[1] - 0.01, 0.03, [BONE.neck], 0.12);
  return {
    skull,
    headTop,
    eyeY: (eyes.min.y + eyes.max.y) / 2,
    eyeX: Math.max(0.03, (eyes.max.x - eyes.min.x) / 2 - 0.012),
    faceZ: eyes.max.z,
    beltY,
    waistX: waist.x,
    waistFront: waist.front,
    waistBack: waist.back,
    chestY,
    chestFront: chest.front,
    chestBack: chest.back,
    chestX: chest.x,
    neckR: Math.max(neck.x, (neck.front - neck.back) / 2),
  };
}

/** Attributes every character geometry has, for the batched crowd (all geometries in a BatchedMesh match). */
function withAttributes(g: THREE.BufferGeometry, color: THREE.Color, slot: number, bone: number | null): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  const vc = g.getAttribute('color');
  // A primitive's own vertex colours become a shade of its slot colour (seams, stitching), around 1.
  let mean = 1;
  if (vc && slot !== 0) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += (vc.getX(i) + vc.getY(i) + vc.getZ(i)) / 3;
    mean = Math.max(1e-3, sum / n);
  }
  for (let i = 0; i < n; i++) {
    if (vc && slot !== 0) {
      const shade = Math.min(1.25, (vc.getX(i) + vc.getY(i) + vc.getZ(i)) / 3 / mean);
      c[i * 3] = shade;
      c[i * 3 + 1] = shade;
      c[i * 3 + 2] = shade;
    } else if (slot !== 0) {
      c[i * 3] = 1;
      c[i * 3 + 1] = 1;
      c[i * 3 + 2] = 1;
    } else {
      c[i * 3] = color.r * (vc ? vc.getX(i) : 1);
      c[i * 3 + 1] = color.g * (vc ? vc.getY(i) : 1);
      c[i * 3 + 2] = color.b * (vc ? vc.getZ(i) : 1);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.getAttribute('position'));
  out.setAttribute('normal', g.getAttribute('normal'));
  out.setAttribute('color', new THREE.BufferAttribute(c, 3));
  out.setAttribute('slot', new THREE.BufferAttribute(new Float32Array(n).fill(slot), 1));
  if (bone === null) {
    const si = g.getAttribute('skinIndex');
    out.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(si.array as ArrayLike<number>), 4));
    out.setAttribute('skinWeight', g.getAttribute('skinWeight'));
  } else {
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = bone;
      sw[i * 4] = 1;
    }
    out.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    out.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  }
  out.setIndex(g.index ? Array.from(g.index.array) : Array.from({ length: n }, (_, i) => i));
  return out;
}

/** The model's own hands left out (triangles wholly on a hand bone): restHands replaces them. */
function withoutHands(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = g.index!;
  const keep: number[] = [];
  const onHand = (i: number) => {
    const b = dominant(g, i);
    return b === BONE.handL || b === BONE.handR;
  };
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    if (onHand(a) && onHand(b) && onHand(c)) continue;
    keep.push(a, b, c);
  }
  if (keep.length === index.count) return g;
  // Compact: only the vertices still used.
  const map = new Map<number, number>();
  const order: number[] = [];
  const ix = keep.map((v) => {
    let j = map.get(v);
    if (j === undefined) {
      j = order.length;
      map.set(v, j);
      order.push(v);
    }
    return j;
  });
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const Arr = a.array.constructor as new (len: number) => THREE.TypedArray;
    const arr = new Arr(order.length * a.itemSize) as unknown as number[];
    order.forEach((src, j) => {
      for (let k = 0; k < a.itemSize; k++) arr[j * a.itemSize + k] = a.getComponent(src, k);
    });
    out.setAttribute(name, new THREE.BufferAttribute(arr as unknown as THREE.TypedArray, a.itemSize, a.normalized));
  }
  out.setIndex(ix);
  return out;
}

export function buildLook(look: Look, model: FittedModel): LookTemplate {
  const measure = measureBody(model);
  const parts: THREE.BufferGeometry[] = [];
  for (const p of model.primitives) {
    if (look.drop?.includes(p.material)) continue;
    const g = withoutHands(p.geometry);
    if (g.index!.count === 0) continue;
    parts.push(withAttributes(g, p.color, SLOT_OF[look.slots[p.material] ?? 'fixed'], null));
  }
  for (const h of restHands()) parts.push(withAttributes(h.geometry, new THREE.Color(1, 1, 1), SLOT.skin, BONE[h.bone]));
  const bodyVertices = parts.reduce((n, g) => n + g.getAttribute('position').count, 0);
  for (const id of look.accessories) {
    for (const a of accessory(id, measure)) parts.push(withAttributes(a.geometry, new THREE.Color(a.color), a.slot, BONE[a.bone as RigBone]));
  }
  const geometry = mergeGeometries(parts, false);
  if (!geometry) throw new Error(`look ${look.id}: geometry attributes differ`);
  for (const p of parts) p.dispose();
  geometry.name = `look-${look.id}`;
  geometry.computeBoundingSphere();
  return { look, geometry, measure, model, bodyVertices };
}

/**
 * Every look's template, built from the loaded models, or null when any model the looks use is missing (Node tests,
 * failed load, ?assets=0): the crowd then draws the segment characters.
 */
export function buildLookTemplates(lib: AssetLibrary = assets): LookTemplate[] | null {
  // Built once per loaded set of models (every CrowdView of a session shares them; geometry is never mutated).
  const key = lib.model(LOOKS[0]!.model);
  if (key && cache?.key === key) return cache.templates;
  const models = new Map<string, FittedModel>();
  for (const look of LOOKS) {
    if (models.has(look.model)) continue;
    const entry = lib.entry(look.model);
    const scene = lib.clone(look.model);
    if (!entry?.bones || !scene) return null;
    const fitted = fitCharacter(look.model, scene, entry.bones);
    if (!fitted) return null;
    models.set(look.model, fitted);
  }
  const templates = LOOKS.map((look) => buildLook(look, models.get(look.model)!));
  cache = { key: key!, templates };
  return templates;
}

let cache: { key: object; templates: LookTemplate[] } | null = null;
