// The Gull Regatta's gates (sim/activities/regatta.ts) while one is under way: a pair of buoys either side of each gate,
// bobbing on the sea, one instanced draw for the course. The gate to pass next stands out, its buoys larger (the
// objective marker rings it too), and the gates already passed are gone. The material is the turbines' (an instanced,
// vertex-coloured standard material), so the course hidden at warm-up has its program already. Presentation only.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { REGATTA_GATE_R, REGATTA_GATES, REGATTA_START } from '../sim/activities/regatta';
import type { ViewState } from '../sim/viewState';
import { WATER_Y } from '../world/constants';
import { seaHeightAt } from './boatView';
import type { SeaUniforms } from './sea';

/** A buoy stands this far (m) beyond the gate's radius, out of the way of a boat taking the gate wide. */
const BUOY_OUT = 1.5;

/** A racing buoy: a float with a red and white band, a cone on top and a short pole with a pennant, its waterline at 0. */
function buoyGeometry(): THREE.BufferGeometry {
  const parts: Array<[THREE.BufferGeometry, number]> = [
    [new THREE.CylinderGeometry(0.75, 0.6, 1.6, 14).translate(0, 0.1, 0), 0xffffff],
    [new THREE.CylinderGeometry(0.77, 0.77, 0.45, 14).translate(0, 0.55, 0), 0xd8331f],
    [new THREE.ConeGeometry(0.75, 0.9, 14).translate(0, 1.35, 0), 0xffffff],
    [new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6).translate(0, 2.4, 0), 0x3a3d42],
    [new THREE.BoxGeometry(0.03, 0.42, 0.7).translate(0, 2.95, 0.36), 0xd8331f],
  ];
  const c = new THREE.Color();
  const geos = parts.map(([g, color]) => {
    const geo = g.toNonIndexed();
    geo.deleteAttribute('uv');
    c.setHex(color);
    const rgb = new Float32Array(geo.getAttribute('position').count * 3);
    for (let i = 0; i < rgb.length; i += 3) rgb.set([c.r, c.g, c.b], i);
    geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    return geo;
  });
  const g = mergeGeometries(geos, false);
  if (!g) throw new Error('mergeGeometries failed');
  return g;
}

/**
 * Where the two buoys of each gate float, across the course there (its direction from the gate before to the one
 * after). The finish is also the start line, crossed northwards at the start.
 */
export function buoySpots(): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  REGATTA_GATES.forEach((g, i) => {
    const a = i === 0 ? REGATTA_START : REGATTA_GATES[i - 1]!;
    const b = REGATTA_GATES[i + 1];
    const len = b ? Math.hypot(b.x - a.x, b.z - a.z) : 1;
    const [dx, dz] = b ? [(b.x - a.x) / len, (b.z - a.z) / len] : [0, -1];
    const r = REGATTA_GATE_R + BUOY_OUT;
    out.push({ x: g.x - dz * r, z: g.z + dx * r }, { x: g.x + dz * r, z: g.z - dx * r });
  });
  return out;
}

export class RegattaView {
  readonly mesh: THREE.InstancedMesh;
  private readonly spots = buoySpots();
  private readonly phase = this.spots.map(() => Math.random() * Math.PI * 2);
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly big = new THREE.Vector3(1.4, 1.4, 1.4);
  private sea: SeaUniforms | null = null;

  constructor() {
    this.mesh = new THREE.InstancedMesh(buoyGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.1 }), this.spots.length);
    this.mesh.name = 'regattaBuoys';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    // Out on the course, wherever the camera is: the course is culled as a whole or not at all.
    this.mesh.frustumCulled = false;
  }

  /** The sea whose drawn waves the buoys ride (before the first sync). */
  bindSea(u: SeaUniforms): void {
    this.sea = u;
  }

  /** Shows the course while the local player's regatta runs: the next gate (the start line first) larger, those passed gone. */
  sync(sim: ViewState, time: number): void {
    const j = sim.activities.job;
    this.mesh.visible = j?.kind === 'regatta';
    if (j?.kind !== 'regatta') return;
    const finish = REGATTA_GATES.length - 1;
    const next = j.stage === 'racing' ? j.gate : finish;
    this.spots.forEach((s, i) => {
      const gate = i >> 1;
      const t = time * 1.4 + this.phase[i]!;
      const y = gate < next ? -100 : WATER_Y + seaHeightAt(this.sea, s.x, s.z) + Math.sin(t) * 0.12;
      this.e.set(Math.sin(t * 0.8) * 0.08, 0, Math.cos(t * 0.9) * 0.08);
      this.mesh.setMatrixAt(i, this.m.compose(this.p.set(s.x, y, s.z), this.q.setFromEuler(this.e), gate === next ? this.big : this.one));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
