// Lake Lomas's shore and Pinewood (world/country/lakeland.ts): the fishing dock and the dinghies moored at it, the lake's
// cabins and campground, the pine forest and the track and fire lookout tower in it, and the wild country of the valley's
// north. They keep off every road and out of the vineyard and the ranch, the dinghies cannot leave the lake, the pines
// are solid trunks on the ground, and the telescope at the tower's foot is a viewpoint.

import { describe, expect, it } from 'vitest';
import { bakeSeaShelter } from '../../src/render/seaShelter';
import { countyShore } from '../../src/render/sea';
import { viewpoints } from '../../src/render/dressing';
import { hullDepth } from '../../src/sim/boatPhysics';
import { lakeMoorings, mooredBoats } from '../../src/sim/boats';
import type { Vehicle } from '../../src/sim/entities';
import { WATER_Y } from '../../src/world/constants';
import { COUNTY_PLOTS, countryGround, inLake, LAKE_NAME } from '../../src/world/country';
import { roadGap, lakeGap } from '../../src/world/country/lakeland';
import { DOCK_Y } from '../../src/world/country/lake';
import { PINE_TOWER } from '../../src/world/country/woods';
import { rectContains } from '../../src/world/layout';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';
import { stepUntil } from './r2_police_helpers';

const W = world();
const L = W.layout;
const land = L.country.lakeland;
const plot = (id: string) => COUNTY_PLOTS.find((p) => p.id === id)!.rect;
const mine = L.props.slice(land.forest.first);
const solids = L.country.places.solids.slice(land.firstSolid);

describe('the fishing dock', () => {
  it('is two piers on the lake at the Marina\'s deck height, named for the lake, from dry land out over deep water', () => {
    const decks = L.decks.filter((d) => d.name === LAKE_NAME);
    expect(decks.map((d) => d.rect)).toEqual([land.dock.walk, land.dock.head]);
    for (const d of decks) {
      expect(d.y).toBe(DOCK_Y);
      expect(d.bridge).toBe(false);
    }
    const { walk, head } = land.dock;
    // The walkway starts on land (the ground there is dry) and meets the head's middle.
    expect(countryGround(L.country, walk.maxX + 1, (walk.minZ + walk.maxZ) / 2)).toBeGreaterThanOrEqual(0);
    expect(walk.minX).toBeLessThan(head.maxX);
    expect(walk.minX).toBeGreaterThan(head.minX);
    for (const z of [head.minZ + 1, head.maxZ - 1]) expect(W.waterDepth(head.minX - 3, z)).toBeGreaterThan(1.5);
    expect(W.groundHeight(head.minX + 1, head.minZ + 3)).toBe(DOCK_Y);
    expect(W.zoneName(head.minX + 1, head.minZ + 3)).toBe(LAKE_NAME);
  });

  it('is calm, as the lake is: no swell reaches its piers', () => {
    const map = bakeSeaShelter(W, countyShore(L.country));
    const at = (x: number, z: number) => map.data[(Math.min(map.nz - 1, Math.floor((z - map.minZ) / map.cell)) * map.nx + Math.min(map.nx - 1, Math.floor((x - map.minX) / map.cell))) * 4]!;
    const { head, walk } = land.dock;
    for (const [x, z] of [[head.minX - 2, head.minZ + 6], [(walk.minX + walk.maxX) / 2, (walk.minZ + walk.maxZ) / 2], [head.minX + 3, head.maxZ - 2]] as const) expect(at(x, z), `${x}, ${z}`).toBeLessThan(0.02);
  });

  it('can be walked out along from the shore to the T-head, over the water, without a step too tall', () => {
    const sim = makeSim({ police: false });
    const { walk, head } = land.dock;
    const z = (walk.minZ + walk.maxZ) / 2;
    teleport(sim, walk.maxX + 4, z);
    let lowest = Infinity;
    let there: { y: number; state: string } | null = null;
    const t = stepUntil(sim, 20, () => {
      lowest = Math.min(lowest, sim.player.pos.y);
      if (!there && sim.player.pos.x < head.maxX - 1) there = { y: sim.player.pos.y, state: sim.player.state };
      return there !== null;
    }, () => input({ moveZ: 1, cameraYaw: -Math.PI / 2 }));
    expect(t).toBeGreaterThanOrEqual(0);
    expect(there!.state).not.toBe('swimming');
    expect(there!.y).toBeCloseTo(DOCK_Y, 1);
    expect(lowest).toBeGreaterThan(-0.2);
  });
});

describe('the dinghies', () => {
  /** An ambient sim with the player standing on the dock's T-head by the moorings. */
  function atDock(seed = 5) {
    const sim = makeSim({ ambient: true, police: false, seed });
    const { head } = land.dock;
    teleport(sim, head.minX + 1.5, head.minZ + 11);
    step(sim, 1.2);
    return sim;
  }

  it('two wait at the head\'s west side, afloat a metre off it, clear of the deck, when the player is near, and none when he is far', () => {
    const sim = atDock();
    const moor = lakeMoorings(sim.world);
    expect(moor.length).toBe(2);
    const boats = mooredBoats(sim).filter((b): b is Vehicle => !!b);
    expect(boats.map((b) => b.kind)).toEqual(['dinghy', 'dinghy']);
    expect(new Set(boats.map((b) => b.color)).size).toBe(2);
    const { head } = land.dock;
    for (const b of boats) {
      expect(b.pos.y).toBeCloseTo(WATER_Y, 6);
      expect(b.pos.x + b.halfW).toBeLessThan(head.minX - 0.5);
      expect(hullDepth(b, sim.world, b.pos.x, b.pos.z, b.heading)).toBeGreaterThan(b.spec.boat!.draft + 1);
      expect(inLake(b.pos.x, b.pos.z)).toBe(true);
    }
    const far = makeSim({ ambient: true, police: false, seed: 5 });
    teleport(far, -1330, 84);
    step(far, 2);
    expect(mooredBoats(far).filter((b) => !!b)).toEqual([]);
  });

  it('is boarded with F from the T-head', () => {
    const sim = atDock();
    const boat = mooredBoats(sim).find((b): b is Vehicle => !!b)!;
    const p = sim.player;
    p.pos.x = boat.pos.x + boat.halfW + 1.5;
    p.pos.z = boat.pos.z;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    step(sim, 0.2);
    step(sim, 1 / 60, input({ enterExit: true }));
    expect(stepUntil(sim, 2, () => p.vehicle === boat)).toBeGreaterThanOrEqual(0);
    expect(boat.driver).toBe(p);
  });

  it('is stopped by the T-head when driven at it from its mooring, and never climbs onto the deck', () => {
    const sim = atDock();
    const boat = mooredBoats(sim).find((b): b is Vehicle => !!b)!;
    const p = sim.player;
    p.pos.x = boat.pos.x + boat.halfW + 1.5;
    p.pos.z = boat.pos.z;
    step(sim, 0.2);
    step(sim, 1 / 60, input({ enterExit: true }));
    stepUntil(sim, 2, () => p.vehicle === boat);
    expect(p.vehicle).toBe(boat);
    // Bow to the east, at the deck from three metres off, full throttle.
    boat.pos.x -= 2;
    boat.heading = Math.PI / 2;
    for (let f = 0; f < 60 * 15; f++) {
      sim.update(1 / 60, input({ throttle: 1 }));
      expect(sim.world.groundHeight(boat.pos.x, boat.pos.z), 'on the deck').toBeLessThan(WATER_Y);
    }
    expect(boat.pos.x + boat.halfL).toBeLessThanOrEqual(land.dock.head.minX + 0.2);
  });

  it('cannot leave the lake, whichever way it is steered from a spot off the dock at full throttle, and never climbs the dock or the shore', () => {
    const { head } = land.dock;
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.8, 2.4, -2.4, -0.8]) {
      const sim = makeSim({ police: false });
      const boat = sim.spawnVehicle('dinghy', head.minX - 14, (head.minZ + head.maxZ) / 2, heading);
      boat.pos.y = WATER_Y;
      placeInCar(sim, boat);
      for (let f = 0; f < 60 * 50; f++) {
        sim.update(1 / 60, input({ throttle: 1 }));
        if (f % 30 === 0) {
          expect(inLake(boat.pos.x, boat.pos.z), `heading ${heading} at ${boat.pos.x.toFixed(0)}, ${boat.pos.z.toFixed(0)}`).toBe(true);
          expect(sim.world.groundHeight(boat.pos.x, boat.pos.z)).toBeLessThan(WATER_Y);
        }
      }
    }
  }, 120_000);
});

describe('what it keeps clear of', () => {
  const vineyard = plot('vineyard');
  const ranch = plot('ranch');
  it('keeps every prop, building, solid, sign and boulder off the roads, the vineyard, the ranch and the land south of the Pass Road', () => {
    const pts: Array<[string, number, number, number]> = [];
    for (const p of mine) pts.push([p.kind, p.x, p.z, 8]);
    for (const s of solids) pts.push([`solid ${s.tag}`, (s.rect.minX + s.rect.maxX) / 2, (s.rect.minZ + s.rect.maxZ) / 2, 6]);
    for (const s of land.signs) pts.push([`sign ${s.id}`, s.x, s.z, 2.5]);
    for (const b of land.boulders) pts.push(['boulder', b.x, b.z, 5]);
    for (const c of land.cabins) pts.push(['cabin', (c.rect.minX + c.rect.maxX) / 2, (c.rect.minZ + c.rect.maxZ) / 2, 12]);
    for (const t of land.tables) pts.push(['table', t.x, t.z, 6]);
    for (const f of land.flowers) pts.push(['flowers', f.x, f.z, f.r + 4]);
    expect(pts.length).toBeGreaterThan(2500);
    for (const [what, x, z, gap] of pts) {
      expect(roadGap(x, z), `${what} at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBeGreaterThanOrEqual(gap);
      expect(rectContains(vineyard, x, z, 6), `${what} in the vineyard at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(false);
      expect(rectContains(ranch, x, z, 6), `${what} in the ranch at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(false);
      expect(z, `${what} south of the Pass Road`).toBeLessThan(80);
    }
  });

  it('leaves the lanes\' mouths on the road\'s edge only: every other point of every lane is clear of the carriageway', () => {
    for (const l of land.lanes) {
      expect(l.pts.length).toBeGreaterThanOrEqual(4);
      expect(roadGap(l.pts[0]!, l.pts[1]!)).toBeLessThan(0.5);
      expect(roadGap(l.pts[0]!, l.pts[1]!)).toBeGreaterThan(-1);
      for (let k = 2; k < l.pts.length; k += 2) expect(roadGap(l.pts[k]!, l.pts[k + 1]!), `lane point ${k / 2}`).toBeGreaterThan(l.width / 2);
    }
  });

  it('puts nothing on the lake: no prop, solid or reed bed but the dock stands in water deeper than a wader', () => {
    for (const p of mine) expect(countryGround(L.country, p.x, p.z), `${p.kind} at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`).toBeGreaterThanOrEqual(0);
    for (const s of solids) {
      const x = (s.rect.minX + s.rect.maxX) / 2;
      const z = (s.rect.minZ + s.rect.maxZ) / 2;
      if (s.tag === 'lamp' && x > -1905 && x < -1890 && z < -260 && z > -290) continue;
      expect(countryGround(L.country, x, z), `solid ${s.tag} at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the cabins and the campground', () => {
  it('has four cabins that are solid buildings facing the lake with porches, and a camp of three tents, a van and a toilet round a fire ring', () => {
    expect(land.cabins.length).toBe(4);
    for (const c of land.cabins) {
      const b = L.buildings.find((q) => q.id === c.building)!;
      expect(b.district).toBe('country');
      expect(W.isFree((c.rect.minX + c.rect.maxX) / 2, (c.rect.minZ + c.rect.maxZ) / 2, 0.3)).toBe(false);
      expect(W.isFree((c.porch.minX + c.porch.maxX) / 2, c.porch.maxZ + 0.6, 0.3)).toBe(true);
      expect(lakeGap(c.rect.minX, c.porch.maxZ)).toBeLessThan(30);
    }
    const camp = land.camp;
    expect(camp.tents.map((t) => t.kind).sort()).toEqual(['dome', 'family', 'ridge']);
    for (const t of camp.tents) expect(W.isFree(t.x, t.z, 0.3), `tent ${t.kind}`).toBe(false);
    expect(W.isFree(camp.van.x, camp.van.z, 0.3)).toBe(false);
    expect(W.isFree(camp.toilet.x, camp.toilet.z, 0.3)).toBe(false);
    expect(W.isFree(camp.fire.x, camp.fire.z, 0.3)).toBe(false);
    expect(W.isFree(camp.fire.x + camp.ring + 1.2, camp.fire.z, 0.3)).toBe(true);
    // The camp is within sight of the water and a long walk from the road.
    expect(lakeGap(camp.fire.x, camp.fire.z)).toBeLessThan(35);
    expect(roadGap(camp.fire.x, camp.fire.z)).toBeGreaterThan(60);
  });

  it('labels the campground and the lookout on the map', () => {
    expect(land.labels.map((l) => l.name)).toEqual(['Lake Lomas Campground', 'Pinewood Lookout']);
  });
});

describe('Pinewood', () => {
  const pinewood = plot('pinewood');
  const pines = mine.filter((p) => p.kind === 'pine');

  it('is a forest of some two thousand pines, most of them in the plot, each a solid trunk standing on the ground', () => {
    expect(land.forest.pines).toBeGreaterThan(1500);
    expect(pines.length).toBeGreaterThan(land.forest.pines);
    const inPlot = pines.filter((p) => rectContains(pinewood, p.x, p.z));
    expect(inPlot.length).toBe(land.forest.pines);
    for (const p of pines.slice(0, 400)) {
      expect(p.y).toBe(countryGround(L.country, p.x, p.z));
      const c = W.grid.colliders[W.propColliders[L.props.indexOf(p)]!]!;
      expect(c.tag).toBe('tree');
      expect(c.r).toBeCloseTo(0.3 * p.scale, 9);
      expect(c.y0).toBe(p.y);
      expect(W.isFree(p.x, p.z, 0.2)).toBe(false);
    }
  });

  it('has a dirt track from the Valley Loop up Pine Rise no steeper than a fire road, and the fire lookout tower on the highest ground in the plot', () => {
    const track = land.lanes[land.lanes.length - 1]!;
    let steepest = 0;
    for (let k = 2; k < track.pts.length; k += 2) {
      const ax = track.pts[k - 2]!;
      const az = track.pts[k - 1]!;
      const bx = track.pts[k]!;
      const bz = track.pts[k + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s + 4 <= len; s += 4) {
        const g0 = W.groundHeight(ax + ((bx - ax) * s) / len, az + ((bz - az) * s) / len);
        const g1 = W.groundHeight(ax + ((bx - ax) * (s + 4)) / len, az + ((bz - az) * (s + 4)) / len);
        steepest = Math.max(steepest, Math.abs(g1 - g0) / 4);
      }
    }
    console.log(`[lakeland] the Pinewood track climbs at most ${(steepest * 100).toFixed(1)}%`);
    expect(steepest).toBeLessThan(0.15);
    expect(W.groundHeight(track.pts[track.pts.length - 2]!, track.pts[track.pts.length - 1]!)).toBeGreaterThan(6);
    let highest = -Infinity;
    for (let x = pinewood.minX; x <= pinewood.maxX; x += 3) for (let z = pinewood.minZ; z <= pinewood.maxZ; z += 3) highest = Math.max(highest, W.groundHeight(x, z));
    expect(W.groundHeight(PINE_TOWER.x, PINE_TOWER.z)).toBeCloseTo(highest, 6);
    // The tower's four legs and its cab are solid; its feet and its middle between the legs are open ground.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) expect(W.isFree(PINE_TOWER.x + sx * PINE_TOWER.half, PINE_TOWER.z + sz * PINE_TOWER.half, 0.2)).toBe(false);
    expect(W.isFree(PINE_TOWER.x, PINE_TOWER.z, 0.3)).toBe(true);
  });

  it('adds a telescope and a plaque to the viewpoints, at the tower\'s foot', () => {
    const items = viewpoints(W).filter((it) => Math.hypot(it.x - PINE_TOWER.x, it.z - PINE_TOWER.z) < 12);
    expect(items.map((it) => it.kind).sort()).toEqual(['plaque', 'telescope']);
    for (const it of items) expect(it.y).toBeCloseTo(W.groundHeight(it.x, it.z), 9);
  });
});

describe('the valley\'s north', () => {
  const vineyard = plot('vineyard');
  const lakePlot = plot('lake');
  const scatter = mine.slice(0, mine.length - land.forest.shade).filter((p) => (p.kind === 'pine' || p.kind === 'tree') && !rectContains(plot('pinewood'), p.x, p.z));

  it('is wild country: pines and oaks scattered over it, thinning toward the lake, with boulders and wildflower patches', () => {
    expect(scatter.filter((p) => p.kind === 'pine').length).toBeGreaterThan(200);
    expect(scatter.filter((p) => p.kind === 'tree').length).toBeGreaterThan(100);
    const per = (lo: number, hi: number) => scatter.filter((p) => lakeGap(p.x, p.z) >= lo && lakeGap(p.x, p.z) < hi).length;
    // Trees per square metre of the valley's open land, by distance from the lake's water: none close in, more beyond.
    expect(per(0, 28)).toBe(0);
    expect(per(28, 90)).toBeLessThan(per(90, 200) + per(200, 600));
    expect(land.boulders.length).toBeGreaterThan(20);
    for (const b of land.boulders) expect(W.isFree(b.x, b.z, 0.2), `boulder at ${b.x.toFixed(1)}, ${b.z.toFixed(1)}`).toBe(false);
    expect(land.flowers.length).toBeGreaterThanOrEqual(15);
    expect(new Set(land.flowers.map((f) => f.hue)).size).toBe(5);
    for (const f of land.flowers) {
      expect(rectContains(vineyard, f.x, f.z, f.r), 'flowers in the vineyard').toBe(false);
      expect(rectContains(lakePlot, f.x, f.z) && lakeGap(f.x, f.z) < f.r, 'flowers in the water').toBe(false);
    }
  });

  it('has reeds only in the shallows, ducks and loons only on deep water, and every bird\'s path over the lake', () => {
    expect(land.reeds.length).toBeGreaterThan(200);
    for (const r of land.reeds) {
      expect(r.y).toBeLessThanOrEqual(-0.12);
      expect(r.y).toBeGreaterThanOrEqual(-0.9);
      expect(r.y).toBe(countryGround(L.country, r.x, r.z));
    }
    expect(new Set(land.waterfowl.map((b) => b.kind))).toEqual(new Set(['duck', 'loon']));
    for (const b of land.waterfowl) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = b.cx + Math.cos(a) * b.rx;
        const z = b.cz + Math.sin(a) * b.rz;
        // A duck dabbles in the shallows; a loon needs deep water to dive in.
        expect(W.waterDepth(x, z), `${b.kind} path at ${x.toFixed(0)}, ${z.toFixed(0)}`).toBeGreaterThan(b.kind === 'loon' ? 2 : 0.4);
      }
    }
  });
});
