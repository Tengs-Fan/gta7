// The payphone at the end of Hollister Lane (world/country/oddities.ts): it rings when a player passes within
// PAYPHONE_RANGE m of it, on foot or in a car, every PAYPHONE_GAP s for up to PAYPHONE_RING_FOR s (payphoneRing, which
// the audio rings the bell for), and while it rings it has a marker like a gun shop's at its foot. E there on foot answers
// it: a stranger says one of PAYPHONE_LINES down the line, as a subtitle (and, in his own voice, aloud). It rings again
// only PAYPHONE_COOLDOWN s after it was answered or given up on. The lines come in an order that is fixed by the city's
// seed and runs through all of them before any is said twice. Single player only, as the cows' markers are: a room's
// phone would ring for whoever was near it and answer to whoever got there first. Nothing here draws sim.rng.

import { Rng } from '../core/rng';
import { hashInts } from '../world/layout';
import type { Marker } from './interactions';
import type { Sim } from './sim';
import { lineSeconds } from './speech';
import { registerSystem } from './systems';
import type { PlayerView } from './viewState';

/** How near a player must pass for it to ring (m), how often it rings and for how long, and the quiet after (s). */
export const PAYPHONE_RANGE = 25;
export const PAYPHONE_GAP = 3;
export const PAYPHONE_RING_FOR = 30;
export const PAYPHONE_COOLDOWN = 240;
/** Who is on the line (the subtitle's speaker, heard down a phone line: audio/dialogue.ts), and what he says (scripts/assets/speech). */
export const PAYPHONE_SPEAKER = 'Stranger (phone)';
export const PAYPHONE_LINES: readonly string[] = [
  'Good news and bad news. The good news is that you answered. The bad news is that I only wanted the phone.',
  'Listen carefully. The pie is not what it seems. It is, in fact, exactly a pie. We are all very worried.',
  'I am calling from the bottom of a very large field. It is quite nice. Please do not send help. Send soup.',
  'If this is the sheriff, I was never here. If this is not the sheriff, I was definitely here, and I brought a ladder.',
  'I have information about Bigfoot. He is fine. He would like you to stop waving at him. It makes him self-conscious.',
  'You have reached the Las Lomas County Department of Things. For nothing, press nothing. Thank you for your time. It will not be returned.',
];
export const PAYPHONE_PROMPT = 'Press E to answer the payphone';
/** The marker's colour: a little green. */
const PAYPHONE_COLOR = 0x6fe08a;
/** Salt of the generator that puts the lines in order (hashInts(seed, PAYPHONE_SALT)). */
const PAYPHONE_SALT = 7;

interface Phone {
  marker: Marker;
  ringing: boolean;
  /** Sim time it began ringing and when it rings next. */
  since: number;
  next: number;
  /** Sim time before which it does not ring. */
  readyAt: number;
  answered: number;
  /** PAYPHONE_LINES' indices in the order they are said. */
  order: readonly number[];
}

const phones = new WeakMap<Sim, Phone>();

function phone(sim: Sim): Phone {
  let p = phones.get(sim);
  if (!p) {
    const at = sim.world.layout.country.oddities.payphone.at;
    p = {
      marker: { id: 'payphone', kind: 'payphone', x: at.x, z: at.z, radius: 1.5, label: PAYPHONE_PROMPT, color: PAYPHONE_COLOR, ref: 'payphone' },
      ringing: false,
      since: 0,
      next: 0,
      readyAt: 0,
      answered: 0,
      order: new Rng(hashInts(sim.world.layout.seed, PAYPHONE_SALT)).shuffle(PAYPHONE_LINES.map((_, i) => i)),
    };
    phones.set(sim, p);
  }
  return p;
}

/** The payphone's marker goes (while it rings it is among the interactions' markers, and only then). */
function dropMarker(sim: Sim, p: Phone): void {
  sim.interactions.markers.splice(sim.interactions.markers.indexOf(p.marker), 1);
}

/** The payphone stops ringing (answered, or given up on) and is quiet for PAYPHONE_COOLDOWN s. */
function hangUp(sim: Sim, p: Phone): void {
  p.ringing = false;
  p.readyAt = sim.time + PAYPHONE_COOLDOWN;
  dropMarker(sim, p);
}

/** Whether the payphone is ringing now. */
export function payphoneRinging(sim: Sim): boolean {
  return phone(sim).ringing;
}

/** `slot` presses E at the payphone: while it rings he picks it up and hears the next line; else nothing. */
export function answerPayphone(sim: Sim, slot: PlayerView): void {
  const p = phone(sim);
  if (!p.ringing) return;
  const text = PAYPHONE_LINES[p.order[p.answered % p.order.length]!]!;
  p.answered++;
  hangUp(sim, p);
  sim.events.emit('subtitle', { speaker: PAYPHONE_SPEAKER, text, duration: lineSeconds(PAYPHONE_SPEAKER, text), ...slot.tag });
}

registerSystem({
  id: 'payphone',
  slot: 'afterInteractions',
  update(sim) {
    if (sim.multiplayer) return;
    const p = phone(sim);
    const ph = sim.world.layout.country.oddities.payphone;
    if (!p.ringing) {
      if (sim.time < p.readyAt || !sim.players.some((slot) => !slot.down && Math.hypot(slot.pos().x - ph.x, slot.pos().z - ph.z) <= PAYPHONE_RANGE)) return;
      p.ringing = true;
      p.since = sim.time;
      p.next = sim.time;
      sim.interactions.markers.push(p.marker);
    } else if (sim.time - p.since >= PAYPHONE_RING_FOR) {
      hangUp(sim, p);
      return;
    }
    if (sim.time < p.next) return;
    p.next += PAYPHONE_GAP;
    sim.events.emit('payphoneRing', { x: ph.x, y: sim.world.groundHeight(ph.x, ph.z) + 1.6, z: ph.z });
  },
  reset(sim) {
    const p = phones.get(sim);
    if (p?.ringing) dropMarker(sim, p);
    phones.delete(sim);
  },
});
