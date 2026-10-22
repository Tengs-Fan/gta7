// The sea surface: the Gerstner waves (render/waves.ts) and the analytic shoreline patched into the sea's
// standard material, the camera-snapped wave grid drawn on High, and the software sea's shader.

import * as THREE from 'three';
import { BEACH_W, CURB_H, SAND_DROP, SEABED_Y, WATER_Y } from '../world/constants';
import type { Bounds } from '../world/layout';
import { CALM_SEA, COARSE_CELL, COARSE_EXTENT, FINE_EXTENT, SEA_SLOPE2_GLSL, SEA_WAVES_GLSL, SKIRT_EXTENT, wavePhases } from './waves';

/** The sand's drop-off into deep water past the beach's end (CityView.buildCoast), m. */
const DROP_OFF = 25;
/** Shallows colour over sand, and the wet sand seen through the thinnest water (sRGB). */
const SHALLOW = 0x2fa8a6;
const SAND_TINT = 0x9c9475;

/** Uniforms shared by every material that follows the sea: the sea itself and the foam rings on it. */
export interface SeaUniforms {
  uWavePhase: { value: THREE.Vector4 };
  uSeaAmp: { value: number };
  uDisplace: { value: number };
  uSeaOrigin: { value: THREE.Vector2 };
  /** Surf bands' phase (rad, wrapped) and the foam noise's drift. */
  uSurfPhase: { value: number };
  uFoamDrift: { value: THREE.Vector2 };
  /** landMinX, landMinZ, landMaxZ, beachEndX. */
  uShoreLand: { value: THREE.Vector4 };
  /** beachStartX, BEACH_W, SAND_DROP, CURB_H. */
  uShoreBeach: { value: THREE.Vector4 };
  uShallow: { value: THREE.Color };
  uSandTint: { value: THREE.Color };
}

export function seaUniforms(): SeaUniforms {
  return {
    uWavePhase: { value: new THREE.Vector4() },
    uSeaAmp: { value: CALM_SEA },
    uDisplace: { value: 0 },
    uSeaOrigin: { value: new THREE.Vector2() },
    uSurfPhase: { value: 0 },
    uFoamDrift: { value: new THREE.Vector2() },
    // No land until setShore: deep water everywhere.
    uShoreLand: { value: new THREE.Vector4(1e6, 1e6, -1e6, -1e6) },
    uShoreBeach: { value: new THREE.Vector4(1e6, BEACH_W, SAND_DROP, CURB_H) },
    uShallow: { value: new THREE.Color(SHALLOW) },
    uSandTint: { value: new THREE.Color(SAND_TINT) },
  };
}

/** Feeds the shoreline the layout's land rectangle and beach (staticWorld.baseGround's terrain). */
export function setShore(u: SeaUniforms, b: Bounds): void {
  u.uShoreLand.value.set(b.landMinX, b.landMinZ, b.landMaxZ, b.beachEndX);
  u.uShoreBeach.value.set(b.beachStartX, BEACH_W, SAND_DROP, CURB_H);
}

const tmpPhases = [0, 0, 0, 0];
const SURF_RATE = 1.2;

/** Per frame: the waves' phases at renderer time `time`, the sea state, and the grid's centre. */
export function updateSea(u: SeaUniforms, time: number, seaState: number, originX: number, originZ: number): void {
  const p = wavePhases(time, tmpPhases);
  u.uWavePhase.value.set(p[0]!, p[1]!, p[2]!, p[3]!);
  u.uSeaAmp.value = Math.min(1, Math.max(0, seaState));
  u.uSeaOrigin.value.set(originX, originZ);
  u.uSurfPhase.value = (time * SURF_RATE) % (Math.PI * 2);
  u.uFoamDrift.value.set((time * 0.013) % 1, (time * 0.009) % 1);
}

const n = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * Water depth over the analytic terrain (staticWorld.baseGround): the beach's sand slope and its drop-off, deep
 * water elsewhere. Off the beach's ends the sand fades into the deep over SHORE_BLEND m so the shallows do not
 * end in a hard edge.
 */
export const SHORE_GLSL = /* glsl */ `
uniform vec4 uShoreLand;
uniform vec4 uShoreBeach;
uniform float uSurfPhase;
uniform vec2 uFoamDrift;
uniform vec3 uShallow;
uniform vec3 uSandTint;
float seaBeachOut(vec2 p) {
  vec2 c = vec2(clamp(p.x, uShoreBeach.x, uShoreLand.w + ${n(DROP_OFF)}), clamp(p.y, uShoreLand.y, uShoreLand.z));
  return length(p - c);
}
float seaDepthAt(vec2 p) {
  float x = clamp(p.x, uShoreBeach.x, uShoreLand.w + ${n(DROP_OFF)});
  float endY = uShoreBeach.w - uShoreBeach.z;
  float sand = x <= uShoreLand.w
    ? uShoreBeach.w - (x - uShoreBeach.x) / uShoreBeach.y * uShoreBeach.z
    : mix(endY, ${n(SEABED_Y)}, (x - uShoreLand.w) / ${n(DROP_OFF)});
  float shelf = ${n(WATER_Y)} - sand;
  return mix(shelf, ${n(WATER_Y - SEABED_Y)}, smoothstep(0.0, 40.0, seaBeachOut(p)));
}
/** Distance outside the land rectangle (0 inside), and how much of it is a quay wall rather than the beach. */
float seaQuay(vec2 p) {
  float dx = max(max(uShoreLand.x - p.x, p.x - uShoreLand.w), 0.0);
  float dz = max(max(uShoreLand.y - p.y, p.y - uShoreLand.z), 0.0);
  return length(vec2(dx, dz));
}
float seaWaterlineX() {
  return uShoreBeach.x + uShoreBeach.y * (uShoreBeach.w - ${n(WATER_Y)}) / uShoreBeach.z;
}
/** Foam 0..1: surf bands moving shoreward over the beach, and a pulsing strip along the quay walls. */
float seaFoam(vec2 p, float depth, float noise, float sea) {
  float onBeach = 1.0 - smoothstep(0.0, 4.0, seaBeachOut(p));
  float reach = 0.6 + 0.9 * sea;
  float shore = 1.0 - smoothstep(0.0, reach, depth);
  float band = 0.5 + 0.5 * sin(depth * 12.566 + uSurfPhase + noise * 2.0);
  float bands = smoothstep(0.55, 0.9, band + (noise - 0.5) * 0.5) * shore;
  float swash = 1.0 - smoothstep(0.0, 0.05 + 0.08 * sea, depth);
  float beach = clamp((bands * (0.55 + 0.6 * sea) + swash * 0.8) * onBeach, 0.0, 1.0);
  float d = seaQuay(p);
  float width = 0.5 + 1.0 * smoothstep(0.3, 0.7, noise);
  float pulse = 0.8 + 0.2 * sin(uSurfPhase * 1.4 + (p.x + p.y) * 0.21);
  float notBeach = 1.0 - smoothstep(seaWaterlineX() - 5.0, seaWaterlineX() + 10.0, p.x);
  float quay = (1.0 - smoothstep(width * 0.4, width, d)) * step(1e-3, d) * pulse * notBeach * (0.85 + 0.3 * sea) * (0.75 + 0.5 * noise);
  return clamp(max(beach, quay), 0.0, 1.0);
}
/** The sea's albedo over the shallows: wet sand through the thinnest water, turquoise, then the deep colour. */
vec3 seaShallows(vec3 deep, float depth) {
  vec3 c = mix(uShallow, deep, smoothstep(0.0, 4.0, depth));
  return mix(uSandTint, c, smoothstep(0.0, 0.45, depth));
}
`;

/**
 * Patches the sea's (already ripple-patched) standard material: world-anchored ripple UVs (the mesh follows the
 * camera), vertex displacement scaled by uDisplace, the wave slopes added to the ripple normal, the shallows' colour
 * and foam. Only uniforms change at runtime: the grid on or off and the sea state never rebuild the program.
 */
export function patchSeaMaterial(mat: THREE.MeshStandardMaterial, u: SeaUniforms): void {
  const ripples = mat.onBeforeCompile.bind(mat);
  const key = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    ripples(shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SEA_WAVES_GLSL}\nattribute vec2 aEdge;\nvarying vec2 vSeaXZ;`)
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
  vec4 seaBase = modelMatrix * vec4( position, 1.0 );
  vSeaXZ = seaBase.xz;
#ifdef USE_NORMALMAP
  // The ripple tile is anchored to the world (one plane 6 km across had UV 0..1), not to the moving mesh.
  vNormalMapUv = ( normalMapTransform * vec3( seaBase.x / 6000.0 + 0.5, 0.5 - seaBase.z / 6000.0, 1.0 ) ).xy;
#endif`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed += uDisplace * seaDisplaceEdge( seaBase.xz, aEdge );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${SEA_WAVES_GLSL}\n${SHORE_GLSL}\nvarying vec2 vSeaXZ;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float seaDepth = seaDepthAt( vSeaXZ );
  float seaFoamAmt = 0.0;
#ifdef USE_NORMALMAP
  {
    vec2 fuv = vSeaXZ * 0.031 + uFoamDrift;
    float seaNoise = texture2D( normalMap, fuv ).x * 0.6 + texture2D( normalMap, fuv * 2.37 + 0.31 ).y * 0.4;
    seaFoamAmt = seaFoam( vSeaXZ, seaDepth, seaNoise, uSeaAmp );
  }
#endif
  diffuseColor.rgb = mix( seaShallows( diffuseColor.rgb, seaDepth ), vec3( 0.82, 0.86, 0.86 ), seaFoamAmt );`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix( roughnessFactor, 0.85, seaFoamAmt );')
      .replace(
        '#include <emissivemap_fragment>',
        `{
    vec2 seaS = seaSlope( vSeaXZ, distance( cameraPosition.xz, vSeaXZ ) ) * ( 1.0 - 0.6 * seaFoamAmt );
    normal = normalize( normal + mat3( viewMatrix ) * vec3( -seaS.x, 0.0, -seaS.y ) );
  }
#include <emissivemap_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => `${key()}-waves`;
}

/** The software sea: two waves on the ripple, the shallows and the beach's surf. Shares SeaUniforms. */
export function softwareSeaMaterial(u: SeaUniforms, extra: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog!), ...extra, ...u },
    vertexShader: `varying vec3 vWorld;\n#include <common>\n#include <fog_pars_vertex>
      void main() { vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `varying vec3 vWorld;
      uniform sampler2D uNormal; uniform vec2 uDrift;
      uniform vec3 uTop, uHorizon; uniform float uNight;
      #include <common>
      #include <fog_pars_fragment>
      ${SEA_WAVES_GLSL}
      ${SEA_SLOPE2_GLSL}
      ${SHORE_GLSL}
      void main() {
        vec3 ripple = texture2D(uNormal, vWorld.xz * 0.15 + uDrift).xyz;
        vec2 wave = ripple.xy * 2.0 - 1.0;
        vec2 swell = seaSlope2(vWorld.xz);
        vec3 n = normalize(vec3(wave.x * 0.18 - swell.x, 1.0, wave.y * 0.18 - swell.y));
        vec3 eye = normalize(cameraPosition - vWorld);
        vec3 reflection = reflect(-eye, n);
        vec3 sky = mix(uHorizon, uTop, smoothstep(0.0, 0.6, reflection.y));
        float fresnel = 1.0 - max(dot(n, eye), 0.0);
        fresnel *= fresnel;
        float depth = seaDepthAt(vWorld.xz);
        float light = 1.0 - uNight * 0.94;
        vec3 sea = seaShallows(vec3(0.018, 0.17, 0.23), depth) * light;
        float onBeach = 1.0 - smoothstep(0.0, 4.0, seaBeachOut(vWorld.xz));
        float shore = 1.0 - smoothstep(0.0, 0.6 + 0.9 * uSeaAmp, depth);
        float band = smoothstep(0.6, 0.9, 0.5 + 0.5 * sin(depth * 12.566 + uSurfPhase + ripple.z * 2.0));
        float foam = clamp(band * shore * onBeach * (0.55 + 0.6 * uSeaAmp), 0.0, 1.0);
        vec3 col = mix(sea, sky, (0.25 + fresnel * 0.65) * (1.0 - foam));
        gl_FragColor = vec4(mix(col, vec3(0.8) * light, foam), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

/** The plane drawn on every tier but High (and on software), centred on the camera like the grid. */
export function seaPlane(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(SKIRT_EXTENT * 2, SKIRT_EXTENT * 2).rotateX(-Math.PI / 2);
  g.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}

/**
 * High's wave grid in XZ around its centre: 1 m cells to FINE_EXTENT, COARSE_CELL cells to COARSE_EXTENT, then a
 * flat skirt to SKIRT_EXTENT whose inner rim shares the coarse ring's vertices. The fine ring's rim vertices that
 * fall between coarse ones carry aEdge (the rim's direction), so the shader puts them on the coarse ring's edges.
 * The mesh is moved in whole COARSE_CELL steps (Environment), so every vertex stays on a fixed world lattice.
 */
export function seaGrid(): THREE.BufferGeometry {
  const pos: number[] = [];
  const edge: number[] = [];
  const index: number[] = [];
  const vertex = (x: number, z: number, ex = 0, ez = 0): number => {
    pos.push(x, 0, z);
    edge.push(ex, ez);
    return pos.length / 3 - 1;
  };
  const grid = (half: number, cell: number, hole: number, rim: boolean): void => {
    const cells = Math.round((half * 2) / cell);
    const ids: number[] = [];
    for (let j = 0; j <= cells; j++) {
      for (let i = 0; i <= cells; i++) {
        const x = -half + i * cell;
        const z = -half + j * cell;
        if (Math.max(Math.abs(x), Math.abs(z)) < hole) {
          ids.push(-1);
          continue;
        }
        let ex = 0;
        let ez = 0;
        if (rim) {
          // On the rim and between two coarse vertices: slide along the rim.
          if (Math.abs(z) === half && x % COARSE_CELL !== 0) ex = 1;
          else if (Math.abs(x) === half && z % COARSE_CELL !== 0) ez = 1;
        }
        ids.push(vertex(x, z, ex, ez));
      }
    }
    const at = (i: number, j: number) => ids[j * (cells + 1) + i]!;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const cx = -half + (i + 0.5) * cell;
        const cz = -half + (j + 0.5) * cell;
        if (Math.max(Math.abs(cx), Math.abs(cz)) < hole) continue;
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i, j + 1);
        const d = at(i + 1, j + 1);
        // Counter-clockwise seen from above (+y).
        index.push(a, c, b, b, c, d);
      }
    }
  };
  grid(FINE_EXTENT, 1, 0, true);
  grid(COARSE_EXTENT, COARSE_CELL, FINE_EXTENT, false);
  // The skirt: per side, a strip of quads from the coarse rim out to SKIRT_EXTENT, flat (the waves have faded out).
  const steps = Math.round((COARSE_EXTENT * 2) / COARSE_CELL);
  const k = SKIRT_EXTENT / COARSE_EXTENT;
  const sides: Array<(t: number) => [number, number]> = [
    (t) => [t, -COARSE_EXTENT],
    (t) => [COARSE_EXTENT, t],
    (t) => [-t, COARSE_EXTENT],
    (t) => [-COARSE_EXTENT, -t],
  ];
  for (const side of sides) {
    for (let i = 0; i < steps; i++) {
      const [x0, z0] = side(-COARSE_EXTENT + i * COARSE_CELL);
      const [x1, z1] = side(-COARSE_EXTENT + (i + 1) * COARSE_CELL);
      const a = vertex(x0, z0);
      const b = vertex(x1, z1);
      const c = vertex(x0 * k, z0 * k);
      const d = vertex(x1 * k, z1 * k);
      index.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  const count = pos.length / 3;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  // Never read (the shader works the ripple UV out from the world position), but three's shader declares it.
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 2));
  g.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKIRT_EXTENT * Math.SQRT2);
  return g;
}

/** Where the grid's centre goes for a camera at (x, z): whole COARSE_CELL steps, so its vertices never swim. */
export function snapSea(v: number): number {
  return Math.round(v / COARSE_CELL) * COARSE_CELL;
}
