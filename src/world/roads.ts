// Directed lane graph built on top of the road grid: lanes, turn curves through
// intersections, traffic signal phases and A* routing between intersections.
// Las Lomas County's roads (world/country) follow the grid's nodes, lanes and turns, which keep their ids: chains of
// straight lanes through bend nodes, joined to the grid at two gateways (docs/map.md).

import { Rng } from '../core/rng';
import { CROSSWALK_W, LANE_W } from './constants';
import { COUNTRY_SPEED, laneEnd, slotOf, type CountryGraph, type CountryRoad, type CountyJunction } from './country';
import { DIR_VECTORS, hashInts, mkRect, rectContains, roadFrom, type CityLayout, type Rect, type RoadLine } from './layout';

export type Dir = 0 | 1 | 2 | 3; // N E S W
export type Axis = 'NS' | 'EW';
export type TurnKind = 'straight' | 'left' | 'right';
export type SignalState = 'green' | 'yellow' | 'red';

export const SIGNAL_GREEN = 11;
export const SIGNAL_YELLOW = 3;
export const SIGNAL_ALL_RED = 2;
export const SIGNAL_HALF = SIGNAL_GREEN + SIGNAL_YELLOW + SIGNAL_ALL_RED;
export const SIGNAL_CYCLE = SIGNAL_HALF * 2;

/** The county's signal offsets draw from their own generator, never the grid's. */
const OUTER_SALT = 0x1a5;
/** How near a gateway (m) a point in the city may find a county lane its nearest. */
const GATEWAY_REACH = 40;

export function axisOf(dir: Dir): Axis {
  return dir === 0 || dir === 2 ? 'NS' : 'EW';
}

export function reverseDir(dir: Dir): Dir {
  return ((dir + 2) % 4) as Dir;
}

export interface RoadNode {
  id: number;
  i: number;
  j: number;
  x: number;
  z: number;
  /** Half extents of the intersection box. */
  halfX: number;
  halfZ: number;
  neighbors: [number, number, number, number];
  degree: number;
  signal: boolean;
  offset: number;
}

export interface Turn {
  kind: TurnKind;
  from: Lane;
  to: Lane;
  /** Polyline from the end of `from` to the start of `to` as x,z pairs. */
  pts: Float64Array;
  length: number;
  /** Respects lane discipline (inner lane turns left, outer lane turns right). */
  legal: boolean;
}

export interface Lane {
  id: number;
  from: number;
  to: number;
  dir: Dir;
  index: number;
  lanesInDir: number;
  line: RoadLine;
  sx: number;
  sz: number;
  ex: number;
  ez: number;
  dx: number;
  dz: number;
  length: number;
  heading: number;
  turns: Turn[];
  speedLimit: number;
}

export interface RoadSegment {
  a: number;
  b: number;
  vertical: boolean;
  line: RoadLine;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export class RoadNetwork {
  /** Every junction of the grid by id (j * (n + 1) + i); one with no road left (degree 0) is dead. */
  readonly nodes: RoadNode[] = [];
  /** The junctions some road reaches. */
  readonly live: RoadNode[] = [];
  readonly lanes: Lane[] = [];
  readonly segments: RoadSegment[] = [];
  private readonly lanesByEdge = new Map<number, Lane[]>();
  /** distanceField() results by goal node. */
  private readonly fields = new Map<number, Float64Array>();
  /** Junctions held green along one axis (see holdSignal). */
  private readonly holds = new Map<number, Axis>();
  private readonly n: number;
  /** The grid's nodes and lanes, ids 0 to gridNodeCount - 1 and gridLaneCount - 1; the county's come after them. */
  readonly gridNodeCount: number;
  readonly gridLaneCount: number;
  readonly gridNodes: readonly RoadNode[];
  readonly gridLanes: readonly Lane[];
  /** Las Lomas County's roads, each with its nodes in order along it (grid ids at the gateways), for the renderers. */
  readonly outerRoads: ReadonlyArray<{ road: CountryRoad; nodes: readonly number[] }>;
  private readonly outerLanes: readonly Lane[];
  private readonly junctions: Readonly<Record<CountyJunction, number>>;
  /** The grid junctions the county's roads leave from, and the links' mouths through the promenade beside them. */
  private readonly gateways: readonly RoadNode[];
  private readonly mouths: readonly Rect[];
  /** The county's road surface: each stretch as its centre line and half width, each junction's box as a disc. */
  private readonly outerSurface: { segs: Float64Array; discs: Float64Array; bounds: Rect };

  constructor(readonly layout: CityLayout) {
    const { vLines, hLines } = layout;
    this.n = layout.n;
    const n = this.n;
    const rng = new Rng((layout.seed * 31337) >>> 0);

    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const neighbors: [number, number, number, number] = [
          roadFrom(layout, i, j, 0) ? this.id(i, j - 1) : -1,
          roadFrom(layout, i, j, 1) ? this.id(i + 1, j) : -1,
          roadFrom(layout, i, j, 2) ? this.id(i, j + 1) : -1,
          roadFrom(layout, i, j, 3) ? this.id(i - 1, j) : -1,
        ];
        const degree = neighbors.filter((v) => v >= 0).length;
        this.nodes.push({
          id: this.id(i, j),
          i,
          j,
          x: vLines[i]!.pos,
          z: hLines[j]!.pos,
          halfX: vLines[i]!.width / 2,
          halfZ: hLines[j]!.width / 2,
          neighbors,
          degree,
          signal: degree >= 3,
          offset: rng.range(0, SIGNAL_CYCLE),
        });
      }
    }
    for (const node of this.nodes) if (node.degree > 0) this.live.push(node);

    // Segments (undirected) and lanes (directed).
    for (const a of this.nodes) {
      for (let d = 0; d < 4; d++) {
        const bId = a.neighbors[d]!;
        if (bId < 0) continue;
        const b = this.nodes[bId]!;
        const dir = d as Dir;
        const vertical = dir === 0 || dir === 2;
        const line = vertical ? vLines[a.i]! : hLines[a.j]!;
        if (dir === 1 || dir === 2) {
          // Record each undirected segment once.
          if (vertical) {
            this.segments.push({ a: a.id, b: b.id, vertical, line, minX: line.pos - line.width / 2, maxX: line.pos + line.width / 2, minZ: a.z + a.halfZ, maxZ: b.z - b.halfZ });
          } else {
            this.segments.push({ a: a.id, b: b.id, vertical, line, minX: a.x + a.halfX, maxX: b.x - b.halfX, minZ: line.pos - line.width / 2, maxZ: line.pos + line.width / 2 });
          }
        }
        const u = DIR_VECTORS[dir]!;
        const rx = -u.z;
        const rz = u.x;
        const halfA = vertical ? a.halfZ : a.halfX;
        const halfB = vertical ? b.halfZ : b.halfX;
        const list: Lane[] = [];
        for (let k = 0; k < line.lanes; k++) {
          const off = LANE_W * (k + 0.5);
          const sx = a.x + u.x * (halfA + CROSSWALK_W) + rx * off;
          const sz = a.z + u.z * (halfA + CROSSWALK_W) + rz * off;
          const ex = b.x - u.x * (halfB + CROSSWALK_W) + rx * off;
          const ez = b.z - u.z * (halfB + CROSSWALK_W) + rz * off;
          const lane: Lane = {
            id: this.lanes.length,
            from: a.id,
            to: b.id,
            dir,
            index: k,
            lanesInDir: line.lanes,
            line,
            sx,
            sz,
            ex,
            ez,
            dx: u.x,
            dz: u.z,
            length: Math.hypot(ex - sx, ez - sz),
            heading: Math.atan2(u.x, u.z),
            turns: [],
            speedLimit: line.avenue ? 17 : 12.5,
          };
          this.lanes.push(lane);
          list.push(lane);
        }
        this.lanesByEdge.set(a.id * 4 + dir, list);
      }
    }

    // Turns.
    for (const lane of this.lanes) {
      const node = this.nodes[lane.to]!;
      const options: Array<[TurnKind, Dir]> = [
        ['straight', lane.dir],
        ['left', ((lane.dir + 3) % 4) as Dir],
        ['right', ((lane.dir + 1) % 4) as Dir],
      ];
      for (const [kind, od] of options) {
        if (node.neighbors[od]! < 0) continue;
        const outs = this.lanesByEdge.get(node.id * 4 + od);
        if (!outs || outs.length === 0) continue;
        const outIndex = kind === 'straight' ? Math.min(lane.index, outs.length - 1) : kind === 'left' ? 0 : outs.length - 1;
        const to = outs[outIndex]!;
        const legal = lane.lanesInDir === 1 || kind === 'straight' || (kind === 'left' ? lane.index === 0 : lane.index === lane.lanesInDir - 1);
        lane.turns.push(makeTurn(kind, lane, to, legal));
      }
      // Corner nodes may have no legal turn for some lanes: allow everything there.
      if (lane.turns.length > 0 && !lane.turns.some((t) => t.legal)) for (const t of lane.turns) t.legal = true;
    }

    this.gridNodeCount = this.nodes.length;
    this.gridLaneCount = this.lanes.length;
    this.gridNodes = this.nodes.slice();
    this.gridLanes = this.lanes.slice();
    const graph = layout.country.graph;
    this.junctions = graph.junctions;
    this.outerRoads = layout.country.roads.map((road, k) => ({ road, nodes: graph.roadNodes[k]! }));
    this.addOuter(graph);
    this.outerLanes = this.lanes.slice(this.gridLaneCount);
    this.gateways = [...new Set(graph.gateways.map((g) => this.nodes[g.node]!))];
    const b = layout.bounds;
    this.mouths = this.gateways.map((g) => mkRect(b.landMinX, g.z - g.halfZ, b.cityMinX, g.z + g.halfZ));
    this.outerSurface = outerSurface(this.nodes, graph);
  }

  /**
   * Las Lomas County's roads (world/country), after the grid's nodes, lanes and turns, which keep their ids and order.
   * A node per vertex, signalled where three roads meet and a bend where two do; each link in the slot of its bearing
   * at its first node and in the opposite one at its second, so a lane's reverse is laneFrom(lane.to,
   * reverseDir(lane.dir), 0) as on the grid; lanes straight along each link; the turns at a bend its one continuation,
   * at a junction the grid's. A gateway gains its link in the empty west slot, and its approaches the one turn into it,
   * after their own.
   */
  private addOuter(graph: CountryGraph): void {
    const rng = new Rng(hashInts(this.layout.seed, OUTER_SALT));
    for (const v of graph.vertices) {
      const degree = v.links.length;
      this.nodes.push({ id: v.id, i: -1, j: -1, x: v.x, z: v.z, halfX: v.half, halfZ: v.half, neighbors: [-1, -1, -1, -1], degree, signal: degree >= 3, offset: rng.range(0, SIGNAL_CYCLE) });
    }
    for (const link of graph.links) {
      const a = this.nodes[link.a]!;
      const b = this.nodes[link.b]!;
      const slot = slotOf(b.x - a.x, b.z - a.z);
      a.neighbors[slot] = b.id;
      b.neighbors[(slot + 2) % 4] = a.id;
    }
    for (const g of graph.gateways) this.nodes[g.node]!.degree = this.nodes[g.node]!.neighbors.filter((v) => v >= 0).length;
    const lines = new Map(this.layout.country.roads.map((r): [CountryRoad, RoadLine] => [r, { index: -1, vertical: false, pos: NaN, width: r.width, lanes: r.lanes, avenue: false, name: r.name }]));
    for (const link of graph.links) {
      for (const [from, to] of [[link.a, link.b], [link.b, link.a]] as const) {
        const a = this.nodes[from]!;
        const b = this.nodes[to]!;
        const dir = a.neighbors.indexOf(b.id) as Dir;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const ux = (b.x - a.x) / len;
        const uz = (b.z - a.z) / len;
        const endA = this.laneEndAt(a, dir);
        const endB = this.laneEndAt(b, reverseDir(dir));
        const line = lines.get(link.road)!;
        const list: Lane[] = [];
        for (let k = 0; k < line.lanes; k++) {
          const off = LANE_W * (k + 0.5);
          const sx = a.x + ux * endA - uz * off;
          const sz = a.z + uz * endA + ux * off;
          const ex = b.x - ux * endB - uz * off;
          const ez = b.z - uz * endB + ux * off;
          const lane: Lane = {
            id: this.lanes.length,
            from: a.id,
            to: b.id,
            dir,
            index: k,
            lanesInDir: line.lanes,
            line,
            sx,
            sz,
            ex,
            ez,
            dx: ux,
            dz: uz,
            length: Math.hypot(ex - sx, ez - sz),
            heading: Math.atan2(ux, uz),
            turns: [],
            speedLimit: Math.min(COUNTRY_SPEED[link.road.kind], Math.sqrt(4.5 * link.radius)),
          };
          this.lanes.push(lane);
          list.push(lane);
        }
        this.lanesByEdge.set(a.id * 4 + dir, list);
      }
    }
    for (const lane of this.lanes.slice(this.gridLaneCount)) {
      const node = this.nodes[lane.to]!;
      if (this.isBend(node)) {
        const back = reverseDir(lane.dir);
        const on = node.neighbors.findIndex((nb, d) => nb >= 0 && d !== back);
        const outs = this.lanesByEdge.get(node.id * 4 + on)!;
        lane.turns.push(outerTurn('straight', lane, outs[Math.min(lane.index, outs.length - 1)]!, true));
        continue;
      }
      for (const od of [lane.dir, (lane.dir + 3) % 4, (lane.dir + 1) % 4] as Dir[]) {
        const t = this.junctionTurn(lane, od);
        if (t) lane.turns.push(t);
      }
      if (lane.turns.length > 0 && !lane.turns.some((t) => t.legal)) for (const t of lane.turns) t.legal = true;
    }
    for (const g of graph.gateways) {
      const node = this.nodes[g.node]!;
      const slot = node.neighbors.findIndex((nb) => nb >= this.gridNodeCount) as Dir;
      for (const lane of this.lanes.slice(0, this.gridLaneCount)) {
        if (lane.to !== node.id) continue;
        const t = this.junctionTurn(lane, slot);
        if (t) lane.turns.push(t);
      }
    }
  }

  /** Where a lane ends short of a node along slot `dir`: past a junction's box and crosswalk, half a metre from a bend. */
  private laneEndAt(node: RoadNode, dir: Dir): number {
    if (node.i >= 0) return (dir === 1 || dir === 3 ? node.halfX : node.halfZ) + CROSSWALK_W;
    return laneEnd(node.halfX);
  }

  /**
   * The turn from `lane` into slot `od` of the junction it reaches, as the grid makes them: straight on, left or right
   * (none back), the inner lane turning left and the outer right. Null when no road leaves there.
   */
  private junctionTurn(lane: Lane, od: Dir): Turn | null {
    const node = this.nodes[lane.to]!;
    const kind: TurnKind | null = od === lane.dir ? 'straight' : od === (lane.dir + 3) % 4 ? 'left' : od === (lane.dir + 1) % 4 ? 'right' : null;
    if (!kind || node.neighbors[od]! < 0) return null;
    const outs = this.lanesByEdge.get(node.id * 4 + od);
    if (!outs || outs.length === 0) return null;
    const outIndex = kind === 'straight' ? Math.min(lane.index, outs.length - 1) : kind === 'left' ? 0 : outs.length - 1;
    const legal = lane.lanesInDir === 1 || kind === 'straight' || (kind === 'left' ? lane.index === 0 : lane.index === lane.lanesInDir - 1);
    return outerTurn(kind, lane, outs[outIndex]!, legal);
  }

  /** A county node where its road just bends: two links and no junction. */
  isBend(node: RoadNode): boolean {
    return node.i < 0 && node.degree === 2;
  }

  /** One of the county's named junctions. */
  junction(name: CountyJunction): RoadNode {
    return this.nodes[this.junctions[name]]!;
  }

  id(i: number, j: number): number {
    return j * (this.n + 1) + i;
  }

  node(i: number, j: number): RoadNode {
    return this.nodes[this.id(i, j)]!;
  }

  lanesBetween(a: number, b: number): Lane[] {
    const na = this.nodes[a]!;
    const d = na.neighbors.indexOf(b);
    if (d < 0) return [];
    return this.lanesByEdge.get(a * 4 + d) ?? [];
  }

  laneFrom(a: number, dir: Dir, index: number): Lane | null {
    const list = this.lanesByEdge.get(a * 4 + dir);
    if (!list || list.length === 0) return null;
    return list[Math.min(index, list.length - 1)]!;
  }

  /**
   * Holds a signalised junction green for `axis` (the cross axis red, pedestrians kept off the held road) until
   * released. Drivers, pedestrians and the signal heads all read signalState/pedCanCross, so they all see the hold.
   * The road network belongs to a world that outlives a Sim (the title and each new game share it): whoever holds a
   * junction releases it, and a new Sim clears what a discarded one left behind.
   */
  holdSignal(nodeId: number, axis: Axis): void {
    if (this.nodes[nodeId]?.signal) this.holds.set(nodeId, axis);
  }

  releaseSignal(nodeId: number): void {
    this.holds.delete(nodeId);
  }

  clearSignalHolds(): void {
    this.holds.clear();
  }

  /** The axis a junction is held green for, or null when it runs its normal cycle. */
  signalHold(nodeId: number): Axis | null {
    return this.holds.get(nodeId) ?? null;
  }

  get heldSignals(): ReadonlyMap<number, Axis> {
    return this.holds;
  }

  signalState(nodeId: number, axis: Axis, t: number): SignalState {
    const hold = this.holds.get(nodeId);
    if (hold !== undefined) return axis === hold ? 'green' : 'red';
    return this.cycleSignalState(nodeId, axis, t);
  }

  /** Pedestrians may start crossing a road carrying `crossedAxis` traffic. */
  pedCanCross(nodeId: number, crossedAxis: Axis, t: number): boolean {
    const hold = this.holds.get(nodeId);
    if (hold !== undefined) return crossedAxis !== hold;
    return this.cyclePedCanCross(nodeId, crossedAxis, t);
  }

  /** The junction's normal signal cycle, ignoring any hold. */
  cycleSignalState(nodeId: number, axis: Axis, t: number): SignalState {
    const node = this.nodes[nodeId]!;
    if (!node.signal) return 'green';
    const c = (((t + node.offset) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
    const inA = c < SIGNAL_HALF;
    const local = inA ? c : c - SIGNAL_HALF;
    const active: Axis = inA ? 'NS' : 'EW';
    if (axis !== active) return 'red';
    return local < SIGNAL_GREEN ? 'green' : local < SIGNAL_GREEN + SIGNAL_YELLOW ? 'yellow' : 'red';
  }

  /** Pedestrian crossings in the junction's normal signal cycle, ignoring any hold. */
  cyclePedCanCross(nodeId: number, crossedAxis: Axis, t: number): boolean {
    const node = this.nodes[nodeId]!;
    if (!node.signal) return true;
    const c = (((t + node.offset) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
    const inA = c < SIGNAL_HALF;
    const local = inA ? c : c - SIGNAL_HALF;
    const active: Axis = inA ? 'NS' : 'EW';
    return active !== crossedAxis && local < SIGNAL_GREEN - 5;
  }

  /** The nearest node: the grid's own answer in the city; off it, a county node when one is strictly nearer. */
  nearestNode(x: number, z: number): RoadNode {
    const grid = this.nearestGridNode(x, z);
    const b = this.layout.bounds;
    if (x >= b.cityMinX && x <= b.cityMaxX && z >= b.cityMinZ && z <= b.cityMaxZ) return grid;
    let best = grid;
    let bd = (grid.x - x) ** 2 + (grid.z - z) ** 2;
    for (let i = this.gridNodeCount; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  private nearestGridNode(x: number, z: number): RoadNode {
    const node = this.node(nearestIndex(this.layout.vLines, x), nearestIndex(this.layout.hLines, z));
    if (node.degree > 0) return node;
    // The nearest crossing of the lines is dead (by the sea or inside a superblock): the nearest live one.
    let best = this.live[0]!;
    let bd = Infinity;
    for (const n of this.live) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  /**
   * Nearest lane to a point. When `heading` is given, lanes pointing the
   * opposite way are penalised so that a vehicle keeps its travel direction.
   */
  nearestLane(x: number, z: number, heading?: number): { lane: Lane; s: number; dist: number } {
    const { vLines, hLines } = this.layout;
    const candidates: Lane[] = [];
    const vi = nearestIndex(vLines, x);
    const hj = nearestIndex(hLines, z);
    // Vertical segment around z on line vi.
    const sj = segmentIndex(hLines, z);
    const sv = this.lanesBetween(this.id(vi, sj), this.id(vi, sj + 1));
    const sv2 = this.lanesBetween(this.id(vi, sj + 1), this.id(vi, sj));
    candidates.push(...sv, ...sv2);
    const si = segmentIndex(vLines, x);
    const sh = this.lanesBetween(this.id(si, hj), this.id(si + 1, hj));
    const sh2 = this.lanesBetween(this.id(si + 1, hj), this.id(si, hj));
    candidates.push(...sh, ...sh2);
    // No road round the point (by the sea or inside a superblock): every lane of the grid.
    if (candidates.length === 0) candidates.push(...this.gridLanes);
    // Off the city or by a gateway, the county's lanes too, after the grid's: a tie stays on the grid.
    if (this.nearOuter(x, z)) candidates.push(...this.outerLanes);

    let best: Lane = candidates[0]!;
    let bestScore = Infinity;
    let bestS = 0;
    let bestDist = Infinity;
    for (const lane of candidates) {
      const s = Math.max(0, Math.min(lane.length, (x - lane.sx) * lane.dx + (z - lane.sz) * lane.dz));
      const px = lane.sx + lane.dx * s;
      const pz = lane.sz + lane.dz * s;
      const dist = Math.hypot(x - px, z - pz);
      let score = dist;
      if (heading !== undefined) {
        const align = Math.sin(heading) * lane.dx + Math.cos(heading) * lane.dz;
        score += (1 - align) * 6;
      }
      if (score < bestScore) {
        bestScore = score;
        best = lane;
        bestS = s;
        bestDist = dist;
      }
    }
    return { lane: best, s: bestS, dist: bestDist };
  }

  /**
   * A* over intersections. Returns the node id sequence (inclusive) or null. `notFirst` is a
   * neighbour of `from` the route may not lead to first (the node a car came from: no U-turns).
   */
  findRoute(from: number, to: number, notFirst = -1): number[] | null {
    if (from === to) return [from];
    const nodes = this.nodes;
    const open = new Set<number>([from]);
    const came = new Map<number, number>();
    const g = new Map<number, number>([[from, 0]]);
    const target = nodes[to]!;
    const h = (id: number) => Math.hypot(nodes[id]!.x - target.x, nodes[id]!.z - target.z);
    const f = new Map<number, number>([[from, h(from)]]);
    while (open.size > 0) {
      let cur = -1;
      let bestF = Infinity;
      for (const id of open) {
        const v = f.get(id) ?? Infinity;
        if (v < bestF) {
          bestF = v;
          cur = id;
        }
      }
      if (cur === to) {
        const path = [cur];
        while (came.has(cur)) {
          cur = came.get(cur)!;
          path.push(cur);
        }
        return path.reverse();
      }
      open.delete(cur);
      const nc = nodes[cur]!;
      for (const nb of nc.neighbors) {
        if (nb < 0 || (cur === from && nb === notFirst)) continue;
        const nn = nodes[nb]!;
        const tentative = (g.get(cur) ?? Infinity) + Math.hypot(nn.x - nc.x, nn.z - nc.z);
        if (tentative < (g.get(nb) ?? Infinity)) {
          came.set(nb, cur);
          g.set(nb, tentative);
          f.set(nb, tentative + h(nb));
          open.add(nb);
        }
      }
    }
    return null;
  }

  /**
   * Shortest road distance from every intersection to `goal` (Dijkstra over node neighbours,
   * Infinity where unreachable). Memoised per goal; callers must not modify the array.
   */
  distanceField(goal: number): Float64Array {
    let field = this.fields.get(goal);
    if (field) return field;
    const nodes = this.nodes;
    field = new Float64Array(nodes.length).fill(Infinity);
    const done = new Uint8Array(nodes.length);
    field[goal] = 0;
    // Plain O(n^2) selection: the grid has about a hundred intersections.
    for (;;) {
      let cur = -1;
      let best = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        if (!done[i] && field[i]! < best) {
          best = field[i]!;
          cur = i;
        }
      }
      if (cur < 0) break;
      done[cur] = 1;
      const nc = nodes[cur]!;
      for (const nb of nc.neighbors) {
        if (nb < 0 || done[nb]) continue;
        const nn = nodes[nb]!;
        const d = best + Math.hypot(nn.x - nc.x, nn.z - nc.z);
        if (d < field[nb]!) field[nb] = d;
      }
    }
    this.fields.set(goal, field);
    return field;
  }

  /** Turn from `lane` towards the neighbouring node `next`, or null if not adjacent. */
  turnTowards(lane: Lane, next: number): Turn | null {
    for (const t of lane.turns) if (t.to.to === next) return t;
    return null;
  }

  /** Whether nearestLane looks at the county's lanes from (x, z): off the city rectangle, or near a gateway. */
  private nearOuter(x: number, z: number): boolean {
    const b = this.layout.bounds;
    if (x < b.cityMinX || x > b.cityMaxX || z < b.cityMinZ || z > b.cityMaxZ) return true;
    return this.gateways.some((g) => Math.hypot(g.x - x, g.z - z) < GATEWAY_REACH);
  }

  /** True if the point lies on any road surface (lanes, shoulders, intersections). */
  isOnRoad(x: number, z: number): boolean {
    const { vLines, hLines, bounds: b } = this.layout;
    if (x < b.cityMinX || x > b.cityMaxX || z < b.cityMinZ || z > b.cityMaxZ) return this.isOnOuterRoad(x, z);
    const i = nearestIndex(vLines, x);
    const j = nearestIndex(hLines, z);
    const inV = Math.abs(x - vLines[i]!.pos) <= vLines[i]!.width / 2;
    const inH = Math.abs(z - hLines[j]!.pos) <= hLines[j]!.width / 2;
    if (inV && inH) return this.node(i, j).degree > 0;
    if (inV) return roadFrom(this.layout, i, segmentIndex(hLines, z), 2);
    if (inH) return roadFrom(this.layout, segmentIndex(vLines, x), j, 1);
    return false;
  }

  /** Off the city: on the land, the links' mouths through the promenade; beyond it, the county's roads. */
  private isOnOuterRoad(x: number, z: number): boolean {
    const b = this.layout.bounds;
    if (x >= b.landMinX && x <= b.beachEndX && z >= b.landMinZ && z <= b.landMaxZ) return this.mouths.some((r) => rectContains(r, x, z));
    const { segs, discs, bounds } = this.outerSurface;
    if (!rectContains(bounds, x, z)) return false;
    for (let k = 0; k < segs.length; k += 5) {
      const ax = segs[k]!;
      const az = segs[k + 1]!;
      const dx = segs[k + 2]! - ax;
      const dz = segs[k + 3]! - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      if ((x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2 <= segs[k + 4]! ** 2) return true;
    }
    for (let k = 0; k < discs.length; k += 3) if ((x - discs[k]!) ** 2 + (z - discs[k + 1]!) ** 2 <= discs[k + 2]! ** 2) return true;
    return false;
  }
}

/** The county's road surface for isOnRoad: each link's centre line and half width, each junction's box as a disc. */
function outerSurface(nodes: readonly RoadNode[], graph: CountryGraph): { segs: Float64Array; discs: Float64Array; bounds: Rect } {
  const segs: number[] = [];
  const discs: number[] = [];
  const bounds = mkRect(Infinity, Infinity, -Infinity, -Infinity);
  for (const link of graph.links) {
    const a = nodes[link.a]!;
    const b = nodes[link.b]!;
    const half = link.road.width / 2;
    segs.push(a.x, a.z, b.x, b.z, half);
    bounds.minX = Math.min(bounds.minX, a.x - half, b.x - half);
    bounds.minZ = Math.min(bounds.minZ, a.z - half, b.z - half);
    bounds.maxX = Math.max(bounds.maxX, a.x + half, b.x + half);
    bounds.maxZ = Math.max(bounds.maxZ, a.z + half, b.z + half);
  }
  for (const v of graph.vertices) if (v.half > 0) discs.push(v.x, v.z, v.half);
  return { segs: Float64Array.from(segs), discs: Float64Array.from(discs), bounds };
}

/**
 * A turn between any two lanes (the county's, and a gateway's into them): a quadratic Bezier with its control point
 * where the two lane lines cross, as the grid's turns have, or a straight join where they run parallel or cross behind
 * the first lane's end or beyond the second's start (the inside of a bend).
 */
function outerTurn(kind: TurnKind, from: Lane, to: Lane, legal: boolean): Turn {
  const pts: number[] = [];
  const den = from.dx * to.dz - from.dz * to.dx;
  const ox = to.sx - from.ex;
  const oz = to.sz - from.ez;
  const t = (ox * to.dz - oz * to.dx) / den;
  const u = (ox * from.dz - oz * from.dx) / den;
  if (Math.abs(den) > 1e-9 && t > 0 && u < 0) {
    const cx = from.ex + from.dx * t;
    const cz = from.ez + from.dz * t;
    const steps = kind === 'straight' ? 4 : 10;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const a = (1 - f) * (1 - f);
      const b = 2 * (1 - f) * f;
      const c = f * f;
      pts.push(a * from.ex + b * cx + c * to.sx, a * from.ez + b * cz + c * to.sz);
    }
  } else {
    pts.push(from.ex, from.ez, to.sx, to.sz);
  }
  const arr = new Float64Array(pts);
  let length = 0;
  for (let i = 2; i < arr.length; i += 2) length += Math.hypot(arr[i]! - arr[i - 2]!, arr[i + 1]! - arr[i - 1]!);
  return { kind, from, to, pts: arr, length, legal };
}

function makeTurn(kind: TurnKind, from: Lane, to: Lane, legal: boolean): Turn {
  const pts: number[] = [];
  if (kind === 'straight') {
    pts.push(from.ex, from.ez, to.sx, to.sz);
  } else {
    // Quadratic Bezier with the control point at the crossing of both lane lines.
    const verticalIn = from.dir === 0 || from.dir === 2;
    const cx = verticalIn ? from.ex : to.sx;
    const cz = verticalIn ? to.sz : from.ez;
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const c = t * t;
      pts.push(a * from.ex + b * cx + c * to.sx, a * from.ez + b * cz + c * to.sz);
    }
  }
  const arr = new Float64Array(pts);
  let length = 0;
  for (let i = 2; i < arr.length; i += 2) length += Math.hypot(arr[i]! - arr[i - 2]!, arr[i + 1]! - arr[i - 1]!);
  return { kind, from, to, pts: arr, length, legal };
}

function nearestIndex(lines: RoadLine[], v: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const d = Math.abs(lines[i]!.pos - v);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Index i such that v lies between lines i and i+1 (clamped). */
function segmentIndex(lines: RoadLine[], v: number): number {
  for (let i = 0; i < lines.length - 1; i++) if (v < lines[i + 1]!.pos) return i;
  return lines.length - 2;
}
