// AzuraLink: a three-car monorail on a beam 10 m over Cortez Canal, from a station on the north promenade to one on the
// south, over every street bridge. The line is pure data, and the train runs to a timetable: where it is is a function
// of sim time alone, so every sim and every multiplayer client puts it in the same place without a snapshot.

import type { CityLayout, Rect } from './layout';

/** The train's three cars, nose to tail along the beam (m). */
export const CAR_LENGTH = 10.4;
export const CAR_GAP = 0.6;
export const TRAIN_LENGTH = 3 * CAR_LENGTH + 2 * CAR_GAP;
/** The cars' width and their body's height above the floor (m). */
export const CAR_WIDTH = 3;
export const CAR_HEIGHT = 3.1;
/** Cruising speed (m/s), seconds at each station, and the metres it eases in and out of them over. */
export const TRAIN_SPEED = 15;
export const TRAIN_DWELL = 20;
export const TRAIN_EASE = 30;
/** The beam runs on this far (m) past the train's end at each station. */
export const BEAM_OVERRUN = 1.5;
/** Pylons stand this far (m) clear of every deck over the canal. */
const PYLON_CLEAR = 3;
/** The longest span (m) between two pylons in one stretch of open water. */
const PYLON_SPAN = 40;
/** A station's stair tower: its footprint (m) on the bank and its height. */
const TOWER_W = 7;
const TOWER_D = 8;
export const TOWER_H = 13.6;
/** The platform's and the walkway's slab under their floor (m). */
export const PLATFORM_SLAB = 0.45;
/** The platform's width beside the train (m), and the walkway's over to the tower. */
const PLATFORM_W = 4;
const WALKWAY_W = 4;
/**
 * The train stops with its middle this far (m) in from the land's end, standing over the ring road's bridge with its
 * platform reaching out over the promenade: the footbridges and the south stunt ramp's run-out lane stay clear of it.
 */
const STOP_IN = 37;
/** A station's tower stands this far (m) from the stop along the canal, on the promenade's bank. */
const TOWER_OFF = 13;

export interface MonorailStation {
  name: string;
  /** Where the middle of the train stops. */
  z: number;
  /** The side of the beam its platform is on: 1 east, -1 west. */
  side: 1 | -1;
  /** The stair tower on the bank, from the ground up to TOWER_H. */
  tower: Rect;
  /** The platform beside the train and the walkway over the water to the tower, their floor at beamY. */
  platform: Rect[];
  /** The foot of the stairs: where the ride is taken and where it leaves you, facing away from the tower. */
  foot: { x: number; z: number; heading: number };
}

export interface Monorail {
  /** The beam's line along the canal. */
  x: number;
  /** The top of the beam: the cars' floor and the platforms'. */
  beamY: number;
  /** Where the middle of the train stops at the north and the south station. */
  z0: number;
  z1: number;
  pylons: { x: number; z: number }[];
  /** North first. */
  stations: MonorailStation[];
}

/** The line before buildMonorail lays it (the layout's first draft). */
export function noMonorail(): Monorail {
  return { x: 0, beamY: 0, z0: 0, z1: 0, pylons: [], stations: [] };
}

/** The decks over the canal (bridges, footways, the footbridges) as merged z ranges, north to south. */
function deckSpans(layout: CityLayout, x0: number, x1: number): Array<[number, number]> {
  const spans = layout.decks
    .filter((d) => d.rect.minX < x1 && d.rect.maxX > x0)
    .map((d): [number, number] => [d.rect.minZ, d.rect.maxZ])
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/** AzuraLink along Cortez Canal: the beam on its middle line, a pylon pair round every bridge, a station on each promenade. */
export function buildMonorail(layout: CityLayout): void {
  const canal = layout.water.find((w) => w.name === 'Cortez Canal')!.bounds;
  const x = (canal.minX + canal.maxX) / 2;
  const b = layout.bounds;
  const z0 = b.landMinZ + STOP_IN;
  const z1 = b.landMaxZ - STOP_IN;
  const end = TRAIN_LENGTH / 2 + BEAM_OVERRUN;
  // Pylons in each stretch of open water under the beam: one at either end, PYLON_CLEAR off the decks, and more between
  // them at most PYLON_SPAN apart.
  const pylons: { x: number; z: number }[] = [];
  const spans = deckSpans(layout, canal.minX, canal.maxX);
  let from = z0 - end;
  for (const [s0, s1] of [...spans, [z1 + end, z1 + end] as [number, number]]) {
    const a = Math.max(from, z0 - end) + PYLON_CLEAR;
    const c = Math.min(s0, z1 + end) - PYLON_CLEAR;
    from = Math.max(from, s1);
    if (c < a) continue;
    // A short stretch takes one pylon in its middle.
    if (c - a < 10) {
      pylons.push({ x, z: (a + c) / 2 });
      continue;
    }
    const n = Math.ceil((c - a) / PYLON_SPAN) + 1;
    for (let k = 0; k < n; k++) pylons.push({ x, z: a + ((c - a) * k) / (n - 1) });
  }
  // A platform runs the train's length and on to the pylons just past either end of it, whose heads hold it up.
  const span = (z: number): [number, number] => {
    let z0 = z - TRAIN_LENGTH / 2 - 0.5;
    let z1 = z + TRAIN_LENGTH / 2 + 0.5;
    for (const p of pylons) {
      if (p.z > z0 - 5 && p.z < z0) z0 = p.z - 0.8;
      if (p.z < z1 + 5 && p.z > z1) z1 = p.z + 0.8;
    }
    return [z0, z1];
  };
  const station = (name: string, z: number, side: 1 | -1, landward: 1 | -1, back: number): MonorailStation => {
    // The tower stands on the bank, `back` m from the quay; the walkway meets it halfway along.
    const quay = side > 0 ? canal.maxX : canal.minX;
    const tx0 = quay + side * back;
    const tx1 = tx0 + side * TOWER_W;
    const tz = z - landward * TOWER_OFF;
    const tower = { minX: Math.min(tx0, tx1), minZ: tz - TOWER_D / 2, maxX: Math.max(tx0, tx1), maxZ: tz + TOWER_D / 2 };
    const edge = x + side * (CAR_WIDTH / 2 + 0.2);
    const outer = edge + side * PLATFORM_W;
    const [pz0, pz1] = span(z);
    const platform = [
      { minX: Math.min(edge, outer), minZ: pz0, maxX: Math.max(edge, outer), maxZ: pz1 },
      { minX: Math.min(outer, tx0), minZ: tz - WALKWAY_W / 2, maxX: Math.max(outer, tx0), maxZ: tz + WALKWAY_W / 2 },
    ];
    const foot = { x: (tx0 + tx1) / 2, z: tz + landward * (TOWER_D / 2 + 1.4), heading: landward > 0 ? 0 : Math.PI };
    return { name, z, side, tower, platform, foot };
  };
  layout.monorail = {
    x,
    beamY: 9.6,
    z0,
    z1,
    pylons,
    // Seaview's tower steps back off the line of the promenade's tree beside it.
    stations: [station('Northshore', z0, 1, 1, 2), station('Seaview', z1, -1, -1, 10)],
  };
}

/** Seconds the train takes to ease up to TRAIN_SPEED over TRAIN_EASE m (and down again). */
const EASE_TIME = (2 * TRAIN_EASE) / TRAIN_SPEED;
const ACCEL = (TRAIN_SPEED * TRAIN_SPEED) / (2 * TRAIN_EASE);

/** Seconds from one station to the other. */
export function runTime(m: Monorail): number {
  return 2 * EASE_TIME + (m.z1 - m.z0 - 2 * TRAIN_EASE) / TRAIN_SPEED;
}

/** Seconds of the timetable's round: a dwell at the north station, the run south, a dwell at the south one, the run back. */
export function trainPeriod(m: Monorail): number {
  return 2 * (TRAIN_DWELL + runTime(m));
}

export interface TrainState {
  /** The middle of the train. */
  z: number;
  /** The way it runs, or runs next from a station: 1 south, -1 north. */
  dir: 1 | -1;
  speed: number;
  /** Seconds left at the station it stands at, doors open; 0 between stations. */
  dwell: number;
  /** The station it stands at (0 north, 1 south), or -1 between them. */
  station: number;
}

/** Where the train is at sim time `t`. */
export function trainAt(m: Monorail, t: number): TrainState {
  const run = runTime(m);
  const period = trainPeriod(m);
  const s = ((t % period) + period) % period;
  const half = TRAIN_DWELL + run;
  const back = s >= half;
  const u = back ? s - half : s;
  const dir = back ? -1 : 1;
  if (u < TRAIN_DWELL) return { z: back ? m.z1 : m.z0, dir, speed: 0, dwell: TRAIN_DWELL - u, station: back ? 1 : 0 };
  const tau = u - TRAIN_DWELL;
  let along: number;
  let speed: number;
  if (tau < EASE_TIME) {
    along = 0.5 * ACCEL * tau * tau;
    speed = ACCEL * tau;
  } else if (tau > run - EASE_TIME) {
    const left = run - tau;
    along = m.z1 - m.z0 - 0.5 * ACCEL * left * left;
    speed = ACCEL * left;
  } else {
    along = TRAIN_EASE + TRAIN_SPEED * (tau - EASE_TIME);
    speed = TRAIN_SPEED;
  }
  return { z: back ? m.z1 - along : m.z0 + along, dir, speed, dwell: 0, station: -1 };
}

/** Seconds from sim time `t` until the train next leaves `station` (0 north, 1 south). */
export function nextDeparture(m: Monorail, station: number, t: number): number {
  const period = trainPeriod(m);
  const leaves = station === 0 ? TRAIN_DWELL : 2 * TRAIN_DWELL + runTime(m);
  return (((leaves - t) % period) + period) % period;
}
