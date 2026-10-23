// The multi-player sim core, part two: traffic and pedestrians stream round every player under a split budget
// (VAL-MPSIM-005), nothing streams out in view of or near any player and nothing streams in where one would see it pop
// up (VAL-MPSIM-006), 2-4 player runs through the server's latched input path are deterministic (VAL-MPSIM-008), and
// single-player traces are unchanged (VAL-MPSIM-010, with sp_trace.test.ts).

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room } from '../../server/room';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { PlayerSlot } from '../../src/sim/playerSlot';
import type { Sim } from '../../src/sim/sim';
import { CLUSTER_RADIUS, clusterTarget, mpBudget, playerClusters } from '../../src/sim/traffic';
import { recordSpTrace } from '../support/spTrace';
import { input, makeSim } from './helpers';
import { behind, DT, place, serialise, stateHash } from './mp_helpers';
import { FakePeer } from './net_helpers';

const isTraffic = (v: Vehicle) => !v.removed && v.owner === 'traffic' && !!v.driver && !v.driver.isPlayer && !v.destroyed;
const isPed = (c: Character) => !c.removed && c.owner === 'ped' && c.alive && !c.persistent;

/** A walk round a block of the road grid from node (i, j): its four corners, offset onto the sidewalk side. */
function blockLoop(sim: Sim, i: number, j: number): Array<{ x: number; z: number }> {
  const n = (a: number, b: number) => sim.roads.node(a, b);
  return [n(i, j), n(i + 1, j), n(i + 1, j + 1), n(i, j + 1)].map((p) => ({ x: p.x + 9, z: p.z + 9 }));
}

/** Moves slot `s` along `route` at `speed` m/s (kinematically: he walks or drives through anything). */
function follower(route: Array<{ x: number; z: number }>, speed: number) {
  let k = 0;
  return (sim: Sim, s: PlayerSlot): number => {
    const c = s.character;
    const o = c.vehicle ?? c;
    const t = route[k % route.length]!;
    const dx = t.x - o.pos.x;
    const dz = t.z - o.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 3) k++;
    const step = Math.min(d, speed * DT);
    const heading = Math.atan2(dx, dz);
    place(sim, s, o.pos.x + (dx / (d || 1)) * step, o.pos.z + (dz / (d || 1)) * step);
    o.vel.x = (dx / (d || 1)) * speed;
    o.vel.z = (dz / (d || 1)) * speed;
    if (c.vehicle) c.vehicle.heading = heading;
    else c.heading = heading;
    return heading;
  };
}

describe('traffic and pedestrians round every player (VAL-MPSIM-005)', () => {
  it('two players 600 m apart each keep cars and people round them; the totals stay within the split budget', () => {
    const sim = makeSim({ ambient: true, police: true, multiplayer: true, seed: 12, startHour: 13 });
    const a = sim.players[0]!;
    const n0 = sim.roads.node(4, 4);
    const n1 = sim.roads.node(10, 7);
    place(sim, a, n0.x + 9, n0.z + 9);
    const b = sim.addPlayer(n1.x + 9, n1.z + 9);
    place(sim, b, n1.x + 9, n1.z + 9);
    const gap = Math.hypot(a.pos().x - b.pos().x, a.pos().z - b.pos().z);
    expect(gap).toBeGreaterThan(550);
    // Player 1's drive across the city after 120 s: west along the road grid to the far side.
    const across = [sim.roads.node(10, 7), sim.roads.node(6, 7), sim.roads.node(6, 2), sim.roads.node(1, 2)].map((p) => ({ x: p.x, z: p.z }));
    const drive = follower(across, 16);
    let car: Vehicle | null = null;
    const per: Array<{ cars: number[]; peds: number[]; emptyCars: number; emptyPeds: number; worstEmptyCars: number; worstEmptyPeds: number }> = [a, b].map(() => ({ cars: [], peds: [], emptyCars: 0, emptyPeds: 0, worstEmptyCars: 0, worstEmptyPeds: 0 }));
    let maxTraffic = 0;
    let maxPeds = 0;
    let capTraffic = 0;
    let capPeds = 0;
    let over = 0;
    const T = 180;
    let yaw = 0;
    for (let t = 0; t < T; t++) {
      if (t === 120) {
        car = sim.spawnVehicle('sports', b.pos().x, b.pos().z, 0);
        sim.seat(b.character, car, 0);
      }
      for (let f = 0; f < 60; f++) {
        yaw += 0.01;
        const hb = t >= 120 ? drive(sim, b) : yaw * 1.3;
        sim.update(DT, new Map<number, PlayerInput>([[0, behind(a.character, {}, yaw)], [1, behind(b.character, {}, hb)]]));
      }
      const cars = sim.vehicles.filter(isTraffic);
      const peds = sim.characters.filter(isPed);
      // The documented caps for two players: the single-player targets times mpBudget(2) (whatever the grouping).
      const tCap = Math.round(sim.traffic.targetCount * mpBudget(2));
      const pCap = Math.round(sim.peds.targetCount * mpBudget(2));
      capTraffic = Math.max(capTraffic, tCap);
      capPeds = Math.max(capPeds, pCap);
      maxTraffic = Math.max(maxTraffic, cars.length);
      maxPeds = Math.max(maxPeds, peds.length);
      if (cars.length > tCap || peds.length > pCap) over++;
      if (t < 30) continue;
      [a, b].forEach((s, i) => {
        const p = s.pos();
        const nc = cars.filter((v) => Math.hypot(v.pos.x - p.x, v.pos.z - p.z) < 150).length;
        const np = peds.filter((c) => Math.hypot(c.pos.x - p.x, c.pos.z - p.z) < 150).length;
        const r = per[i]!;
        r.cars.push(nc);
        r.peds.push(np);
        r.emptyCars = nc === 0 ? r.emptyCars + 1 : 0;
        r.emptyPeds = np === 0 ? r.emptyPeds + 1 : 0;
        r.worstEmptyCars = Math.max(r.worstEmptyCars, r.emptyCars);
        r.worstEmptyPeds = Math.max(r.worstEmptyPeds, r.emptyPeds);
      });
    }
    const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
    const groups = playerClusters(sim.activePlayers()).length;
    per.forEach((r, i) => {
      const parked = r.cars.slice(0, 90);
      const moving = r.cars.slice(90);
      console.log(`[mpsim-005] slot ${i} (${sim.world.zoneName(...(i === 0 ? [a.pos().x, a.pos().z] : [n1.x, n1.z]) as [number, number])}): cars within 150 m mean ${mean(r.cars).toFixed(1)} (standing ${mean(parked).toFixed(1)}, ${i === 1 ? 'driving' : 'meanwhile'} ${mean(moving).toFixed(1)}), min ${Math.min(...r.cars)}; pedestrians mean ${mean(r.peds).toFixed(1)} (${mean(r.peds.slice(0, 90)).toFixed(1)} / ${mean(r.peds.slice(90)).toFixed(1)}), min ${Math.min(...r.peds)}; longest empty: cars ${r.worstEmptyCars} s, peds ${r.worstEmptyPeds} s`);
      expect(mean(r.cars)).toBeGreaterThanOrEqual(6);
      expect(mean(r.peds)).toBeGreaterThanOrEqual(6);
      expect(r.worstEmptyCars).toBeLessThanOrEqual(5);
      expect(r.worstEmptyPeds).toBeLessThanOrEqual(5);
    });
    console.log(`[mpsim-005] players ${gap.toFixed(0)} m apart (group radius ${CLUSTER_RADIUS} m, ${groups} group(s) at the end); totals at most ${maxTraffic} traffic cars (cap ${capTraffic} = target x ${mpBudget(2)}, ${clusterTarget(sim.traffic.targetCount, 2)} per group) and ${maxPeds} pedestrians (cap ${capPeds}); seconds over a cap: ${over}`);
    expect(over).toBe(0);
    expect(maxTraffic).toBeLessThanOrEqual(capTraffic);
    expect(maxPeds).toBeLessThanOrEqual(capPeds);
  }, 60_000);
});

describe('nothing streams out in sight of any player (VAL-MPSIM-006)', () => {
  /** Smallest distance (m) from every player at which each kind may stream out (traffic.ts, peds.ts streaming rules). */
  function despawnFloor(e: Vehicle | Character): number {
    if ('spec' in e) {
      if (e.destroyed || e.inWater) return 60;
      if (e.owner === 'parked') return 235;
      // Traffic in view of nobody: 120 m behind a fast player, 90 m for the room a gang car takes (gangs.ts makeRoom).
      if (e.driver) return 90;
      return 40;
    }
    return e.alive ? 110 : 40;
  }

  for (const n of [2, 3, 4]) {
    it(`${n} players on the move for 180 s`, () => {
      const sim = makeSim({ ambient: true, police: true, multiplayer: true, streetCrime: true, seed: 30 + n, startHour: 18 });
      const routes = [blockLoop(sim, 4, 4), blockLoop(sim, 2, 6), blockLoop(sim, 7, 3), blockLoop(sim, 6, 7)];
      const speeds = [5, 14, 7, 18];
      const slots: PlayerSlot[] = [sim.players[0]!];
      for (let i = 1; i < n; i++) slots.push(sim.addPlayer(routes[i]![0]!.x, routes[i]![0]!.z));
      slots.forEach((s, i) => place(sim, s, routes[i]![0]!.x, routes[i]![0]!.z));
      // Two of them drive.
      for (const i of [1, 3]) {
        const s = slots[i];
        if (!s) continue;
        const car = sim.spawnVehicle('sedan', s.pos().x, s.pos().z, 0);
        sim.seat(s.character, car, 0);
      }
      const movers = slots.map((_, i) => follower(routes[i]!, speeds[i]!));
      let streaming = false;
      let removals = 0;
      let spawns = 0;
      const bad: string[] = [];
      const near = (x: number, z: number) => Math.min(...slots.map((s) => Math.hypot(x - s.pos().x, z - s.pos().z)));
      const removeV = sim.removeVehicle.bind(sim);
      const removeC = sim.removeCharacter.bind(sim);
      const spawnV = sim.spawnVehicle.bind(sim);
      const spawnC = sim.spawnCharacter.bind(sim);
      let inRemoval = 0;
      const check = (e: Vehicle | Character) => {
        removals++;
        const d = near(e.pos.x, e.pos.z);
        const seen = sim.isVisible(e.pos.x, e.pos.y, e.pos.z);
        if (seen || d < despawnFloor(e)) bad.push(`removed ${'spec' in e ? e.kind : e.role} ${e.id} at ${d.toFixed(0)} m${seen ? ', in view' : ''}`);
      };
      sim.removeVehicle = (v: Vehicle) => {
        if (streaming && !v.removed) check(v);
        inRemoval++;
        try {
          removeV(v);
        } finally {
          inRemoval--;
        }
      };
      sim.removeCharacter = (c: Character) => {
        // Occupants go with their vehicle (checked as that).
        if (streaming && !c.removed && !sim.slotOf(c) && inRemoval === 0) check(c);
        removeC(c);
      };
      sim.spawnVehicle = (kind, x, z, heading, color) => {
        if (streaming) {
          spawns++;
          const d = near(x, z);
          if (sim.isVisible(x, 1, z) || d < 35) bad.push(`spawned ${kind} at ${d.toFixed(0)} m${sim.isVisible(x, 1, z) ? ', in view' : ''}`);
        }
        return spawnV(kind, x, z, heading, color);
      };
      sim.spawnCharacter = (role, x, z, look) => {
        const c = spawnC(role, x, z, look);
        if (streaming && role !== 'player') {
          spawns++;
          const d = near(x, z);
          // Drivers spawn in their cars (checked as those); people on foot from 22 m, in view only from 55 m.
          if (d < 22 || (d < 55 && sim.isVisible(x, 1, z))) bad.push(`spawned ${role} at ${d.toFixed(1)} m${sim.isVisible(x, 1, z) ? ', in view' : ''}`);
        }
        return c;
      };
      for (const [obj, name] of [[sim.traffic, 'updateStreaming'], [sim.peds, 'updateStreaming']] as const) {
        const fn = (obj as unknown as Record<string, (dt: number) => void>)[name]!.bind(obj);
        (obj as unknown as Record<string, (dt: number) => void>)[name] = (dt: number) => {
          streaming = true;
          try {
            fn(dt);
          } finally {
            streaming = false;
          }
        };
      }
      const gangsUpdate = sim.gangs.update.bind(sim.gangs);
      sim.gangs.update = (s, dt) => {
        streaming = true;
        try {
          gangsUpdate(s, dt);
        } finally {
          streaming = false;
        }
      };
      let yaw = 0;
      for (let f = 0; f < 180 * 60; f++) {
        yaw += 0.008;
        const inputs = new Map<number, PlayerInput>();
        slots.forEach((s, i) => {
          const h = movers[i]!(sim, s);
          // Cameras look round: ahead, then sweeping to the sides and back.
          inputs.set(s.id, behind(s.character, {}, h + Math.sin(yaw * (1 + i * 0.3)) * 1.4));
        });
        sim.update(DT, inputs);
      }
      const groups = playerClusters(sim.activePlayers()).length;
      console.log(`[mpsim-006] ${n} players: ${removals} streaming removals and ${spawns} streaming spawns checked, ${bad.length} violations${bad.length ? `: ${bad.slice(0, 6).join('; ')}` : ''}; ${groups} player group(s) at the end, ${sim.vehicles.filter(isTraffic).length} traffic cars, ${sim.characters.filter(isPed).length} pedestrians`);
      expect(removals).toBeGreaterThan(20);
      expect(spawns).toBeGreaterThan(50);
      expect(bad).toEqual([]);
    }, 90_000);
  }
});

describe('same seed, same inputs: same game with 2-4 players (VAL-MPSIM-008)', () => {
  /** Each player's script: 0 drives round blocks, 1 shoots and commits crimes, 2 gets in and out of a car, 3 dies and respawns. */
  function script(room: Room, slot: PlayerSlot, i: number, tick: number): PlayerInput {
    const sim = room.sim;
    const c = slot.character;
    const t = tick / 60;
    const inp = input({ cameraYaw: c.heading });
    switch (i % 4) {
      case 0:
        if (c.vehicle) {
          inp.throttle = t % 8 < 6 ? 1 : 0;
          inp.brake = t % 8 >= 6 ? 1 : 0;
          inp.steer = Math.sin(t / 3) * 0.6;
          inp.handbrake = t % 8 > 7.5;
        } else inp.moveZ = 1;
        break;
      case 1: {
        inp.moveZ = t % 6 < 3 ? 1 : 0;
        inp.cameraYaw = t / 2;
        inp.aim = true;
        inp.fire = tick % 40 < 4;
        inp.firePressed = tick % 40 === 0;
        break;
      }
      case 2:
        inp.enterExit = tick % 240 === 30 || tick % 240 === 150;
        inp.moveZ = tick % 240 > 160 ? 1 : 0;
        inp.cameraYaw = t / 5;
        break;
      case 3:
        inp.moveZ = 1;
        inp.sprint = true;
        inp.cameraYaw = Math.sin(t / 4) * 2;
        inp.jump = tick % 90 === 0;
        if (tick % 1200 === 600 && c.alive) sim.combat.damageCharacter(c, 5000, null, 'fall', 0, -1, 0);
        break;
    }
    return inp;
  }

  function run(players: number, seed: number): { hash: string; log: string; events: number; deaths: number; wanted: number[]; peakWanted: number } {
    const room = new Room(`det${players}`, seed, { realtime: false, log: () => {}, dev: true });
    const sim = room.sim;
    const lines: string[] = [];
    const emit = sim.events.emit.bind(sim.events) as (t: string, p: unknown) => void;
    (sim.events as unknown as { emit: (t: string, p: unknown) => void }).emit = (type, payload) => {
      lines.push(`${room.tick} ${serialise(type, payload)}`);
      emit(type, payload);
    };
    const members = Array.from({ length: players }, (_, i) => {
      const m = room.join(i + 1, `P${i}`, new FakePeer());
      if (m === 'full') throw new Error('full');
      return m;
    });
    const slotOf = (i: number) => sim.players.find((s) => s.id === members[i]!.slot)!;
    // Player 0 drives, player 1 is armed, player 2 has a car beside him.
    room.command(members[0]!, 'debug', JSON.stringify({ drive: 'sedan' }));
    if (players > 1) room.command(members[1]!, 'debug', JSON.stringify({ give: ['pistol', 400] }));
    if (players > 2) {
      const p = slotOf(2).character;
      sim.spawnVehicle('sedan', p.pos.x + Math.cos(p.heading) * 2.4, p.pos.z - Math.sin(p.heading) * 2.4, p.heading);
    }
    let seq = 0;
    let deaths = 0;
    let peakWanted = 0;
    sim.events.on('wasted', () => deaths++);
    for (let tick = 0; tick < 60 * 60; tick++) {
      seq++;
      members.forEach((m, i) => {
        const slot = slotOf(i);
        // Through the server's latch (InputLatch), as a client's inputs come in.
        room.input(m, seq, script(room, slot, i, tick), room.tick);
      });
      room.step();
      for (const s of sim.players) peakWanted = Math.max(peakWanted, s.wanted.level);
    }
    const log = lines.join('\n');
    const out = { hash: stateHash(sim), log: createHash('sha256').update(log).digest('hex'), events: lines.length, deaths, wanted: sim.players.map((s) => s.wanted.level), peakWanted };
    room.close();
    return out;
  }

  for (const n of [2, 3, 4]) {
    it(`${n} players: two runs with one seed match, another seed does not`, () => {
      const a = run(n, 77);
      const b = run(n, 77);
      const c = run(n, 78);
      console.log(`[mpsim-008] ${n} players, seed 77: state ${a.hash.slice(0, 16)} / ${b.hash.slice(0, 16)}, event log ${a.log.slice(0, 16)} / ${b.log.slice(0, 16)} (${a.events} events, ${a.deaths} deaths, wanted ${JSON.stringify(a.wanted)}); seed 78: state ${c.hash.slice(0, 16)}, log ${c.log.slice(0, 16)}`);
      expect(a.events).toBeGreaterThan(200);
      expect(b.hash).toBe(a.hash);
      expect(b.log).toBe(a.log);
      expect(c.hash).not.toBe(a.hash);
      expect(c.log).not.toBe(a.log);
      if (n >= 4) expect(a.deaths).toBeGreaterThan(0);
      // A bust or a death ends a pursuit, so the levels at the end of the run may all be 0.
      expect(a.peakWanted).toBeGreaterThan(0);
    }, 120_000);
  }
});

describe('single player is unchanged by the multiplayer core (VAL-MPSIM-010)', () => {
  it('the single-player trace with the wave-1 street systems on matches its a971b0e recording', () => {
    // sp_trace.test.ts holds the plain trace byte for byte against tests/unit/fixtures/sp_trace_72d0b98.json. This is
    // the same script with sim.streetCrime on (as the real game runs), its hash recorded at a971b0e, before mp-core.
    const now = `${JSON.stringify(recordSpTrace({ streetCrime: true }))}\n`;
    const hash = createHash('sha256').update(now).digest('hex');
    console.log(`[mpsim-010] streetCrime trace sha256 ${hash}`);
    expect(hash).toBe('dd0956bf6ac5c7d1f89a8a40a3ccdd0dc8cc20473ce5fa3603723779a1387e07');
  }, 120_000);
});
