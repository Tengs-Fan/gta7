// Coast: the sloped beach, quay walls, the headland's cliffs and piers.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { BEACH_W, CURB_H, DECK_SLAB, SEABED_Y, WATER_Y } from '../../world/constants';
import { PARAPET_H, sandHeight } from '../../world/layout';
import { foreshoreReach, shores, type Shore } from '../../world/shore';
import { lookoutRail } from '../../world/terrain';
import type { StaticWorld } from '../../world/staticWorld';
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
  const shore = shores(view.world);
  quayWalls(shore, walls);
  revetments(view, shore);
  cliffs(view, shore);
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

  // The bridges over the canal and the bays: concrete slabs (the road's asphalt is drawn on the carriageway), parapets on
  // the footways.
  const bridges = new GeoBuilder(false);
  const concrete = { uv: { kind: 'world', scale: 3 }, bottom: true } as const;
  for (const d of view.world.layout.decks) {
    if (!d.bridge) continue;
    // The carriageway's top stays just under the asphalt; a footway's top is its paving.
    bridges.box(d.rect.minX, d.y - 0.7, d.rect.minZ, d.rect.maxX, d.y > 0 ? d.y : d.y - 0.02, d.rect.maxZ, concrete);
  }
  for (const r of view.world.layout.parapets) bridges.box(r.minX, CURB_H, r.minZ, r.maxX, CURB_H + PARAPET_H, r.maxZ, concrete);
  const rail = lookoutRail(view.world.layout);
  bridges.box(rail.minX, rail.y, rail.minZ, rail.maxX, rail.y + PARAPET_H, rail.maxZ, concrete);
  view.add(bridges.build(), view.wet.patch(view.surface('concrete', 1, 3)), { shadow: true, name: 'bridges', split: false });

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

/** The quay walls along every stretch of shore but the headland's (its cliffs), each facing out over the water. */
function quayWalls(shore: Shore[], walls: GeoBuilder): void {
  const uv = { kind: 'world', scale: 3 } as const;
  for (const s of shore) {
    if (s.headland) continue;
    // GeoBuilder.wall faces (-dz, dx) of the direction it runs in.
    const forward = -(s.z1 - s.z0) * s.nx + (s.x1 - s.x0) * s.nz > 0;
    if (forward) walls.wall(s.x0, s.z0, s.x1, s.z1, SEABED_Y, CURB_H, uv);
    else walls.wall(s.x1, s.z1, s.x0, s.z0, SEABED_Y, CURB_H, uv);
  }
}

/**
 * The rocky foreshore's boulders: per metre of shore, from `out` m off the wall across the band foreshoreReach gives,
 * their size (m), and the icosahedron detail of their shape. Bigger and higher round a headland.
 */
const RIPRAP = { perMetre: 1, out: 0.3, size: [0.9, 2.4], rise: 0, climb: 0, detail: 0 } as const;
/** Round a headland the heap also climbs `climb` m against the cliff for every metre the cliff stands over the curb. */
const HEADLAND_RIPRAP = { perMetre: 1.4, out: 0.2, size: [1.4, 3.6], rise: 0.5, climb: 0.15, detail: 1 } as const;

/** A lumpy boulder: an icosahedron pushed in and out by a few seeded bumps, flat-shaded. */
function boulder(seed: number, detail: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const bumps = Array.from({ length: 5 }, () => new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize().multiplyScalar(rng.range(0.15, 0.35)));
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    let r = 1;
    for (const b of bumps) r += b.length() * Math.max(0, p.dot(b) / b.length()) ** 3 - 0.08;
    p.multiplyScalar(r);
    // Flatter than tall, as boulders settle.
    p.y *= 0.62;
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Riprap: a rocky foreshore at the foot of the open coast's quay walls and round the headlands, so the shore reads as
 * a ragged line of rock and water rather than a ruled one. The harbour basin and the canal keep their plain stone
 * walls. Drawn only: the rocks stand in the water off the walls, where nothing walks.
 */
function revetments(view: CityView, shore: Shore[]): void {
  const rng = new Rng(0x7e55e1);
  const specs = [RIPRAP, HEADLAND_RIPRAP];
  const variants = specs.map((spec, k) => [boulder(11 + k, spec.detail), boulder(23 + k, spec.detail), boulder(37 + k, spec.detail)]);
  const placed: THREE.Matrix4[][][] = specs.map(() => [[], [], []]);
  const tints: THREE.Color[][][] = specs.map(() => [[], [], []]);
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const s of shore) {
    if (s.built) continue;
    const len = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    const k = s.headland ? 1 : 0;
    const spec = specs[k]!;
    const reachAt = foreshoreReach(s);
    const count = Math.max(1, Math.round(len * spec.perMetre));
    for (let n = 0; n < count; n++) {
      const t = (n + rng.next()) / count;
      // Heaped: most boulders hug the wall, fewer reach the band's far edge.
      const f = rng.next() ** 1.5;
      const out = spec.out + reachAt(t * len) * f;
      const x = s.x0 + (s.x1 - s.x0) * t + s.nx * out;
      const z = s.z0 + (s.z1 - s.z0) * t + s.nz * out;
      const size = rng.range(spec.size[0], spec.size[1]) * (1 - 0.4 * f);
      const tall = Math.max(0, cliffTop(view.world, s, s.x0 + (s.x1 - s.x0) * t, s.z0 + (s.z1 - s.z0) * t) - CURB_H);
      const y = WATER_Y + rng.range(-0.35, 0.45) * size + (spec.rise + spec.climb * tall) * (1 - f);
      e.set(rng.range(-0.3, 0.3), rng.range(0, Math.PI * 2), rng.range(-0.3, 0.3));
      q.setFromEuler(e);
      const v = rng.int(0, 2);
      placed[k]![v]!.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(size * rng.range(0.9, 1.4), size, size * rng.range(0.9, 1.3))));
      tints[k]![v]!.push(new THREE.Color(0x7d766c).multiplyScalar(rng.range(0.75, 1.15)).lerp(new THREE.Color(0x5e564b), rng.next() * 0.5));
    }
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  specs.forEach((_, k) => {
    variants[k]!.forEach((g, v) => {
      const list = placed[k]![v]!;
      if (list.length === 0) return;
      const mesh = new THREE.InstancedMesh(g, mat, list.length);
      list.forEach((m, i) => {
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, tints[k]![v]![i]!);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      mesh.name = 'riprap';
      view.group.add(mesh);
    });
  });
}

/** The ground at the land's edge of shore `s` at (x, z): the top of its wall or cliff. */
function cliffTop(world: StaticWorld, s: Shore, x: number, z: number): number {
  return world.groundHeight(x - s.nx * 1e-3, z - s.nz * 1e-3);
}

/**
 * The cliff face's columns along the shore are the ground's lattice (ground.ts RISE_STEP), so its top meets the edge of
 * the ground drawn over the bluff vertex for vertex; its rows are at most CLIFF_ROW m tall, and between the columns at
 * either end and under its top edge it is pushed out over the water by up to CLIFF_RAG m, a ragged rock face.
 */
const CLIFF_STEP = 2;
const CLIFF_ROW = 2.5;
const CLIFF_RAG = 0.6;
/** The cliff rock: darker than the boulders heaped at its foot. */
const CLIFF_ROCK = 0x544c43;

/**
 * Azura Point's sides: rock from the seabed up to the ground at its edge, which climbs with the bluff, flat shaded like
 * the boulders (their material, in a darker rock) and batched in cells like the city's other shadow casters.
 */
function cliffs(view: CityView, shore: Shore[]): void {
  const g = new GeoBuilder(false);
  const rng = new Rng(0xc11ff5);
  for (const s of shore) {
    if (!s.headland) continue;
    const vertical = s.x0 === s.x1;
    const a = vertical ? Math.min(s.z0, s.z1) : Math.min(s.x0, s.x1);
    const b = vertical ? Math.max(s.z0, s.z1) : Math.max(s.x0, s.x1);
    const ts = [a];
    for (let t = (Math.floor(a / CLIFF_STEP) + 1) * CLIFF_STEP; t < b - 1e-6; t += CLIFF_STEP) if (t > a + 1e-6) ts.push(t);
    ts.push(b);
    // GeoBuilder.wall's winding: the face looks to (-dz, dx) of the way the columns run; turn them to face the water.
    const dx = vertical ? 0 : 1;
    const dz = vertical ? 1 : 0;
    if (-dz * s.nx + dx * s.nz < 0) ts.reverse();
    const cols = ts.map((t) => {
      const x = vertical ? s.x0 : t;
      const z = vertical ? t : s.z0;
      return { x, z, top: cliffTop(view.world, s, x, z) };
    });
    const rows = Math.ceil((Math.max(...cols.map((c) => c.top)) - SEABED_Y) / CLIFF_ROW);
    const pts = cols.map((c, i) =>
      Array.from({ length: rows + 1 }, (_, k) => {
        const rag = i === 0 || i === cols.length - 1 || k === rows ? 0 : rng.next() * CLIFF_RAG;
        return [c.x + s.nx * rag, SEABED_Y + ((c.top - SEABED_Y) * k) / rows, c.z + s.nz * rag] as const;
      }),
    );
    for (let i = 0; i + 1 < pts.length; i++) {
      for (let k = 0; k < rows; k++) g.quad(...pts[i]![k]!, ...pts[i + 1]![k]!, ...pts[i + 1]![k + 1]!, ...pts[i]![k + 1]!, [0, 0, 1, 0, 1, 1, 0, 1]);
    }
  }
  view.add(g.build(), new THREE.MeshStandardMaterial({ color: CLIFF_ROCK, roughness: 0.95, flatShading: true }), { shadow: true, name: 'cliffs' });
}
