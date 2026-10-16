// Third-person camera: over-the-shoulder on foot, chase cam in vehicles,
// orbit when wasted, slow flyover on the title screen. Collides with buildings.

import * as THREE from 'three';
import { clamp, damp, dampAngle, wrapAngle, type V3 } from '../core/math';
import type { Sim } from '../sim/sim';
import { isSolidForSight, makeRayHit } from '../world/colliders';

export type CameraMode = 'play' | 'title';

const hit = makeRayHit();

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  /** Horizontal view heading (same convention as entity headings). */
  yaw = 0;
  pitch = -0.12;
  sensitivity = 1;
  invertY = false;
  zoomLevel = 0;
  mode: CameraMode = 'title';
  private vehYaw = 0;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private lookIdle = 10;
  private readonly target = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly dir = new THREE.Vector3(0, 0, 1);
  private fov = 68;
  private dist = 4.4;
  private shakeAmt = 0;
  private titleT = 0;
  private deathT = 0;
  private wasInVehicle = false;
  private initialized = false;
  baseFov = 68;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(68, aspect, 0.3, 2400);
    this.camera.position.set(0, 80, 200);
  }

  /** Mouse / stick look input in pixels (or equivalent). */
  look(dx: number, dy: number): void {
    const k = 0.0024 * this.sensitivity;
    const ky = (this.invertY ? -1 : 1) * k;
    if (this.wasInVehicle) {
      this.orbitYaw = wrapAngle(this.orbitYaw - dx * k);
      this.orbitPitch = clamp(this.orbitPitch - dy * ky, -0.5, 0.6);
    } else {
      this.yaw = wrapAngle(this.yaw - dx * k);
      this.pitch = clamp(this.pitch - dy * ky, -1.25, 0.85);
    }
    if (Math.abs(dx) + Math.abs(dy) > 0.5) this.lookIdle = 0;
  }

  addShake(amount: number): void {
    this.shakeAmt = Math.min(2, this.shakeAmt + amount);
  }

  /** Ray through the centre of the screen. */
  aimRay(): { origin: V3; dir: V3 } {
    return {
      origin: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      dir: { x: this.dir.x, y: this.dir.y, z: this.dir.z },
    };
  }

  update(dt: number, sim: Sim, aiming: boolean): void {
    this.lookIdle += dt;
    if (this.mode === 'title') {
      this.updateTitle(dt);
      return;
    }
    const p = sim.player;
    const v = p.vehicle;
    const cam = this.camera;
    if (!this.initialized) {
      this.initialized = true;
      this.yaw = p.heading;
      this.target.set(p.pos.x, p.pos.y + 1.55, p.pos.z);
    }
    if (v && !this.wasInVehicle) {
      this.vehYaw = v.heading;
      this.orbitYaw = wrapAngle(this.yaw - v.heading);
      this.orbitPitch = 0;
    } else if (!v && this.wasInVehicle) {
      this.yaw = wrapAngle(this.vehYaw + this.orbitYaw);
      this.pitch = -0.12;
    }
    this.wasInVehicle = !!v;

    let lookFrom: THREE.Vector3;
    let fovTarget = this.baseFov;
    if (sim.playerDown && sim.deathKind === 'wasted') {
      this.deathT += dt;
      const tx = p.pos.x;
      const tz = p.pos.z;
      this.target.lerp(new THREE.Vector3(tx, p.pos.y + 0.5, tz), 1 - Math.exp(-6 * dt));
      const a = this.yaw + this.deathT * 0.35;
      const r = 6 + this.deathT * 0.6;
      this.desired.set(tx - Math.sin(a) * r, p.pos.y + 3 + this.deathT * 0.8, tz - Math.cos(a) * r);
      lookFrom = this.target.clone();
      this.dir.copy(this.target).sub(this.desired).normalize();
    } else if (v) {
      this.deathT = 0;
      const speed = v.speed;
      let desiredYaw = v.heading;
      if (speed > 6 && v.forwardSpeed > 0) desiredYaw = Math.atan2(v.vel.x, v.vel.z);
      if (v.forwardSpeed < -4) desiredYaw = v.heading;
      this.vehYaw = dampAngle(this.vehYaw, desiredYaw, v.airborne ? 1.5 : 4.2, dt);
      if (this.lookIdle > 1.4) {
        this.orbitYaw = dampAngle(this.orbitYaw, 0, 2.6, dt);
        this.orbitPitch = damp(this.orbitPitch, 0, 2.6, dt);
      }
      const yaw = this.vehYaw + this.orbitYaw;
      this.yaw = wrapAngle(yaw);
      const s = v.spec;
      const zoom = this.zoomLevel === 1 ? 1.5 : 1;
      const dist = (5.2 + s.length * 0.72) * zoom;
      const height = (1.3 + s.height * 0.6) * (this.zoomLevel === 1 ? 1.25 : 1);
      this.target.lerp(new THREE.Vector3(v.pos.x, v.pos.y + s.height * 0.75, v.pos.z), 1 - Math.exp(-18 * dt));
      const pitch = -0.08 + this.orbitPitch;
      const fx = Math.sin(yaw) * Math.cos(pitch);
      const fz = Math.cos(yaw) * Math.cos(pitch);
      this.desired.set(this.target.x - fx * dist, this.target.y + height - Math.sin(pitch) * dist * 0.3, this.target.z - fz * dist);
      const look = new THREE.Vector3(this.target.x + Math.sin(yaw) * 3, this.target.y + 0.3, this.target.z + Math.cos(yaw) * 3);
      this.dir.copy(look).sub(this.desired).normalize();
      lookFrom = this.target.clone();
      fovTarget = this.baseFov + clamp(speed / s.maxSpeed, 0, 1) * 13;
      this.pitch = Math.asin(clamp(this.dir.y, -1, 1));
    } else {
      this.deathT = 0;
      const swimming = p.state === 'swimming';
      const lying = p.state === 'knocked' || p.state === 'dead';
      const headY = swimming ? 1.6 : lying ? 0.7 : 1.58 * p.appearance.height;
      this.target.lerp(new THREE.Vector3(p.pos.x, p.pos.y + headY, p.pos.z), 1 - Math.exp(-22 * dt));
      const distTarget = aiming ? 2.4 : this.zoomLevel === 1 ? 6.6 : 4.3;
      this.dist = damp(this.dist, distTarget, 10, dt);
      const shoulder = aiming ? 0.62 : 0.42;
      const cy = Math.cos(this.pitch);
      this.dir.set(Math.sin(this.yaw) * cy, Math.sin(this.pitch), Math.cos(this.yaw) * cy);
      const rx = -Math.cos(this.yaw);
      const rz = Math.sin(this.yaw);
      // Right of the camera is (-cos yaw, sin yaw): shift the character to the left of the crosshair.
      this.desired.set(this.target.x - this.dir.x * this.dist + rx * shoulder, this.target.y - this.dir.y * this.dist + 0.18, this.target.z - this.dir.z * this.dist + rz * shoulder);
      lookFrom = new THREE.Vector3(this.target.x + rx * shoulder * 0.5, this.target.y, this.target.z + rz * shoulder * 0.5);
      fovTarget = aiming ? this.baseFov - 16 : this.baseFov;
    }

    // Keep the camera out of buildings.
    const d = this.desired.clone().sub(lookFrom);
    const len = d.length();
    if (len > 0.01) {
      d.divideScalar(len);
      if (sim.world.grid.raycast(lookFrom.x, lookFrom.y, lookFrom.z, d.x, d.y, d.z, len, hit, isSolidForSight)) {
        const t = Math.max(0.35, hit.t - 0.3);
        this.desired.copy(lookFrom).addScaledVector(d, t);
      }
    }
    const gy = sim.world.groundHeight(this.desired.x, this.desired.z);
    if (this.desired.y < gy + 0.35) this.desired.y = gy + 0.35;

    cam.position.copy(this.desired);
    if (this.shakeAmt > 0.001) {
      const s = this.shakeAmt * 0.18;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
      this.shakeAmt *= Math.exp(-5 * dt);
    }
    this.fov = damp(this.fov, fovTarget, 6, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    cam.lookAt(cam.position.x + this.dir.x, cam.position.y + this.dir.y, cam.position.z + this.dir.z);
  }

  private updateTitle(dt: number): void {
    this.titleT += dt;
    const a = this.titleT * 0.045 + 0.6;
    const r = 260;
    const cam = this.camera;
    cam.position.set(Math.cos(a) * r, 95 + Math.sin(this.titleT * 0.1) * 12, Math.sin(a) * r);
    const look = new THREE.Vector3(0, 30, 0);
    this.dir.copy(look).sub(cam.position).normalize();
    cam.lookAt(look);
    if (cam.fov !== 55) {
      cam.fov = 55;
      cam.updateProjectionMatrix();
    }
  }

  /** Snap behind the player (after respawn / teleport). */
  reset(sim: Sim): void {
    const p = sim.player;
    this.yaw = p.vehicle ? p.vehicle.heading : p.heading;
    this.vehYaw = this.yaw;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.pitch = -0.12;
    const pos = sim.playerPos();
    this.target.set(pos.x, pos.y + 1.5, pos.z);
    this.wasInVehicle = !!p.vehicle;
    this.initialized = true;
  }
}
