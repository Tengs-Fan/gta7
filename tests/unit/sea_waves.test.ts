// The sea's swell (render/waves.ts) and where it reaches (render/seaShelter.ts): the shelter and depth baked over the
// world, which calm the harbours, the canal, the Marina and the water along the quays and leave the open sea and the
// beaches to the waves; the breakers over the beach and the clearance under the decks; a boat riding and slamming; a
// swimmer and his camera riding the swell.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BoatView, SLAM_SPEED } from '../../src/render/boatView';
import { CameraController } from '../../src/render/camera';
import { CrowdView } from '../../src/render/crowd';
import { countyShore, seaDepthCpu, seaHeightAt, seaUniforms, setSeaShelter, updateSea, type CountyShore } from '../../src/render/sea';
import { bakeSeaShelter, SHELTER_CELL, SHELTER_RAMP } from '../../src/render/seaShelter';
import {
  CALM_SEA, OPEN_SEA, SURF_GAMMA, SURF_K, SURF_LAG, SURF_SYNC_DEPTH, WAVE_K, seaHeight, shelterAt, surfPhase, wavePhases, type SeaSurface, type ShelterMap,
} from '../../src/render/waves';
import { SWIM_FLOAT } from '../../src/sim/characterPhysics';
import type { Vehicle } from '../../src/sim/entities';
import { SWIM_HIP } from '../../src/sim/pose';
import { BEACH_W, CURB_H, DECK_SLAB, SAND_DROP, WATER_Y } from '../../src/world/constants';
import { segmentJoints } from '../support/crowdJoints';
import { makeSim, world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

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

/** The sea as drawn at time `t` and sea state `sea`, the grid centred on (ox, oz), with the shelter map. */
function drawnSea(t: number, sea: number, ox: number, oz: number): SeaSurface {
  const phases = wavePhases(t);
  return { phases, surf: surfPhase(phases[0]!, world().layout.bounds.beachStartX), sea, ox, oz, shelter: map };
}

describe('the waves over the beach and under the decks', () => {
  it('on the east beach the swell shoals into breakers, steeper than the swell and capped by the depth, and the waterline stays put', () => {
    const b = world().layout.bounds;
    const z = -150;
    for (const sea of [CALM_SEA, 1]) {
      let breaker = { lo: Infinity, hi: -Infinity };
      for (let k = 0; k < 120; k++) {
        const s = drawnSea(k * 0.13, sea, 560, z);
        for (let x = b.beachStartX + 30; x < b.beachEndX; x += 0.7) {
          const d = seaDepthCpu(b, x, z, county);
          const h = seaHeight(s, x, z);
          // Never over SURF_GAMMA times the depth (a wave breaks before it gets taller), never draining the sand.
          expect(h, `x ${x.toFixed(1)} depth ${d.toFixed(2)}`).toBeLessThanOrEqual(SURF_GAMMA * Math.max(d, 0) * 1.05 + 1e-3);
          expect(h).toBeGreaterThan(-Math.max(d, 0) - 1e-3);
          if (Math.abs(d - 1.2) < 0.05) breaker = { lo: Math.min(breaker.lo, h), hi: Math.max(breaker.hi, h) };
        }
      }
      // A breaker about a metre high where the beach is 1.2 m deep (a wave breaks at about 0.8 times the depth).
      expect(breaker.hi - breaker.lo, `sea ${sea}`).toBeGreaterThan(0.75);
    }
    // The breakers come in with the onshore swell wave: at SURF_SYNC_DEPTH the two are in step.
    const x = b.beachStartX + (BEACH_W * (SURF_SYNC_DEPTH + CURB_H - WATER_Y)) / SAND_DROP;
    for (const p0 of [0, 1.3, 4.4]) {
      const surf = surfPhase(p0, b.beachStartX);
      expect(Math.sin(SURF_SYNC_DEPTH * SURF_K + surf + SURF_LAG)).toBeCloseTo(Math.sin(-WAVE_K[0]! * x - p0), 6);
    }
  });

  it('in a storm nothing rises through the decks or over the quays, and the land stays dry', () => {
    const layout = world().layout;
    const b = layout.bounds;
    const decks = layout.decks.filter((d) => !d.dirt);
    let worstDeck = -Infinity;
    let worstQuay = -Infinity;
    for (let k = 0; k < 40; k++) {
      const t = k * 0.71;
      for (const d of decks) {
        const r = d.rect;
        const s = drawnSea(t, 1, (r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2);
        for (let x = r.minX - 1; x <= r.maxX + 1; x += 3) {
          for (let z = r.minZ - 1; z <= r.maxZ + 1; z += 3) worstDeck = Math.max(worstDeck, seaHeight(s, x, z) - (d.y - DECK_SLAB - WATER_Y));
        }
      }
      // Two metres out from the land rectangle's west, north and south quays.
      const s = drawnSea(t, 1, 0, 0);
      for (let u = b.landMinZ; u <= b.landMaxZ; u += 9) worstQuay = Math.max(worstQuay, seaHeight(s, b.landMinX - 2, u));
      for (let u = b.landMinX; u <= b.beachStartX - 20; u += 9) worstQuay = Math.max(worstQuay, seaHeight(s, u, b.landMinZ - 2), seaHeight(s, u, b.landMaxZ + 2));
      expect(seaHeight(s, 0, 0)).toBe(0);
    }
    console.log(`[sea] storm: highest crest ${(worstDeck).toFixed(2)} m against the decks' undersides, ${(worstQuay - (CURB_H - WATER_Y)).toFixed(2)} m against the quays' tops`);
    expect(worstDeck).toBeLessThan(-0.3);
    expect(worstQuay).toBeLessThan(0.25);
  });
});

describe('a boat on the drawn sea', () => {
  /** A speedboat in open water east of the beach, its view on the sea's uniforms (the shelter map's too). */
  function rig(): { v: Vehicle; view: BoatView; u: ReturnType<typeof seaUniforms> } {
    const sim = makeSim({ world: world() });
    const v = sim.spawnVehicle('speedboat', 700, -250, Math.PI / 2);
    v.pos.y = WATER_Y;
    const u = seaUniforms();
    u.uDisplace.value = 1;
    setSeaShelter(u, map);
    const view = new BoatView('speedboat');
    view.bindSea(u);
    view.bind(v);
    return { v, view, u };
  }

  it('at rest it heaves on the drawn surface under it, a metre or so on a calm day', () => {
    const { v, view, u } = rig();
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 600; k++) {
      const t = k / 30;
      updateSea(u, t, CALM_SEA, v.pos.x, v.pos.z);
      view.sync(v, 1 / 30, t, 0);
      const y = view.group.position.y - WATER_Y;
      // The hull rides on its bow and stern's sea, never off it at rest.
      const sea = seaHeightAt(u, v.pos.x, v.pos.z);
      expect(Math.abs(y - sea), `t ${t.toFixed(2)}`).toBeLessThan(0.12);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    expect(hi - lo).toBeGreaterThan(0.6);
    // It may lift off the water by a hair as its spring overshoots, but never slams at rest.
    expect(view.slam).toBeLessThan(SLAM_SPEED);
  });

  it('at speed into a storm\'s sea it leaves the crests and slams down beyond them, ploughing into the faces it cannot rise to', () => {
    const { v, view, u } = rig();
    v.heading = -Math.PI / 2;
    v.forwardSpeed = 25;
    v.vel.x = -25;
    let flown = 0;
    let slams = 0;
    let under = 0;
    for (let k = 0; k < 300; k++) {
      const t = k / 60;
      v.pos.x = 740 - 25 * t;
      updateSea(u, t, 1, v.pos.x, v.pos.z);
      view.sync(v, 1 / 60, t, 0);
      const bow = view.group.position.y - WATER_Y;
      const sea = seaHeightAt(u, v.pos.x, v.pos.z);
      flown = Math.max(flown, bow - sea);
      under = Math.min(under, bow - sea);
      if (view.slam > SLAM_SPEED) slams++;
      view.slam = 0;
    }
    console.log(`[boat] storm at 25 m/s: up to ${flown.toFixed(2)} m clear of the sea and ${(-under).toFixed(2)} m into it, ${slams} slams in 5 s`);
    expect(flown).toBeGreaterThan(0.15);
    // Clear of it by a hull's height or so at most, never thrown metres into the air.
    expect(flown).toBeLessThan(1.2);
    expect(slams).toBeGreaterThan(0);
    // Its bow ploughs into a face it meets too fast to rise up, but not far.
    expect(under).toBeGreaterThan(-0.7);
  });
});

describe('a swimmer in the swell', () => {
  /** The player swimming in open water east of the beach, and the sea's uniforms in a storm (the shelter map's too). */
  function rig() {
    const sim = makeSim({ world: world(), police: false });
    const p = sim.player;
    Object.assign(p.pos, { x: 700, y: WATER_Y - SWIM_FLOAT, z: -250 });
    p.state = 'swimming';
    const u = seaUniforms();
    u.uDisplace.value = 1;
    setSeaShelter(u, map);
    return { sim, p, u };
  }

  it('is drawn riding the surface, his gun held up with him', () => {
    const { p, u } = rig();
    p.inventory.give('pistol', 100);
    p.inventory.current = 'pistol';
    p.aiming = true;
    const cv = new CrowdView();
    cv.bindSea(u);
    let seen = 0;
    for (let k = 0; k < 8; k++) {
      updateSea(u, 1.7 + k * 0.9, 1, p.pos.x, p.pos.z);
      cv.sync([p], p.pos.x, p.pos.z, 1 / 60);
      const lift = seaHeightAt(u, p.pos.x, p.pos.z);
      seen = Math.max(seen, Math.abs(lift));
      expect(segmentJoints(cv, p).get('pelvis')!.y).toBeCloseTo(p.pos.y + SWIM_HIP + lift, 4);
    }
    expect(seen).toBeGreaterThan(0.3);
  });

  it('keeps the camera above the drawn sea, rising and falling with him', () => {
    const { sim, u } = rig();
    const cam = new CameraController(16 / 9);
    cam.bindSea(u);
    cam.mode = 'play';
    cam.reset(sim);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 600; k++) {
      updateSea(u, k / 60, 1, sim.player.pos.x, sim.player.pos.z);
      cam.update(1 / 60, sim, false);
      const c = cam.camera.position;
      if (k < 60) continue;
      expect(c.y - (WATER_Y + seaHeightAt(u, c.x, c.z)), `frame ${k}`).toBeGreaterThanOrEqual(0.35 - 1e-6);
      lo = Math.min(lo, c.y);
      hi = Math.max(hi, c.y);
    }
    expect(hi - lo).toBeGreaterThan(1);
  });
});
