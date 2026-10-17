// Owns the three.js renderer and scene; mirrors the simulation every frame.

import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Sim } from '../sim/sim';
import type { Vehicle } from '../sim/entities';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import type { StaticWorld } from '../world/staticWorld';
import { CameraController } from './camera';
import { CityView } from './city';
import { CrowdView } from './crowd';
import { Effects } from './effects';
import { Environment } from './environment';
import { MarkerView } from './markers';
import { PropsView } from './props';
import { VehicleView, VehicleViewPool } from './vehicleView';

export type Quality = 'low' | 'medium' | 'high';

export interface RenderSettings {
  quality: Quality;
  fov: number;
}

function supportsHalfFloatTargets(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ok = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cameraCtl: CameraController;
  readonly env: Environment;
  readonly city: CityView;
  readonly props: PropsView;
  readonly crowd = new CrowdView();
  readonly effects = new Effects();
  readonly markers = new MarkerView();
  private readonly vehicleViews = new Map<number, VehicleView>();
  private readonly pool = new VehicleViewPool();
  private readonly headlight: THREE.SpotLight;
  private readonly siren: THREE.PointLight;
  private bloom: UnrealBloomPass | null = null;
  private readonly hdr: boolean;
  private sim: Sim | null = null;
  private unsub: Array<() => void> = [];
  private smokeTimer = 0;
  private quality: Quality = 'high';
  time = 0;

  constructor(canvas: HTMLCanvasElement, private readonly world: StaticWorld, settings: RenderSettings) {
    this.hdr = supportsHalfFloatTargets();
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      outputBufferType: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The HDR output pass would otherwise reset the counters; reset them per frame instead.
    this.renderer.info.autoReset = false;
    this.cameraCtl = new CameraController(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.cameraCtl.baseFov = settings.fov;

    this.env = new Environment(this.scene, this.renderer);
    this.city = new CityView(world);
    this.props = new PropsView(world);
    this.scene.add(this.city.group, this.props.group, this.crowd.group, this.effects.group, this.markers.group);

    this.headlight = new THREE.SpotLight(0xfff4dc, 0, 70, 0.55, 0.55, 1.4);
    this.scene.add(this.headlight, this.headlight.target);
    this.siren = new THREE.PointLight(0xff2020, 0, 30, 1.6);
    this.scene.add(this.siren);

    this.setQuality(settings.quality);
    this.resize();
    this.warmup();
  }

  /** Builds one view per vehicle kind and compiles every shader up front to avoid hitches later. */
  private warmup(): void {
    const tmp: VehicleView[] = [];
    for (const kind of Object.keys(VEHICLE_SPECS) as VehicleKind[]) {
      const v = this.pool.acquire(kind);
      v.group.position.set(0, -50, 0);
      this.scene.add(v.group);
      tmp.push(v);
    }
    try {
      this.renderer.compile(this.scene, this.cameraCtl.camera);
    } catch {
      // Compilation is an optimisation only.
    }
    for (const v of tmp) this.pool.release(v);
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const dpr = Math.min(window.devicePixelRatio || 1, q === 'high' ? 1.5 : q === 'medium' ? 1.15 : 0.8);
    this.renderer.setPixelRatio(dpr);
    const shadows = q !== 'low';
    this.env.setShadows(shadows);
    this.env.sun.shadow.mapSize.set(q === 'high' ? 2048 : 1024, q === 'high' ? 2048 : 1024);
    this.env.sun.shadow.map?.dispose();
    (this.env.sun.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
    if (this.hdr) {
      if (q === 'low') {
        this.renderer.setEffects([]);
        this.bloom = null;
      } else if (!this.bloom) {
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        // Threshold sits above sun-lit albedo so only emissive lights, the sun and explosions bloom.
        this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.6, 0.5, 2.6);
        this.renderer.setEffects([this.bloom]);
      }
    }
    this.resize();
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  setFov(fov: number): void {
    this.cameraCtl.baseFov = fov;
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    const cam = this.cameraCtl.camera;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }

  attach(sim: Sim): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    for (const v of this.vehicleViews.values()) {
      this.scene.remove(v.group);
      this.pool.release(v);
    }
    this.vehicleViews.clear();
    this.effects.reset();
    this.sim = sim;
    const fx = this.effects;
    const ev = sim.events;
    this.unsub.push(
      ev.on('shot', (e) => {
        const big = e.weapon === 'shotgun' || e.weapon === 'rocket';
        if (e.shooter || e.weapon === 'rifle') fx.muzzleFlash(e.fx, e.fy, e.fz, big);
        if (e.weapon === 'rocket') fx.rocketLaunched(e.fx, e.fy, e.fz);
        if (e.weapon !== 'rocket' && e.weapon !== 'fists') {
          fx.tracer(e.fx, e.fy, e.fz, e.tx, e.ty, e.tz);
          if (e.hit === 'world' || e.hit === 'vehicle' || e.hit === 'flesh') fx.impact(e.tx, e.ty, e.tz, e.nx, e.ny, e.nz, e.hit);
        }
      }),
      ev.on('explosion', (e) => {
        fx.explosion(e.x, e.y, e.z, e.radius);
        const c = this.cameraCtl.camera.position;
        const d = Math.hypot(c.x - e.x, c.y - e.y, c.z - e.z);
        // The only blast shake: grows with the radius and fades out by about 70 m.
        this.cameraCtl.addShake((e.radius / 7.5) * Math.max(0, 2.4 - d / 30));
      }),
      ev.on('impact', (e) => {
        if (e.strength > 7) fx.debris(e.x, e.y, e.z);
        if (e.vehicle && e.vehicle.driver === sim.player) this.cameraCtl.addKick(e.x - e.vehicle.pos.x, e.z - e.vehicle.pos.z, e.strength);
      }),
      ev.on('propBroken', (e) => {
        this.props.breakProp(e.index, e.dirX, e.dirZ);
        const p = this.world.layout.props[e.index];
        if (p?.kind === 'hydrant') fx.hydrantSpray(p.x, p.y, p.z);
      }),
      ev.on('splash', (e) => fx.splash(e.x, e.y, e.z, e.big)),
      ev.on('blood', (e) => fx.impact(e.x, e.y, e.z, -e.dx, -e.dy, -e.dz, 'flesh')),
    );
  }

  private syncVehicles(sim: Sim, dt: number, night: number): void {
    const seen = new Set<number>();
    for (const v of sim.vehicles) {
      if (v.removed) continue;
      seen.add(v.id);
      let view = this.vehicleViews.get(v.id);
      if (!view) {
        view = this.pool.acquire(v.kind);
        view.bind(v);
        this.scene.add(view.group);
        this.vehicleViews.set(v.id, view);
      }
      view.sync(v, dt, this.time, night);
    }
    for (const [id, view] of this.vehicleViews) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        this.pool.release(view);
        this.vehicleViews.delete(id);
        this.effects.skids.break(`${id}:l`);
        this.effects.skids.break(`${id}:r`);
      }
    }
  }

  private vehicleEffects(sim: Sim, dt: number): void {
    const fx = this.effects;
    this.smokeTimer += dt;
    const tireSmoke = this.smokeTimer > 0.05;
    if (tireSmoke) this.smokeTimer = 0;
    const cam = this.cameraCtl.camera.position;
    for (const v of sim.vehicles) {
      if (v.removed) continue;
      const d2 = (v.pos.x - cam.x) ** 2 + (v.pos.z - cam.z) ** 2;
      if (d2 > 220 * 220) continue;
      const fxh = Math.sin(v.heading);
      const fzh = Math.cos(v.heading);
      const hx = v.pos.x + fxh * v.halfL * 0.62;
      const hz = v.pos.z + fzh * v.halfL * 0.62;
      // Nothing smokes or burns in the sea (cars that drown are marked destroyed, with no health left).
      if (!v.inWater && (v.burning || (v.destroyed && v.wreckTime < 25) || v.condition < 0.45)) {
        fx.vehicleSmoke(v.destroyed ? v.pos.x : hx, v.pos.y + v.spec.height * 0.55, v.destroyed ? v.pos.z : hz, v.condition, v.burning, v.destroyed && v.wreckTime < 25, dt);
      }
      if (v.skid > 0.25 && !v.airborne && !v.inWater && v.speed > 2) {
        const sx = Math.cos(v.heading);
        const sz = -Math.sin(v.heading);
        const rx = v.pos.x - fxh * v.halfL * 0.62;
        const rz = v.pos.z - fzh * v.halfL * 0.62;
        for (const [side, key] of [[1, 'l'], [-1, 'r']] as const) {
          const wx = rx + sx * side * (v.halfW - 0.18);
          const wz = rz + sz * side * (v.halfW - 0.18);
          fx.skids.add(`${v.id}:${key}`, wx, v.pos.y, wz, this.time);
          if (tireSmoke && v.skid > 0.55 && d2 < 90 * 90) fx.tireSmoke(wx, v.pos.y, wz);
        }
      } else if (v.airborne) {
        fx.skids.break(`${v.id}:l`);
        fx.skids.break(`${v.id}:r`);
      }
    }
  }

  private syncLights(sim: Sim, night: number): void {
    const v = sim.player.vehicle;
    if (v && night > 0.25 && !v.destroyed) {
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      this.headlight.position.set(v.pos.x + fx * v.halfL, v.pos.y + 0.8, v.pos.z + fz * v.halfL);
      this.headlight.target.position.set(v.pos.x + fx * (v.halfL + 25), v.pos.y - 0.5, v.pos.z + fz * (v.halfL + 25));
      this.headlight.target.updateMatrixWorld();
      this.headlight.intensity = 260 * night;
    } else {
      this.headlight.intensity = 0;
    }
    // Siren glow from the closest police car with the siren on.
    const cam = this.cameraCtl.camera.position;
    let best: Vehicle | null = null;
    let bd = 70;
    for (const u of sim.vehicles) {
      if (!u.siren || u.removed || u.destroyed) continue;
      const d = Math.hypot(u.pos.x - cam.x, u.pos.z - cam.z);
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    if (best) {
      const red = Math.floor(this.time * 6) % 2 === 0;
      this.siren.color.setHex(red ? 0xff2020 : 0x2050ff);
      this.siren.position.set(best.pos.x, best.pos.y + best.spec.height + 0.6, best.pos.z);
      this.siren.intensity = 40 + 160 * night;
    } else {
      this.siren.intensity = 0;
    }
  }

  /** Mirrors the sim (if any) and renders one frame. */
  render(dt: number, aiming: boolean): void {
    this.time += dt;
    const sim = this.sim;
    const cam = this.cameraCtl.camera;
    if (sim) this.cameraCtl.update(dt, sim, aiming);
    const hours = sim ? sim.clock.hours : 17.5;
    const focus = sim && this.cameraCtl.mode === 'play' ? new THREE.Vector3(cam.position.x * 0.5 + sim.playerPos().x * 0.5, 0, cam.position.z * 0.5 + sim.playerPos().z * 0.5) : new THREE.Vector3(cam.position.x * 0.3, 0, cam.position.z * 0.3);
    this.env.update(hours, focus, cam, this.time, this.renderer);
    const night = this.env.night;
    this.city.update(night);
    // Signals run on the sim clock, the one drivers and pedestrians obey.
    this.props.update(this.time, night, sim ? sim.time : this.time);
    if (sim) {
      this.syncVehicles(sim, dt, night);
      this.effects.syncRockets(sim.projectiles);
      this.vehicleEffects(sim, dt);
      this.crowd.sync(sim.characters, cam.position.x, cam.position.z, dt);
      this.markers.syncMarkers(sim.missions.active || sim.wanted.level > 0 ? sim.interactions.markers.filter((m) => m.kind !== 'mission') : sim.interactions.markers, this.time);
      const objectives = [...(sim.missions.active?.markers ?? []), ...sim.activities.objectives()];
      this.markers.syncObjectives(objectives, (x, z) => sim.world.groundHeight(x, z), this.time);
      this.markers.syncPickups(sim.pickups, this.time, cam.position.x, cam.position.z);
      this.markers.syncHelis(sim.helis, night, (x, z) => sim.world.groundHeight(x, z));
      this.syncLights(sim, night);
    }
    this.effects.update(dt, this.time);
    this.renderer.info.reset();
    this.renderer.render(this.scene, cam);
  }

  stats(): { calls: number; triangles: number; programs: number; particles: number; vehicles: number } {
    const info = this.renderer.info;
    return { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? 0, particles: this.effects.particleCount, vehicles: this.vehicleViews.size };
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.env.dispose();
    this.renderer.dispose();
  }
}
