// Las Lomas County's places (docs/map.md, "Las Lomas: roads outside the grid"): Dry Creek, the crossroads town with the
// county's one traffic light, the Moonbeam Drive-In on the shore of Lomas Sound and the Gravel Gulch dirt track. Pure
// data, no rendering. buildPlaces is the last of the county's content passes and only
// appends: its stores are buildings of district 'country' (StaticWorld adds their colliders after every older one), then
// props, POIs, footpaths and parking bays, and the solids StaticWorld adds after the county's props. It draws nothing
// from the city's generator, and builds only in its own plots.

import { Rng } from '../../core/rng';
import type { AttractionSolid } from '../attractions';
import { addProp, hashInts, mkRect, type CityLayout, type FacadeStyle, type Poi, type Rect, type Side } from '../layout';
import { countryGround, MOUTH_CLEAR } from './index';

export type StoreKind = 'feed' | 'guns' | 'diner' | 'gas' | 'sheriff' | 'shop';

/** One of Dry Creek's stores: a building with a false front on its street side, a flat board rising over its gable. */
export interface Store {
  /** Its building's id. */
  building: number;
  name: string;
  kind: StoreKind;
  /** The street side, where its false front and its door are. */
  front: Side;
  /** The body behind the false front, under its gable, and the false front's top. */
  body: Rect;
  eaves: number;
  top: number;
}

export interface TownAnchors {
  stores: Store[];
  /** The boardwalks along the store fronts (timber decks at the ground's height). */
  boardwalks: Rect[];
  /** Packed dirt: Gas & Grits' forecourt, and the parking either side of Creek Road. */
  lots: Rect[];
  /** Gas & Grits: its four pumps (prop indices) and the canopy over them. */
  pumps: number[];
  canopy: Rect;
  /** The canopy's underside and its top. */
  canopyY: [number, number];
  /** The grain elevator: its silos in a row, the head house on top of them and the leg tower beside them, up to `top`. */
  elevator: { silos: Array<{ x: number; z: number }>; r: number; height: number; head: Rect; headTop: number; leg: Rect; top: number };
  /** The water tower: the tank on four legs. */
  tower: { x: number; z: number; r: number; legs: number; y0: number; y1: number };
  /** The World's Second-Largest Corn Cob and its plaque, which faces the main street. */
  cob: { x: number; z: number; r: number; height: number; plaque: { x: number; z: number } };
  /** The town's billboards (prop indices) and what each says. */
  billboards: Array<{ prop: number; lines: [string, string] }>;
  /** The diner's neon cow, on its roof facing the street. */
  neon: { x: number; z: number; y: number };
}

export interface DriveInAnchors {
  /** The screen, its face to the west: its frame's footprint (a solid), and the picture's edges and height. */
  frame: Rect;
  screen: { x: number; z0: number; z1: number; y0: number; y1: number };
  /** The lot the cars stand in (the horn's SHHH reaches across it), and the parking bays in arcs facing the screen. */
  lot: Rect;
  /** The bays' indices in layout.parking: from `first` up to (not including) `end`. */
  bays: { first: number; end: number };
  /** The speaker posts (prop indices), one between each pair of bays. */
  speakers: number[];
  /** The projection booth and the concession stand (solids), and the marquee by the gate on Creek Road. */
  booth: Rect;
  stand: Rect;
  marquee: { x: number; z: number; posts: [number, number] };
  /** The gravel drive from Creek Road to the gate. */
  drive: Rect;
}

/** A turn of the dirt track: its centre, radius and the bearings (radians from +x towards +z) it runs between. */
export interface TrackTurn {
  cx: number;
  cz: number;
  r: number;
  a0: number;
  a1: number;
}

export interface TrackAnchors {
  /** The track's centre line, a point at least every TRACK_STEP m round the lap from the start line and back to it. */
  line: Array<{ x: number; z: number }>;
  /** How far round the lap (m) each point of the line is. */
  at: number[];
  length: number;
  width: number;
  /**
   * A lap's gates: one at each turn's apex, then the start line. `at` is the point of the line its flags stand either
   * side of; an apex gate's centre is pushed out from it, so its reach (TRACK_GATE_R) ends at the track's inside edge.
   */
  gates: Array<{ x: number; z: number; at: number }>;
  /** Where the scramble starts, just past the start line facing on round. */
  start: { x: number; z: number; heading: number };
  turns: TrackTurn[];
  /** The whoops' and the tabletops' ramps (ids), and the tabletops' decks (in layout.decks). */
  ramps: number[];
  tables: Rect[];
  /** The dirt drive in from the Lomas Highway. */
  drive: Rect;
}

export interface CountyPlaces {
  /** The places' solids: StaticWorld adds them after the county's props. */
  solids: AttractionSolid[];
  town: TownAnchors;
  driveIn: DriveInAnchors;
  track: TrackAnchors;
}

/** The places before buildPlaces lays them down. */
export function noPlaces(): CountyPlaces {
  return {
    solids: [],
    town: {
      stores: [],
      boardwalks: [],
      lots: [],
      pumps: [],
      canopy: mkRect(0, 0, 0, 0),
      canopyY: [0, 0],
      elevator: { silos: [], r: 0, height: 0, head: mkRect(0, 0, 0, 0), headTop: 0, leg: mkRect(0, 0, 0, 0), top: 0 },
      tower: { x: 0, z: 0, r: 0, legs: 0, y0: 0, y1: 0 },
      cob: { x: 0, z: 0, r: 0, height: 0, plaque: { x: 0, z: 0 } },
      billboards: [],
      neon: { x: 0, z: 0, y: 0 },
    },
    driveIn: {
      frame: mkRect(0, 0, 0, 0),
      screen: { x: 0, z0: 0, z1: 0, y0: 0, y1: 0 },
      lot: mkRect(0, 0, 0, 0),
      bays: { first: 0, end: 0 },
      speakers: [],
      booth: mkRect(0, 0, 0, 0),
      stand: mkRect(0, 0, 0, 0),
      marquee: { x: 0, z: 0, posts: [0, 0] },
      drive: mkRect(0, 0, 0, 0),
    },
    track: { line: [], at: [], length: 0, width: 0, gates: [], start: { x: 0, z: 0, heading: 0 }, turns: [], ramps: [], tables: [], drive: mkRect(0, 0, 0, 0) },
  };
}

// ---------------------------------------------------------------------------
// Dry Creek

/**
 * Dry Creek round its crossroads at (-840, -268): the main street is the Lomas Highway (its kerbs at z -276 and -260),
 * the cross street Hollister Lane north and Creek Road south (kerbs at x -845 and -835). The verges (sidewalks.ts) run
 * 1.5 m off the kerbs: along the north kerb, up the east of Hollister Lane and down the west of Creek Road. North of the
 * main street the stores stand behind a boardwalk on the verge; south of it, behind nose-in parking and a boardwalk.
 */
const N_FRONT = -281;
const S_FRONT = -251;
/** The boardwalks' walking lines, and their decks' outer edges. */
const N_WALK = -279.5;
const S_WALK = -252.5;
const N_EDGE = -278;
const S_EDGE = -254;
/** The nose-in bays south of the main street: their centres' z, and the gap between them (above traffic's BAY_SPACING). */
const BAY_Z = -256.8;
const BAY_GAP = 3.6;
/** The verges' corners round the crossroads (sidewalks.ts: 1.5 m off the kerbs and the junction's box). */
const NW = [-849.5, -277.5] as const;
const NE = [-830.5, -277.5] as const;
const SW = [-846.5, -258.5] as const;
/** Across Creek Road and across the main street's east arm from the verges: the crosswalks the verges do not give. */
const SE_SOUTH = [-833.5, -258.5] as const;
const SE_EAST = [-830.5, -258.5] as const;

interface StoreDef {
  name: string;
  kind: StoreKind;
  x0: number;
  x1: number;
  depth: number;
  eaves: number;
  top: number;
  style: FacadeStyle;
}

/** The stores, west to east: the north row's fronts face south over the boardwalk, the south row's face north. */
const NORTH_ROW: readonly StoreDef[] = [
  { name: 'DRY CREEK FEED & SEED', kind: 'feed', x0: -904, x1: -874, depth: 18, eaves: 6.2, top: 9, style: 'warehouse' },
  { name: 'BANG BANG GUNS & BAIT', kind: 'guns', x0: -870, x1: -851, depth: 14, eaves: 4.8, top: 7.4, style: 'brick' },
  { name: "MOO-MOO'S DINER", kind: 'diner', x0: -829, x1: -810, depth: 13, eaves: 4.4, top: 6.4, style: 'stucco' },
];
const SOUTH_ROW: readonly StoreDef[] = [
  { name: 'PRAIRIE MERCANTILE', kind: 'shop', x0: -905, x1: -879, depth: 16, eaves: 5, top: 7.8, style: 'house' },
  { name: "SHERIFF'S OFFICE", kind: 'sheriff', x0: -875, x1: -853, depth: 14, eaves: 4.8, top: 7.2, style: 'house' },
  { name: 'HOLLOWAY HARDWARE', kind: 'shop', x0: -827, x1: -806, depth: 14, eaves: 5, top: 7.6, style: 'brick' },
  { name: 'THE RUSTY SPUR', kind: 'shop', x0: -802, x1: -779, depth: 15, eaves: 5.2, top: 8, style: 'house' },
];
/** Gas & Grits' kiosk, behind its forecourt, its front to the south. */
const KIOSK: StoreDef = { name: 'GAS & GRITS', kind: 'gas', x0: -801, x1: -781, depth: 11, eaves: 4, top: 5.6, style: 'stucco' };
const KIOSK_FRONT = -305;
/** The false front's slab, in front of the body. */
const FRONT_T = 0.4;

/** The forecourt's canopy and the pumps under it, two to each of two islands running north-south. */
const CANOPY = mkRect(-803, -297, -777, -283);
const CANOPY_Y: [number, number] = [4.8, 5.5];
const PUMPS: ReadonlyArray<readonly [number, number]> = [[-796, -287], [-796, -293], [-784, -287], [-784, -293]];
/** The canopy's posts, at the islands' ends. */
const CANOPY_POSTS: ReadonlyArray<readonly [number, number]> = [[-796, -284], [-796, -296], [-784, -284], [-784, -296]];

/** The bust station's door step is this far out from a store's front, on its boardwalk. */
const STEP = 1.5;

/** Where a bust at (x, z) walks out: SAPD Central anywhere on the city's land, else the nearest police station. */
export function bustStation(layout: CityLayout, x: number, z: number): Poi {
  const city = layout.pois.find((p) => p.id === 'police')!;
  if (x >= layout.bounds.landMinX) return city;
  return layout.pois.filter((p) => p.kind === 'police').reduce((best, p) => (Math.hypot(p.x - x, p.z - z) < Math.hypot(best.x - x, best.z - z) ? p : best));
}

/** Appends a store: its false front as tier 0 (a slab as tall as the front), its body as tier 1, under the gable. */
function addStore(layout: CityLayout, rng: Rng, d: StoreDef, front: Side, frontZ: number): Store {
  const north = front === 'S';
  const z0 = north ? frontZ - d.depth : frontZ;
  const z1 = north ? frontZ : frontZ + d.depth;
  const slab = north ? mkRect(d.x0, z1 - FRONT_T, d.x1, z1) : mkRect(d.x0, z0, d.x1, z0 + FRONT_T);
  const body = north ? mkRect(d.x0, z0, d.x1, z1 - FRONT_T) : mkRect(d.x0, z0 + FRONT_T, d.x1, z1);
  const id = layout.buildings.reduce((m, b) => Math.max(m, b.id), -1) + 1;
  layout.buildings.push({
    id, rect: mkRect(d.x0, z0, d.x1, z1), height: d.top, tiers: [{ ...slab, y0: 0, y1: d.top }, { ...body, y0: 0, y1: d.eaves }],
    style: d.style, roof: 'gable', tint: rng.next(), district: 'country', roofProps: [], sign: { text: d.name, color: '#f2e6c8', side: front },
    special: null, ground: 'none', groundH: 0, groundSides: [],
  });
  return { building: id, name: d.name, kind: d.kind, front, body, eaves: d.eaves, top: d.top };
}

function buildDryCreek(layout: CityLayout, rng: Rng, places: CountyPlaces): void {
  const country = layout.country;
  const town = places.town;
  const ground = (x: number, z: number) => countryGround(country, x, z);
  for (const d of NORTH_ROW) town.stores.push(addStore(layout, rng, d, 'S', N_FRONT));
  for (const d of SOUTH_ROW) town.stores.push(addStore(layout, rng, d, 'N', S_FRONT));
  town.stores.push(addStore(layout, rng, KIOSK, 'S', KIOSK_FRONT));
  const store = (kind: StoreKind) => town.stores.find((s) => s.kind === kind)!;
  const doorX = (s: Store) => (s.body.minX + s.body.maxX) / 2;

  // The boardwalks: before the north row from the town's west end to the verge's corner, and before the diner; before
  // the south row on either side of Creek Road.
  town.boardwalks.push(
    mkRect(-926, N_FRONT, NW[0], N_EDGE),
    mkRect(NE[0], N_FRONT, -808, N_EDGE),
    mkRect(-926, S_EDGE, SW[0] - 2, S_FRONT),
    mkRect(SE_EAST[0], S_EDGE, -777, S_FRONT),
  );
  // Their walking lines spawn people, a node at least every 26 m; short links join them to the verges' corners, and the
  // two crosswalks the verges lack cross the south and east arms on Dry Creek's light (sidewalks.ts).
  const walk = (ax: number, az: number, bx: number, bz: number, spawn: boolean) => {
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 26);
    for (let k = 0; k < steps; k++) {
      country.walks.push({ ax: ax + ((bx - ax) * k) / steps, az: az + ((bz - az) * k) / steps, bx: ax + ((bx - ax) * (k + 1)) / steps, bz: az + ((bz - az) * (k + 1)) / steps, spawn });
    }
  };
  walk(-926, N_WALK, NW[0], N_WALK, true);
  walk(NW[0], N_WALK, NW[0], NW[1], false);
  walk(NE[0], N_WALK, -808, N_WALK, true);
  walk(NE[0], N_WALK, NE[0], NE[1], false);
  walk(-926, S_WALK, SW[0] - 2, S_WALK, true);
  walk(SW[0] - 2, S_WALK, SW[0], SW[1], false);
  walk(SE_EAST[0], S_WALK, -777, S_WALK, true);
  walk(SE_EAST[0], S_WALK, SE_EAST[0], SE_EAST[1], false);
  walk(SE_SOUTH[0], SE_SOUTH[1], SE_EAST[0], SE_EAST[1], false);
  walk(SW[0], SW[1], SE_SOUTH[0], SE_SOUTH[1], false);
  walk(NE[0], NE[1], SE_EAST[0], SE_EAST[1], false);

  // The sheriff's door and Bang Bang's, on their boardwalks: a bust out here walks out of the one (bustStation).
  const sheriff = store('sheriff');
  layout.pois.push({ id: 'sheriff', kind: 'police', name: 'Las Lomas County Sheriff', x: doorX(sheriff), z: S_FRONT - STEP, heading: Math.PI, bay: null, block: -1 });
  const guns = store('guns');
  layout.pois.push({ id: 'guns_county', kind: 'gunshop', name: 'Bang Bang Guns & Bait', x: doorX(guns), z: N_FRONT + STEP, heading: 0, bay: null, block: -1 });

  // Gas & Grits: the pumps break (and go up: sim/dryCreek.ts), the canopy and its posts are solid.
  for (const [x, z] of PUMPS) {
    town.pumps.push(layout.props.length);
    addProp(layout, 'pump', x, z, Math.PI / 2, 1, ground(x, z));
  }
  town.canopy = CANOPY;
  town.canopyY = CANOPY_Y;
  places.solids.push({ rect: CANOPY, y0: CANOPY_Y[0], y1: CANOPY_Y[1], tag: 'wall' });
  for (const [x, z] of CANOPY_POSTS) places.solids.push({ rect: mkRect(x - 0.2, z - 0.2, x + 0.2, z + 0.2), y0: 0, y1: CANOPY_Y[0], tag: 'pillar', round: true });

  // The grain elevator behind the Feed & Seed, the landmark you steer by: four concrete silos, the head house across
  // their tops and the leg tower at their east end, 40 m up.
  const silos = [-903.4, -896.8, -890.2, -883.6].map((x) => ({ x, z: -318 }));
  const r = 3.3;
  const head = mkRect(-901, -321, -886, -315);
  const leg = mkRect(-880.3, -320.5, -876.8, -315.5);
  town.elevator = { silos, r, height: 30, head, headTop: 36, leg, top: 40 };
  for (const s of silos) places.solids.push({ rect: mkRect(s.x - r, s.z - r, s.x + r, s.z + r), y0: 0, y1: 30, tag: 'building', round: true });
  places.solids.push({ rect: head, y0: 30, y1: 36, tag: 'building' }, { rect: leg, y0: 0, y1: 40, tag: 'building' });

  // The water tower behind the Rusty Spur: DRY CREEK. YOU'RE ALMOST SOMEWHERE.
  const tower = { x: -792, z: -222, r: 5, legs: 3.6, y0: 18, y1: 26 };
  town.tower = tower;
  places.solids.push({ rect: mkRect(tower.x - tower.r, tower.z - tower.r, tower.x + tower.r, tower.z + tower.r), y0: tower.y0, y1: tower.y1 + 2, tag: 'building', round: true });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = tower.x + sx * tower.legs;
    const z = tower.z + sz * tower.legs;
    places.solids.push({ rect: mkRect(x - 0.3, z - 0.3, x + 0.3, z + 0.3), y0: 0, y1: tower.y0, tag: 'pillar', round: true });
  }

  // The World's Second-Largest Corn Cob at the town's west end, its plaque to the main street.
  const cob = { x: -918, z: -294, r: 1.3, height: 9, plaque: { x: -918, z: -287.5 } };
  town.cob = cob;
  places.solids.push({ rect: mkRect(cob.x - cob.r, cob.z - cob.r, cob.x + cob.r, cob.z + cob.r), y0: 0, y1: cob.height, tag: 'pillar', round: true });

  // The diner's neon cow kicks on its roof over the boardwalk.
  const diner = store('diner');
  town.neon = { x: doorX(diner), z: N_FRONT - 0.5, y: diner.top + 0.2 };

  // Billboards for the traffic coming into town: from the causeway, and from the highway out west.
  for (const [x, z, lines] of [
    [-757, -301, ['LAST GAS FOR 400 METRES', 'GAS & GRITS · DRY CREEK']],
    [-922, -232, ['INJURED BY A COW?', 'CALL BUD BARLOW, ATTORNEY AT LAW.']],
  ] as const) {
    town.billboards.push({ prop: layout.props.length, lines: [lines[0], lines[1]] });
    addProp(layout, 'billboard', x, z, Math.PI / 2, 1, ground(x, z));
  }

  // Street lamps along the north kerb, their heads over the main street, clear of the crossroads' corners.
  for (const x of [-922, -894, -866, -814, -786, -758]) addProp(layout, 'lamp', x, -277, 0, 1, ground(x, -277));

  // Benches against the store fronts, clear of the walking lines.
  for (const s of town.stores) {
    if (s.kind === 'gas') continue;
    const z = s.front === 'S' ? N_FRONT + 0.6 : S_FRONT - 0.6;
    const x = s.body.maxX - 2.2;
    addProp(layout, 'bench', x, z, s.front === 'S' ? 0 : Math.PI, 1, ground(x, z));
  }

  // Nose-in parking south of the main street, facing the stores, clear of Creek Road's corners.
  town.lots.push(mkRect(-806, -305, -772, -276.3), mkRect(-905, -259.8, -851, S_EDGE), mkRect(-829, -259.8, -777, S_EDGE));
  for (const [x0, x1] of [[-903, -853], [-827, -780]] as const) {
    for (let x = x0; x <= x1; x += BAY_GAP) layout.parking.push({ x, z: BAY_Z, heading: 0 });
  }
}

// ---------------------------------------------------------------------------
// The Moonbeam Drive-In

/**
 * The drive-in on the county's east shore: a 30 x 14 m screen facing west across the lot, the city behind it over
 * Lomas Sound, its picture's foot SCREEN.y0 up. The cars stand in ROWS arcs round the screen's foot, nose to it, a
 * speaker post between each pair; the booth and the stand behind them, the gate and the marquee on Creek Road.
 */
const SCREEN = { x: -716, z: 120, w: 30, y0: 4, y1: 18 };
const ROWS = [34, 42, 50, 58, 66];
/** Cars to a row, and the gap (m) between neighbours along their arc. */
const ROW_CARS = 8;
const CAR_GAP = 4.2;

function buildDriveIn(layout: CityLayout, places: CountyPlaces): void {
  const d = places.driveIn;
  const ground = (x: number, z: number) => countryGround(layout.country, x, z);
  const { x: sx, z: sz, w } = SCREEN;
  d.frame = mkRect(sx - 0.8, sz - w / 2 - 0.5, sx + 0.6, sz + w / 2 + 0.5);
  d.screen = { x: sx - 0.82, z0: sz - w / 2, z1: sz + w / 2, y0: SCREEN.y0, y1: SCREEN.y1 };
  // You can hide behind it: the frame is solid from the ground to the top of the picture.
  places.solids.push({ rect: d.frame, y0: 0, y1: SCREEN.y1 + 0.5, tag: 'wall' });

  // The bays, nose to the screen's foot, each row's cars CAR_GAP apart along its arc; a speaker post between each pair.
  d.bays.first = layout.parking.length;
  for (const r of ROWS) {
    const step = CAR_GAP / r;
    for (let k = 0; k < ROW_CARS; k++) {
      const a = (k - (ROW_CARS - 1) / 2) * step;
      const x = sx - Math.cos(a) * r;
      const z = sz + Math.sin(a) * r;
      layout.parking.push({ x, z, heading: Math.atan2(sx - x, sz - z) });
      if (k % 2 === 1) continue;
      const pa = a + step / 2;
      const px = sx - Math.cos(pa) * (r + 0.8);
      const pz = sz + Math.sin(pa) * (r + 0.8);
      d.speakers.push(layout.props.length);
      addProp(layout, 'speaker', px, pz, Math.atan2(sx - px, sz - pz), 1, ground(px, pz));
    }
  }
  d.bays.end = layout.parking.length;
  const far = ROWS[ROWS.length - 1]! + 4;
  const half = Math.sin(((ROW_CARS / 2) * CAR_GAP) / ROWS[ROWS.length - 1]!) * far;
  d.lot = mkRect(sx - far, sz - half, sx - 4, sz + half);

  // The booth behind the last row, its window to the screen; the stand to its south.
  d.booth = mkRect(-794, 116, -787, 124);
  d.stand = mkRect(-796, 94, -784, 102);
  places.solids.push({ rect: d.booth, y0: 0, y1: 4.6, tag: 'building' }, { rect: d.stand, y0: 0, y1: 3.8, tag: 'building' });

  // The gate on Creek Road (its kerb at x -835) and the marquee beside it, facing the road.
  d.drive = mkRect(-835, 56, -790, 64);
  d.marquee = { x: -815, z: 50, posts: [-4.2, 4.2] };
  for (const dz of d.marquee.posts) {
    const z = d.marquee.z + dz;
    places.solids.push({ rect: mkRect(d.marquee.x - 0.25, z - 0.25, d.marquee.x + 0.25, z + 0.25), y0: 0, y1: 7.5, tag: 'pillar', round: true });
  }
}

// ---------------------------------------------------------------------------
// Gravel Gulch

/**
 * The dirt track south of the Lomas Highway's south leg: a lap of about 1.1 km from the start line on its north
 * straight, clockwise round the outside with a hairpin loop up its middle, every turn of TRACK_R m. As a turtle from
 * the start line heading east: [straight m] or [turn: degrees, positive to the left].
 */
const TRACK_START = { x: -1246, z: 310 };
const TRACK_R = 24;
const TRACK_WIDTH = 9;
const TRACK_STEP = 2;
const TRACK_LEGS: ReadonlyArray<number | readonly [number]> = [150, [-90], 168, [-90], 31, [-90], 116, [90], 8, [90], 116, [-90], 23, [-90], 168, [-90], 8];
/** How near (m) a rider passes a gate's centre to pass it (sim/activities/scramble.ts). */
export const TRACK_GATE_R = 8;
/**
 * The east straight's six whoops (from WHOOPS m down it, a crest every WHOOP_PITCH m) and the west straight's two
 * tabletops (each from its distance up it: a steep face to a lip over the table, the table, and the landing), all as
 * wide as the track. The lip stands TABLE.lip m over the table, so a rider at speed leaves the ground there.
 */
const WHOOPS = { from: 28, count: 6, pitch: 9, half: 3.5, height: 0.8 };
const TABLES = [40, 104];
const TABLE = { face: 7, lip: 2.2, top: 12, height: 1.5, landing: 10 };

function buildTrack(layout: CityLayout, places: CountyPlaces): void {
  const t = places.track;
  t.width = TRACK_WIDTH;
  // Walk the centre line, a point every TRACK_STEP m along the straights and round the turns.
  let { x, z } = TRACK_START;
  let h = Math.PI / 2;
  let s = 0;
  const push = () => {
    t.line.push({ x, z });
    t.at.push(s);
  };
  push();
  const straights: Array<{ x: number; z: number; h: number; s: number }> = [];
  for (const leg of TRACK_LEGS) {
    if (typeof leg === 'number') {
      straights.push({ x, z, h, s });
      const n = Math.max(1, Math.ceil(leg / TRACK_STEP));
      const [x0, z0] = [x, z];
      for (let k = 1; k <= n; k++) {
        x = x0 + Math.sin(h) * ((leg * k) / n);
        z = z0 + Math.cos(h) * ((leg * k) / n);
        s += leg / n;
        push();
      }
      continue;
    }
    const turn = (leg[0] * Math.PI) / 180;
    const sign = Math.sign(turn);
    // The turn's centre is TRACK_R to its inside (left of the heading (cos h, -sin h) for a left turn).
    const cx = x + sign * TRACK_R * Math.cos(h);
    const cz = z - sign * TRACK_R * Math.sin(h);
    const h0 = h;
    const n = Math.ceil((TRACK_R * Math.abs(turn)) / TRACK_STEP);
    for (let k = 1; k <= n; k++) {
      const hk = h0 + (turn * k) / n;
      x = cx - sign * TRACK_R * Math.cos(hk);
      z = cz + sign * TRACK_R * Math.sin(hk);
      s += (TRACK_R * Math.abs(turn)) / n;
      push();
    }
    h = h0 + turn;
    t.turns.push({ cx, cz, r: TRACK_R, a0: Math.atan2(t.line[t.line.length - n - 1]!.z - cz, t.line[t.line.length - n - 1]!.x - cx), a1: Math.atan2(z - cz, x - cx) });
    // The turn's gate at its apex, pushed out so a rider on the racing line, hugging the inside edge, passes it and one
    // up on the berm does too, but one cutting across the infield does not.
    const at = t.line.length - 1 - Math.floor(n / 2);
    const apex = t.line[at]!;
    const out = (TRACK_R + TRACK_GATE_R - TRACK_WIDTH / 2) / TRACK_R;
    t.gates.push({ x: cx + (apex.x - cx) * out, z: cz + (apex.z - cz) * out, at });
  }
  t.length = s;
  // The lap's last gate on the start line; the scramble starts just past it.
  t.gates.push({ ...t.line.at(-1)!, at: t.line.length - 1 });
  t.start = { x: TRACK_START.x + 6, z: TRACK_START.z, heading: Math.PI / 2 };

  // The whoops on the east straight (heading south), the tabletops on the west one (heading north): a ramp rising
  // along the way to each crest or lip, and one rising back to it from beyond.
  const ramp = (cx: number, cz: number, heading: number, length: number, height: number) => {
    t.ramps.push(layout.ramps.length);
    layout.ramps.push({ id: layout.ramps.length, x: cx, z: cz, heading, length, width: TRACK_WIDTH - 1, height, stunt: false });
  };
  const east = straights[1]!;
  const west = straights[7]!;
  for (let k = 0; k < WHOOPS.count; k++) {
    const crest = east.z + WHOOPS.from + k * WHOOPS.pitch;
    ramp(east.x, crest - WHOOPS.half / 2, 0, WHOOPS.half, WHOOPS.height);
    ramp(east.x, crest + WHOOPS.half / 2, Math.PI, WHOOPS.half, WHOOPS.height);
  }
  for (const d of TABLES) {
    const lip = west.z - d - TABLE.face;
    const end = lip - TABLE.top;
    ramp(west.x, lip + TABLE.face / 2, Math.PI, TABLE.face, TABLE.lip);
    ramp(west.x, end - TABLE.landing / 2, 0, TABLE.landing, TABLE.height);
    const top = mkRect(west.x - (TRACK_WIDTH - 1) / 2, end, west.x + (TRACK_WIDTH - 1) / 2, lip);
    t.tables.push(top);
    layout.decks.push({ rect: top, y: TABLE.height, name: 'Gravel Gulch', bridge: false, dirt: true });
  }
  // The drive in from the highway's south kerb (z 276) to the north straight.
  t.drive = mkRect(-1206, 276, -1196, TRACK_START.z - TRACK_WIDTH / 2);
}

/**
 * The places, the last of the county's content passes (after the landscape and the farms): Dry Creek, the Moonbeam
 * Drive-In and Gravel Gulch. Its own generator (hashInts(seed, 9101)) gives the stores their tints; nothing else is
 * random.
 */
export function buildPlaces(layout: CityLayout): void {
  const rng = new Rng(hashInts(layout.seed, 9101));
  const places = noPlaces();
  layout.country.places = places;
  buildDryCreek(layout, rng, places);
  buildDriveIn(layout, places);
  buildTrack(layout, places);
  // The drive-in's and Gravel Gulch's drives, for the poles to keep off.
  layout.country.approaches.push({ rect: places.driveIn.drive, pad: MOUTH_CLEAR }, { rect: places.track.drive, pad: MOUTH_CLEAR });
}
