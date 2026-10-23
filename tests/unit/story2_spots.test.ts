// Chapter 2's places: on free, dry land, where the missions' lines say they are.

import { describe, expect, it } from 'vitest';
import { chapter2Spots } from '../../src/sim/missions/spots';
import { StaticWorld } from '../../src/world/staticWorld';

describe('chapter 2 spots', () => {
  const world = new StaticWorld();
  const s = chapter2Spots(world);

  it('puts every spot on dry land, the ground ones free, the lane ones on a lane', () => {
    const ground = { vera: s.vera, tailResume: s.tailResume, stealCar: s.stealCar, stealResume: s.stealResume, evidence: s.evidence, ...Object.fromEntries(s.stealGuards.map((g, i) => [`guard${i}`, g])) };
    for (const [name, p] of Object.entries(ground)) {
      expect(world.waterDepth(p.x, p.z), name).toBeLessThan(0);
      expect(world.isFree(p.x, p.z, 0.5), name).toBe(true);
    }
    const lanes = { curb: s.curb, tailStart: s.tailStart, tailMeet: s.tailMeet, tailEnd: s.tailEnd, tailResumeCar: s.tailResumeCar, ...Object.fromEntries(s.pickupStops.map((p, i) => [`stop${i + 1}`, p])) };
    for (const [name, p] of Object.entries(lanes)) {
      expect(world.waterDepth(p.x, p.z), name).toBeLessThan(0);
      expect(world.roads.nearestLane(p.x, p.z).dist, name).toBeLessThan(0.5);
      expect(world.isFree(p.x, p.z, 1), name).toBe(true);
    }
    expect(s.stealGuards.length).toBe(2);
  });

  it('parks the Nightjar by the street, the box near SAPD Central and the stops apart', () => {
    expect(world.roads.nearestLane(s.stealCar.x, s.stealCar.z).dist).toBeLessThan(15);
    const police = world.layout.pois.find((p) => p.id === 'police')!;
    expect(Math.hypot(s.evidence.x - police.x, s.evidence.z - police.z)).toBeLessThan(80);
    const stops = [...s.pickupStops, s.curb];
    for (let i = 1; i < stops.length; i++) expect(Math.hypot(stops[i]!.x - stops[i - 1]!.x, stops[i]!.z - stops[i - 1]!.z)).toBeGreaterThan(150);
    expect(Math.hypot(s.tailStart.x - s.curb.x, s.tailStart.z - s.curb.z)).toBeGreaterThan(50);
    expect(Math.hypot(s.tailResume.x - s.tailResumeCar.x, s.tailResume.z - s.tailResumeCar.z)).toBeLessThan(10);
  });
});
