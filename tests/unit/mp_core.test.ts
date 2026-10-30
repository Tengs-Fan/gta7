// The multi-player sim core: each player's own wanted level and police pursuit, busts, deaths and respawns that touch
// only their player, a shared clock, per-player pickups, purchases and jobs, and what multiplayer sims refuse
// (VAL-MPSIM-001..004, 007, 009). Streaming, determinism and the single-player trace are in mp_core_streaming.test.ts.

import { describe, expect, it } from 'vitest';
import type { Character, Vehicle } from '../../src/sim/entities';
import { applySimCheat, MP_NO_CHEATS } from '../../src/sim/cheats';
import { MP_NO_SAVE } from '../../src/sim/interactions';
import { MP_NO_STORY } from '../../src/sim/missions/runner';
import { PLAYER_SCOPED_EVENTS } from '../../src/sim/events';
import type { PlayerSlot } from '../../src/sim/playerSlot';
import type { Sim } from '../../src/sim/sim';
import { input, makeSim } from './helpers';
import { behind, DT, onLane, place, recordEvents, stepSlots } from './mp_helpers';

/** Every police unit, officer and helicopter, with the slot it works for. */
function policeBySlot(sim: Sim): { units: Map<number, Vehicle[]>; officers: Map<number, Character[]>; helis: Map<number, number> } {
  const units = new Map<number, Vehicle[]>();
  const officers = new Map<number, Character[]>();
  const helis = new Map<number, number>();
  for (const v of sim.vehicles) {
    if (v.removed || v.owner !== 'police' || !v.driver?.isLaw) continue;
    const id = sim.police.targetSlotOf(v);
    units.set(id, [...(units.get(id) ?? []), v]);
  }
  for (const c of sim.characters) {
    if (c.removed || !c.isLaw || !c.alive) continue;
    const id = sim.police.targetSlotOf(c);
    officers.set(id, [...(officers.get(id) ?? []), c]);
  }
  for (const h of sim.helis) if (!h.removed && !h.destroyed) helis.set(sim.police.targetSlotOf(h), (helis.get(sim.police.targetSlotOf(h)) ?? 0) + 1);
  return { units, officers, helis };
}

/** Every character the police fire at or aim at, counted (CombatSystem.npcFire / holdAim), and every bust. */
function watchPolice(sim: Sim): { firedAt: Map<Character, number>; aimedAt: Map<Character, number> } {
  const firedAt = new Map<Character, number>();
  const aimedAt = new Map<Character, number>();
  const combat = sim.combat as unknown as { npcFire: (c: Character, t: Character, ...r: unknown[]) => unknown; holdAim: (c: Character, t: Character) => unknown };
  const fire = combat.npcFire.bind(sim.combat);
  const aim = combat.holdAim.bind(sim.combat);
  combat.npcFire = (c, t, ...r) => {
    if (c.isLaw) firedAt.set(t, (firedAt.get(t) ?? 0) + 1);
    return fire(c, t, ...r);
  };
  combat.holdAim = (c, t) => {
    if (c.isLaw) aimedAt.set(t, (aimedAt.get(t) ?? 0) + 1);
    return aim(c, t);
  };
  return { firedAt, aimedAt };
}

const UNITS_BY_LEVEL = [0, 2, 3, 4, 6, 7];

describe('wanted levels and crimes per player (VAL-MPSIM-001)', () => {
  it('player 1’s crimes raise only player 1’s level, and every player-scoped event names its slot', () => {
    const sim = makeSim({ police: true, multiplayer: true });
    const log = recordEvents(sim);
    const a = sim.players[0]!;
    const road = onLane(sim, 60, 25);
    place(sim, a, road.x, road.z);
    const b = sim.addPlayer(road.x + 80, road.z);
    place(sim, b, road.x + 80, road.z);
    const p = b.character;
    // An officer looking on, and a pedestrian in front of him.
    const cop = sim.spawnCharacter('cop', p.pos.x - 3, p.pos.z + 3);
    sim.police.equipOfficer(cop, null);
    const victim = sim.spawnCharacter('civilian', p.pos.x + 1.5, p.pos.z);
    const steps: string[] = [];
    const note = (what: string) => steps.push(`${what}: slot0 ${a.wanted.level}, slot1 ${b.wanted.level}`);
    sim.combat.damageCharacter(victim, 6, p, 'melee', 1, 0, 0);
    note('slot 1 punches a pedestrian by a cop');
    expect(b.wanted.level).toBeGreaterThanOrEqual(1);
    expect(a.wanted.level).toBe(0);
    // Shooting by the police: two stars.
    p.inventory.give('pistol', 120);
    p.inventory.current = 'pistol';
    for (let i = 0; i < 90 && b.wanted.level < 2; i++) {
      const shoot = i % 12 === 0;
      stepSlots(sim, DT, (s) => (s === b ? behind(p, { aim: true, fire: shoot, firePressed: shoot }, Math.PI / 2) : null));
    }
    note('slot 1 fires by the police');
    expect(b.wanted.level).toBeGreaterThanOrEqual(2);
    expect(a.wanted.level).toBe(0);
    // Slot 0 commits a crime of his own, by another officer.
    const cop2 = sim.spawnCharacter('cop', a.character.pos.x + 3, a.character.pos.z);
    sim.police.equipOfficer(cop2, null);
    const victim2 = sim.spawnCharacter('civilian', a.character.pos.x - 1.5, a.character.pos.z);
    const before1 = b.wanted.level;
    sim.combat.damageCharacter(victim2, 6, a.character, 'melee', -1, 0, 0);
    note('slot 0 punches a pedestrian by a cop');
    expect(a.wanted.level).toBeGreaterThanOrEqual(1);
    expect(b.wanted.level).toBe(before1);
    // A kill by slot 1 is a world event carrying his id.
    const target = sim.spawnCharacter('civilian', p.pos.x + 2, p.pos.z + 2);
    sim.combat.damageCharacter(target, 500, p, 'bullet', 1, 0, 0);
    // Both lose sight of the police at once (no units come: no ambient life): slot 1's two stars go first (18 s
    // unseen), slot 0's three take longer (28 s), so when slot 1's go, slot 0's are still there.
    a.wanted.setLevel(3);
    note('slot 0 at three stars');
    for (const c of [cop, cop2]) sim.removeCharacter(c);
    place(sim, b, road.x + 400, road.z + 400);
    place(sim, a, road.x - 300, road.z - 300);
    expect(b.wanted.level).toBe(2);
    let t = 0;
    while (b.wanted.level > 0 && t < 120) {
      stepSlots(sim, 0.5);
      t += 0.5;
    }
    note(`after ${t} s unseen`);
    expect(b.wanted.level).toBe(0);
    expect(a.wanted.level).toBe(3);
    const lvA = a.wanted.level;
    console.log(`[mpsim-001] ${steps.join('; ')}`);

    const scoped = (type: string) => log.filter((e) => e.type === type);
    const wanted = scoped('wanted');
    // Slot 0's events name it too: a multiplayer sim never leaves the field to the single-player undefined-means-0 rule.
    for (const e of wanted) expect([0, 1]).toContain(e.payload.playerId);
    expect(wanted.some((e) => e.payload.playerId === 0)).toBe(true);
    const w1 = wanted.filter((e) => e.payload.playerId === 1);
    expect(w1.length).toBeGreaterThanOrEqual(3);
    // Each wanted event belongs to the slot whose level it reports.
    let lv0 = 0;
    let lv1 = 0;
    for (const e of wanted) {
      if (e.payload.playerId === 1) {
        expect(e.payload.previous).toBe(lv1);
        lv1 = e.payload.level as number;
      } else {
        expect(e.payload.previous).toBe(lv0);
        lv0 = e.payload.level as number;
      }
    }
    expect(lv1).toBe(0);
    expect(lv0).toBe(lvA);
    const lost = scoped('message').filter((e) => e.payload.text === 'You lost the cops.');
    expect(lost.map((e) => e.payload.playerId)).toEqual([1]);
    for (const type of PLAYER_SCOPED_EVENTS) for (const e of scoped(type)) expect(typeof e.payload.playerId, `${type} carries an explicit playerId`).toBe('number');
    // Dispatch lines for slot 1's chase and for slot 0's are each on their own player's scanner.
    const dispatch = scoped('dispatch');
    expect(dispatch.some((e) => e.payload.playerId === 1)).toBe(true);
    for (const e of dispatch) expect(typeof e.payload.text).toBe('string');
    const d1 = dispatch.filter((e) => e.payload.playerId === 1).map((e) => e.payload.text as string);
    expect(d1.some((t) => t.includes('return to patrol'))).toBe(true);
    // Money: slot 1 picks up cash someone dropped.
    sim.pickupSys.dropMoney(p.pos.x, p.pos.z, 37);
    const moneyBefore = [a.progress.money, b.progress.money];
    stepSlots(sim, 0.2);
    expect(b.progress.money).toBe(moneyBefore[1]! + 37);
    expect(a.progress.money).toBe(moneyBefore[0]);
    expect(scoped('money').filter((e) => e.payload.amount === 37).map((e) => e.payload.playerId)).toEqual([1]);
    // World events of slot 1's doing carry his id; nobody's carry none.
    const shots = scoped('shot').filter((e) => (e.payload.shooter as Character | null) === p);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((e) => e.payload.playerId === 1)).toBe(true);
    const shots0 = scoped('shot').filter((e) => (e.payload.shooter as Character | null) === a.character);
    expect(shots0.every((e) => e.payload.playerId === 0)).toBe(true);
    expect(scoped('weaponFired').filter((e) => e.payload.shooter === p).every((e) => e.payload.playerId === 1)).toBe(true);
    const kill = scoped('characterKilled').find((e) => e.payload.victim === target)!;
    expect(kill.payload.playerId).toBe(1);
    const target0 = sim.spawnCharacter('civilian', a.character.pos.x + 2, a.character.pos.z + 2);
    sim.combat.damageCharacter(target0, 500, a.character, 'bullet', 1, 0, 0);
    expect(scoped('characterKilled').find((e) => e.payload.victim === target0)!.payload.playerId).toBe(0);
    console.log(`[mpsim-001] events: wanted ${wanted.map((e) => `${e.payload.previous}->${e.payload.level}@${e.payload.playerId ?? 0}`).join(' ')}; dispatch ${dispatch.map((e) => `${e.payload.playerId ?? 0}:"${e.payload.text}"`).join(' | ')}; lost ${lost.length}; shots by slot 1 ${shots.length}, kill playerId ${kill.payload.playerId}`);
  });
});

describe('player tags in a sim with one seat (single player)', () => {
  it('leaves slot 0 untagged until a second slot or a server room exists', () => {
    const sim = makeSim({ police: true });
    const log = recordEvents(sim);
    sim.players[0]!.wanted.setLevel(2);
    expect(log.filter((e) => e.type === 'wanted').length).toBeGreaterThan(0);
    for (const e of log) expect('playerId' in e.payload).toBe(false);
    sim.addPlayer(sim.player.pos.x + 20, sim.player.pos.z);
    sim.players[0]!.wanted.setLevel(0);
    expect(log.filter((e) => e.type === 'wanted').pop()!.payload.playerId).toBe(0);
  });
});

describe('the police pursue the right player (VAL-MPSIM-002)', () => {
  it('units chase player 1 only, never fire at or arrest player 0 beside it; two pursuits keep their own caps', () => {
    const sim = makeSim({ ambient: true, police: true, multiplayer: true, seed: 21 });
    const a = sim.players[0]!;
    const road = onLane(sim, 120, 30);
    place(sim, a, road.x, road.z);
    const b = sim.addPlayer(road.x, road.z);
    // 80 m apart along the road.
    place(sim, b, road.x + Math.sin(road.heading) * 80, road.z + Math.cos(road.heading) * 80);
    // Player 1 armed (so the police shoot rather than cuff him) and in god mode, walking back and forth.
    b.cheats.godMode = true;
    a.cheats.godMode = true;
    b.character.inventory.give('pistol', 500);
    b.character.inventory.current = 'pistol';
    b.wanted.setLevel(3);
    const watch = watchPolice(sim);
    const busts: number[] = [];
    sim.events.on('busted', (e) => busts.push(e.playerId ?? 0));
    const series: Array<{ t: number; units: number; mean: number }> = [];
    let wrongTarget = 0;
    let maxUnits1 = 0;
    let heli1 = 0;
    let besideSeconds = 0;
    let t = 0;
    const walk = (s: PlayerSlot, tt: number) => (s === b ? behind(b.character, { moveZ: 1 }, road.heading + (Math.floor(tt / 6) % 2 === 0 ? 0 : Math.PI)) : null);
    for (; t < 90; t++) {
      // From 45 s player 0 stands 8 m from player 1, in the middle of the pursuit.
      if (t >= 45) {
        const q = b.character.pos;
        place(sim, a, q.x + 6, q.z + 5);
        besideSeconds++;
      }
      if (b.wanted.level !== 3) b.wanted.setLevel(3);
      stepSlots(sim, 1, (s, tt) => walk(s, t + tt));
      const pol = policeBySlot(sim);
      for (const v of sim.vehicles) {
        if (v.removed || v.owner !== 'police' || !v.ai) continue;
        if (v.ai.target === a.character) wrongTarget++;
        if (v.ai.policy === 'chase' && sim.police.targetSlotOf(v) !== 1 && a.wanted.level === 0 && v.ai.target) wrongTarget++;
      }
      const mine = (pol.units.get(1) ?? []).filter((v) => v.ai?.policy === 'chase');
      maxUnits1 = Math.max(maxUnits1, mine.length);
      heli1 = Math.max(heli1, pol.helis.get(1) ?? 0);
      const bp = b.character.pos;
      series.push({ t, units: mine.length, mean: mine.length ? mine.reduce((n, v) => n + Math.hypot(v.pos.x - bp.x, v.pos.z - bp.z), 0) / mine.length : NaN });
      expect(a.wanted.level).toBe(0);
    }
    // As they close in on him: from where they set out (the first seconds) to the chase (12-24 s).
    const early = series.filter((s) => s.t < 4 && Number.isFinite(s.mean));
    const later = series.filter((s) => s.t >= 12 && s.t < 24 && Number.isFinite(s.mean));
    const avg = (xs: typeof series) => xs.reduce((n, s) => n + s.mean, 0) / xs.length;
    console.log(`[mpsim-002] slot 1 at 3 stars: pursuing units over time ${series.filter((s) => s.t % 10 === 0).map((s) => `${s.t}s:${s.units}u@${Number.isFinite(s.mean) ? s.mean.toFixed(0) : '-'}m`).join(' ')}; mean distance 0-4 s ${avg(early).toFixed(0)} m -> 12-24 s ${avg(later).toFixed(0)} m; police fired at slot 0 ${watch.firedAt.get(a.character) ?? 0} times, aimed ${watch.aimedAt.get(a.character) ?? 0}, at slot 1 ${watch.firedAt.get(b.character) ?? 0}; ${besideSeconds} s with slot 0 8 m from slot 1; busts ${JSON.stringify(busts)}; wrong targets ${wrongTarget}`);
    expect(early.length).toBeGreaterThan(0);
    expect(avg(later)).toBeLessThan(avg(early));
    expect(watch.firedAt.get(b.character) ?? 0).toBeGreaterThan(0);
    expect(watch.firedAt.get(a.character) ?? 0).toBe(0);
    expect(watch.aimedAt.get(a.character) ?? 0).toBe(0);
    expect(busts.filter((id) => id === 0)).toEqual([]);
    expect(wrongTarget).toBe(0);
    expect(maxUnits1).toBeLessThanOrEqual(UNITS_BY_LEVEL[3]!);
    expect(heli1).toBeLessThanOrEqual(1);

    // Player 0 gets 2 stars: his pursuit is separate and keeps its own cap.
    a.character.inventory.give('pistol', 500);
    a.character.inventory.current = 'pistol';
    place(sim, a, b.character.pos.x + 150, b.character.pos.z);
    a.wanted.setLevel(2);
    let shared = 0;
    let max0 = 0;
    let max1 = 0;
    let helis0 = 0;
    for (let k = 0; k < 40; k++) {
      if (b.wanted.level !== 3) b.wanted.setLevel(3);
      if (a.wanted.level !== 2) a.wanted.setLevel(2);
      stepSlots(sim, 1, (s, tt) => (s === a ? behind(a.character, { moveZ: 1 }, road.heading + Math.PI / 2 + (Math.floor((k + tt) / 5) % 2 === 0 ? 0 : Math.PI)) : walk(s, t + k + tt)));
      const pol = policeBySlot(sim);
      const u0 = pol.units.get(0) ?? [];
      const u1 = pol.units.get(1) ?? [];
      const aimsAt = (v: Vehicle, s: PlayerSlot) => !!v.ai?.target && (v.ai.target === s.character || v.ai.target === s.character.vehicle);
      for (const v of u0) if (aimsAt(v, b)) shared++;
      for (const v of u1) if (aimsAt(v, a)) shared++;
      max0 = Math.max(max0, u0.filter((v) => v.ai?.policy === 'chase').length);
      max1 = Math.max(max1, u1.filter((v) => v.ai?.policy === 'chase').length);
      helis0 = Math.max(helis0, pol.helis.get(0) ?? 0);
    }
    console.log(`[mpsim-002] slot 0 at 2 stars too: most chasing units slot 0 ${max0} (cap ${UNITS_BY_LEVEL[2]}), slot 1 ${max1} (cap ${UNITS_BY_LEVEL[3]}); units chasing the other pursuit's player ${shared}; helicopters slot 0 ${helis0}`);
    expect(max0).toBeGreaterThan(0);
    expect(max0).toBeLessThanOrEqual(UNITS_BY_LEVEL[2]!);
    expect(max1).toBeLessThanOrEqual(UNITS_BY_LEVEL[3]!);
    expect(shared).toBe(0);
    expect(helis0).toBe(0);
  }, 60_000);
});

describe('a bust or death touches only its player (VAL-MPSIM-003)', () => {
  /** Slot 0's state, all of it that a bust or death elsewhere could change. */
  function stateOf(sim: Sim, s: PlayerSlot) {
    const c = s.character;
    return {
      wanted: s.wanted.level,
      pos: [c.pos.x, c.pos.y, c.pos.z],
      health: c.health,
      armor: c.armor,
      money: s.progress.money,
      weapons: c.inventory.owned().map((w) => [w, c.inventory.total(w)]),
      vehicle: c.vehicle?.id ?? null,
      pursuit: [...(policeBySlot(sim).units.get(s.id) ?? [])].map((v) => v.id).sort(),
      officers: [...(policeBySlot(sim).officers.get(s.id) ?? [])].map((o) => o.id).sort(),
      down: s.deathKind,
    };
  }

  for (const how of ['busted', 'wasted'] as const) {
    it(`player 1 ${how}: his own bill and respawn; player 0's state and pursuit unchanged, his controls never locked`, () => {
      const sim = makeSim({ ambient: false, police: true, multiplayer: true, seed: 4 });
      const a = sim.players[0]!;
      const road = onLane(sim, 90, 30);
      place(sim, a, road.x, road.z);
      const b = sim.addPlayer(road.x + 60, road.z);
      place(sim, b, road.x + 60, road.z);
      a.character.inventory.give('pistol', 60);
      b.character.inventory.give('smg', 90);
      a.progress.money = 5000;
      b.progress.money = 5000;
      a.wanted.setLevel(2);
      b.wanted.setLevel(3);
      // Both pursuits have units (no ambient life: placed by hand, as dispatch would).
      sim.update(DT, new Map([[0, behind(a.character)], [1, behind(b.character)]]));
      for (const s of [a, b]) {
        let n = 0;
        for (let k = 0; k < 20 && n < 2; k++) if (sim.police.spawnUnit('police', true, s)) n++;
        expect(n).toBe(2);
      }
      const before = stateOf(sim, a);
      expect(before.pursuit.length).toBe(2);
      expect(stateOf(sim, b).pursuit.length).toBe(2);
      if (how === 'busted') sim.bustPlayer(b);
      else sim.combat.damageCharacter(b.character, 5000, null, 'fall', 0, -1, 0);
      expect(b.deathKind).toBe(how);
      // The death sequence runs in slot 1 while slot 0 plays on (in god mode against his own pursuit's fire).
      a.cheats.godMode = true;
      let locked = 0;
      const frames = Math.ceil(5 / DT);
      for (let i = 0; i < frames && b.deathKind; i++) {
        sim.update(DT, new Map([[0, behind(a.character, { aim: true }, Math.PI / 2)], [1, behind(b.character)]]));
        if (a.controlLock > 0 || a.deathKind) locked++;
      }
      expect(b.deathKind).toBeNull();
      const after = stateOf(sim, a);
      const poi = sim.world.layout.pois.find((p) => p.id === (how === 'busted' ? 'police' : 'hospital'))!;
      const fee = 100 + (how === 'busted' ? 150 : 100) * 3;
      console.log(`[mpsim-003 ${how}] slot 1 respawned ${Math.hypot(b.character.pos.x - poi.x, b.character.pos.z - poi.z).toFixed(1)} m from the ${poi.id}, money 5000 -> ${b.progress.money} (fee ${fee}), wanted ${b.wanted.level}, weapons ${b.character.inventory.owned().join(',')}; slot 0 before ${JSON.stringify(before)} after ${JSON.stringify(after)}; frames with slot 0 locked ${locked}; slot 1 pursuit ${stateOf(sim, b).pursuit.length}`);
      expect(Math.hypot(b.character.pos.x - poi.x, b.character.pos.z - poi.z)).toBeLessThan(12);
      expect(b.progress.money).toBe(5000 - fee);
      expect(b.wanted.level).toBe(0);
      expect(stateOf(sim, b).pursuit).toEqual([]);
      if (how === 'busted') expect(b.character.inventory.owned()).toEqual(['fists']);
      else expect(b.character.armor).toBe(0);
      expect(locked).toBe(0);
      // Slot 0: nothing changed by any of it (he stood still: his own units chased him meanwhile, but none went).
      expect(after.wanted).toBe(before.wanted);
      expect(after.money).toBe(before.money);
      expect(after.weapons).toEqual(before.weapons);
      expect(after.vehicle).toBe(before.vehicle);
      expect(after.health).toBe(before.health);
      expect(after.down).toBeNull();
      expect(after.pursuit).toEqual(before.pursuit);
      expect(Math.hypot(after.pos[0]! - before.pos[0]!, after.pos[2]! - before.pos[2]!)).toBeLessThan(0.5);
    });
  }

  it('a unit only the respawning player can see goes; one another player sees stays on patrol', () => {
    const sim = makeSim({ ambient: false, police: true, multiplayer: true, seed: 1 });
    const a = sim.players[0]!;
    const road = onLane(sim, 90, 30);
    place(sim, a, road.x, road.z);
    const b = sim.addPlayer(road.x + 60, road.z);
    place(sim, b, road.x + 60, road.z);
    b.wanted.setLevel(3);
    sim.update(DT, new Map([[0, behind(a.character)], [1, behind(b.character)]]));
    const units: Vehicle[] = [];
    for (let k = 0; k < 20 && units.length < 2; k++) {
      const v = sim.police.spawnUnit('police', true, b);
      if (v) units.push(v);
    }
    expect(units.length).toBe(2);
    const [mine, shared] = units as [Vehicle, Vehicle];
    // Player 1's camera looks at both units, player 0's only at the second.
    const look = (s: PlayerSlot, v: Vehicle) => {
      s.cam.x = v.pos.x - 20;
      s.cam.y = v.pos.y + 3;
      s.cam.z = v.pos.z;
      s.camDir.x = 1;
      s.camDir.y = 0;
      s.camDir.z = 0;
    };
    look(b, mine);
    look(a, shared);
    expect(sim.seenFrom(b, mine.pos.x, mine.pos.y, mine.pos.z, 320)).toBe(true);
    expect(sim.seenFrom(a, mine.pos.x, mine.pos.y, mine.pos.z, 320)).toBe(false);
    sim.police.dismiss(b);
    expect(mine.removed).toBe(true);
    expect(shared.removed).toBe(false);
  });
});

describe('a respawn and the shared clock (VAL-MPSIM-004)', () => {
  it('in a 2-player sim the clock runs on by sim time only through player 1’s death, while player 0 keeps playing', () => {
    const sim = makeSim({ ambient: false, police: false, multiplayer: true, startHour: 10 });
    const a = sim.players[0]!;
    const b = sim.addPlayer(a.character.pos.x + 8, a.character.pos.z);
    const h0 = sim.clock.hours;
    const t0 = sim.time;
    sim.combat.damageCharacter(b.character, 5000, null, 'fall', 0, -1, 0);
    expect(b.deathKind).toBe('wasted');
    const start = { ...a.character.pos };
    let moved = 0;
    let lockedA = 0;
    let lockedB = 0;
    let frames = 0;
    while (b.deathKind && frames < 600) {
      sim.update(DT, new Map([[0, behind(a.character, { moveZ: 1 })], [1, behind(b.character, { moveZ: 1 })]]));
      frames++;
      if (a.controlLock > 0 || a.deathKind) lockedA++;
      if (b.deathKind) lockedB++;
    }
    moved = Math.hypot(a.character.pos.x - start.x, a.character.pos.z - start.z);
    const dh = sim.clock.hours - h0;
    const elapsed = (sim.time - t0) * sim.clock.rate;
    console.log(`[mpsim-004] 2 players: slot 1 down for ${frames} frames (${(frames * DT).toFixed(2)} s, his death timer in his slot), clock ${h0.toFixed(4)} -> ${sim.clock.hours.toFixed(4)} h (+${dh.toFixed(4)} h, elapsed sim time ${elapsed.toFixed(4)} h); slot 0 walked ${moved.toFixed(1)} m meanwhile, locked ${lockedA} frames`);
    expect(Math.abs(dh - elapsed)).toBeLessThan(1e-6);
    expect(lockedA).toBe(0);
    expect(moved).toBeGreaterThan(5);
    expect(lockedB).toBeGreaterThan(200);
  });

  it('in single player a respawn still skips the hours spent in hospital', () => {
    const sim = makeSim({ ambient: false, police: false, startHour: 10 });
    const h0 = sim.clock.hours;
    const t0 = sim.time;
    sim.combat.damageCharacter(sim.player, 5000, null, 'fall', 0, -1, 0);
    let frames = 0;
    while (sim.playerDown && frames < 600) {
      sim.update(DT, input());
      frames++;
    }
    const dh = sim.clock.hours - h0;
    const elapsed = (sim.time - t0) * sim.clock.rate;
    console.log(`[mpsim-004] 1 player: clock ${h0.toFixed(4)} -> ${sim.clock.hours.toFixed(4)} h (+${dh.toFixed(4)} h: 6 h skipped plus ${elapsed.toFixed(4)} h of sim time)`);
    expect(dh).toBeCloseTo(6 + elapsed, 6);
  });
});

describe('pickups, purchases and activities per player (VAL-MPSIM-007)', () => {
  it('pickups and the gun shop pay and serve only their player; pickup timers are shared', () => {
    const sim = makeSim({ ambient: false, police: false, multiplayer: true });
    const a = sim.players[0]!;
    const health = sim.pickups.find((p) => p.kind === 'health')!;
    expect(health).toBeDefined();
    const b = sim.addPlayer(health.pos.x + 40, health.pos.z);
    place(sim, a, health.pos.x + 60, health.pos.z);
    b.character.health = 30;
    a.character.health = 30;
    place(sim, b, health.pos.x, health.pos.z);
    stepSlots(sim, 0.1);
    expect(b.character.health).toBe(b.character.maxHealth);
    expect(a.character.health).toBe(30);
    expect(health.active).toBe(false);
    // The respawn timer is the pickup's: inactive for player 0 as well, until it comes back.
    place(sim, a, health.pos.x, health.pos.z);
    stepSlots(sim, 0.1);
    expect(a.character.health).toBe(30);
    sim.pickupSys.dropMoney(b.character.pos.x + 1, b.character.pos.z, 55);
    const m0 = [a.progress.money, b.progress.money];
    place(sim, a, health.pos.x + 60, health.pos.z);
    place(sim, b, b.character.pos.x + 1, b.character.pos.z);
    stepSlots(sim, 0.2);
    expect(b.progress.money).toBe(m0[1]! + 55);
    expect(a.progress.money).toBe(m0[0]);
    // Player 0 buys armour.
    a.progress.money = 1000;
    const bm = b.progress.money;
    expect(sim.interactions.buy('armor', a)).toBeNull();
    expect(a.character.armor).toBe(100);
    expect(a.progress.money).toBe(700);
    expect(b.character.armor).toBe(0);
    expect(b.progress.money).toBe(bm);
    console.log(`[mpsim-007] health pickup: slot 1 30 -> ${b.character.health}, slot 0 stays ${a.character.health} (pickup inactive for both, respawn timer ${health.respawnTimer.toFixed(1)} s); cash: slot 1 +55; armour: slot 0 paid 300 (money ${a.progress.money}, armour ${a.character.armor}), slot 1 armour ${b.character.armor}, money unchanged`);
  });

  it('two players run their own jobs at once: taxi and vigilante, each with its own status, objectives and pay', () => {
    const sim = makeSim({ ambient: true, police: true, multiplayer: true, seed: 8 });
    const a = sim.players[0]!;
    const r0 = onLane(sim, 80, 20);
    const r1 = onLane(sim, 200, 20);
    const taxi = sim.spawnVehicle('taxi', r0.x, r0.z, r0.heading);
    const cruiser = sim.spawnVehicle('police', r1.x, r1.z, r1.heading);
    const b = sim.addPlayer(r1.x + 4, r1.z);
    sim.seat(b.character, taxi, 0);
    sim.seat(a.character, cruiser, 0);
    // Player 1 starts a taxi job: player 0 has none, and none of its objectives.
    sim.update(DT, new Map([[1, behind(b.character, { job: true })], [0, behind(a.character)]]));
    expect(sim.activities.jobOf(b)?.kind).toBe('taxi');
    expect(sim.activities.jobOf(a)).toBeNull();
    expect(sim.activities.objectives(a)).toEqual([]);
    expect(sim.activities.objectives(b).length).toBeGreaterThan(0);
    // Player 0 starts vigilante in the cruiser.
    sim.update(DT, new Map([[0, behind(a.character, { job: true })], [1, behind(b.character)]]));
    expect(sim.activities.jobOf(a)?.kind).toBe('vigilante');
    expect(sim.activities.jobOf(b)?.kind).toBe('taxi');
    stepSlots(sim, 2);
    const statusA = sim.activities.status(a);
    const statusB = sim.activities.status(b);
    expect(statusA).not.toBe(statusB);
    const objA = sim.activities.objectives(a);
    const objB = sim.activities.objectives(b);
    expect(objA.length).toBeGreaterThan(0);
    expect(objB.length).toBeGreaterThan(0);
    // A taxi fare for player 1: the fare gets in and is driven to the stop (placed there), paid to player 1.
    const log = recordEvents(sim);
    const tj = sim.activities.jobOf(b)!;
    expect(tj.kind).toBe('taxi');
    const fare = (tj as { fare: Character | null }).fare!;
    expect(fare).toBeTruthy();
    // Drive up to the fare and stop.
    place(sim, b, fare.pos.x + 2, fare.pos.z);
    taxi.vel.x = 0;
    taxi.vel.z = 0;
    for (let i = 0; i < 600 && (tj as { stage: string }).stage !== 'dropoff'; i++) sim.update(DT, new Map([[1, behind(b.character, { brake: 1 })], [0, behind(a.character)]]));
    expect((tj as { stage: string }).stage).toBe('dropoff');
    const dest = sim.activities.objectives(b)[0]!;
    const money = [a.progress.money, b.progress.money];
    place(sim, b, dest.x, dest.z);
    for (let i = 0; i < 600 && b.progress.money === money[1]; i++) sim.update(DT, new Map([[1, behind(b.character, { brake: 1 })], [0, behind(a.character)]]));
    expect(b.progress.money).toBeGreaterThan(money[1]!);
    expect(a.progress.money).toBe(money[0]);
    const paid = log.filter((e) => e.type === 'money');
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((e) => e.payload.playerId === 1)).toBe(true);
    expect(log.filter((e) => e.type === 'activityMilestone').map((e) => [e.payload.kind, e.payload.playerId])).toEqual([['taxi', 1]]);
    // Ending player 1's job leaves player 0's running.
    sim.update(DT, new Map([[1, behind(b.character, { job: true })], [0, behind(a.character)]]));
    expect(sim.activities.jobOf(b)).toBeNull();
    expect(sim.activities.jobOf(a)?.kind).toBe('vigilante');
    const ended = log.filter((e) => e.type === 'activityEnded');
    expect(ended.map((e) => [e.payload.kind, e.payload.playerId])).toEqual([['taxi', 1]]);
    console.log(`[mpsim-007] jobs: slot 0 vigilante (status "${statusA}", ${objA.length} objectives), slot 1 taxi (status "${statusB}", ${objB.length} objectives); slot 1 paid ${b.progress.money - money[1]!} for a fare, slot 0's money unchanged; slot 1's job ended, slot 0's runs on`);
  });

  it('stunt and rampage rewards go to the player who earned them', () => {
    const sim = makeSim({ ambient: false, police: false, multiplayer: true });
    const a = sim.players[0]!;
    const r = onLane(sim, 50, 20);
    const b = sim.addPlayer(r.x, r.z);
    const car = sim.spawnVehicle('sports', r.x, r.z, r.heading);
    sim.seat(b.character, car, 0);
    const log = recordEvents(sim);
    const m = [a.progress.money, b.progress.money];
    // A landed jump from ramp 0: 1.5 s in the air over 30 m.
    car.launchRamp = 0;
    car.airTime = 1.5;
    car.launchX = car.pos.x - 30;
    car.launchZ = car.pos.z;
    sim.activities.onVehicleLanded(car);
    expect(b.progress.money).toBeGreaterThan(m[1]!);
    expect(a.progress.money).toBe(m[0]);
    expect(b.progress.stunts).toEqual([0]);
    expect(a.progress.stunts).toEqual([]);
    expect(log.filter((e) => e.type === 'stunt').map((e) => e.payload.playerId)).toEqual([1]);
    // Rampage: player 1 starts it from its pickup and makes the kills.
    sim.unseat(b.character);
    const pick = sim.pickups.find((p) => p.kind === 'rampage')!;
    place(sim, b, pick.pos.x, pick.pos.z);
    stepSlots(sim, 0.1);
    expect(sim.activities.jobOf(b)?.kind).toBe('rampage');
    expect(sim.activities.jobOf(a)).toBeNull();
    const before = [a.progress.money, b.progress.money];
    for (let k = 0; k < 40 && sim.activities.jobOf(b); k++) {
      const g = sim.characters.find((c) => !c.removed && c.alive && c.missionTag === 'rampage');
      if (g) sim.combat.damageCharacter(g, 5000, b.character, 'bullet', 1, 0, 0);
      stepSlots(sim, 1.3);
    }
    expect(sim.activities.jobOf(b)).toBeNull();
    expect(b.progress.rampages).toEqual([pick.tag]);
    expect(a.progress.rampages).toEqual([]);
    expect(b.progress.money - before[1]!).toBeGreaterThanOrEqual(2000);
    expect(a.progress.money).toBe(before[0]);
    const objectives = log.filter((e) => e.type === 'objective');
    expect(objectives.length).toBeGreaterThan(0);
    expect(objectives.every((e) => e.payload.playerId === 1)).toBe(true);
    console.log(`[mpsim-007] stunt bonus ${m[1]} -> slot 1 only; rampage passed by slot 1: +${b.progress.money - before[1]!}, ${objectives.length} kill counts on his HUD, slot 0 unchanged`);
  });
});

describe('story missions, cheats and saving in multiplayer sims (VAL-MPSIM-009)', () => {
  function attempt(sim: Sim) {
    const log = recordEvents(sim);
    const slot = sim.players[sim.players.length - 1]!;
    const offers = sim.missions.offers().map((d) => d.id);
    sim.missions.refreshMarkers();
    const markers = sim.interactions.markers.filter((m) => m.kind === 'mission').length;
    const started = sim.missions.start('wheels');
    const moneyBefore = sim.players.map((s) => s.progress.money);
    const cheat = applySimCheat(sim, 'MONEYTREE', slot);
    const god = applySimCheat(sim, 'IMMORTAL', slot);
    const stars = applySimCheat(sim, 'COPMAGNET', slot);
    const moneyAfter = sim.players.map((s) => s.progress.money);
    const save = sim.interactions.markers.find((m) => m.kind === 'save')!;
    const p = slot.character;
    p.pos.x = save.x;
    p.pos.z = save.z;
    p.health = 50;
    const prompt = sim.interactions.prompt(slot);
    sim.interactions.interact(slot);
    for (let i = 0; i < 30; i++) sim.update(DT, new Map(sim.players.map((s) => [s.id, behind(s.character)])));
    return {
      offers, markers, started, cheat, god, stars, moneyBefore, moneyAfter, prompt,
      godMode: sim.players.map((s) => s.cheats.godMode),
      wanted: sim.players.map((s) => s.wanted.level),
      saves: log.filter((e) => e.type === 'saveRequested').length,
      messages: log.filter((e) => e.type === 'message').map((e) => e.payload.text as string),
      health: p.health,
      canSave: sim.interactions.canSave(slot),
    };
  }

  it('a multiplayer sim refuses each with a reason; a single-player sim does them as before', () => {
    const mp = makeSim({ ambient: false, police: true, multiplayer: true });
    mp.addPlayer(mp.player.pos.x + 5, mp.player.pos.z);
    const m = attempt(mp);
    console.log(`[mpsim-009] multiplayer: offers ${JSON.stringify(m.offers)}, mission markers ${m.markers}, start wheels ${m.started}; cheats -> ${JSON.stringify([m.cheat, m.god, m.stars])}, money ${JSON.stringify(m.moneyBefore)} -> ${JSON.stringify(m.moneyAfter)}, god ${JSON.stringify(m.godMode)}, wanted ${JSON.stringify(m.wanted)}; save prompt "${m.prompt}", saves ${m.saves}, health ${m.health}; messages ${JSON.stringify(m.messages)}`);
    expect(m.offers).toEqual([]);
    expect(m.markers).toBe(0);
    expect(m.started).toBe(false);
    expect(mp.missions.active).toBeNull();
    expect(mp.missions.refusal).toBe(MP_NO_STORY);
    expect(m.messages).toContain(MP_NO_STORY);
    expect([m.cheat, m.god, m.stars]).toEqual([MP_NO_CHEATS, MP_NO_CHEATS, MP_NO_CHEATS]);
    expect(m.moneyAfter).toEqual(m.moneyBefore);
    expect(m.godMode).toEqual([false, false]);
    expect(m.wanted).toEqual([0, 0]);
    expect(m.prompt).toBe(MP_NO_SAVE);
    expect(m.messages).toContain(MP_NO_SAVE);
    expect(m.saves).toBe(0);
    expect(m.health).toBe(50);
    expect(m.canSave).toBe(false);

    const sp = makeSim({ ambient: false, police: true });
    const s = attempt(sp);
    console.log(`[mpsim-009] single player: offers ${JSON.stringify(s.offers)}, mission markers ${s.markers}, start wheels ${s.started}; cheats -> ${JSON.stringify([s.cheat, s.god, s.stars])}, money ${JSON.stringify(s.moneyBefore)} -> ${JSON.stringify(s.moneyAfter)}, god ${JSON.stringify(s.godMode)}; saves ${s.saves}`);
    expect(s.offers.length).toBeGreaterThan(0);
    expect(s.markers).toBeGreaterThan(0);
    expect(s.started).toBe(true);
    expect(sp.missions.active?.def.id).toBe('wheels');
    expect(sp.missions.refusal).toBeNull();
    expect([s.cheat, s.god, s.stars]).toEqual([null, null, null]);
    expect(s.moneyAfter[0]).toBe(s.moneyBefore[0]! + 50000);
    expect(s.godMode).toEqual([true]);
    expect(s.wanted).toEqual([2]);
  });

  it('the single-player safehouse still saves (no mission, no stars)', () => {
    const sp = makeSim({ ambient: false, police: true });
    const log = recordEvents(sp);
    const save = sp.interactions.markers.find((m) => m.kind === 'save')!;
    sp.player.pos.x = save.x;
    sp.player.pos.z = save.z;
    sp.player.health = 50;
    expect(sp.interactions.canSave()).toBe(true);
    sp.interactions.interact();
    expect(log.filter((e) => e.type === 'saveRequested').length).toBe(1);
    expect(sp.player.health).toBe(sp.player.maxHealth);
  });
});
