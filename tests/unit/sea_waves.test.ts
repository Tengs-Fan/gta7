// The sea's swell (render/waves.ts) and where it reaches (render/seaShelter.ts): the shelter and depth baked over the
// world, which calm the harbours, the canal, the Marina and the water along the quays and leave the open sea and the
// beaches to the waves.

import { beforeAll, describe, expect, it } from 'vitest';
import { countyShore, seaDepthCpu, type CountyShore } from '../../src/render/sea';
import { bakeSeaShelter, SHELTER_CELL, SHELTER_RAMP } from '../../src/render/seaShelter';
import { OPEN_SEA, shelterAt, type ShelterMap } from '../../src/render/waves';
import { WATER_Y } from '../../src/world/constants';
import { world } from './helpers';

let county: CountyShore;
let map: ShelterMap;

beforeAll(() => {
  county = countyShore(world().layout.country);
  map = bakeSeaShelter(world(), county);
});

const at = (x: number, z: number) => shelterAt(map, x, z);

describe('the shelter map', () => {
  it('covers the world with open, deep sea at its edges', () => {
    const b = world().layout.bounds;
    expect(map.minX).toBeLessThan(b.worldMinX - 100);
    expect(map.minZ).toBeLessThan(b.worldMinZ - 100);
    expect(map.minX + map.nx * map.cell).toBeGreaterThan(b.worldMaxX + 100);
    expect(map.minZ + map.nz * map.cell).toBeGreaterThan(b.worldMaxZ + 100);
    expect(map.cell).toBe(SHELTER_CELL);
    for (const [x, z] of [[map.minX - 500, 0], [0, map.minZ - 500], [5000, 5000], [b.worldMaxX + 110, -200]] as const) {
      const s = at(x, z);
      expect(s[0], `${x} ${z}`).toBeCloseTo(1, 6);
      expect(s[1], `${x} ${z}`).toBeCloseTo(OPEN_SEA[1]!, 6);
    }
  });

  it('calms the harbour basin, the coves and bays, the canal and the Marina', () => {
    const calm: Array<[string, number, number]> = [
      ['Port Basin', -440, 455], ['Pelican Harbor', -450, 90], ['Northshore Bay', 270, -440], ['Coral Bay', 316, 420], ['Hillcrest Cove', -440, -450],
      ['Cortez Canal', -175, 0], ['Cortez Canal north mouth', -175, -514],
      // The moored boats between the Marina's slips, and under the seaward half of Azura Pier and the Key's jetty.
      ['Marina boat', 596, 466], ['Marina boat', 622, 466], ['Marina boat', 648, 466], ['Azura Pier', 650, 40], ["Smuggler's Key jetty", 250, -600],
      ['Southgate Bridge', -600, 268],
    ];
    for (const [name, x, z] of calm) expect(at(x, z)[0], name).toBeLessThan(0.02);
  });

  it('lets the waves grow back over SHELTER_RAMP from the quays and sea walls, but not from the beaches', () => {
    const b = world().layout.bounds;
    // North of the promenade at Delgado St, west of it in the sound: calm at the wall, open by the ramp's end.
    for (const [x, z, nx, nz] of [[-300, b.landMinZ, 0, -1], [b.landMinX, -100, -1, 0]] as const) {
      expect(at(x + nx * 2, z + nz * 2)[0]).toBeLessThan(0.02);
      expect(at(x + nx * 10, z + nz * 10)[0]).toBeLessThan(0.12);
      expect(at(x + nx * (SHELTER_RAMP[1] + 6), z + nz * (SHELTER_RAMP[1] + 6))[0]).toBeGreaterThan(0.98);
    }
    // The east beach: open right up to its waterline, which the depth pins (a third of the way down the sand).
    const waterline = b.beachStartX + 110 * (1.15 / 3.2);
    for (const z of [-400, -150, 250]) {
      for (const x of [waterline + 1, waterline + 20, b.beachEndX - 2, b.beachEndX + 60]) {
        const s = at(x, z);
        expect(s[0], `${x} ${z}`).toBeGreaterThan(0.99);
        expect(s[1], `${x} ${z}`).toBeCloseTo(seaDepthCpu(b, x, z, county), 1);
      }
    }
    // The county's shore off its east coast shelves into the sound like a beach: no wall.
    expect(at(-680, 0)[0]).toBeGreaterThan(0.99);
    expect(at(-680, 0)[1]).toBeGreaterThan(0.5);
  });

  it('holds the drawn depth and its slope: shoreward down the beach, negative on land', () => {
    const b = world().layout.bounds;
    const beach = at(560, -150);
    expect(beach[1]).toBeCloseTo(seaDepthCpu(b, 560, -150, county), 2);
    expect(beach[2]).toBeCloseTo(3.2 / 110, 3);
    expect(Math.abs(beach[3]!)).toBeLessThan(1e-3);
    // Downtown's streets stand a metre over the sea.
    expect(at(0, 0)[1]).toBeLessThanOrEqual(WATER_Y);
  });

  it('samples bilinearly between lattice points, as the GPU filters it', () => {
    const k = (j: number, i: number) => (j * map.nx + i) * 4;
    const i = 400;
    const j = 200;
    const x0 = map.minX + (i + 0.5) * map.cell;
    const z0 = map.minZ + (j + 0.5) * map.cell;
    expect(at(x0, z0)[1]).toBeCloseTo(map.data[k(j, i) + 1]!, 6);
    const mid = at(x0 + map.cell * 0.25, z0 + map.cell * 0.5)[1]!;
    const want = (map.data[k(j, i) + 1]! * 0.75 + map.data[k(j, i + 1) + 1]! * 0.25) * 0.5 + (map.data[k(j + 1, i) + 1]! * 0.75 + map.data[k(j + 1, i + 1) + 1]! * 0.25) * 0.5;
    expect(mid).toBeCloseTo(want, 6);
    expect(shelterAt(null, 3, 4)).toEqual([...OPEN_SEA]);
  });
});
