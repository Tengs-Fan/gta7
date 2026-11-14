// Garages, ramps, helipads.

import * as THREE from 'three';
import { attractionOf } from '../../world/attractions';
import type { Building, Garage } from '../../world/layout';
import { GeoBuilder, hexToRgb, scaleRgb, type RGB } from '../geo';
import { groundTexture, helipadTexture } from '../textures';
import { addSign } from './buildings';
import { DECOR_PROGRAM, PLAIN_FOG, withBuildingFog } from './facadeShader';
import type { CityView } from './index';

export function buildStructures(view: CityView): void {
  const layout = view.world.layout;
  const garageGeo = new GeoBuilder(true);
  for (const g of layout.garages) {
    const col = hexToRgb(g.color);
    for (const w of g.walls) garageGeo.box(w.minX, 0, w.minZ, w.maxX, g.height, w.maxZ, { uv: { kind: 'world', scale: 3 }, color: col });
    garageGeo.box(g.rect.minX - 0.3, g.height, g.rect.minZ - 0.3, g.rect.maxX + 0.3, g.height + 0.4, g.rect.maxZ + 0.3, { uv: { kind: 'world', scale: 3 }, color: scaleRgb(col, 0.7), bottom: true });
    // Hollister Farm's barn has no marker: its sign is painted on (attractions.ts).
    const poi = layout.pois.find((p) => p.id === g.poi);
    if (!poi) continue;
    garageDress(garageGeo, g, col);
    const text = poi.kind === 'spray' ? 'SPRAY SHACK' : "LOU'S AUTO";
    const color = poi.kind === 'spray' ? '#5cff9d' : '#ff9a5c';
    const fake: Building = { id: -1, rect: g.rect, height: g.height + 3.2, tiers: [], style: 'office', roof: 'flat', tint: 0, district: 'docks', roofProps: [], sign: null, special: null, ground: 'none', groundH: 0, groundSides: [] };
    addSign(view, fake, text, color, g.side);
  }
  view.add(garageGeo.build(), new THREE.MeshStandardMaterial({ map: groundTexture('metal'), vertexColors: true, roughness: 0.7, metalness: 0.2 }), { shadow: true, name: 'garages' });

  // Stunt ramps: sloped plate plus side panels with hazard colours.
  const plate = new GeoBuilder(false);
  const sides = new GeoBuilder(true);
  // The farm's kicker wears hay bales instead (attractions.ts).
  const hay = attractionOf(layout, 'farm').anchors.ramp;
  for (const r of layout.ramps) {
    // Gravel Gulch's whoops and tabletops are dirt (render/country/track.ts).
    if (r.id === hay || !r.stunt) continue;
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    const sx = Math.cos(r.heading);
    const sz = -Math.sin(r.heading);
    const hw = r.width / 2;
    const hl = r.length / 2;
    const base = view.world.baseGround(r.x, r.z);
    const P = (along: number, side: number, h: number): [number, number, number] => [r.x + fx * along + sx * side, base + h, r.z + fz * along + sz * side];
    const a = P(-hl, -hw, 0.02);
    const bq = P(-hl, hw, 0.02);
    const c = P(hl, hw, r.height);
    const d = P(hl, -hw, r.height);
    plate.quad(...a, ...bq, ...c, ...d, [0, 0, 1, 0, 1, 3, 0, 3]);
    // Back face and side triangles.
    const e = P(hl, hw, 0);
    const f = P(hl, -hw, 0);
    sides.quad(...d, ...c, ...e, ...f, [0, 0, 1, 0, 1, 1, 0, 1], [0.9, 0.75, 0.1]);
    sides.tri(...bq, ...e, ...c, [0, 0, 1, 0, 1, 1], [0.95, 0.8, 0.1]);
    sides.tri(...a, ...d, ...f, [0, 0, 1, 1, 1, 0], [0.95, 0.8, 0.1]);
  }
  const plateMat = view.wet.patch(new THREE.MeshStandardMaterial({ map: groundTexture('metal', 5), roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide }));
  view.add(plate.build(), plateMat, { shadow: true, name: 'ramps', split: false });
  // The side panels share the street decor's program (with three's own fog: PLAIN_FOG), as they shared the plain
  // decor program before the decor took the building fog, so no program of their own compiles in the frame a ramp first
  // comes into view under the night lights.
  const sideMat = withBuildingFog(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), DECOR_PROGRAM, PLAIN_FOG);
  view.add(sides.build(), sideMat, { shadow: true, name: 'ramp-sides', split: false });

  // Helipads on rooftops.
  const pads = layout.buildings.flatMap((b) => b.roofProps.filter((p) => p.kind === 'helipad'));
  if (pads.length > 0) {
    const g = new GeoBuilder(false);
    for (const p of pads) {
      const h = p.w / 2;
      g.quad(p.x - h, p.y + 0.06, p.z + h, p.x + h, p.y + 0.06, p.z + h, p.x + h, p.y + 0.06, p.z - h, p.x - h, p.y + 0.06, p.z - h, [0, 0, 1, 0, 1, 1, 0, 1]);
    }
    view.add(g.build(), new THREE.MeshStandardMaterial({ map: helipadTexture(), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { name: 'helipads' });
  }
}

/** Height (m) of a city garage's door opening: the header over it stops there, clear of every vehicle that drives in. */
const GARAGE_DOOR_H = 4.3;

/**
 * A city garage's dressing (Lou's, the Spray Shacks), render only, outside the drive-in opening: steel columns at its
 * corners, a header over the door with the door rolled up under it on its drum and guide rails down both jambs, hazard
 * stripes on the jambs' faces, a darker base course, a band of clerestory windows high on the side and back walls, and a
 * coping and a vent on the roof. Before, a garage was three plain walls under a slab, its front a 5.5 m hole.
 */
function garageDress(geo: GeoBuilder, g: Garage, col: RGB): void {
  const W = { kind: 'world' as const, scale: 3 };
  const r = g.rect;
  const h = g.height;
  const steel = scaleRgb(col, 0.45);
  // Wall-local frame of the door side: s along the opening from one jamb to the other, o out of the garage.
  const front = { N: r.minZ, S: r.maxZ, E: r.maxX, W: r.minX }[g.side];
  const ns = g.side === 'N' || g.side === 'S';
  const out = g.side === 'S' || g.side === 'E' ? 1 : -1;
  const a0 = ns ? r.minX : r.minZ;
  const a1 = ns ? r.maxX : r.maxZ;
  /** An axis-aligned box from (s0, o0) to (s1, o1) in the door side's frame (o measured out from the front plane). */
  const fbox = (s0: number, s1: number, o0: number, o1: number, y0: number, y1: number, c: RGB, bottom = false) => {
    const [p0, p1] = [front + out * o0, front + out * o1];
    if (ns) geo.box(s0, y0, Math.min(p0, p1), s1, y1, Math.max(p0, p1), { uv: W, color: c, bottom });
    else geo.box(Math.min(p0, p1), y0, s0, Math.max(p0, p1), y1, s1, { uv: W, color: c, bottom });
  };
  const jamb = 0.5;
  // The header over the opening, the rolled door's drum under it, and the guide rails.
  fbox(a0 + jamb, a1 - jamb, -0.5, 0, GARAGE_DOOR_H, h, col, true);
  fbox(a0 + jamb, a1 - jamb, -0.95, -0.5, GARAGE_DOOR_H - 0.05, GARAGE_DOOR_H + 0.5, [0.55, 0.56, 0.58], true);
  for (const s of [a0 + jamb, a1 - jamb - 0.12]) fbox(s, s + 0.12, -0.6, -0.48, 0, GARAGE_DOOR_H, steel);
  // Hazard stripes up the jambs' front faces to 1.6 m, proud of the base course.
  for (const s of [a0, a1 - jamb]) {
    for (let k = 0; k < 8; k++) fbox(s + 0.02, s + jamb - 0.02, 0, 0.07, k * 0.2, k * 0.2 + 0.2, k % 2 === 0 ? [0.85, 0.68, 0.08] : [0.06, 0.06, 0.06]);
  }
  // Steel columns standing proud at the four corners, and a base course round the three walls.
  for (const [x, z] of [[r.minX, r.minZ], [r.maxX, r.minZ], [r.maxX, r.maxZ], [r.minX, r.maxZ]] as const) geo.box(x - 0.18, 0, z - 0.18, x + 0.18, h, z + 0.18, { uv: W, color: steel });
  for (const w of g.walls) geo.box(w.minX - 0.05, 0, w.minZ - 0.05, w.maxX + 0.05, 0.9, w.maxZ + 0.05, { uv: W, color: scaleRgb(col, 0.6), top: false });
  // Clerestory windows: dark glass panes 1 cm proud of the walls' outer faces, between 3.9 and 4.7 m.
  const pane: RGB = [0.05, 0.07, 0.09];
  for (const w of g.walls) {
    const along = w.maxX - w.minX > w.maxZ - w.minZ;
    const len = along ? w.maxX - w.minX : w.maxZ - w.minZ;
    const n = Math.floor((len - 1) / 1.6);
    if (n < 1) continue;
    // The outer face: the wall's face away from the garage's middle.
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    for (let k = 0; k < n; k++) {
      const c0 = (along ? w.minX : w.minZ) + (len - n * 1.6) / 2 + k * 1.6 + 0.15;
      const c1 = c0 + 1.3;
      if (along) {
        const z = (w.minZ + w.maxZ) / 2 < cz ? w.minZ - 0.01 : w.maxZ + 0.01;
        const zz = z < cz ? z - 0.01 : z + 0.01;
        geo.box(c0, 3.9, Math.min(z, zz), c1, 4.7, Math.max(z, zz), { uv: W, color: pane, top: false });
      } else {
        const x = (w.minX + w.maxX) / 2 < cx ? w.minX - 0.01 : w.maxX + 0.01;
        const xx = x < cx ? x - 0.01 : x + 0.01;
        geo.box(Math.min(x, xx), 3.9, c0, Math.max(x, xx), 4.7, c1, { uv: W, color: pane, top: false });
      }
    }
  }
  // A coping round the roof slab's edge and a vent on it.
  const y = h + 0.4;
  geo.box(r.minX - 0.3, y, r.minZ - 0.3, r.maxX + 0.3, y + 0.35, r.minZ - 0.05, { uv: W, color: steel });
  geo.box(r.minX - 0.3, y, r.maxZ + 0.05, r.maxX + 0.3, y + 0.35, r.maxZ + 0.3, { uv: W, color: steel });
  geo.box(r.minX - 0.3, y, r.minZ - 0.05, r.minX - 0.05, y + 0.35, r.maxZ + 0.05, { uv: W, color: steel });
  geo.box(r.maxX + 0.05, y, r.minZ - 0.05, r.maxX + 0.3, y + 0.35, r.maxZ + 0.05, { uv: W, color: steel });
  const vx = (r.minX + r.maxX) / 2 + (r.maxX - r.minX) * 0.2;
  const vz = (r.minZ + r.maxZ) / 2 - (r.maxZ - r.minZ) * 0.15;
  geo.box(vx - 0.7, y, vz - 0.5, vx + 0.7, y + 0.9, vz + 0.5, { uv: W, color: [0.6, 0.61, 0.62] });
}
