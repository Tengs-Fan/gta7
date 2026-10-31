// What Las Lomas County's places (town.ts, driveIn.ts, track.ts) draw with: one atlas of painted boards, signs and
// surfaces for all of them, and one material over it, so each place is a single draw culled with the county. Each
// place's plain pieces are vertex coloured and sample the atlas's white band; its painted ones are mapped onto a band.
// Like the city's attractions (render/city/attractions.ts), the atlas's glow twin lights what is lit after dark.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Atlas } from '../city/attractions';
import { GeoBuilder, type RGB } from '../geo';
import { toTexture } from '../textures/misc';
import type { CountryView } from './index';

/** The places' atlas: 1024 by ATLAS_H px. */
const ATLAS_H = 4096;

export interface PlacePieces {
  /** Vertex-coloured geometry (its uvs are set to the atlas's white band). */
  plain: GeoBuilder;
  /** Geometry mapped onto atlas bands (white vertex colour unless tinted). */
  painted: GeoBuilder;
}

export class PlacesKit {
  readonly atlas = new Atlas(ATLAS_H);
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

  /** Adds every place as a mesh of its own (shadow-casting, culled as a whole), all with one material. */
  finish(view: CountryView): void {
    const mat = new THREE.MeshStandardMaterial({
      map: toTexture(this.atlas.canvas, true, false),
      emissiveMap: toTexture(this.atlas.glowCanvas, true, false),
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
