// The payphone at the end of Hollister Lane (sim/payphone.ts): it rings when a player passes within 25 m, on foot or in a car,
// every 3 s for 30 s, and shows a marker while it does; E at its foot answers it, and a stranger says one of six lines, in
// an order fixed by the city's seed; it is quiet for four minutes after, and after a ring nobody answered; a multiplayer room's
// never rings.

import { describe, expect, it } from 'vitest';
import { SPEECH, dialogueKey } from '../../src/sim/speech';
import { PAYPHONE_COOLDOWN, PAYPHONE_GAP, PAYPHONE_LINES, PAYPHONE_PROMPT, PAYPHONE_RANGE, PAYPHONE_RING_FOR, PAYPHONE_SPEAKER, payphoneRinging } from '../../src/sim/payphone';
import type { Sim } from '../../src/sim/sim';
import { StaticWorld } from '../../src/world/staticWorld';
import { makeSim, placeInCar, step, teleport } from './helpers';

/** A sim (of the city of `seed`, the default one unless it is given) with a player `d` m south of the payphone's foot, and a log of what the phone does. */
function ringing(opts: { seed?: number; d?: number } = {}) {
  const sim = makeSim({ ...(opts.seed === undefined ? {} : { world: new StaticWorld(opts.seed) }), police: false });
  const ph = sim.world.layout.country.oddities.payphone;
  const rings: number[] = [];
  const lines: Array<{ speaker: string; text: string; duration: number }> = [];
  sim.events.on('payphoneRing', () => rings.push(sim.time));
  sim.events.on('subtitle', (e) => lines.push(e));
  const stand = (d: number) => teleport(sim, ph.x, ph.z + d);
  stand(opts.d ?? PAYPHONE_RANGE + 1);
  return { sim, ph, rings, lines, stand };
}

const markers = (sim: Sim) => sim.interactions.markers.filter((m) => m.kind === 'payphone');

/** Answers the payphone: the player on its marker presses E. */
function answer(sim: Sim, at: { x: number; z: number }): void {
  teleport(sim, at.x, at.z);
  sim.interactions.interact(sim.players[0]!);
}

describe('the payphone rings', () => {
  it('for a player within 25 m, not beyond it', () => {
    const far = ringing({ d: PAYPHONE_RANGE + 1 });
    step(far.sim, 2);
    expect(far.rings).toEqual([]);
    expect(payphoneRinging(far.sim)).toBe(false);
    expect(markers(far.sim)).toEqual([]);
    far.stand(PAYPHONE_RANGE - 1);
    step(far.sim, 0.5);
    expect(far.rings.length).toBe(1);
    expect(payphoneRinging(far.sim)).toBe(true);
    const m = markers(far.sim);
    expect(m.length).toBe(1);
    expect([m[0]!.x, m[0]!.z]).toEqual([far.ph.at.x, far.ph.at.z]);
    expect(m[0]!.label).toBe(PAYPHONE_PROMPT);
  });

  it('for a car passing by as well as a man on foot', () => {
    const { sim, ph, rings } = ringing();
    const car = sim.spawnVehicle('sedan', ph.x, ph.z + 20, Math.PI);
    placeInCar(sim, car);
    step(sim, 0.5);
    expect(rings.length).toBe(1);
  });

  it('every 3 s for 30 s, then gives up and goes quiet, its marker with it', () => {
    const { sim, rings } = ringing({ d: 10 });
    step(sim, PAYPHONE_RING_FOR + 5);
    // Ten rings, 3 s apart, from the moment he came near.
    expect(rings.length).toBe(PAYPHONE_RING_FOR / PAYPHONE_GAP);
    for (let k = 1; k < rings.length; k++) expect(rings[k]! - rings[k - 1]!).toBeCloseTo(PAYPHONE_GAP, 1);
    expect(payphoneRinging(sim)).toBe(false);
    expect(markers(sim)).toEqual([]);
    // Still standing there, it stays quiet for the cooldown after it gave up, then rings again.
    step(sim, PAYPHONE_COOLDOWN - 10);
    expect(rings.length).toBe(PAYPHONE_RING_FOR / PAYPHONE_GAP);
    step(sim, 15);
    expect(rings.length).toBeGreaterThan(PAYPHONE_RING_FOR / PAYPHONE_GAP);
    expect(payphoneRinging(sim)).toBe(true);
  });

  it('not in a multiplayer room, which has no phone to answer it', () => {
    const room = makeSim({ multiplayer: true, police: false });
    const ph = room.world.layout.country.oddities.payphone;
    const rings: number[] = [];
    room.events.on('payphoneRing', () => rings.push(1));
    teleport(room, ph.x, ph.z + 5);
    step(room, 3);
    expect(rings).toEqual([]);
    expect(markers(room)).toEqual([]);
  });
});

describe('answering it', () => {
  it('takes E on foot at its foot while it rings, and a stranger says a line as a subtitle, voiced down a phone line', () => {
    const { sim, ph, rings, lines } = ringing({ d: 10 });
    step(sim, 1);
    expect(markers(sim).length).toBe(1);
    answer(sim, ph.at);
    expect(lines.length).toBe(1);
    expect(lines[0]!.speaker).toBe(PAYPHONE_SPEAKER);
    expect(PAYPHONE_SPEAKER.endsWith(' (phone)')).toBe(true);
    expect(PAYPHONE_LINES).toContain(lines[0]!.text);
    // His clip is recorded: the subtitle stays up as long as it is spoken.
    const clip = SPEECH.dialogue[dialogueKey(PAYPHONE_SPEAKER, lines[0]!.text)]!;
    expect(clip).toBeTruthy();
    expect(lines[0]!.duration).toBeGreaterThan(SPEECH.clips[clip]!);
    expect(payphoneRinging(sim)).toBe(false);
    expect(markers(sim)).toEqual([]);
    const n = rings.length;
    step(sim, 20);
    expect(rings.length).toBe(n);
  });

  it('does nothing while it is quiet: a man at its foot presses E and nobody speaks', () => {
    const { sim, ph, lines } = ringing();
    answer(sim, ph.at);
    expect(lines).toEqual([]);
  });

  it('is quiet for four minutes after, then rings again for the next line', () => {
    const { sim, ph, rings, lines } = ringing({ d: 10 });
    step(sim, 1);
    answer(sim, ph.at);
    const first = lines[0]!.text;
    teleport(sim, ph.x, ph.z + 10);
    step(sim, PAYPHONE_COOLDOWN - 5);
    expect(payphoneRinging(sim)).toBe(false);
    const n = rings.length;
    step(sim, 10);
    expect(rings.length).toBeGreaterThan(n);
    expect(payphoneRinging(sim)).toBe(true);
    answer(sim, ph.at);
    expect(lines.length).toBe(2);
    expect(lines[1]!.text).not.toBe(first);
  });
});

describe('the lines', () => {
  /** What a sim says in answer to the phone, six calls in a row. */
  function sixCalls(seed?: number): string[] {
    const { sim, ph, lines } = ringing({ seed, d: 10 });
    for (let k = 0; k < PAYPHONE_LINES.length * 2; k++) {
      teleport(sim, ph.x, ph.z + 10);
      step(sim, k === 0 ? 1 : PAYPHONE_COOLDOWN + 1);
      answer(sim, ph.at);
    }
    return lines.map((l) => l.text);
  }

  it('are six, each said once before any is said again, in an order that is the same for a seed every time', () => {
    expect(PAYPHONE_LINES.length).toBe(6);
    const a = sixCalls();
    expect(a.length).toBe(12);
    expect(new Set(a.slice(0, 6)).size).toBe(6);
    expect(a.slice(6)).toEqual(a.slice(0, 6));
    expect(sixCalls()).toEqual(a);
    // The city's seed picks the order, so another seed's differs (all six agreeing by chance is a 1 in 720).
    expect(sixCalls(2).slice(0, 6)).not.toEqual(a.slice(0, 6));
  });

  it('each have a recorded clip, are short enough to be said in a subtitle, and read as words', () => {
    for (const text of PAYPHONE_LINES) {
      const id = SPEECH.dialogue[dialogueKey(PAYPHONE_SPEAKER, text)];
      expect(id, text).toBeTruthy();
      expect(SPEECH.clips[id!]!, text).toBeGreaterThan(3);
      expect(SPEECH.clips[id!]!, text).toBeLessThan(14);
      expect(text.length).toBeLessThan(160);
    }
  });
});

describe('a new game', () => {
  it('hangs it up: its marker goes, and it rings again for whoever comes near', () => {
    const { sim, ph, rings } = ringing({ d: 10 });
    step(sim, 1);
    expect(markers(sim).length).toBe(1);
    sim.resetSystems();
    expect(markers(sim)).toEqual([]);
    teleport(sim, ph.x, ph.z + 10);
    step(sim, 1);
    expect(rings.length).toBe(2);
    expect(markers(sim).length).toBe(1);
  });
});
