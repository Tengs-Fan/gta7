// Roads: asphalt, gutters, ironwork, lane markings and crosswalks.

import * as THREE from 'three';
import { CROSSWALK_W, LANE_W } from '../../world/constants';
import { hashInts } from '../../world/layout';
import { GeoBuilder } from '../geo';
import { manhole, stormDrain } from '../cityArchitecture';
import type { CityView } from './index';
import { quadLine } from './shared';

export function buildRoads(view: CityView): void {
  const roads = view.world.roads;
  const asphalt = new GeoBuilder(false);
  const gutters = new GeoBuilder(false);
  const ironwork = new GeoBuilder(true);
  const white = new GeoBuilder(false);
  const yellow = new GeoBuilder(false);
  const yM = 0.02;
  for (const n of roads.nodes) asphalt.flat(n.x - n.halfX, n.z - n.halfZ, n.x + n.halfX, n.z + n.halfZ, 0, { kind: 'world', scale: 8 });
  for (const s of roads.segments) {
    asphalt.flat(s.minX, s.minZ, s.maxX, s.maxZ, 0, { kind: 'world', scale: 8 });
    const line = s.line;
    const c = line.pos;
    // Markings run between the crosswalk bands.
    const a0 = (s.vertical ? s.minZ : s.minX) + CROSSWALK_W;
    const a1 = (s.vertical ? s.maxZ : s.maxX) - CROSSWALK_W;
    const L = (a: number, o: number) => (s.vertical ? { x: c + o, z: a } : { x: a, z: c + o });
    // Narrow concrete gutters make the asphalt meet the raised pavement cleanly.
    // Grates and service covers are flush finishes, below all road paint.
    for (const side of [-1, 1]) {
      const off = side * (line.width / 2 - 0.15);
      const start = L(s.vertical ? s.minZ : s.minX, off);
      const end = L(s.vertical ? s.maxZ : s.maxX, off);
      quadLine(gutters, start.x, start.z, end.x, end.z, 0.3, 0.004);
      for (const along of [a0 + 1.5, a1 - 1.5]) {
        const drain = L(along, side * (line.width / 2 - 0.22));
        stormDrain(ironwork, drain.x, drain.z, s.vertical);
      }
    }
    if (hashInts(s.a, s.b) % 3 !== 0 && a1 - a0 > 8) {
      const cover = L((a0 + a1) / 2, LANE_W * 0.5);
      manhole(ironwork, cover.x, cover.z);
    }
    // Centre line(s).
    if (line.lanes === 2) {
      for (const o of [-0.16, 0.16]) {
        const p = L(a0, o);
        const q = L(a1, o);
        quadLine(yellow, p.x, p.z, q.x, q.z, 0.12, yM);
      }
      // Dashed lane dividers.
      for (const o of [-LANE_W, LANE_W]) {
        for (let a = a0 + 2; a + 3 <= a1; a += 9) {
          const p = L(a, o);
          const q = L(a + 3, o);
          quadLine(white, p.x, p.z, q.x, q.z, 0.12, yM);
        }
      }
    } else {
      for (let a = a0 + 1; a + 4 <= a1; a += 7) {
        const p = L(a, 0);
        const q = L(a + 4, 0);
        quadLine(yellow, p.x, p.z, q.x, q.z, 0.13, yM);
      }
    }
    // Edge lines.
    for (const o of [-(line.width / 2 - 0.35), line.width / 2 - 0.35]) {
      const p = L(a0, o);
      const q = L(a1, o);
      quadLine(white, p.x, p.z, q.x, q.z, 0.1, yM);
    }
  }
  // Stop lines and zebra crossings.
  for (const n of roads.nodes) {
    for (let d = 0; d < 4; d++) {
      if (n.neighbors[d]! < 0) continue;
      const vertical = d === 0 || d === 2;
      const sign = d === 0 || d === 3 ? -1 : 1;
      const halfAlong = vertical ? n.halfZ : n.halfX;
      const width = vertical ? n.halfX * 2 : n.halfZ * 2;
      const c0 = halfAlong;
      const c1 = halfAlong + CROSSWALK_W;
      // Zebra: stripes parallel to the road.
      for (let o = -width / 2 + 0.6; o <= width / 2 - 0.6; o += 1.2) {
        const a = c0 + 0.4;
        const b = c1 - 0.4;
        if (vertical) quadLine(white, n.x + o, n.z + sign * a, n.x + o, n.z + sign * b, 0.55, yM);
        else quadLine(white, n.x + sign * a, n.z + o, n.x + sign * b, n.z + o, 0.55, yM);
      }
      // Stop line across the incoming half (traffic arriving from direction d drives on its right).
      const sl = c1 + 0.3;
      if (vertical) {
        // Arriving from north (d=0 side) travels south; its lanes are on the west half.
        const x0 = d === 0 ? n.x - width / 2 + 0.2 : n.x + 0.3;
        const x1 = d === 0 ? n.x - 0.3 : n.x + width / 2 - 0.2;
        quadLine(white, x0, n.z + sign * sl, x1, n.z + sign * sl, 0.45, yM);
      } else {
        const z0 = d === 1 ? n.z - width / 2 + 0.2 : n.z + 0.3;
        const z1 = d === 1 ? n.z - 0.3 : n.z + width / 2 - 0.2;
        quadLine(white, n.x + sign * sl, z0, n.x + sign * sl, z1, 0.45, yM);
      }
    }
  }
  const wet = view.wet;
  const roadMat = wet.patch(view.surface('asphalt'));
  view.add(asphalt.build(), roadMat, { name: 'roads' });
  view.add(gutters.build(), wet.patch(view.surface('concrete')), { name: 'road-gutters' });
  view.add(ironwork.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.64, metalness: 0.35 }), { name: 'street-ironwork' });
  const mk = (color: number) => wet.patch(new THREE.MeshStandardMaterial({ color, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  view.add(white.build(), mk(0xe6e6e0), { name: 'markings-white' });
  view.add(yellow.build(), mk(0xe8b923), { name: 'markings-yellow' });
}
