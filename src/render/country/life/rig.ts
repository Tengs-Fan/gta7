// A rig without bones, for the countryside's few moving things (the dog's legs and head, the biplane's propeller, the
// combine's reel): every vertex carries its part's number and the part's pivot, and the material turns each part about
// its pivot by the angles (about x, y and z) its uniform holds for it. One merged mesh and one draw call a thing, however
// many parts it moves; the rest pose is the geometry as built.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Most parts a rig may have. */
export const RIG_PARTS = 8;

/** Collects parts, each with its pivot and its colour, into one geometry carrying `aPart` and `aPivot`. */
export class RigBuilder {
  private readonly geos: THREE.BufferGeometry[] = [];

  /** `geo` as part number `part`, turned about `pivot`, in `color` (scaled by `shade`). */
  add(part: number, pivot: readonly [number, number, number], geo: THREE.BufferGeometry, color: number, shade = 1): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    const n = g.getAttribute('position').count;
    const c = new THREE.Color(color).multiplyScalar(shade);
    const col = new Float32Array(n * 3);
    const pv = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col.set([c.r, c.g, c.b], i * 3);
      pv.set(pivot, i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPivot', new THREE.BufferAttribute(pv, 3));
    g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
    this.geos.push(g);
    return this;
  }

  build(name: string): THREE.BufferGeometry {
    const m = mergeGeometries(this.geos, false);
    if (!m) throw new Error(`${name}: mergeGeometries failed`);
    for (const g of this.geos) g.dispose();
    m.name = name;
    m.computeBoundingBox();
    m.computeBoundingSphere();
    return m;
  }
}

/** The rig's material and the angles (rad, about x, y, z) it turns each part by. */
export interface Rig {
  readonly material: THREE.MeshStandardMaterial;
  readonly pose: { value: THREE.Vector3[] };
}

/** Turns about x, then y, then z. */
const ROT = /* glsl */ `
uniform vec3 uRigPose[${RIG_PARTS}];
attribute float aPart;
attribute vec3 aPivot;
mat3 rigRot( vec3 a ) {
  float cx = cos( a.x ), sx = sin( a.x ), cy = cos( a.y ), sy = sin( a.y ), cz = cos( a.z ), sz = sin( a.z );
  return mat3(
    cz * cy, sz * cy, -sy,
    cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx,
    cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx );
}`;

/**
 * A vertex-coloured material that turns each part of a RigBuilder geometry by its entry of `pose`; `key` names its
 * program (the software tier's replacement runs the same patches on its Lambert).
 */
export function rigMaterial(key: string, params: THREE.MeshStandardMaterialParameters = {}): Rig {
  const pose = { value: Array.from({ length: RIG_PARTS }, () => new THREE.Vector3()) };
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, ...params });
  material.name = key;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRigPose = pose;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROT}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = rigRot( uRigPose[ int( aPart + 0.5 ) ] ) * objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = aPivot + rigRot( uRigPose[ int( aPart + 0.5 ) ] ) * ( transformed - aPivot );');
  };
  material.customProgramCacheKey = () => `gta7-rig-${key}`;
  return { material, pose };
}
