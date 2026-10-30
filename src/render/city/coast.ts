// Coast: the sloped beach, quay walls and piers.

import * as THREE from 'three';
import { BEACH_W, CURB_H, DECK_SLAB, SEABED_Y, WATER_Y } from '../../world/constants';
import { PARAPET_H, sandHeight } from '../../world/layout';
import { GeoBuilder } from '../geo';
import { pilingCentres, PILING_RADIUS } from '../sea';
import type { CityView } from './index';
import { setGroundAttribute } from './surfaces';

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
    const s = 1 / view.ground.tile('sand');
    sand.quad(x0, y0, b.landMaxZ, x1, y1, b.landMaxZ, x1, y1, b.landMinZ, x0, y0, b.landMinZ, [x0 * s, -b.landMaxZ * s, x1 * s, -b.landMaxZ * s, x1 * s, -b.landMinZ * s, x0 * s, -b.landMinZ * s]);
  }
  // Drop-off into deep water.
  sand.quad(b.beachEndX, end, b.landMaxZ, b.beachEndX + 25, SEABED_Y, b.landMaxZ, b.beachEndX + 25, SEABED_Y, b.landMinZ, b.beachEndX, end, b.landMinZ, [0, 0, 1, 0, 1, 1, 0, 1]);
  // Quay walls wherever the land meets the sea, and the beach's north/south edges.
  const bottom = SEABED_Y;
  quayWalls(view, walls);
  for (let i = 0; i < steps; i++) {
    const x0 = b.beachStartX + (BEACH_W * i) / steps;
    const x1 = b.beachStartX + (BEACH_W * (i + 1)) / steps;
    walls.quad(x1, bottom, b.landMinZ, x0, bottom, b.landMinZ, x0, sandHeight(b, x0), b.landMinZ, x1, sandHeight(b, x1), b.landMinZ, [0, 0, 1, 0, 1, 1, 0, 1]);
    walls.quad(x0, bottom, b.landMaxZ, x1, bottom, b.landMaxZ, x1, sandHeight(b, x1), b.landMaxZ, x0, sandHeight(b, x0), b.landMaxZ, [0, 0, 1, 0, 1, 1, 0, 1]);
  }
  // Wet sand along the waterline, ripples and the surf's lace (the detail patch); the sand stays dry under rain.
  const sandMat = view.ground.patch(view.ground.material('sand'), 'sand');
  view.add(setGroundAttribute(sand.build(), []), sandMat, { name: 'beach' });
  view.add(walls.build(), view.surface('concrete', 1, 3), { name: 'quay' });

  // The canal's bridges: concrete slabs (the road's asphalt is drawn on the carriageway), parapets on the footways.
  const bridges = new GeoBuilder(false);
  const concrete = { uv: { kind: 'world', scale: 3 }, bottom: true } as const;
  for (const d of view.world.layout.decks) {
    if (!d.bridge) continue;
    // The carriageway's top stays just under the asphalt; a footway's top is its paving.
    bridges.box(d.rect.minX, d.y - 0.7, d.rect.minZ, d.rect.maxX, d.y > 0 ? d.y : d.y - 0.02, d.rect.maxZ, concrete);
  }
  for (const r of view.world.layout.parapets) bridges.box(r.minX, CURB_H, r.minZ, r.maxX, CURB_H + PARAPET_H, r.maxZ, concrete);
  view.add(bridges.build(), view.wet.patch(view.surface('concrete', 1, 3)), { shadow: true, name: 'bridges' });

  // Piers.
  const deck = new GeoBuilder(false);
  const pillars: THREE.Vector3[] = [];
  for (const d of view.world.layout.decks) {
    if (d.bridge) continue;
    deck.box(d.rect.minX, d.y - DECK_SLAB, d.rect.minZ, d.rect.maxX, d.y, d.rect.maxZ, { uv: { kind: 'world', scale: 4 }, bottom: true });
    for (const p of pilingCentres(d.rect, (x, z) => view.world.baseGround(x, z))) pillars.push(new THREE.Vector3(p.x, d.y, p.z));
  }
  view.add(deck.build(), view.wet.patch(view.surface('wood', 1, 2)), { shadow: true, name: 'piers' });
  if (pillars.length > 0) {
    const pg = new THREE.CylinderGeometry(PILING_RADIUS, PILING_RADIUS, 1, 6);
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

/**
 * The quay walls: every stretch where land meets the sea along the land rectangle's west, north and south edges,
 * round the water cut into it and round the headlands, each facing out over the water.
 */
function quayWalls(view: CityView, walls: GeoBuilder): void {
  const world = view.world;
  const layout = world.layout;
  const b = layout.bounds;
  const land = (x: number, z: number) => world.baseGround(x, z) > WATER_Y;
  const rects = [...layout.water.flatMap((w) => w.rects), ...layout.headlands.flatMap((h) => h.rects)];
  const edges: Array<{ vertical: boolean; at: number; t0: number; t1: number }> = [
    { vertical: true, at: b.landMinX, t0: b.landMinZ, t1: b.landMaxZ },
    { vertical: false, at: b.landMinZ, t0: b.landMinX, t1: b.beachStartX },
    { vertical: false, at: b.landMaxZ, t0: b.landMinX, t1: b.beachStartX },
  ];
  for (const r of rects) {
    edges.push({ vertical: true, at: r.minX, t0: r.minZ, t1: r.maxZ }, { vertical: true, at: r.maxX, t0: r.minZ, t1: r.maxZ });
    edges.push({ vertical: false, at: r.minZ, t0: r.minX, t1: r.maxX }, { vertical: false, at: r.maxZ, t0: r.minX, t1: r.maxX });
  }
  // Land and water can only change hands at a rectangle's edge: split every edge there.
  const xs = [b.landMinX, b.beachStartX, ...rects.flatMap((r) => [r.minX, r.maxX])];
  const zs = [b.landMinZ, b.landMaxZ, ...rects.flatMap((r) => [r.minZ, r.maxZ])];
  const done = new Set<string>();
  const uv = { kind: 'world', scale: 3 } as const;
  for (const e of edges) {
    const cuts = [e.t0, e.t1, ...(e.vertical ? zs : xs).filter((t) => t > e.t0 && t < e.t1)].sort((p, q) => p - q);
    for (let k = 1; k < cuts.length; k++) {
      const t0 = cuts[k - 1]!;
      const t1 = cuts[k]!;
      const key = `${e.vertical ? 'x' : 'z'}${e.at.toFixed(2)}:${t0.toFixed(2)}`;
      if (t1 - t0 < 0.01 || done.has(key)) continue;
      const m = (t0 + t1) / 2;
      const before = e.vertical ? land(e.at - 0.3, m) : land(m, e.at - 0.3);
      const after = e.vertical ? land(e.at + 0.3, m) : land(m, e.at + 0.3);
      if (before === after) continue;
      done.add(key);
      // GeoBuilder.wall faces (-dz, dx) of the direction it runs in.
      if (e.vertical) walls.wall(e.at, before ? t1 : t0, e.at, before ? t0 : t1, SEABED_Y, CURB_H, uv);
      else walls.wall(before ? t0 : t1, e.at, before ? t1 : t0, e.at, SEABED_Y, CURB_H, uv);
    }
  }
}
