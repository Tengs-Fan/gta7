// Police radio chatter. Polls the wanted level and the police state every frame (the police system
// updates it last) and narrates the chase as 'dispatch' events for the HUD's scanner line. It never
// uses the subtitle channel, which belongs to the story.

import type { Vehicle } from './entities';
import type { Sim } from './sim';
import type { CrimeType } from './wanted';

/** At most one line on the air per this many seconds. */
export const DISPATCH_GAP = 6;
/** A line still waiting for its turn after this many seconds is stale and dropped. */
export const DISPATCH_MAX_WAIT = 4;

const CRIME_PHRASES: Readonly<Record<CrimeType, string>> = {
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
const COLOUR_NAMES: ReadonlyArray<readonly [string, number]> = [
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

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;

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

  constructor(private readonly sim: Sim) {
    this.evasions = sim.wanted.evasions;
  }

  update(): void {
    const sim = this.sim;
    const w = sim.wanted;
    const level = w.level;
    const searching = level > 0 && w.searching;
    const helis = level > 0 ? sim.helis.filter((h) => !h.removed && !h.destroyed).length : 0;
    if (sim.playerDown) {
      // Wasted or busted: the chase is over, and the respawn clears the stars without a word.
      this.queue.length = 0;
    } else if (level === 0 && this.level > 0) {
      // Whatever ended the chase, nothing said about it is news any more.
      this.queue.length = 0;
      if (w.evasions !== this.evasions) this.say('All units, return to patrol.');
    } else if (level > 0) {
      if (this.level === 0) this.say(this.opening());
      else {
        if (searching && !this.searching) this.say(`We lost visual. Search around ${this.zone(w.lastSeenX, w.lastSeenZ)}.`);
        if (!searching && this.searching) this.say(this.spotted());
      }
      if (level >= 4 && this.level < 4) this.say('SWAT is rolling.');
      if (helis > 0 && this.helis === 0) this.say('Air unit on scene.');
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
    this.sim.events.emit('dispatch', { text: line.text });
  }

  private zone(x: number, z: number): string {
    return this.sim.world.zoneName(x, z);
  }

  private opening(): string {
    const sim = this.sim;
    const pp = sim.playerPos();
    const crime = sim.wanted.lastCrime;
    const what = crime ? CRIME_PHRASES[crime] : 'a disturbance';
    const v = sim.player.vehicle;
    return `All units, ${what} reported in ${this.zone(pp.x, pp.z)}. Suspect ${v ? `in ${describe(v)}` : 'on foot'}.`;
  }

  private spotted(): string {
    const sim = this.sim;
    const p = sim.player;
    const v = p.vehicle;
    const pp = sim.playerPos();
    const vx = v ? v.vel.x : p.vel.x;
    const vz = v ? v.vel.z : p.vel.z;
    const h = v ? v.heading : p.heading;
    // Moving: the way he goes; standing: the way he faces.
    const [dx, dz] = Math.hypot(vx, vz) > 1.5 ? [vx, vz] : [Math.sin(h), Math.cos(h)];
    return `Suspect spotted heading ${compassName(dx, dz)} through ${this.zone(pp.x, pp.z)}.`;
  }
}

/** "a red Velora", "an orange Nightjar GT". */
function describe(v: Vehicle): string {
  const colour = colourName(v.color);
  return `${/^[aeiou]/.test(colour) ? 'an' : 'a'} ${colour} ${v.spec.name}`;
}
