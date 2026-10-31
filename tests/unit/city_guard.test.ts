// The city does not move: everything San Azura's grid was before Las Lomas County joined the lane graph (docs/map.md),
// recorded on the untouched round-2 head (c5ebb01) before any county code existed. Lanes, junctions, turns, signals,
// routes, distance fields, the walk graph, props, colliders, the street-run courses and the ground under the old world
// hash as they did; the city's lookups answer as their frozen copies do (tests/unit/helpers.ts), or with a county lane or
// node strictly nearer. Only what the county legitimately touches is left out: the west arm the two gateways gain
// (neighbors[3] and degree of nodes 22 and 88), the promenade's two mouth edges turned crosswalks, the four props moved
// out of the mouths, and the ground and lookups on the two links and west of x -650.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { buildStreetRunCourses } from '../../src/sim/streetRuns';
import { SIGNAL_CYCLE, type Lane } from '../../src/world/roads';
import { frozenNearestLane, frozenNearestNode, laneScore, world } from './helpers';

const W = world();
const roads = W.roads;

/** What the city had: 121 junctions, 574 lanes, 463 walk nodes, 432 walking edges, 3861 props and 4575 colliders. */
const GRID_NODES = 121;
const GRID_LANES = 574;
const WALK_NODES = 463;
const PROPS = 3861;
const COLLIDERS = 4575;
/** The gateways to the county: Magnolia Ave and Southgate Ave at Harbor Blvd. */
const GATEWAYS = [22, 88];
/** The props that stood in the two mouths through the promenade: two lamps, a tree and a bench. */
const MOVED: ReadonlyArray<{ index: number; kind: string }> = [
  { index: 3123, kind: 'lamp' },
  { index: 3124, kind: 'tree' },
  { index: 3125, kind: 'bench' },
  { index: 3154, kind: 'lamp' },
];
/** The old world's bounds, whatever layout.bounds says now. */
const OLD = { minX: -672, maxX: 762, minZ: -1060, maxZ: 676 };

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** The links' corridors west of the city (the mouths, the causeway, the bridge) and everything west of x -650. */
function county(x: number, z: number): boolean {
  return x < -650 || (x < -478 && (Math.abs(z + 268) <= 14 || Math.abs(z - 268) <= 14));
}

const laneRow = (l: Lane) => [
  l.id, l.from, l.to, l.dir, l.index, l.lanesInDir,
  [l.line.index, l.line.vertical, l.line.pos, l.line.width, l.line.lanes, l.line.avenue, l.line.name],
  l.sx, l.sz, l.ex, l.ez, l.dx, l.dz, l.length, l.heading, l.speedLimit,
];

describe('city guard: the grid', () => {
  it('keeps its junctions, live list and segments', () => {
    expect(roads.nodes.slice(0, GRID_NODES).every((n, k) => n.id === k && n.i >= 0 && n.j >= 0)).toBe(true);
    const nodes = roads.nodes.slice(0, GRID_NODES).map((n) => {
      const gate = GATEWAYS.includes(n.id);
      return [n.id, n.i, n.j, n.x, n.z, n.halfX, n.halfZ, gate ? n.neighbors.slice(0, 3) : n.neighbors, gate ? null : n.degree, n.signal, n.offset];
    });
    for (const id of GATEWAYS) expect(roads.nodes[id]!.neighbors.slice(0, 3).filter((v) => v >= 0).length).toBe(3);
    const live = roads.live.map((n) => n.id);
    const segments = roads.segments.map((s) => [s.a, s.b, s.vertical, s.line.index, s.minX, s.minZ, s.maxX, s.maxZ]);
    expect({ nodes: sha(nodes), live: sha(live), segments: sha(segments) }).toEqual({
      nodes: 'd2bbb9d8ecf98179a1dbefdce79b2dd22f95fb2bce2a077ba684569ec88905f0',
      live: '6aa132b3c52b678113b86db10264bcd8ad53760ca0faf2869361a4544c2e4e95',
      segments: 'c42afd70a6412650d373ec49e34c11e3af64969655e9341a4aa48adc3f759c3f',
    });
  });

  it('keeps its lanes and their turns, the gateways\' approaches gaining one turn at most, appended', () => {
    const lanes = roads.lanes.slice(0, GRID_LANES);
    expect(lanes.every((l, k) => l.id === k && l.line.index >= 0)).toBe(true);
    const turns = lanes.map((l) => {
      const grid = l.turns.filter((t) => t.to.line.index >= 0);
      const outer = l.turns.length - grid.length;
      expect(outer, `lane ${l.id}`).toBeLessThanOrEqual(GATEWAYS.includes(l.to) ? 1 : 0);
      if (outer > 0) expect(l.turns[l.turns.length - 1]!.to.line.index, `lane ${l.id}`).toBeLessThan(0);
      return grid.map((t) => [t.kind, t.to.id, Array.from(t.pts), t.length, t.legal]);
    });
    expect({ lanes: sha(lanes.map(laneRow)), turns: sha(turns) }).toEqual({
      lanes: 'c43093987fbcc17d4e070dd2c6128d54f57bde8ca61298c18edc649463ccfe2b',
      turns: 'fb08f10d3af0f457b774f5d315361707db91f22f145fc31b04c572289e9fae3a',
    });
  });

  it('keeps its signals: offsets, a full cycle of lights and crossings', () => {
    const rows: string[] = [];
    for (const n of roads.nodes.slice(0, GRID_NODES)) {
      const row = [n.offset.toString()];
      for (let t = 0; t < SIGNAL_CYCLE + 1; t += 0.25) {
        for (const axis of ['NS', 'EW'] as const) row.push(roads.signalState(n.id, axis, t)[0]!, roads.pedCanCross(n.id, axis, t) ? '1' : '0');
      }
      rows.push(row.join(''));
    }
    expect(sha(rows)).toBe('f18583c6f904d5633cef4cbe212cd3ba931037926487aec40f5cb0683ad3c057');
  });

  it('keeps every route between two junctions, with and without a first turn barred', () => {
    const live = roads.live.filter((n) => n.i >= 0).map((n) => n.id);
    const plain: Array<number[] | null> = [];
    const barred: Array<number[] | null> = [];
    for (const a of live) {
      for (const b of live) plain.push(roads.findRoute(a, b));
      for (const nb of roads.nodes[a]!.neighbors) {
        if (nb < 0 || nb >= GRID_NODES) continue;
        for (let k = (a + nb) % 7; k < live.length; k += 7) barred.push(roads.findRoute(a, live[k]!, nb));
      }
    }
    expect({ plain: sha(plain), barred: sha(barred) }).toEqual({
      plain: '35b415f15e02b2e295bb48414beb6142be74b1c38223683bf91dd60cc984b387',
      barred: '0fd2bdac1a786c88c3f6895c8e8799e4f944f084c489fee05556823c55608c17',
    });
  });

  it('keeps every distance field over the grid', () => {
    const fields = roads.live.filter((n) => n.i >= 0).map((n) => Array.from(roads.distanceField(n.id).slice(0, GRID_NODES)));
    expect(sha(fields)).toBe('977ab3c4342ef2d63e8d14065014bd6d34deabeae3960f7b44d280f0fbc581e9');
  });

  it('keeps the three street-run courses', () => {
    expect(sha(buildStreetRunCourses(roads))).toBe('466c187a5d164bafe33c8f8f8f02c8b204d43fc275a9c8decb3cf03de466a95a');
  });
});

describe('city guard: the walk graph, the props and the colliders', () => {
  it('keeps every walk node and edge, the mouths\' two promenade edges aside, and the walking edges in their order', () => {
    const walk = W.walk;
    expect(walk.nodes.length).toBeGreaterThanOrEqual(WALK_NODES);
    // The promenade's edges across the two mouths: either side of Magnolia Ave and Southgate Ave on the west promenade.
    const at = (x: number, z: number) => walk.nodes.findIndex((n) => Math.abs(n.x - x) < 0.01 && Math.abs(n.z - z) < 0.01);
    const mouths = [
      [at(-480.2, -278.2), at(-480.2, -257.8)],
      [at(-480.2, 257.8), at(-480.2, 278.2)],
    ];
    expect(mouths.flat()).toEqual([386, 387, 424, 425]);
    const mouth = (a: number, b: number) => mouths.some(([p, q]) => (a === p && b === q) || (a === q && b === p));
    const nodes = walk.nodes.slice(0, WALK_NODES).map((n) => [n.id, n.x, n.z, n.edges.map((e) => (mouth(n.id, e.to) ? [e.to, e.length] : [e.to, e.length, e.crosswalk, e.axis, e.roadNode]))]);
    expect(walk.walkEdges.length).toBe(432);
    expect({ nodes: sha(nodes), walkEdges: sha(walk.walkEdges) }).toEqual({
      nodes: 'a37827712e82c3e34d786ce9b88e853ec6c023b3b22588d4d653f6744841eb0c',
      walkEdges: '966d20bd9b80e61fcdd3a2be81ef40687bf8fc5f26ad808cf31d177efae647df',
    });
  });

  it('keeps every prop and every collider, the four moved out of the mouths aside', () => {
    const props = W.layout.props;
    expect(props.length).toBeGreaterThanOrEqual(PROPS);
    for (const m of MOVED) expect(props[m.index]!.kind).toBe(m.kind);
    const moved = new Set(MOVED.map((m) => m.index));
    const rows = props.slice(0, PROPS).map((p, i) => [p.kind, moved.has(i) ? null : p.x, p.y, moved.has(i) ? null : p.z, p.rot, p.scale, p.color, p.w, p.d, p.h, p.node, p.dir]);
    const skip = new Set(MOVED.map((m) => W.propColliders[m.index]!));
    expect(W.grid.colliders.length).toBeGreaterThanOrEqual(COLLIDERS);
    const colliders = W.grid.colliders.slice(0, COLLIDERS).map((c) =>
      skip.has(c.id) ? [c.id, c.circle, c.r, c.y0, c.y1, c.tag, c.breakable, c.propIndex] : [c.id, c.circle, c.minX, c.minZ, c.maxX, c.maxZ, c.cx, c.cz, c.r, c.y0, c.y1, c.tag, c.breakable, c.propIndex],
    );
    const propColliders = W.propColliders.slice(0, PROPS);
    expect({ props: sha(rows), colliders: sha(colliders), propColliders: sha(propColliders) }).toEqual({
      props: '80cbb257efb5af5bb0e4279be72316d288c9efb1b7d70ba4667aa716d35dba7b',
      colliders: 'cd10b880ddac64af3f54e334f7505bc47b8428bf2050a01aa0125a623b466762',
      propColliders: 'ca4f8326dadc6bc1281d071e44384f0375d42c06ea6fc36e658095b3cac3007f',
    });
  });
});

describe('city guard: the ground and the lookups over the old world', () => {
  /** A 4 m lattice over the old world, then 10 000 seeded points in it. */
  const points: Array<[number, number]> = [];
  for (let x = OLD.minX; x <= OLD.maxX; x += 4) for (let z = OLD.minZ; z <= OLD.maxZ; z += 4) points.push([x, z]);
  const rng = new Rng(0xc17e);
  for (let k = 0; k < 10_000; k++) points.push([rng.range(OLD.minX, OLD.maxX), rng.range(OLD.minZ, OLD.maxZ)]);

  it('keeps the ground, the water, the roads, the zones and the districts off the links', () => {
    const rows: string[] = [];
    for (const [x, z] of points) {
      if (county(x, z)) continue;
      rows.push(`${W.baseGround(x, z)} ${W.groundHeight(x, z)} ${W.waterDepth(x, z)} ${W.isOnRoad(x, z) ? 1 : 0} ${W.zoneName(x, z)} ${W.districtAt(x, z)}`);
    }
    expect(sha(rows)).toBe('3c82ef9430d55ef8a7819098e28f13d3026079e1c3402099ecde358558a29581');
  });

  it('answers nearestLane and nearestNode as the city did, or with a county lane or node strictly nearer', () => {
    const headings = [undefined, 0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const bad: string[] = [];
    let outer = 0;
    for (const [x, z] of points) {
      for (const h of headings) {
        const was = frozenNearestLane(roads, x, z, h);
        const now = roads.nearestLane(x, z, h);
        if (now.lane === was.lane) {
          if (now.s !== was.s || now.dist !== was.dist) bad.push(`lane at ${x},${z},${h}: s ${now.s} / ${was.s}, dist ${now.dist} / ${was.dist}`);
        } else if (now.lane.line.index >= 0 || !(laneScore(now.lane, now.dist, h) < laneScore(was.lane, was.dist, h))) {
          bad.push(`lane at ${x},${z},${h}: ${now.lane.id} for ${was.lane.id}`);
        } else outer++;
      }
      const was = frozenNearestNode(roads, x, z);
      const now = roads.nearestNode(x, z);
      if (now !== was && (now.i >= 0 || !(Math.hypot(now.x - x, now.z - z) < Math.hypot(was.x - x, was.z - z)))) bad.push(`node at ${x},${z}: ${now.id} for ${was.id}`);
      if (bad.length > 20) break;
    }
    console.log(`[city_guard] ${points.length} points, ${outer} nearest lanes now in the county`);
    expect(bad).toEqual([]);
  });
});
