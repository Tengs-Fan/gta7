// Las Lomas County's roads: asphalt ribbons along each road's centre line, mitred at its bends, a pad on every
// junction, and the links' mouths through the promenade (the causeway's and the highway's ribbons run on to the
// gateways' boxes); white edge lines, the highway's dashed lane lines, a dashed yellow centre line (a double solid one
// round the highway's bends) and stop lines at the signals. Flush with the ground, so the paint sits just over the asphalt
// and the asphalt just over the grass. A few thousand triangles in all: one mesh each, as the city's roads and paint.

import * as THREE from 'three';
import { CROSSWALK_W, LANE_W } from '../../world/constants';
import type { RoadNode } from '../../world/roads';
import { quadLine } from '../city/shared';
import { setGroundAttribute, type GroundRange } from '../city/surfaces';
import { GeoBuilder } from '../geo';
import { COUNTRY_CELL } from '../quality';
import type { CountryView } from './index';

/** Heights (m) of the asphalt and the paint over the flush ground. */
const ASPHALT_Y = 0.012;
const PAINT_Y = 0.024;
/** A dashed line's dash and gap (m). */
const DASH = 3;
const GAP = 6;

interface Vertex {
  x: number;
  z: number;
  /** The unit right normal of the line through it, lengthened to keep the width at a mitred bend. */
  rx: number;
  rz: number;
  /** Distance along the road from the run's first vertex. */
  s: number;
  /** The radius of the curve the stretch after it lies on. */
  radius: number;
}

export function buildCountryRoads(view: CountryView): void {
  const roads = view.world.roads;
  const surfaces = view.city.ground;
  const asphalt = new GeoBuilder(false);
  const ranges: GroundRange[] = [];
  const white = new GeoBuilder(false);
  const yellow = new GeoBuilder(false);
  const uv = { kind: 'world', scale: surfaces.tile('road') } as const;
  const outer = (n: RoadNode) => n.i < 0;
  for (const { road, nodes } of roads.outerRoads) {
    const half = road.width / 2;
    // The road in runs between its junctions (and gateways), each a chain of straight stretches through bends.
    let run: RoadNode[] = [roads.nodes[nodes[0]!]!];
    const runs: RoadNode[][] = [];
    for (let k = 1; k < nodes.length; k++) {
      const n = roads.nodes[nodes[k]!]!;
      run.push(n);
      if (!roads.isBend(n)) {
        runs.push(run);
        run = [n];
      }
    }
    for (const r of runs) {
      const pts = runVertices(r, road.radii.slice(nodes.indexOf(r[0]!.id)), roads.isBend.bind(roads));
      const first = r[0]!;
      const last = r[r.length - 1]!;
      // Start and end at a junction's box: a county junction's pad, a gateway's own box in the city.
      const box = (n: RoadNode, dx: number, dz: number) => (outer(n) || Math.abs(dx) > Math.abs(dz) ? n.halfX : n.halfZ);
      const s0 = box(first, pts[1]!.x - pts[0]!.x, pts[1]!.z - pts[0]!.z);
      const total = pts[pts.length - 1]!.s;
      const s1 = total - box(last, pts[pts.length - 1]!.x - pts[pts.length - 2]!.x, pts[pts.length - 1]!.z - pts[pts.length - 2]!.z);
      ribbon(asphalt, ranges, pts, s0, s1, -half, half, ASPHALT_Y, uv);
      for (const o of [-(half - 0.35), half - 0.35]) line(white, pts, s0, s1, o, 0.1, false);
      const centre = s0 + CROSSWALK_W;
      const stop = s1 - CROSSWALK_W;
      if (road.lanes === 2) {
        for (const o of [-LANE_W, LANE_W]) line(white, pts, centre, stop, o, 0.1, true);
        // Double solid round the bends, dashed along the straights.
        for (const o of [-0.18, 0.18]) line(yellow, pts, centre, stop, o, 0.12, false, (v) => v.radius < Infinity);
        line(yellow, pts, centre, stop, 0, 0.13, true, (v) => v.radius === Infinity);
      } else {
        line(yellow, pts, centre, stop, 0, 0.13, true);
      }
      // Stop lines at a county junction's signal, across the half coming in.
      if (last.signal && outer(last)) line(white, pts, stop - 0.3, stop + 0.15, half / 2 + 0.05, half - 0.25, false, undefined, true);
      if (first.signal && outer(first)) line(white, pts, centre - 0.15, centre + 0.3, -(half / 2 + 0.05), half - 0.25, false, undefined, true);
    }
  }
  // A pad on every county junction.
  for (const n of roads.nodes.slice(roads.gridNodeCount)) if (!roads.isBend(n)) asphalt.flat(n.x - n.halfX, n.z - n.halfZ, n.x + n.halfX, n.z + n.halfZ, ASPHALT_Y, uv);
  const roadMat = surfaces.patch(view.city.wet.patch(surfaces.material('road')), 'road');
  roadMat.polygonOffset = true;
  roadMat.polygonOffsetFactor = -1;
  roadMat.polygonOffsetUnits = -1;
  view.add(setGroundAttribute(asphalt.build(), ranges), roadMat, { name: 'country-roads', split: false });
  const paint = (color: number) => view.city.wet.patch(new THREE.MeshStandardMaterial({ color, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  view.add(white.build(), paint(0xe6e6e0), { name: 'country-markings-white', split: false });
  view.add(yellow.build(), paint(0xe8b923), { name: 'country-markings-yellow', split: false });
}

/** A run's vertices with their mitred right normals and distances along it; `radii` from the run's first stretch on. */
function runVertices(run: RoadNode[], radii: number[], isBend: (n: RoadNode) => boolean): Vertex[] {
  const out: Vertex[] = [];
  let s = 0;
  for (let k = 0; k < run.length; k++) {
    const n = run[k]!;
    const prev = run[k - 1];
    const next = run[k + 1];
    const dir = (p: RoadNode, q: RoadNode) => {
      const l = Math.hypot(q.x - p.x, q.z - p.z);
      return { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
    };
    const din = prev ? dir(prev, n) : dir(n, next!);
    const dout = next && isBend(n) ? dir(n, next) : din;
    const ux = din.x + dout.x;
    const uz = din.z + dout.z;
    const l = Math.hypot(ux, uz);
    // The mitre: the mean direction's normal, longer by 1 / cos(half the turn).
    const stretch = 1 / Math.sqrt((din.x * dout.x + din.z * dout.z + 1) / 2);
    if (prev) s += Math.hypot(n.x - prev.x, n.z - prev.z);
    out.push({ x: n.x, z: n.z, rx: (-uz / l) * stretch, rz: (ux / l) * stretch, s, radius: radii[k] ?? Infinity });
  }
  return out;
}

/** The point `s` along the run, offset `o` to its right (mitred at the vertices, straight between them). */
function at(pts: Vertex[], s: number, o: number): { x: number; z: number; k: number } {
  let k = 0;
  while (k < pts.length - 2 && pts[k + 1]!.s < s) k++;
  const a = pts[k]!;
  const b = pts[k + 1]!;
  const t = (s - a.s) / (b.s - a.s);
  return { x: a.x + (b.x - a.x) * t + (a.rx + (b.rx - a.rx) * t) * o, z: a.z + (b.z - a.z) * t + (a.rz + (b.rz - a.rz) * t) * o, k };
}

/**
 * The run's surface from s0 to s1 between offsets o0 and o1 (to its right), a quad per stretch and per CountryView
 * cell it crosses, with lane wear.
 */
function ribbon(g: GeoBuilder, ranges: GroundRange[], pts: Vertex[], s0: number, s1: number, o0: number, o1: number, y: number, uv: { kind: 'world'; scale: number }): void {
  const cuts = [s0, s1, ...pts.map((p) => p.s).filter((s) => s > s0 && s < s1)];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!;
    const b = pts[k]!;
    for (const [p, q] of [[a.x, b.x], [a.z, b.z]] as const) {
      for (let c = Math.ceil(Math.min(p, q) / COUNTRY_CELL) * COUNTRY_CELL; c < Math.max(p, q); c += COUNTRY_CELL) {
        const s = a.s + ((b.s - a.s) * (c - p)) / (q - p);
        if (s > s0 && s < s1) cuts.push(s);
      }
    }
  }
  cuts.sort((p, q) => p - q);
  const half = (o1 - o0) / 2;
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1]!;
    const b = cuts[i]!;
    const al = at(pts, a, o0);
    const ar = at(pts, a, o1);
    const bl = at(pts, b, o0);
    const br = at(pts, b, o1);
    const s = 1 / uv.scale;
    const start = g.vertexCount;
    g.quad(ar.x, y, ar.z, br.x, y, br.z, bl.x, y, bl.z, al.x, y, al.z, [ar.x * s, -ar.z * s, br.x * s, -br.z * s, bl.x * s, -bl.z * s, al.x * s, -al.z * s]);
    // Lane wear: across from the centre line, along from either end of the run, and the half width.
    const across = [half, half, -half, -half];
    const along = [a, b, b, a];
    let v = 0;
    ranges.push({
      start,
      end: g.vertexCount,
      fill: (_x, _y, _z, out) => {
        out[0] = across[v]!;
        out[1] = along[v]! - s0;
        out[2] = s1 - along[v]!;
        out[3] = half;
        v++;
      },
    });
  }
}

/**
 * A line of paint `width` m wide `o` m right of the run's centre line from s0 to s1 (dashed, or only along the stretches
 * `where` holds); `across` turns it into a bar across the road from offset o - width / 2 to o + width / 2, s0 to s1 deep.
 */
function line(g: GeoBuilder, pts: Vertex[], s0: number, s1: number, o: number, width: number, dashed: boolean, where?: (v: Vertex) => boolean, across = false): void {
  if (across) {
    const half = width / 2;
    const p = at(pts, (s0 + s1) / 2, o - half);
    const q = at(pts, (s0 + s1) / 2, o + half);
    quadLine(g, p.x, p.z, q.x, q.z, s1 - s0, PAINT_Y);
    return;
  }
  const step = dashed ? DASH + GAP : 2;
  for (let s = s0; s < s1 - 0.01; s += step) {
    const e = Math.min(s1, s + (dashed ? DASH : step));
    const p = at(pts, s, o);
    if (where && !where(pts[p.k]!)) continue;
    const q = at(pts, e, o);
    quadLine(g, p.x, p.z, q.x, q.z, width, PAINT_Y);
  }
}
