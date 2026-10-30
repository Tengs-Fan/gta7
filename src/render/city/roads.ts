// Roads: asphalt, gutters, ironwork, lane markings, crosswalks, and tyre marks at the junctions.

import * as THREE from 'three';
import { CROSSWALK_W, LANE_W } from '../../world/constants';
import { hashInts } from '../../world/layout';
import type { RoadNetwork } from '../../world/roads';
import { GeoBuilder } from '../geo';
import { manhole, stormDrain } from '../cityArchitecture';
import { tyreMarkTexture } from '../textures';
import type { CityView } from './index';
import { quadLine } from './shared';
import { setGroundAttribute, type GroundRange } from './surfaces';

/** Manhole cover radius as drawn (cityArchitecture.manhole). */
export const MANHOLE_R = 0.48;
/** About one service cover per this many metres of each road segment (at least one per segment). */
const MANHOLE_SPACING = 40;
/** Junctions with a signal get skid marks unless their hash says otherwise (about this share skipped). */
const TYRE_MARK_SKIP = 0.25;
/** Tyre-mark strips: width (m), height above the asphalt (under the paint), and darkest opacity. */
export const TYRE_MARK_W = 0.22;
const TYRE_MARK_Y = 0.006;

const hash = (...xs: number[]): number => hashInts(...xs) >>> 0;

export interface Manhole {
  x: number;
  z: number;
  segment: number;
}

export interface TyreMark {
  node: number;
  /** The strip's centreline points (x, z), each at least TYRE_MARK_W / 2 inside the asphalt. */
  points: Array<{ x: number; z: number }>;
}

/** Where along a segment (from its node at `a0` + CROSSWALK_W to `a1` - CROSSWALK_W) and in which lane the covers go. */
export function manholesOf(roads: RoadNetwork, segment: number): Manhole[] {
  const s = roads.segments[segment]!;
  const line = s.line;
  const a0 = (s.vertical ? s.minZ : s.minX) + CROSSWALK_W;
  const a1 = (s.vertical ? s.maxZ : s.maxX) - CROSSWALK_W;
  const len = a1 - a0;
  if (len < 8) return [];
  const count = Math.max(1, Math.round(len / MANHOLE_SPACING));
  const out: Manhole[] = [];
  for (let k = 0; k < count; k++) {
    const h = hash(s.a, s.b, k + 7);
    // Spread evenly with a deterministic jitter, clear of the stop lines and drains at the ends.
    const t = (k + 0.5) / count + (((h % 1000) / 1000) - 0.5) * (0.5 / count);
    const along = Math.min(a1 - 3, Math.max(a0 + 3, a0 + t * len));
    const lane = line.lanes === 2 ? ((h >> 10) & 1) : 0;
    const side = (h >> 11) & 1 ? 1 : -1;
    const across = line.pos + side * LANE_W * (lane + 0.5);
    out.push(s.vertical ? { x: across, z: along, segment } : { x: along, z: across, segment });
  }
  return out;
}

/**
 * Skid marks at a junction: braking marks in the wheel tracks of some incoming lanes, ending at the stop line, and on
 * some junctions an arc of a hard turn inside the junction box. All lie on asphalt clear of the crosswalk stripes
 * and the lane paint.
 */
export function tyreMarksOf(roads: RoadNetwork, nodeId: number): TyreMark[] {
  const n = roads.nodes[nodeId]!;
  if (!n.signal) return [];
  const h0 = hash(nodeId, 9137);
  if ((h0 % 1000) / 1000 < TYRE_MARK_SKIP) return [];
  const out: TyreMark[] = [];
  for (let d = 0; d < 4; d++) {
    if (n.neighbors[d]! < 0) continue;
    const h = hash(nodeId, d, 433);
    if (h % 3 === 0) continue;
    const vertical = d === 0 || d === 2;
    const sign = d === 0 || d === 3 ? -1 : 1;
    const halfAlong = vertical ? n.halfZ : n.halfX;
    const halfWidth = vertical ? n.halfX : n.halfZ;
    // The lanes arriving from side d are on the half the stop line covers (see buildRoads).
    const inSide = vertical ? (d === 0 ? -1 : 1) : d === 1 ? -1 : 1;
    const lanes = halfWidth > 6.5 ? 2 : 1;
    const lane = lanes === 2 ? (h >> 8) & 1 : 0;
    const centre = inSide * LANE_W * (lane + 0.5);
    const stop = halfAlong + CROSSWALK_W + 0.9;
    const length = 5 + ((h >>> 4) % 9);
    const wobble = (((h >>> 12) % 100) / 100 - 0.5) * 0.5;
    for (const track of [-0.8, 0.8]) {
      const points: Array<{ x: number; z: number }> = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const along = stop + t * length;
        const across = centre + track + wobble * t * t;
        points.push(vertical ? { x: n.x + across, z: n.z + sign * along } : { x: n.x + sign * along, z: n.z + across });
      }
      out.push({ node: nodeId, points });
    }
  }
  // A hard turn's arc inside the junction box, on about half of the marked junctions.
  if ((h0 >> 6) & 1) {
    const r = Math.min(n.halfX, n.halfZ) - 1.6;
    if (r > 1.5) {
      const a0 = (((h0 >>> 8) % 4) * Math.PI) / 2 + 0.3;
      const span = 1.1 + ((h0 >>> 10) % 5) * 0.15;
      for (const dr of [-0.75, 0.75]) {
        const rr = r + dr * 0.5;
        const points: Array<{ x: number; z: number }> = [];
        for (let i = 0; i <= 10; i++) {
          const a = a0 + (span * i) / 10;
          points.push({ x: n.x + Math.cos(a) * rr * (n.halfX / Math.min(n.halfX, n.halfZ)) * 0.999, z: n.z + Math.sin(a) * rr * (n.halfZ / Math.min(n.halfX, n.halfZ)) * 0.999 });
        }
        out.push({ node: nodeId, points });
      }
    }
  }
  return out;
}

/** A strip of quads along a polyline (y up), fading in and out at its ends through vertex alpha. */
function stripGeometry(marks: readonly TyreMark[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (const m of marks) {
    const pts = m.points;
    let v = 0;
    const base = pos.length / 3;
    const strength = 0.55 + (hash(Math.round(pts[0]!.x * 10), Math.round(pts[0]!.z * 10)) % 40) / 100;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[Math.min(i + 1, pts.length - 1)]!;
      const o = pts[Math.max(i - 1, 0)]!;
      let dx = q.x - o.x;
      let dz = q.z - o.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      if (i > 0) v += Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z);
      const t = i / (pts.length - 1);
      const a = strength * Math.min(1, t * 4) * Math.min(1, (1 - t) * 2.5 + 0.25);
      for (const s of [-1, 1]) {
        pos.push(p.x - dz * s * TYRE_MARK_W * 0.5, TYRE_MARK_Y, p.z + dx * s * TYRE_MARK_W * 0.5);
        uv.push(s < 0 ? 0 : 1, v / 2);
        col.push(1, 1, 1, a);
        nrm.push(0, 1, 0);
      }
      if (i > 0) {
        const k = base + i * 2;
        // Counter-clockwise from above whichever way the strip runs: checked per quad.
        const ax = pos[(k - 2) * 3]!;
        const az = pos[(k - 2) * 3 + 2]!;
        const bx = pos[(k - 1) * 3]!;
        const bz = pos[(k - 1) * 3 + 2]!;
        const cx = pos[k * 3]!;
        const cz = pos[k * 3 + 2]!;
        const cross = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        if (cross > 0) idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
        else idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

export function buildRoads(view: CityView): void {
  const roads = view.world.roads;
  const surfaces = view.ground;
  const asphalt = new GeoBuilder(false);
  const asphaltRanges: GroundRange[] = [];
  const gutters = new GeoBuilder(false);
  const ironwork = new GeoBuilder(true);
  const white = new GeoBuilder(false);
  const yellow = new GeoBuilder(false);
  const yM = 0.02;
  const uv = { kind: 'world', scale: surfaces.tile('road') } as const;
  for (const n of roads.live) asphalt.flat(n.x - n.halfX, n.z - n.halfZ, n.x + n.halfX, n.z + n.halfZ, 0, uv);
  roads.segments.forEach((s, si) => {
    const start = asphalt.vertexCount;
    asphalt.flat(s.minX, s.minZ, s.maxX, s.maxZ, 0, uv);
    const line = s.line;
    const c = line.pos;
    const lo = s.vertical ? s.minZ : s.minX;
    const hi = s.vertical ? s.maxZ : s.maxX;
    // Lane wear needs the distance across from the centre line, along from either end and the half width.
    asphaltRanges.push({
      start,
      end: asphalt.vertexCount,
      fill: (x, _y, z, out) => {
        const along = s.vertical ? z : x;
        out[0] = (s.vertical ? x : z) - c;
        out[1] = along - lo;
        out[2] = hi - along;
        out[3] = line.width / 2;
      },
    });
    // Markings run between the crosswalk bands.
    const a0 = (s.vertical ? s.minZ : s.minX) + CROSSWALK_W;
    const a1 = (s.vertical ? s.maxZ : s.maxX) - CROSSWALK_W;
    const L = (a: number, o: number) => (s.vertical ? { x: c + o, z: a } : { x: a, z: c + o });
    // Narrow concrete gutters make the asphalt meet the raised pavement cleanly.
    // Grates and service covers are flush finishes, below all road paint.
    for (const side of [-1, 1]) {
      const off = side * (line.width / 2 - 0.15);
      const startP = L(s.vertical ? s.minZ : s.minX, off);
      const endP = L(s.vertical ? s.maxZ : s.maxX, off);
      quadLine(gutters, startP.x, startP.z, endP.x, endP.z, 0.3, 0.004);
      for (const along of [a0 + 1.5, a1 - 1.5]) {
        const drain = L(along, side * (line.width / 2 - 0.22));
        stormDrain(ironwork, drain.x, drain.z, s.vertical);
      }
    }
    for (const m of manholesOf(roads, si)) {
      manhole(ironwork, m.x, m.z);
      surfaces.manholes.push(m);
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
  });
  // Stop lines and zebra crossings.
  const marks: TyreMark[] = [];
  roads.nodes.forEach((n, ni) => {
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
    marks.push(...tyreMarksOf(roads, ni));
  });
  surfaces.tyreMarks.push(...marks);
  const wet = view.wet;
  const roadMat = surfaces.patch(wet.patch(surfaces.material('road')), 'road');
  view.add(setGroundAttribute(asphalt.build(), asphaltRanges), roadMat, { name: 'roads' });
  view.add(setGroundAttribute(gutters.build(), []), surfaces.patch(wet.patch(surfaces.material('curb')), 'curb'), { name: 'road-gutters' });
  view.add(ironwork.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.15 }), { name: 'street-ironwork' });
  const mk = (color: number) => wet.patch(new THREE.MeshStandardMaterial({ color, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  view.add(white.build(), mk(0xe6e6e0), { name: 'markings-white' });
  view.add(yellow.build(), mk(0xe8b923), { name: 'markings-yellow' });
  if (marks.length > 0) {
    // Rubber laid on the asphalt: a dark, slightly glossy film that the rain wets like the road under it.
    const tyreMat = wet.patch(
      new THREE.MeshStandardMaterial({
        color: 0x0c0c0d,
        map: tyreMarkTexture(),
        vertexColors: true,
        roughness: 0.62,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    tyreMat.name = 'tyre-marks';
    view.add(stripGeometry(marks), tyreMat, { name: 'road-decals' });
  }
}
