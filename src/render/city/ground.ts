// Ground: sidewalks, lots, promenade.

import * as THREE from 'three';
import { CURB_H, SIDEWALK_W } from '../../world/constants';
import type { GroundKind } from '../../world/layout';
import { GeoBuilder } from '../geo';
import type { CityView } from './index';
import { quadLine } from './shared';

const GROUND_TEX: Record<GroundKind, 'grass' | 'plaza' | 'asphalt' | 'dirt'> = {
  grass: 'grass',
  yard: 'grass',
  plaza: 'plaza',
  parking: 'asphalt',
  dirt: 'dirt',
};

export function buildGround(view: CityView): void {
  const layout = view.world.layout;
  const walk = new GeoBuilder(false);
  const curbs = new GeoBuilder(false);
  const patches = new Map<string, GeoBuilder>();
  const patch = (k: string) => {
    let g = patches.get(k);
    if (!g) {
      g = new GeoBuilder(false);
      patches.set(k, g);
    }
    return g;
  };
  const y = CURB_H;
  const sw = SIDEWALK_W;
  for (const blk of layout.blocks) {
    const r = blk.rect;
    // Sidewalk ring (4 non-overlapping strips).
    walk.flat(r.minX, r.minZ, r.maxX, r.minZ + sw, y, { kind: 'world', scale: 4 });
    walk.flat(r.minX, r.maxZ - sw, r.maxX, r.maxZ, y, { kind: 'world', scale: 4 });
    walk.flat(r.minX, r.minZ + sw, r.minX + sw, r.maxZ - sw, y, { kind: 'world', scale: 4 });
    walk.flat(r.maxX - sw, r.minZ + sw, r.maxX, r.maxZ - sw, y, { kind: 'world', scale: 4 });
    // Curb faces.
    curbs.wall(r.minX, r.maxZ, r.maxX, r.maxZ, 0, y, { kind: 'world', scale: 2 });
    curbs.wall(r.maxX, r.maxZ, r.maxX, r.minZ, 0, y, { kind: 'world', scale: 2 });
    curbs.wall(r.maxX, r.minZ, r.minX, r.minZ, 0, y, { kind: 'world', scale: 2 });
    curbs.wall(r.minX, r.minZ, r.minX, r.maxZ, 0, y, { kind: 'world', scale: 2 });
  }
  for (const gp of layout.ground) {
    const tex = GROUND_TEX[gp.kind];
    patch(tex).flat(gp.rect.minX, gp.rect.minZ, gp.rect.maxX, gp.rect.maxZ, y + 0.004, { kind: 'world', scale: tex === 'plaza' ? 6 : 8 });
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
  const prom = patch('plaza');
  const wood = new GeoBuilder(false);
  walk.flat(b.cityMinX - sw, b.cityMinZ - sw, b.cityMaxX + sw, b.cityMinZ, y, { kind: 'world', scale: 4 });
  walk.flat(b.cityMinX - sw, b.cityMaxZ, b.cityMaxX + sw, b.cityMaxZ + sw, y, { kind: 'world', scale: 4 });
  walk.flat(b.cityMinX - sw, b.cityMinZ, b.cityMinX, b.cityMaxZ, y, { kind: 'world', scale: 4 });
  walk.flat(b.cityMaxX, b.cityMinZ, b.cityMaxX + sw, b.cityMaxZ, y, { kind: 'world', scale: 4 });
  curbs.wall(b.cityMinX, b.cityMinZ, b.cityMaxX, b.cityMinZ, 0, y, { kind: 'world', scale: 2 });
  curbs.wall(b.cityMaxX, b.cityMaxZ, b.cityMinX, b.cityMaxZ, 0, y, { kind: 'world', scale: 2 });
  curbs.wall(b.cityMinX, b.cityMaxZ, b.cityMinX, b.cityMinZ, 0, y, { kind: 'world', scale: 2 });
  curbs.wall(b.cityMaxX, b.cityMinZ, b.cityMaxX, b.cityMaxZ, 0, y, { kind: 'world', scale: 2 });
  prom.flat(b.landMinX, b.landMinZ, b.cityMinX - sw, b.landMaxZ, y, { kind: 'world', scale: 6 });
  prom.flat(b.cityMinX - sw, b.landMinZ, b.beachStartX, b.cityMinZ - sw, y, { kind: 'world', scale: 6 });
  prom.flat(b.cityMinX - sw, b.cityMaxZ + sw, b.beachStartX, b.landMaxZ, y, { kind: 'world', scale: 6 });
  wood.flat(b.cityMaxX + sw, b.cityMinZ - sw, b.beachStartX, b.cityMaxZ + sw, y, { kind: 'world', scale: 4 });

  const wet = view.wet;
  view.add(walk.build(), wet.patch(view.surface('sidewalk')), { name: 'sidewalks' });
  view.add(curbs.build(), wet.patch(view.surface('concrete')), { name: 'curbs' });
  view.add(wood.build(), wet.patch(view.surface('wood')), { name: 'boardwalk' });
  for (const [k, g] of patches) {
    const m = view.surface(k as 'grass' | 'plaza' | 'asphalt' | 'dirt');
    // Grass soaks the rain up rather than shining.
    if (k !== 'grass') wet.patch(m);
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -1;
    view.add(g.build(), m, { name: `ground-${k}` });
  }
  const lineMat = wet.patch(new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  view.add(lines.build(), lineMat, { name: 'parking-lines' });
}
