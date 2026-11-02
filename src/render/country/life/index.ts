// Life in Las Lomas County's countryside, presentation only: no sim state, no colliders, no draw from the sim's random
// streams. The crows (flocks.ts, crows.ts), the dairy's dog (dog.ts), the crop-duster biplane, the combine harvester in
// the wheat and the dawn balloon (flight.ts) are driven from the renderer's frame with the sim's clock, the cars and the
// player's position; what they sound like goes on a sheet for the audio (audio/lifeSounds.ts).
// Each is a draw or two, hidden past the fog's reach (where the fog has hidden it already), and the whole is skipped, drawn
// and sounded, while the camera is far from the county. The placeholder poles and wires (wires.ts) stand in for the roadside branch's.

import * as THREE from 'three';
import { lifeSounds, shoot } from '../../../audio/lifeSounds';
import { lerp } from '../../../core/math';
import type { V3 } from '../../../core/math';
import { Rng } from '../../../core/rng';
import { registerDebug } from '../../../debug';
import type { Character } from '../../../sim/entities';
import type { ViewState } from '../../../sim/viewState';
import type { StaticWorld } from '../../../world/staticWorld';
import type { Effects } from '../../effects';
import { FX_BUDGETS, type FxTier } from '../../fx/budget';
import type { CountryView } from '../index';
import { Dog, dogRun, type Visitor } from './dog';
import { CrowsView } from './crows';
import { balloonAt, biplaneAt, burnerAt, combineAt, combinePath, dustPaths, newPose, type Balloon, type Combine, type FlightPath } from './flight';
import { Flock, crowSites } from './flocks';
import { BALLOON_BURNER_Y, BALLOON_MOUTH_Y, DOG_PART, HEADER_W, NOZZLES, REEL, basketGeometry, biplaneGeometry, combineGeometry, dogGeometry, envelopeGeometry, flameGeometry, poleGeometry } from './models';
import { rigMaterial, type Rig } from './rig';
import { PLACEHOLDER_POLES, SPANS, wirePoint } from './wires';

/** Everything is drawn out to the fog's reach but the placeholder poles, which are drawn from this far from the line's middle. */
const POLES_RANGE = 280;
/** Its spray and dust are let off only this near. */
const SPRAY_RANGE = 420;
const DUST_RANGE = 300;
/** Cars slower than this (m/s) do not startle a crow; a person on foot slower than this does not either. */
const MOVING = 1.5;
const WALKING = 0.5;
/** Fewer birds on the lower tiers: the share of each flock's perches. */
const CROW_SHARE = { high: 1, medium: 0.65, low: 0.4, software: 0.4 } as const;
/** The farmland, with the margin outside it where something on the roads might startle a flock or the dog. */
const NEAR = { minX: -1420, maxX: -640, minZ: -480, maxZ: 340 };

const SPRAY_COLOR = [0xe6efdc, 0xf6f9f1] as const;
const DUST_COLOR = [0xb89a62, 0xd2c19a] as const;

export class CountryLife {
  /** What the audio hears of it: the sheet this writes each frame (audio/lifeSounds.ts). */
  readonly sounds = lifeSounds;
  private readonly world: StaticWorld;
  private readonly group = new THREE.Group();
  private readonly flocks: Flock[];
  private readonly crows: CrowsView;
  private readonly shown: boolean[];
  private readonly dog: Dog;
  private readonly dogRig: Rig;
  private readonly dogMesh: THREE.Mesh;
  private readonly paths: FlightPath[];
  private readonly planeRig: Rig;
  private readonly planeMesh: THREE.Mesh;
  private readonly combinePath: FlightPath;
  private readonly combineRig: Rig;
  private readonly combineMesh: THREE.Mesh;
  private readonly polesAt: { x: number; z: number };
  private readonly poles: THREE.Mesh;
  private readonly wires: THREE.LineSegments;
  private readonly balloon: THREE.Group;
  private readonly envelope: THREE.Mesh;
  private readonly envelopeMat: THREE.MeshStandardMaterial;
  private readonly flame: THREE.Mesh;
  private readonly rng = new Rng(9917);
  private readonly cars: Visitor[] = [];
  private readonly plane = newPose();
  private readonly combine: Combine = { x: 0, z: 0, heading: 0, working: false };
  private readonly drift: Balloon = { x: 0, y: 0, z: 0, yaw: 0, fill: 0, height: 0 };
  private readonly side = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly nose = new THREE.Vector3();
  private reel = 0;
  private spin = 0;
  private plume = 1;
  private sprayDebt = 0;
  private dustDebt = 0;
  /** What was drawn in the last frame, for the debug hook and the tests. */
  readonly drawn = { crows: 0, dog: false, plane: false, combine: false, balloon: false, flame: false };

  constructor(view: CountryView) {
    const world = view.world;
    this.world = world;
    this.group.name = 'country-life';
    view.moving.add(this.group);
    // The crows.
    this.flocks = crowSites(world).map((s, i) => new Flock(i, s.perches, s.ceiling));
    this.shown = this.flocks.map(() => false);
    this.crows = new CrowsView(this.flocks.reduce((n, f) => n + f.perches.length, 0));
    this.group.add(this.crows.mesh);
    // The dog.
    const run = dogRun(world);
    this.dog = new Dog(run, world.groundHeight(run.x, run.home));
    this.dogRig = rigMaterial('dog', { roughness: 0.85 });
    this.dogMesh = new THREE.Mesh(dogGeometry(), this.dogRig.material);
    this.dogMesh.name = 'farm-dog';
    this.dogMesh.castShadow = true;
    this.dogMesh.visible = false;
    this.group.add(this.dogMesh);
    // The biplane.
    this.paths = dustPaths(world);
    this.planeRig = rigMaterial('biplane', { roughness: 0.55, metalness: 0.1 });
    this.planeMesh = new THREE.Mesh(biplaneGeometry(), this.planeRig.material);
    this.planeMesh.name = 'crop-duster';
    this.planeMesh.castShadow = true;
    this.planeMesh.visible = false;
    this.planeMesh.matrixAutoUpdate = false;
    this.group.add(this.planeMesh);
    // The combine.
    const wheat = world.layout.country.farms.fields.find((f) => f.crop === 'wheat')!.rect;
    this.combinePath = combinePath(wheat);
    this.combineRig = rigMaterial('combine', { roughness: 0.6 });
    this.combineMesh = new THREE.Mesh(combineGeometry(), this.combineRig.material);
    this.combineMesh.name = 'combine';
    this.combineMesh.castShadow = true;
    this.combineMesh.visible = false;
    this.group.add(this.combineMesh);
    // The balloon.
    this.balloon = new THREE.Group();
    this.balloon.name = 'balloon';
    const basket = new THREE.Mesh(basketGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    basket.castShadow = true;
    this.envelopeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide, emissive: new THREE.Color(1, 0.45, 0.15), emissiveIntensity: 0 });
    this.envelope = new THREE.Mesh(envelopeGeometry(), this.envelopeMat);
    this.envelope.castShadow = true;
    this.envelope.position.y = BALLOON_MOUTH_Y;
    this.flame = new THREE.Mesh(flameGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.flame.position.y = BALLOON_BURNER_Y;
    this.flame.visible = false;
    this.flame.frustumCulled = false;
    this.balloon.add(basket, this.envelope, this.flame);
    this.balloon.visible = false;
    this.group.add(this.balloon);
    // The placeholder poles and wires.
    this.poles = new THREE.Mesh(poleGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    this.poles.name = 'placeholder-poles';
    this.poles.castShadow = true;
    this.polesAt = { x: PLACEHOLDER_POLES[0]!.x, z: (PLACEHOLDER_POLES[0]!.z + PLACEHOLDER_POLES[PLACEHOLDER_POLES.length - 1]!.z) / 2 };
    this.wires = wireLines();
    this.group.add(this.poles, this.wires);
    this.setTier('high');
    registerDebug('life', {
      stats: () => ({ ...this.drawn, flocks: this.flocks.map((f) => ({ state: f.state, count: f.count, x: f.cx, z: f.cz })), dog: { state: this.dog.state, ...this.dog.pose } }),
      plane: () => ({ ...this.plane }),
      combine: () => ({ ...this.combine }),
      balloon: () => ({ ...this.drift }),
      flock: (i: number) => this.flocks[i]!,
    });
  }

  /** The tier's birds (CROW_SHARE) and puffs (the effects' plume rate). */
  setTier(tier: keyof typeof CROW_SHARE): void {
    for (const f of this.flocks) f.setCount(Math.ceil(f.perches.length * CROW_SHARE[tier]));
    this.plume = FX_BUDGETS[tier as FxTier].plumeRate;
  }

  /** Hides all of it, silent. */
  private hideAll(): void {
    this.group.visible = false;
    this.sounds.plane.level = 0;
    this.sounds.combine.level = 0;
    this.sounds.burner.level = 0;
    Object.assign(this.drawn, { crows: 0, dog: false, plane: false, combine: false, balloon: false, flame: false });
  }

  /**
   * Each frame, `dt` s on, with the camera at `cam` and the fog's reach `reach` (m) past which nothing is drawn: the cars of
   * `sim` and the `player` startle the crows and the dog, the day's `hours` and the sim's clock set the rest of it going;
   * `fx` takes the biplane's spray and the combine's dust.
   */
  update(dt: number, cam: V3, reach: number, sim: ViewState | null, player: Character | null, hours: number, time: number, wind: { readonly x: number; readonly z: number }, fx: Effects): void {
    const dx = Math.max(NEAR.minX - cam.x, 0, cam.x - NEAR.maxX);
    const dz = Math.max(NEAR.minZ - cam.z, 0, cam.z - NEAR.maxZ);
    // Far from the farmland (the city) there is nothing to draw, to move or to hear.
    if (Math.hypot(dx, dz) > reach) {
      this.hideAll();
      return;
    }
    this.group.visible = true;
    const t = sim ? sim.time : time;
    const fair = sim ? sim.weather.state.rain < 0.1 : true;
    const step = Math.min(dt, 0.1);
    this.gather(sim, player);
    const d = this.drawn;
    // The crows: every flock near enough.
    this.flocks.forEach((f, k) => {
      const near = Math.hypot(f.cx - cam.x, f.cz - cam.z) < reach;
      this.shown[k] = near;
      if (near) f.update(step, t, this.cars, (x, y, z) => shoot(this.sounds, 'caw', x, y, z));
    });
    d.crows = this.crows.update(this.flocks, this.shown);
    this.updateDog(step, t, cam, reach);
    this.updatePlane(step, t, hours, fair, cam, reach, wind, fx);
    this.updateCombine(step, hours, cam, reach, wind, fx);
    this.updateBalloon(t, hours, fair, cam, reach);
    // The placeholder poles, from as far as the line reaches.
    const poles = Math.hypot(this.polesAt.x - cam.x, this.polesAt.z - cam.z) < Math.min(reach, POLES_RANGE);
    this.poles.visible = poles;
    this.wires.visible = poles;
  }

  /** The cars under way and the walking player near the farmland, as the crows and the dog see them. */
  private gather(sim: ViewState | null, player: Character | null): void {
    let n = 0;
    const add = (x: number, z: number, vz: number) => {
      const c = (this.cars[n] ??= { x: 0, z: 0, vz: 0 });
      c.x = x;
      c.z = z;
      c.vz = vz;
      n++;
    };
    if (sim) {
      for (const v of sim.vehicles) {
        if (v.removed || v.destroyed || v.speed < MOVING || v.pos.x < NEAR.minX || v.pos.x > NEAR.maxX || v.pos.z < NEAR.minZ || v.pos.z > NEAR.maxZ) continue;
        add(v.pos.x, v.pos.z, v.vel.z);
      }
    }
    if (player && !player.vehicle && player.speed > WALKING) add(player.pos.x, player.pos.z, player.vel.z);
    this.cars.length = n;
  }

  private updateDog(dt: number, time: number, cam: V3, reach: number): void {
    const p = this.dog.pose;
    const shown = Math.hypot(p.x - cam.x, p.z - cam.z) < reach;
    this.dogMesh.visible = shown;
    this.drawn.dog = shown;
    if (!shown) return;
    this.dog.update(dt, this.cars, (x, y, z) => shoot(this.sounds, 'bark', x, y, z));
    const awake = this.dog.state === 'chase' || this.dog.state === 'alert';
    const m = this.dogMesh;
    m.position.set(p.x, p.y - 0.22 * p.lie + Math.abs(Math.sin(p.gait)) * 0.05 * p.swing, p.z);
    m.rotation.y = p.yaw;
    const pose = this.dogRig.pose.value;
    // Head: up when it is on watch, a bark throws it up and back; down on its paws when it lies.
    pose[DOG_PART.head]!.set(lerp(-p.head - p.bark * 0.35, 0.5, p.lie), 0, 0);
    // The tail wags while it is on watch, hangs while it trots, lies out when it lies.
    pose[DOG_PART.tail]!.set(awake ? -0.3 : 0.25, awake ? Math.sin(time * 11) * 0.55 : Math.sin(time * 1.5) * 0.1 * (1 - p.lie), 0);
    const swing = (phase: number) => Math.sin(p.gait + phase) * 0.95 * p.swing;
    pose[DOG_PART.legFL]!.set(swing(0) * (1 - p.lie) - 1.45 * p.lie, 0, 0);
    pose[DOG_PART.legBR]!.set(swing(0) * (1 - p.lie) + 1.2 * p.lie, 0, 0);
    pose[DOG_PART.legFR]!.set(swing(Math.PI) * (1 - p.lie) - 1.45 * p.lie, 0, 0);
    pose[DOG_PART.legBL]!.set(swing(Math.PI) * (1 - p.lie) + 1.2 * p.lie, 0, 0);
  }

  private updatePlane(dt: number, t: number, hours: number, fair: boolean, cam: V3, reach: number, wind: { readonly x: number; readonly z: number }, fx: Effects): void {
    const out = biplaneAt(this.paths, t, hours, fair, this.plane);
    const p = this.plane;
    const near = out && Math.hypot(p.x - cam.x, p.z - cam.z) < reach;
    this.planeMesh.visible = near;
    this.drawn.plane = near;
    const s = this.sounds.plane;
    s.level = near ? 1 : 0;
    if (!near) return;
    s.x = p.x;
    s.y = p.y;
    s.z = p.z;
    s.vx = p.vx;
    s.vy = p.vy;
    s.vz = p.vz;
    // Its nose, its up and its left (up x nose) as the mesh's z, y and x.
    this.nose.set(p.fx, p.fy, p.fz);
    this.up.set(p.ux, p.uy, p.uz);
    this.side.crossVectors(this.up, this.nose);
    this.planeMesh.matrix.makeBasis(this.side, this.up, this.nose).setPosition(p.x, p.y, p.z);
    this.planeMesh.matrixWorldNeedsUpdate = true;
    this.spin = (this.spin + dt * 24) % (Math.PI * 2);
    this.planeRig.pose.value[1]!.set(0, 0, this.spin);
    if (p.spray && dt > 0 && Math.hypot(p.x - cam.x, p.z - cam.z) < SPRAY_RANGE) this.spraying(dt, wind, fx);
  }

  /** The spray from the boom's two ends: pale mist let off behind the nozzles, drifting down and with the wind. */
  private spraying(dt: number, wind: { readonly x: number; readonly z: number }, fx: Effects): void {
    const p = this.plane;
    this.sprayDebt += 90 * this.plume * dt;
    for (; this.sprayDebt >= 1; this.sprayDebt -= 1) {
      const n = NOZZLES[this.rng.int(0, NOZZLES.length - 1)]!;
      // The nozzle in the world: x along the plane's left, y along its up, z along its nose.
      const ox = this.side.x * n[0] + this.up.x * n[1] + this.nose.x * n[2];
      const oy = this.side.y * n[0] + this.up.y * n[1] + this.nose.y * n[2];
      const oz = this.side.z * n[0] + this.up.z * n[1] + this.nose.z * n[2];
      const lag = this.rng.range(0, dt);
      fx.puff(p.x + ox - p.vx * lag, p.y + oy - p.vy * lag, p.z + oz - p.vz * lag, p.vx * 0.04 + wind.x * 0.3 + this.rng.range(-0.4, 0.4), this.rng.range(-1.4, -0.6), p.vz * 0.04 + wind.z * 0.3 + this.rng.range(-0.4, 0.4), this.rng.range(2.6, 4), 1.2, this.rng.range(4.5, 6.5), SPRAY_COLOR[0], SPRAY_COLOR[1], 0.42, 0.3, 0.7);
    }
  }

  private updateCombine(dt: number, hours: number, cam: V3, reach: number, wind: { readonly x: number; readonly z: number }, fx: Effects): void {
    const c = this.combine;
    combineAt(this.combinePath, hours, c);
    const shown = Math.hypot(c.x - cam.x, c.z - cam.z) < reach;
    this.combineMesh.visible = shown;
    this.drawn.combine = shown;
    const s = this.sounds.combine;
    s.level = shown && c.working ? 1 : 0;
    if (!shown) return;
    this.combineMesh.position.set(c.x, this.world.groundHeight(c.x, c.z), c.z);
    this.combineMesh.rotation.y = c.heading;
    if (c.working) this.reel += dt * 3.4;
    this.combineRig.pose.value[1]!.set(this.reel, 0, 0);
    s.x = c.x;
    s.y = this.combineMesh.position.y + 2.5;
    s.z = c.z;
    if (c.working && dt > 0 && Math.hypot(c.x - cam.x, c.z - cam.z) < DUST_RANGE) this.dusting(dt, wind, fx);
  }

  /** The combine's dust: a tan cloud from behind its straw walkers, and a thinner one rising off the header's lip. */
  private dusting(dt: number, wind: { readonly x: number; readonly z: number }, fx: Effects): void {
    const c = this.combine;
    const hx = Math.sin(c.heading);
    const hz = Math.cos(c.heading);
    const y = this.combineMesh.position.y;
    this.dustDebt += 26 * this.plume * dt;
    for (; this.dustDebt >= 1; this.dustDebt -= 1) {
      const front = this.rng.chance(0.3);
      const along = front ? REEL.pivot[2] + 0.4 : -5.4;
      const across = this.rng.range(-1, 1) * (front ? HEADER_W / 2 - 0.5 : 1.2);
      const back = front ? 0 : 1.4;
      fx.puff(c.x + hx * along + hz * across, y + (front ? 0.8 : 2.4), c.z + hz * along - hx * across, -hx * back + wind.x * 0.5 + this.rng.range(-0.5, 0.5), this.rng.range(0.5, 1.4), -hz * back + wind.z * 0.5 + this.rng.range(-0.5, 0.5), this.rng.range(3, 4.5), front ? 1.2 : 1.8, this.rng.range(5, 8), DUST_COLOR[0], DUST_COLOR[1], front ? 0.3 : 0.4, -0.05, 0.5);
    }
  }

  private updateBalloon(t: number, hours: number, fair: boolean, cam: V3, reach: number): void {
    const b = this.drift;
    const out = balloonAt(this.world, hours, fair, b);
    const shown = out && Math.hypot(b.x - cam.x, b.z - cam.z) < reach;
    this.balloon.visible = shown;
    this.drawn.balloon = shown;
    const burner = shown ? burnerAt(t, hours, b.fill) : 0;
    this.drawn.flame = burner > 0.02;
    this.flame.visible = burner > 0.02;
    const s = this.sounds.burner;
    s.level = burner;
    if (!shown) return;
    this.balloon.position.set(b.x, b.y, b.z);
    this.balloon.rotation.set(0, b.yaw, Math.sin(t * 0.35) * 0.025 * b.fill);
    // The envelope lies along the ground, swelling and lifting upright on the mouth as it fills.
    const lie = 1 - b.fill;
    this.envelope.position.y = lerp(3.5, BALLOON_MOUTH_Y, b.fill);
    this.envelope.rotation.x = lie * lie * (Math.PI / 2);
    this.envelope.scale.set(0.45 + 0.55 * b.fill, 0.4 + 0.6 * b.fill, 0.45 + 0.55 * b.fill);
    this.envelopeMat.emissiveIntensity = 0.5 * burner;
    if (burner > 0.02) {
      const flick = 1 + 0.18 * Math.sin(t * 41) + 0.1 * Math.sin(t * 67);
      this.flame.scale.set(0.5 + 0.5 * burner, (0.25 + 0.75 * burner) * flick, 0.5 + 0.5 * burner);
    }
    s.x = b.x;
    s.y = b.y + BALLOON_BURNER_Y;
    s.z = b.z;
  }
}

/** The placeholder wires, each hanging in eight straight pieces. */
function wireLines(): THREE.LineSegments {
  const pts: number[] = [];
  for (const w of SPANS.flat()) {
    for (let k = 0; k < 8; k++) pts.push(...wirePoint(w, k / 8), ...wirePoint(w, (k + 1) / 8));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1a1a1c }));
  lines.name = 'placeholder-wires';
  lines.frustumCulled = false;
  return lines;
}
