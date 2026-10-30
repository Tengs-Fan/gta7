// Coast: the sloped beach, quay walls and piers.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { BEACH_W, CURB_H, DECK_SLAB, SEABED_Y, WATER_Y } from '../../world/constants';
import { PARAPET_H, rectContains, sandHeight, type Rect } from '../../world/layout';
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
  revetments(view, quayWalls(view, walls));
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

/** A stretch of shore from (x0, z0) to (x1, z1), the water on the side of (nx, nz). */
interface Shore {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  nx: number;
  nz: number;
}

/**
 * The quay walls: every stretch where land meets the sea along the land rectangle's west, north and south edges,
 * round the water cut into it and round the headlands, each facing out over the water. Returns the stretches.
 */
function quayWalls(view: CityView, walls: GeoBuilder): Shore[] {
  const shores: Shore[] = [];
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
      const n = before ? 1 : -1;
      shores.push(e.vertical ? { x0: e.at, z0: t0, x1: e.at, z1: t1, nx: n, nz: 0 } : { x0: t0, z0: e.at, x1: t1, z1: e.at, nx: 0, nz: n });
    }
  }
  return shores;
}

/**
 * The rocky foreshore: boulders per metre of shore, the band they fill (from `out` m off the wall to `out` + up to
 * `reach` m, wandering along the shore so it runs out into rocky fingers here and there), their size (m), and the
 * icosahedron detail of their shape. Heaped wider, bigger and higher round a headland.
 */
const RIPRAP = { perMetre: 1, out: 0.3, reach: [2, 11], size: [0.9, 2.4], rise: 0, detail: 0 } as const;
const HEADLAND_RIPRAP = { perMetre: 1.4, out: 0.2, reach: [4, 16], size: [1.4, 3.6], rise: 0.5, detail: 1 } as const;
/** Metres between the foreshore width's lattice points along a shore. */
const REACH_WAVE = 28;

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
function revetments(view: CityView, shores: Shore[]): void {
  const layout = view.world.layout;
  const built: Rect[] = layout.water.filter((w) => w.name === 'Port Basin' || w.name === 'Cortez Canal').flatMap((w) => w.area);
  const headlands = layout.headlands.flatMap((h) => h.rects);
  const near = (rs: Rect[], x: number, z: number, m: number) => rs.some((r) => rectContains(r, x, z, m));
  const rng = new Rng(0x7e55e1);
  const specs = [RIPRAP, HEADLAND_RIPRAP];
  const variants = specs.map((spec, k) => [boulder(11 + k, spec.detail), boulder(23 + k, spec.detail), boulder(37 + k, spec.detail)]);
  const placed: THREE.Matrix4[][][] = specs.map(() => [[], [], []]);
  const tints: THREE.Color[][][] = specs.map(() => [[], [], []]);
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const s of shores) {
    const len = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    const mx = (s.x0 + s.x1) / 2;
    const mz = (s.z0 + s.z1) / 2;
    if (near(built, mx + s.nx, mz + s.nz, 1)) continue;
    const k = near(headlands, mx - s.nx, mz - s.nz, 1) ? 1 : 0;
    const spec = specs[k]!;
    // The band's width along the shore: smoothly between random lattice values, squared so wide fingers are rare.
    const lattice = Array.from({ length: Math.ceil(len / REACH_WAVE) + 2 }, () => rng.next() ** 2);
    const reachAt = (d: number) => {
      const f = d / REACH_WAVE;
      const i = Math.floor(f);
      const u = f - i;
      const w = u * u * (3 - 2 * u);
      return spec.reach[0] + (spec.reach[1] - spec.reach[0]) * (lattice[i]! * (1 - w) + lattice[i + 1]! * w);
    };
    const count = Math.max(1, Math.round(len * spec.perMetre));
    for (let n = 0; n < count; n++) {
      const t = (n + rng.next()) / count;
      const reach = reachAt(t * len);
      // Heaped: most boulders hug the wall, fewer reach the band's far edge.
      const f = rng.next() ** 1.5;
      const out = spec.out + reach * f;
      const x = s.x0 + (s.x1 - s.x0) * t + s.nx * out;
      const z = s.z0 + (s.z1 - s.z0) * t + s.nz * out;
      const size = rng.range(spec.size[0], spec.size[1]) * (1 - 0.4 * f);
      const y = WATER_Y + rng.range(-0.35, 0.45) * size + spec.rise * (1 - f);
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
