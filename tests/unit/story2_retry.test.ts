// Chapter 2 retries: each mission resumes at its last checkpoint with that step's entities fresh, and no leftovers.

import { describe, expect, it } from 'vitest';
import type { Sim } from '../../src/sim/sim';
import { chapter2Spots } from '../../src/sim/missions/spots';
import { RAM_ESCAPE_DIST, WAVES } from '../../src/sim/missions/vera';
import { step, teleport } from './helpers';
import { active, enterVehicle, gunner, objectiveIs, parkAt, startAtMarker, stepUntil, storySim } from './story2_helpers';

const tagged = (sim: Sim, id: string) => sim.vehicles.filter((v) => !v.removed && v.missionTag === id);
const gangUp = (sim: Sim) => sim.characters.filter((c) => !c.removed && c.alive && c.role === 'gang');

/** Takes the quick retry (on foot, E) or the pause menu's, then waits out the fade. */
function retry(sim: Sim, id: string, fromMenu = false): void {
  if (!fromMenu && sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
  step(sim, 0.3);
  expect(sim.missions.retryNow(fromMenu), 'retry taken').toBe(true);
  stepUntil(sim, () => sim.missions.active?.def.id === id, 3);
  stepUntil(sim, () => sim.controlLock <= 0, 3);
}

describe('chapter 2 retry and checkpoints', () => {
  it('Shadow Play resumes at the meeting, with one new courier and car', () => {
    const sim = storySim('shadow_play');
    startAtMarker(sim, 'shadow_play');
    stepUntil(sim, objectiveIs(sim, 'Tail the courier: take the Pipsqueak first'), 30);
    let m = active(sim);
    const [car, courier] = [m.vehicles[0]!, m.vehicles[1]!];
    enterVehicle(sim, car);
    // Follow at 40 m, straight behind, until the checkpoint.
    stepUntil(sim, () => m.checkpointReached === 1, 200, () => {
      const fx = Math.sin(courier.heading);
      const fz = Math.cos(courier.heading);
      parkAt(sim, courier.pos.x - fx * 40, courier.pos.z - fz * 40, courier.heading);
    });
    console.log(`Shadow Play checkpoint 1 at ${m.time.toFixed(1)} s; before the failure ${tagged(sim, 'shadow_play').length} mission cars`);
    // Spotted on the second leg.
    stepUntil(sim, () => sim.missions.active === null, 20, () => {
      const fx = Math.sin(courier.heading);
      const fz = Math.cos(courier.heading);
      parkAt(sim, courier.pos.x - fx * 8, courier.pos.z - fz * 8, courier.heading);
    });
    retry(sim, 'shadow_play');
    m = active(sim);
    expect(m.resume).toBe(1);
    expect(m.retrying).toBe(true);
    stepUntil(sim, objectiveIs(sim, 'Tail the courier: take the Pipsqueak first'), 2);
    const s = chapter2Spots(sim.world);
    const cars = tagged(sim, 'shadow_play');
    console.log(`after the retry: ${cars.length} mission cars, courier ${Math.hypot(m.vehicles[1]!.pos.x - s.tailMeet.x, m.vehicles[1]!.pos.z - s.tailMeet.z).toFixed(1)} m from the meeting`);
    expect(cars).toEqual([m.vehicles[0], m.vehicles[1]]);
    expect(courier.removed && car.removed).toBe(true);
    expect(Math.hypot(m.vehicles[1]!.pos.x - s.tailMeet.x, m.vehicles[1]!.pos.z - s.tailMeet.z)).toBeLessThan(3);
    expect(Math.hypot(sim.player.pos.x - s.tailResume.x, sim.player.pos.z - s.tailResume.z)).toBeLessThan(8);
    expect(m.markers.filter((o) => o.label === 'Courier').length).toBe(1);
  });

  it('Room Service resumes at the wave it was lost on, its attackers only, after a WASTED', () => {
    const sim = storySim('room_service');
    startAtMarker(sim, 'room_service');
    stepUntil(sim, objectiveIs(sim, /wave 1\//), 30);
    const m = active(sim);
    const bot = gunner(sim, () => (sim.missions.active?.characters ?? []).filter((c) => c.role === 'gang'));
    stepUntil(sim, objectiveIs(sim, `Defend the hotel entrance (wave 2/${WAVES.length})`), 120, bot);
    expect(m.checkpointReached).toBe(1);
    const before = gangUp(sim).length;
    sim.cheats.godMode = false;
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 0.3);
    expect(sim.missions.active).toBeNull();
    stepUntil(sim, () => !sim.playerDown, 20);
    step(sim, 0.5);
    sim.cheats.godMode = true;
    retry(sim, 'room_service');
    const r = active(sim);
    expect(r.resume).toBe(1);
    stepUntil(sim, objectiveIs(sim, `Defend the hotel entrance (wave 2/${WAVES.length})`), 2);
    console.log(`Room Service: ${before} attackers up at the failure, ${gangUp(sim).length} after the retry`);
    expect(gangUp(sim).length).toBe(WAVES[1]);
    expect(r.markers.length).toBe(WAVES[1]);
    expect(sim.player.inventory.has('smg')).toBe(true);
  });

  it('Showroom Condition: before the theft it starts over with its minders; after it, the car alone', () => {
    const sim = storySim('showroom');
    startAtMarker(sim, 'showroom');
    stepUntil(sim, objectiveIs(sim, 'Steal the yellow Nightjar GT'), 30);
    sim.combat.explodeVehicle(active(sim).vehicles[0]!);
    step(sim, 0.5);
    expect(sim.missions.active).toBeNull();
    retry(sim, 'showroom');
    let m = active(sim);
    expect(m.resume).toBe(0);
    stepUntil(sim, objectiveIs(sim, 'Steal the yellow Nightjar GT'), 2);
    expect(tagged(sim, 'showroom').length).toBe(1);
    expect(m.characters.filter((c) => c.role === 'gang').length).toBe(2);
    console.log(`from the start: ${tagged(sim, 'showroom').length} Nightjar, ${gangUp(sim).length} minders`);

    enterVehicle(sim, m.vehicles[0]!);
    stepUntil(sim, () => m.checkpointReached === 1, 2);
    sim.combat.explodeVehicle(m.vehicles[0]!);
    step(sim, 0.5);
    expect(sim.missions.active).toBeNull();
    stepUntil(sim, () => !sim.playerDown, 20);
    retry(sim, 'showroom', true);
    m = active(sim);
    expect(m.resume).toBe(1);
    stepUntil(sim, objectiveIs(sim, 'Get back in the Nightjar'), 2);
    console.log(`from the checkpoint: ${tagged(sim, 'showroom').length} Nightjar, ${gangUp(sim).length} minders up, player ${Math.hypot(sim.player.pos.x - m.vehicles[0]!.pos.x, sim.player.pos.z - m.vehicles[0]!.pos.z).toFixed(1)} m from it`);
    expect(tagged(sim, 'showroom').length).toBe(1);
    expect(m.characters.length).toBe(0);
    expect(gangUp(sim).length).toBe(0);
    expect(Math.hypot(sim.player.pos.x - m.vehicles[0]!.pos.x, sim.player.pos.z - m.vehicles[0]!.pos.z)).toBeLessThan(6);
  });

  it('Off the Road resumes with the second car only', () => {
    const sim = storySim('off_the_road');
    startAtMarker(sim, 'off_the_road');
    stepUntil(sim, objectiveIs(sim, 'Get in the Dustrunner'), 30);
    const m = active(sim);
    enterVehicle(sim, m.vehicles[0]!);
    stepUntil(sim, objectiveIs(sim, /\(1\/2\)/), 3);
    const first = m.vehicles[1]!;
    first.health = 0.3 * first.spec.health;
    stepUntil(sim, objectiveIs(sim, /\(2\/2\)/), 3);
    expect(m.checkpointReached).toBe(1);
    const second = m.vehicles[2]!;
    const away = sim.world.findFreeSpot(second.pos.x + (RAM_ESCAPE_DIST + 80), second.pos.z, 2, 60) ?? sim.roads.node(0, 0);
    parkAt(sim, away.x, away.z);
    stepUntil(sim, () => sim.missions.active === null, 30);
    retry(sim, 'off_the_road');
    const r = active(sim);
    expect(r.resume).toBe(1);
    stepUntil(sim, objectiveIs(sim, 'Get in the Dustrunner'), 2);
    enterVehicle(sim, r.vehicles[0]!);
    stepUntil(sim, objectiveIs(sim, 'Ram the Tiburones car off the road (2/2)'), 3);
    const cars = tagged(sim, 'off_the_road');
    console.log(`Off the Road after the retry: ${cars.map((v) => v.kind).join(', ')}`);
    expect(cars.map((v) => v.kind)).toEqual(['pickup', 'sedan']);
    expect(first.removed && second.removed).toBe(true);
  });

  it('Rush Hour resumes at stop 3 with a fresh clock for the stops left', () => {
    const sim = storySim('rush_hour');
    startAtMarker(sim, 'rush_hour');
    stepUntil(sim, objectiveIs(sim, 'Get in the Thunderhoof'), 30);
    const m = active(sim);
    enterVehicle(sim, m.vehicles[0]!);
    const s = chapter2Spots(sim.world);
    for (const st of s.pickupStops.slice(0, 2)) {
      stepUntil(sim, objectiveIs(sim, /^Collect/), 3);
      parkAt(sim, st.x, st.z, st.heading);
      step(sim, 0.3);
    }
    expect(m.checkpointReached).toBe(1);
    stepUntil(sim, () => sim.missions.active === null, 300);
    retry(sim, 'rush_hour');
    const r = active(sim);
    expect(r.resume).toBe(1);
    enterVehicle(sim, r.vehicles[0]!);
    stepUntil(sim, objectiveIs(sim, 'Collect the envelope (stop 3/4)'), 3);
    console.log(`Rush Hour resumed at stop 3 with ${(r.timer!.endsAt - sim.time).toFixed(1)} s on the clock, ${tagged(sim, 'rush_hour').length} mission car`);
    expect(r.timer!.endsAt - sim.time).toBeGreaterThan(30);
    expect(tagged(sim, 'rush_hour').length).toBe(1);
  });

  it('Last Call resumes at the getaway after a BUSTED, with the stars back on', () => {
    const sim = storySim('last_call');
    startAtMarker(sim, 'last_call');
    stepUntil(sim, objectiveIs(sim, /^Steal the evidence/), 30);
    const ev = chapter2Spots(sim.world).evidence;
    teleport(sim, ev.x, ev.z);
    stepUntil(sim, objectiveIs(sim, 'Get to a car'), 3);
    const lane = sim.roads.nearestLane(ev.x, ev.z).lane;
    const car = sim.spawnVehicle('sports', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
    enterVehicle(sim, car);
    stepUntil(sim, objectiveIs(sim, 'Lose the cops'), 3);
    expect(active(sim).checkpointReached).toBe(1);
    sim.bustPlayer();
    step(sim, 0.3);
    expect(sim.missions.active).toBeNull();
    stepUntil(sim, () => !sim.playerDown, 20);
    step(sim, 0.5);
    // Refused while wanted, as in chapter 1.
    sim.wanted.setLevel(1);
    expect(sim.missions.retryNow()).toBe(false);
    expect(sim.missions.retryMenuOffer()?.blocked).toBe('Lose the cops before retrying.');
    sim.wanted.clear();
    sim.police.dismissAll();
    step(sim, 0.5);
    retry(sim, 'last_call');
    const r = active(sim);
    expect(r.resume).toBe(1);
    stepUntil(sim, objectiveIs(sim, 'Get in the Nightjar GT'), 2);
    expect(sim.wanted.level).toBe(3);
    enterVehicle(sim, r.vehicles[0]!);
    stepUntil(sim, objectiveIs(sim, 'Lose the cops'), 2);
    expect(sim.player.inventory.has('rifle')).toBe(true);
  });
});
