// A player with no stars standing near another player's police chase is never hurt by that chase: officers aim only at
// their own pursuit's player and hold fire while a round at him would go on into the bystander (VAL-MPX-002).

import { describe, expect, it } from 'vitest';
import type { Character } from '../../src/sim/entities';
import { makeSim } from './helpers';
import { behind, onLane, place, stepSlots } from './mp_helpers';

type Side = 'behind' | 'beside';

/** Where B stands each second: 12 m from A, on the far side of him from the officers, or beside him. */
function bystanderSpot(a: Character, officers: Array<{ x: number; z: number }>, side: Side): { x: number; z: number } | null {
  let cx = 0;
  let cz = 0;
  let n = 0;
  for (const o of officers) {
    const d = Math.hypot(o.x - a.pos.x, o.z - a.pos.z);
    if (d > 3 && d < 60) {
      cx += o.x;
      cz += o.z;
      n++;
    }
  }
  if (n === 0) return null;
  let dx = cx / n - a.pos.x;
  let dz = cz / n - a.pos.z;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l;
  dz /= l;
  const R = 12;
  if (side === 'behind') return { x: a.pos.x - dx * R, z: a.pos.z - dz * R };
  return { x: a.pos.x - dz * R, z: a.pos.z + dx * R };
}

function chase(seed: number, side: Side) {
  const sim = makeSim({ ambient: true, police: true, multiplayer: true, seed });
  const a = sim.players[0]!;
  const road = onLane(sim, 120, 30);
  place(sim, a, road.x, road.z);
  const b = sim.addPlayer(road.x + 10, road.z);
  place(sim, b, road.x + 10, road.z);
  // God mode keeps the 2-star chase of A going for the whole run; B is a normal player at full health.
  a.cheats.godMode = true;
  a.character.inventory.give('pistol', 900);
  a.character.inventory.current = 'pistol';
  const startHealth = b.character.health;

  let firedAtA = 0;
  let aimedOrFiredAtB = 0;
  const combat = sim.combat as unknown as { npcFire: (c: Character, t: Character, ...r: unknown[]) => unknown; holdAim: (c: Character, t: Character) => unknown };
  const fire = combat.npcFire.bind(sim.combat);
  const aim = combat.holdAim.bind(sim.combat);
  combat.npcFire = (c, t, ...r) => {
    if (c.isLaw && t === a.character) firedAtA++;
    if (c.isLaw && t === b.character) aimedOrFiredAtB++;
    return fire(c, t, ...r);
  };
  combat.holdAim = (c, t) => {
    if (c.isLaw && t === b.character) aimedOrFiredAtB++;
    return aim(c, t);
  };
  let copRounds = 0;
  sim.events.on('weaponFired', (e) => {
    if (e.shooter?.isLaw) copRounds++;
  });
  const copDamageToB: string[] = [];
  const otherDamageToB: string[] = [];
  let trafficLoss = 0;
  sim.events.on('damage', (e) => {
    if (e.victim !== b.character) return;
    // Ambient traffic can run him down where he is put on the carriageway: that is no one's chase.
    if (e.kind === 'vehicle' && !e.attacker) {
      trafficLoss += e.healthLoss;
      return;
    }
    (e.attacker?.isLaw ? copDamageToB : otherDamageToB).push(`${e.kind} by ${e.attacker?.id ?? 'nobody'} at ${sim.time.toFixed(1)}`);
  });

  let targetsB = 0;
  let maxChasing = 0;
  let near = 0;
  let placed = 0;
  for (let t = 0; t < 90; t++) {
    if (a.wanted.level !== 2) a.wanted.setLevel(2);
    const spot = t >= 3 ? bystanderSpot(a.character, [...sim.characters.filter((c) => c.isLaw && c.alive && !c.removed).map((c) => c.pos), ...sim.vehicles.filter((v) => v.owner === 'police' && !v.removed).map((v) => v.pos)], side) : null;
    if (spot) place(sim, b, spot.x, spot.z);
    stepSlots(sim, 1, (s, tt) => (s === a ? behind(a.character, { moveZ: 1 }, road.heading + (Math.floor((t + tt) / 6) % 2 === 0 ? 0 : Math.PI)) : null));
    const gap = Math.hypot(a.character.pos.x - b.character.pos.x, a.character.pos.z - b.character.pos.z);
    if (spot) {
      placed++;
      if (gap >= 6 && gap <= 16.5) near++;
    }
    let chasing = 0;
    for (const v of sim.vehicles) {
      if (v.removed || v.owner !== 'police' || !v.ai) continue;
      if (v.ai.target === b.character || (v.ai.target && v.ai.target === b.character.vehicle)) targetsB++;
      if (v.ai.policy === 'chase' && sim.police.targetSlotOf(v) === 0) chasing++;
    }
    for (const c of sim.characters) if (c.isLaw && !c.removed && c.alive && c.brain && c.brain.target === b.character) targetsB++;
    maxChasing = Math.max(maxChasing, chasing);
  }
  return { b, startHealth, trafficLoss, firedAtA, aimedOrFiredAtB, copRounds, copDamageToB, otherDamageToB, targetsB, maxChasing, near, placed };
}

/** A armed and standing his ground with B right beside him (no god mode): the police still get to A. */
function adjacent(seed: number, gap: number) {
  const sim = makeSim({ ambient: true, police: true, multiplayer: true, seed });
  const a = sim.players[0]!;
  const road = onLane(sim, 120, 30);
  place(sim, a, road.x, road.z);
  const b = sim.addPlayer(road.x + gap, road.z);
  place(sim, b, road.x + gap, road.z);
  a.character.inventory.give('pistol', 900);
  a.character.inventory.current = 'pistol';
  const startHealth = b.character.health;
  let damageToB = 0;
  let damageToA = 0;
  let bust = 0;
  let down = 0;
  sim.events.on('damage', (e) => {
    if (e.victim === b.character) damageToB++;
    if (e.victim === a.character && e.attacker?.isLaw) damageToA++;
  });
  sim.events.on('busted', (e) => {
    if ((e.playerId ?? 0) === 0) bust++;
  });
  sim.events.on('wasted', (e) => {
    if ((e.playerId ?? 0) === 0) down++;
  });
  let firstFight = -1;
  for (let t = 0; t < 90; t++) {
    if (a.wanted.level < 2 && bust + down === 0) a.wanted.setLevel(2);
    stepSlots(sim, 1);
    if (firstFight < 0 && (damageToA > 0 || bust + down > 0)) firstFight = t;
  }
  return { startHealth, b, damageToB, damageToA, bust, down, firstFight };
}

describe('a bystander near another player’s chase (VAL-MPX-002)', () => {
  for (const gap of [2, 5]) {
    it(`player 0 standing armed ${gap} m from player 1 is still reached by the police and player 1 is not hurt`, () => {
      for (const seed of [21, 22]) {
        const r = adjacent(seed, gap);
        console.log(`[mp-bystander] adjacent ${gap} m seed ${seed}: A hurt by police ${r.damageToA}, busted ${r.bust}, wasted ${r.down}, first at ${r.firstFight} s; B damage events ${r.damageToB}, health ${r.startHealth} -> ${r.b.character.health}`);
        expect(r.damageToA + r.bust + r.down).toBeGreaterThan(0);
        expect(r.damageToB).toBe(0);
        expect(r.b.character.health).toBe(r.startHealth);
      }
    }, 120_000);
  }

  for (const side of ['behind', 'beside'] as Side[]) {
    for (const seed of [21, 22, 23, 24]) {
      it(`player 1 with no stars ${side} player 0 in a 2-star chase is not hurt or aimed at (seed ${seed})`, () => {
        const r = chase(seed, side);
        console.log(`[mp-bystander] ${side} seed ${seed}: chasing units ${r.maxChasing}, cop rounds ${r.copRounds}, fired at A ${r.firedAtA}, at B ${r.aimedOrFiredAtB}; B ${r.startHealth} -> ${r.b.character.health}, police damage ${r.copDamageToB.length}, other damage ${JSON.stringify(r.otherDamageToB)}; ${r.near}/${r.placed} s within 6-16.5 m of A`);
        // The chase is live.
        expect(r.maxChasing).toBeGreaterThan(0);
        expect(r.firedAtA).toBeGreaterThan(0);
        expect(r.copRounds).toBeGreaterThan(0);
        // B stood 8-15 m from A nearly throughout (A is sent back to the station when busted, and B is placed afresh).
        expect(r.near).toBeGreaterThan(r.placed * 0.8);
        // Nothing of it reaches him.
        expect(r.aimedOrFiredAtB).toBe(0);
        expect(r.targetsB).toBe(0);
        expect(r.copDamageToB).toEqual([]);
        expect(r.otherDamageToB).toEqual([]);
        expect(r.b.character.health).toBe(r.startHealth - r.trafficLoss);
        expect(r.b.wanted.level).toBe(0);
      }, 120_000);
    }
  }
});
