// Coyote Ridge's fire road and Lookout Point (world/country/hills.ts): the gravel road draped on the ridge's south
// shoulder from its turn-off on the Lomas Highway up to the car park on the crest, the car park, its parapet, and the
// timber fire lookout tower. The ground itself is ground.ts's, the turbines turbines.ts's, and the plaque and the coin
// telescope are dressing (dressing.ts viewpoints). A few thousand triangles: one mesh per material.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FIRE_ROAD_W, fireRoadLine, LOOKOUT } from '../../world/country/hills';
import { PARAPET_H } from '../../world/layout';
import { NO_RECT, setGroundAttribute } from '../city/surfaces';
import { GeoBuilder } from '../geo';
import type { CountryView } from './index';

/** Height (m) of the gravel over the ground it is draped on, above the ground mesh's chords over the slopes. */
const GRAVEL_Y = 0.05;
/** The fire road's samples (m apart) along its centre line. */
const ROAD_STEP = 2;

/** The tower's timber, its cab's boards, its roof and its windows. */
const TIMBER = 0x6e5236;
const BOARDS = 0x8a6a46;
const ROOF = 0x4b4038;
const GLASS = 0x26323c;

export function buildHills(view: CountryView): void {
  const world = view.world;
  const surfaces = view.city.ground;
  const ground = (x: number, z: number) => world.groundHeight(x, z);
  const gravel = new GeoBuilder(false);
  const uv = { kind: 'world', scale: 6 } as const;
  const s = 1 / uv.scale;
  // The road: a strip across the centre line at every sample, each edge on the ground under it.
  const line = fireRoadLine(ROAD_STEP);
  const half = FIRE_ROAD_W / 2;
  const edge = (i: number, side: number) => {
    const p = line[i]!;
    const x = p.x + Math.cos(p.heading) * half * side;
    const z = p.z - Math.sin(p.heading) * half * side;
    return [x, ground(x, z) + GRAVEL_Y, z] as const;
  };
  for (let i = 1; i < line.length; i++) {
    const [ax, ay, az] = edge(i - 1, 1);
    const [bx, by, bz] = edge(i, 1);
    const [cx, cy, cz] = edge(i, -1);
    const [dx, dy, dz] = edge(i - 1, -1);
    gravel.quad(dx, dy, dz, cx, cy, cz, bx, by, bz, ax, ay, az, [dx * s, -dz * s, cx * s, -cz * s, bx * s, -bz * s, ax * s, -az * s]);
  }
  // The car park on the crest's flat top.
  const pad = LOOKOUT.pad;
  const top = ground(LOOKOUT.tower.x, LOOKOUT.tower.z);
  gravel.flat(pad.minX, pad.minZ, pad.maxX, pad.maxZ, top + GRAVEL_Y, uv);
  const gravelMat = surfaces.patch(view.city.wet.patch(surfaces.material('plain', 'dirt', 7)), 'plain');
  gravelMat.polygonOffset = true;
  gravelMat.polygonOffsetFactor = -1;
  gravelMat.polygonOffsetUnits = -1;
  view.add(setGroundAttribute(gravel.build(), [], NO_RECT), gravelMat, { name: 'fire-road', split: false });

  // The parapet along the car park's east edge, as the lookout's at Azura Point.
  const wall = new GeoBuilder(false);
  const q = LOOKOUT.parapet;
  wall.box(q.minX, top, q.minZ, q.maxX, top + PARAPET_H, q.maxZ, { uv: { kind: 'world', scale: 3 } });
  view.add(wall.build(), view.city.wet.patch(view.city.surface('concrete', 1, 3)), { shadow: true, name: 'lookout-parapet', split: false });

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.name = 'fire-lookout';
  view.add(lookoutTower(top), mat, { shadow: true, name: 'fire-lookout', split: false });
}

/** A box from a to b (its length along them) of the given cross-section, painted. */
function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, color: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(w, h, len);
  g.deleteAttribute('uv');
  const m = new THREE.Matrix4().lookAt(b, a, Math.abs(b.y - a.y) > len * 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  g.applyMatrix4(m);
  return paint(g, color);
}

function paint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgb.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
  return geo;
}

/**
 * The fire lookout: four timber posts braced crosswise on every side up to a deck, a boarded cab with a band of windows
 * all round, a catwalk rail and a pyramid roof, standing on the ground at `y` (world/country/hills.ts LOOKOUT.tower).
 */
function lookoutTower(y: number): THREE.BufferGeometry {
  const t = LOOKOUT.tower;
  const V = (x: number, h: number, z: number) => new THREE.Vector3(t.x + x, y + h, t.z + z);
  const h = t.half;
  const parts: THREE.BufferGeometry[] = [];
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]] as const;
  for (const [x, z] of corners) parts.push(beam(V(x, 0, z), V(x, t.cab, z), t.post * 2, t.post * 2, TIMBER));
  // Cross braces on each side in two storeys, and a ring of girts between them.
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k]!;
    const [bx, bz] = corners[(k + 1) % 4]!;
    for (const [y0, y1] of [[0.4, t.cab / 2], [t.cab / 2, t.cab - 0.3]] as const) {
      parts.push(beam(V(ax, y0, az), V(bx, y1, bz), 0.12, 0.12, TIMBER));
      parts.push(beam(V(bx, y0, bz), V(ax, y1, az), 0.12, 0.12, TIMBER));
    }
    parts.push(beam(V(ax, t.cab / 2, az), V(bx, t.cab / 2, bz), 0.16, 0.16, TIMBER));
  }
  // The deck, wider than the posts, and the cab on it: boards to the sill, windows, boards over them.
  const deck = h + 0.9;
  parts.push(paint(new THREE.BoxGeometry(deck * 2, 0.25, deck * 2).translate(t.x, y + t.cab, t.z), TIMBER));
  const cab = h + 0.3;
  const sill = t.cab + 1.1;
  const head = t.top - 1.2;
  parts.push(paint(new THREE.BoxGeometry(cab * 2, sill - t.cab, cab * 2).translate(t.x, y + (t.cab + sill) / 2, t.z), BOARDS));
  parts.push(paint(new THREE.BoxGeometry(cab * 2 - 0.1, head - sill, cab * 2 - 0.1).translate(t.x, y + (sill + head) / 2, t.z), GLASS));
  for (const [x, z] of corners) parts.push(beam(V((x * cab) / h, sill, (z * cab) / h), V((x * cab) / h, head, (z * cab) / h), 0.14, 0.14, BOARDS));
  parts.push(paint(new THREE.BoxGeometry(cab * 2, t.top - 0.9 - head, cab * 2).translate(t.x, y + (head + t.top - 0.9) / 2, t.z), BOARDS));
  // The catwalk's rail round the deck's edge.
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k]!;
    const [bx, bz] = corners[(k + 1) % 4]!;
    const a = V((ax * deck) / h, t.cab + 1, (az * deck) / h);
    const b = V((bx * deck) / h, t.cab + 1, (bz * deck) / h);
    parts.push(beam(a, b, 0.08, 0.08, TIMBER));
    parts.push(beam(a, a.clone().setY(y + t.cab), 0.08, 0.08, TIMBER));
  }
  // The roof: a shallow pyramid over the eaves.
  const eave = cab + 0.6;
  const roof = new THREE.ConeGeometry(eave * Math.SQRT2, 1.4, 4, 1).rotateY(Math.PI / 4).translate(t.x, y + t.top - 0.9 + 0.7, t.z);
  parts.push(paint(roof, ROOF));
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  geo.computeVertexNormals();
  return geo;
}
