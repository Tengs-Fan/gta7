// Las Lomas County's static geometry (world/country): its ground and beaches, the causeway's verges, the roads with
// their markings and reflector posts and the links' mouths, and the Southgate Bridge's arch. The county is drawn in 256 m
// cells, each hidden on every tier once the camera is COUNTRY_FOG_MARGIN past the fog's far end from it, where it has long
// faded into the sky; the city's own buildings never come here, so CityView keeps its skyline. The ground's cells are
// drawn finer near the camera and coarser beyond COUNTRY_NEAR, and those under Coyote Ridge and the foothills keep their
// outline in the haze past the cull (ground.ts). The content passes (the landscape, the farms, the places) add their
// meshes through add() too; the farms' crops near the camera and the windpump's wheel, and the places' neon and the
// drive-in's screen, move in update().

import * as THREE from 'three';
import type { ViewState } from '../../sim/viewState';
import type { Rect } from '../../world/layout';
import type { StaticWorld } from '../../world/staticWorld';
import type { CityView } from '../city';
import { skyPath } from '../environment';
import type { WindUniforms } from '../props';
import { COUNTRY_CELL, COUNTRY_FOG_MARGIN, COUNTRY_NEAR, CROP_RING, type QualityTier } from '../quality';
import { spatialGeometry, StaticVisibility } from '../spatial';
import { buildBridge } from './bridge';
import { buildDriveIn } from './driveIn';
import { FarmsView } from './farms';
import { FieldsView } from './fields';
import { buildCountryGround } from './ground';
import { buildHills } from './hills';
import { PlacesKit } from './kit';
import { RanchView } from './ranch';
import { Reflectors } from './reflectors';
import { buildCountryRoads } from './roads';
import { buildTown } from './town';
import { buildTrack } from './track';
import { ValleyView } from './valley';

export class CountryView {
  readonly group = new THREE.Group();
  /** What moves or follows the camera (the crops round it, the windpump's wheel): no cells. */
  readonly moving = new THREE.Group();
  /** The reflector posts along the roads, whose glows the renderer asks for each frame. */
  readonly reflectors: Reflectors;
  private readonly visibility = new StaticVisibility();
  /** The ground's cells, each drawn by its near or its far meshes (addCell). */
  private readonly cells: Array<{ bounds: Rect; near: THREE.Mesh[]; far: THREE.Mesh[]; silhouette: boolean }> = [];
  readonly farms: FarmsView;
  readonly fields: FieldsView;
  /** Sunset Vineyard, the Lazy Q Ranch and the ruin on the Willow Knoll (valley.ts). */
  readonly valley: ValleyView;
  /** The ranch's horses and sheep (ranch.ts). */
  readonly ranch: RanchView;
  private readonly sun = new THREE.Vector3();
  private readonly moon = new THREE.Vector3();
  /** What the places animate each frame: Moo-Moo's neon cow, the drive-in's screen. */
  private readonly animated: Array<(night: number, time: number, sim: ViewState | null) => void> = [];
  /** The drive-in's cars flash their lights at a horn (driveInShush). */
  readonly shush: (time: number) => void;

  constructor(
    readonly world: StaticWorld,
    /** The city's view: the county shares its ground surfaces and wet patch, so it builds no program of its own. */
    readonly city: CityView,
    /** The props' wind (PropsView): the county's corn sways on it, as Hollister Farm's does. */
    wind: WindUniforms,
    /** A software renderer's: no plants round the camera, so the tall crops' blocks are drawn from inside too. */
    readonly software = false,
  ) {
    this.group.name = 'country';
    this.moving.name = 'country-moving';
    this.group.add(this.moving);
    buildCountryGround(this);
    buildCountryRoads(this);
    buildBridge(this);
    buildHills(this);
    this.reflectors = new Reflectors(this);
    this.farms = new FarmsView(this);
    this.fields = new FieldsView(this, wind);
    this.valley = new ValleyView(this, wind);
    this.ranch = new RanchView(this);
    const kit = new PlacesKit();
    this.animated.push(buildTown(this, kit));
    const driveIn = buildDriveIn(this, kit);
    this.animated.push(driveIn.update);
    this.shush = driveIn.shush;
    buildTrack(this, kit);
    kit.finish(this);
  }

  /** The tier's crops near the camera (quality.ts CROP_RING). */
  setTier(tier: QualityTier | 'software'): void {
    this.fields.setTier(CROP_RING[tier]);
  }

  /**
   * Each frame, with the camera at (x, y, z): the crops round it, the sunflowers to the sun (`hours`), the windpump's
   * wheel, and the places' neon and the drive-in's screen (`night`, and the sim's clock and cars).
   */
  update(x: number, y: number, z: number, night: number, time: number, hours: number, wind: { readonly x: number; readonly z: number }, sim: ViewState | null): void {
    skyPath(hours, this.sun, this.moon);
    this.fields.update(x, y, z, this.sun.x, this.sun.z);
    this.farms.update(time, Math.hypot(wind.x, wind.z));
    this.valley.update(night);
    this.ranch.update(time, x, z, sim);
    for (const f of this.animated) f(night, time, sim);
  }

  /** A static layer of the county, cut into COUNTRY_CELL cells (unless `split` is false: a few pieces across it). */
  add(geo: THREE.BufferGeometry, mat: THREE.Material, opts: { shadow?: boolean; receive?: boolean; name?: string; split?: boolean } = {}): void {
    const parts = spatialGeometry(geo, opts.split === false ? Infinity : COUNTRY_CELL);
    for (const part of parts) {
      const m = new THREE.Mesh(part, mat);
      m.castShadow = opts.shadow ?? false;
      m.receiveShadow = opts.receive ?? true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      if (opts.name) m.name = opts.name;
      this.group.add(m);
      this.visibility.add(m);
    }
    if (parts[0] !== geo) geo.dispose();
  }

  /**
   * A cell of the ground, drawn by its near meshes while the camera is within COUNTRY_NEAR of it and by its far ones
   * beyond; past the fog's cull the far ones stay only for a `silhouette` (a rise's) on the hardware tiers.
   */
  addCell(bounds: Rect, near: THREE.Mesh[], far: THREE.Mesh[], silhouette: boolean): void {
    for (const m of [...near, ...far]) {
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
    }
    this.cells.push({ bounds, near, far, silhouette });
  }

  /** Each frame: hides the cells farther from the camera than the fog's far end and the margin, and picks each ground cell's meshes. */
  cull(x: number, z: number, fogFar: number): void {
    const reach = fogFar + COUNTRY_FOG_MARGIN;
    this.visibility.update(x, z, reach);
    this.farms.cull(x, z, reach);
    this.valley.cull(x, z, reach);
    const outline = this.city.buildingU.skyline.value > 0.5;
    for (const c of this.cells) {
      const b = c.bounds;
      const d = Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));
      const near = d < COUNTRY_NEAR;
      for (const m of c.near) m.visible = near && d <= reach;
      for (const m of c.far) m.visible = !near && (d <= reach || (c.silhouette && outline));
    }
  }

  dispose(): void {
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      geos.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
    });
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
  }
}
