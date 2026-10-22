// Rain streaks: one instanced draw of thin quads in a box that wraps round the camera. Every drop's place is a hash
// of its seed folded into the box on the GPU, so the CPU only sets uniforms each frame. Streaks stretch along the
// drop's motion relative to the camera, are lit by the scene's light level (dim at night) and are not drawn under
// any roof of the cover map (rainCover.ts).

import * as THREE from 'three';
import type { CoverMap } from './rainCover';

/** Instances allocated: High's count. Lower tiers draw a prefix of them. */
export const RAIN_CAPACITY = 6000;
/** Drops drawn by a software rasteriser, whatever the tier. */
export const SOFTWARE_RAIN_DROPS = 500;
/** The wrapping box round the camera (m): x and z centred on it, y from RAIN_BELOW under it. */
export const RAIN_BOX = { x: 48, y: 30, z: 48 } as const;
const RAIN_BELOW = 12;
/** Fall speed (m/s) and the share of the wind that slants it. */
const FALL = 9;
const WIND_SLANT = 0.6;
/** World width of a streak (m); far drops widen to a pixel and fade to match. */
const STREAK_WIDTH = 0.014;
/** Camera speeds above this (m/s) are a cut or a teleport, not motion. */
const MAX_CAM_SPEED = 60;
/** Linear colour of a streak in full daylight (times Environment.smokeLight). */
const RAIN_COLOR = new THREE.Color(0.72, 0.76, 0.82);

const RAIN_VS = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCam;
uniform vec3 uOffset;
uniform vec3 uVel;
uniform vec3 uCamVel;
uniform float uRain;
uniform float uPx;
uniform sampler2D uCover;
uniform vec4 uCoverRect;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_vertex>
const vec3 BOX = vec3(${RAIN_BOX.x.toFixed(1)}, ${RAIN_BOX.y.toFixed(1)}, ${RAIN_BOX.z.toFixed(1)});
const vec3 LOW = vec3(${(RAIN_BOX.x / 2).toFixed(1)}, ${RAIN_BELOW.toFixed(1)}, ${(RAIN_BOX.z / 2).toFixed(1)});
void main() {
  vUv = position.xy;
  vAlpha = 0.0;
  // Outside the clip volume: dropped before rasterising.
  gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
  // Lighter rain draws fewer drops (and fainter ones, below).
  if ( aSeed.w >= uRain ) return;
  vec3 base = uCam - LOW;
  vec3 p = base + mod( aSeed.xyz * BOX + uOffset - base, BOX );
  float roof = texture2D( uCover, ( p.xz - uCoverRect.xy ) * uCoverRect.zw ).r;
  if ( p.y < roof ) return;
  vec3 rel = uVel - uCamVel;
  float speed = length( rel );
  vec3 dir = rel / max( speed, 0.001 );
  float len = clamp( speed * ( 0.045 + 0.03 * fract( aSeed.w * 13.7 ) ), 0.25, 3.0 );
  vec3 q = p - dir * len * position.y;
  vec3 toCam = q - uCam;
  float d = length( toCam );
  vec3 side = cross( dir, toCam );
  side /= max( length( side ), 0.0001 );
  float w = max( ${STREAK_WIDTH}, d * uPx * 0.75 );
  q += side * position.x * w;
  float hd = length( p.xz - uCam.xz );
  float top = base.y + BOX.y;
  vAlpha = ( ${STREAK_WIDTH} / w )
    * ( 1.0 - smoothstep( 15.0, ${(RAIN_BOX.x / 2 - 0.5).toFixed(1)}, hd ) )
    * smoothstep( 0.6, 2.0, d )
    * smoothstep( 0.0, 3.0, p.y - base.y ) * smoothstep( 0.0, 3.0, top - p.y )
    * ( 0.55 + 0.45 * uRain );
  vec4 mvPosition = viewMatrix * vec4( q, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RAIN_FS = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  float a = vAlpha * ( 1.0 - abs( vUv.x ) ) * sin( 3.14159265 * vUv.y ) * 0.55;
#ifdef USE_FOG
  #ifdef FOG_EXP2
    a *= exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    a *= 1.0 - smoothstep( fogNear, fogFar, vFogDepth );
  #endif
#endif
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( uColor, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** A float texture of the cover map (nearest filtered: a roof edge stays sharp to the cell). */
export function coverTexture(map: CoverMap): THREE.DataTexture {
  const t = new THREE.DataTexture(map.data, map.width, map.height, THREE.RedFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** (minX, minZ, 1 / width in m, 1 / depth in m): world x/z to cover-map texture coordinates. */
export function coverRect(map: CoverMap): THREE.Vector4 {
  return new THREE.Vector4(map.minX, map.minZ, 1 / (map.width * map.cell), 1 / (map.height * map.cell));
}

/** Deterministic seeds in [0, 1): xyz the place in the box, w the rain intensity from which the drop is drawn. */
function seeds(n: number): Float32Array {
  const out = new Float32Array(n * 4);
  let s = 0x2545f491;
  for (let i = 0; i < out.length; i++) {
    // mulberry32
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return out;
}

export class Rain {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly cover: THREE.DataTexture;
  readonly coverRect: THREE.Vector4;
  private count = 0;
  private readonly lastCam = new THREE.Vector3();
  private hasLast = false;
  private readonly camVel = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();

  constructor(map: CoverMap) {
    this.cover = coverTexture(map);
    this.coverRect = coverRect(map);
    const geo = new THREE.InstancedBufferGeometry();
    // x across the streak (-1..1), y along it (0 at the drop, 1 at the end of its trail).
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(RAIN_CAPACITY), 4));
    geo.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      vertexShader: RAIN_VS,
      fragmentShader: RAIN_FS,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uCam: { value: new THREE.Vector3() },
          uOffset: { value: new THREE.Vector3() },
          uVel: { value: new THREE.Vector3(0, -FALL, 0) },
          uCamVel: { value: new THREE.Vector3() },
          uRain: { value: 0 },
          uPx: { value: 0.001 },
          uCover: { value: null },
          uCoverRect: { value: new THREE.Vector4() },
          uColor: { value: RAIN_COLOR.clone() },
        },
      ]),
      fog: true,
      transparent: true,
      depthWrite: false,
    });
    // merge() clones its values: the texture and rectangle are set after it, so they stay shared.
    material.uniforms.uCover!.value = this.cover;
    material.uniforms.uCoverRect!.value = this.coverRect;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = 'rain';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  /** Drops drawn at full rain (the tier's TierSpec.rainDrops, or SOFTWARE_RAIN_DROPS). */
  setCount(n: number): void {
    this.count = Math.max(0, Math.min(RAIN_CAPACITY, Math.floor(n)));
    this.mesh.geometry.instanceCount = this.count;
  }

  get capacity(): number {
    return this.count;
  }

  /** Streak instances drawn this frame: the tier's count while it rains, else 0. */
  get drops(): number {
    return this.mesh.visible ? this.count : 0;
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.mesh.material.uniforms;
  }

  /**
   * One frame: `rain` 0..1, `wind` in m/s, `light` the scene's light level (Environment.smokeLight) and `pixelAngle`
   * 2 tan(fov / 2) / drawing-buffer height, a pixel's width 1 m away.
   */
  update(dt: number, camera: THREE.Vector3, rain: number, wind: { x: number; z: number }, light: THREE.Color, pixelAngle: number): void {
    const u = this.mesh.material.uniforms;
    if (dt > 0) {
      if (this.hasLast && camera.distanceTo(this.lastCam) < MAX_CAM_SPEED * dt + 0.5) {
        this.target.subVectors(camera, this.lastCam).divideScalar(dt);
        if (this.target.length() > MAX_CAM_SPEED) this.target.setLength(MAX_CAM_SPEED);
      } else {
        this.target.set(0, 0, 0);
        this.camVel.set(0, 0, 0);
      }
      this.camVel.lerp(this.target, 1 - Math.exp(-dt * 10));
    }
    this.lastCam.copy(camera);
    this.hasLast = true;
    const vel = u.uVel!.value as THREE.Vector3;
    vel.set(wind.x * WIND_SLANT, -FALL, wind.z * WIND_SLANT);
    // Integrated here in double precision and wrapped to the box, so the drops never lose float precision and a change
    // of wind bends them rather than jumping.
    const o = this.offset;
    o.x = wrap(o.x + vel.x * dt, RAIN_BOX.x);
    o.y = wrap(o.y + vel.y * dt, RAIN_BOX.y);
    o.z = wrap(o.z + vel.z * dt, RAIN_BOX.z);
    (u.uOffset!.value as THREE.Vector3).copy(o);
    (u.uCam!.value as THREE.Vector3).copy(camera);
    (u.uCamVel!.value as THREE.Vector3).copy(this.camVel);
    const r = Math.max(0, Math.min(1, rain));
    u.uRain!.value = r;
    u.uPx!.value = pixelAngle;
    (u.uColor!.value as THREE.Color).copy(RAIN_COLOR).multiply(light);
    this.mesh.visible = r > 0.002 && this.count > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.cover.dispose();
  }
}

function wrap(v: number, m: number): number {
  const r = v % m;
  return r < 0 ? r + m : r;
}
