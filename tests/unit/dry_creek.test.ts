// Dry Creek (world/country/places.ts): its stores inside its plot and clear of the roads, a bust out here walking out of
// the Sheriff's Office (and one in the city out of SAPD Central, as ever), people on its boardwalks crossing on its
// light, and Gas & Grits' pumps going up one after another, the doing of whoever knocked the first one down.

import { describe, expect, it, vi } from 'vitest';
import { COUNTY_PLOTS } from '../../src/world/country';
import { bustStation } from '../../src/world/country/places';
import { rectContains, rectsOverlap, type Rect } from '../../src/world/layout';
import { PUMP_CHAIN, PUMP_FUSE } from '../../src/sim/dryCreek';
import type { Character } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

const W = world();
const L = W.layout;
const plot = COUNTY_PLOTS.find((p) => p.id === 'drycreek')!.rect;
/** The places build in their three plots alone. */
const places = COUNTY_PLOTS.filter((p) => ['drycreek', 'drivein', 'track'].includes(p.id)).map((p) => p.rect);
const town = L.country.places.town;

/** Points on a 0.5 m lattice over r. */
function lattice(r: Rect): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let x = r.minX; x <= r.maxX + 1e-9; x += 0.5) for (let z = r.minZ; z <= r.maxZ + 1e-9; z += 0.5) out.push([x, z]);
  return out;
}

describe('Dry Creek: the town', () => {
  it('stands its stores and landmarks in its plot, and the places\' solids and props in theirs, clear of the roads, the verges and every older building', () => {
    // The stores by their buildings, and every building older than them (the city's, and any of the county's passes
    // before the places').
    const stores = town.stores.map((s) => L.buildings.find((b) => b.id === s.building)!);
    const others = L.buildings.filter((b) => !stores.includes(b));
    expect(stores.map((b) => b.district)).toEqual(stores.map(() => 'country'));
    expect(stores.map((s) => s.sign!.text)).toEqual(town.stores.map((s) => s.name));
    expect(town.stores.map((s) => s.name)).toEqual(expect.arrayContaining(['DRY CREEK FEED & SEED', "MOO-MOO'S DINER", 'BANG BANG GUNS & BAIT', 'GAS & GRITS', "SHERIFF'S OFFICE"]));
    const older = Math.max(...others.map((b) => b.id));
    stores.forEach((b, k) => expect(b.id).toBe(older + 1 + k));
    const solids = [...stores.flatMap((b) => b.tiers), ...L.country.places.solids.map((s) => s.rect)];
    for (const b of stores) expect(rectContains(plot, b.rect.minX, b.rect.minZ) && rectContains(plot, b.rect.maxX, b.rect.maxZ)).toBe(true);
    for (const r of solids) {
      expect(places.some((q) => rectContains(q, r.minX, r.minZ) && rectContains(q, r.maxX, r.maxZ)), JSON.stringify(r)).toBe(true);
      for (const [x, z] of lattice(r)) expect(W.isOnRoad(x, z), `${x}, ${z}`).toBe(false);
      for (const n of W.walk.nodes) expect(rectContains(r, n.x, n.z, 0.4), `walk node ${n.id} in ${JSON.stringify(r)}`).toBe(false);
    }
    for (const b of others) for (const r of solids) expect(rectsOverlap(b.rect, r)).toBe(false);
    // The places' props, from Gas & Grits' first pump on: after any older pass's, and before the roadside oddities'.
    for (const p of L.props.slice(town.pumps[0], L.country.oddities.firstProp)) {
      expect(places.some((q) => rectContains(q, p.x, p.z)), `${p.kind} at ${p.x}, ${p.z}`).toBe(true);
      expect(W.isOnRoad(p.x, p.z)).toBe(false);
    }
    // The landmark is 40 m tall; the parking bays are off the road and in the plot.
    expect(town.elevator.top).toBe(40);
    const bays = L.parking.filter((s) => rectContains(plot, s.x, s.z));
    expect(bays.length).toBeGreaterThanOrEqual(20);
    for (const s of bays) for (const dz of [-2.3, 2.3]) expect(W.isOnRoad(s.x, s.z + dz)).toBe(false);
  });

  it('busts a player in the county out of the Sheriff\'s Office, and one in the city out of SAPD Central', () => {
    const b = L.bounds;
    for (let x = b.landMinX; x <= b.beachEndX; x += 16) {
      for (let z = b.landMinZ; z <= b.landMaxZ; z += 16) expect(bustStation(L, x, z).id).toBe('police');
    }
    expect(bustStation(L, -840, -250).id).toBe('sheriff');
    expect(bustStation(L, -1300, 400).id).toBe('sheriff');
    expect(bustStation(L, -600, -268).id).toBe('sheriff');
    for (const [x, z, want] of [[-850, -240, 'sheriff'], [-300, -200, 'police']] as const) {
      const sim = makeSim({ seed: 4, police: false });
      teleport(sim, x, z);
      const slot = sim.players[0]!;
      slot.deathKind = 'busted';
      slot.deathLevel = 1;
      sim.finishRespawn(slot);
      const poi = L.pois.find((p) => p.id === want)!;
      expect(Math.hypot(sim.player.pos.x - poi.x, sim.player.pos.z - poi.z), want).toBeLessThan(13);
      expect(sim.player.heading).toBe(poi.heading);
    }
    expect(L.pois.find((p) => p.id === 'sheriff')!.kind).toBe('police');
    expect(makeSim().interactions.markers.some((m) => m.id === 'guns_county' && m.kind === 'gunshop')).toBe(true);
  });
});

describe('Dry Creek: its people', () => {
  it('spawns them on its boardwalks only, keeps the city\'s walking edges, and crosses all four arms on its light', () => {
    const walk = W.walk;
    expect(walk.walkEdges.length).toBe(432);
    expect(walk.countyWalkEdges.length).toBeGreaterThan(8);
    for (const [a, b] of walk.countyWalkEdges) for (const n of [walk.nodes[a]!, walk.nodes[b]!]) expect(rectContains(plot, n.x, n.z)).toBe(true);
    const dc = W.roads.junction('drycreek');
    const crossings = walk.nodes.flatMap((n) => n.edges.filter((e) => e.crosswalk && e.roadNode === dc.id).map((e) => [n.id, e.to].sort((p, q) => p - q).join('-')));
    expect(new Set(crossings).size).toBe(4);
    // Every boardwalk joins the verges: from any of them a pedestrian can walk to any other.
    const seen = new Set<number>([walk.countyWalkEdges[0]![0]]);
    const queue = [...seen];
    while (queue.length > 0) {
      for (const e of walk.nodes[queue.pop()!]!.edges) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
    for (const [a] of walk.countyWalkEdges) expect(seen.has(a)).toBe(true);

    const sim = makeSim({ seed: 7, ambient: true, police: false });
    teleport(sim, -840, -268);
    step(sim, 6);
    const peds = sim.characters.filter((c) => c.owner === 'ped' && !c.removed);
    expect(peds.length).toBeGreaterThan(4);
    for (const c of peds) expect(rectContains(plot, c.pos.x, c.pos.z, 4), `${c.pos.x}, ${c.pos.z}`).toBe(true);
  });
});

describe('Dry Creek: Gas & Grits', () => {
  it('goes up when a car rams a pump, one pump after another, and leaves fire under the canopy', () => {
    const sim = makeSim({ seed: 9, police: false });
    const blasts: Array<{ x: number; z: number; t: number }> = [];
    const fires: number[] = [];
    sim.events.on('explosion', (e) => blasts.push({ x: e.x, z: e.z, t: sim.time }));
    sim.events.on('fireStarted', () => fires.push(sim.time));
    const pump = L.props[town.pumps[0]!]!;
    // From the west, along the lane beside the island.
    const car = sim.spawnVehicle('sedan', pump.x - 9, pump.z, Math.PI / 2);
    placeInCar(sim, car);
    car.vel.x = 12;
    const broken = (i: number) => sim.world.grid.colliders[sim.world.propColliders[i]!]!.broken;
    step(sim, 0.8, input({ throttle: 1 }));
    expect(broken(town.pumps[0]!)).toBe(true);
    step(sim, 3);
    // A blast at each pump (the car may go up too), PUMP_CHAIN s apart, and fire under the canopy.
    const at = town.pumps.map((i) => blasts.find((b) => Math.hypot(b.x - L.props[i]!.x, b.z - L.props[i]!.z) < 0.01)?.t ?? -1).sort((p, q) => p - q);
    expect(at[0]).toBeGreaterThanOrEqual(PUMP_FUSE);
    for (let k = 1; k < at.length; k++) expect(at[k]! - at[k - 1]!).toBeGreaterThanOrEqual(PUMP_CHAIN - 1e-6);
    for (const i of town.pumps) expect(broken(i)).toBe(true);
    expect(fires.length).toBeGreaterThanOrEqual(4);
  });

  it('blames whoever knocked the first pump down, never the player who only stands nearest', () => {
    const pump = L.props[town.pumps[0]!]!;
    /** The owners of the pumps' blasts over the next 3 s. */
    const blasts = (sim: Sim): Array<Character | null> => {
      const spy = vi.spyOn(sim.combat, 'explosion');
      step(sim, 3);
      const owners = spy.mock.calls.filter(([x, , z]) => town.pumps.some((i) => L.props[i]!.x === x && L.props[i]!.z === z)).map((c) => c[5]);
      expect(owners).toHaveLength(town.pumps.length);
      return owners;
    };
    // The player driving into it: his blasts, his stars.
    const rammed = makeSim({ seed: 9 });
    const car = rammed.spawnVehicle('sedan', pump.x - 9, pump.z, Math.PI / 2);
    placeInCar(rammed, car);
    car.vel.x = 12;
    expect(new Set(blasts(rammed))).toEqual(new Set([rammed.player]));
    expect(rammed.wanted.level).toBeGreaterThan(0);
    // An empty car sent into it, the player 30 m off on foot: nobody's blasts, no star.
    const empty = makeSim({ seed: 9 });
    teleport(empty, pump.x - 30, pump.z);
    empty.spawnVehicle('sedan', pump.x - 9, pump.z, Math.PI / 2).vel.x = 14;
    expect(new Set(blasts(empty))).toEqual(new Set([null]));
    expect(empty.wanted.level).toBe(0);
    // In multiplayer, the owner of the blast that knocked it down, not the other player standing nearer the pumps.
    const mp = makeSim({ seed: 9, multiplayer: true });
    const a = mp.players[0]!;
    teleport(mp, pump.x - 35, pump.z);
    const b = mp.addPlayer(-770, -265);
    step(mp, 0.1);
    mp.combat.explosion(pump.x - 3, pump.y + 0.5, pump.z, 5, 50, a.character, null);
    expect(new Set(blasts(mp))).toEqual(new Set([a.character]));
    expect(b.wanted.level).toBe(0);
    expect(a.wanted.level).toBeGreaterThan(0);
  });
});
