// A passenger fated to drown when his car goes into the sea (sinking.ts) only drowns if he is still in the water when
// his time comes: one who made it onto dry ground (placed on the quay beside the car, or climbing out) lives, and
// nothing is charged to the driver for him.

import { describe, expect, it } from 'vitest';
import type { Character, DamageKind } from '../../src/sim/entities';
import { DROWN_AFTER, drownsInSinkingCar } from '../../src/sim/sinking';
import { SWIM_DEPTH, WATER_Y } from '../../src/world/constants';
import { makeSim, step } from './helpers';

/** The scrutiny scenario: a sedan rolling slowly over the Marina deck's east edge with the player and three passengers. */
function slowRollOff() {
  const sim = makeSim({ seed: 4, police: false });
  const deck = sim.world.layout.decks.find((d) => d.name === 'Marina' && d.rect.maxX - d.rect.minX > 50)!;
  const heading = Math.PI / 4;
  const v = sim.spawnVehicle('sedan', deck.rect.maxX - 0.05, (deck.rect.minZ + deck.rect.maxZ) / 2, heading);
  sim.seat(sim.player, v, 0);
  const people = [1, 2, 3].map((seat) => {
    const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
    sim.seat(c, v, seat);
    return c;
  });
  v.vel.x = Math.sin(heading);
  v.vel.z = Math.cos(heading);
  const drowns: Array<{ c: Character; kind: DamageKind; state: string; depth: number }> = [];
  sim.events.on('damage', (e) => {
    if (e.victim && people.includes(e.victim) && e.killed) {
      drowns.push({ c: e.victim, kind: e.kind, state: e.victim.state, depth: sim.world.waterDepth(e.victim.pos.x, e.victim.pos.z) });
    }
  });
  const crimes: string[] = [];
  const crime = sim.wanted.crime.bind(sim.wanted);
  sim.wanted.crime = (type, x, z, by) => {
    crimes.push(type);
    return crime(type, x, z, by);
  };
  return { sim, v, people, drowns, crimes };
}

describe('sinking car: no drowning on dry land', () => {
  it('a fated passenger who reaches dry ground before going under is not drowned or charged to the driver', () => {
    const r = slowRollOff();
    step(r.sim, 6);
    expect(r.v.inWater).toBe(true);
    const fated = r.people.filter((c) => drownsInSinkingCar(c));
    expect(fated.length).toBeGreaterThan(0);
    for (const d of r.drowns) {
      console.log(`[sinking] #${d.c.id} died (${d.kind}) state ${d.state}, water depth ${d.depth.toFixed(2)}`);
      // Lethal drowning only in the water, never on the deck.
      expect(d.state).toBe('swimming');
      expect(d.depth).toBeGreaterThan(SWIM_DEPTH);
    }
    for (const c of r.people) {
      const dry = r.sim.world.waterDepth(c.pos.x, c.pos.z) <= 0;
      console.log(`[sinking] #${c.id} fated ${drownsInSinkingCar(c)} alive ${c.alive} state ${c.state} dry ${dry}`);
      if (c.alive) continue;
      expect(r.drowns.some((d) => d.c === c)).toBe(true);
    }
    expect(r.sim.progress.stats.kills).toBe(r.drowns.length);
    expect(r.crimes.filter((t) => t === 'murder')).toHaveLength(r.drowns.length);
  });

  it('a fated passenger who climbs out of the water before his time lives; one still swimming drowns', () => {
    const sim = makeSim({ seed: 4, police: false });
    const deck = sim.world.layout.decks.find((d) => d.name === 'Marina' && d.rect.maxX - d.rect.minX > 50)!;
    const v = sim.spawnVehicle('sedan', deck.rect.minX + 20, (deck.rect.minZ + deck.rect.maxZ) / 2, 0);
    sim.seat(sim.player, v, 0);
    const fated: Character[] = [];
    // Ids decide who is fated; the unfated ones spawned along the way just stand on the deck.
    for (let seat = 1; fated.length < 2; ) {
      const c = sim.spawnCharacter('civilian', deck.rect.minX + 10, (deck.rect.minZ + deck.rect.maxZ) / 2);
      if (!drownsInSinkingCar(c)) continue;
      sim.seat(c, v, seat++);
      fated.push(c);
    }
    // Open sea, 40 m off the west shore: nobody swims back to land within DROWN_AFTER.
    v.pos.x = sim.world.bounds.landMinX - 40;
    v.pos.z = 0;
    v.pos.y = WATER_Y;
    let under = -1;
    for (let f = 0; f < 60 * 3 && under < 0; f++) {
      step(sim, 1 / 60);
      if (v.inWater) under = sim.time;
    }
    expect(under).toBeGreaterThan(0);
    const [climber, swimmer] = fated as [Character, Character];
    step(sim, 0.5);
    expect(climber.state).toBe('swimming');
    expect(swimmer.state).toBe('swimming');
    // The climber is out on the deck well before DROWN_AFTER (as if he had swum to it).
    climber.pos.x = deck.rect.minX + 5;
    climber.pos.z = (deck.rect.minZ + deck.rect.maxZ) / 2;
    climber.pos.y = deck.y;
    climber.vel.x = climber.vel.y = climber.vel.z = 0;
    climber.state = 'normal';
    climber.onGround = true;
    step(sim, 0.5);
    expect(climber.state).toBe('normal');
    step(sim, DROWN_AFTER + 1);
    console.log(`[sinking] open sea: climber #${climber.id} ${climber.alive ? climber.state : 'dead'}, swimmer #${swimmer.id} ${swimmer.alive ? swimmer.state : 'dead'}, kills ${sim.progress.stats.kills}`);
    expect(climber.alive).toBe(true);
    expect(swimmer.alive).toBe(false);
    expect(sim.progress.stats.kills).toBe(1);
  });
});
