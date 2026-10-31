// Las Lomas County's static geometry (world/country): its ground and beaches, the causeway's verges, the roads with
// their markings and the links' mouths, and the Southgate Bridge's arch. The county is drawn in 256 m cells, each hidden
// on every tier once the camera is COUNTRY_FOG_MARGIN past the fog's far end from it, where it has long faded into the
// sky; the city's own buildings never come here, so CityView keeps its skyline. The content passes (the landscape, the
// farms, the places) add their meshes through add() too.

import * as THREE from 'three';
import type { StaticWorld } from '../../world/staticWorld';
import type { CityView } from '../city';
import { COUNTRY_CELL, COUNTRY_FOG_MARGIN } from '../quality';
import { spatialGeometry, StaticVisibility } from '../spatial';
import { buildBridge } from './bridge';
import { buildCountryGround } from './ground';
import { PlacesKit } from './kit';
import { buildCountryRoads } from './roads';
import { buildTown } from './town';

export class CountryView {
  readonly group = new THREE.Group();
  private readonly visibility = new StaticVisibility();
  /** What the places animate each frame (Moo-Moo's neon cow). */
  private readonly animated: Array<(night: number, time: number) => void> = [];

  constructor(
    readonly world: StaticWorld,
    /** The city's view: the county shares its ground surfaces and wet patch, so it builds no program of its own. */
    readonly city: CityView,
  ) {
    this.group.name = 'country';
    buildCountryGround(this);
    buildCountryRoads(this);
    buildBridge(this);
    const kit = new PlacesKit();
    this.animated.push(buildTown(this, kit));
    kit.finish(this);
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

  /** Each frame, with the city's (CityView.update): the places' neon. */
  update(night: number, time: number): void {
    for (const f of this.animated) f(night, time);
  }

  /** Each frame: hides the cells farther from the camera than the fog's far end and the margin. */
  cull(x: number, z: number, fogFar: number): void {
    this.visibility.update(x, z, fogFar + COUNTRY_FOG_MARGIN);
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
