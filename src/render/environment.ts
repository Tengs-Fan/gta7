// Sky dome (clouds, stars, moon, hills across the bay), sun/moon lighting, fog, environment map and the ocean.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/math';
import { WATER_Y } from '../world/constants';
import { waterNormalTexture } from './textures';

interface Key {
  h: number;
  top: number;
  horizon: number;
  sun: number;
  sunI: number;
  hemiI: number;
  exposure: number;
}

// Palette keyframes over the day (hours). The warm morning light holds until about 08:30.
const KEYS: Key[] = [
  { h: 0, top: 0x03060f, horizon: 0x0b1530, sun: 0x8fa8ff, sunI: 0.0, hemiI: 0.22, exposure: 1.0 },
  { h: 4.8, top: 0x060c1f, horizon: 0x1a2440, sun: 0x8fa8ff, sunI: 0.0, hemiI: 0.25, exposure: 1.0 },
  { h: 6.0, top: 0x29457f, horizon: 0xf09a6a, sun: 0xffa060, sunI: 1.0, hemiI: 0.5, exposure: 1.0 },
  { h: 7.5, top: 0x3a6fc0, horizon: 0xf2c49c, sun: 0xffc890, sunI: 2.3, hemiI: 0.66, exposure: 1.0 },
  { h: 8.5, top: 0x3d7bd0, horizon: 0xd6dde6, sun: 0xffe2bc, sunI: 2.8, hemiI: 0.74, exposure: 1.0 },
  { h: 12, top: 0x2b6cd4, horizon: 0xaed0f2, sun: 0xfff6e8, sunI: 3.3, hemiI: 0.8, exposure: 1.0 },
  { h: 16.5, top: 0x3570cc, horizon: 0xf0d8b0, sun: 0xffe2b0, sunI: 2.9, hemiI: 0.74, exposure: 1.0 },
  { h: 18.4, top: 0x34478a, horizon: 0xff8a4c, sun: 0xff8040, sunI: 1.7, hemiI: 0.6, exposure: 1.08 },
  { h: 19.4, top: 0x161e44, horizon: 0xb44a3e, sun: 0xff5a30, sunI: 0.3, hemiI: 0.36, exposure: 1.05 },
  { h: 20.6, top: 0x070c20, horizon: 0x1e2648, sun: 0x8fa8ff, sunI: 0.0, hemiI: 0.24, exposure: 1.0 },
  { h: 24, top: 0x03060f, horizon: 0x0b1530, sun: 0x8fa8ff, sunI: 0.0, hemiI: 0.22, exposure: 1.0 },
];

const cA = new THREE.Color();
const cB = new THREE.Color();

function sample(hours: number): { top: THREE.Color; horizon: THREE.Color; sun: THREE.Color; sunI: number; hemiI: number; exposure: number } {
  const h = ((hours % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]!.h <= h) i++;
  const a = KEYS[i]!;
  const b = KEYS[i + 1]!;
  const t = clamp((h - a.h) / (b.h - a.h), 0, 1);
  const mix = (x: number, y: number) => cA.setHex(x).lerp(cB.setHex(y), t).clone();
  return { top: mix(a.top, b.top), horizon: mix(a.horizon, b.horizon), sun: mix(a.sun, b.sun), sunI: lerp(a.sunI, b.sunI, t), hemiI: lerp(a.hemiI, b.hemiI, t), exposure: lerp(a.exposure, b.exposure, t) };
}

/** Darkness 0 (day) .. 1 (night) for a sun intensity. */
function nightOf(sunI: number): number {
  return 1 - smoothstep(0.02, 0.45, sunI / 3.3);
}

/** Brightness 0..1 of the stars at a time of day (hours). */
export function starIntensity(hours: number): number {
  return smoothstep(0.5, 0.95, nightOf(sample(hours).sunI));
}

/** Share of the sky covered by cloud at a time of day (hours): about 0.35 by day and 0.25 at night. */
export function cloudCover(hours: number): number {
  const day = 1 - nightOf(sample(hours).sunI);
  return lerp(0.25, 0.35, day) + 0.03 * Math.sin((hours / 24) * Math.PI * 4);
}

/**
 * Standard deviation of the sky shader's gradient-noise fbm (mean 0.5) per octave count, measured by
 * sampling the same noise; the cloud threshold for a coverage is mean + sd * probit(1 - coverage).
 */
const CLOUD_SD: Readonly<Record<number, number>> = { 2: 0.132, 4: 0.109, 5: 0.106 };

/** Inverse of the standard normal CDF (Abramowitz and Stegun 26.2.23, error below 5e-4). */
function probit(p: number): number {
  const q = Math.min(Math.max(p < 0.5 ? p : 1 - p, 1e-6), 0.5);
  const t = Math.sqrt(-2 * Math.log(q));
  const z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  return p < 0.5 ? -z : z;
}

/** The cloud fbm value that a share `cover` of the sky exceeds (the shader's density is 0.5 there). */
export function cloudThreshold(cover: number, sd: number = CLOUD_SD[5]!): number {
  return 0.5 + sd * probit(1 - clamp(cover, 0.01, 0.99));
}

/** 0..1: how strongly a low sun paints the cloud undersides (dusk 17:30-19:30, and a little at dawn). */
export function goldenHour(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  const dusk = smoothstep(17.3, 18.2, h) * (1 - smoothstep(19.2, 19.8, h));
  const dawn = smoothstep(5.6, 6.2, h) * (1 - smoothstep(7.4, 8.4, h));
  return Math.max(dusk, dawn * 0.8);
}

/** Night colours: a moonlit blue sky light, sodium-lit streets bouncing up, and the city's warm glow on the horizon. */
const NIGHT_SKY_LIGHT = new THREE.Color(0.36, 0.46, 0.8);
const NIGHT_GROUND_LIGHT = new THREE.Color(0.35, 0.27, 0.18);
const NIGHT_HORIZON_GLOW = new THREE.Color(0.16, 0.11, 0.08);
/** How much of that glow the night horizon (and the fog) takes on. */
const GLOW_STRENGTH = 0.45;
const WHITE = new THREE.Color(0xffffff);

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  // The sphere is centred on the camera: the interpolated (not normalised) position is the exact
  // point of each pixel's view ray on its triangle, so patterns never bend at the triangle edges.
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // keep at far plane
}`;

const SKY_FS = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uLightDir;
uniform float uStars;
uniform float uMoon;
uniform float uNight;
uniform float uGolden;
uniform float uCloudT;
uniform float uHighT;
uniform float uTime;
uniform vec2 uCamXZ;
uniform float uCamY;
uniform vec2 uWind1;
uniform vec2 uWind2;
uniform int uOctaves;
uniform float uLightTap;
varying vec3 vDir;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Gradient noise: no lattice-aligned blocks, so thresholded clouds keep soft, natural edges.
float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i) * 2.0 - 1.0, f);
  float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Each octave is rotated against the last. Mean 0.5; its spread per octave count is CLOUD_SD.
const mat2 OCTAVE = mat2(1.6, 1.2, -1.2, 1.6);
float fbm(vec2 p, int octaves) {
  float a = 0.5;
  float s = 0.0;
  float n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    s += a * gnoise(p);
    n += a;
    p = OCTAVE * p + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return 0.5 + s / n;
}

// One jittered point star per cell of a cube-face grid; sized in pixels via fwidth so stars stay
// 1-2 px wide at any field of view.
vec3 stars(vec3 d, float pix) {
  const float K = 180.0;
  vec3 a = abs(d);
  float face;
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) { face = d.x > 0.0 ? 0.0 : 1.0; uv = d.zy / a.x; }
  else if (a.y >= a.z) { face = d.y > 0.0 ? 2.0 : 3.0; uv = d.xz / a.y; }
  else { face = d.z > 0.0 ? 4.0 : 5.0; uv = d.xy / a.z; }
  vec2 cell = floor((uv * 0.5 + 0.5) * K);
  vec2 key = cell + vec2(face * 211.0, face * 97.0);
  if (hash12(key + 0.5) > 0.075) return vec3(0.0);
  vec2 jit = hash22(key);
  vec2 c = (cell + 0.25 + 0.5 * jit) / K * 2.0 - 1.0;
  vec3 s;
  if (face < 1.5) s = vec3(face < 0.5 ? 1.0 : -1.0, c.y, c.x);
  else if (face < 3.5) s = vec3(c.x, face < 2.5 ? 1.0 : -1.0, c.y);
  else s = vec3(c.x, c.y, face < 4.5 ? 1.0 : -1.0);
  float r = length(d - normalize(s)) / pix;
  float core = 1.0 - smoothstep(0.45, 1.25, r);
  float mag = pow(hash12(key * 1.7 + 3.1), 5.0);
  float tw = 0.78 + 0.22 * sin(uTime * (1.5 + 3.0 * jit.x) + jit.y * 40.0);
  vec3 tint = mix(vec3(0.72, 0.8, 1.0), vec3(1.0, 0.9, 0.74), hash12(key * 2.3));
  return tint * core * (0.22 + 1.7 * mag) * tw;
}

// Cloud layers on a virtual plane above the camera: rgb colour, a coverage.
vec4 clouds(vec3 d) {
  vec2 p = d.xz / max(d.y, 0.03);
  vec2 q1 = (uCamXZ + p * 1500.0) / 900.0 + uWind1;
  // uCloudT is the fbm value that exactly uCloudCover of the sky exceeds (see cloudThreshold).
  float n1 = fbm(q1, uOctaves);
  float dens = smoothstep(uCloudT - 0.06, uCloudT + 0.06, n1);
  // Thin high streaks.
  vec2 q2 = (uCamXZ + p * 2400.0) / 400.0 * vec2(0.45, 1.0) + uWind2;
  float n2 = fbm(q2 + vec2(5.2, 1.3), uOctaves > 2 ? uOctaves - 1 : 2);
  float high = smoothstep(uHighT - 0.03, uHighT + 0.12, n2) * 0.4;
  // Light: compare the density one step towards the sun (or moon): denser there means shadowed here.
  float lit = 0.6;
  if (uLightTap > 0.5) {
    vec2 toward = normalize(uLightDir.xz + vec2(1e-4)) * 0.22;
    float tap = smoothstep(uCloudT - 0.06, uCloudT + 0.06, fbm(q1 + toward, 3));
    lit = clamp(0.62 + (dens - tap) * 1.1, 0.0, 1.0);
  }
  vec3 bright = mix(vec3(1.0), uSunColor, 0.35) * 1.12;
  vec3 shade = mix(uTop, vec3(0.72, 0.74, 0.78), 0.55) * 0.78;
  // Low sun: undersides and edges take its orange.
  shade = mix(shade, uSunColor * vec3(1.0, 0.6, 0.42) * 0.95, uGolden);
  bright = mix(bright, mix(uSunColor, vec3(1.0, 0.86, 0.7), 0.35) * 1.2, uGolden);
  // Night: dim moonlit tops; low clouds catch the city's glow from below.
  vec3 glowLit = max(uGlow, vec3(0.0)) * exp(-d.y * 5.0);
  bright = mix(bright, vec3(0.06, 0.066, 0.085) + glowLit * 0.6, uNight);
  shade = mix(shade, vec3(0.028, 0.03, 0.04) + glowLit * 0.9, uNight);
  vec3 col = mix(shade, bright, lit);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(sd, 10.0) * (1.0 - dens) * 0.9 * (1.0 - uNight);
  vec3 highCol = mix(bright, uHorizon, 0.25);
  float a = dens + high * (1.0 - dens);
  col = a > 0.0 ? (col * dens + highCol * high * (1.0 - dens)) / a : col;
  // Far clouds sink into the haze; none below the horizon.
  float fade = smoothstep(0.0, 0.2, d.y);
  col = mix(uHorizon + uGlow, col, smoothstep(0.02, 0.35, d.y));
  return vec4(col, a * fade);
}

// A ridge of hills at a distance (metres) with heights (metres above the sea) between lo and hi:
// 1 inside its silhouette, which sits on the sea at its true angle below the horizon.
float ridge(float h, vec2 hz, float dist, float lo, float hi, float present, float pix, float seed) {
  float top = (lo + (hi - lo) * fbm(hz * (dist / 1100.0) + seed, 4)) * present;
  float above = (top - uCamY) / dist;
  float base = -uCamY / dist;
  return (1.0 - smoothstep(above - pix, above + pix, h)) * smoothstep(base - pix, base + pix, h) * step(0.001, present);
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  float t = pow(clamp(h, 0.0, 1.0), 0.55);
  // The city's warm glow hangs low over the horizon at night.
  vec3 horizon = uHorizon + uGlow;
  vec3 col = max(mix(uHorizon, uTop, t) + uGlow * exp(-max(h, 0.0) * 9.0), vec3(0.0));
  // Below the horizon fade towards a darker haze.
  if (h < 0.0) col = mix(horizon, horizon * 0.55, clamp(-h * 4.0, 0.0, 1.0));
  float pix = max(length(fwidth(d)), 1e-6);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 900.0) * 18.0 + pow(sd, 12.0) * 0.35 + pow(sd, 3.0) * 0.12) * step(-0.05, uSunDir.y);
  if (h > 0.0 && uStars > 0.0) col += stars(d, pix) * uStars * smoothstep(0.02, 0.25, h);
  if (uMoon > 0.0) {
    vec3 md = d - uMoonDir;
    float m = length(md);
    const float R = 0.012;
    float disc = 1.0 - smoothstep(R - pix, R + pix, m);
    if (disc > 0.0) {
      vec3 mt = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
      vec3 mb = cross(mt, uMoonDir);
      vec2 l = vec2(dot(md, mt), dot(md, mb)) / R;
      float maria = 0.6 * vnoise(l * 2.6 + 3.0) + 0.4 * vnoise(l * 6.0 + 1.0);
      float limb = sqrt(max(0.0, 1.0 - dot(l, l)));
      col = mix(col, vec3(1.0, 0.97, 0.9) * (0.72 + 0.28 * limb) * (0.8 + 0.2 * maria) * 2.2, disc * uMoon);
    }
    col += vec3(0.55, 0.62, 0.8) * (exp(-m * 30.0) * 0.16 + exp(-m * 6.0) * 0.05) * uMoon;
  }
  if (h > 0.0) {
    vec4 c = clouds(d);
    col = mix(col, c.rgb, c.a);
  }
  // Hills across the bay to the north, west and south (the open ocean lies east): a far ridge about
  // 6 km out and a nearer one at 3.5 km, both standing on the sea, hazed towards the horizon colour.
  if (h < 0.12) {
    vec2 hz = normalize(d.xz + vec2(1e-5));
    float present = 1.0 - smoothstep(0.05, 0.85, hz.x);
    if (present > 0.0) {
      float lightK = 1.0 - 0.92 * uNight;
      vec3 land = vec3(0.2, 0.27, 0.21) * lightK;
      float far = ridge(h, hz, 6000.0, 120.0, 420.0, present, pix, 11.0);
      float near = ridge(h, hz, 3500.0, 42.0, 150.0, present, pix, 3.0);
      col = mix(col, mix(land, horizon, 0.74), far);
      vec3 nearCol = mix(land * 0.8, horizon, 0.52);
      // A few house lights on the nearer hills at night, a few pixels apart.
      float lights = smoothstep(0.5, 0.9, uNight);
      if (lights > 0.0 && near > 0.0) {
        // Azimuth with its wrap-around seam facing east, where there are no hills.
        vec2 g = vec2(atan(hz.y, -hz.x), h) * 300.0;
        vec2 cell = floor(g);
        if (hash12(cell + 3.7) < 0.035) {
          vec2 c = cell + 0.25 + 0.5 * hash22(cell + 7.0);
          float r = length(g - c) / 300.0 / pix;
          nearCol += vec3(1.0, 0.72, 0.42) * (1.0 - smoothstep(0.35, 1.0, r)) * 0.7 * lights;
        }
      }
      col = mix(col, nearCol, near);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

type SkyQuality = 'low' | 'medium' | 'high';

export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: THREE.Mesh;
  readonly water: THREE.Mesh;
  readonly fog: THREE.Fog;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly waterNormal: THREE.Texture;
  /** The PMREM target holding the environment map: allocated by the first bake and refilled by every later one. */
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private cubeTarget: THREE.WebGLCubeRenderTarget | null = null;
  private cubeCamera: THREE.CubeCamera | null = null;
  night = 0;
  sunDir = new THREE.Vector3(0, 1, 0);
  shadowsEnabled = true;
  /** Spread of the sky shader's cloud fbm at the current octave count. */
  private cloudSd = CLOUD_SD[5]!;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    this.fog = new THREE.Fog(0xaed0f2, 180, 760);
    scene.fog = this.fog;

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color(0, 0, 0) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) },
        uStars: { value: 0 },
        uMoon: { value: 0 },
        uNight: { value: 0 },
        uGolden: { value: 0 },
        uCloudT: { value: 0.55 },
        uHighT: { value: 0.6 },
        uTime: { value: 0 },
        uCamXZ: { value: new THREE.Vector2() },
        uCamY: { value: 2 },
        uWind1: { value: new THREE.Vector2() },
        uWind2: { value: new THREE.Vector2() },
        uOctaves: { value: 5 },
        uLightTap: { value: 1 },
      },
      side: THREE.BackSide,
      // Drawn after the opaque scene at the far plane: pixels already covered fail the depth test
      // and are never shaded.
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 1000;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -75;
    sc.right = 75;
    sc.top = 75;
    sc.bottom = -75;
    sc.near = 1;
    sc.far = 500;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6b5a48, 1);
    scene.add(this.hemi);

    this.waterNormal = waterNormalTexture();
    this.waterNormal.repeat.set(900, 900);
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x135a73, roughness: 0.22, metalness: 0.1, normalMap: this.waterNormal, normalScale: new THREE.Vector2(0.22, 0.22), envMapIntensity: 1.8 }),
    );
    water.position.y = WATER_Y;
    water.receiveShadow = true;
    this.water = water;
    scene.add(water);

    // Image based lighting: a tiny sky scene re-baked whenever the palette changes.
    this.envMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSun: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSun; uniform vec3 uSunDir; varying vec3 vP;
        void main(){ vec3 d = normalize(vP); float h = d.y;
          vec3 c = mix(uHorizon, uTop, smoothstep(0.0, 0.6, h));
          c = mix(c, vec3(0.16, 0.15, 0.14) * (uHorizon + 0.2), 1.0 - smoothstep(-0.25, 0.0, h));
          c += uSun * pow(max(dot(d, uSunDir), 0.0), 24.0) * 2.5;
          gl_FragColor = vec4(c, 1.0); }`,
    });
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), this.envMat));
    try {
      this.pmrem = new THREE.PMREMGenerator(renderer);
    } catch {
      this.pmrem = null;
    }
    // A restored WebGL context has lost the GPU copy of the environment map: re-bake on the next frame.
    renderer.domElement?.addEventListener?.('webglcontextrestored', () => {
      this.envHours = Number.NaN;
    });
  }

  private readonly envScene = new THREE.Scene();
  private readonly envMat: THREE.ShaderMaterial;
  private pmrem: THREE.PMREMGenerator | null;
  private envHours = Number.NaN;

  /**
   * Re-bakes the environment map for the current sky (cheap: a 24-segment sphere). The sky is
   * rendered with one reused cube camera into one cube target, then prefiltered into the PMREM
   * target of the first bake, so scene.environment never changes identity and the env-mapped
   * materials never re-resolve their programs.
   */
  private refreshEnv(s: { top: THREE.Color; horizon: THREE.Color; sun: THREE.Color; sunI: number }, sunDir: THREE.Vector3): void {
    if (!this.pmrem) return;
    const u = this.envMat.uniforms;
    (u.uTop!.value as THREE.Color).copy(s.top);
    (u.uHorizon!.value as THREE.Color).copy(s.horizon);
    (u.uSun!.value as THREE.Color).copy(s.sun).multiplyScalar(Math.min(1.5, s.sunI / 2));
    (u.uSunDir!.value as THREE.Vector3).copy(sunDir);
    try {
      if (!this.cubeTarget || !this.cubeCamera) {
        this.cubeTarget = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType });
        this.cubeCamera = new THREE.CubeCamera(0.1, 100, this.cubeTarget);
      }
      this.cubeCamera.update(this.renderer, this.envScene);
      const target = this.pmrem.fromCubemap(this.cubeTarget.texture, this.envTarget);
      if (target !== this.envTarget) {
        this.envTarget?.dispose();
        this.envTarget = target;
      }
      if (this.scene.environment !== target.texture) this.scene.environment = target.texture;
    } catch {
      this.scene.environment = null;
    }
  }

  setShadows(on: boolean): void {
    this.shadowsEnabled = on;
    this.sun.castShadow = on;
  }

  /** Sky detail per graphics quality: low draws 2-octave clouds without the light tap. */
  setQuality(q: SkyQuality): void {
    const u = this.skyMat.uniforms;
    const octaves = q === 'high' ? 5 : q === 'medium' ? 4 : 2;
    u.uOctaves!.value = octaves;
    u.uLightTap!.value = q === 'low' ? 0 : 1;
    this.cloudSd = CLOUD_SD[octaves] ?? CLOUD_SD[5]!;
  }

  /** Updates lighting for the given time of day and moves the shadow frustum with the camera focus. */
  update(hours: number, focus: THREE.Vector3, camera: THREE.Camera, time: number, renderer: THREE.WebGLRenderer): void {
    const s = sample(hours);
    // Sun path: rises in the east (+X) at 06:00, sets in the west at 19:00, tilted south.
    const dayT = (hours - 6) / 13;
    const elev = Math.sin(dayT * Math.PI) * 1.15;
    const az = dayT * Math.PI;
    const sunDir = new THREE.Vector3(Math.cos(az), Math.sin(elev), 0.35).normalize();
    this.sunDir.copy(sunDir);
    const moonDir = new THREE.Vector3(-Math.cos(az) * 0.8, Math.max(0.25, -Math.sin(elev) * 0.9), -0.35).normalize();
    this.night = nightOf(s.sunI);
    const night = this.night;
    // At night the city's light glows warm on the horizon; the fog takes the same colour, so
    // distant buildings fade into it rather than into a navy wall.
    // Only once it is properly dark, so the sunset keeps its colours.
    const horizon = s.horizon.clone().lerp(NIGHT_HORIZON_GLOW, smoothstep(0.55, 1, night) * GLOW_STRENGTH);
    // The sky adds the difference near the horizon only (it fades out with elevation).
    const glow = horizon.clone().sub(s.horizon);

    const u = this.skyMat.uniforms;
    (u.uTop!.value as THREE.Color).copy(s.top);
    (u.uHorizon!.value as THREE.Color).copy(s.horizon);
    (u.uGlow!.value as THREE.Color).copy(glow);
    (u.uSunDir!.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor!.value as THREE.Color).copy(s.sun);
    (u.uMoonDir!.value as THREE.Vector3).copy(moonDir);
    (u.uLightDir!.value as THREE.Vector3).copy(night > 0.6 ? moonDir : sunDir);
    u.uStars!.value = starIntensity(hours);
    u.uMoon!.value = smoothstep(0.3, 0.85, night);
    u.uNight!.value = night;
    u.uGolden!.value = goldenHour(hours);
    const cover = cloudCover(hours);
    u.uCloudT!.value = cloudThreshold(cover, this.cloudSd);
    u.uHighT!.value = cloudThreshold(cover * 0.5, this.cloudSd);
    u.uTime!.value = time % 1000;
    (u.uCamXZ!.value as THREE.Vector2).set(camera.position.x, camera.position.z);
    u.uCamY!.value = Math.max(0.5, camera.position.y - WATER_Y);
    // Wind drift in noise units, wrapped well before float precision suffers.
    (u.uWind1!.value as THREE.Vector2).set((time * 0.0105) % 1000, (time * 0.0042) % 1000);
    (u.uWind2!.value as THREE.Vector2).set((time * 0.021) % 1000, (time * 0.0085) % 1000);
    this.sky.position.copy(camera.position);

    // Daylight sun, or a dim bluish moon at night.
    const moonI = 0.32 * night;
    const useMoon = s.sunI < moonI;
    const lightDir = useMoon ? moonDir : sunDir.y > 0.05 ? sunDir : new THREE.Vector3(sunDir.x, 0.05, sunDir.z).normalize();
    this.sun.color.copy(useMoon ? new THREE.Color(0x9fb4ff) : s.sun);
    this.sun.intensity = useMoon ? moonI : s.sunI;
    // Snap the shadow camera to texel increments to avoid shimmering.
    const texel = 150 / 2048;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx + lightDir.x * 220, lightDir.y * 220, fz + lightDir.z * 220);
    this.sun.target.updateMatrixWorld();

    // Night fill: walls never go pitch black (moonlit sky above, sodium-lit streets below).
    this.hemi.intensity = Math.max(s.hemiI, 0.4 * night);
    this.hemi.color.copy(s.top).lerp(WHITE, 0.45).lerp(NIGHT_SKY_LIGHT, night);
    this.hemi.groundColor.setRGB(0.32, 0.28, 0.24).multiplyScalar(0.6 + 0.4 * (1 - night)).lerp(NIGHT_GROUND_LIGHT, night);

    this.fog.color.copy(horizon).lerp(s.top, 0.15 * (1 - night));
    this.fog.near = lerp(180, 90, night);
    this.fog.far = lerp(780, 520, night);
    this.scene.environmentIntensity = 0.4 + 0.35 * (1 - night);
    // Re-bake reflections every quarter game hour (or after a jump in time); NaN forces the first bake.
    const diff = Math.abs(hours - this.envHours);
    if (!(Math.min(diff, 24 - diff) <= 0.25)) {
      this.envHours = hours;
      this.refreshEnv(s, sunDir);
    }
    renderer.toneMappingExposure = s.exposure;

    this.waterNormal.offset.set((time * 0.012) % 1, (time * 0.008) % 1);
  }

  dispose(): void {
    this.cubeTarget?.dispose();
    this.envTarget?.dispose();
    this.pmrem?.dispose();
  }
}
