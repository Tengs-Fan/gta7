// Sky dome, sun/moon lighting, fog, environment map and the ocean.

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

// Palette keyframes over the day (hours).
const KEYS: Key[] = [
  { h: 0, top: 0x03060f, horizon: 0x0b1530, sun: 0x8fa8ff, sunI: 0.0, hemiI: 0.22, exposure: 1.0 },
  { h: 4.8, top: 0x060c1f, horizon: 0x1a2440, sun: 0x8fa8ff, sunI: 0.0, hemiI: 0.25, exposure: 1.0 },
  { h: 6.0, top: 0x29457f, horizon: 0xf09a6a, sun: 0xffa060, sunI: 1.0, hemiI: 0.5, exposure: 1.0 },
  { h: 7.5, top: 0x3f7fd2, horizon: 0xbfd8f0, sun: 0xffe0b8, sunI: 2.7, hemiI: 0.72, exposure: 1.0 },
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

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // keep at far plane
}`;

const SKY_FS = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uStars;
uniform float uTime;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  float t = pow(clamp(h, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizon, uTop, t);
  // Below the horizon fade towards a darker haze.
  if (h < 0.0) col = mix(uHorizon, uHorizon * 0.55, clamp(-h * 4.0, 0.0, 1.0));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 900.0) * 18.0 + pow(sd, 12.0) * 0.35 + pow(sd, 3.0) * 0.12) * step(-0.05, uSunDir.y);
  float md = max(dot(d, uMoonDir), 0.0);
  col += vec3(0.85, 0.9, 1.0) * pow(md, 2200.0) * 7.0 * uStars;
  col += vec3(0.5, 0.6, 0.9) * pow(md, 30.0) * 0.08 * uStars;
  if (uStars > 0.0 && h > 0.0) {
    vec3 cell = floor(d * 240.0);
    float s = hash(cell);
    float tw = 0.6 + 0.4 * sin(uTime * 2.0 + s * 50.0);
    col += vec3(step(0.9965, s) * uStars * tw * (0.6 + 0.4 * h));
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: THREE.Mesh;
  readonly water: THREE.Mesh;
  readonly fog: THREE.Fog;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly waterNormal: THREE.Texture;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  night = 0;
  sunDir = new THREE.Vector3(0, 1, 0);
  shadowsEnabled = true;

  constructor(private readonly scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.fog = new THREE.Fog(0xaed0f2, 180, 760);
    scene.fog = this.fog;

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uStars: { value: 0 },
        uTime: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
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
  }

  private readonly envScene = new THREE.Scene();
  private readonly envMat: THREE.ShaderMaterial;
  private pmrem: THREE.PMREMGenerator | null;
  private envHours = Number.NaN;

  /** Re-bakes the environment map for the current sky (cheap: a 24-segment sphere). */
  private refreshEnv(s: { top: THREE.Color; horizon: THREE.Color; sun: THREE.Color; sunI: number }, sunDir: THREE.Vector3): void {
    if (!this.pmrem) return;
    const u = this.envMat.uniforms;
    (u.uTop!.value as THREE.Color).copy(s.top);
    (u.uHorizon!.value as THREE.Color).copy(s.horizon);
    (u.uSun!.value as THREE.Color).copy(s.sun).multiplyScalar(Math.min(1.5, s.sunI / 2));
    (u.uSunDir!.value as THREE.Vector3).copy(sunDir);
    try {
      const target = this.pmrem.fromScene(this.envScene, 0, 0.1, 100, { size: 128 });
      this.envTarget?.dispose();
      this.envTarget = target;
      this.scene.environment = target.texture;
    } catch {
      this.scene.environment = null;
    }
  }

  setShadows(on: boolean): void {
    this.shadowsEnabled = on;
    this.sun.castShadow = on;
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
    this.night = 1 - smoothstep(0.02, 0.45, s.sunI / 3.3);

    const u = this.skyMat.uniforms;
    (u.uTop!.value as THREE.Color).copy(s.top);
    (u.uHorizon!.value as THREE.Color).copy(s.horizon);
    (u.uSunDir!.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor!.value as THREE.Color).copy(s.sun);
    (u.uMoonDir!.value as THREE.Vector3).copy(moonDir);
    u.uStars!.value = smoothstep(0.5, 0.95, this.night);
    u.uTime!.value = time;
    this.sky.position.copy(camera.position);

    // Daylight sun, or a dim bluish moon at night.
    const moonI = 0.32 * this.night;
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

    this.hemi.intensity = s.hemiI;
    this.hemi.color.copy(s.top).lerp(new THREE.Color(0xffffff), 0.45);
    this.hemi.groundColor.setRGB(0.32, 0.28, 0.24).multiplyScalar(0.6 + 0.4 * (1 - this.night));

    this.fog.color.copy(s.horizon).lerp(s.top, 0.15);
    this.fog.near = lerp(180, 90, this.night);
    this.fog.far = lerp(780, 520, this.night);
    this.scene.environmentIntensity = 0.4 + 0.35 * (1 - this.night);
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
    this.envTarget?.dispose();
    this.pmrem?.dispose();
  }
}
