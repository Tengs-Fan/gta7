// Turbine Row (world/offshore.ts): ten offshore wind turbines, instanced, so the row's towers, nacelles and rotors are
// one draw each. The rotors turn with the weather's wind and the nacelles swing slowly round to face it; red aviation
// lights on the nacelles blink together after dark, and foam laps at each tower's foot. The towers cast shadows wherever
// the tier draws them (High and Medium). Presentation only: Math.random phases, nothing read back by the sim.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Prop } from '../world/layout';
import { TURBINE_BASE, TURBINE_HUB, TURBINE_ROTOR } from '../world/offshore';
import type { StaticWorld } from '../world/staticWorld';
import { FoamRings } from './foamRings';
import { glowTexture } from './textures';

/** The rotor's plane stands this far (m) upwind of the tower's axis. */
const ROTOR_Z = 5.5;
/** How fast (rad/s) a nacelle turns to face a new wind. */
const YAW_RATE = 0.08;
/** An aviation light's beat: lit for LIGHT_ON of every LIGHT_PERIOD seconds, every light at once. */
const LIGHT_PERIOD = 1.5;
const LIGHT_ON = 0.5;
/** Where the light stands on the nacelle (its frame: +z upwind), and its halo's size on screen (px). */
const LIGHT_AT = new THREE.Vector3(0, TURBINE_HUB + 2.3, -6.5);
const LIGHT_HALO_PX = 16;
/** A foam ring spreads from each tower's foot every FOAM_EVERY seconds. */
const FOAM_EVERY = 1.3;

/**
 * Rotor speed (rad/s) in a wind of `speed` m/s: a tip speed ratio of about 6, turning over slowly in a calm, held at
 * its rated 12 rpm from a stiff breeze up.
 */
export function rotorSpeed(speed: number): number {
  return Math.min(1.25, 0.12 + speed * 0.15);
}

/** A cylinder from y0 to y1 with radii r0 (bottom) and r1 (top), coloured `color`. */
function column(r0: number, r1: number, y0: number, y1: number, seg: number, color: number): THREE.BufferGeometry {
  return tint(new THREE.CylinderGeometry(r1, r0, y1 - y0, seg).translate(0, (y0 + y1) / 2, 0), color);
}

function tint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgb.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('mergeGeometries failed');
  return g;
}

/** The tower, from below the waterline: a yellow transition piece with its platform, then the white mast tapering up. */
function towerGeometry(): THREE.BufferGeometry {
  return merge([
    column(TURBINE_BASE + 0.2, TURBINE_BASE + 0.2, -6, 12, 20, 0xe2b322),
    column(4.4, 4.4, 12, 12.4, 20, 0x5a5f66),
    column(TURBINE_BASE, 1.75, 12.4, TURBINE_HUB - 1.9, 20, 0xe9ecee),
  ]);
}

/** The nacelle on the tower's top, its front (+z) upwind. */
function nacelleGeometry(): THREE.BufferGeometry {
  return merge([
    tint(new THREE.BoxGeometry(3.6, 3.8, 11).translate(0, TURBINE_HUB, -1.8), 0xe9ecee),
    tint(new THREE.BoxGeometry(2.2, 0.5, 2.4).translate(0, TURBINE_HUB + 2.15, -5.6), 0xc9cdd1),
  ]);
}

/** Three blades round a spinner in the rotor's plane (local xy), the axis along +z. */
function rotorGeometry(): THREE.BufferGeometry {
  const len = TURBINE_ROTOR - 1.2;
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const blade = new THREE.BoxGeometry(2.8, len, 0.45, 1, 6, 1);
    const pos = blade.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      // Narrowing from the root to a slim tip, thinner too, and swept back a little towards the trailing edge.
      const t = (pos.getY(i) + len / 2) / len;
      const w = 1 - 0.78 * t;
      pos.setX(i, pos.getX(i) * w + 0.5 * t);
      pos.setZ(i, pos.getZ(i) * (1 - 0.6 * t));
    }
    blade.translate(0, len / 2 + 1.2, 0).rotateZ((k * Math.PI * 2) / 3);
    parts.push(tint(blade, 0xf1f3f4));
  }
  parts.push(tint(new THREE.ConeGeometry(1.5, 3.4, 14).rotateX(Math.PI / 2).translate(0, 0, 1.7), 0xe9ecee));
  parts.push(tint(new THREE.CylinderGeometry(1.5, 1.5, 1.6, 14).rotateX(Math.PI / 2).translate(0, 0, -0.8), 0xd6d9dc));
  const g = merge(parts);
  g.computeVertexNormals();
  return g;
}

export class TurbineView {
  readonly group = new THREE.Group();
  /** Foam at the towers' feet: a ShaderMaterial riding the sea's waves (kept out of the software stand-ins). */
  readonly foam = new FoamRings(40);
  private readonly turbines: Prop[];
  private readonly nacelles: THREE.InstancedMesh;
  private readonly rotors: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly halos: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly lightMat = new THREE.MeshBasicMaterial({ color: 0x330000, fog: false });
  /** Each rotor's own turn, so the row does not spin in step. */
  private readonly phase: number[];
  private angle = 0;
  /** The nacelles' heading (their +z upwind): north until the first wind, which they face at once. */
  private yaw = Math.PI;
  private aimed = false;
  private foamClock = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly spin = new THREE.Quaternion();
  private readonly turn = new THREE.Quaternion();
  private readonly base = new THREE.Vector3();
  private readonly at = new THREE.Vector3();
  private readonly hub = new THREE.Vector3(0, TURBINE_HUB, ROTOR_Z);
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly fwd = new THREE.Vector3(0, 0, 1);

  constructor(world: StaticWorld) {
    this.group.name = 'turbines';
    this.turbines = world.layout.props.filter((p) => p.kind === 'turbine');
    const n = this.turbines.length;
    this.phase = this.turbines.map(() => Math.random() * ((Math.PI * 2) / 3));
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.1 });
    const towers = new THREE.InstancedMesh(towerGeometry(), white, n);
    this.nacelles = new THREE.InstancedMesh(nacelleGeometry(), white, n);
    this.rotors = new THREE.InstancedMesh(rotorGeometry(), white, n);
    this.turbines.forEach((p, i) => towers.setMatrixAt(i, this.m.makeTranslation(p.x, p.y, p.z)));
    for (const [mesh, name] of [[towers, 'turbineTowers'], [this.nacelles, 'turbineNacelles'], [this.rotors, 'turbineRotors']] as const) {
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    this.lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), this.lightMat, n);
    this.lights.name = 'turbineLights';
    const haloGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    // Bright lights carry through the haze: neither the light nor its halo is fogged.
    this.halos = new THREE.Points(haloGeo, new THREE.PointsMaterial({ map: glowTexture(), color: 0xff2a14, size: LIGHT_HALO_PX, sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.halos.name = 'turbineHalos';
    this.halos.frustumCulled = false;
    this.group.add(this.lights, this.halos);
    this.place();
    towers.computeBoundingSphere();
    // The rotors turn and the nacelles swing within these spheres.
    for (const mesh of [this.nacelles, this.rotors, this.lights]) {
      mesh.computeBoundingSphere();
      mesh.boundingSphere!.radius += TURBINE_ROTOR;
    }
  }

  /** Sets every nacelle, rotor and light for the nacelles' heading and the rotors' turn now. */
  private place(): void {
    this.q.setFromAxisAngle(this.up, this.yaw);
    const halo = this.halos.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.turbines.forEach((p, i) => {
      const base = this.base.set(p.x, p.y, p.z);
      this.nacelles.setMatrixAt(i, this.m.compose(base, this.q, this.one));
      const light = this.at.copy(LIGHT_AT).applyQuaternion(this.q).add(base);
      this.lights.setMatrixAt(i, this.m.makeTranslation(light.x, light.y, light.z));
      halo.setXYZ(i, light.x, light.y, light.z);
      // Clockwise seen from upwind.
      this.spin.setFromAxisAngle(this.fwd, -(this.angle + this.phase[i]!));
      const hub = this.at.copy(this.hub).applyQuaternion(this.q).add(base);
      this.rotors.setMatrixAt(i, this.m.compose(hub, this.turn.copy(this.q).multiply(this.spin), this.one));
    });
    this.nacelles.instanceMatrix.needsUpdate = true;
    this.rotors.instanceMatrix.needsUpdate = true;
    this.lights.instanceMatrix.needsUpdate = true;
    halo.needsUpdate = true;
  }

  /**
   * Turns the rotors and the nacelles for this frame's wind (m/s, the direction the air moves), blinks the lights at
   * `night` (0..1) and lets the foam lap at the towers' feet in the scene's `light`.
   */
  update(dt: number, time: number, night: number, wind: { readonly x: number; readonly z: number }, light: THREE.Color): void {
    const speed = Math.hypot(wind.x, wind.z);
    if (speed > 0.01) {
      // Into the wind: the rotor faces where the air comes from.
      const want = Math.atan2(-wind.x, -wind.z);
      const d = this.aimed ? Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw)) : want - this.yaw;
      this.yaw += this.aimed ? Math.sign(d) * Math.min(Math.abs(d), YAW_RATE * dt) : d;
      this.aimed = true;
    }
    this.angle = (this.angle + rotorSpeed(speed) * dt) % (Math.PI * 2);
    this.place();
    // Both stay in the scene, dark between flashes and by day, so their programs are built with the rest at warm-up.
    const on = night > 0.3 && time % LIGHT_PERIOD < LIGHT_ON;
    this.lightMat.color.setRGB(on ? 1.6 : 0.2, on ? 0.08 : 0.02, on ? 0.05 : 0.02);
    this.halos.material.color.setHex(on ? 0xff2a14 : 0x000000);
    this.foamClock -= dt;
    if (this.foamClock <= 0) {
      this.foamClock = FOAM_EVERY;
      for (const p of this.turbines) this.foam.add(p.x, p.z, TURBINE_BASE + 4 + Math.random() * 2, 3.4, 0.55);
    }
    this.foam.light.copy(light);
    this.foam.update(dt);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) o.geometry.dispose();
    });
    this.halos.material.map?.dispose();
    this.halos.material.dispose();
    this.lightMat.dispose();
    this.foam.dispose();
  }
}
