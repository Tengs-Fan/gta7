// Pedestrian navigation graph: a walking loop around every block, an outer
// loop along the promenade, and crosswalk edges at every intersection.

import type { Rng } from '../core/rng';
import { PED_INSET } from './constants';
import type { CityLayout } from './layout';
import type { Axis, RoadNetwork } from './roads';

export interface WalkEdge {
  to: number;
  length: number;
  crosswalk: boolean;
  /** Traffic axis of the road being crossed (crosswalks only). */
  axis: Axis | null;
  /** Road node whose signal controls this crosswalk, or -1. */
  roadNode: number;
}

export interface WalkNode {
  id: number;
  x: number;
  z: number;
  edges: WalkEdge[];
}

export class SidewalkGraph {
  readonly nodes: WalkNode[] = [];
  private readonly keys = new Map<string, number>();
  /** Non-crosswalk edges as [a, b] pairs, used for spawning. */
  readonly walkEdges: Array<[number, number]> = [];

  constructor(layout: CityLayout, roads: RoadNetwork) {
    const I = PED_INSET;
    for (const block of layout.blocks) {
      const r = block.rect;
      const nw = this.addNode(r.minX + I, r.minZ + I);
      const ne = this.addNode(r.maxX - I, r.minZ + I);
      const se = this.addNode(r.maxX - I, r.maxZ - I);
      const sw = this.addNode(r.minX + I, r.maxZ - I);
      this.link(nw, ne);
      this.link(ne, se);
      this.link(se, sw);
      this.link(sw, nw);
    }

    const b = layout.bounds;
    const west = b.cityMinX - I;
    const east = b.cityMaxX + I;
    const north = b.cityMinZ - I;
    const south = b.cityMaxZ + I;
    this.addNode(west, north);
    this.addNode(east, north);
    this.addNode(east, south);
    this.addNode(west, south);

    for (const node of roads.nodes) {
      for (let d = 0; d < 4; d++) {
        if (node.neighbors[d]! < 0) continue;
        let ax: number;
        let az: number;
        let bx: number;
        let bz: number;
        let axis: Axis;
        if (d === 0 || d === 2) {
          const z = d === 0 ? node.z - node.halfZ - I : node.z + node.halfZ + I;
          ax = node.x - node.halfX - I;
          bx = node.x + node.halfX + I;
          az = z;
          bz = z;
          axis = 'NS';
        } else {
          const x = d === 1 ? node.x + node.halfX + I : node.x - node.halfX - I;
          az = node.z - node.halfZ - I;
          bz = node.z + node.halfZ + I;
          ax = x;
          bx = x;
          axis = 'EW';
        }
        const a = this.addNode(ax, az);
        const c = this.addNode(bx, bz);
        this.link(a, c, true, axis, node.id);
      }
    }

    // Connect consecutive nodes along the four promenade lines.
    const eps = 0.05;
    const lines: Array<{ pick: (n: WalkNode) => boolean; key: (n: WalkNode) => number }> = [
      { pick: (n) => Math.abs(n.x - west) < eps, key: (n) => n.z },
      { pick: (n) => Math.abs(n.x - east) < eps, key: (n) => n.z },
      { pick: (n) => Math.abs(n.z - north) < eps, key: (n) => n.x },
      { pick: (n) => Math.abs(n.z - south) < eps, key: (n) => n.x },
    ];
    for (const line of lines) {
      const list = this.nodes.filter(line.pick).sort((p, q) => line.key(p) - line.key(q));
      for (let i = 1; i < list.length; i++) this.link(list[i - 1]!.id, list[i]!.id);
    }
  }

  private addNode(x: number, z: number): number {
    const key = `${Math.round(x * 10)},${Math.round(z * 10)}`;
    const existing = this.keys.get(key);
    if (existing !== undefined) return existing;
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, edges: [] });
    this.keys.set(key, id);
    return id;
  }

  private link(a: number, b: number, crosswalk = false, axis: Axis | null = null, roadNode = -1): void {
    if (a === b) return;
    const na = this.nodes[a]!;
    const nb = this.nodes[b]!;
    if (na.edges.some((e) => e.to === b)) return;
    const length = Math.hypot(nb.x - na.x, nb.z - na.z);
    na.edges.push({ to: b, length, crosswalk, axis, roadNode });
    nb.edges.push({ to: a, length, crosswalk, axis, roadNode });
    if (!crosswalk) this.walkEdges.push([a, b]);
  }

  edge(a: number, b: number): WalkEdge | null {
    return this.nodes[a]?.edges.find((e) => e.to === b) ?? null;
  }

  nearestNode(x: number, z: number): number {
    let best = 0;
    let bd = Infinity;
    for (const n of this.nodes) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = n.id;
      }
    }
    return best;
  }

  /** Random point on a walking edge whose distance to (px, pz) is within [minD, maxD]. */
  randomPointNear(rng: Rng, px: number, pz: number, minD: number, maxD: number): { a: number; b: number; t: number; x: number; z: number } | null {
    for (let tries = 0; tries < 40; tries++) {
      const [a, b] = rng.pick(this.walkEdges);
      const na = this.nodes[a]!;
      const nb = this.nodes[b]!;
      const t = rng.next();
      const x = na.x + (nb.x - na.x) * t;
      const z = na.z + (nb.z - na.z) * t;
      const d = Math.hypot(x - px, z - pz);
      if (d >= minD && d <= maxD) return { a, b, t, x, z };
    }
    // Fallback: pick uniformly (by length) from the exact parts of every walking edge inside the band.
    // On one edge those are up to two pieces either side of the point closest to (px, pz).
    const pieces: number[] = []; // edge index, start, end (metres along the edge)
    let total = 0;
    const addPiece = (edge: number, s0: number, s1: number) => {
      if (s1 <= s0) return;
      pieces.push(edge, s0, s1);
      total += s1 - s0;
    };
    for (let i = 0; i < this.walkEdges.length; i++) {
      const [a, b] = this.walkEdges[i]!;
      const na = this.nodes[a]!;
      const nb = this.nodes[b]!;
      const len = Math.hypot(nb.x - na.x, nb.z - na.z);
      if (len < 1e-9) continue;
      const along = ((px - na.x) * (nb.x - na.x) + (pz - na.z) * (nb.z - na.z)) / len;
      const off2 = Math.max(0, (px - na.x) ** 2 + (pz - na.z) ** 2 - along * along);
      if (off2 > maxD * maxD) continue;
      const outer = Math.sqrt(maxD * maxD - off2);
      const inner = Math.sqrt(Math.max(0, minD * minD - off2));
      addPiece(i, Math.max(0, along - outer), Math.min(len, along - inner));
      addPiece(i, Math.max(0, along + inner), Math.min(len, along + outer));
    }
    if (total <= 0) return null;
    let u = rng.next() * total;
    for (let k = 0; k < pieces.length; k += 3) {
      const s0 = pieces[k + 1]!;
      const span = pieces[k + 2]! - s0;
      if (u > span && k + 3 < pieces.length) {
        u -= span;
        continue;
      }
      const [a, b] = this.walkEdges[pieces[k]!]!;
      const na = this.nodes[a]!;
      const nb = this.nodes[b]!;
      const t = (s0 + Math.min(u, span)) / Math.hypot(nb.x - na.x, nb.z - na.z);
      return { a, b, t, x: na.x + (nb.x - na.x) * t, z: na.z + (nb.z - na.z) * t };
    }
    return null;
  }
}
