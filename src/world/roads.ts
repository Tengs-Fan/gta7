// Directed lane graph built on top of the road grid: lanes, turn curves through
// intersections, traffic signal phases and A* routing between intersections.

import { Rng } from '../core/rng';
import { CROSSWALK_W, LANE_W } from './constants';
import { DIR_VECTORS, type CityLayout, type RoadLine } from './layout';

export type Dir = 0 | 1 | 2 | 3; // N E S W
export type Axis = 'NS' | 'EW';
export type TurnKind = 'straight' | 'left' | 'right';
export type SignalState = 'green' | 'yellow' | 'red';

export const SIGNAL_GREEN = 11;
export const SIGNAL_YELLOW = 3;
export const SIGNAL_ALL_RED = 2;
export const SIGNAL_HALF = SIGNAL_GREEN + SIGNAL_YELLOW + SIGNAL_ALL_RED;
export const SIGNAL_CYCLE = SIGNAL_HALF * 2;

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
  readonly nodes: RoadNode[] = [];
  readonly lanes: Lane[] = [];
  readonly segments: RoadSegment[] = [];
  private readonly lanesByEdge = new Map<number, Lane[]>();
  private readonly n: number;

  constructor(readonly layout: CityLayout) {
    const { vLines, hLines } = layout;
    this.n = layout.n;
    const n = this.n;
    const rng = new Rng((layout.seed * 31337) >>> 0);

    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const neighbors: [number, number, number, number] = [
          j > 0 ? this.id(i, j - 1) : -1,
          i < n ? this.id(i + 1, j) : -1,
          j < n ? this.id(i, j + 1) : -1,
          i > 0 ? this.id(i - 1, j) : -1,
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

  signalState(nodeId: number, axis: Axis, t: number): SignalState {
    const node = this.nodes[nodeId]!;
    if (!node.signal) return 'green';
    const c = (((t + node.offset) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
    const inA = c < SIGNAL_HALF;
    const local = inA ? c : c - SIGNAL_HALF;
    const active: Axis = inA ? 'NS' : 'EW';
    if (axis !== active) return 'red';
    return local < SIGNAL_GREEN ? 'green' : local < SIGNAL_GREEN + SIGNAL_YELLOW ? 'yellow' : 'red';
  }

  /** Pedestrians may start crossing a road carrying `crossedAxis` traffic. */
  pedCanCross(nodeId: number, crossedAxis: Axis, t: number): boolean {
    const node = this.nodes[nodeId]!;
    if (!node.signal) return true;
    const c = (((t + node.offset) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
    const inA = c < SIGNAL_HALF;
    const local = inA ? c : c - SIGNAL_HALF;
    const active: Axis = inA ? 'NS' : 'EW';
    return active !== crossedAxis && local < SIGNAL_GREEN - 5;
  }

  nearestNode(x: number, z: number): RoadNode {
    const i = nearestIndex(this.layout.vLines, x);
    const j = nearestIndex(this.layout.hLines, z);
    return this.node(i, j);
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

    let best: Lane = candidates[0] ?? this.lanes[0]!;
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

  /** Turn from `lane` towards the neighbouring node `next`, or null if not adjacent. */
  turnTowards(lane: Lane, next: number): Turn | null {
    for (const t of lane.turns) if (t.to.to === next) return t;
    return null;
  }

  /** True if the point lies on any road surface (lanes, shoulders, intersections). */
  isOnRoad(x: number, z: number): boolean {
    const b = this.layout.bounds;
    if (x < b.cityMinX || x > b.cityMaxX || z < b.cityMinZ || z > b.cityMaxZ) return false;
    for (const l of this.layout.vLines) if (Math.abs(x - l.pos) <= l.width / 2) return true;
    for (const l of this.layout.hLines) if (Math.abs(z - l.pos) <= l.width / 2) return true;
    return false;
  }
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
