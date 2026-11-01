// Boat wakes on the sea: the churned water trailing behind each boat under way, and the two arms of its Kelvin wake
// spreading from its track at 19.5 degrees either side, fading out over WAKE_LIFE s. One draw for every boat: ribbons
// over each boat's recent stern points, rewritten on the CPU each frame from a fixed pool and laid on the sea's drawn
// waves (render/waves.ts) in the vertex shader. Presentation only: nothing here feeds back into the sim.

import * as THREE from 'three';
import { WATER_Y } from '../world/constants';
import { SEA_WAVES_GLSL } from './waves';

/** How long a stretch of wake lasts (s): the churned trail fades first, the arms by then. */
export const WAKE_LIFE = 10;
const TRAIL_LIFE = WAKE_LIFE * 0.75;
/**
 * Slots for boats' wakes, and stern points kept per boat. A boat new to the pool takes the slot whose boat fed longest
 * ago, wherever it is; with more boats under way than slots, the newcomers take that slot from one another every frame
 * and none of them draws a wake (rooms hold eight players and the sim has no boats of its own, so it never comes to that).
 */
export const WAKE_BOATS = 8;
export const WAKE_POINTS = 40;
/** A boat leaves a stern point every WAKE_STEP m; one that jumps further than WAKE_JUMP m (a teleport) starts afresh. */
export const WAKE_STEP = 1.6;
const WAKE_JUMP = 20;
/** The Kelvin wake's half-angle, whatever the speed: tan(19.47 degrees). */
export const KELVIN = Math.tan((19.47 * Math.PI) / 180);
/** Ribbons per boat: the trail down the middle, and the two arms. */
const RIBBONS = 3;
/** Vertices per ribbon: two per stern point, and two for the head that follows the stern between points. */
const RIBBON_VERTS = (WAKE_POINTS + 1) * 2;

const WAKE_VS = /* glsl */ `
attribute vec3 aFoam;
varying vec3 vFoam;
varying vec2 vXZ;
#include <common>
#include <fog_pars_vertex>
${SEA_WAVES_GLSL}
void main() {
  vFoam = aFoam;
  vXZ = position.xz;
  vec3 d = uDisplace * seaDisplace(position.xz);
  // A few centimetres over the surface it follows, under the hull's own foam ring.
  vec4 mvPosition = viewMatrix * vec4(position.x + d.x, ${WATER_Y.toFixed(1)} + 0.04 + d.y, position.z + d.z, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const WAKE_FS = /* glsl */ `
varying vec3 vFoam;
varying vec2 vXZ;
uniform vec3 uLight;
#include <common>
#include <fog_pars_fragment>
float wakeHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float wakeNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wakeHash(i), wakeHash(i + vec2(1.0, 0.0)), f.x), mix(wakeHash(i + vec2(0.0, 1.0)), wakeHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  // vFoam: strength, across the ribbon (-1..1), and 0 for the trail or 1 for an arm.
  float u = abs(vFoam.y);
  // The churned trail is fullest down its middle; an arm is a narrow line of broken water along its crest.
  float across = mix(1.0 - u * u, 1.0 - smoothstep(0.1, 1.0, u), vFoam.z);
  // Foam stays put on the water: patches, lace and speckle. Fresh and thick it covers the ribbon but for a few holes; as
  // it fades only its densest patches are left. Under the trail's foam the churned, aerated water shows pale turquoise.
  float fine = wakeNoise(vXZ * 19.0 + 1.7);
  float n = wakeNoise(vXZ * 0.9) * 0.45 + wakeNoise(vXZ * 2.6 + 7.1) * 0.3 + wakeNoise(vXZ * 7.3 + 3.3) * 0.15 + fine * 0.1;
  float edge = 0.62 - 0.5 * vFoam.x * across;
  float foam = smoothstep(edge, edge + 0.16, n);
  float churn = 0.4 * vFoam.x * across * (1.0 - vFoam.z);
  float a = max(0.9 * across * foam, churn);
  if (a < 0.004) discard;
  // Bubbles shade the foam a little, lighter where it is thickest.
  vec3 white = vec3(0.9, 0.94, 0.95) * (0.82 + 0.25 * fine + 0.15 * foam);
  gl_FragColor = vec4(mix(vec3(0.42, 0.75, 0.74), white, foam) * uLight, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** One boat's stern points, oldest overwritten first, and what it fed this frame. */
interface WakeSlot {
  id: number;
  /** Stern points: position, unit heading of travel, speed (m/s), wake strength 0..1 and the time each was left. */
  x: Float32Array;
  z: Float32Array;
  dx: Float32Array;
  dz: Float32Array;
  speed: Float32Array;
  k: Float32Array;
  t: Float32Array;
  count: number;
  next: number;
  /** Half the hull's width (m), and the stern as fed this frame (fed false: not under way this frame). */
  halfW: number;
  fed: boolean;
  hx: number;
  hz: number;
  hdx: number;
  hdz: number;
  hSpeed: number;
  hk: number;
  /** When it last fed a point (renderer time), for handing its slot to a new boat. */
  seen: number;
  /** Points drawn in the last update (0: its ribbons lie collapsed). */
  drawn: number;
}

export class BoatWakes {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly foam: Float32Array;
  private readonly slots: WakeSlot[] = [];
  /** The scene light the foam takes (Effects.setLight). */
  readonly light: THREE.Color;
  /** Stern points drawn in the last update, for tests and probes. */
  points = 0;

  constructor() {
    const verts = WAKE_BOATS * RIBBONS * RIBBON_VERTS;
    this.pos = new Float32Array(verts * 3);
    this.foam = new Float32Array(verts * 3);
    const index = new Uint16Array(WAKE_BOATS * RIBBONS * WAKE_POINTS * 6);
    let k = 0;
    for (let r = 0; r < WAKE_BOATS * RIBBONS; r++) {
      const base = r * RIBBON_VERTS;
      for (let i = 0; i < WAKE_POINTS; i++) {
        const a = base + i * 2;
        index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], k);
        k += 6;
      }
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aFoam', new THREE.BufferAttribute(this.foam, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: WAKE_VS,
      fragmentShader: WAKE_FS,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uLight: { value: new THREE.Color(1, 1, 1) }, uWavePhase: { value: new THREE.Vector4() }, uSeaAmp: { value: 0 }, uDisplace: { value: 0 }, uSeaOrigin: { value: new THREE.Vector2() } },
      ]),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.light = this.mat.uniforms.uLight!.value as THREE.Color;
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'boat-wakes';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    const f = () => new Float32Array(WAKE_POINTS);
    for (let i = 0; i < WAKE_BOATS; i++) {
      this.slots.push({ id: -1, x: f(), z: f(), dx: f(), dz: f(), speed: f(), k: f(), t: f(), count: 0, next: 0, halfW: 1, fed: false, hx: 0, hz: 0, hdx: 0, hdz: 1, hSpeed: 0, hk: 0, seen: -Infinity, drawn: 0 });
    }
  }

  /** Shares the sea's wave uniforms, so the wakes ride the waves the sea draws. Before the first render. */
  bindSea(u: { uWavePhase: THREE.IUniform; uSeaAmp: THREE.IUniform; uDisplace: THREE.IUniform; uSeaOrigin: THREE.IUniform }): void {
    Object.assign(this.mat.uniforms, { uWavePhase: u.uWavePhase, uSeaAmp: u.uSeaAmp, uDisplace: u.uDisplace, uSeaOrigin: u.uSeaOrigin });
  }

  /**
   * Boat `id`, its stern at (x, z) going along the unit (dx, dz) at `speed` m/s with wake strength `k` (boatWakeLevel)
   * and half its hull's width `halfW`, is under way this frame. The point is taken in the next update.
   */
  feed(id: number, x: number, z: number, dx: number, dz: number, speed: number, k: number, halfW: number): void {
    let slot: WakeSlot | null = null;
    // Its own slot, else the one whose boat fed longest ago (its wake has faded, or will be the least missed); a slot
    // taken this frame counts as the oldest until the update, so a second newcomer this frame takes it over.
    let oldest = this.slots[0]!;
    for (const s of this.slots) {
      if (s.id === id) slot = s;
      if (s.seen < oldest.seen) oldest = s;
    }
    if (!slot) {
      slot = oldest;
      slot.id = id;
      slot.count = 0;
      slot.next = 0;
      slot.seen = -Infinity;
    }
    slot.fed = true;
    slot.halfW = halfW;
    slot.hx = x;
    slot.hz = z;
    slot.hdx = dx;
    slot.hdz = dz;
    slot.hSpeed = speed;
    slot.hk = k;
  }

  /** Takes the points fed since the last update and rewrites the ribbons for renderer time `now`. */
  update(now: number): void {
    let drawn = 0;
    for (let b = 0; b < WAKE_BOATS; b++) {
      const s = this.slots[b]!;
      if (s.fed) {
        s.seen = now;
        this.take(s, now);
      }
      drawn += this.lay(s, b, now);
      s.fed = false;
    }
    this.points = drawn;
    this.mesh.visible = drawn > 0;
    if (drawn > 0) {
      (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.getAttribute('aFoam') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Stores the fed stern as a new point once it is WAKE_STEP m past the last, or as the first after a jump. */
  private take(s: WakeSlot, now: number): void {
    const last = (s.next + WAKE_POINTS - 1) % WAKE_POINTS;
    const gap = s.count > 0 ? Math.hypot(s.hx - s.x[last]!, s.hz - s.z[last]!) : Infinity;
    if (gap > WAKE_JUMP) s.count = 0;
    else if (gap < WAKE_STEP) return;
    const i = s.next;
    s.x[i] = s.hx;
    s.z[i] = s.hz;
    s.dx[i] = s.hdx;
    s.dz[i] = s.hdz;
    s.speed[i] = s.hSpeed;
    s.k[i] = s.hk;
    s.t[i] = now;
    s.next = (i + 1) % WAKE_POINTS;
    s.count = Math.min(WAKE_POINTS, s.count + 1);
  }

  /**
   * Writes boat slot `b`'s three ribbons, newest point (the head, while it is under way) first; the vertices past its
   * last live point collapse onto it with no strength, so their triangles have no area. Returns the points drawn.
   */
  private lay(s: WakeSlot, b: number, now: number): number {
    let n = 0;
    let x = 0;
    let z = 0;
    for (let j = 0; j <= WAKE_POINTS; j++) {
      let dx: number;
      let dz: number;
      let speed: number;
      let k: number;
      let age: number;
      if (s.fed && j === 0) {
        x = s.hx;
        z = s.hz;
        dx = s.hdx;
        dz = s.hdz;
        speed = s.hSpeed;
        k = s.hk;
        age = 0;
      } else {
        const back = s.fed ? j - 1 : j;
        if (back >= s.count) break;
        const i = (s.next + WAKE_POINTS - 1 - back) % WAKE_POINTS;
        age = now - s.t[i]!;
        if (!(age < WAKE_LIFE)) break;
        x = s.x[i]!;
        z = s.z[i]!;
        dx = s.dx[i]!;
        dz = s.dz[i]!;
        speed = s.speed[i]!;
        k = s.k[i]!;
      }
      n++;
      const trail = k * Math.max(0, 1 - age / TRAIL_LIFE) ** 2;
      const arm = 0.8 * k * Math.max(0, 1 - age / WAKE_LIFE) ** 1.5;
      // The trail widens slowly from the hull's width; each arm runs out from the hull's side at the Kelvin angle,
      // KELVIN times the distance the boat has gone since, and its broken crest widens as it goes. (-dz, dx) is left
      // of the heading of travel.
      const trailW = s.halfW * 0.7 + 0.3 * age;
      const out = s.halfW * 0.85 + KELVIN * speed * age;
      const armW = 0.3 + 0.1 * age;
      this.vertex(b, 0, j, x, z, -dz * trailW, dx * trailW, trail, 0);
      this.vertex(b, 1, j, x - dz * out, z + dx * out, -dz * armW, dx * armW, arm, 1);
      this.vertex(b, 2, j, x + dz * out, z - dx * out, -dz * armW, dx * armW, arm, 1);
    }
    // The rest collapse onto the last point drawn; with none drawn the slot was collapsed already.
    if (n > 0 || s.drawn > 0) for (let j = n; j <= WAKE_POINTS; j++) for (let r = 0; r < RIBBONS; r++) this.vertex(b, r, j, x, z, 0, 0, 0, 0);
    s.drawn = n;
    return n;
  }

  /** Point j of ribbon r of boat slot b: its two edges at (x, z) +- (wx, wz), with strength k, on the trail (0) or an arm (1). */
  private vertex(b: number, r: number, j: number, x: number, z: number, wx: number, wz: number, k: number, kind: number): void {
    const v = (b * RIBBONS + r) * RIBBON_VERTS + j * 2;
    const p = this.pos;
    const f = this.foam;
    p[v * 3] = x + wx;
    p[v * 3 + 2] = z + wz;
    p[v * 3 + 3] = x - wx;
    p[v * 3 + 5] = z - wz;
    f[v * 3] = k;
    f[v * 3 + 1] = 1;
    f[v * 3 + 2] = kind;
    f[v * 3 + 3] = k;
    f[v * 3 + 4] = -1;
    f[v * 3 + 5] = kind;
  }

  /** Forgets every boat's wake (a new session). */
  clear(): void {
    for (const s of this.slots) {
      s.id = -1;
      s.count = 0;
      s.next = 0;
      s.fed = false;
      s.seen = -Infinity;
    }
    this.points = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
