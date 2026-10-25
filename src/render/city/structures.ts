// Garages, ramps, helipads.

import * as THREE from 'three';
import type { Building } from '../../world/layout';
import { GeoBuilder, hexToRgb, scaleRgb } from '../geo';
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
    const poi = layout.pois.find((p) => p.id === g.poi)!;
    const text = poi.kind === 'spray' ? 'SPRAY SHACK' : "LOU'S AUTO";
    const color = poi.kind === 'spray' ? '#5cff9d' : '#ff9a5c';
    const fake: Building = { id: -1, rect: g.rect, height: g.height + 3.2, tiers: [], style: 'office', roof: 'flat', tint: 0, district: 'docks', roofProps: [], sign: null, special: null, ground: 'none', groundH: 0, groundSides: [] };
    addSign(view, fake, text, color, g.side);
  }
  view.add(garageGeo.build(), new THREE.MeshStandardMaterial({ map: groundTexture('metal'), vertexColors: true, roughness: 0.7, metalness: 0.2 }), { shadow: true, name: 'garages' });

  // Stunt ramps: sloped plate plus side panels with hazard colours.
  const plate = new GeoBuilder(false);
  const sides = new GeoBuilder(true);
  for (const r of layout.ramps) {
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
  const plateMat = new THREE.MeshStandardMaterial({ map: groundTexture('metal', 5), roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide });
  view.add(plate.build(), plateMat, { shadow: true, name: 'ramps' });
  // The side panels share the street decor's program (with three's own fog: PLAIN_FOG), as they shared the plain
  // decor program before the decor took the building fog, so no program of their own compiles in the frame a ramp first
  // comes into view under the night lights.
  const sideMat = withBuildingFog(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), DECOR_PROGRAM, PLAIN_FOG);
  view.add(sides.build(), sideMat, { shadow: true, name: 'ramp-sides' });

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
