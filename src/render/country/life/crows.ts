// The crows (flocks.ts) as one instanced mesh, one draw whatever the flocks are doing. Each instance's matrix holds where
// the bird is and which way it faces, pitches and banks; its `aCrow` (how far its wings are open, the beat's phase and
// depth) is read by the material, which folds each wing down along the body when it is shut and swings it about the
// shoulder, the tip lagging, when it beats.

import * as THREE from 'three';
import type { Flock } from './flocks';
import { crowGeometry, SHOULDER } from './models';

/** A crow is drawn this much bigger than life, for its wings to be seen from the road. */
const SIZE = 1.15;

export class CrowsView {
  readonly mesh: THREE.InstancedMesh;
  private readonly aCrow: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(SIZE, SIZE, SIZE);

  constructor(capacity: number) {
    const geo = crowGeometry();
    this.aCrow = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCrow', this.aCrow);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, side: THREE.DoubleSide });
    mat.name = 'crows';
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWing;\nattribute vec3 aCrow;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
if ( aWing > 0.0 ) {
  // aCrow: how open the wing is, the beat's phase and its depth. The wing's angle about the shoulder (+ raises the tip):
  // shut, it hangs down along the body, a third of its length; open, it beats about a little above level, the tip further.
  float side = position.x > 0.0 ? 1.0 : -1.0;
  float beat = sin( aCrow.y ) * aCrow.z;
  float th = mix( -1.25, 0.12 + beat * ( 0.45 + 0.4 * aWing ), aCrow.x );
  float r = ( abs( position.x ) - ${SHOULDER.toFixed(2)} ) * mix( 0.3, 1.0, aCrow.x );
  transformed.x = side * ( ${SHOULDER.toFixed(2)} + r * cos( th ) );
  transformed.y = position.y + r * sin( th );
  transformed.z = position.z - aWing * aWing * beat * 0.05 * aCrow.x;
}`,
        );
    };
    mat.customProgramCacheKey = () => 'gta7-crows';
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.name = 'crows';
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** Draws the birds out of the flocks that are `shown` (each flock's first `count`); returns how many. */
  update(flocks: readonly Flock[], shown: readonly boolean[]): number {
    let n = 0;
    flocks.forEach((f, k) => {
      if (!shown[k]) return;
      for (let i = 0; i < f.count; i++) {
        const c = f.crows[i]!;
        this.e.set(c.peck - c.pitch, c.yaw, -c.bank);
        this.q.setFromEuler(this.e);
        this.m.compose(this.p.set(c.x, c.y, c.z), this.q, this.s);
        this.mesh.setMatrixAt(n, this.m);
        this.aCrow.setXYZ(n, c.open, c.flap, c.amp);
        n++;
      }
    });
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      for (const a of [this.mesh.instanceMatrix, this.aCrow]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
    return n;
  }
}
