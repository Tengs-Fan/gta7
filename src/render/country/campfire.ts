// The campground's campfire (world/country/lake.ts: the fire ring; render/country/lake.ts draws its stones and logs): burning
// from dusk until the first light (world/country/lakeland.ts campfireLit). Its embers, a glowing bed in the ring, a halo and
// a pool of firelight on the ground are a draw each, their strength flickering with the fire's; its flames and smoke are the
// effects' (Effects.groundFire, as a molotov's fire), and its light is the molotovs' too: the shared flash light lent to the
// fire (Effects.fireLight), so the scene's light count stays what it was. Low has no dynamic lights, so the pool and the halo
// are what it shows.

import * as THREE from 'three';
import { campfireLit } from '../../world/country/lakeland';
import type { V3 } from '../../core/math';
import type { Effects } from '../effects';
import { canvas, glowTexture, toTexture } from '../textures/misc';
import type { CountryView } from './index';

/** How near (m) the camera must be for the fire's flames and light to be made, and the light's strength at full burn. */
const FLAME_RANGE = 110;
const FIRE_LIGHT = 7;
/** How far (m) its halo sprite is drawn. */
const HALO_RANGE = 700;
/** The fire's pool of light on the ground: its width (m). */
const POOL = 15;

export class Campfire {
  private readonly poolMat: THREE.MeshBasicMaterial;
  private readonly haloMat: THREE.PointsMaterial;
  private readonly emberMat: THREE.MeshBasicMaterial;
  private readonly halo: THREE.Points;
  private readonly at: { x: number; y: number; z: number };
  private lit = 0;
  private holding = false;

  constructor(view: CountryView) {
    const camp = view.world.layout.country.lakeland.camp;
    this.at = camp.fire;
    const { x, y, z } = this.at;
    this.emberMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    // The embers and the pool are cells of the county's like any layer of it, hidden with them; the halo is a point sprite,
    // hidden by its own distance (update).
    view.add(new THREE.CircleGeometry(camp.ring * 0.72, 14).rotateX(-Math.PI / 2).translate(x, y + 0.07, z), this.emberMat, { split: false, receive: false, name: 'campfire-embers' });
    const [pc, px] = canvas(64, 64);
    const g = px.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,170,70,1)');
    g.addColorStop(0.45, 'rgba(255,120,40,0.4)');
    g.addColorStop(1, 'rgba(255,90,20,0)');
    px.fillStyle = g;
    px.fillRect(0, 0, 64, 64);
    this.poolMat = new THREE.MeshBasicMaterial({ map: toTexture(pc, true, false), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    view.add(new THREE.PlaneGeometry(POOL, POOL).rotateX(-Math.PI / 2).translate(x, y + 0.09, z), this.poolMat, { split: false, receive: false, name: 'campfire-pool' });
    const halo = new THREE.BufferGeometry();
    halo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x, y + 0.7, z]), 3));
    this.haloMat = new THREE.PointsMaterial({ map: glowTexture(), color: 0xffa04a, size: 3.4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.halo = new THREE.Points(halo, this.haloMat);
    this.halo.name = 'campfire-halo';
    this.halo.frustumCulled = false;
    this.halo.visible = false;
    view.group.add(this.halo);
  }

  /** A flicker 0.7..1: two incommensurate sines and a fast one, as the molotov fire's. */
  private flicker(time: number): number {
    return 0.78 + 0.22 * Math.sin(time * 23) * Math.sin(time * 7.3 + 1) + 0.04 * Math.sin(time * 61);
  }

  /** Each frame, at the clock's `hours` and the draw's `time`, the camera at `cam`: how far the embers, the halo and the pool glow, and none of them drawn while it is out or far away. */
  update(hours: number, time: number, cam: V3): void {
    this.lit = campfireLit(hours);
    const f = this.flicker(time);
    const on = this.lit > 0.01;
    this.emberMat.opacity = this.lit * (0.55 + 0.4 * f);
    this.haloMat.opacity = this.lit * 0.75 * f;
    this.poolMat.opacity = this.lit * 0.6 * f;
    this.emberMat.visible = this.poolMat.visible = on;
    this.halo.visible = on && Math.hypot(cam.x - this.at.x, cam.z - this.at.z) < HALO_RANGE;
  }

  /**
   * Each frame the sim is in view, `dt` s on with the camera at `cam`: the flames and smoke while it burns and the camera is
   * within FLAME_RANGE of it, and, unless a molotov's fire holds it (`taken`), the flash light lent to it. Whether it holds the
   * light is its own business: it lets it go once out of range or burnt down.
   */
  sync(fx: Effects, dt: number, cam: V3, time: number, taken: boolean): void {
    const { x, y, z } = this.at;
    const near = Math.hypot(cam.x - x, cam.z - z) < FLAME_RANGE && this.lit > 0.05;
    if (near && dt > 0) fx.groundFire(x, y + 0.12, z, 0.3, dt, this.lit);
    const want = near && !taken;
    if (want) this.holding = fx.fireLight(x, y + 0.9, z, FIRE_LIGHT * this.lit * this.flicker(time));
    else if (this.holding) {
      // A molotov's fire that has taken the light wrote it this frame: let go without zeroing it.
      if (!taken) fx.fireLight(0, 0, 0, 0);
      this.holding = false;
    }
  }

  reset(): void {
    this.holding = false;
  }
}
