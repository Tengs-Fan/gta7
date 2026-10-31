// Police radio chatter. Polls the wanted level and the police state every frame (the police system
// updates it last) and narrates the chase as 'dispatch' events for the HUD's scanner line. It never
// uses the subtitle channel, which belongs to the story.

import { COUNTY_NAME, COUNTY_PLOTS } from '../world/country';
import type { Vehicle } from './entities';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import type { CrimeType } from './wanted';

/** At most one line on the air per this many seconds. */
export const DISPATCH_GAP = 6;
/** A line still waiting for its turn after this many seconds is stale and dropped. */
export const DISPATCH_MAX_WAIT = 4;

export const CRIME_PHRASES: Readonly<Record<CrimeType, string>> = {
  carjack: 'a carjacking',
  stealPoliceCar: 'a stolen police cruiser',
  hitPed: 'a hit-and-run',
  assault: 'an assault',
  assaultCop: 'an assault on an officer',
  murder: 'a homicide',
  killGang: 'a homicide',
  killCop: 'an officer down',
  gunfire: 'shots fired',
  explosion: 'an explosion',
  destroyVehicle: 'a vehicle fire',
  destroyPolice: 'an officer down',
  hitPolice: 'a rammed police unit',
};

/** Colour names for suspect vehicles: the nearest of these reference colours. */
export const COLOUR_NAMES: ReadonlyArray<readonly [string, number]> = [
  ['red', 0xaa2d26],
  ['blue', 0x2a5db0],
  ['green', 0x2e8b3a],
  ['yellow', 0xf1c40f],
  ['white', 0xf0f0f0],
  ['black', 0x181818],
  ['grey', 0x808080],
  ['purple', 0x7d3c98],
  ['orange', 0xe67e22],
  ['teal', 0x138d8a],
  ['brown', 0x784b2d],
];

/** The name of the reference colour nearest to `color` (0xRRGGBB). */
export function colourName(color: number): string {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  let best = COLOUR_NAMES[0]![0];
  let bd = Infinity;
  for (const [name, c] of COLOUR_NAMES) {
    const d = (r - ((c >> 16) & 255)) ** 2 + (g - ((c >> 8) & 255)) ** 2 + (b - (c & 255)) ** 2;
    if (d < bd) {
      bd = d;
      best = name;
    }
  }
  return best;
}

/**
 * Las Lomas County's places. A line about one, or said while the suspect is in one, is the Las Lomas County Sheriff's
 * dispatcher's, in a voice of his own (SHERIFF): only he names them.
 */
export const COUNTY_ZONES: ReadonlySet<string> = new Set([COUNTY_NAME, ...COUNTY_PLOTS.map((p) => p.name)]);

/** The sheriff's dispatcher's lines: the opening's head (crime, place), the suspect, the search and the sighting's head (compass point, place). */
export const SHERIFF = {
  opening: (crime: string, zone: string) => `Deputies, we got ${crime} out by ${zone}.`,
  inVehicle: 'Suspect took off in a vehicle.',
  onFoot: 'Suspect took off on foot.',
  haymaker: "Suspect is fleeing on a Haymaker. Deputies, let's not make this a whole thing.",
  search: (zone: string) => `Lost him. Deputies, check around ${zone}.`,
  spotted: (dir: string, zone: string) => `There he goes, headed ${dir} past ${zone}.`,
  patrol: 'All deputies, head on back to the diner.',
  swat: 'The state boys are sending SWAT.',
  air: 'Air unit is up over the county.',
} as const;

export const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;

/** Compass point of a direction on the map (+X east, +Z south). */
export function compassName(dx: number, dz: number): string {
  const a = Math.atan2(dx, -dz); // 0 = north, clockwise
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return COMPASS[i]!;
}

export class DispatchSystem {
  private level = 0;
  private searching = false;
  private helis = 0;
  private evasions: number;
  private lastAt = -Infinity;
  private readonly queue: Array<{ text: string; at: number }> = [];

  /** Narrates the pursuit of `slot`'s player (slot 0 by default), on his own scanner line. */
  constructor(private readonly sim: Sim, private readonly slot: PlayerSlot = sim.players[0]!) {
    this.evasions = slot.wanted.evasions;
  }

  update(): void {
    const sim = this.sim;
    const w = this.slot.wanted;
    const level = w.level;
    const searching = level > 0 && w.searching;
    let helis = 0;
    if (level > 0) for (const h of sim.helis) if (!h.removed && !h.destroyed && sim.police.targetSlotOf(h) === this.slot.id) helis++;
    if (this.slot.down) {
      // Wasted or busted: the chase is over, and the respawn clears the stars without a word.
      this.queue.length = 0;
    } else if (level === 0 && this.level > 0) {
      // Whatever ended the chase, nothing said about it is news any more.
      this.queue.length = 0;
      if (w.evasions !== this.evasions) this.say(this.inCounty() ? SHERIFF.patrol : 'All units, return to patrol.');
    } else if (level > 0) {
      if (this.level === 0) this.say(this.opening());
      else {
        if (searching && !this.searching) {
          const zone = this.zone(w.lastSeenX, w.lastSeenZ);
          this.say(COUNTY_ZONES.has(zone) ? SHERIFF.search(zone) : `We lost visual. Search around ${zone}.`);
        }
        if (!searching && this.searching) this.say(this.spotted());
      }
      if (level >= 4 && this.level < 4) this.say(this.inCounty() ? SHERIFF.swat : 'SWAT is rolling.');
      if (helis > 0 && this.helis === 0) this.say(this.inCounty() ? SHERIFF.air : 'Air unit on scene.');
    }
    this.level = level;
    this.searching = searching;
    this.helis = helis;
    this.evasions = w.evasions;
    this.flush();
  }

  private say(text: string): void {
    this.queue.push({ text, at: this.sim.time });
  }

  private flush(): void {
    const now = this.sim.time;
    while (this.queue.length > 0 && now - this.queue[0]!.at > DISPATCH_MAX_WAIT) this.queue.shift();
    if (this.queue.length === 0 || now - this.lastAt < DISPATCH_GAP) return;
    const line = this.queue.shift()!;
    this.lastAt = now;
    this.sim.events.emit('dispatch', { text: line.text, ...this.slot.tag });
  }

  private zone(x: number, z: number): string {
    return this.sim.world.zoneName(x, z);
  }

  /** The suspect is in Las Lomas County: the sheriff has the air. */
  private inCounty(): boolean {
    const pp = this.slot.pos();
    return COUNTY_ZONES.has(this.zone(pp.x, pp.z));
  }

  private opening(): string {
    const pp = this.slot.pos();
    const crime = this.slot.wanted.lastCrime;
    const what = crime ? CRIME_PHRASES[crime] : 'a disturbance';
    const v = this.slot.character.vehicle;
    const zone = this.zone(pp.x, pp.z);
    if (COUNTY_ZONES.has(zone)) return `${SHERIFF.opening(what, zone)} ${v ? (v.kind === 'tractor' ? SHERIFF.haymaker : SHERIFF.inVehicle) : SHERIFF.onFoot}`;
    return `All units, ${what} reported in ${zone}. Suspect ${v ? `in ${describe(v)}` : 'on foot'}.`;
  }

  private spotted(): string {
    const p = this.slot.character;
    const v = p.vehicle;
    const pp = this.slot.pos();
    const vx = v ? v.vel.x : p.vel.x;
    const vz = v ? v.vel.z : p.vel.z;
    const h = v ? v.heading : p.heading;
    // Moving: the way he goes; standing: the way he faces.
    const [dx, dz] = Math.hypot(vx, vz) > 1.5 ? [vx, vz] : [Math.sin(h), Math.cos(h)];
    const zone = this.zone(pp.x, pp.z);
    if (COUNTY_ZONES.has(zone)) return v?.kind === 'tractor' ? SHERIFF.haymaker : SHERIFF.spotted(compassName(dx, dz), zone);
    return `Suspect spotted heading ${compassName(dx, dz)} through ${zone}.`;
  }
}

/** "a red Velora", "an orange Nightjar GT". */
function describe(v: Vehicle): string {
  const colour = colourName(v.color);
  return `${/^[aeiou]/.test(colour) ? 'an' : 'a'} ${colour} ${v.spec.name}`;
}
