// Coyote Ridge's fire road and Lookout Point (world/country/hills.ts): the gravel road draped on the ridge's south
// shoulder from its turn-off on the Lomas Highway, across the Pass Road, up to the car park on the crest, the car park, its parapet, and the
// timber fire lookout tower, and the boulders on the walls of Coyote Pass. The ground itself is ground.ts's, the turbines
// turbines.ts's, and the plaque and the coin telescope are dressing (dressing.ts viewpoints). A few thousand triangles:
// one mesh per material.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FIRE_ROAD_W, fireRoadLine, LOOKOUT, PASS_ROCK_VARIANTS, passRocks, type PassRock } from '../../world/country/hills';
import type { FireTower } from '../../world/country/lakeland';
import { PARAPET_H } from '../../world/layout';
import { boulder } from '../city/coast';
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
/** The boulders' rock, as the foreshore's (city/coast.ts), and the darker one they shade to. */
const ROCK = 0x7d766c;
const ROCK_DARK = 0x5e564b;

export function buildHills(view: CountryView): void {
  const world = view.world;
  const surfaces = view.city.ground;
  const ground = (x: number, z: number) => world.groundHeight(x, z);
  const gravel = new GeoBuilder(false);
  const uv = { kind: 'world', scale: 6 } as const;
  const s = 1 / uv.scale;
  // The road: a strip across the centre line at every sample, each edge on the ground under it, but for where it crosses
  // the Pass Road, whose asphalt runs on.
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
    if (world.isOnRoad((ax + cx) / 2, (az + cz) / 2)) continue;
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
  view.add(lookoutTower(top, LOOKOUT.tower), mat, { shadow: true, name: 'fire-lookout', split: false });
  // Wet in the rain and lit by the headlights as the ground they lie on is.
  view.add(boulders(passRocks(world.layout.country)), rockMaterial(view), { shadow: true, name: 'pass-rocks' });
}

/** The material of every boulder of the county's: grey-brown flat-shaded rock, wet in the rain. */
export function rockMaterial(view: CountryView): THREE.Material {
  return view.city.wet.patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
}

/** Boulders: the foreshore's lumps (city/coast.ts) in their grey-brown rock, each sunk a fifth into the ground. */
export function boulders(rocks: readonly PassRock[]): THREE.BufferGeometry {
  const shapes = Array.from({ length: PASS_ROCK_VARIANTS }, (_, v) => boulder(41 + v, 1));
  const parts: THREE.BufferGeometry[] = [];
  const quat = new THREE.Quaternion();
  const rock = new THREE.Color();
  const dark = new THREE.Color(ROCK_DARK);
  for (const r of rocks) {
    const geo = shapes[r.variant]!.clone();
    geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(r.x, r.y - r.size * 0.2, r.z), quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.yaw), new THREE.Vector3(r.size, r.size, r.size)));
    rock.set(ROCK).lerp(dark, r.tint);
    parts.push(paint(geo, rock.getHex()));
  }
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return geo;
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
 * A fire lookout: four timber posts braced crosswise on every side up to a deck, a boarded cab with a band of windows
 * all round, a catwalk rail and a pyramid roof, standing on the ground at `y` (world/country/hills.ts LOOKOUT.tower, and
 * Pinewood's, world/country/woods.ts PINE_TOWER, whose posts carry a storey of braces for every 5 m).
 */
export function lookoutTower(y: number, t: FireTower): THREE.BufferGeometry {
  const V = (x: number, h: number, z: number) => new THREE.Vector3(t.x + x, y + h, t.z + z);
  const h = t.half;
  const parts: THREE.BufferGeometry[] = [];
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]] as const;
  for (const [x, z] of corners) parts.push(beam(V(x, 0, z), V(x, t.cab, z), t.post * 2, t.post * 2, TIMBER));
  // Cross braces on each side in storeys of about 5 m, and a ring of girts between them.
  const storeys = Math.max(2, Math.round(t.cab / 5));
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k]!;
    const [bx, bz] = corners[(k + 1) % 4]!;
    for (let s = 0; s < storeys; s++) {
      const y0 = s === 0 ? 0.4 : (t.cab * s) / storeys;
      const y1 = s === storeys - 1 ? t.cab - 0.3 : (t.cab * (s + 1)) / storeys;
      parts.push(beam(V(ax, y0, az), V(bx, y1, bz), 0.12, 0.12, TIMBER));
      parts.push(beam(V(bx, y0, bz), V(ax, y1, az), 0.12, 0.12, TIMBER));
      if (s > 0) parts.push(beam(V(ax, y0, az), V(bx, y0, bz), 0.16, 0.16, TIMBER));
    }
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
