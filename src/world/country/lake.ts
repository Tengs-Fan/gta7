// Lake Lomas's shore (world/country/lakeland.ts): the fishing dock with the dinghies moored at its T-head, a pull-out and
// the lanes in from the Valley Loop, four cabins on the north-east shore with porch lamps, the campground on the south-east
// shore (tents, a fire ring and its campfire, a camper van, a pit toilet), picnic tables, the signs, an overturned
// rowboat, reeds in the shallows and the ducks and loons on the water.

import { Rng } from '../../core/rng';
import { mkRect, type CityLayout, type Rect, type Side } from '../layout';
import { countryGround, LAKE_NAME } from './index';
import { blocked, loopX, nextBuildingId, type CountyLakeland, type Keepout, type LakeCabin, type Tent } from './lakeland';

/** The dock's deck height (m): the Marina's piers' (a metre and a half over the lake). */
export const DOCK_Y = 0.45;

/** The dock: a walkway out from the shore, 34 m, and a T-head across its end. The head is 12 m beyond the water's edge. */
const DOCK_WALK = mkRect(-1896, -276.2, -1862, -273.8);
const DOCK_HEAD = mkRect(-1900, -286, -1894, -264);

/** The cabins, west to east along the north shore: centre x and z, and the size (x by z) of each. Their porches face south, to the lake. */
const CABINS: ReadonlyArray<readonly [x: number, z: number, w: number, d: number, tint: number]> = [
  [-1962, -328, 7.2, 5.4, 0.1],
  [-1936, -326, 6.4, 5.0, 0.55],
  [-1910, -325, 7.6, 5.4, 0.8],
  [-1884, -329, 6.8, 5.2, 0.3],
];
const EAVES = 2.7;
const RIDGE = 4.7;
const PORCH_D = 2.0;

/** The camp's fire and the ring of stones round it. */
const FIRE = { x: -1919, z: -196 } as const;
const RING_R = 1.0;

/** Reed beds: centre x, z and radius of the shore they grow along. */
const REED_BEDS: ReadonlyArray<readonly [number, number, number]> = [
  [-2108, -331, 24],
  [-2149, -287, 22],
  [-2070, -161, 20],
  [-2078, -398, 18],
  [-1965, -168, 20],
  [-1960, -300, 22],
  [-1930, -242, 22],
  [-2128, -243, 18],
  [-1884, -300, 10],
];

/** The ducks and loons: where they swim and how fast. */
const FOWL: ReadonlyArray<readonly ['duck' | 'loon', number, number, number, number, number, number]> = [
  ['duck', -1946, -272, 22, 12, 0.07, 0],
  ['duck', -1946, -272, 22, 12, 0.07, 0.35],
  ['duck', -1946, -272, 22, 12, 0.07, 0.42],
  ['duck', -2078, -368, 5, 10, 0.09, 1.2],
  ['duck', -2078, -368, 5, 10, 0.09, 1.5],
  ['loon', -2052, -283, 34, 14, 0.04, 2.1],
  ['loon', -2052, -283, 34, 14, 0.04, 2.55],
  ['loon', -2092, -262, 22, 9, 0.05, 4.0],
];

/** The road's west edge at z, nudged 0.3 m inside it so a lane's dirt meets the asphalt. */
const edgeAt = (z: number): number => loopX(z) - 5 + 0.3;

export function buildLake(layout: CityLayout, land: CountyLakeland, rng: Rng, keep: Keepout): void {
  const country = layout.country;
  const solids = country.places.solids;
  const ground = (x: number, z: number) => countryGround(country, x, z);
  const box = (rect: Rect, y0: number, y1: number, tag: 'wall' | 'building' | 'bench' | 'rock' | 'pillar' | 'lamp') => solids.push({ rect, y0, y1, tag });
  const round = (x: number, z: number, r: number, y0: number, y1: number, tag: 'wall' | 'rock' | 'pillar' | 'lamp') => solids.push({ rect: mkRect(x - r, z - r, x + r, z + r), y0, y1, tag, round: true });

  // The dock: two piers on the lake (the city draws them with their pilings), and a lamp on a post at the head's end.
  layout.decks.push({ rect: DOCK_WALK, y: DOCK_Y, name: LAKE_NAME, bridge: false }, { rect: DOCK_HEAD, y: DOCK_Y, name: LAKE_NAME, bridge: false });
  const lamp = { x: DOCK_HEAD.minX + 0.4, y: DOCK_Y, z: DOCK_HEAD.minZ + 0.5 };
  land.dock = { walk: DOCK_WALK, head: DOCK_HEAD, y: DOCK_Y, lamp };
  round(lamp.x, lamp.z, 0.1, DOCK_Y, DOCK_Y + 2.8, 'lamp');
  keep.rects.push(mkRect(DOCK_WALK.minX - 8, DOCK_HEAD.minZ - 8, DOCK_WALK.maxX + 6, DOCK_HEAD.maxZ + 8));

  // The pull-out by the dock's root and the lanes in from the Valley Loop's east side: to the pull-out, along the cabins, to the camp.
  const pull = mkRect(-1864, -285, -1832, -265);
  const cabinZ = -337;
  const campZ = -188;
  const lakeLane = [edgeAt(-275), -275, -1834, -275];
  const cabinLane = [edgeAt(cabinZ), cabinZ, -1860, -336, -1900, -335, -1945, -336, -1985, -338];
  const campLane = [edgeAt(campZ), campZ, -1860, -190, -1890, -192, -1912, -195];
  land.lanes.push({ pts: lakeLane, width: 6 }, { pts: cabinLane, width: 4 }, { pts: campLane, width: 4 });
  land.pads.push(pull);
  keep.rects.push(pull);
  for (const l of land.lanes) keep.lines.push({ pts: l.pts, r: l.width / 2 + 2 });

  // The cabins: log walls, a gable roof, a porch along the south front with a lamp on its post by the door.
  CABINS.forEach(([x, z, w, d, tint], k) => {
    const rect = mkRect(x - w / 2, z - d / 2, x + w / 2, z + d / 2);
    const id = nextBuildingId(layout);
    layout.buildings.push({
      id, rect, height: RIDGE, tiers: [{ ...rect, y0: 0, y1: EAVES }], style: 'house', roof: 'gable', tint, district: 'country', roofProps: [],
      sign: null, special: null, ground: 'none', groundH: 0, groundSides: [],
    });
    const porch = mkRect(rect.minX, rect.maxZ, rect.maxX, rect.maxZ + PORCH_D);
    const front: Side = 'S';
    const cabin: LakeCabin = { building: id, rect, front, porch, lamp: { x: rect.minX + 0.5 + (k % 2) * (w - 1), y: 2.1, z: porch.maxZ - 0.2 } };
    land.cabins.push(cabin);
    keep.rects.push(mkRect(rect.minX - 3, rect.minZ - 3, rect.maxX + 3, porch.maxZ + 4));
  });

  // The campground: a gravel pad with the fire in its middle, three tents, the van, the toilet and two picnic tables.
  const camp = land.camp;
  camp.fire = { x: FIRE.x, z: FIRE.z, y: ground(FIRE.x, FIRE.z) };
  camp.ring = RING_R;
  camp.pad = mkRect(FIRE.x - 16, FIRE.z - 14, FIRE.x + 18, FIRE.z + 14);
  land.pads.push(camp.pad);
  keep.rects.push(mkRect(camp.pad.minX - 3, camp.pad.minZ - 3, camp.pad.maxX + 3, camp.pad.maxZ + 3));
  round(FIRE.x, FIRE.z, RING_R, 0, 0.5, 'rock');
  const tents: Array<[Tent['kind'], number, number, number]> = [
    ['ridge', FIRE.x - 10, FIRE.z - 6, Math.PI / 2],
    ['dome', FIRE.x - 7, FIRE.z + 9, Math.PI],
    ['family', FIRE.x + 6, FIRE.z + 10, Math.PI],
  ];
  for (const [kind, x, z, rot] of tents) {
    camp.tents.push({ kind, x, z, rot });
    const alongX = Math.abs(Math.sin(rot)) > 0.7;
    if (kind === 'dome') round(x, z, 1.55, 0, 1.4, 'wall');
    else {
      const [l, w, h] = kind === 'ridge' ? [3.2, 2.3, 1.6] : [4.6, 3.6, 2.1];
      const [hx, hz] = alongX ? [l / 2, w / 2] : [w / 2, l / 2];
      box(mkRect(x - hx, z - hz, x + hx, z + hz), 0, h, 'wall');
    }
  }
  camp.van = { x: FIRE.x + 13, z: FIRE.z - 8.5, rot: -Math.PI / 2 };
  box(mkRect(camp.van.x - 2.6, camp.van.z - 1.05, camp.van.x + 2.6, camp.van.z + 1.05), 0, 2.2, 'wall');
  camp.toilet = { x: FIRE.x + 19, z: FIRE.z + 12, rot: -Math.PI / 2 };
  box(mkRect(camp.toilet.x - 0.75, camp.toilet.z - 0.75, camp.toilet.x + 0.75, camp.toilet.z + 0.75), 0, 2.4, 'wall');
  camp.logs = [
    { x: FIRE.x - 2.6, z: FIRE.z + 0.4, rot: Math.PI / 2 },
    { x: FIRE.x + 0.6, z: FIRE.z + 2.6, rot: 0.15 },
    { x: FIRE.x + 2.4, z: FIRE.z - 1.2, rot: Math.PI / 2 + 0.2 },
  ];
  const tableAt = (x: number, z: number, rot: number) => {
    land.tables.push({ x, z, rot });
    const alongX = Math.abs(Math.cos(rot)) > 0.7;
    const [hx, hz] = alongX ? [1.0, 1.05] : [1.05, 1.0];
    box(mkRect(x - hx, z - hz, x + hx, z + hz), 0, 0.8, 'wall');
  };
  tableAt(FIRE.x + 6, FIRE.z - 7, 0);
  tableAt(FIRE.x - 1, FIRE.z - 9, Math.PI / 2);
  tableAt(-1858, -259, Math.PI / 2);
  tableAt(-1856, -292, 0);
  tableAt(-1944, -316, 0);

  // An overturned rowboat on the beach by the dock, its bottom up.
  land.rowboat = { x: -1873, z: -258, rot: 0.25 };
  box(mkRect(land.rowboat.x - 1.9, land.rowboat.z - 1.2, land.rowboat.x + 1.9, land.rowboat.z + 1.2), 0, 0.8, 'wall');

  // The signs.
  const gap = (z: number) => loopX(z) - 5 - 3;
  land.signs.push(
    { id: 'lake', x: gap(-262), z: -262, rot: Math.PI / 2, lines: ['LAKE LOMAS', 'DOCK · CABINS · CAMPING', 'QUIET PLEASE. THE LOONS ARE LISTENING.'] },
    { id: 'swim', x: -1868.5, z: -270.5, rot: Math.PI / 2, lines: ['LAKE LOMAS: NO SWIMMING', '(WE MEAN IT)'] },
    { id: 'camp', x: gap(campZ - 4), z: campZ - 4, rot: Math.PI / 2, lines: ['LOMAS LAKESIDE CAMP', 'QUIET HOURS 10 PM TO 6 AM', 'BEARS: ALL DAY'] },
    { id: 'fire', x: FIRE.x - 4.5, z: FIRE.z - 3.2, rot: Math.PI / 4, lines: ['FIRE RING', 'BYO MARSHMALLOWS'] },
  );

  // Reeds in the shallows, thickest along the bays and the inlets, none by the dock, the beach by the pull-out or the camp's shore.
  for (const [cx, cz, r] of REED_BEDS) {
    for (let i = 0, n = Math.round(r * r * 0.45); i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * r;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const y = ground(x, z);
      const h = rng.range(1.5, 2.7);
      const blades = rng.int(5, 9);
      const lean = rng.range(-0.18, 0.18);
      if (y > -0.12 || y < -0.9 || blocked(keep, x, z, 3)) continue;
      land.reeds.push({ x, y, z, h, blades, lean });
    }
  }

  for (const [kind, cx, cz, rx, rz, speed, phase] of FOWL) land.waterfowl.push({ kind, cx, cz, rx, rz, speed, phase });
}
