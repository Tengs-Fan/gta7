// The places that later map passes must not move: the story missions' spots, the hidden packages' candidate spots and
// the landmark towers. Passes that rebuild single cells (src/world/attractions.ts) or add land after the shared draws keep
// every one of these where it was; the hashes were recorded on 4323153, before the attractions pass existed.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { landmarkTowers } from '../../src/render/city/landmarks';
import { chapter2Spots, missionSpots, type LaneSpot } from '../../src/sim/missions/spots';
import type { Poi } from '../../src/world/layout';
import { world } from './helpers';

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const xz = (p: { x: number; z: number }) => [p.x, p.z];
const poi = (p: Poi) => [p.id, p.x, p.z, p.heading];
const lane = (p: LaneSpot) => [p.lane.id, p.s, p.x, p.z, p.heading];

describe('the map guard: what a map pass must leave in place', () => {
  it('keeps the mission spots of both chapters', () => {
    const W = world();
    const m = missionSpots(W);
    const one = {
      pois: [m.lou, m.dex, m.bank, m.marina].map(poi),
      louBay: xz(m.louBay),
      packagePickup: xz(m.packagePickup),
      packageDrop: xz(m.packageDrop),
      repoCar: [m.repoCar.x, m.repoCar.z, m.repoCar.heading],
      repoGuards: m.repoGuards.map(xz),
      vans: m.vans.map((v) => [v.x, v.z, v.heading]),
      getaway: [m.getaway.lane.id, m.getaway.x, m.getaway.z, m.getaway.heading],
    };
    const c = chapter2Spots(W);
    const two = {
      vera: poi(c.vera),
      lanes: [c.curb, c.tailStart, c.tailMeet, c.tailEnd, c.tailResumeCar, ...c.pickupStops].map(lane),
      tailResume: [c.tailResume.x, c.tailResume.z, c.tailResume.heading],
      stealCar: [c.stealCar.x, c.stealCar.z, c.stealCar.heading],
      stealGuards: c.stealGuards.map(xz),
      stealResume: [c.stealResume.x, c.stealResume.z, c.stealResume.heading],
      evidence: xz(c.evidence),
    };
    expect(sha(one)).toBe('f90ccdb24b7f5fcc9bf5e41905b93129dbb8ed014b56dc7b35895fdd138ed60a');
    expect(sha(two)).toBe('600fab2f70dbf0253f34da05796067f212a874f5a36ab04be8d1744981f389fb');
  });

  it('keeps the open spots the hidden packages and pickups are placed on (pickups.ts), in order', () => {
    const W = world();
    // PickupSystem.placeWorldPickups' own filter: farthestPointOrder over this list places all twenty packages.
    const spots = W.layout.openSpots.filter((s) => W.isFree(s.x, s.z, 0.6) && W.waterDepth(s.x, s.z) < -0.1).map((s) => [s.x, s.z, s.district]);
    expect(spots.length).toBeGreaterThan(100);
    expect(sha(spots)).toBe('951a4341f4c5c71550c0ed4a22f44517a7fb03b5067f0dfc6c58aeae7797a5af');
  });

  it('keeps the landmark towers', () => {
    const ids = landmarkTowers(world().layout).map((l) => l.id);
    expect(ids.length).toBe(4);
    expect(sha(ids)).toBe('f6acb7c4b2975853af34f008deb32a61cd3b3df760d4f7530014a3e8202edfdb');
  });
});
