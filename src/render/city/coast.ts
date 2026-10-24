// Coast: the sloped beach, quay walls and piers.

import * as THREE from 'three';
import { BEACH_W, CURB_H, DECK_SLAB, SEABED_Y, WATER_Y } from '../../world/constants';
import { sandHeight } from '../../world/layout';
import { GeoBuilder } from '../geo';
import type { CityView } from './index';

export function buildCoast(view: CityView): void {
  const b = view.world.layout.bounds;
  const sand = new GeoBuilder(false);
  const walls = new GeoBuilder(false);
  const end = sandHeight(b, b.beachEndX);
  // Sloped beach in strips so the slope reads well under shadows.
  const steps = 10;
  for (let i = 0; i < steps; i++) {
    const x0 = b.beachStartX + (BEACH_W * i) / steps;
    const x1 = b.beachStartX + (BEACH_W * (i + 1)) / steps;
    const y0 = sandHeight(b, x0);
    const y1 = sandHeight(b, x1);
    const s = 1 / 8;
    sand.quad(x0, y0, b.landMaxZ, x1, y1, b.landMaxZ, x1, y1, b.landMinZ, x0, y0, b.landMinZ, [x0 * s, -b.landMaxZ * s, x1 * s, -b.landMaxZ * s, x1 * s, -b.landMinZ * s, x0 * s, -b.landMinZ * s]);
  }
  // Drop-off into deep water.
  sand.quad(b.beachEndX, end, b.landMaxZ, b.beachEndX + 25, SEABED_Y, b.landMaxZ, b.beachEndX + 25, SEABED_Y, b.landMinZ, b.beachEndX, end, b.landMinZ, [0, 0, 1, 0, 1, 1, 0, 1]);
  // Quay walls (W, N, S) and the beach's north/south edges.
  const bottom = SEABED_Y;
  walls.wall(b.landMinX, b.landMinZ, b.landMinX, b.landMaxZ, bottom, CURB_H, { kind: 'world', scale: 3 });
  walls.wall(b.beachStartX, b.landMinZ, b.landMinX, b.landMinZ, bottom, CURB_H, { kind: 'world', scale: 3 });
  walls.wall(b.landMinX, b.landMaxZ, b.beachStartX, b.landMaxZ, bottom, CURB_H, { kind: 'world', scale: 3 });
  for (let i = 0; i < steps; i++) {
    const x0 = b.beachStartX + (BEACH_W * i) / steps;
    const x1 = b.beachStartX + (BEACH_W * (i + 1)) / steps;
    walls.quad(x1, bottom, b.landMinZ, x0, bottom, b.landMinZ, x0, sandHeight(b, x0), b.landMinZ, x1, sandHeight(b, x1), b.landMinZ, [0, 0, 1, 0, 1, 1, 0, 1]);
    walls.quad(x0, bottom, b.landMaxZ, x1, bottom, b.landMaxZ, x1, sandHeight(b, x1), b.landMaxZ, x0, sandHeight(b, x0), b.landMaxZ, [0, 0, 1, 0, 1, 1, 0, 1]);
  }
  const sandMat = view.surface('sand');
  view.add(sand.build(), sandMat, { name: 'beach' });
  view.add(walls.build(), view.surface('concrete', 1, 3), { name: 'quay' });

  // Piers.
  const deck = new GeoBuilder(false);
  const pillars: THREE.Vector3[] = [];
  for (const d of view.world.layout.decks) {
    deck.box(d.rect.minX, d.y - DECK_SLAB, d.rect.minZ, d.rect.maxX, d.y, d.rect.maxZ, { uv: { kind: 'world', scale: 4 }, bottom: true });
    for (let x = d.rect.minX + 2; x < d.rect.maxX; x += 7) {
      for (const z of [d.rect.minZ + 0.6, d.rect.maxZ - 0.6]) if (WATER_Y > view.world.baseGround(x, z) - 0.1) pillars.push(new THREE.Vector3(x, d.y, z));
    }
  }
  view.add(deck.build(), view.wet.patch(view.surface('wood', 1, 2)), { shadow: true, name: 'piers' });
  if (pillars.length > 0) {
    const pg = new THREE.CylinderGeometry(0.25, 0.25, 1, 6);
    pg.translate(0, -0.5, 0);
    const pm = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 }), pillars.length);
    const m = new THREE.Matrix4();
    pillars.forEach((p, i) => {
      const h = p.y - SEABED_Y;
      m.makeScale(1, h, 1);
      m.setPosition(p.x, p.y - DECK_SLAB, p.z);
      pm.setMatrixAt(i, m);
    });
    pm.instanceMatrix.needsUpdate = true;
    pm.computeBoundingSphere();
    view.group.add(pm);
  }
}
