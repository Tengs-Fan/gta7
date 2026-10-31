// Offshore: Turbine Row, ten wind turbines standing in the sea north of the city, and Smuggler's Key, a rocky island off
// the mouth of Northshore Bay with the ruins of Fort Contraband on it. A post-pass over the finished layout
// (generateCity runs it after assignGroundFloors): it only appends props, ground, a deck and a headland, and draws from
// its own generator, so every prop index and every draw of the shared generator stays what it was.

import { Rng } from '../core/rng';
import { CURB_H, WATER_Y } from './constants';
import { addProp, hashInts, mkRect, rectsMinus, type CityLayout, type Rect } from './layout';

/** A wall of the ruined battery: a box standing on the Key from y0 up to y1. */
export interface OffshoreSolid extends Rect {
  y0: number;
  y1: number;
}

/** What the Key holds besides its props: the walls StaticWorld makes solid, and what the renderer and the pickups place. */
export interface Offshore {
  solids: OffshoreSolid[];
  /** The battery's guns in their embrasures, `rot` the heading they point along. */
  cannons: Array<{ x: number; z: number; rot: number }>;
  /** Fishing boats wrecked on the rocks: the moored boat's model at (x, y, z), turned by rot, rolled and pitched. */
  wrecks: Array<{ x: number; y: number; z: number; rot: number; roll: number; pitch: number }>;
  /** Signboards, their lines top to bottom, facing along rot. */
  signs: Array<{ lines: string[]; x: number; z: number; rot: number }>;
  /** The smugglers' stash in the ruins (sim/pickups.ts). */
  stash: Array<{ what: 'rifle' | 'armor'; x: number; z: number }>;
}

export const KEY_NAME = "Smuggler's Key";

/** Hub height above the water (m) and rotor radius of a turbine (render/turbines.ts draws them so). */
export const TURBINE_HUB = 70;
export const TURBINE_ROTOR = 40;
/** The tower's radius at the waterline (m), its collider's. */
export const TURBINE_BASE = 2.6;

/**
 * Turbine Row: two rows of five, 112 m apart along each row and staggered by half of that, the near row 274 m off the
 * north shore. Within 400 m of it, well inside the daytime fog, and 110 m clear of the Key.
 */
const TURBINE_ROWS: ReadonlyArray<{ z: number; x: readonly number[] }> = [
  { z: -790, x: [700, 588, 476, 364, 252] },
  { z: -905, x: [644, 532, 420, 308, 196] },
];

/** The Key: a body of rock and turf, and a knoll to its north where the battery stands. */
const KEY_RECTS: readonly Rect[] = [mkRect(215, -660, 285, -610), mkRect(230, -680, 270, -655)];

/** Fort Contraband's ground plan: the yard inside its walls. */
const FORT = mkRect(232, -676, 268, -640);
const WALL_T = 0.8;

export function buildOffshore(layout: CityLayout): void {
  const rng = new Rng(hashInts(layout.seed, 0x6b3));
  for (const row of TURBINE_ROWS) for (const x of row.x) addProp(layout, 'turbine', x, row.z, 0, 1, WATER_Y);

  layout.headlands.push({ name: KEY_NAME, y: CURB_H, rects: [...KEY_RECTS] });
  // Turf over the rock; bare dirt in the fort's yard and along the path down to the jetty.
  const path = mkRect(247, FORT.maxZ, 253, -610);
  const [body, knoll] = KEY_RECTS as [Rect, Rect];
  const land = [body, mkRect(knoll.minX, knoll.minZ, knoll.maxX, body.minZ)];
  for (const r of rectsMinus(land, [FORT, path])) layout.ground.push({ rect: r, kind: 'grass' });
  layout.ground.push({ rect: FORT, kind: 'dirt' }, { rect: path, kind: 'dirt' });

  // The battery's walls, broken down to between 1 and 2.5 m: two embrasures for the guns on the seaward side, breaches
  // in the flanks, a gateway towards the jetty, and the shell of a powder magazine in the yard.
  const o = layout.offshore;
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = FORT;
  const wall = (ax: number, az: number, bx: number, bz: number, h: number) => o.solids.push({ ...mkRect(ax, az, bx, bz), y0: CURB_H, y1: CURB_H + h });
  wall(x0, z0, 241.5, z0 + WALL_T, 2.2);
  wall(244.5, z0, 255.5, z0 + WALL_T, 1.5);
  wall(258.5, z0, x1, z0 + WALL_T, 2.4);
  wall(x0, z0 + WALL_T, x0 + WALL_T, -663, 1.9);
  wall(x0, -658, x0 + WALL_T, z1 - WALL_T, 1.2);
  wall(x1 - WALL_T, z0 + WALL_T, x1, -667, 2.5);
  wall(x1 - WALL_T, -662.5, x1, z1 - WALL_T, 1);
  wall(x0, z1 - WALL_T, 245, z1, 1.4);
  wall(255, z1 - WALL_T, x1, z1, 1.1);
  wall(252, -660, 262, -660 + WALL_T, 2);
  wall(262 - WALL_T, -660 + WALL_T, 262, -652, 1.8);
  wall(252, -660 + WALL_T, 252 + WALL_T, -655, 1.3);
  o.cannons.push({ x: 243, z: z0 + 2.4, rot: Math.PI }, { x: 257, z: z0 + 2.4, rot: Math.PI });
  o.stash.push({ what: 'rifle', x: 257, z: -656 }, { what: 'armor', x: 238, z: -647 });
  o.signs.push(
    { lines: ['FORT CONTRABAND', 'EST. 1887. DECOMMISSIONED 1888.', 'REASONS CLASSIFIED.'], x: 241, z: z1 + 1.2, rot: 0 },
    { lines: ['PRIVATE ISLAND.', 'TRESPASSERS WILL BE', 'MILDLY JUDGED.'], x: 255.5, z: -611.5, rot: 0 },
  );
  // A fishing boat that came in too fast, up on the rocks off the Key's east side.
  o.wrecks.push({ x: 287.5, y: WATER_Y + 0.5, z: -629, rot: 0.35, roll: 0.42, pitch: -0.07 });

  // Three palms bent by the sea wind, and the jetty on the bay side with a lamp at its end.
  for (const [x, z] of [[220, -653], [279, -655], [223, -616]] as const) addProp(layout, 'palm', x, z, rng.range(0, Math.PI * 2), rng.range(0.95, 1.25));
  layout.decks.push({ rect: mkRect(248, -612, 252, -586), y: 0.45, name: KEY_NAME, bridge: false });
  addProp(layout, 'lamp', 251.4, -588.5, -Math.PI / 2, 1, 0.45);
}
