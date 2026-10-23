// Presentation of the wave-1 jobs: the burning bins of a firefighter job (the burning cars are ordinary vehicles) and
// the fire truck's water jet. The same on every tier: a handful of meshes and the shared effects' particles.

import * as THREE from 'three';
import { activityFires } from '../sim/activities/firefighter';
import type { ViewState } from '../sim/viewState';
import { waterJetOf } from '../sim/waterCannon';
import type { Effects } from './effects';

const DROPS = 140;
const BINS = 6;
const tmp = new THREE.Object3D();

export class ActivityFxView {
  readonly group = new THREE.Group();
  private readonly drops: THREE.InstancedMesh;
  private readonly bins: THREE.Mesh[] = [];
  private steamTimer = 0;

  constructor() {
    const dropMat = new THREE.MeshBasicMaterial({ color: 0xe4f4ff, transparent: true, opacity: 0.75, depthWrite: false });
    this.drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), dropMat, DROPS);
    this.drops.name = 'water-jet';
    this.drops.frustumCulled = false;
    this.drops.visible = false;
    this.group.add(this.drops);
    const binGeo = new THREE.CylinderGeometry(0.36, 0.3, 0.9, 10).translate(0, 0.45, 0);
    const binMat = new THREE.MeshStandardMaterial({ color: 0x3b4a3a, roughness: 0.8, metalness: 0.3 });
    for (let i = 0; i < BINS; i++) {
      const b = new THREE.Mesh(binGeo, binMat);
      b.name = 'fire-bin';
      b.castShadow = true;
      b.visible = false;
      this.bins.push(b);
      this.group.add(b);
    }
  }

  /** Mirrors this frame's fires and jets; `time` animates the jet. */
  sync(sim: ViewState, dt: number, fx: Effects, time: number): void {
    const fires = activityFires(sim.activities.job);
    let b = 0;
    for (const f of fires) {
      if (f.vehicle) continue;
      const bin = this.bins[b++];
      if (bin) {
        bin.position.set(f.x, f.y, f.z);
        bin.visible = true;
      }
      // A bin's flames shrink as the water beats them down; steam rises once they are out.
      if (f.strength > 0 && Math.random() < 0.35 + 0.65 * f.strength) fx.vehicleSmoke(f.x, f.y + 0.9, f.z, 0, true, false, dt);
      else if (f.strength <= 0) fx.vehicleSmoke(f.x, f.y + 0.9, f.z, 0.3, false, false, dt);
    }
    for (; b < this.bins.length; b++) this.bins[b]!.visible = false;

    let n = 0;
    this.steamTimer += dt;
    for (const v of sim.vehicles) {
      if (v.removed || !v.spec.waterCannon) continue;
      const jet = waterJetOf(v, sim.frame);
      if (!jet) continue;
      const h = Math.hypot(jet.dx, jet.dz) || 1;
      const ux = jet.dx / h;
      const uz = jet.dz / h;
      const tan = jet.dy / h;
      const reach = jet.reach;
      const gy = sim.world.groundHeight(jet.ox + ux * reach, jet.oz + uz * reach);
      // A parabola from the nozzle along its pitch, landing where the sim says the jet comes down.
      const k = (jet.oy - gy + tan * reach) / (reach * reach);
      for (let i = 0; i < DROPS && n < DROPS; i++, n++) {
        const u = (i / DROPS + time * 1.9) % 1;
        const d = u * reach;
        const wob = Math.sin(i * 12.9898 + time * 9) * 0.35 * u;
        const lift = Math.cos(i * 78.233 + time * 7) * 0.25 * u;
        tmp.position.set(jet.ox + ux * d - uz * wob, jet.oy + tan * d - k * d * d + lift, jet.oz + uz * d + ux * wob);
        tmp.scale.setScalar(0.12 + 0.38 * u);
        tmp.updateMatrix();
        this.drops.setMatrixAt(n, tmp.matrix);
      }
      if (this.steamTimer > 0.04) {
        fx.tireSmoke(jet.ox + ux * reach, gy + 0.3, jet.oz + uz * reach);
        fx.tireSmoke(jet.ox + ux * reach * 0.6, jet.oy + tan * reach * 0.6 - k * (reach * 0.6) ** 2, jet.oz + uz * reach * 0.6);
      }
    }
    if (this.steamTimer > 0.04) this.steamTimer = 0;
    this.drops.count = n;
    this.drops.visible = n > 0;
    if (n > 0) this.drops.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.drops.count = 0;
    this.drops.visible = false;
    for (const b of this.bins) b.visible = false;
  }
}
