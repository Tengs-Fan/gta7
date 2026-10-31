// Las Lomas County's static geometry (world/country): its ground and beaches, the causeway's verges, the roads with
// their markings and the links' mouths, and the Southgate Bridge's arch. The county is drawn in 256 m cells, each hidden
// on every tier once the camera is COUNTRY_FOG_MARGIN past the fog's far end from it, where it has long faded into the
// sky; the city's own buildings never come here, so CityView keeps its skyline. The content passes (the landscape, the
// farms, the places) add their meshes through add() too; the farms' crops near the camera and the windpump's wheel move
// in update().

import * as THREE from 'three';
import type { StaticWorld } from '../../world/staticWorld';
import type { CityView } from '../city';
import { skyPath } from '../environment';
import type { WindUniforms } from '../props';
import { COUNTRY_CELL, COUNTRY_FOG_MARGIN, CROP_RING, type QualityTier } from '../quality';
import { spatialGeometry, StaticVisibility } from '../spatial';
import { buildBridge } from './bridge';
import { FarmsView } from './farms';
import { FieldsView } from './fields';
import { buildCountryGround } from './ground';
import { buildCountryRoads } from './roads';

export class CountryView {
  readonly group = new THREE.Group();
  /** What moves or follows the camera (the crops round it, the windpump's wheel): no cells. */
  readonly moving = new THREE.Group();
  private readonly visibility = new StaticVisibility();
  readonly farms: FarmsView;
  readonly fields: FieldsView;
  private readonly sun = new THREE.Vector3();
  private readonly moon = new THREE.Vector3();

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
    this.farms = new FarmsView(this);
    this.fields = new FieldsView(this, wind);
  }

  /** The tier's crops near the camera (quality.ts CROP_RING). */
  setTier(tier: QualityTier | 'software'): void {
    this.fields.setTier(CROP_RING[tier]);
  }

  /** Each frame, with the camera at (x, y, z): the crops round it, the sunflowers to the sun (`hours`), the windpump's wheel. */
  update(x: number, y: number, z: number, time: number, hours: number, wind: { readonly x: number; readonly z: number }): void {
    skyPath(hours, this.sun, this.moon);
    this.fields.update(x, y, z, this.sun.x, this.sun.z);
    this.farms.update(time, Math.hypot(wind.x, wind.z));
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

  /** Each frame: hides the cells farther from the camera than the fog's far end and the margin. */
  cull(x: number, z: number, fogFar: number): void {
    this.visibility.update(x, z, fogFar + COUNTRY_FOG_MARGIN);
    this.farms.cull(x, z, fogFar + COUNTRY_FOG_MARGIN);
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
