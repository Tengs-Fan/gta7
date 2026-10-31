// Las Lomas County's roads, land and links (world/country): the outer graph keeps the lane graph's rules (a slot per
// link, every lane's reverse where the grid has it, no dead end, bends a car follows at speed), the land is flat with
// a beach round it, the plots keep off the roads, the verges keep off the spawn list, and the causeway and the bridge
// carry the road over Lomas Sound and close it to boats.

import { describe, expect, it } from 'vitest';
import { CROSSWALK_W, CURB_H, PROMENADE_W, SWIM_DEPTH, WATER_Y } from '../../src/world/constants';
import {
  BRIDGE, BRIDGE_NAME, CAUSEWAY, CAUSEWAY_NAME, COUNTRY_ROADS, COUNTY_LAND, COUNTY_NAME, COUNTY_PLOTS, onCountyLand,
} from '../../src/world/country';
import { rectContains, type Rect } from '../../src/world/layout';
import { reverseDir, type Lane } from '../../src/world/roads';
import { makeBrain } from '../../src/sim/brains';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

const W = world();
const L = W.layout;
const roads = W.roads;
const outerNodes = roads.nodes.slice(roads.gridNodeCount);
const outerLanes = roads.lanes.slice(roads.gridLaneCount);
const deg = (r: number) => (r * 180) / Math.PI;

/** Distance from (x, z) to the rectangle r (0 inside). */
const rectGap = (r: Rect, x: number, z: number) => Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));

/** Points every `step` m along every county road's centre line, with the road. */
function centrePoints(step = 2): Array<{ x: number; z: number; road: (typeof COUNTRY_ROADS)[number] }> {
  const out: Array<{ x: number; z: number; road: (typeof COUNTRY_ROADS)[number] }> = [];
  for (const road of COUNTRY_ROADS) {
    for (let k = 2; k < road.pts.length; k += 2) {
      const ax = road.pts[k - 2]!;
      const az = road.pts[k - 1]!;
      const bx = road.pts[k]!;
      const bz = road.pts[k + 1]!;
      const n = Math.ceil(Math.hypot(bx - ax, bz - az) / step);
      for (let i = 0; i < n; i++) out.push({ x: ax + ((bx - ax) * i) / n, z: az + ((bz - az) * i) / n, road });
    }
  }
  return out;
}

/** Whether (x, z) is on the city's land: its rectangle out to the promenade's edge. */
const onCityLand = (x: number) => x >= L.bounds.landMinX;

describe('Las Lomas County: the outer road graph', () => {
  it('appends 52 nodes and 160 lanes after the grid, joined to it at Magnolia Ave and Southgate Ave on Harbor Blvd', () => {
    expect(roads.gridNodeCount).toBe(121);
    expect(roads.gridLaneCount).toBe(574);
    expect(outerNodes.length).toBe(52);
    expect(outerLanes.length).toBe(160);
    expect(outerNodes.every((n, k) => n.id === roads.gridNodeCount + k && n.i === -1 && n.j === -1)).toBe(true);
    expect(outerLanes.every((l, k) => l.id === roads.gridLaneCount + k && l.line.index === -1)).toBe(true);
    for (const [i, j] of [[0, 2], [0, 8]] as const) {
      const g = roads.node(i, j);
      expect(g.neighbors[3]).toBeGreaterThanOrEqual(roads.gridNodeCount);
      expect(g.degree).toBe(4);
      expect(g.signal).toBe(true);
    }
    expect(roads.gridNodes.length).toBe(121);
    expect(roads.gridLanes).toEqual(roads.lanes.slice(0, 574));
    expect(roads.live.every((n) => n.i >= 0)).toBe(true);
    expect(roads.junction('drycreek')).toMatchObject({ x: -840, z: -268, degree: 4, signal: true });
    expect(roads.junction('hollister')).toMatchObject({ x: -1104, z: -268, degree: 3, signal: true });
    expect(roads.junction('creek')).toMatchObject({ x: -840, z: 268, degree: 3, signal: true });
  });

  it('gives every link one slot at either end, every lane its reverse, and no node a dead end', () => {
    for (const n of outerNodes) {
      expect(n.degree, `node ${n.id}`).toBeGreaterThanOrEqual(2);
      expect(n.neighbors.filter((v) => v >= 0).length, `node ${n.id}`).toBe(n.degree);
      expect(n.signal).toBe(n.degree >= 3);
      expect(roads.isBend(n)).toBe(n.degree === 2);
    }
    for (const l of outerLanes) {
      expect(roads.nodes[l.from]!.neighbors[l.dir], `lane ${l.id}`).toBe(l.to);
      const back = roads.laneFrom(l.to, reverseDir(l.dir), 0)!;
      expect([back.from, back.to], `lane ${l.id}`).toEqual([l.to, l.from]);
      expect(l.turns.length, `lane ${l.id}`).toBeGreaterThan(0);
      expect(l.turns.some((t) => t.legal)).toBe(true);
    }
    // Every county node reaches the middle of the city and back.
    const centre = roads.node(5, 5).id;
    for (const n of outerNodes) {
      expect(roads.findRoute(n.id, centre), `from ${n.id}`).not.toBeNull();
      expect(roads.findRoute(centre, n.id), `to ${n.id}`).not.toBeNull();
    }
  });

  it('keeps the rules for roads off the grid: arms on the axes, gentle bends 20-30 m apart, none near a junction', () => {
    const junctions = outerNodes.filter((n) => n.degree >= 3);
    for (const { road, nodes } of roads.outerRoads) {
      for (let k = 0; k < nodes.length; k++) {
        const node = roads.nodes[nodes[k]!]!;
        const prev = roads.nodes[nodes[k - 1] ?? -1];
        const next = roads.nodes[nodes[k + 1] ?? -1];
        for (const o of [prev, next]) {
          if (!o || roads.isBend(node)) continue;
          // A junction's arm: within 15 degrees of an axis.
          const off = (((deg(Math.atan2(o.x - node.x, o.z - node.z)) % 90) + 90) % 90);
          expect(Math.min(off, 90 - off), `${road.name} at ${node.id}`).toBeLessThanOrEqual(15);
        }
        if (!roads.isBend(node)) continue;
        const turn = Math.atan2(next!.x - node.x, next!.z - node.z) - Math.atan2(node.x - prev!.x, node.z - prev!.z);
        expect(Math.abs(deg(Math.atan2(Math.sin(turn), Math.cos(turn)))), `${road.name} at ${node.id}`).toBeLessThanOrEqual(10.01);
        for (const j of junctions) expect(Math.hypot(j.x - node.x, j.z - node.z), `${road.name} at ${node.id}`).toBeGreaterThanOrEqual(30);
      }
      // Each stretch on a curve is 20-30 m, its radius 120 m or more.
      for (let k = 1; k < road.pts.length / 2; k++) {
        if (road.radii[k - 1] === Infinity) continue;
        const len = Math.hypot(road.pts[k * 2]! - road.pts[k * 2 - 2]!, road.pts[k * 2 + 1]! - road.pts[k * 2 - 1]!);
        expect(len, road.name).toBeGreaterThanOrEqual(20);
        expect(len, road.name).toBeLessThanOrEqual(30);
        expect(road.radii[k - 1], road.name).toBeGreaterThanOrEqual(120);
      }
    }
    console.log(`[country_roads] ${COUNTRY_ROADS.map((r) => `${r.name} ${Math.round(r.pts.reduce((s, _v, k) => (k >= 2 && k % 2 === 0 ? s + Math.hypot(r.pts[k]! - r.pts[k - 2]!, r.pts[k + 1]! - r.pts[k - 1]!) : s), 0))} m`).join(', ')}`);
  });

  it('builds bend lanes of 19 m and more, from any of which a driver plans 70 m ahead within 8 steps', () => {
    for (const l of outerLanes) if (roads.isBend(roads.nodes[l.from]!) || roads.isBend(roads.nodes[l.to]!)) expect(l.length, `lane ${l.id}`).toBeGreaterThanOrEqual(19);
    // DriverAI.extend from the very end of a lane: a turn, then its lane, and so on, at most 8 pieces; the shortest way.
    const reach = (lane: Lane, steps: number): number => {
      if (steps < 2) return 0;
      let best = Infinity;
      for (const t of lane.turns) best = Math.min(best, t.length + t.to.length + reach(t.to, steps - 2));
      return best;
    };
    for (const l of outerLanes) expect(reach(l, 8), `lane ${l.id}`).toBeGreaterThanOrEqual(70);
    for (const l of outerLanes) {
      const limit = l.line.lanes === 2 ? 22 : 15;
      expect(l.speedLimit).toBe(limit);
    }
  });

  it('finds every county lane from its own middle, and the road under its centre lines but not a metre past its edge', () => {
    for (const l of outerLanes) {
      const x = l.sx + (l.dx * l.length) / 2;
      const z = l.sz + (l.dz * l.length) / 2;
      expect(roads.nearestLane(x, z, l.heading).lane.id, `lane ${l.id}`).toBe(l.id);
    }
    for (const p of centrePoints()) {
      if (onCityLand(p.x)) continue;
      expect(W.isOnRoad(p.x, p.z), `${p.road.name} at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`).toBe(true);
    }
    for (const l of outerLanes) {
      if (l.index !== l.lanesInDir - 1) continue;
      const half = l.line.width / 2;
      const s = l.length / 2;
      const cx = l.sx + l.dx * s + l.dz * LANE_OFF(l);
      const cz = l.sz + l.dz * s - l.dx * LANE_OFF(l);
      // To its right: inside the edge, then a metre past it (clear of any junction box).
      expect(W.isOnRoad(cx - l.dz * (half - 0.2), cz + l.dx * (half - 0.2)), `lane ${l.id}`).toBe(true);
      expect(W.isOnRoad(cx - l.dz * (half + 1), cz + l.dx * (half + 1)), `lane ${l.id}`).toBe(false);
    }
  });
});

/** How far a lane runs right of its road's centre line. */
function LANE_OFF(l: Lane): number {
  return 4 * (l.index + 0.5);
}

describe('Las Lomas County: the land', () => {
  it('reaches out to x -1776 by whole grid cells, the county about 0.9 km2 on six rectangles', () => {
    expect(L.bounds.worldMinX).toBe(-1776);
    expect((L.bounds.cityMinX - PROMENADE_W - 160 - L.bounds.worldMinX) % 12).toBe(0);
    expect(W.grid.minX).toBe(-1776);
    const area = COUNTY_LAND.reduce((s, r) => s + (r.maxX - r.minX) * (r.maxZ - r.minZ), 0);
    console.log(`[country_roads] land ${area} m2 on ${COUNTY_LAND.length} rectangles`);
    expect(area).toBeGreaterThan(850_000);
    expect(COUNTY_LAND.length).toBeGreaterThanOrEqual(4);
    expect(COUNTY_LAND.length).toBeLessThanOrEqual(7);
    expect(COUNTY_LAND.every((r) => r.minX >= -1560 && r.maxX <= -700 && r.minZ >= -580 && r.maxZ <= 580)).toBe(true);
  });

  it('is flat on every road and plot, with a beach that meets the water 6-10 m out', () => {
    for (const p of centrePoints()) if (p.x < CAUSEWAY.minX) expect(W.groundHeight(p.x, p.z), `${p.road.name}`).toBe(0);
    for (const p of COUNTY_PLOTS) for (const [x, z] of [[p.rect.minX, p.rect.minZ], [p.rect.maxX, p.rect.maxZ], [(p.rect.minX + p.rect.maxX) / 2, (p.rect.minZ + p.rect.maxZ) / 2]] as const) expect(W.baseGround(x, z), p.name).toBe(0);
    // Off the west, north and south coasts and the east shore: where the ground crosses the water.
    for (const [x, z, dx, dz] of [[-1560, 0, -1, 0], [-1000, -580, 0, -1], [-1200, 580, 0, 1], [-700, 0, 1, 0]] as const) {
      let d = 0;
      while (W.baseGround(x + dx * d, z + dz * d) > WATER_Y) d += 0.1;
      expect(d).toBeGreaterThanOrEqual(6);
      expect(d).toBeLessThanOrEqual(10);
      expect(W.baseGround(x + dx * 50, z + dz * 50)).toBe(-8);
    }
  });

  it('keeps every road 30 m inside the land and every plot on it, 12 m off the road edges but Dry Creek', () => {
    for (const p of centrePoints(4)) {
      if (p.x > -760) continue;
      const r = p.road.width / 2 + 30;
      for (let a = 0; a < 16; a++) expect(onCountyLand(L.country, p.x + Math.cos((a * Math.PI) / 8) * r, p.z + Math.sin((a * Math.PI) / 8) * r), `${p.road.name} at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`).toBe(true);
    }
    const pts = centrePoints(1);
    for (const plot of COUNTY_PLOTS) {
      for (const [x, z] of [[plot.rect.minX, plot.rect.minZ], [plot.rect.maxX, plot.rect.minZ], [plot.rect.minX, plot.rect.maxZ], [plot.rect.maxX, plot.rect.maxZ]] as const) expect(onCountyLand(L.country, x, z), plot.name).toBe(true);
      if (plot.id === 'drycreek') continue;
      const gap = Math.min(...pts.map((p) => rectGap(plot.rect, p.x, p.z) - p.road.width / 2));
      expect(gap, plot.name).toBeGreaterThanOrEqual(12);
    }
  });

  it('names its plots and the county, the causeway and the bridge, and keeps the sound the bay', () => {
    for (const p of COUNTY_PLOTS) {
      const x = (p.rect.minX + p.rect.maxX) / 2;
      const z = (p.rect.minZ + p.rect.maxZ) / 2;
      expect(W.zoneName(x, z)).toBe(p.name);
      expect(W.districtAt(x, z)).toBe('country');
    }
    expect(W.zoneName(-1250, -300)).toBe(COUNTY_NAME);
    expect(W.zoneName(-600, -260)).toBe(CAUSEWAY_NAME);
    expect(W.districtAt(-600, -260)).toBe('country');
    expect(W.zoneName(-600, 268)).toBe(BRIDGE_NAME);
    expect(W.districtAt(-600, 268)).toBe('sea');
    expect(W.zoneName(-600, 0)).toBe('San Azura Bay');
    expect(W.districtAt(-600, 0)).toBe('sea');
  });

  it('keeps the verges off the spawn list and a walk node within 30 m of every county road', () => {
    const walk = W.walk;
    expect(walk.walkEdges.length).toBe(432);
    expect(walk.walkEdges.every(([a, b]) => a < 463 && b < 463)).toBe(true);
    expect(walk.countyWalkEdges).toEqual([]);
    // No county edge touches the city's graph.
    for (const n of walk.nodes.slice(0, 463)) expect(n.edges.every((e) => e.to < 463)).toBe(true);
    for (const p of centrePoints(5)) {
      if (onCityLand(p.x) || rectContains(BRIDGE, p.x, p.z) || (p.x > -760 && Math.abs(p.z - 268) < 20)) continue;
      const n = walk.nodes[walk.nearestNode(p.x, p.z)]!;
      expect(Math.hypot(n.x - p.x, n.z - p.z), `${p.road.name} at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`).toBeLessThanOrEqual(30);
    }
    // From the middle of a field, the nearest walk node is the county's, not the promenade's.
    for (const p of COUNTY_PLOTS) expect(walk.nearestNode((p.rect.minX + p.rect.maxX) / 2, (p.rect.minZ + p.rect.maxZ) / 2), p.name).toBeGreaterThanOrEqual(463);
    // No pedestrian spawns in the county while it has no footpath: no draw either.
    const a = makeSim({ seed: 2 });
    const b = makeSim({ seed: 2 });
    expect(a.world.walk.randomPointNear(a.rng, -900, 0, 20, 100)).toBeNull();
    expect(a.rng.next()).toBe(b.rng.next());
  });

  it('lets a swimmer climb out onto a beach', () => {
    const sim = makeSim({ seed: 3, police: false });
    teleport(sim, -1000, -614);
    step(sim, 0.5);
    expect(sim.player.state).toBe('swimming');
    step(sim, 12, input({ moveZ: 1, cameraYaw: 0 }));
    expect(sim.player.state).toBe('normal');
    expect(sim.world.baseGround(sim.player.pos.x, sim.player.pos.z)).toBeGreaterThan(WATER_Y);
  });
});

describe('Las Lomas County: the Magnolia Causeway, the Southgate Bridge and their mouths', () => {
  const mouth = (z: number) => ({ minX: L.bounds.landMinX, minZ: z - 8, maxX: L.bounds.cityMinX, maxZ: z + 8 });

  it('lays the mouths at road level through the promenade, the kerb either side', () => {
    for (const z of [-268, 268]) {
      expect(W.baseGround(-495, z)).toBe(0);
      expect(W.baseGround(-495, z - 7.9)).toBe(0);
      expect(W.baseGround(-495, z - 8.5)).toBe(CURB_H);
      expect(W.baseGround(-495, z + 8.5)).toBe(CURB_H);
      expect(W.isOnRoad(-495, z)).toBe(true);
    }
    expect(W.baseGround(-600, -268)).toBe(0);
    expect(W.baseGround(-600, -280)).toBe(0);
    expect(W.baseGround(-600, -290)).toBe(-8);
    expect(W.groundHeight(-600, 268)).toBe(0);
    expect(W.baseGround(-600, 268)).toBe(-8);
  });

  it('moves the four props out of the mouths, keeping their indices, 2 m and more off the road', () => {
    const moved = [3123, 3124, 3125, 3154];
    expect(moved.map((i) => L.props[i]!.kind)).toEqual(['lamp', 'tree', 'bench', 'lamp']);
    for (const z of [-268, 268]) {
      const r = mouth(z);
      const near = L.props.filter((p) => p.kind !== 'signal' && rectContains(r, p.x, p.z, 2));
      expect(near).toEqual([]);
    }
    for (const i of moved) expect(rectGap(mouth(L.props[i]!.z < 0 ? -268 : 268), L.props[i]!.x, L.props[i]!.z)).toBeGreaterThanOrEqual(2);
  });

  it('stands signal heads for the gateways\' eastbound approaches and every approach of the county\'s junctions', () => {
    const heads = L.props.slice(L.country.firstProp).filter((p) => p.kind === 'signal');
    const at = (node: number, dir: number) => heads.filter((p) => p.node === node && p.dir === dir).length;
    expect(at(roads.node(0, 2).id, 1)).toBe(1);
    expect(at(roads.node(0, 8).id, 1)).toBe(1);
    for (const n of outerNodes.filter((o) => o.signal)) {
      for (let d = 0; d < 4; d++) expect(at(n.id, (d + 2) % 4), `node ${n.id} arm ${d}`).toBe(n.neighbors[d]! >= 0 ? 1 : 0);
    }
    expect(heads.length).toBe(2 + 4 + 3 + 3);
    // Lamps along both of the causeway's verges.
    const lamps = L.props.slice(L.country.firstProp).filter((p) => p.kind === 'lamp' && rectContains(CAUSEWAY, p.x, p.z));
    expect(lamps.length).toBe(12);
    expect(lamps.every((p) => p.y === 0 && !W.isOnRoad(p.x, p.z))).toBe(true);
  });

  it('builds the county\'s colliders after every older one: the bridge\'s parapets and its props', () => {
    const first = L.country.firstProp;
    const ids = L.props.slice(first).map((_p, k) => W.propColliders[first + k]!);
    expect(Math.min(...ids)).toBeGreaterThan(4574);
    const parapets = W.grid.colliders.filter((c) => c.tag === 'wall' && rectContains(BRIDGE, c.cx, c.cz));
    expect(parapets.length).toBe(2);
    expect(parapets.every((c) => c.id > 4574 && c.maxX - c.minX === BRIDGE.maxX - BRIDGE.minX)).toBe(true);
  });

  it('sinks a car driven off the causeway\'s side', () => {
    const sim = makeSim({ seed: 5, police: false });
    const v = sim.spawnVehicle('sedan', -600, -262, 0);
    placeInCar(sim, v);
    step(sim, 4, input({ throttle: 1 }));
    expect(v.pos.z).toBeGreaterThan(CAUSEWAY.maxZ);
    expect(v.inWater).toBe(true);
  });

  it('lets a swimmer climb out onto the causeway\'s verge', () => {
    const sim = makeSim({ seed: 3, police: false });
    teleport(sim, -600, -246);
    step(sim, 0.5);
    expect(sim.player.state).toBe('swimming');
    step(sim, 6, input({ moveZ: 1, cameraYaw: Math.PI }));
    expect(sim.player.state).toBe('normal');
    expect(rectContains(CAUSEWAY, sim.player.pos.x, sim.player.pos.z)).toBe(true);
    expect(sim.player.pos.y).toBeCloseTo(0, 2);
  });

  it('stops a boat at both links', () => {
    for (const [z, heading, edge] of [[-200, Math.PI, CAUSEWAY.maxZ], [330, Math.PI, BRIDGE.maxZ]] as const) {
      const sim = makeSim({ seed: 9, police: false });
      const boat = sim.spawnVehicle('speedboat', -606, z, heading);
      boat.pos.y = WATER_Y;
      placeInCar(sim, boat);
      step(sim, 8, input({ throttle: 1 }));
      console.log(`[country_roads] a Marlin at the link from z ${z}: z ${boat.pos.z.toFixed(1)}, ${boat.speed.toFixed(1)} m/s`);
      expect(boat.pos.z).toBeGreaterThan(edge);
      expect(boat.speed).toBeLessThan(2);
    }
  });

  it('makes the promenade\'s edge across each mouth a crosswalk on the gateway\'s light, keeping its place on the spawn list', () => {
    const walk = W.walk;
    for (const [a, b, node, slot] of [[386, 387, roads.node(0, 2).id, 365], [424, 425, roads.node(0, 8).id, 377]] as const) {
      expect(walk.edge(a, b)).toMatchObject({ crosswalk: true, axis: 'EW', roadNode: node });
      expect(walk.edge(b, a)).toMatchObject({ crosswalk: true, axis: 'EW', roadNode: node });
      expect(walk.walkEdges[slot]).toEqual([a, b]);
    }
    // Walkers reaching it from the south while Magnolia Ave and the causeway have their green wait at the kerb.
    const sim = makeSim({ seed: 4, police: false, ambient: false });
    const node = roads.node(0, 2).id;
    const at = walk.nodes[386]!;
    while (sim.roads.signalState(node, 'EW', sim.time) !== 'green' || sim.roads.signalState(node, 'EW', sim.time + 6) !== 'green') sim.time += 0.5;
    const walkers = [0, 1, 2, 3, 4, 5, 6, 7].map(() => {
      const c = sim.spawnCharacter('civilian', at.x, at.z + 0.5);
      c.brain = makeBrain('wander');
      c.brain.fromNode = 370;
      c.brain.toNode = 386;
      return c;
    });
    let onCrossing = 0;
    step(sim, 5, () => {
      onCrossing += walkers.filter((c) => c.pos.z > at.z + 2.5).length;
      return input();
    });
    expect(walkers.some((c) => c.brain!.mode === 'cross' && c.brain!.toNode === 387)).toBe(true);
    expect(onCrossing).toBe(0);
  });

  it('keeps CROSSWALK_W between the gateways\' boxes and the county\'s first lanes', () => {
    for (const z of [-268, 268]) {
      const lane = outerLanes.find((l) => l.from === roads.node(0, z < 0 ? 2 : 8).id)!;
      expect(lane.sx).toBeCloseTo(-470 - 8 - CROSSWALK_W, 9);
    }
  });

  it('closes no city water deeper than a boat floats: the sound deep either side of both links', () => {
    for (const z of [-300, -230, 240, 300]) expect(W.waterDepth(-606, z)).toBeGreaterThan(SWIM_DEPTH);
  });
});
