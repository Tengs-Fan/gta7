// Owns the three.js renderer and scene; mirrors the simulation every frame.

import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Sim } from '../sim/sim';
import type { Vehicle } from '../sim/entities';
import { VEHICLE_SPECS, WEAPONS, type VehicleKind } from '../sim/specs';
import type { StaticWorld } from '../world/staticWorld';
import { CameraController } from './camera';
import { CityView } from './city';
import { CrowdView } from './crowd';
import { Effects, FLASH_SIZE } from './effects';
import { Environment } from './environment';
import { MarkerView } from './markers';
import { PropsView } from './props';
import { FEW_POINT_LIGHTS, pixelRatioFor, probeGpu, QUALITY, type GpuProbe, type QualityTier } from './quality';
import { VehicleView, VehicleViewPool } from './vehicleView';

export type Quality = QualityTier;

export interface RenderSettings {
  quality: Quality;
  fov: number;
  /** The boot-time GPU probe (taken here when absent). */
  gpu?: GpuProbe;
}

/** Vehicles below this condition smoke (as in vehicleEffects). */
const SMOKE_CONDITION = 0.45;
/**
 * The siren's light: intensity by day plus at night, and a short reach with inverse-square falloff, so it washes the
 * street around the car red and blue but leaves the facades a few metres away their own colour (P27).
 */
const SIREN_DAY = 25;
const SIREN_NIGHT = 25;
const SIREN_RANGE = 12;
const SIREN_DECAY = 2;

/** Every create / delete pair of WebGL 2 objects. */
const GL_PAIRS: ReadonlyArray<readonly [create: string, del: string]> = [
  ...['Buffer', 'Framebuffer', 'Program', 'Query', 'Renderbuffer', 'Sampler', 'Shader', 'Texture', 'TransformFeedback', 'VertexArray'].map((k) => [`create${k}`, `delete${k}`] as const),
  ['fenceSync', 'deleteSync'],
];
const GL_GENERATION = Symbol('glGeneration');

/**
 * After a context restore three still holds 'dispose' handlers bound to the lost context, so
 * disposing anything made before the loss (a render target resized later, for one) asks WebGL to
 * delete an object of the old context, which it reports as INVALID_OPERATION. This wraps the
 * context's create / delete calls: new objects are tagged with the context generation, and deletes
 * of objects from an earlier generation are skipped (their GPU memory died with that context).
 * Call it when the context is first lost (everything made before is stale from then on); it returns
 * the function to call at each later loss.
 */
export function guardStaleDeletes(gl: object): () => void {
  let generation = 1;
  const ctx = gl as Record<string, unknown>;
  for (const [createName, deleteName] of GL_PAIRS) {
    const create = ctx[createName];
    const del = ctx[deleteName];
    if (typeof create !== 'function' || typeof del !== 'function') continue;
    ctx[createName] = (...args: unknown[]) => {
      const o = (create as (...a: unknown[]) => unknown).apply(gl, args);
      if (o && typeof o === 'object') (o as Record<symbol, number>)[GL_GENERATION] = generation;
      return o;
    };
    ctx[deleteName] = (o: unknown) => {
      // Untagged objects predate the first loss; null and undefined pass through (no-ops).
      if (o && typeof o === 'object' && (o as Record<symbol, number | undefined>)[GL_GENERATION] !== generation) return;
      (del as (o: unknown) => void).call(gl, o);
    };
  }
  return () => {
    generation++;
  };
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
  /** Whether the context was created with MSAA: fixed for the page's life (see QUALITY). */
  readonly msaa: boolean;
  /** The dynamic point lights (siren, muzzle flash, explosion flash) as their owners drive them. */
  private pointSources: THREE.PointLight[] = [];
  /** On 'few', the lights actually drawn: the most visible sources are copied into them each frame. */
  private readonly lightPool: THREE.PointLight[] = [];
  /** Ambient vehicle views hidden beyond the tier's vehicle draw distance. */
  private readonly farHidden = new Set<VehicleView>();
  private readonly tmpV = new THREE.Vector3();
  private contextLost = false;
  /** Set up on the first context loss (see guardStaleDeletes). */
  private newGlGeneration: (() => void) | null = null;
  private ratio = 0;
  private sim: Sim | null = null;
  private unsub: Array<() => void> = [];
  private smokeTimer = 0;
  /** Rounds of the player's current automatic burst (every second one draws a tracer), and the sim time of the last. */
  private autoRounds = 0;
  private lastAutoRound = -Infinity;
  private quality: Quality = 'high';
  private warmedUp = false;
  time = 0;

  constructor(canvas: HTMLCanvasElement, private readonly world: StaticWorld, settings: RenderSettings) {
    this.hdr = (settings.gpu ?? probeGpu()).halfFloat;
    // MSAA is a context attribute that also sizes three's internal HDR scene target, so it can only
    // be chosen here, from the starting tier; setQuality() applies everything else live. The
    // half-float output stays on every tier: the output pass applies the tone mapping and sRGB
    // conversion that the custom sky and particle shaders rely on, so colours match across tiers.
    this.msaa = QUALITY[settings.quality].msaa;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.msaa,
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
    this.siren = new THREE.PointLight(0xff2020, 0, SIREN_RANGE, SIREN_DECAY);
    this.scene.add(this.siren);
    for (let i = 0; i < FEW_POINT_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 30, 1.6);
      l.visible = false;
      this.lightPool.push(l);
      this.scene.add(l);
    }
    // three registers its own handlers first (it calls preventDefault so the browser may restore).
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.setQuality(settings.quality);
    this.resize();
    // Bake the environment map first, so the warm-up compiles the env-mapped variants that are drawn.
    this.env.update(17.5, new THREE.Vector3(), this.cameraCtl.camera, 0, this.renderer);
    this.warmup();
    this.warmedUp = true;
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
    // With the HDR output three draws the scene into its half-float target with tone mapping off and
    // a linear colour space. Compiling for the canvas would build the tone-mapped sRGB variants,
    // which are never drawn, so a stand-in half-float target is bound while compiling.
    const target = this.hdr ? new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }) : null;
    try {
      if (target) this.renderer.setRenderTarget(target);
      try {
        this.renderer.compile(this.scene, this.cameraCtl.camera);
      } finally {
        if (target) this.renderer.setRenderTarget(null);
      }
    } catch {
      // Compilation is an optimisation only.
    }
    target?.dispose();
    for (const v of tmp) this.pool.release(v);
  }

  /** Applies a tier from the QUALITY table live (MSAA excepted, see the constructor). */
  setQuality(q: Quality): void {
    this.quality = q;
    const t = QUALITY[q];
    this.renderer.shadowMap.enabled = t.shadows;
    this.env.setShadows(t.shadows);
    // The sky's cloud octaves and light tap follow the tier (compiled by the warm-up below).
    this.env.setQuality(q);
    const shadow = this.env.sun.shadow;
    if (!t.shadows || shadow.mapSize.x !== t.shadowSize) {
      // Freed on Low; rebuilt at the new size on the next shadow pass otherwise.
      shadow.map?.dispose();
      (shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
      shadow.mapSize.set(t.shadowSize, t.shadowSize);
    }
    this.setBloom(t.bloom);
    // Without a bloom halo the coloured lamps (traffic lights) must carry their hue in the lamp itself.
    this.props.setGlow(this.bloom !== null);
    // Dynamic lights: on 'few' the sources stay hidden and feed the pool (see syncLightPool).
    // The number of visible lights only changes here, so shaders are not rebuilt during play.
    this.collectPointSources();
    for (const l of this.pointSources) l.visible = t.pointLights === 'all';
    for (const l of this.lightPool) {
      l.visible = t.pointLights === 'few';
      l.intensity = 0;
    }
    this.headlight.visible = t.headlight;
    this.resize();
    // Compile the new light / shadow variants now rather than when each object first shows up.
    if (this.warmedUp) this.warmup();
  }

  private setBloom(on: boolean): void {
    if (!this.hdr) return;
    if (!on) {
      // Off on Low: free its render targets too (a fresh pass is made if it comes back).
      this.renderer.setEffects([]);
      this.bloom?.dispose();
      this.bloom = null;
      return;
    }
    if (!this.bloom) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      // Threshold sits above sun-lit albedo so only emissive lights, the sun and explosions bloom.
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.6, 0.5, 2.6);
    }
    this.renderer.setEffects([this.bloom]);
  }

  /** Every point light in the scene except the pool's own: the siren, the effects' flashes, and any added later. */
  private collectPointSources(): void {
    const pool = new Set<THREE.Object3D>(this.lightPool);
    const found: THREE.PointLight[] = [];
    this.scene.traverse((o) => {
      if (o instanceof THREE.PointLight && !pool.has(o)) found.push(o);
    });
    this.pointSources = found;
  }

  /** On 'few': copies the most visible lit sources into the pool lights, the rest go dark for the frame. */
  private syncLightPool(): void {
    if (QUALITY[this.quality].pointLights !== 'few') return;
    const cam = this.cameraCtl.camera.position;
    const pool = this.lightPool;
    const picked: Array<{ l: THREE.PointLight; score: number }> = [];
    for (const l of this.pointSources) {
      if (l.intensity <= 0) continue;
      const p = l.parent ? l.parent.localToWorld(this.tmpV.copy(l.position)) : this.tmpV.copy(l.position);
      const range = l.distance > 0 ? l.distance : 50;
      // Brighter and closer to the camera first: a flash 200 m away lights nothing on screen.
      const score = l.intensity / (1 + (p.distanceTo(cam) / range) ** 2);
      let i = picked.length;
      while (i > 0 && picked[i - 1]!.score < score) i--;
      if (i < pool.length) picked.splice(i, 0, { l, score });
      if (picked.length > pool.length) picked.pop();
    }
    pool.forEach((dst, i) => {
      const src = picked[i]?.l;
      if (!src) {
        dst.intensity = 0;
        return;
      }
      if (src.parent) src.parent.localToWorld(dst.position.copy(src.position));
      else dst.position.copy(src.position);
      dst.color.copy(src.color);
      dst.intensity = src.intensity;
      dst.distance = src.distance;
      dst.decay = src.decay;
    });
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  /** The pixel ratio handed to three: dprCap x renderScale of the tier on a display at or above the cap. */
  get pixelRatio(): number {
    return this.ratio;
  }

  setFov(fov: number): void {
    this.cameraCtl.baseFov = fov;
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    // Re-read on every resize: zooming or moving to another monitor changes devicePixelRatio.
    const ratio = pixelRatioFor(this.quality, window.devicePixelRatio || 1);
    if (ratio !== this.ratio) {
      this.ratio = ratio;
      this.renderer.setPixelRatio(ratio);
    }
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
    this.farHidden.clear();
    this.effects.reset();
    // A new session's clock starts again from 0.
    this.autoRounds = 0;
    this.lastAutoRound = -Infinity;
    this.sim = sim;
    const fx = this.effects;
    const ev = sim.events;
    this.unsub.push(
      // One flash per trigger pull (a shotgun blast is one flash, not nine).
      ev.on('weaponFired', (e) => {
        fx.muzzleFlash(e.x, e.y, e.z, FLASH_SIZE[e.weapon], e);
        if (e.weapon === 'rocket') fx.rocketLaunched(e.x, e.y, e.z);
      }),
      // Every bullet or pellet: its tracer and its impact.
      ev.on('shot', (e) => {
        // Helicopter rounds have no weaponFired of their own.
        if (!e.shooter) fx.muzzleFlash(e.fx, e.fy, e.fz, FLASH_SIZE[e.weapon]);
        if (e.weapon === 'rocket' || e.weapon === 'fists') return;
        // The player's automatic fire traces every second round of a burst (its first one always).
        // Everyone else's traces every round.
        let traced = true;
        if (e.shooter?.isPlayer && WEAPONS[e.weapon].auto) {
          if (sim.time - this.lastAutoRound > 0.25) this.autoRounds = 0;
          this.lastAutoRound = sim.time;
          traced = this.autoRounds++ % 2 === 0;
        }
        if (traced) fx.tracer(e.fx, e.fy, e.fz, e.tx, e.ty, e.tz);
        // Flesh hits bleed through 'blood', except helicopter rounds, which come without one.
        if (e.hit === 'world' || e.hit === 'vehicle' || (e.hit === 'flesh' && !e.shooter)) fx.impact(e.tx, e.ty, e.tz, e.nx, e.ny, e.nz, e.hit);
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
    // Crash feedback: sparks where a vehicle grinds along something, glass and body parts flying off hard hits.
    const ground = (x: number, z: number): number => sim.world.groundHeight(x, z);
    this.unsub.push(
      ev.on('scrape', (e) => fx.scrapeSparks(e.vehicle, e.x, e.y, e.z, e.speed)),
      ev.on('impact', (e) => {
        const v = e.vehicle;
        // God mode keeps the player's car whole, so nothing comes off it; a burnt-out wreck has no glass left.
        if (v && sim.cheats.godMode && v.driver === sim.player) return;
        if (e.strength > 15 && !v?.destroyed) fx.glassShards(e.x, e.y, e.z);
        if (e.strength > 20 && v) fx.shedParts(v, e.x, e.y, e.z, e.strength, ground);
      }),
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
      // Without a bloom halo the light bars, like the traffic lights, must carry their hue in the lamp itself.
      view.sync(v, dt, this.time, night, this.bloom !== null);
      this.cullFar(view, v);
    }
    for (const [id, view] of this.vehicleViews) {
      if (!seen.has(id)) {
        this.farHidden.delete(view);
        this.scene.remove(view.group);
        this.pool.release(view);
        this.vehicleViews.delete(id);
        this.effects.skids.break(`${id}:l`);
        this.effects.skids.break(`${id}:r`);
      }
    }
  }

  /**
   * Skips ambient cars beyond the tier's vehicle draw distance (on Low, 150 m: a few pixels tall, and
   * about 15 draw calls each). Mission and police vehicles are always drawn, and so are wrecks and
   * burning or smoking cars, whose fire and smoke would otherwise hang in the air. The title flyover
   * draws every car: it circles 260 m out and 95 m up, where all of them are far yet clearly seen,
   * and the title sim has only a few dozen.
   */
  private cullFar(view: VehicleView, v: Vehicle): void {
    const far = this.cameraCtl.mode === 'title' ? Infinity : QUALITY[this.quality].vehicleDistance;
    const cam = this.cameraCtl.camera.position;
    const plain = (v.owner === 'traffic' || v.owner === 'parked') && !v.destroyed && !v.burning && v.condition >= SMOKE_CONDITION;
    const hide = plain && (v.pos.x - cam.x) ** 2 + (v.pos.z - cam.z) ** 2 > far * far;
    if (hide === this.farHidden.has(view)) return;
    view.group.visible = !hide;
    if (hide) this.farHidden.add(view);
    else this.farHidden.delete(view);
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
      // Not drawn on this tier (see cullFar): no skid marks or tyre smoke under an invisible car.
      const view = this.vehicleViews.get(v.id);
      if (view && this.farHidden.has(view)) continue;
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
      // Each smashed head lamp takes its half of the beam with it.
      const lamps = this.vehicleViews.get(v.id)?.headLamps ?? 2;
      this.headlight.intensity = 260 * night * (lamps / 2);
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
      this.siren.intensity = SIREN_DAY + SIREN_NIGHT * night;
    } else {
      this.siren.intensity = 0;
    }
  }

  /** Mirrors the sim (if any) and renders one frame. */
  render(dt: number, aiming: boolean): void {
    if (this.contextLost) return;
    this.time += dt;
    const sim = this.sim;
    const cam = this.cameraCtl.camera;
    if (sim) this.cameraCtl.update(dt, sim, aiming);
    const hours = sim ? sim.clock.hours : 17.5;
    const focus = sim && this.cameraCtl.mode === 'play' ? new THREE.Vector3(cam.position.x * 0.5 + sim.playerPos().x * 0.5, 0, cam.position.z * 0.5 + sim.playerPos().z * 0.5) : new THREE.Vector3(cam.position.x * 0.3, 0, cam.position.z * 0.3);
    this.env.update(hours, focus, cam, this.time, this.renderer);
    const night = this.env.night;
    this.city.update(night, hours, this.time);
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
    this.syncLightPool();
    this.renderer.info.reset();
    this.renderer.render(this.scene, cam);
  }

  stats(): { calls: number; triangles: number; programs: number; particles: number; vehicles: number } {
    const info = this.renderer.info;
    return { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? 0, particles: this.effects.particleCount, vehicles: this.vehicleViews.size };
  }

  /** True between 'webglcontextlost' and 'webglcontextrestored'; nothing can be drawn meanwhile. */
  get isContextLost(): boolean {
    return this.contextLost;
  }

  private readonly onContextLost = (): void => {
    this.contextLost = true;
    const gl = typeof this.renderer.getContext === 'function' ? this.renderer.getContext() : null;
    if (gl) {
      if (this.newGlGeneration) this.newGlGeneration();
      else this.newGlGeneration = guardStaleDeletes(gl);
    }
  };

  /**
   * three has already rebuilt its GL state (its handler runs first): it re-uploads buffers and
   * textures and rebuilds render targets on first use. What only ever lived on the GPU is gone,
   * though: the environment map is re-baked on the next frame (shadow and bloom targets are redrawn
   * every frame anyway), and every shader is compiled again before play resumes.
   */
  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.env.contextRestored();
    this.warmup();
  };

  dispose(): void {
    for (const u of this.unsub) u();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.bloom?.dispose();
    this.env.dispose();
    this.renderer.dispose();
  }
}
