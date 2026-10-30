// Authored time trials resolved onto San Azura's actual road graph. Every gate
// sits at a connected intersection; there are no straight lines through blocks.

import type { Axis, RoadNetwork } from '../world/roads';

export const STREET_RUN_IDS = ['magnolia', 'coastline', 'dockside'] as const;
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

interface CourseDesign {
  id: StreetRunId;
  name: string;
  description: string;
  corners: readonly (readonly [number, number])[];
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
 * The junctions held green for a racer whose next gate is `checkpoint` (gate k is at course.nodes[k + 1]): the next
 * GREEN_WAVE_GATES course junctions still ahead, each along the axis the course comes into it on (the first time,
 * if the course passes a junction twice). Unsignalised junctions have nothing to hold.
 */
export function greenWave(course: StreetRunCourse, roads: RoadNetwork, checkpoint: number): Array<{ nodeId: number; axis: Axis }> {
  const out: Array<{ nodeId: number; axis: Axis }> = [];
  for (let k = checkpoint + 1; k <= checkpoint + GREEN_WAVE_GATES && k < course.nodes.length; k++) {
    const nodeId = course.nodes[k]!;
    const node = roads.nodes[nodeId]!;
    if (!node.signal || out.some((h) => h.nodeId === nodeId)) continue;
    const first = course.nodes.indexOf(nodeId, 1);
    const previous = roads.nodes[course.nodes[first - 1]!]!;
    out.push({ nodeId, axis: previous.i === node.i ? 'NS' : 'EW' });
  }
  return out;
}

export function buildStreetRunCourses(roads: RoadNetwork): StreetRunCourse[] {
  return DESIGNS.map((design) => {
    const nodes = [roads.id(...design.corners[0]!)];
    // Explicit orthogonal segments keep each course's pacing authored rather
    // than allowing a shortest-path tie to move a turn to a different street.
    for (let segment = 1; segment < design.corners.length; segment++) {
      let [i, j] = design.corners[segment - 1]!;
      const [toI, toJ] = design.corners[segment]!;
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
      const previous = roads.nodes[nodes[index - 1]!]!;
      const next = roads.nodes[nodes[index + 1] ?? nodes[1]!]!;
      const inDir = Math.atan2(node.x - previous.x, node.z - previous.z);
      const outDir = Math.atan2(next.x - node.x, next.z - node.z);
      const turn = Math.atan2(Math.sin(outDir - inDir), Math.cos(outDir - inDir));
      const road = next.i === node.i ? roads.layout.vLines[node.i]! : roads.layout.hLines[node.j]!;
      const instruction = Math.abs(turn) < 0.1 ? 'Straight' : turn < 0 ? 'Right' : 'Left';
      // The whole junction box plus 3 m: a tight inside line through a corner passes near the box's corner.
      checkpoints.push({ x: node.x, z: node.z, radius: Math.hypot(node.halfX, node.halfZ) + 3, label: `${instruction} · ${road.name}`, nodeId: node.id });
      distance += Math.hypot(node.x - px, node.z - pz);
      px = node.x;
      pz = node.z;
    }
    checkpoints.push({ x: start.x, z: start.z, radius: 8, label: 'Finish', nodeId: nodes[0]! });
    distance += Math.hypot(start.x - px, start.z - pz);
    return { ...design, start, checkpoints, nodes, distance: Math.round(distance) };
  });
}
