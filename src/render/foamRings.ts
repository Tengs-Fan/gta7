// Foam rings spreading on the sea where something splashed: one instanced draw of flat quads that ride the sea's
// waves (the sea's own displacement, render/waves.ts), lit by the scene like the smoke layer.

import * as THREE from 'three';
import { WATER_Y } from '../world/constants';
import { SEA_WAVES_GLSL } from './waves';

const RING_VS = /* glsl */ `
attribute vec4 iRing;
varying vec2 vQ;
varying float vA;
#include <common>
#include <fog_pars_vertex>
${SEA_WAVES_GLSL}
void main() {
  vQ = position.xz;
  vA = iRing.w;
  vec2 p = iRing.xy + position.xz * iRing.z;
  vec3 d = uDisplace * seaDisplace(p);
  // A hand's breadth over the surface it follows, so the sea never cuts through it.
  vec4 mvPosition = viewMatrix * vec4(p.x + d.x, ${WATER_Y.toFixed(1)} + 0.05 + d.y, p.y + d.z, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RING_FS = /* glsl */ `
varying vec2 vQ;
varying float vA;
uniform vec3 uLight;
#include <common>
#include <fog_pars_fragment>
void main() {
  float r = length(vQ);
  float ring = smoothstep(0.5, 0.86, r) * (1.0 - smoothstep(0.88, 1.0, r));
  // Foam breaks up round the ring, and a faint film stays inside it.
  ring *= 0.7 + 0.3 * sin(atan(vQ.y, vQ.x) * 7.0 + r * 11.0);
  float a = vA * max(ring, 0.18 * (1.0 - smoothstep(0.6, 0.9, r)));
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(0.9, 0.94, 0.95) * uLight, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class FoamRings {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly iRing: Float32Array;
  private readonly x: Float32Array;
  private readonly z: Float32Array;
  private readonly radius: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly alpha: Float32Array;
  private next = 0;
  active = 0;
  /** The scene light the foam takes (Effects.setLight). */
  readonly light: THREE.Color;

  constructor(readonly max = 64) {
    const base = new THREE.PlaneGeometry(2, 2, 6, 6).rotateX(-Math.PI / 2);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.iRing = new Float32Array(max * 4);
    this.geo.setAttribute('iRing', new THREE.InstancedBufferAttribute(this.iRing, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: RING_VS,
      fragmentShader: RING_FS,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uLight: { value: new THREE.Color(1, 1, 1) }, uWavePhase: { value: new THREE.Vector4() }, uSeaAmp: { value: 0 }, uDisplace: { value: 0 }, uSeaOrigin: { value: new THREE.Vector2() } },
      ]),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.light = this.mat.uniforms.uLight!.value as THREE.Color;
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    const f = () => new Float32Array(max);
    this.x = f();
    this.z = f();
    this.radius = f();
    this.age = f();
    this.life = f();
    this.alpha = f();
  }

  /** Shares the sea's wave uniforms, so the rings ride the waves the sea draws. Before the first render. */
  bindSea(u: { uWavePhase: THREE.IUniform; uSeaAmp: THREE.IUniform; uDisplace: THREE.IUniform; uSeaOrigin: THREE.IUniform }): void {
    Object.assign(this.mat.uniforms, { uWavePhase: u.uWavePhase, uSeaAmp: u.uSeaAmp, uDisplace: u.uDisplace, uSeaOrigin: u.uSeaOrigin });
  }

  /** A ring at (x, z) on the sea spreading to `radius` m over `life` s. */
  add(x: number, z: number, radius: number, life: number, alpha = 0.8): void {
    if (radius <= 0 || life <= 0) return;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.x[i] = x;
    this.z[i] = z;
    this.radius[i] = radius;
    this.age[i] = 0;
    this.life[i] = life;
    this.alpha[i] = alpha;
  }

  update(dt: number): void {
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (!(this.life[i]! > 0)) continue;
      this.age[i] = this.age[i]! + dt;
      const t = this.age[i]! / this.life[i]!;
      if (t >= 1) {
        this.life[i] = 0;
        continue;
      }
      // Fast at first, slowing as it spreads; fading as it goes.
      const grow = 1 - (1 - t) * (1 - t);
      this.iRing[n * 4] = this.x[i]!;
      this.iRing[n * 4 + 1] = this.z[i]!;
      this.iRing[n * 4 + 2] = Math.max(0.05, this.radius[i]! * grow);
      this.iRing[n * 4 + 3] = this.alpha[i]! * Math.min(1, t * 10) * (1 - t * t);
      n++;
    }
    this.active = n;
    this.geo.instanceCount = n;
    (this.geo.getAttribute('iRing') as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.next = 0;
    this.active = 0;
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
