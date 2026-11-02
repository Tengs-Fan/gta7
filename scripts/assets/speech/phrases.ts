// The police dispatcher's phrases. DispatchSystem (src/sim/dispatch.ts) builds its lines from these pieces, and the
// scanner says a line by joining the clips of its phrases, longest match first: every piece of every line the
// dispatcher can build must be here. A phrase that runs on into the next ends on a comma, so it is read that way.

import { COLOUR_NAMES, COMPASS, COUNTY_ZONES, CRIME_PHRASES, SHERIFF } from '../../../src/sim/dispatch';
import { VEHICLE_SPECS } from '../../../src/sim/specs';
import { COUNTY_NAME, VALLEY_NAME } from '../../../src/world/country';
import type { StaticWorld } from '../../../src/world/staticWorld';

/** Every place the dispatcher can name (StaticWorld.zoneName). */
export function zoneNames(world: StaticWorld): string[] {
  const zones = new Set<string>(['San Azura Bay', 'Ocean Beach']);
  for (const b of world.layout.blocks) zones.add(b.zone);
  for (const d of world.layout.decks) zones.add(d.name);
  for (const w of world.layout.water) zones.add(w.name);
  for (const h of world.layout.headlands) zones.add(h.name);
  // Las Lomas County and the valley beside it, and the plots by name.
  zones.add(COUNTY_NAME);
  zones.add(VALLEY_NAME);
  for (const p of world.layout.country.plots) zones.add(p.name);
  return [...zones];
}

export function dispatchPhrases(world: StaticWorld): string[] {
  const crimes = new Set([...Object.values(CRIME_PHRASES), 'a disturbance']);
  return [
    'All units, return to patrol.',
    'SWAT is rolling.',
    'Air unit on scene.',
    ...[...crimes].map((c) => `All units, ${c} reported in,`),
    ...zoneNames(world).filter((z) => !COUNTY_ZONES.has(z)).map((z) => `${z}.`),
    'Suspect on foot.',
    ...COLOUR_NAMES.map(([c]) => `Suspect in ${/^[aeiou]/.test(c) ? 'an' : 'a'} ${c},`),
    ...Object.values(VEHICLE_SPECS).map((s) => `${s.name}.`),
    'We lost visual. Search around,',
    ...COMPASS.map((d) => `Suspect spotted heading ${d} through,`),
  ];
}

/** The Las Lomas County Sheriff's dispatcher's phrases (dispatch.ts SHERIFF), in his own voice: he alone names the county's places. */
export function sheriffPhrases(): string[] {
  const crimes = new Set([...Object.values(CRIME_PHRASES), 'a disturbance']);
  // A line's head: the line with no place in it, running on into the place's phrase.
  const head = (line: string) => `${line.slice(0, -2)},`;
  return [
    ...[...crimes].map((c) => head(SHERIFF.opening(c, ''))),
    ...[...COUNTY_ZONES].map((z) => `${z}.`),
    SHERIFF.inVehicle,
    SHERIFF.onFoot,
    SHERIFF.haymaker,
    head(SHERIFF.search('')),
    ...COMPASS.map((d) => head(SHERIFF.spotted(d, ''))),
    SHERIFF.patrol,
    SHERIFF.swat,
    SHERIFF.air,
  ];
}
