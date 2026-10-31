import { describe, expect, it } from 'vitest';
import { CAB_ARRIVAL_LIMIT, cabState, callCab, setCabDestination } from '../../src/sim/activities/cab';
import type { Sim } from '../../src/sim/sim';
import { input, makeSim } from './helpers';

/** A sidewalk spot beside the city's lane `laneIndex` (Las Lomas County's lanes come after them). */
function curbSpot(sim: Sim, laneIndex: number): { x: number; z: number } {
  const lane = sim.roads.gridLanes[laneIndex % sim.roads.gridLanes.length]!;
  const s = lane.length / 2;
  const x = lane.sx + lane.dx * s;
  const z = lane.sz + lane.dz * s;
  for (let off = 5; off < 14; off += 0.5) {
    const px = x - lane.dz * off;
    const pz = z + lane.dx * off;
    if (!sim.world.isOnRoad(px, pz) && sim.world.isFree(px, pz, 0.5)) return { x: px, z: pz };
  }
  return { x, z };
}

function place(sim: Sim, x: number, z: number): void {
  const p = sim.player;
  p.pos.x = x;
  p.pos.z = z;
  p.pos.y = sim.world.groundHeight(x, z);
}

/** Steps until `done` holds or `limit` s pass; returns the seconds taken (Infinity on timeout). */
function until(sim: Sim, limit: number, done: () => boolean, press?: () => boolean): number {
  const dt = 1 / 60;
  for (let t = 0; t < limit; t += dt) {
    const pp = sim.playerPos();
    sim.update(dt, input({ aimOrigin: { x: pp.x, y: pp.y + 3, z: pp.z - 6 }, aimDir: { x: 0, y: 0, z: 1 }, enterExit: press?.() ?? false }));
    if (done()) return t;
  }
  return Infinity;
}

/** One press of the enter key in the next frame. */
function pressEnter(sim: Sim): void {
  let pressed = false;
  until(sim, 0.5, () => pressed, () => (pressed ? false : (pressed = true)));
}

/** Calls a cab to a curb by lane `lane` and waits for it; returns the seconds it took and its distance to the player. */
function cabArrives(sim: Sim, lane: number): { t: number; d: number } {
  const spot = curbSpot(sim, lane);
  place(sim, spot.x, spot.z);
  sim.update(1 / 60, input());
  expect(callCab(sim).ok).toBe(true);
  const t = until(sim, CAB_ARRIVAL_LIMIT, () => cabState(sim)?.stage === 'waiting');
  const j = cabState(sim)!;
  return { t, d: Math.hypot(j.cab.pos.x - sim.player.pos.x, j.cab.pos.z - sim.player.pos.z) };
}

/** Walks up to the waiting cab and gets in with the enter key. */
function getIn(sim: Sim): void {
  const j = cabState(sim)!;
  const side = sim.world.findFreeSpot(j.cab.pos.x - Math.cos(j.cab.heading) * 2.2, j.cab.pos.z + Math.sin(j.cab.heading) * 2.2, 0.4, 3)!;
  place(sim, side.x, side.z);
  pressEnter(sim);
}

describe('call a cab', () => {
  it(`comes to the player within ${CAB_ARRIVAL_LIMIT} s and stops within 10 m of him (5 seeds)`, () => {
    const rows: string[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const sim = makeSim({ seed, ambient: true, police: false });
      const { t, d } = cabArrives(sim, seed * 37 + 11);
      rows.push(`seed ${seed}: arrived in ${t.toFixed(1)} s, stopped ${d.toFixed(1)} m from the player`);
      expect(t).toBeLessThan(CAB_ARRIVAL_LIMIT);
      expect(d).toBeLessThan(10);
      getIn(sim);
      const j = cabState(sim)!;
      expect(sim.player.vehicle).toBe(j.cab);
      expect(sim.player.seat).toBeGreaterThan(0);
      expect(j.cab.driver).toBe(j.driver);
    }
    console.log(rows.join('\n'));
  });

  it('drives to the waypoint and lets the player out within 15 m of its road point, charging once (3 seeds x 3 waypoints)', () => {
    const rows: string[] = [];
    for (const seed of [1, 2, 3]) {
      for (const w of [0, 1, 2]) {
        const sim = makeSim({ seed, ambient: true, police: false });
        cabArrives(sim, seed * 37 + 11 + w * 5);
        getIn(sim);
        const from = { ...sim.playerPos() };
        const far = curbSpot(sim, seed * 53 + 101 + w * 211);
        const money = sim.progress.money;
        let charges = 0;
        const off = sim.events.on('money', (e) => {
          if (e.amount < 0) charges++;
        });
        setCabDestination(sim, far);
        until(sim, 0.1, () => false);
        const j = cabState(sim)!;
        expect(j.stage).toBe('riding');
        const stop = { x: j.stopX, z: j.stopZ };
        const t = until(sim, 300, () => !sim.activities.busy);
        off();
        const end = Math.hypot(sim.player.pos.x - stop.x, sim.player.pos.z - stop.z);
        rows.push(`seed ${seed} waypoint ${w}: ${Math.hypot(far.x - from.x, far.z - from.z).toFixed(0)} m away, ride ${j.odometer.toFixed(0)} m in ${t.toFixed(1)} s, out ${end.toFixed(1)} m from the road point, fare $${money - sim.progress.money} (${charges} charge)`);
        expect(t).toBeLessThan(300);
        expect(sim.player.vehicle).toBeNull();
        expect(end).toBeLessThan(15);
        expect(charges).toBe(1);
      }
    }
    console.log(rows.join('\n'));
  });

  it('asks for a waypoint before driving off, and getting out early costs nothing', () => {
    const sim = makeSim({ seed: 2, ambient: true, police: false });
    const said: string[] = [];
    sim.events.on('message', (e) => said.push(e.text));
    cabArrives(sim, 85);
    getIn(sim);
    const j = cabState(sim)!;
    expect(j.stage).toBe('seated');
    expect(said.at(-1)).toMatch(/Set a waypoint on the map/);
    const at = { x: j.cab.pos.x, z: j.cab.pos.z };
    until(sim, 5, () => false);
    expect(Math.hypot(j.cab.pos.x - at.x, j.cab.pos.z - at.z)).toBeLessThan(1);
    setCabDestination(sim, curbSpot(sim, 400));
    until(sim, 8, () => false);
    expect(j.stage).toBe('riding');
    // Off and away: it has covered ground (it may be waiting at a red light at this instant).
    expect(j.odometer).toBeGreaterThan(20);
    const money = sim.progress.money;
    pressEnter(sim);
    until(sim, 10, () => !sim.activities.busy);
    expect(sim.activities.busy).toBe(false);
    expect(sim.player.vehicle).toBeNull();
    expect(sim.progress.money).toBe(money);
    expect(said.at(-1)).toMatch(/No charge/);
  });
});
