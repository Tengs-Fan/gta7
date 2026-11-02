// What Las Lomas County's places (town.ts, driveIn.ts, track.ts) draw with: one atlas of painted boards, signs and
// surfaces for all of them, and one material over it, so each place is a single draw culled with the county. Each
// place's plain pieces are vertex coloured and sample the atlas's white band; its painted ones are mapped onto a band.
// Like the city's attractions (render/city/attractions.ts), the atlas's glow twin lights what is lit after dark.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Atlas } from '../city/attractions';
import { NO_RECT, setGroundAttribute } from '../city/surfaces';
import { GeoBuilder, type RGB } from '../geo';
import type { CountryView } from './index';

/** The height of the places' dirt over the flush ground. */
export const DIRT_Y = 0.035;

export interface PlacePieces {
  /** Vertex-coloured geometry (its uvs are set to the atlas's white band). */
  plain: GeoBuilder;
  /** Geometry mapped onto atlas bands (white vertex colour unless tinted). */
  painted: GeoBuilder;
}

export class PlacesKit {
  /** The places' atlas, 1024 px wide and as tall as its bands need: the places' boards took 4,696 px, which ran off the 4,096 it once was. */
  readonly atlas = Atlas.growing();
  /** Packed dirt on the flush ground (lots, drives, the dirt track), all the places' in one draw of the city's dirt. */
  readonly dirt = new GeoBuilder(false);
  private readonly blank: [number, number];
  private readonly places: Array<PlacePieces & { name: string }> = [];

  constructor() {
    this.blank = this.atlas.band(8, (ctx) => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 1024, 8);
    });
  }

  /** A place's builders, added as one mesh by finish(). */
  place(name: string): PlacePieces {
    const p = { name, plain: new GeoBuilder(true), painted: new GeoBuilder(true) };
    this.places.push(p);
    return p;
  }

  /** A board of w x h m centred at (x, y, z), facing (sin rot, cos rot), painted with band `v` (u from u0 to u1). */
  board(p: PlacePieces, v: [number, number], w: number, h: number, x: number, y: number, z: number, rot: number, u0 = 0, u1 = 1, tint: RGB = [1, 1, 1]): void {
    const ax = Math.cos(rot) * (w / 2);
    const az = -Math.sin(rot) * (w / 2);
    p.painted.quad(x - ax, y - h / 2, z - az, x + ax, y - h / 2, z + az, x + ax, y + h / 2, z + az, x - ax, y + h / 2, z - az, [u0, v[0], u1, v[0], u1, v[1], u0, v[1]], tint);
  }

  /** Adds every place as a mesh of its own (shadow-casting, culled as a whole), all with one material, and the dirt. */
  finish(view: CountryView): void {
    const surfaces = view.city.ground;
    const dirtMat = surfaces.patch(view.city.wet.patch(surfaces.material('plain', 'dirt')), 'plain');
    dirtMat.polygonOffset = true;
    dirtMat.polygonOffsetFactor = -1;
    dirtMat.polygonOffsetUnits = -1;
    view.add(setGroundAttribute(this.dirt.build(), [], NO_RECT), dirtMat, { split: false, name: 'places-dirt' });
    const mat = new THREE.MeshStandardMaterial({
      map: this.atlas.texture(),
      emissiveMap: this.atlas.texture(true),
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.4,
      vertexColors: true,
      roughness: 0.8,
    });
    // Lit up after dark with the city's signs (CityView.update).
    view.city.materials.signs.push(mat);
    for (const p of this.places) {
      const plain = p.plain.build();
      const uv = plain.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, (this.blank[0] + this.blank[1]) / 2);
      const geo = mergeGeometries([plain, p.painted.build()], false)!;
      plain.dispose();
      view.add(geo, mat, { shadow: true, split: false, name: p.name });
    }
  }
}
