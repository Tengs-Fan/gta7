// Authored time trials resolved onto San Azura's actual road graph. Every gate
// sits at a connected intersection; there are no straight lines through blocks.

import type { CountyJunction } from '../world/country';
import { axisOf, type Axis, type RoadNetwork } from '../world/roads';

export const STREET_RUN_IDS = ['magnolia', 'coastline', 'dockside', 'laslomas'] as const;
export type StreetRunId = typeof STREET_RUN_IDS[number];
export type StreetRunMedal = 'bronze' | 'silver' | 'gold';

export interface StreetRunCheckpoint {
  x: number;
  z: number;
  radius: number;
  label: string;
  nodeId: number;
}

export interface StreetRunCourse {
  id: StreetRunId;
  name: string;
  description: string;
  distance: number;
  gold: number;
  silver: number;
  bronze: number;
  /** Cash for a gold finish. Silver pays 70%, bronze 45%. */
  reward: number;
  start: { x: number; z: number; heading: number };
  checkpoints: readonly StreetRunCheckpoint[];
  /** Connected node sequence, including the start node again at the end. */
  nodes: readonly number[];
}

/**
 * Bends of Las Lomas County's roads a course may name as corners: the apexes of the Lomas Highway's two curves round
 * the west of the county (each curve's middle vertex). Between the Hollister T and the Creek T the highway runs 1.1 km
 * round them, and without a gate there a U-turn back through Dry Creek and down Creek Road (0.8 km), or a line across
 * the fields (0.6 km), would cut it; through gates at both apexes a line across the fields saves only about 45 m on the
 * road's own racing line.
 */
const COUNTY_BENDS = {
  'northwest curve': [-1277.3, -215.3],
  'southwest curve': [-1294.9, 214.4],
} as const;
type CountyBend = keyof typeof COUNTY_BENDS;

/** A course's corner: a grid junction (i, j), or one of Las Lomas County's junctions or gated bends by name. */
type Waypoint = readonly [number, number] | CountyJunction | CountyBend;

interface CourseDesign {
  id: StreetRunId;
  name: string;
  description: string;
  /**
   * The corners in order: between two grid corners the course runs along the lines (one straight, then the other); to or
   * from a county junction or bend it takes the shortest way on (roads.findRoute), never back the way it came.
   */
  corners: readonly Waypoint[];
  gold: number;
  silver: number;
  bronze: number;
  reward: number;
}

// Medal times come from the course bot's laps with whole-junction gates and the green wave: about 35, 40 and 39 s
// through an empty city, a median 1-4 s slower through traffic. Gold asks for at most a 20 m/s average (1.35-1.6 times
// the bot's clear lap), silver allows a lift or two, bronze a crash.
const DESIGNS: readonly CourseDesign[] = [
  {
    id: 'magnolia', name: 'Magnolia Rush',
    description: 'Wide avenues, four fast corners. Find your rhythm through the city.',
    corners: [[5, 2], [8, 2], [8, 5], [5, 5], [5, 2]],
    gold: 55, silver: 70, bronze: 95, reward: 1000,
  },
  {
    id: 'coastline', name: 'Coastline Circuit',
    description: 'Open the throttle on Ocean Drive, then bring it home along Sunset.',
    corners: [[8, 2], [10, 2], [10, 7], [8, 7], [8, 2]],
    gold: 65, silver: 85, bronze: 115, reward: 1400,
  },
  {
    id: 'dockside', name: 'Dockside Switchback',
    description: 'A technical run through the docks and twice over the canal. Brake early and link the turns.',
    corners: [[2, 8], [5, 8], [5, 9], [4, 9], [4, 10], [2, 10], [2, 8]],
    gold: 52, silver: 66, bronze: 90, reward: 1250,
  },
];

/**
 * Las Lomas County's: west along Magnolia Ave and over the Magnolia Causeway, through Dry Creek and round the Lomas
 * Highway, through the apexes of its two curves out west, home over the Southgate Bridge and north up Vista Ave. Its
 * medal times come from the course bot's lap through an empty world (street_runs.test.ts: about 106 s over 3 km), at
 * the city's margins: gold asks for at most a 20 m/s average (1.46 times the bot's lap), silver and bronze as far
 * behind it as the city's are behind theirs.
 */
const COUNTY_DESIGNS: readonly CourseDesign[] = [
  {
    id: 'laslomas', name: 'Las Lomas Loop',
    description: 'Out to the farms and back. Mind the cows; they have the right of way and they know it.',
    corners: [[2, 2], [0, 2], 'drycreek', 'hollister', 'northwest curve', 'southwest curve', 'creek', [0, 8], [2, 8], [2, 2]],
    gold: 155, silver: 198, bronze: 270, reward: 2200,
  },
];

/** A compact, stable race clock for both HUD and saved personal bests. */
export function formatRunTime(seconds: number): string {
  const tenths = Math.max(0, Math.floor(seconds * 10 + 1e-6));
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

export function runMedal(course: StreetRunCourse, seconds: number): StreetRunMedal | null {
  if (seconds <= 0 || seconds > course.bronze) return null;
  if (seconds <= course.gold) return 'gold';
  return seconds <= course.silver ? 'silver' : 'bronze';
}

/** How many course junctions ahead of the racer the green wave holds. */
export const GREEN_WAVE_GATES = 2;

/**
 * The junctions held green for a racer whose next gate is `checkpoint`: the next GREEN_WAVE_GATES gates' junctions (the
 * finish line's aside), each along the axis the course comes into it on (the first time, if the course passes a
 * junction twice). Unsignalised junctions have nothing to hold.
 */
export function greenWave(course: StreetRunCourse, roads: RoadNetwork, checkpoint: number): Array<{ nodeId: number; axis: Axis }> {
  const out: Array<{ nodeId: number; axis: Axis }> = [];
  for (let k = checkpoint; k < checkpoint + GREEN_WAVE_GATES && k < course.checkpoints.length - 1; k++) {
    const nodeId = course.checkpoints[k]!.nodeId;
    const node = roads.nodes[nodeId]!;
    if (!node.signal || out.some((h) => h.nodeId === nodeId)) continue;
    const first = course.nodes.indexOf(nodeId, 1);
    const previous = roads.nodes[course.nodes[first - 1]!]!;
    out.push({ nodeId, axis: axisOf(roads.lanesBetween(previous.id, nodeId)[0]!.dir) });
  }
  return out;
}

/** The city's three courses (the county's: buildCountyRunCourses). */
export function buildStreetRunCourses(roads: RoadNetwork): StreetRunCourse[] {
  return DESIGNS.map((design) => buildCourse(roads, design));
}

/** Las Lomas County's course, through the city's gateways. */
export function buildCountyRunCourses(roads: RoadNetwork): StreetRunCourse[] {
  return COUNTY_DESIGNS.map((design) => buildCourse(roads, design));
}

/** Every course: the city's, then the county's. */
export function allStreetRunCourses(roads: RoadNetwork): StreetRunCourse[] {
  return [...buildStreetRunCourses(roads), ...buildCountyRunCourses(roads)];
}

function buildCourse(roads: RoadNetwork, design: CourseDesign): StreetRunCourse {
  const named = (w: Waypoint): w is CountyBend => typeof w === 'string' && w in COUNTY_BENDS;
  // A named bend is the county's node nearest its point.
  const bend = ([x, z]: readonly [number, number]) => roads.nodes.slice(roads.gridNodeCount).reduce((a, b) => (Math.hypot(b.x - x, b.z - z) < Math.hypot(a.x - x, a.z - z) ? b : a)).id;
  const at = (w: Waypoint) => (named(w) ? bend(COUNTY_BENDS[w]) : typeof w === 'string' ? roads.junction(w).id : roads.id(...w));
  const gated = new Set(design.corners.filter(named).map(at));
  const nodes = [at(design.corners[0]!)];
  // Explicit orthogonal segments keep each course's pacing authored rather
  // than allowing a shortest-path tie to move a turn to a different street.
  for (let segment = 1; segment < design.corners.length; segment++) {
    const from = design.corners[segment - 1]!;
    const to = design.corners[segment]!;
    if (typeof from === 'string' || typeof to === 'string') {
      nodes.push(...roads.findRoute(nodes[nodes.length - 1]!, at(to), nodes[nodes.length - 2] ?? -1)!.slice(1));
      continue;
    }
    let [i, j] = from;
    const [toI, toJ] = to;
    while (i !== toI || j !== toJ) {
      if (i !== toI) i += Math.sign(toI - i);
      else j += Math.sign(toJ - j);
      nodes.push(roads.id(i, j));
    }
  }
  const lane = roads.lanesBetween(nodes[0]!, nodes[1]!)[0]!;
  // On a legal lane, beyond the crosswalk. Finishing here gives the player a
  // full loop and leaves the same course nearest when T is pressed to retry.
  const start = { x: lane.sx + lane.dx * 12, z: lane.sz + lane.dz * 12, heading: lane.heading };
  const checkpoints: StreetRunCheckpoint[] = [];
  let distance = 0;
  let px = start.x;
  let pz = start.z;
  for (let index = 1; index < nodes.length; index++) {
    const node = roads.nodes[nodes[index]!]!;
    distance += Math.hypot(node.x - px, node.z - pz);
    px = node.x;
    pz = node.z;
    // A gate at every junction: a county road's bends have none but those the design names.
    if (roads.isBend(node) && !gated.has(node.id)) continue;
    const previous = roads.nodes[nodes[index - 1]!]!;
    const next = roads.nodes[nodes[index + 1] ?? nodes[1]!]!;
    const inDir = Math.atan2(node.x - previous.x, node.z - previous.z);
    const outDir = Math.atan2(next.x - node.x, next.z - node.z);
    const turn = Math.atan2(Math.sin(outDir - inDir), Math.cos(outDir - inDir));
    const road = roads.lanesBetween(node.id, next.id)[0]!.line;
    const instruction = Math.abs(turn) < 0.1 ? 'Straight' : turn < 0 ? 'Right' : 'Left';
    // The whole junction box plus 3 m: a tight inside line through a corner passes near the box's corner. At a bend,
    // the road's whole width and 3 m either side.
    checkpoints.push({ x: node.x, z: node.z, radius: (roads.isBend(node) ? road.width / 2 : Math.hypot(node.halfX, node.halfZ)) + 3, label: `${instruction} · ${road.name}`, nodeId: node.id });
  }
  checkpoints.push({ x: start.x, z: start.z, radius: 8, label: 'Finish', nodeId: nodes[0]! });
  distance += Math.hypot(start.x - px, start.z - pz);
  return { ...design, start, checkpoints, nodes, distance: Math.round(distance) };
}
