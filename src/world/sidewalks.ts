// Pedestrian navigation graph: a walking loop around every block, an outer
// loop along the promenade (broken where the sea comes in), crosswalk edges at
// every intersection, and the path out along Azura Point. Las Lomas County's
// verges and footpaths come after all of these, apart from them.

import type { Rng } from '../core/rng';
import { PED_INSET, WATER_Y } from './constants';
import { countryGround } from './country';
import { headlandAt, rectContains, rectCX, waterAt, type CityLayout } from './layout';
import type { Axis, RoadNetwork } from './roads';

/** The county's verges: a footpath this far (m) outside the road's edge, a node at least every VERGE_STEP m. */
const VERGE_OUT = 1.5;
const VERGE_STEP = 30;

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
  /** Las Lomas County's: its footpaths' edges pedestrians spawn on there (the verges are not among them). */
  readonly countyWalkEdges: Array<[number, number]> = [];
  private readonly county: CityLayout['country'];

  constructor(layout: CityLayout, roads: RoadNetwork) {
    this.county = layout.country;
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
    for (const [x, z] of [[west, north], [east, north], [east, south], [west, south]] as const) if (!waterAt(layout, x, z)) this.addNode(x, z);
    // The path out to the lighthouse leaves the promenade loop here.
    const point = layout.headlands.find((h) => h.name === 'Azura Point');
    const pointX = point ? rectCX(point.rects[1]!) : 0;
    const pointFoot = point ? this.addNode(pointX, north) : -1;

    for (const node of roads.gridNodes) {
      for (let d = 0; d < 4; d++) {
        // A gateway's arm out to the county crosses the promenade, not a sidewalk: its crosswalk is the promenade's edge (below).
        if (node.neighbors[d]! < 0 || node.neighbors[d]! >= roads.gridNodeCount) continue;
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
      // A junction over the water is a bridge: its footways join the sidewalks either side of it.
      if (node.degree > 0 && waterAt(layout, node.x, node.z)) {
        for (const z of [node.z - node.halfZ - I, node.z + node.halfZ + I]) this.link(this.addNode(node.x - node.halfX - I, z), this.addNode(node.x + node.halfX + I, z));
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
      for (let i = 1; i < list.length; i++) if (!this.crossesWater(layout, list[i - 1]!, list[i]!)) this.link(list[i - 1]!.id, list[i]!.id);
    }
    // Where a gateway's arm leaves for the county, the promenade's edge across its mouth becomes the crosswalk, obeying
    // the junction's light, and keeps its place among the walking edges.
    for (const node of roads.gridNodes) {
      if (!node.neighbors.some((nb) => nb >= roads.gridNodeCount)) continue;
      const a = this.addNode(node.x - node.halfX - I, node.z - node.halfZ - I);
      const c = this.addNode(node.x - node.halfX - I, node.z + node.halfZ + I);
      for (const e of [this.edge(a, c)!, this.edge(c, a)!]) {
        e.crosswalk = true;
        e.axis = 'EW';
        e.roadNode = node.id;
      }
    }
    if (point) {
      const tip = point.rects[1]!;
      const neck = this.addNode(pointX, b.landMinZ);
      const end = this.addNode(pointX, tip.minZ + 24);
      this.link(pointFoot, neck);
      this.link(neck, end);
    }
    this.buildCounty(layout, roads);
  }

  /**
   * Las Lomas County, after every older node and edge: a verge along one side of each road (the right of its centre
   * line, VERGE_OUT m off the edge), broken where the road is over water or on the city's land, its pieces joined round
   * each junction, none of it to spawn on and none touching the city's graph; then the content passes' footpaths.
   */
  private buildCounty(layout: CityLayout, roads: RoadNetwork): void {
    const b = layout.bounds;
    const country = layout.country;
    const ground = (x: number, z: number) => x < b.landMinX && (!!headlandAt(layout, x, z) || countryGround(country, x, z) > WATER_Y);
    const ends = new Map<number, number[]>();
    for (const { road, nodes } of roads.outerRoads) {
      const side = road.width / 2 + VERGE_OUT;
      const pts: Array<{ x: number; z: number; junction: number }> = [];
      for (let k = 0; k < nodes.length; k++) {
        const node = roads.nodes[nodes[k]!]!;
        const prev = roads.nodes[nodes[k - 1] ?? -1];
        const next = roads.nodes[nodes[k + 1] ?? -1];
        // Each stretch's direction, and the right of the line through the node (their mean at a bend).
        const dir = (p: { x: number; z: number }, q: { x: number; z: number }) => {
          const l = Math.hypot(q.x - p.x, q.z - p.z);
          return { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
        };
        const din = prev ? dir(prev, node) : null;
        const dout = next ? dir(node, next) : null;
        if (roads.isBend(node)) {
          const ux = din!.x + dout!.x;
          const uz = din!.z + dout!.z;
          const l = Math.hypot(ux, uz);
          const cos = (din!.x * dout!.x + din!.z * dout!.z + 1) / 2;
          // Mitred: the offset grows as the line turns, so both stretches' verges keep their distance.
          const out = side / Math.sqrt(cos);
          pts.push({ x: node.x - (uz / l) * out, z: node.z + (ux / l) * out, junction: -1 });
          continue;
        }
        // A junction (or a road's end at one): the verge stops at the corner past its box, either side of it.
        const along = node.halfX + VERGE_OUT;
        if (din) pts.push({ x: node.x - din.x * along - din.z * side, z: node.z - din.z * along + din.x * side, junction: node.id });
        if (dout) pts.push({ x: node.x + dout.x * along - dout.z * side, z: node.z + dout.z * along + dout.x * side, junction: node.id });
      }
      let last = -1;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k]!;
        const q = pts[k - 1];
        // From one corner of a junction to the next is across a road: a new piece starts.
        const across = !q || (q.junction >= 0 && q.junction === p.junction);
        if (across) last = -1;
        const steps = across ? 1 : Math.ceil(Math.hypot(p.x - q.x, p.z - q.z) / VERGE_STEP);
        for (let s = 1; s <= steps; s++) {
          const x = across ? p.x : q.x + ((p.x - q.x) * s) / steps;
          const z = across ? p.z : q.z + ((p.z - q.z) * s) / steps;
          if (!ground(x, z)) {
            last = -1;
            continue;
          }
          const id = this.addNode(x, z);
          if (last >= 0) this.link(last, id, false, null, -1, null);
          last = id;
        }
        if (p.junction >= 0 && last >= 0 && roads.nodes[p.junction]!.i < 0) {
          const list = ends.get(p.junction) ?? [];
          list.push(last);
          ends.set(p.junction, list);
        }
      }
    }
    // Round each junction, its verges' ends in turn by their bearing from it, but for the longest step (across the box);
    // a step over one of its roads is a crosswalk on its light.
    for (const [junction, list] of ends) {
      const j = roads.nodes[junction]!;
      const ring = [...new Set(list)].sort((p, q) => Math.atan2(this.nodes[p]!.z - j.z, this.nodes[p]!.x - j.x) - Math.atan2(this.nodes[q]!.z - j.z, this.nodes[q]!.x - j.x));
      if (ring.length < 2) continue;
      const steps = ring.map((id, k) => [this.nodes[id]!, this.nodes[ring[(k + 1) % ring.length]!]!] as const);
      const len = (s: (typeof steps)[number]) => Math.hypot(s[1].x - s[0].x, s[1].z - s[0].z);
      const longest = steps.reduce((m, s) => (len(s) > len(m) ? s : m));
      for (const s of steps) {
        if (s === longest && ring.length > 2) continue;
        const [p, q] = s;
        if (roads.isOnRoad((p.x + q.x) / 2, (p.z + q.z) / 2)) this.link(p.id, q.id, true, Math.abs(q.x - p.x) > Math.abs(q.z - p.z) ? 'NS' : 'EW', junction);
        else this.link(p.id, q.id, false, null, -1, null);
      }
    }
    for (const w of country.walks) this.link(this.addNode(w.ax, w.az), this.addNode(w.bx, w.bz), false, null, -1, w.spawn ? this.countyWalkEdges : null);
  }

  /** Whether a straight walk from a to b would step into the sea (a bridge's footway keeps it dry). */
  private crossesWater(layout: CityLayout, a: WalkNode, b: WalkNode): boolean {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2);
    for (let k = 0; k <= steps; k++) {
      const x = a.x + ((b.x - a.x) * k) / steps;
      const z = a.z + ((b.z - a.z) * k) / steps;
      if (waterAt(layout, x, z) && !layout.decks.some((d) => rectContains(d.rect, x, z))) return true;
    }
    return false;
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

  /** Joins a and b once. A walking edge goes to `spawn`, the city's walking edges unless another list or none is given. */
  private link(a: number, b: number, crosswalk = false, axis: Axis | null = null, roadNode = -1, spawn: Array<[number, number]> | null = this.walkEdges): void {
    if (a === b) return;
    const na = this.nodes[a]!;
    const nb = this.nodes[b]!;
    if (na.edges.some((e) => e.to === b)) return;
    const length = Math.hypot(nb.x - na.x, nb.z - na.z);
    na.edges.push({ to: b, length, crosswalk, axis, roadNode });
    nb.edges.push({ to: a, length, crosswalk, axis, roadNode });
    if (!crosswalk && spawn) spawn.push([a, b]);
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

  /**
   * Random point on a walking edge whose distance to (px, pz) is within [minD, maxD]: the city's, or round Las Lomas
   * County its own (none there, none drawn, while it has no footpath to spawn on).
   */
  randomPointNear(rng: Rng, px: number, pz: number, minD: number, maxD: number): { a: number; b: number; t: number; x: number; z: number } | null {
    const pool = rectContains(this.county.bounds, px, pz) ? this.countyWalkEdges : this.walkEdges;
    if (pool.length === 0) return null;
    for (let tries = 0; tries < 40; tries++) {
      const [a, b] = rng.pick(pool);
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
    for (let i = 0; i < pool.length; i++) {
      const [a, b] = pool[i]!;
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
      const [a, b] = pool[pieces[k]!]!;
      const na = this.nodes[a]!;
      const nb = this.nodes[b]!;
      const t = (s0 + Math.min(u, span)) / Math.hypot(nb.x - na.x, nb.z - na.z);
      return { a, b, t, x: na.x + (nb.x - na.x) * t, z: na.z + (nb.z - na.z) * t };
    }
    return null;
  }
}
