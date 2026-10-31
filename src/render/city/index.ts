// Static city geometry: terrain, roads, markings, sidewalks, buildings, roofs,
// coast, piers, ramps, garages, signs and the hill sign. Spatial batches retain material sharing and culling.

import * as THREE from 'three';
import { BOARDWALK_W } from '../../world/constants';
import type { StaticWorld } from '../../world/staticWorld';
import { CulledStaticMesh, spatialGeometry, StaticVisibility } from '../spatial';
import { WetGround } from '../wetGround';
import { groundSurface, type GroundTex } from '../textures';
import { buildBuildings, buildingTextures, occupancy, shopOccupancy } from './buildings';
import type { BuildingUniforms } from './facadeShader';
import type { ShopFrontage } from './storefronts';
import type { QualityTier } from '../quality';
import { buildGround } from './ground';
import { buildRoads } from './roads';
import { buildCoast } from './coast';
import { buildStructures } from './structures';
import { HillSign } from './hillSign';
import { buildAttractionViews } from './attractions';
import type { CityMaterials, Entrance, NightUniforms } from './shared';
import { GroundSurfaces, registerGroundDebug, type AnisoTier } from './surfaces';

export { frontageSplit, occupancy, shopOccupancy } from './buildings';
export type { FrontageSplit } from './buildings';
export type { CityMaterials, Entrance } from './shared';

export class CityView {
  readonly group = new THREE.Group();
  readonly materials: CityMaterials = { facades: new Map(), signs: [], storefront: null, decor: null };
  /** The drawn main door of every building with one, by building id (a special's stands in front of its POI marker). */
  readonly entrances = new Map<number, Entrance>();
  /** The design of every shop frontage, by frontKey(building, side, quad). */
  readonly storefronts = new Map<string, ShopFrontage>();
  readonly nightU: NightUniforms = { occupancy: { value: 0 }, shopOccupancy: { value: 0 }, time: { value: 0 } };
  /** Tier switches of the building shading (uniforms: no program changes). */
  readonly buildingU: BuildingUniforms = { parallax: { value: 1 }, skyline: { value: 1 } };
  readonly visibility = new StaticVisibility();
  /** The wet-ground patch on the paved surfaces (roads, markings, pavements, plazas, car parks, boardwalk, piers). */
  readonly wet = new WetGround();
  /** The ground's PBR materials, detail patches and anisotropy (roads, sidewalks, lawns, sand). */
  readonly ground: GroundSurfaces;
  /** The SAN AZURA letters and the viewpoints' dressing. */
  readonly hillSign: HillSign;
  private readonly softwareMeshes: CulledStaticMesh[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly projection = new THREE.Matrix4();

  constructor(readonly world: StaticWorld, private readonly chunkSize = Infinity, private readonly software = false) {
    this.group.name = 'city';
    this.ground = new GroundSurfaces(software);
    if (software) this.buildingU.skyline.value = 0;
    buildBuildings(this);
    buildGround(this);
    buildRoads(this);
    buildCoast(this);
    buildStructures(this);
    this.hillSign = new HillSign(this);
    buildAttractionViews(this);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o instanceof CulledStaticMesh)) this.visibility.add(o);
    });
    registerGroundDebug(this);
  }

  /** Anisotropic filtering of the ground textures for a tier (the software tier gets none). */
  setAnisotropy(tier: AnisoTier, maxAnisotropy: number): number {
    return this.ground.setAnisotropy(tier, maxAnisotropy);
  }

  cull(camera: THREE.Camera, distance: number): void {
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.visibility.update(camera.position.x, camera.position.z, distance);
    for (const mesh of this.softwareMeshes) mesh.prepare(this.frustum, camera.position.x, camera.position.z, distance);
  }

  /** `split: false` keeps a shadow caster in one mesh: for a few pieces across the city, cells would only add draws. */
  add(geo: THREE.BufferGeometry, mat: THREE.Material, opts: { shadow?: boolean; receive?: boolean; name?: string; split?: boolean } = {}): void {
    if (this.software) {
      const mesh = new CulledStaticMesh(geo, mat, this.chunkSize);
      mesh.name = opts.name ?? '';
      this.group.add(mesh);
      this.softwareMeshes.push(mesh);
      return;
    }
    // Layers that cast no shadow are thin ground surfaces: a few triangles a cell, so culling them saves nothing but draws.
    const parts = spatialGeometry(geo, opts.shadow && opts.split !== false ? this.chunkSize : Infinity);
    for (const part of parts) {
      const m = new THREE.Mesh(part, mat);
      m.castShadow = opts.shadow ?? false;
      m.receiveShadow = opts.receive ?? true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      if (opts.name) m.name = opts.name;
      this.group.add(m);
    }
    if (parts[0] !== geo) geo.dispose();
  }

  /** Albedo, grain/joints and roughness share one UV scale on each ground surface. */
  surface(kind: GroundTex, roughness = 1, seed = 1): THREE.MeshStandardMaterial {
    const surface = groundSurface(kind, seed);
    return new THREE.MeshStandardMaterial({
      map: surface.map,
      roughnessMap: surface.rough,
      normalMap: surface.normal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness,
      metalness: kind === 'metal' ? 0.35 : 0,
    });
  }

  /**
   * Per-tier building detail: texture anisotropy (High min(8, the GPU's maximum), Medium 4, Low 2, software 1) and
   * the recessed windows and interiors (High and Medium; Low and software draw them flat). Only uniforms and texture
   * parameters change, so no geometry is rebuilt and no program is compiled.
   */
  setQuality(tier: QualityTier, maxAnisotropy: number, software = this.software): void {
    const aniso = software ? 1 : Math.max(1, Math.min(tier === 'high' ? 8 : tier === 'medium' ? 4 : 2, maxAnisotropy));
    for (const t of buildingTextures(this)) {
      if (t.anisotropy === aniso) continue;
      t.anisotropy = aniso;
      t.needsUpdate = true;
    }
    this.buildingU.parallax.value = !software && tier !== 'low' ? 1 : 0;
    this.buildingU.skyline.value = software ? 0 : 1;
  }

  /** Night factor 0..1, the time of day in hours (lit windows and shops) and the render time in seconds (TV flicker). */
  update(night: number, hours: number, time: number): void {
    this.nightU.occupancy.value = occupancy(hours);
    this.nightU.shopOccupancy.value = shopOccupancy(hours);
    // Wrapped daily: float precision stays fine for the flicker, and it jumps once a day at most.
    this.nightU.time.value = time % 86400;
    this.ground.update(time);
    for (const m of this.materials.facades.values()) m.emissiveIntensity = night * 1.4;
    if (this.materials.storefront) this.materials.storefront.emissiveIntensity = night * 2.8;
    for (const m of this.materials.signs) m.emissiveIntensity = 0.35 + night * 3.2;
    this.hillSign.update(night);
  }
}

export { BOARDWALK_W };
