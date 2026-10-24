// Ground: sidewalks, lots, promenade.

import * as THREE from 'three';
import { CURB_H, SIDEWALK_W } from '../../world/constants';
import type { GroundKind, Rect } from '../../world/layout';
import { GeoBuilder } from '../geo';
import type { CityView } from './index';
import { quadLine } from './shared';
import { LAWN_OVERHANG, NO_RECT, rectRange, setGroundAttribute, type GroundDetail, type GroundRange } from './surfaces';

const GROUND_TEX: Record<GroundKind, 'grass' | 'plaza' | 'asphalt' | 'dirt'> = {
  grass: 'grass',
  yard: 'grass',
  plaza: 'plaza',
  parking: 'asphalt',
  dirt: 'dirt',
};

const DETAIL: Record<'grass' | 'plaza' | 'asphalt' | 'dirt', GroundDetail> = { grass: 'grass', plaza: 'plain', asphalt: 'lot', dirt: 'plain' };

type Rect4 = [number, number, number, number];
const rect4 = (r: Rect): Rect4 => [r.minX, r.minZ, r.maxX, r.maxZ];

export function buildGround(view: CityView): void {
  const layout = view.world.layout;
  const surfaces = view.ground;
  const walk = new GeoBuilder(false);
  const walkRanges: GroundRange[] = [];
  const curbs = new GeoBuilder(false);
  const patches = new Map<string, { g: GeoBuilder; ranges: GroundRange[] }>();
  const patch = (k: string) => {
    let p = patches.get(k);
    if (!p) {
      p = { g: new GeoBuilder(false), ranges: [] };
      patches.set(k, p);
    }
    return p;
  };
  const y = CURB_H;
  const sw = SIDEWALK_W;
  const walkUv = { kind: 'world', scale: surfaces.tile('kerb') } as const;
  const curbUv = { kind: 'world', scale: surfaces.tile('curb') } as const;
  // Each sidewalk strip carries the rectangle whose sides are its kerbs (the shader darkens the paving along them).
  const strip = (minX: number, minZ: number, maxX: number, maxZ: number, kerb: Rect4) => {
    const start = walk.vertexCount;
    walk.flat(minX, minZ, maxX, maxZ, y, walkUv);
    walkRanges.push(rectRange(start, walk.vertexCount, kerb));
  };
  for (const blk of layout.blocks) {
    const r = blk.rect;
    const kerb = rect4(r);
    // Sidewalk ring (4 non-overlapping strips).
    strip(r.minX, r.minZ, r.maxX, r.minZ + sw, kerb);
    strip(r.minX, r.maxZ - sw, r.maxX, r.maxZ, kerb);
    strip(r.minX, r.minZ + sw, r.minX + sw, r.maxZ - sw, kerb);
    strip(r.maxX - sw, r.minZ + sw, r.maxX, r.maxZ - sw, kerb);
    // Curb faces.
    curbs.wall(r.minX, r.maxZ, r.maxX, r.maxZ, 0, y, curbUv);
    curbs.wall(r.maxX, r.maxZ, r.maxX, r.minZ, 0, y, curbUv);
    curbs.wall(r.maxX, r.minZ, r.minX, r.minZ, 0, y, curbUv);
    curbs.wall(r.minX, r.minZ, r.minX, r.maxZ, 0, y, curbUv);
  }
  for (const gp of layout.ground) {
    const tex = GROUND_TEX[gp.kind];
    const detail = DETAIL[tex];
    const scale = detail === 'plain' ? (tex === 'plaza' ? 6 : 8) : surfaces.tile(detail);
    const p = patch(tex);
    const start = p.g.vertexCount;
    if (tex === 'grass') {
      // A lawn meeting a sidewalk spills a frayed strip onto the paving; the shader works its edge out from the
      // sidewalk's inner rectangle.
      const blk = layout.blocks.find((bl) => gp.rect.minX >= bl.rect.minX - 0.01 && gp.rect.maxX <= bl.rect.maxX + 0.01 && gp.rect.minZ >= bl.rect.minZ - 0.01 && gp.rect.maxZ <= bl.rect.maxZ + 0.01);
      const inner: Rect4 = blk ? [blk.rect.minX + sw, blk.rect.minZ + sw, blk.rect.maxX - sw, blk.rect.maxZ - sw] : [...NO_RECT];
      const out = (a: number, edge: number) => (Math.abs(a - edge) < 0.01 ? LAWN_OVERHANG : 0);
      const minX = gp.rect.minX - out(gp.rect.minX, inner[0]);
      const minZ = gp.rect.minZ - out(gp.rect.minZ, inner[1]);
      const maxX = gp.rect.maxX + out(gp.rect.maxX, inner[2]);
      const maxZ = gp.rect.maxZ + out(gp.rect.maxZ, inner[3]);
      p.g.flat(minX, minZ, maxX, maxZ, y + 0.004, { kind: 'world', scale });
      p.ranges.push(rectRange(start, p.g.vertexCount, inner));
    } else {
      p.g.flat(gp.rect.minX, gp.rect.minZ, gp.rect.maxX, gp.rect.maxZ, y + 0.004, { kind: 'world', scale });
    }
  }
  // Parking bay lines.
  const lines = new GeoBuilder(false);
  for (const s of layout.parking) {
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const sx = Math.cos(s.heading);
    const sz = -Math.sin(s.heading);
    for (const side of [-1, 1]) {
      const cx = s.x + sx * side * 1.6;
      const cz = s.z + sz * side * 1.6;
      const ax = cx - fx * 2.5;
      const az = cz - fz * 2.5;
      const bx = cx + fx * 2.5;
      const bz = cz + fz * 2.5;
      quadLine(lines, ax, az, bx, bz, 0.12, y + 0.012);
    }
  }

  // Outer land around the city: sidewalk ring + promenade strips + boardwalk.
  const b = layout.bounds;
  const prom = patch('plaza').g;
  const wood = new GeoBuilder(false);
  const city: Rect4 = [b.cityMinX, b.cityMinZ, b.cityMaxX, b.cityMaxZ];
  strip(b.cityMinX - sw, b.cityMinZ - sw, b.cityMaxX + sw, b.cityMinZ, city);
  strip(b.cityMinX - sw, b.cityMaxZ, b.cityMaxX + sw, b.cityMaxZ + sw, city);
  strip(b.cityMinX - sw, b.cityMinZ, b.cityMinX, b.cityMaxZ, city);
  strip(b.cityMaxX, b.cityMinZ, b.cityMaxX + sw, b.cityMaxZ, city);
  curbs.wall(b.cityMinX, b.cityMinZ, b.cityMaxX, b.cityMinZ, 0, y, curbUv);
  curbs.wall(b.cityMaxX, b.cityMaxZ, b.cityMinX, b.cityMaxZ, 0, y, curbUv);
  curbs.wall(b.cityMinX, b.cityMaxZ, b.cityMinX, b.cityMinZ, 0, y, curbUv);
  curbs.wall(b.cityMaxX, b.cityMinZ, b.cityMaxX, b.cityMaxZ, 0, y, curbUv);
  prom.flat(b.landMinX, b.landMinZ, b.cityMinX - sw, b.landMaxZ, y, { kind: 'world', scale: 6 });
  prom.flat(b.cityMinX - sw, b.landMinZ, b.beachStartX, b.cityMinZ - sw, y, { kind: 'world', scale: 6 });
  prom.flat(b.cityMinX - sw, b.cityMaxZ + sw, b.beachStartX, b.landMaxZ, y, { kind: 'world', scale: 6 });
  wood.flat(b.cityMaxX + sw, b.cityMinZ - sw, b.beachStartX, b.cityMaxZ + sw, y, { kind: 'world', scale: 4 });

  const wet = view.wet;
  view.add(setGroundAttribute(walk.build(), walkRanges, NO_RECT), surfaces.patch(wet.patch(surfaces.material('kerb')), 'kerb'), { name: 'sidewalks' });
  view.add(setGroundAttribute(curbs.build(), []), surfaces.patch(wet.patch(surfaces.material('curb')), 'curb'), { name: 'curbs' });
  view.add(wood.build(), wet.patch(view.surface('wood')), { name: 'boardwalk' });
  for (const [k, p] of patches) {
    const tex = k as 'grass' | 'plaza' | 'asphalt' | 'dirt';
    const detail = DETAIL[tex];
    const m = surfaces.material(detail, tex);
    // Grass soaks the rain up rather than shining.
    if (k !== 'grass') wet.patch(m);
    surfaces.patch(m, detail);
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -1;
    view.add(setGroundAttribute(p.g.build(), p.ranges, NO_RECT), m, { name: `ground-${k}` });
  }
  const lineMat = wet.patch(new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  view.add(lines.build(), lineMat, { name: 'parking-lines' });
}
