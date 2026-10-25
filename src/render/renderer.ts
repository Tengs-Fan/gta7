// Owns the three.js renderer and scene; mirrors the simulation every frame.

import { ActivityFxView } from './activityFx';
import { SiteView } from './siteView';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { playerOf, type PlayerView, type ViewState } from '../sim/viewState';
import type { Vehicle } from '../sim/entities';
import { VEHICLE_SPECS, WEAPONS, type VehicleKind } from '../sim/specs';
import { WATER_Y } from '../world/constants';
import type { StaticWorld } from '../world/staticWorld';
import { CameraController } from './camera';
import { ContactShadows } from './contactShadows';
import { LightSprites, BLOOM_THRESHOLD, STREAK_RANGE, type LampGlow } from './lightSprites';
import { LocalReflections } from './localReflections';
import { StreetLighting } from './streetLighting';
import { CityView } from './city';
import { CrowdView } from './crowd';
import { Effects, flashSize, TYRE_SPRAY_SPEED, WADE_MIN } from './effects';
import { ThrowView } from './throwView';
import { Environment } from './environment';
import { FinishPass } from './finishPass';
import { gradeAt, type Grade } from './grade';
import { MarkerView } from './markers';
import { PropsView } from './props';
import { Rain, SOFTWARE_RAIN_DROPS } from './rain';
import { buildCoverMap, coverAt, type CoverMap } from './rainCover';
import { FEW_POINT_LIGHTS, gpuClass, pixelRatioFor, probeGpu, QUALITY, softwarePixelRatioFor, type GpuProbe, type QualityTier, type TierSpec } from './quality';
import { HARDWARE_CHUNK_SIZE, STATIC_CHUNK_SIZE } from './spatial';
import { SoftwareMaterials } from './softwareMaterials';
import { ClassViewPool, type AnyVehicleView } from './classViews';
import { SHADOW_LAYER, VehiclePartBatches } from './vehicleBatches';
import { freezeVehicleParts } from './vehicleView';
import { assets } from './assets';

export type Quality = QualityTier;

/** What FinishPass is doing: `aa` is the anti-aliasing actually in effect. */
export interface PostState {
  aa: 'msaa' | 'fxaa' | 'none';
  grade: boolean;
  vignette: number;
}

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
/** Full-beam intensity of the player's headlight at night (both lamps intact). */
export const HEADLIGHT_INTENSITY = 160;
const SIREN_DAY = 25;
const SIREN_NIGHT = 25;
const SIREN_RANGE = 12;
const SIREN_DECAY = 2;
/** Tyre spray needs a road at least this wet, and a car within this range (m) of the camera. */
const TYRE_SPRAY_WET = 0.3;
const TYRE_SPRAY_RANGE = 60;
/** A boat's wake is drawn within this range (m) of the camera. */
const BOAT_WAKE_RANGE = 150;
const NO_WIND = { x: 0, z: 0 } as const;
/** A street lamp's wet-road streak against its halo's colour: the lamp's own light pool already brightens the road. */
const LAMP_STREAK = 0.3;

/**
 * Brightness 0..1 of a lightning flash `t` seconds after the strike: a bright stroke, a dip, a second stroke fading
 * out. Back to nothing within half a second.
 */
export function lightningFlash(t: number): number {
  if (!(t >= 0) || t > 0.6) return 0;
  if (t < 0.07) return 1;
  if (t < 0.12) return 0.2;
  return 0.75 * Math.exp(-(t - 0.12) / 0.08);
}

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

/**
 * Cars other than the player's beyond this distance from the camera (m) are drawn as their merged far version; a band
 * of FAR_LOD_BAND either side keeps one that hovers at the distance from switching back and forth. Software GPUs keep
 * their own, nearer switch without the band.
 */
export const FAR_LOD_DISTANCE = 40;
const FAR_LOD_BAND = 2;
const SOFTWARE_FAR_DISTANCE = 32;
/** A vehicle removed within this distance (m) of the camera and in view fades out over VEHICLE_FADE_OUT s. */
export const VEHICLE_FADE_RANGE = 150;
export const VEHICLE_FADE_OUT = 0.6;

/** A blast this close to the sea's surface over water is drawn as a water plume (Effects.explosion). */
const WATER_BLAST_BAND = 0.3;

/** Where a segment from above the sea passes down through its surface over water, or null. */
export function seaCrossing(world: StaticWorld, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): { x: number; z: number } | null {
  if (!(fy > WATER_Y) || !(ty < WATER_Y)) return null;
  const k = (fy - WATER_Y) / (fy - ty);
  const x = fx + (tx - fx) * k;
  const z = fz + (tz - fz) * k;
  return world.waterDepth(x, z) > 0 ? { x, z } : null;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cameraCtl: CameraController;
  readonly env: Environment;
  readonly city: CityView;
  readonly props: PropsView;
  readonly streetLighting: StreetLighting;
  readonly crowd = new CrowdView();
  readonly effects = new Effects();
  readonly markers = new MarkerView();
  readonly lightSprites = new LightSprites();
  /** The wave-1 jobs' bins and water jet, and the signs and structures of their places. */
  readonly activityFx = new ActivityFxView();
  readonly sites: SiteView;
  /** Grenades and molotovs in flight, the throw's aiming arc and molotov fires. */
  readonly throwView = new ThrowView();
  readonly rain: Rain;
  /** Roof heights over the world (rain and dry ground under cover, no tyre spray in a garage). */
  readonly cover: CoverMap;
  /** Ground wetness 0..1 drawn this frame (the sim's weather.wet). */
  private wet = 0;
  /** How dark the weather makes the day (0 clear .. 1), from the sim each frame: vehicles light up at max(night, weatherDim). */
  weatherDim = 0;
  /** The lightning flash on sky and light (Settings: Lightning flashes). Off, a strike changes nothing drawn. */
  lightningFlashes = true;
  /** Seconds since the last strike that flashed. */
  private flashAge = Infinity;
  private readonly lampGlows: LampGlow[] = [];
  private readonly bufferSize = new THREE.Vector2();
  private readonly vehicleViews = new Map<number, AnyVehicleView>();
  /** Views by the vehicle's class (cars, bikes, boats): see classViews.ts. */
  private readonly pool = new ClassViewPool();
  /** Tyres, rims, lamps and roof gear of every detailed car, drawn instanced. */
  readonly vehicleParts = new VehiclePartBatches();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly partSphere = new THREE.Sphere();
  /** Views of vehicles removed in view, fading out (t: seconds since the fade began). */
  private readonly fadingViews: Array<{ view: AnyVehicleView; t: number }> = [];
  /** Fade copies compiled by the warm-up and kept, so their programs stay alive for the fades of the session. */
  private fadeKeepers: THREE.Material[] = [];
  private readonly headlight: THREE.SpotLight;
  private readonly siren: THREE.PointLight;
  private bloom: UnrealBloomPass | null = null;
  private contactShadows: ContactShadows | null = null;
  private finish: FinishPass | null = null;
  private readonly gradeNow: Grade = gradeAt(17.5);
  private localReflections: LocalReflections | null = null;
  private readonly reflectionPosition = new THREE.Vector3();
  private readonly hdr: boolean;
  readonly software: boolean;
  private readonly softwareMaterials: SoftwareMaterials | null;
  /** Whether the context was created with MSAA: fixed for the page's life (see QUALITY). */
  readonly msaa: boolean;
  /** The dynamic point lights (siren, muzzle flash, explosion flash) as their owners drive them. */
  private pointSources: THREE.PointLight[] = [];
  /** On 'few', the lights actually drawn: the most visible sources are copied into them each frame. */
  private readonly lightPool: THREE.PointLight[] = [];
  /** Ambient vehicle views hidden beyond the tier's vehicle draw distance. */
  private readonly farHidden = new Set<AnyVehicleView>();
  private readonly tmpV = new THREE.Vector3();
  private contextLost = false;
  /** The shadow map hookShadowMap last wrapped. */
  private hookedShadowMap: THREE.WebGLShadowMap | null = null;
  /** Set up on the first context loss (see guardStaleDeletes). */
  private newGlGeneration: (() => void) | null = null;
  private ratio = 0;
  private sim: ViewState | null = null;
  /** Id of the player slot this screen belongs to: its car, camera target and reflections. */
  private localPlayerId = 0;
  private unsub: Array<() => void> = [];
  private smokeTimer = 0;
  /** Rounds of the player's current automatic burst (every second one draws a tracer), and the sim time of the last. */
  private autoRounds = 0;
  private lastAutoRound = -Infinity;
  private quality: Quality = 'high';
  private warmedUp = false;
  time = 0;

  constructor(canvas: HTMLCanvasElement, private readonly world: StaticWorld, settings: RenderSettings) {
    const gpu = settings.gpu ?? probeGpu();
    this.software = gpuClass(gpu.renderer) === 'software';
    this.softwareMaterials = this.software ? new SoftwareMaterials() : null;
    this.hdr = gpu.halfFloat && !this.software;
    // MSAA is a context attribute that also sizes three's internal HDR scene target, so it can only
    // be chosen here, from the starting tier. Hardware tiers keep the HDR output pass. Software
    // GPUs use an LDR canvas, with the same tone mapping/sRGB conversion in each material shader.
    this.msaa = QUALITY[settings.quality].msaa && !this.software;
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
    this.hookShadowMap();
    // The HDR output pass would otherwise reset the counters; reset them per frame instead.
    this.renderer.info.autoReset = false;
    this.cameraCtl = new CameraController(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.cameraCtl.baseFov = settings.fov;

    // Without half-float targets there is no environment map (three's PMREM needs them).
    this.env = new Environment(this.scene, this.renderer, { hdr: this.hdr, software: this.software });
    this.env.setShore(world.layout.bounds);
    this.effects.foam.bindSea(this.env.sea);
    this.pool.bindSea(this.env.sea);
    this.pool.bindGround(world);
    const chunk = this.software ? STATIC_CHUNK_SIZE : HARDWARE_CHUNK_SIZE;
    this.city = new CityView(world, chunk, this.software);
    this.props = new PropsView(world, chunk);
    this.streetLighting = new StreetLighting(world);
    this.sites = new SiteView(world);
    this.scene.add(this.activityFx.group, this.sites.group);
    this.softwareMaterials?.apply(this.sites.group);
    this.softwareMaterials?.apply(this.activityFx.group);
    this.scene.add(this.streetLighting.group);
    this.scene.add(this.city.group, this.props.group, this.crowd.group, this.effects.group, this.markers.group, this.lightSprites.group, this.vehicleParts.group, this.throwView.group);
    this.softwareMaterials?.apply(this.city.group);
    this.softwareMaterials?.apply(this.props.group);
    this.softwareMaterials?.apply(this.crowd.group);
    this.softwareMaterials?.apply(this.throwView.group);
    this.cover = buildCoverMap(world);
    this.rain = new Rain(this.cover);
    this.scene.add(this.rain.mesh);
    this.city.wet.setCover(this.rain.cover, this.rain.coverRect);

    this.headlight = new THREE.SpotLight(0xfff4dc, 0, 70, 0.55, 0.55, 2);
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

  /**
   * The shadow pass tests objects against the main camera's layers: only there may it see the shadow-only casters.
   * three builds a new shadow map when the WebGL context is restored (copying only its flags), so this runs again
   * then; it wraps each shadow map once.
   */
  private hookShadowMap(): void {
    const shadowMap = this.renderer.shadowMap;
    if (shadowMap === this.hookedShadowMap) return;
    this.hookedShadowMap = shadowMap;
    const renderShadows = shadowMap.render;
    shadowMap.render = (lights, scene, camera) => {
      const had = camera.layers.isEnabled(SHADOW_LAYER);
      camera.layers.enable(SHADOW_LAYER);
      try {
        renderShadows.call(shadowMap, lights, scene, camera);
      } finally {
        if (!had) camera.layers.disable(SHADOW_LAYER);
      }
    };
  }

  /** Builds one view per vehicle kind and compiles every shader up front to avoid hitches later. */
  private warmup(): void {
    const tmp: AnyVehicleView[] = [];
    for (const kind of Object.keys(VEHICLE_SPECS) as VehicleKind[]) {
      const v = this.pool.acquire(kind);
      v.group.position.set(0, -50, 0);
      this.scene.add(v.group);
      this.softwareMaterials?.apply(v.group);
      tmp.push(v);
    }
    // The part batches' instanced variants are compiled too.
    this.vehicleParts.begin();
    for (const v of tmp) {
      v.group.updateMatrix();
      v.drawParts(this.vehicleParts);
      // And the far version's (with the software tier's own instead).
      v.setDistant(true, this.software);
      v.drawParts(this.vehicleParts);
      v.setDistant(false);
    }
    this.vehicleParts.end();
    if (this.vehicleParts.takeChanged()) this.softwareMaterials?.apply(this.vehicleParts.group);
    // And the fade copies of a car fading out (hashed alpha), with the hashed-alpha depth of its shadow.
    for (const v of tmp) {
      v.beginFade();
      v.setFade(0.5);
      this.softwareMaterials?.apply(v.group);
    }
    const depthProbe = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshDepthMaterial({ alphaHash: true }));
    depthProbe.position.set(0, -50, 0);
    this.scene.add(depthProbe);
    // Loaded asset models are in the scene only while compiling, so their programs exist before the first use.
    const assetProbe = assets.warmGroup();
    this.softwareMaterials?.apply(assetProbe);
    this.scene.add(assetProbe);
    // With the HDR output three draws the scene into its half-float target with tone mapping off and
    // a linear colour space. Compiling for the canvas would build the tone-mapped sRGB variants,
    // which are never drawn, so a stand-in half-float target is bound while compiling.
    const target = this.hdr ? new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }) : null;
    // Hidden until it rains; compiled now so the first shower costs no program build.
    const rainShown = this.rain.mesh.visible;
    this.rain.mesh.visible = true;
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
    this.rain.mesh.visible = rainShown;
    this.scene.remove(assetProbe);
    this.scene.remove(depthProbe);
    depthProbe.geometry.dispose();
    // Kept, undisposed, so the programs they compiled stay for the session's fades (a program goes with its last user).
    const kept = [depthProbe.material, ...tmp.flatMap((v) => v.endFade())];
    this.softwareMaterials?.forget(this.fadeKeepers);
    for (const m of this.fadeKeepers) m.dispose();
    this.fadeKeepers = kept;
    for (const v of tmp) this.pool.release(v);
    this.vehicleParts.begin();
    this.vehicleParts.end();
  }

  /** Applies a tier from the QUALITY table live (MSAA excepted, see the constructor). */
  setQuality(q: Quality): void {
    this.quality = q;
    const t = QUALITY[this.software ? 'low' : q];
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
    this.setPost(t);
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
    this.lightSprites.setPoolCap(t.headlightPools);
    this.rain.setCount(this.software ? SOFTWARE_RAIN_DROPS : t.rainDrops);
    this.city.wet.setMode(t.wetGround);
    this.city.setQuality(q, typeof this.renderer.capabilities?.getMaxAnisotropy === 'function' ? this.renderer.capabilities.getMaxAnisotropy() : 1, this.software);
    this.env.setWaterGrid(!this.software && t.waterGrid);
    this.streetLighting.group.visible = !this.software && q === 'high';
    if (q !== 'high') this.clearLocalReflections();
    this.resize();
    // Compile the new light / shadow variants now rather than when each object first shows up.
    if (this.warmedUp) this.warmup();
  }

  /**
   * The effects chain: High [ContactShadows, Bloom, Finish], Medium [Bloom, Finish], Low [Finish].
   * Without half-float output (software, hdr=false) three allows no effects at all.
   */
  private setPost(t: Readonly<TierSpec>): void {
    if (!this.hdr) return;
    // High adds local contact shading; all tiers retain their existing native render scale.
    if (t.bloom && this.quality === 'high') {
      this.contactShadows ??= new ContactShadows(this.scene, this.cameraCtl.camera);
    } else {
      this.contactShadows?.dispose();
      this.contactShadows = null;
    }
    if (t.bloom) {
      if (!this.bloom) {
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        // Threshold sits above sun-lit albedo so only emissive lights, the sun and explosions bloom.
        this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.6, 0.5, BLOOM_THRESHOLD);
      }
    } else {
      // Off on Low: free its render targets too (a fresh pass is made if it comes back).
      this.bloom?.dispose();
      this.bloom = null;
    }
    if (t.aa === 'fxaa' || t.grade) {
      // Kept across tier switches: they only change its uniforms, so its program is never rebuilt.
      this.finish ??= new FinishPass();
      this.finish.fxaa = t.aa === 'fxaa';
      this.finish.grade = t.grade;
      this.finish.vignetteOverride = null;
    } else {
      this.finish?.dispose();
      this.finish = null;
    }
    this.renderer.setEffects([this.contactShadows, this.bloom, this.finish].filter((p) => p !== null));
  }

  /** Debug override of FinishPass until the next setQuality. A vignette of null returns it to the time of day. */
  overridePost(o: { aa?: 'none' | 'fxaa'; grade?: boolean; vignette?: number | null }): PostState {
    const f = this.finish;
    if (f) {
      if (o.aa !== undefined) f.fxaa = o.aa === 'fxaa';
      if (o.grade !== undefined) f.grade = o.grade;
      if (o.vignette !== undefined) f.vignetteOverride = o.vignette;
      f.setGrade(this.gradeNow);
    }
    return this.post;
  }

  /** Whether this renderer can run post-processing at all (FinishPass, Low's FXAA): it needs half-float output. */
  get postProcessing(): boolean {
    return this.hdr;
  }

  get post(): PostState {
    const f = this.finish;
    return {
      aa: f?.fxaa ? 'fxaa' : this.msaa ? 'msaa' : 'none',
      grade: f?.grade ?? false,
      vignette: f ? f.vignetteOverride ?? this.gradeNow.vignette : 0,
    };
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

  /** The player's Resolution scale (0.5-1): multiplies the tier's pixel ratio (and its software pixel budget). */
  get resolutionScale(): number {
    return this.userScale;
  }

  set resolutionScale(v: number) {
    const s = Number.isFinite(v) ? Math.max(0.5, Math.min(1, v)) : 1;
    if (s === this.userScale) return;
    this.userScale = s;
    this.resize();
  }

  private userScale = 1;

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    // Re-read on every resize: zooming or moving to another monitor changes devicePixelRatio.
    const ratio =
      (this.software
        ? softwarePixelRatioFor(this.quality, w, h, window.devicePixelRatio || 1)
        : pixelRatioFor(this.quality, window.devicePixelRatio || 1, w, h)) * this.userScale;
    if (ratio !== this.ratio) {
      this.ratio = ratio;
      this.renderer.setPixelRatio(ratio);
    }
    this.renderer.setSize(w, h, false);
    const cam = this.cameraCtl.camera;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }

  attach(sim: ViewState, localPlayerId = 0): void {
    this.clearLocalReflections();
    this.localPlayerId = localPlayerId;
    this.cameraCtl.localPlayerId = localPlayerId;
    for (const u of this.unsub) u();
    this.unsub = [];
    for (const v of this.vehicleViews.values()) {
      this.scene.remove(v.group);
      this.pool.release(v);
    }
    this.vehicleViews.clear();
    this.endFades();
    this.farHidden.clear();
    this.effects.reset();
    this.activityFx.clear();
    this.crowd.reset();
    this.throwView.reset();
    this.flashAge = Infinity;
    // A new session's clock starts again from 0.
    this.autoRounds = 0;
    this.lastAutoRound = -Infinity;
    this.sim = sim;
    const fx = this.effects;
    const ev = sim.events;
    this.unsub.push(
      // One flash per trigger pull (a shotgun blast is one flash, not nine).
      ev.on('weaponFired', (e) => {
        fx.muzzleFlash(e.x, e.y, e.z, flashSize(e.weapon), e);
        if (e.weapon === 'rocket') fx.rocketLaunched(e.x, e.y, e.z);
      }),
      // Every bullet or pellet: its tracer and its impact.
      ev.on('shot', (e) => {
        // Helicopter rounds have no weaponFired of their own.
        if (!e.shooter) fx.muzzleFlash(e.fx, e.fy, e.fz, flashSize(e.weapon));
        else if (e.hit !== 'none') fx.shotLanded(e.fx, e.fy, e.fz, e.tx, e.ty, e.tz, e.nx, e.ny, e.nz);
        if (e.weapon === 'rocket' || e.weapon === 'fists') return;
        // The player's automatic fire traces every second round of a burst (its first one always).
        // Everyone else's traces every round.
        let traced = true;
        if (e.shooter && e.shooter === this.me(sim).character && WEAPONS[e.weapon].auto) {
          if (sim.time - this.lastAutoRound > 0.25) this.autoRounds = 0;
          this.lastAutoRound = sim.time;
          traced = this.autoRounds++ % 2 === 0;
        }
        // A round into the sea ends at its surface in a splash: the sim lets it run on to the seabed.
        const sea = seaCrossing(this.world, e.fx, e.fy, e.fz, e.tx, e.ty, e.tz);
        if (sea) {
          if (traced) fx.tracer(e.fx, e.fy, e.fz, sea.x, WATER_Y, sea.z);
          fx.splash(sea.x, WATER_Y, sea.z, 'small');
          return;
        }
        if (traced) fx.tracer(e.fx, e.fy, e.fz, e.tx, e.ty, e.tz);
        // Flesh hits bleed through 'blood', except helicopter rounds, which come without one.
        if (e.hit === 'world' || e.hit === 'vehicle' || (e.hit === 'flesh' && !e.shooter)) fx.impact(e.tx, e.ty, e.tz, e.nx, e.ny, e.nz, e.hit);
      }),
      ev.on('explosion', (e) => {
        fx.explosion(e.x, e.y, e.z, e.radius, Math.abs(e.y - WATER_Y) < WATER_BLAST_BAND && this.world.waterDepth(e.x, e.z) > 0);
        const c = this.cameraCtl.camera.position;
        const d = Math.hypot(c.x - e.x, c.y - e.y, c.z - e.z);
        // The only blast shake: grows with the radius and fades out by about 70 m.
        this.cameraCtl.addShake((e.radius / 7.5) * Math.max(0, 2.4 - d / 30));
      }),
      ev.on('impact', (e) => {
        if (e.strength > 7) fx.debris(e.x, e.y, e.z);
        if (e.vehicle && e.vehicle.driver === this.me(sim).character) this.cameraCtl.addKick(e.x - e.vehicle.pos.x, e.z - e.vehicle.pos.z, e.strength);
      }),
      ev.on('propBroken', (e) => {
        this.props.breakProp(e.index, e.dirX, e.dirZ);
        const p = this.world.layout.props[e.index];
        if (p?.kind === 'hydrant') fx.hydrantSpray(p.x, p.y, p.z);
        if (p?.kind === 'lamp') fx.debris(p.x, p.y + 0.6, p.z);
      }),
      ev.on('splash', (e) => fx.splash(e.x, e.y, e.z, e.big)),
      ev.on('lightning', () => {
        if (this.lightningFlashes) this.flashAge = 0;
      }),
      ev.on('blood', (e) => fx.impact(e.x, e.y, e.z, -e.dx, -e.dy, -e.dz, 'flesh')),
    );
    // Crash feedback: sparks where a vehicle grinds along something, glass and body parts flying off hard hits.
    const ground = (x: number, z: number): number => sim.world.groundHeight(x, z);
    this.unsub.push(
      ev.on('scrape', (e) => fx.scrapeSparks(e.vehicle, e.x, e.y, e.z, e.speed)),
      ev.on('impact', (e) => {
        const v = e.vehicle;
        // God mode keeps the player's car whole, so nothing comes off it; a burnt-out wreck has no glass left.
        if (v && v.driver && sim.players.some((p) => p.cheats.godMode && p.character === v.driver)) return;
        if (e.strength > 15 && !v?.destroyed) fx.glassShards(e.x, e.y, e.z);
        if (e.strength > 20 && v) fx.shedParts(v, e.x, e.y, e.z, e.strength, ground);
      }),
    );
  }

  private me(sim: ViewState): PlayerView {
    return playerOf(sim, this.localPlayerId);
  }

  private syncVehicles(sim: ViewState, dt: number, night: number): void {
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
      this.chooseDetail(view, v, sim);
      this.softwareMaterials?.apply(view.group);
      this.cullFar(view, v);
    }
    this.updateFrustum();
    for (const [id, view] of this.vehicleViews) {
      if (!seen.has(id)) {
        this.farHidden.delete(view);
        this.vehicleViews.delete(id);
        this.effects.skids.break(`${id}:l`);
        this.effects.skids.break(`${id}:r`);
        // Removed in view (a cleared wreck, a mission car): it fades out where it was instead of vanishing.
        if (view.group.visible && this.inView(view, VEHICLE_FADE_RANGE)) {
          view.beginFade();
          this.softwareMaterials?.apply(view.group);
          this.fadingViews.push({ view, t: 0 });
        } else {
          this.scene.remove(view.group);
          this.pool.release(view);
        }
      }
    }
    for (let i = this.fadingViews.length - 1; i >= 0; i--) {
      const e = this.fadingViews[i]!;
      e.t += dt;
      const f = 1 - e.t / VEHICLE_FADE_OUT;
      if (f > 0) e.view.setFade(f);
      else {
        this.endFade(e.view);
        this.fadingViews.splice(i, 1);
      }
    }
    this.drawVehicleParts();
  }

  /** Whether a view's vehicle is within `range` m of the camera and its bounds in the view (updateFrustum). */
  private inView(view: AnyVehicleView, range: number): boolean {
    const v = view.vehicle;
    if (!v) return false;
    const cam = this.cameraCtl.camera.position;
    if ((v.pos.x - cam.x) ** 2 + (v.pos.z - cam.z) ** 2 > range * range) return false;
    const s = v.spec;
    this.partSphere.center.set(v.pos.x, v.pos.y + s.height / 2, v.pos.z);
    this.partSphere.radius = Math.hypot(s.length, s.width, s.height) / 2 + 0.5;
    return this.frustum.intersectsSphere(this.partSphere);
  }

  private endFade(view: AnyVehicleView): void {
    const used = view.endFade();
    this.softwareMaterials?.forget(used);
    for (const m of used) m.dispose();
    this.scene.remove(view.group);
    this.pool.release(view);
  }

  /** Ends every fade at once (a new session). */
  private endFades(): void {
    for (const e of this.fadingViews) this.endFade(e.view);
    this.fadingViews.length = 0;
  }

  private updateFrustum(): void {
    const cam = this.cameraCtl.camera;
    cam.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.viewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  }

  /** The merged far version for every car but the player's beyond FAR_LOD_DISTANCE (software: its own distance). */
  private chooseDetail(view: AnyVehicleView, v: Vehicle, sim: ViewState): void {
    const cam = this.cameraCtl.camera.position;
    const d2 = (v.pos.x - cam.x) ** 2 + (v.pos.z - cam.z) ** 2;
    const mine = v.driver === this.me(sim).character;
    if (this.software) {
      view.setDistant(!mine && d2 > SOFTWARE_FAR_DISTANCE * SOFTWARE_FAR_DISTANCE, true);
      return;
    }
    const d = FAR_LOD_DISTANCE + (view.isDistant ? -FAR_LOD_BAND : FAR_LOD_BAND);
    view.setDistant(!mine && d2 > d * d);
  }

  /** Refills the part batches with the cars drawn this frame (fading ones included) whose bounds are in the camera's view. */
  private drawVehicleParts(): void {
    const parts = this.vehicleParts;
    parts.begin();
    for (const view of this.vehicleViews.values()) this.drawPartsInView(view);
    for (const e of this.fadingViews) this.drawPartsInView(e.view);
    parts.end();
    if (parts.takeChanged()) this.softwareMaterials?.apply(parts.group);
    const retired = parts.takeRetired();
    if (retired.length) this.softwareMaterials?.forget(retired);
  }

  private drawPartsInView(view: AnyVehicleView): void {
    const v = view.vehicle;
    if (!v || !view.group.visible) return;
    const s = v.spec;
    const sphere = this.partSphere;
    sphere.center.set(v.pos.x, v.pos.y + s.height / 2, v.pos.z);
    sphere.radius = Math.hypot(s.length, s.width, s.height) / 2 + 0.5;
    if (this.frustum.intersectsSphere(sphere)) view.drawParts(this.vehicleParts);
  }

  /**
   * Skips ambient cars beyond the tier's vehicle draw distance (on Low, 150 m: a few pixels tall, and
   * about 15 draw calls each). Mission and police vehicles are always drawn, and so are wrecks and
   * burning or smoking cars, whose fire and smoke would otherwise hang in the air. The title flyover
   * draws every car: it circles 260 m out and 95 m up, where all of them are far yet clearly seen,
   * and the title sim has only a few dozen.
   */
  private cullFar(view: AnyVehicleView, v: Vehicle): void {
    const far = this.cameraCtl.mode === 'title' ? Infinity : QUALITY[this.software ? 'low' : this.quality].vehicleDistance;
    const cam = this.cameraCtl.camera.position;
    const plain = (v.owner === 'traffic' || v.owner === 'parked') && !v.destroyed && !v.burning && v.condition >= SMOKE_CONDITION;
    const hide = plain && (v.pos.x - cam.x) ** 2 + (v.pos.z - cam.z) ** 2 > far * far;
    if (hide === this.farHidden.has(view)) return;
    view.group.visible = !hide;
    if (hide) this.farHidden.add(view);
    else this.farHidden.delete(view);
  }

  private vehicleEffects(sim: ViewState, dt: number): void {
    const fx = this.effects;
    const wake = QUALITY[this.software ? 'low' : this.quality].tyreSpray;
    const spray = this.wet > TYRE_SPRAY_WET && wake;
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
      if (v.spec.class === 'boat') {
        // Foam and spray on the tiers that draw tyre spray; a boat in its own view rides the drawn swell.
        if (wake && !v.destroyed && d2 < BOAT_WAKE_RANGE * BOAT_WAKE_RANGE && Math.abs(v.pos.y - WATER_Y) < 0.5) fx.boatWake(v, view?.group.position.y ?? WATER_Y, dt);
        continue;
      }
      // Wading (its wheels on the sand under the sea; deeper than the sim's flooding depth it is inWater): spray and a wake.
      const depth = WATER_Y - v.pos.y;
      if (depth >= WADE_MIN && !v.airborne && !v.inWater && d2 < 120 * 120) fx.wade(v, WATER_Y, depth, dt);
      else if (spray && d2 < TYRE_SPRAY_RANGE * TYRE_SPRAY_RANGE && !v.airborne && !v.inWater && v.speed > TYRE_SPRAY_SPEED && coverAt(this.cover, v.pos.x, v.pos.z) < v.pos.y + 0.3) {
        fx.tyreSpray(v, this.wet, dt);
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

  /** Lamp glows of every drawn vehicle, and headlight pools for the nearest lit ones (the player's only without a headlight spot). */
  private syncLightSprites(sim: ViewState, lights: number): void {
    const ls = this.lightSprites;
    const cam = this.cameraCtl.camera;
    this.renderer.getDrawingBufferSize(this.bufferSize);
    ls.begin(cam.position, this.bufferSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)));
    const playerCar = this.me(sim).character.vehicle;
    const spot = this.headlight.visible;
    const strength = THREE.MathUtils.smoothstep(lights, 0.35, 0.6);
    const glows = this.lampGlows;
    for (const view of this.vehicleViews.values()) {
      const v = view.vehicle;
      if (!v || v.removed || !view.group.visible) continue;
      const n = view.lampWorldPositions(glows);
      for (let i = 0; i < n; i++) ls.addGlow(glows[i]!);
      if (view.lightsOn && !(spot && v === playerCar)) {
        const lamps = view.headLamps;
        if (lamps > 0) ls.offerPool(v.pos.x + Math.sin(v.heading) * v.halfL, v.pos.z + Math.cos(v.heading) * v.halfL, v.heading, strength * (lamps / 2));
      }
    }
    if (this.wet > 0.01) this.offerLampStreaks();
    ls.finish((x, z) => sim.world.groundHeight(x, z));
  }

  /** Street lamps that are lit and standing, for wet-road streaks (LightSprites keeps the nearest). */
  private offerLampStreaks(): void {
    const lamps = this.props.lampLights;
    if (!lamps) return;
    const c = lamps.color;
    if (c.r + c.g + c.b < 0.02) return;
    const cam = this.cameraCtl.camera.position;
    const { positions: p, on } = lamps;
    for (let i = 0; i < p.length; i += 3) {
      if (on[i]! <= 0) continue;
      const dx = p[i]! - cam.x;
      const dz = p[i + 2]! - cam.z;
      if (dx * dx + dz * dz > STREAK_RANGE * STREAK_RANGE) continue;
      this.lightSprites.offerStreakLight(p[i]!, p[i + 1]!, p[i + 2]!, c.r * LAMP_STREAK, c.g * LAMP_STREAK, c.b * LAMP_STREAK);
    }
  }

  private syncLights(sim: ViewState, night: number): void {
    const v = this.me(sim).character.vehicle;
    if (v && night > 0.25 && !v.destroyed) {
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      this.headlight.position.set(v.pos.x + fx * v.halfL, v.pos.y + 0.8, v.pos.z + fz * v.halfL);
      this.headlight.target.position.set(v.pos.x + fx * (v.halfL + 25), v.pos.y - 0.5, v.pos.z + fz * (v.halfL + 25));
      this.headlight.target.updateMatrixWorld();
      // Each smashed head lamp takes its half of the beam with it.
      const lamps = this.vehicleViews.get(v.id)?.headLamps ?? 2;
      this.headlight.intensity = HEADLIGHT_INTENSITY * night * (lamps / 2);
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
    this.hookShadowMap();
    this.time += dt;
    const sim = this.sim;
    const cam = this.cameraCtl.camera;
    if (sim) this.cameraCtl.update(dt, sim, aiming);
    const hours = sim ? sim.clock.hours : 17.5;
    const focus = sim && this.cameraCtl.mode === 'play' ? new THREE.Vector3(cam.position.x * 0.5 + this.me(sim).pos().x * 0.5, 0, cam.position.z * 0.5 + this.me(sim).pos().z * 0.5) : new THREE.Vector3(cam.position.x * 0.3, 0, cam.position.z * 0.3);
    const weather = sim?.weather.state;
    this.weatherDim = weather?.dim ?? 0;
    this.flashAge += dt;
    if (!this.lightningFlashes) this.flashAge = Infinity;
    this.env.update(hours, focus, cam, this.time, this.renderer, weather, lightningFlash(this.flashAge));
    this.effects.setLight(this.env.smokeLight);
    this.wet = weather?.wet ?? 0;
    const rain = weather?.rain ?? 0;
    this.city.wet.update(this.wet, rain, this.time);
    this.lightSprites.wet = this.wet;
    this.renderer.getDrawingBufferSize(this.bufferSize);
    this.rain.update(dt, cam.position, rain, weather?.wind ?? NO_WIND, this.env.smokeLight, (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, this.bufferSize.y));
    const night = this.env.night;
    this.streetLighting.update(cam.position, night, dt);
    this.city.update(night, hours, this.time);
    // Signals run on the sim clock, the one drivers and pedestrians obey.
    this.props.update(this.time, night, sim ? sim.time : this.time);
    this.props.setOccluderView(cam.position, sim ? this.cameraCtl.occlusionSubject() : null);
    if (sim) {
      const lights = Math.max(night, this.weatherDim);
      this.syncVehicles(sim, dt, lights);
      this.lightSprites.dark = lights;
      this.syncLightSprites(sim, lights);
      this.effects.syncRockets(sim.projectiles);
      this.throwView.sync(sim, this.me(sim).character, this.cameraCtl.aimRay().dir, this.effects, dt, this.time, cam.position);
      this.vehicleEffects(sim, dt);
      this.activityFx.sync(sim, dt, this.effects, this.time);
      this.crowd.scopeHiddenId = this.cameraCtl.scoped ? this.me(sim).character.id : -1;
      this.crowd.sync(sim.characters, cam.position.x, cam.position.z, dt, this.me(sim).character.id);
      this.markers.syncMarkers(sim.missions.active || this.me(sim).wanted.level > 0 ? sim.interactions.markers.filter((m) => m.kind !== 'mission') : sim.interactions.markers, this.time, cam.position, this.me(sim).pos(), aiming);
      const objectives = [...(sim.missions.active?.markers ?? []), ...sim.activities.objectives()];
      this.markers.syncObjectives(objectives, (x, z) => sim.world.groundHeight(x, z), this.time);
      this.markers.syncPickups(sim.pickups, this.time, cam.position.x, cam.position.z);
      this.markers.syncHelis(sim.helis, night, (x, z) => sim.world.groundHeight(x, z));
      // Paused (dt 0), nothing new is emitted.
      if (dt > 0) for (const h of sim.helis) if (h.crashing && !h.removed) this.effects.heliCrash(h.pos.x, h.pos.y, h.pos.z, dt);
      this.syncLights(sim, lights);
    }
    this.effects.update(dt, this.time);
    this.syncLightPool();
    if (this.software) {
      // Culling ends at the fog horizon, where geometry has already faded into the sky.
      this.city.cull(cam, 230);
      this.props.visibility.update(cam.position.x, cam.position.z, 110);
      this.softwareMaterials?.lighting(this.env.sun, this.env.hemi, this.env.envFill, cam);
      this.softwareMaterials?.sync();
    }
    this.renderer.info.reset();
    const car = sim ? this.me(sim).character.vehicle : null;
    const view = car ? this.vehicleViews.get(car.id) : null;
    const reflect = this.hdr && this.quality === 'high' && this.cameraCtl.mode === 'play' && car && view && !car.destroyed;
    if (reflect) {
      this.localReflections ??= new LocalReflections(this.renderer, this.scene);
      this.localReflections.applyCurrent(view.group);
    } else if (this.localReflections) this.clearLocalReflections();
    if (this.finish) this.finish.setGrade(gradeAt(hours, weather, this.gradeNow));
    this.contactShadows?.track(dt);
    // The batches draw the vehicles' part meshes: no pass need walk them or update their matrices.
    freezeVehicleParts(true);
    for (const view of this.vehicleViews.values()) view.hideParts(true);
    for (const e of this.fadingViews) e.view.hideParts(true);
    try {
      this.renderer.render(this.scene, cam);
    } finally {
      for (const view of this.vehicleViews.values()) view.hideParts(false);
      for (const e of this.fadingViews) e.view.hideParts(false);
      freezeVehicleParts(false);
    }
    if (reflect && this.localReflections) {
      // Draw the main scene first: quality changes and context recovery rebuild shadow maps here.
      // Capturing with shadow updates disabled before that draw would sample an uninitialised map.
      this.reflectionPosition.set(car.pos.x, car.pos.y + car.spec.height * 0.7, car.pos.z);
      // The frame's draw has just updated every world matrix; a cube face need not walk the scene for them again.
      const matrices = this.scene.matrixWorldAutoUpdate;
      this.scene.matrixWorldAutoUpdate = false;
      try {
        // Street furniture is left out with the moving things: in a 128-pixel cube it is a few texels, but it was
        // about half the draws of every face, and a face is drawn on most frames while driving.
        this.localReflections.update(view.group, this.reflectionPosition, hours, this.time,
          [this.crowd.group, this.effects.group, this.markers.group, this.props.group, this.vehicleParts.group, ...Array.from(this.vehicleViews.values(), (v) => v.group)]);
      } finally {
        this.scene.matrixWorldAutoUpdate = matrices;
      }
    }
  }

  private clearLocalReflections(): void {
    this.localReflections?.dispose();
    this.localReflections = null;
  }

  stats(): { calls: number; triangles: number; programs: number; particles: number; vehicles: number; localReflections: boolean; glows: number; pools: number; streaks: number; rainDrops: number; wet: number; waterGrid: boolean; wakeBoats: number; wakeSprites: number } {
    const info = this.renderer.info;
    return { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? 0, particles: this.effects.particleCount, wakeBoats: this.effects.wakeBoats, wakeSprites: this.effects.wakeSprites, vehicles: this.vehicleViews.size, localReflections: this.localReflections?.ready ?? false, ...this.lightSprites.counts, rainDrops: this.rain.drops, wet: this.wet, waterGrid: this.env.waterGrid };
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
    this.hookShadowMap();
    this.clearLocalReflections();
    this.env.contextRestored();
    this.warmup();
  };

  dispose(): void {
    this.clearLocalReflections();
    for (const u of this.unsub) u();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.bloom?.dispose();
    this.contactShadows?.dispose();
    this.finish?.dispose();
    this.lightSprites.dispose();
    this.throwView.dispose();
    this.rain.dispose();
    this.city.wet.dispose();
    this.env.dispose();
    this.softwareMaterials?.dispose();
    this.vehicleParts.dispose();
    this.renderer.dispose();
  }
}
