// Chapter 2 missions, each driven through by a headless bot, and each of their fail conditions.

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import { chapter2Spots } from '../../src/sim/missions/spots';
import {
  HOTEL_FALLS, HOTEL_RADIUS, LAST_CALL_STARS, RAM_DISABLED, RAM_ESCAPE_DIST, RAM_TARGETS, SHOWROOM_CONDITION, TAIL_LOST_DIST, TAIL_SPOT_DIST, VERA_MISSIONS, WAVES,
} from '../../src/sim/missions/vera';
import type { Sim } from '../../src/sim/sim';
import { input, step, teleport } from './helpers';
import { active, enterVehicle, gunner, objectiveIs, parkAt, startAtMarker, stepUntil, storySim } from './story2_helpers';

const reward = (id: string) => VERA_MISSIONS.find((d) => d.id === id)!.reward;

/** Big cards shown (text: sub), from now on. */
function cards(sim: Sim): string[] {
  const out: string[] = [];
  sim.events.on('big', (e) => out.push(`${e.text}: ${e.sub}`));
  return out;
}

function failedWith(sim: Sim, shown: string[], reason: RegExp, id: string): void {
  expect(sim.missions.active).toBeNull();
  expect(sim.progress.missionsDone).not.toContain(id);
  const failed = shown.find((c) => c.startsWith('MISSION FAILED'));
  expect(failed, shown.join(' | ')).toMatch(reason);
}

/** Passed, paid `amount` exactly once, marked done once, autosaved, and the next one offered. */
function expectPassed(sim: Sim, id: string, money0: number, amount: number, saves: () => number): void {
  stepUntil(sim, () => sim.missions.active === null, 30);
  expect(sim.progress.missionsDone.filter((m) => m === id)).toEqual([id]);
  expect(sim.progress.money).toBe(money0 + amount);
  expect(saves()).toBeGreaterThanOrEqual(1);
  // Re-entering the marker area pays nothing more.
  const poi = chapter2Spots(sim.world).vera;
  if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
  teleport(sim, poi.x, poi.z);
  step(sim, 0.5);
  sim.update(1 / 60, input({ interact: true }));
  step(sim, 0.5);
  if (sim.missions.active) sim.missions.abandon();
  step(sim, 0.2);
  expect(sim.progress.money).toBe(money0 + amount);
  expect(sim.progress.missionsDone.filter((m) => m === id)).toEqual([id]);
}

function autosaves(sim: Sim): () => number {
  let n = 0;
  sim.events.on('saveRequested', (e) => {
    if (e.poi === 'auto') n++;
  });
  return () => n;
}

/** Shadow Play's bot: keeps the player's car on the courier's own path, `gap` m behind him. */
function tailBot(sim: Sim, courier: Vehicle, gap = 35): () => void {
  const trail: Array<{ x: number; z: number; h: number }> = [];
  const fx = Math.sin(courier.heading);
  const fz = Math.cos(courier.heading);
  for (let k = 0; k <= gap; k++) trail.push({ x: courier.pos.x - fx * (gap - k), z: courier.pos.z - fz * (gap - k), h: courier.heading });
  parkAt(sim, trail[0]!.x, trail[0]!.z, courier.heading);
  return () => {
    const last = trail[trail.length - 1]!;
    if (Math.hypot(last.x - courier.pos.x, last.z - courier.pos.z) > 0.5) trail.push({ x: courier.pos.x, z: courier.pos.z, h: courier.heading });
    let acc = 0;
    for (let i = trail.length - 1; i > 0; i--) {
      acc += Math.hypot(trail[i]!.x - trail[i - 1]!.x, trail[i]!.z - trail[i - 1]!.z);
      if (acc >= gap) {
        const p = trail[i - 1]!;
        parkAt(sim, p.x, p.z, p.h);
        return;
      }
    }
  };
}

function startTail(sim: Sim): { courier: Vehicle; car: Vehicle } {
  startAtMarker(sim, 'shadow_play');
  stepUntil(sim, objectiveIs(sim, 'Tail the courier: take the Pipsqueak first'), 30);
  const m = active(sim);
  const car = m.vehicles[0]!;
  const courier = m.vehicles[1]!;
  // The courier is marked on the radar from the first objective.
  expect(m.markers.some((o) => o.vehicle === courier && o.label === 'Courier')).toBe(true);
  enterVehicle(sim, car);
  stepUntil(sim, objectiveIs(sim, /^Tail the courier \(stay/), 2);
  return { courier, car };
}

describe('1. Shadow Play (tail)', () => {
  it('a bot that keeps 35 m behind the courier passes it', () => {
    const sim = storySim('shadow_play');
    const money = sim.progress.money;
    const saves = autosaves(sim);
    const { courier } = startTail(sim);
    const bot = tailBot(sim, courier);
    let minD = Infinity;
    let maxD = 0;
    let checkpoint = -1;
    const t = stepUntil(sim, () => sim.missions.active?.won === true, 300, () => {
      bot();
      const p = sim.playerPos();
      const dd = Math.hypot(p.x - courier.pos.x, p.z - courier.pos.z);
      minD = Math.min(minD, dd);
      maxD = Math.max(maxD, dd);
      if (checkpoint < 0 && sim.missions.active?.checkpointReached === 1) checkpoint = sim.time;
    });
    console.log(`Shadow Play passed after ${t.toFixed(1)} s, distance ${minD.toFixed(1)}-${maxD.toFixed(1)} m, checkpoint at ${checkpoint.toFixed(1)} s`);
    expect(minD).toBeGreaterThan(TAIL_SPOT_DIST);
    expect(maxD).toBeLessThan(TAIL_LOST_DIST);
    expect(checkpoint).toBeGreaterThan(0);
    expectPassed(sim, 'shadow_play', money, reward('shadow_play'), saves);
  });

  it('fails as spotted when the player stays too close', () => {
    const sim = storySim('shadow_play');
    const shown = cards(sim);
    const { courier } = startTail(sim);
    stepUntil(sim, () => sim.missions.active === null, 20, () => {
      const fx = Math.sin(courier.heading);
      const fz = Math.cos(courier.heading);
      parkAt(sim, courier.pos.x - fx * 8, courier.pos.z - fz * 8, courier.heading);
    });
    failedWith(sim, shown, /spotted/, 'shadow_play');
    console.log('spotted case:', shown.filter((c) => c.startsWith('MISSION FAILED')));
  });

  it('fails as lost when the player falls too far behind', () => {
    const sim = storySim('shadow_play');
    const shown = cards(sim);
    startTail(sim);
    // The player stays put at the hotel while the courier drives off.
    stepUntil(sim, () => sim.missions.active === null, 120);
    failedWith(sim, shown, /lost/, 'shadow_play');
    console.log('lost case:', shown.filter((c) => c.startsWith('MISSION FAILED')));
  });
});

function defendBot(sim: Sim): () => ReturnType<typeof input> {
  return gunner(sim, () => (sim.missions.active?.characters ?? []).filter((c) => c.role === 'gang'));
}

describe('2. Room Service (defend)', () => {
  it('a bot holding the entrance beats every wave, the counter advancing', () => {
    const sim = storySim('room_service');
    const money = sim.progress.money;
    const saves = autosaves(sim);
    startAtMarker(sim, 'room_service');
    stepUntil(sim, objectiveIs(sim, `Defend the hotel entrance (wave 1/${WAVES.length})`), 30);
    const m = active(sim);
    const bot = defendBot(sim);
    const log: string[] = [];
    let counter = '';
    const waves = new Set<string>();
    stepUntil(sim, () => m.won, 300, () => {
      if (m.counter && m.counter !== counter) {
        counter = m.counter;
        log.push(`${m.time.toFixed(1)} s ${counter}`);
        const w = /^WAVE (\d)\/\d - (\d) LEFT/.exec(counter);
        if (w) waves.add(w[1]!);
        // Every attacker of the wave is hostile and on his way in.
        if (w && Number(w[2]) === WAVES[Number(w[1]) - 1]) expect(m.characters.filter((c) => c.alive && c.role === 'gang' && !c.removed).length).toBe(WAVES[Number(w[1]) - 1]);
      }
      return bot();
    });
    console.log(`Room Service waves:\n${log.join('\n')}`);
    expect([...waves]).toEqual(['1', '2', '3']);
    expectPassed(sim, 'room_service', money, reward('room_service'), saves);
  });

  it('attackers march on the entrance, and the hotel falls when the player leaves it to them', () => {
    const sim = storySim('room_service');
    const shown = cards(sim);
    const hotel = chapter2Spots(sim.world).vera;
    startAtMarker(sim, 'room_service');
    stepUntil(sim, objectiveIs(sim, /^Defend the hotel entrance/), 30);
    const m = active(sim);
    const d0 = Math.min(...m.characters.map((c) => Math.hypot(c.pos.x - hotel.x, c.pos.z - hotel.z)));
    // The player walks away down the street.
    const away = sim.roads.node(9, 9);
    teleport(sim, away.x + 8, away.z + 8);
    let closest = d0;
    stepUntil(sim, () => sim.missions.active === null, 120, () => {
      closest = Math.min(closest, ...m.characters.filter((c) => c.alive).map((c) => Math.hypot(c.pos.x - hotel.x, c.pos.z - hotel.z)));
    });
    console.log(`attackers from ${d0.toFixed(1)} m to ${closest.toFixed(1)} m of the door; ${shown.filter((c) => c.startsWith('MISSION FAILED'))}`);
    expect(closest).toBeLessThan(HOTEL_RADIUS);
    expect(m.time).toBeGreaterThan(HOTEL_FALLS);
    failedWith(sim, shown, /took the hotel/, 'room_service');
  });

  it('fails as WASTED when the player dies', () => {
    const sim = storySim('room_service', { god: false });
    const shown = cards(sim);
    startAtMarker(sim, 'room_service');
    stepUntil(sim, objectiveIs(sim, /^Defend the hotel entrance/), 30);
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 0.3);
    failedWith(sim, shown, /wasted/, 'room_service');
  });
});

function startShowroom(sim: Sim): Vehicle {
  startAtMarker(sim, 'showroom');
  stepUntil(sim, objectiveIs(sim, 'Steal the yellow Nightjar GT'), 30);
  const m = active(sim);
  const car = m.vehicles[0]!;
  expect(car.kind).toBe('sports');
  expect(car.color).toBe(0xf1c40f);
  expect(m.markers.some((o) => o.vehicle === car && o.label === 'Yellow Nightjar GT')).toBe(true);
  enterVehicle(sim, car);
  stepUntil(sim, objectiveIs(sim, /^Deliver the yellow Nightjar GT to Hotel Salgado \(below 70% the buyer pays half\)/), 3);
  step(sim, 0.1);
  expect(m.counter).toMatch(/^NIGHTJAR CONDITION \d+%$/);
  return car;
}

describe('3. Showroom Condition (steal and deliver)', () => {
  const deliver = (sim: Sim) => {
    const s = chapter2Spots(sim.world);
    parkAt(sim, s.curb.x, s.curb.z, s.curb.heading);
  };

  it('delivered in good condition, it pays in full', () => {
    const sim = storySim('showroom');
    const money = sim.progress.money;
    const saves = autosaves(sim);
    const car = startShowroom(sim);
    // Scraped on the way, still above the line.
    car.health = car.spec.health * 0.85;
    step(sim, 0.1);
    expect(active(sim).counter).toBe('NIGHTJAR CONDITION 85%');
    deliver(sim);
    console.log(`full: condition ${car.condition.toFixed(2)} at delivery`);
    expectPassed(sim, 'showroom', money, reward('showroom'), saves);
  });

  it('delivered below the line, the buyer pays half', () => {
    const sim = storySim('showroom');
    const money = sim.progress.money;
    const saves = autosaves(sim);
    const car = startShowroom(sim);
    car.health = car.spec.health * (SHOWROOM_CONDITION - 0.15);
    deliver(sim);
    console.log(`half: condition ${car.condition.toFixed(2)} at delivery`);
    expectPassed(sim, 'showroom', money, Math.round(reward('showroom') / 2), saves);
  });

  it('destroyed, it fails', () => {
    const sim = storySim('showroom');
    const shown = cards(sim);
    const car = startShowroom(sim);
    sim.combat.explodeVehicle(car);
    step(sim, 0.5);
    failedWith(sim, shown, /destroyed/, 'showroom');
  });
});

/** Off the Road's bot: every `every` frames, the truck hits the target from behind at 12 m/s over its speed. */
function ramBot(sim: Sim, target: () => Vehicle, every = 40): () => void {
  let f = 0;
  return () => {
    if (++f % every !== 0) return;
    const t = target();
    const truck = sim.player.vehicle!;
    const fx = Math.sin(t.heading);
    const fz = Math.cos(t.heading);
    const back = t.halfL + truck.halfL + 1.5;
    parkAt(sim, t.pos.x - fx * back, t.pos.z - fz * back, t.heading);
    truck.vel.x = t.vel.x + fx * 12;
    truck.vel.z = t.vel.z + fz * 12;
  };
}

function startRam(sim: Sim): void {
  startAtMarker(sim, 'off_the_road');
  stepUntil(sim, objectiveIs(sim, 'Get in the Dustrunner'), 30);
  const m = active(sim);
  expect(m.vehicles[0]!.kind).toBe('pickup');
  enterVehicle(sim, m.vehicles[0]!);
  stepUntil(sim, objectiveIs(sim, `Ram the Tiburones car off the road (1/${RAM_TARGETS})`), 3);
}

describe('4. Off the Road (chase and ram)', () => {
  it('a ramming bot puts both cars off the road; they flee, and take damage from every hit', () => {
    const sim = storySim('off_the_road');
    const money = sim.progress.money;
    const saves = autosaves(sim);
    startRam(sim);
    const m = active(sim);
    for (let i = 0; i < RAM_TARGETS; i++) {
      stepUntil(sim, objectiveIs(sim, `Ram the Tiburones car off the road (${i + 1}/${RAM_TARGETS})`), 5);
      const target = m.vehicles[m.vehicles.length - 1]!;
      expect(m.markers.some((o) => o.vehicle === target)).toBe(true);
      const health: number[] = [];
      let fled = false;
      const bot = ramBot(sim, () => target);
      let f = 0;
      stepUntil(sim, () => !m.markers.some((o) => o.vehicle === target), 120, () => {
        bot();
        fled ||= target.ai?.policy === 'flee';
        if (++f % 40 === 0) health.push(Math.round(target.condition * 100));
      });
      console.log(`target ${i + 1} condition over time: ${health.join(' ')}%`);
      expect(fled).toBe(true);
      expect(target.condition).toBeLessThanOrEqual(RAM_DISABLED);
      expect(health.some((h, k) => k > 0 && h < health[k - 1]!)).toBe(true);
    }
    expectPassed(sim, 'off_the_road', money, reward('off_the_road'), saves);
  });

  it('fails as escaped when the target gets too far away', () => {
    const sim = storySim('off_the_road');
    const shown = cards(sim);
    startRam(sim);
    const m = active(sim);
    const target = m.vehicles[m.vehicles.length - 1]!;
    const fx = target.pos.x - sim.playerPos().x;
    const fz = target.pos.z - sim.playerPos().z;
    const l = Math.hypot(fx, fz);
    const away = sim.world.findFreeSpot(target.pos.x - (fx / l) * (RAM_ESCAPE_DIST + 60), target.pos.z - (fz / l) * (RAM_ESCAPE_DIST + 60), 2, 30)!;
    parkAt(sim, away.x, away.z);
    stepUntil(sim, () => sim.missions.active === null, 30);
    failedWith(sim, shown, /escaped/, 'off_the_road');
  });
});

describe('5. Rush Hour (timed pickups)', () => {
  function startRush(sim: Sim): void {
    startAtMarker(sim, 'rush_hour');
    stepUntil(sim, objectiveIs(sim, 'Get in the Thunderhoof'), 30);
    enterVehicle(sim, active(sim).vehicles[0]!);
    stepUntil(sim, objectiveIs(sim, 'Collect the envelope (stop 1/4)'), 3);
  }

  it('a bot visiting every stop in order inside the time passes it', () => {
    const sim = storySim('rush_hour');
    const money = sim.progress.money;
    const saves = autosaves(sim);
    startRush(sim);
    const m = active(sim);
    expect(m.timer?.label).toBe('RUSH HOUR');
    const s = chapter2Spots(sim.world);
    const stops = [...s.pickupStops, s.curb];
    const log: string[] = [`start: ${(m.timer!.endsAt - sim.time).toFixed(1)} s on the clock`];
    for (let i = 0; i < stops.length; i++) {
      // The stop on the GPS is the current one only.
      expect(m.markers.filter((o) => o.radius === 5).map((o) => [o.x, o.z])).toEqual([[stops[i]!.x, stops[i]!.z]]);
      // A drive of about 25 s between stops.
      step(sim, 25);
      parkAt(sim, stops[i]!.x, stops[i]!.z, stops[i]!.heading);
      step(sim, 0.2);
      log.push(`stop ${i + 1}/4: ${m.timer ? (m.timer.endsAt - sim.time).toFixed(1) : 'done'} s left, objective "${m.objectiveText}"`);
    }
    console.log(`Rush Hour:\n${log.join('\n')}`);
    expectPassed(sim, 'rush_hour', money, reward('rush_hour'), saves);
  });

  it('does not count a later stop visited early', () => {
    const sim = storySim('rush_hour');
    startRush(sim);
    const s = chapter2Spots(sim.world);
    for (const later of [s.pickupStops[1]!, s.pickupStops[2]!, s.curb]) {
      parkAt(sim, later.x, later.z, later.heading);
      step(sim, 1);
      expect(active(sim).objectiveText).toBe('Collect the envelope (stop 1/4)');
    }
  });

  it('fails when the clock runs out', () => {
    const sim = storySim('rush_hour');
    const shown = cards(sim);
    startRush(sim);
    const t = active(sim).timer!.endsAt - sim.time;
    stepUntil(sim, () => sim.missions.active === null, t + 5);
    failedWith(sim, shown, /Out of time/, 'rush_hour');
  });
});

describe('6. Last Call (finale)', () => {
  function toTheBox(sim: Sim): void {
    startAtMarker(sim, 'last_call');
    stepUntil(sim, objectiveIs(sim, 'Steal the evidence box from the SAPD impound lot'), 30);
    const ev = chapter2Spots(sim.world).evidence;
    teleport(sim, ev.x, ev.z);
    stepUntil(sim, objectiveIs(sim, 'Get to a car'), 3);
  }

  it('the job brings 3 stars, held, and the getaway is losing them', () => {
    const sim = storySim('last_call');
    const money = sim.progress.money;
    const saves = autosaves(sim);
    sim.missions.noBust = true;
    const timeline: string[] = [];
    let level = -1;
    sim.events.on('wanted', () => {
      if (sim.wanted.level !== level) timeline.push(`${active(sim).time.toFixed(1)} s: ${(level = sim.wanted.level)}★ (${sim.missions.active?.objectiveText})`);
    });
    toTheBox(sim);
    expect(sim.wanted.level).toBeGreaterThanOrEqual(LAST_CALL_STARS);
    // CHILLOUT (wanted.clear) cannot drop it while the job holds it.
    sim.wanted.clear();
    expect(sim.wanted.level).toBeGreaterThanOrEqual(LAST_CALL_STARS);
    const ev = chapter2Spots(sim.world).evidence;
    const lane = sim.roads.nearestLane(ev.x, ev.z).lane;
    const car = sim.spawnVehicle('sports', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
    enterVehicle(sim, car);
    stepUntil(sim, objectiveIs(sim, 'Lose the cops'), 3);
    expect(sim.missions.active!.won).toBe(false);
    sim.police.dismissAll();
    step(sim, 15);
    expect(sim.missions.active?.won).toBe(false);
    const far = sim.roads.node(9, 9);
    teleport(sim, far.x + 12, far.z + 12);
    stepUntil(sim, () => sim.wanted.level === 0, 150);
    console.log(`Last Call wanted timeline:\n${timeline.join('\n')}`);
    expect(timeline.some((l) => /: [345]★/.test(l))).toBe(true);
    expectPassed(sim, 'last_call', money, reward('last_call'), saves);
    expect(sim.missions.offers()).toEqual([]);
  });

  it('fails as BUSTED with the usual bill', () => {
    const sim = storySim('last_call', { god: false });
    const shown = cards(sim);
    toTheBox(sim);
    sim.bustPlayer();
    step(sim, 0.3);
    failedWith(sim, shown, /busted/, 'last_call');
    expect(shown).toContainEqual(expect.stringMatching(/^BUSTED/));
  });

  it('fails as WASTED', () => {
    const sim = storySim('last_call', { god: false });
    const shown = cards(sim);
    toTheBox(sim);
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 0.3);
    failedWith(sim, shown, /wasted/, 'last_call');
    expect(shown).toContainEqual(expect.stringMatching(/^WASTED/));
  });
});
