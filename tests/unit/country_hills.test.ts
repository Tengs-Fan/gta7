// Las Lomas County's landscape (world/country/hills.ts): Coyote Ridge and the foothills stay off every road, plot and
// verge, the fire road climbs no steeper than 18% up a shoulder no steeper than 21%, the ridge's sight cores stay buried,
// the ridge hides what lies behind it and nothing more, cars and people climb it, its turbines are solid, and every
// collider the county had before keeps its box, band and tag.

import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { CountryView } from '../../src/render/country';
import { reflectorPosts } from '../../src/render/country/reflectors';
import { LightSprites } from '../../src/render/lightSprites';
import { Sim } from '../../src/sim/sim';
import { COP_SIGHT } from '../../src/sim/wanted';
import { WATER_Y } from '../../src/world/constants';
import { COUNTRY_ROADS, COUNTY_PLOTS, countryGround, plotAt } from '../../src/world/country';
import { countyCores, FIRE_ROAD, FIRE_ROAD_W, fireRoadLine, LOOKOUT, ridgeRise } from '../../src/world/country/hills';
import { PARAPET_H, rectContains } from '../../src/world/layout';
import { CORE_COVER, CORE_INSET, riseAt } from '../../src/world/terrain';
import { freshWorld, input, placeInCar, world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

const W = world();
const L = W.layout;
const country = L.country;
const rises = country.rises;
const ridge = ridgeRise(rises);
const DT = 1 / 60;
const rise = (x: number, z: number) => riseAt(rises, x, z);
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** The props' wind for a CountryView, still (the farms' corn sways on it). */
const wind = { uWindTime: { value: 0 }, uWindAmp: { value: 0 }, uWindDir: { value: new THREE.Vector2(1, 0) } };

/**
 * What the county had before the landscape: 4605 colliders in all, and the props up to its first. Re-recorded on the
 * integrated county head, where its traffic made the Hollister T's and the Creek T's signal heads a stop sign and two
 * lamps each (the same count, after which the landscape and the farms append theirs).
 */
const COLLIDERS = 4605;

/** Every county road's centre line as segments, with its half width. */
const segments = COUNTRY_ROADS.flatMap((r) => {
  const out: Array<[number, number, number, number, number]> = [];
  for (let k = 2; k < r.pts.length; k += 2) out.push([r.pts[k - 2]!, r.pts[k - 1]!, r.pts[k]!, r.pts[k + 1]!, r.width / 2]);
  return out;
});

/** How far (m) (x, z) lies outside the nearest county road's edge. */
function offRoad(x: number, z: number): number {
  let best = Infinity;
  for (const [ax, az, bx, bz, half] of segments) {
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t) - half);
  }
  return best;
}

describe('the landscape keeps off everything that assumes flat ground', () => {
  it('is a 24 m ridge along the west coast and five foothills of 4 to 12 m', () => {
    expect(rises.map((r) => r.kind)).toEqual(['ridge', 'bell', 'bell', 'bell', 'bell', 'bell']);
    expect(L.rises.map((r) => r.name)).toEqual(['Hillcrest Green', 'Azura Point']);
    expect(rise(ridge.cx, -300)).toBe(24);
    for (const r of rises.slice(1)) {
      expect(r.height).toBeGreaterThanOrEqual(4);
      expect(r.height).toBeLessThanOrEqual(12);
    }
    // No two overlap, so a ray tested against each in turn meets the ground they make.
    for (const [i, a] of rises.entries()) for (const b of rises.slice(i + 1)) expect(a.bounds.maxX <= b.bounds.minX || b.bounds.maxX <= a.bounds.minX || a.bounds.maxZ <= b.bounds.minZ || b.bounds.maxZ <= a.bounds.minZ, `${a.name} and ${b.name}`).toBe(true);
  });

  it('is 0 within 12 m of every road edge, on every plot but the wild ones and at every verge node, on a 1 m lattice', () => {
    let lifted = 0;
    for (const r of rises) {
      const b = r.bounds;
      for (let x = Math.floor(b.minX); x <= b.maxX; x += 1) {
        for (let z = Math.floor(b.minZ); z <= b.maxZ; z += 1) {
          if (rise(x, z) === 0) continue;
          lifted++;
          const off = offRoad(x, z);
          if (off < 12) expect.fail(`${r.name} ${rise(x, z).toFixed(3)} m at ${x}, ${z}, ${off.toFixed(1)} m off a road`);
          const plot = COUNTY_PLOTS.find((p) => p.kind !== 'wild' && rectContains(p.rect, x, z));
          if (plot) expect.fail(`${r.name} on ${plot.name} at ${x}, ${z}`);
        }
      }
    }
    expect(lifted).toBeGreaterThan(150_000);
    const verges = W.walk.nodes.filter((n) => n.x < L.bounds.landMinX);
    expect(verges.length).toBeGreaterThan(100);
    for (const n of verges) expect(rise(n.x, n.z), `verge node ${n.id}`).toBe(0);
  });

  it('keeps every collider the county had before, and its props, appending the ridge\'s', () => {
    const rows = W.grid.colliders.slice(0, COLLIDERS).map((c) => [c.id, c.circle, c.minX, c.minZ, c.maxX, c.maxZ, c.cx, c.cz, c.r, c.y0, c.y1, c.tag, c.breakable, c.propIndex]);
    expect(sha(rows)).toBe('2aeae4f3892af32178650ec7814f28a94a7f0b2486351722d6a1922203709d85');
    const turbines = L.props.filter((p) => p.kind === 'turbine' && p.x < L.bounds.landMinX);
    expect(turbines.length).toBe(6);
    expect(L.props.indexOf(turbines[0]!)).toBeGreaterThanOrEqual(country.firstProp);
    expect(L.openSpots.every((s) => s.x > L.bounds.landMinX - 200)).toBe(true);
  });

  it('stands every county prop on the ground', () => {
    for (const p of L.props.slice(country.firstProp)) expect(p.y, `${p.kind} at ${p.x}, ${p.z}`).toBeCloseTo(W.baseGround(p.x, p.z), 9);
    const lifted = L.props.slice(country.firstProp).filter((p) => p.y > 1);
    expect(lifted.length).toBeGreaterThan(20);
    for (const p of lifted) expect(p.y).toBe(countryGround(country, p.x, p.z));
  });
});

describe('Coyote Ridge', () => {
  it('climbs no steeper than 35% from the beach, 33% from the highway, 34.3% up its north end and 14% up its south shoulder, and its crest is flat across', () => {
    let east = 0;
    let west = 0;
    for (let x = ridge.bounds.minX; x < ridge.bounds.maxX; x += 1) {
      const g = rise(x + 1, -300) - rise(x, -300);
      if (x > ridge.cx) east = Math.max(east, -g);
      else west = Math.max(west, g);
    }
    expect(east).toBeLessThanOrEqual(0.33);
    expect(west).toBeLessThanOrEqual(0.35);
    expect(east).toBeGreaterThan(0.3);
    // Along the crest's line, from the north shore up its north end and down the south shoulder the fire road climbs.
    let north = 0;
    let south = 0;
    for (let z = ridge.bounds.minZ; z < ridge.bounds.maxZ; z += 1) {
      const g = rise(ridge.cx, z + 1) - rise(ridge.cx, z);
      if (z < ridge.cz) north = Math.max(north, g);
      else south = Math.max(south, -g);
    }
    expect(north).toBeLessThanOrEqual(0.343);
    expect(south).toBeLessThanOrEqual(0.14);
    expect(ridge.bounds.minZ).toBe(-580);
    for (let z = ridge.cz - ridge.rz; z <= ridge.cz + ridge.rz; z += 10) for (let x = ridge.cx - ridge.plateau; x <= ridge.cx + ridge.plateau; x += 2) expect(rise(x, z)).toBe(24);
  });

  it('carries the fire road up no steeper than 18%, on a shoulder no steeper than 21% under it', () => {
    const line = fireRoadLine(1);
    expect(line[0]).toMatchObject({ x: FIRE_ROAD[0]![0], z: FIRE_ROAD[0]![1] });
    expect(line[line.length - 1]).toMatchObject({ x: FIRE_ROAD[FIRE_ROAD.length - 1]![0], z: FIRE_ROAD[FIRE_ROAD.length - 1]![1] });
    let grade = 0;
    let shoulder = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      expect(b.s - a.s).toBeLessThanOrEqual(1.0001);
      grade = Math.max(grade, Math.abs(W.groundHeight(b.x, b.z) - W.groundHeight(a.x, a.z)) / (b.s - a.s));
      // Across the road too: the slope of the ground under its whole width.
      for (const o of [-FIRE_ROAD_W / 2, 0, FIRE_ROAD_W / 2]) {
        const x = b.x + Math.cos(b.heading) * o;
        const z = b.z - Math.sin(b.heading) * o;
        shoulder = Math.max(shoulder, Math.hypot(rise(x + 0.5, z) - rise(x - 0.5, z), rise(x, z + 0.5) - rise(x, z - 0.5)));
      }
    }
    console.log(`[country_hills] fire road ${line[line.length - 1]!.s.toFixed(0)} m, steepest ${(grade * 100).toFixed(1)}%, shoulder ${(shoulder * 100).toFixed(1)}%`);
    expect(grade).toBeLessThanOrEqual(0.18);
    expect(shoulder).toBeLessThanOrEqual(0.21);
    // It starts at the highway's edge and ends on the car park, 24 m up and flat.
    expect(W.groundHeight(line[0]!.x, line[0]!.z)).toBe(0);
    const end = line[line.length - 1]!;
    expect(rectContains(LOOKOUT.pad, end.x, end.z)).toBe(true);
    for (let x = LOOKOUT.pad.minX; x <= LOOKOUT.pad.maxX; x += 1) for (let z = LOOKOUT.pad.minZ; z <= LOOKOUT.pad.maxZ; z += 1) expect(W.groundHeight(x, z)).toBe(24);
  });

  it('stands six turbines along its top 110 m apart and 40 m from Lookout Point, four on the crest and two down the south shoulder, each solid', () => {
    const turbines = L.props.filter((p) => p.kind === 'turbine' && p.x < L.bounds.landMinX);
    // The first 3 m off the crest's north end; the last two past Lookout Point, which the crest has no room for.
    expect(turbines.map((t) => Number(t.y.toFixed(1)))).toEqual([24, 24, 24, 24, 22.2, 9]);
    for (const t of turbines.slice(4)) expect(t.z).toBeGreaterThan(ridge.cz + ridge.rz);
    for (const [i, t] of turbines.entries()) {
      expect(Math.abs(t.x - ridge.cx)).toBeLessThan(ridge.plateau);
      expect(Math.hypot(t.x - LOOKOUT.tower.x, t.z - LOOKOUT.tower.z)).toBeGreaterThanOrEqual(40);
      expect(Math.hypot(t.x - LOOKOUT.plaque.x, t.z - LOOKOUT.plaque.z)).toBeGreaterThanOrEqual(40);
      for (const u of turbines.slice(i + 1)) expect(Math.hypot(t.x - u.x, t.z - u.z)).toBeGreaterThanOrEqual(110);
      // Clear of the fire road by its half width and a metre more.
      for (const p of fireRoadLine(1)) expect(Math.hypot(p.x - t.x, p.z - t.z)).toBeGreaterThan(FIRE_ROAD_W / 2 + 2.6 + 1);
      // The tower from its foundation up past the nacelle.
      const c = W.grid.colliders[W.propColliders[L.props.indexOf(t)]!]!;
      expect([c.tag, c.y0, c.y1]).toEqual(['pillar', t.y - 1, t.y + 72]);
    }
    expect(turbines.length).toBe(6);
  });

  it('a turbine stops a car', () => {
    const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
    const t = sim.world.layout.props.find((p) => p.kind === 'turbine' && p.x < -1000 && p.z === -253)!;
    const v = sim.spawnVehicle('sedan', t.x, t.z + 30, Math.PI);
    placeInCar(sim, v);
    for (let i = 0; i < Math.round(6 / DT); i++) sim.update(DT, input({ throttle: 1 }));
    expect(v.pos.z).toBeGreaterThan(t.z + 2.6 + v.halfW);
    expect(Math.abs(v.pos.x - t.x)).toBeLessThan(4);
  });
});

describe('the sight cores', () => {
  const cores = countyCores(country);

  it('a 24 m ridge gets twelve, each CORE_COVER under the ground over its footprint grown by CORE_INSET', () => {
    expect(cores.filter((c) => rectContains(ridge.bounds, (c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2)).length).toBe(12);
    for (const c of cores) {
      for (let x = c.minX - CORE_INSET; x <= c.maxX + CORE_INSET + 1e-9; x += 1) {
        for (let z = c.minZ - CORE_INSET; z <= c.maxZ + CORE_INSET + 1e-9; z += 1) {
          const cover = W.groundHeight(x, z) - c.y1;
          if (cover < CORE_COVER - 1e-9) expect.fail(`core to ${c.y1} at ${x}, ${z}: ${cover.toFixed(3)} m under`);
        }
      }
    }
    // The grid holds them, solid for sight, after every other collider of the county's.
    expect(W.grid.colliders.filter((c) => c.tag === 'terrain' && c.minX < -700).map((c) => [c.minX, c.minZ, c.maxX, c.maxZ, c.y1])).toEqual(cores.map((c) => [c.minX, c.minZ, c.maxX, c.maxZ, c.y1]));
  });
});

describe('sight and shots across the ridge', () => {
  /** How far (m) the segment runs over the county's ground at its lowest, sampled every 0.25 m; Infinity off the rises. */
  const clearance = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25));
    let low = Infinity;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      if (rise(x, z) > 0) low = Math.min(low, ay + (by - ay) * t - W.groundHeight(x, z));
    }
    return low;
  };

  it('every line of sight within police range that the ridge hides is blocked, and none that it leaves clear', () => {
    // Officers on foot and the player anywhere across the ridge's middle, within COP_SIGHT: eyes 1.6 m and chest 1.2 m up,
    // and out over the water the west flank runs down into, a swimmer's head WATER_Y + 0.4.
    const spots: Array<[number, number]> = [];
    for (let x = -1600; x <= -1345; x += 9) for (let z = -330; z <= -230; z += 11) spots.push([x, z]);
    const up = (x: number, z: number, h: number) => (W.groundHeight(x, z) < WATER_Y ? WATER_Y + 0.4 : W.groundHeight(x, z) + h);
    expect(spots.filter(([x, z]) => W.groundHeight(x, z) < WATER_Y).length).toBeGreaterThan(20);
    let hidden = 0;
    let open = 0;
    const wrong: string[] = [];
    for (const [ax, az] of spots) {
      for (const [bx, bz] of spots) {
        if ((ax === bx && az === bz) || Math.hypot(bx - ax, bz - az) > COP_SIGHT) continue;
        const ay = up(ax, az, 1.6);
        const by = up(bx, bz, 1.2);
        const c = clearance(ax, ay, az, bx, by, bz);
        const seen = W.lineOfSight(ax, ay, az, bx, by, bz);
        if (c < -0.02) {
          hidden++;
          if (seen) wrong.push(`seen through the ridge: ${ax}, ${az} to ${bx}, ${bz}`);
        } else if (c > 0.02 && W.grid.lineOfSight(ax, ay, az, bx, by, bz, W.scratchHit)) {
          open++;
          if (!seen) wrong.push(`blocked over the ridge: ${ax}, ${az} to ${bx}, ${bz}`);
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(hidden).toBeGreaterThan(1000);
    expect(open).toBeGreaterThan(1000);
  });

  it('is blocked across the ridge at 1.6 m and clear over the crest', () => {
    for (let z = -450; z <= 0; z += 50) {
      const e = W.groundHeight(-1352, z) + 1.6;
      const w = W.groundHeight(-1556, z) + 1.6;
      expect(W.lineOfSight(-1352, e, z, -1556, w, z), `across at z ${z}`).toBe(false);
      expect(W.grid.lineOfSight(-1352, e, z, -1556, w, z, W.scratchHit), `the cores across at z ${z}`).toBe(false);
      // The crest's east half, the fire road's side of the turbines.
      expect(W.lineOfSight(ridge.cx, 25.6, z, ridge.cx + 9, 25.6, z + 10), `on the crest at z ${z}`).toBe(true);
    }
    // From Lookout Point's parapet down over the county towards the city.
    const top = 24 + PARAPET_H + 0.6;
    expect(W.lineOfSight(LOOKOUT.parapet.maxX + 0.5, top, -102, -900, 1.6, -150)).toBe(true);
  });

  it('a shot into the flank stops on the turf, and one fired down it flies on to what it is aimed at', () => {
    const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
    const r = sim.combat.castRay(-1345, 1.4, -300, -1, 0, 0, 250, null);
    expect(r.kind).toBe('world');
    expect(sim.world.groundHeight(-1345 - r.t, -300)).toBeCloseTo(1.4, 2);
    // From halfway down, where the flank turns concave, at a man's chest further down: nothing stops the shot short of him.
    for (const [sx, tx] of [[ridge.cx + 40, ridge.cx + 110], [ridge.cx + 60, ridge.cx + 115]] as const) {
      const oy = sim.world.groundHeight(sx, -300) + 1.4;
      const ty = sim.world.groundHeight(tx, -300) + 1.2;
      const d = Math.hypot(tx - sx, ty - oy);
      expect(clearance(sx, oy, -300, tx, ty, -300)).toBeGreaterThan(0.3);
      expect(sim.combat.castRay(sx, oy, -300, (tx - sx) / d, (ty - oy) / d, 0, 150, null).t, `from ${sx}`).toBeGreaterThan(d);
    }
    // From the west beach at a swimmer's head off it, over the water the flank runs on into; and level along the water
    // from out at sea towards the beach, on to the sand.
    const bx = -1561;
    const by = sim.world.groundHeight(bx, -282) + 1.4;
    for (const tx of [-1582, -1591]) {
      expect(sim.world.groundHeight(tx, -282)).toBeLessThan(WATER_Y);
      const ty = WATER_Y + 0.4;
      const d = Math.hypot(tx - bx, ty - by);
      expect(clearance(bx, by, -282, tx, ty, -282)).toBeGreaterThan(0.3);
      expect(sim.combat.castRay(bx, by, -282, (tx - bx) / d, (ty - by) / d, 0, 60, null).t, `at ${tx}`).toBeGreaterThan(d);
    }
    const sea = sim.combat.castRay(-1640, WATER_Y + 0.6, -282, 1, 0, 0, 100, null);
    expect(sim.world.groundHeight(-1640 + sea.t, -282)).toBeCloseTo(WATER_Y + 0.6, 2);
  });
});

describe('on the ridge', () => {
  it('a Nightjar climbs the east flank at 25 m/s without leaving the ground or being stopped', () => {
    const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
    // From just inside the tree belts along its foot.
    const v = sim.spawnVehicle('sports', -1373, -320, -Math.PI / 2);
    placeInCar(sim, v);
    let top = -Infinity;
    for (let i = 0; i < Math.round(8 / DT) && v.pos.x > ridge.cx; i++) {
      v.vel.x = -25;
      v.vel.z = 0;
      v.heading = -Math.PI / 2;
      v.angVel = 0;
      sim.update(DT, input());
      expect(v.airborne, `airborne at x ${v.pos.x.toFixed(1)}`).toBe(false);
      expect(v.pos.y).toBeCloseTo(sim.world.groundHeight(v.pos.x, v.pos.z), 2);
      top = Math.max(top, v.pos.y);
    }
    expect(v.pos.x).toBeLessThanOrEqual(ridge.cx);
    expect(top).toBe(24);
  });

  it('a Nightjar at 45 or 60 m/s drives up the north end from the shore to the crest without being stopped', () => {
    for (const speed of [45, 60]) {
      const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
      // On the crest's east half, clear of the turbines.
      const v = sim.spawnVehicle('sports', ridge.cx + 4, ridge.bounds.minZ + 8, 0);
      placeInCar(sim, v);
      v.vel.z = speed;
      let slow = Infinity;
      for (let i = 0; i < Math.round(3 / DT) && v.pos.z < ridge.cz - ridge.rz; i++) {
        sim.update(DT, input({ throttle: 1 }));
        slow = Math.min(slow, v.speed);
      }
      expect(v.pos.z, `at ${speed} m/s`).toBeGreaterThanOrEqual(ridge.cz - ridge.rz);
      expect(v.pos.y).toBeCloseTo(24, 1);
      expect(slow).toBeGreaterThan(speed * 0.9);
      expect(v.health).toBe(v.spec.health);
    }
  });

  it('a man walks up the east flank to the crest', () => {
    const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
    const p = sim.player;
    p.pos.x = -1352;
    p.pos.z = -330;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    for (let i = 0; i < Math.round(60 / DT) && p.pos.x > ridge.cx + 5; i++) sim.update(DT, input({ moveZ: 1, cameraYaw: -Math.PI / 2 }));
    expect(p.pos.x).toBeLessThanOrEqual(ridge.cx + 5);
    expect(p.pos.y).toBeCloseTo(24, 3);
    expect(p.health).toBe(p.maxHealth);
  });
});

describe('drawing the fire road and Lookout Point', () => {
  const view = new CountryView(W, new CityView(W), wind);
  const mesh = (name: string) => view.group.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name === name)!;

  it('drapes the gravel just over the ground the cars drive on, from the highway to the car park', () => {
    const pos = mesh('fire-road').geometry.getAttribute('position');
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const d = pos.getY(i) - W.groundHeight(pos.getX(i), pos.getZ(i));
      low = Math.min(low, d);
      high = Math.max(high, d);
    }
    expect(low).toBeGreaterThan(0.04);
    expect(high).toBeLessThan(0.06);
    const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
    expect(box.max.x).toBeCloseTo(FIRE_ROAD[0]![0], 0);
    expect(box.min.z).toBeCloseTo(LOOKOUT.pad.minZ, 3);
  });

  it('draws the ground near on the sim\'s own heights and far on a 16 m lattice whose skirts cover what it misses at the edges', () => {
    const meshes = view.group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    const tris = (name: string) => meshes.filter((m) => m.name === name).reduce((n, m) => n + m.geometry.index!.count / 3, 0);
    console.log(`[country_hills] ground: near ${tris('country-grass') + tris('country-sand')} triangles, far ${tris('country-grass-far') + tris('country-sand-far')}`);
    expect(tris('country-grass-far') + tris('country-sand-far')).toBeLessThan((tris('country-grass') + tris('country-sand')) / 8);
    let skirts = 0;
    for (const m of meshes.filter((q) => q.name.startsWith('country-grass') || q.name.startsWith('country-sand'))) {
      const pos = m.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        // The causeway's verge ends on the promenade's edge, a kerb higher.
        if (pos.getX(i) >= L.bounds.landMinX) continue;
        const d = pos.getY(i) - W.baseGround(pos.getX(i), pos.getZ(i));
        if (Math.abs(d) > 1e-4) {
          expect(d, `${m.name} at ${pos.getX(i)}, ${pos.getZ(i)}`).toBeCloseTo(-2, 4);
          skirts++;
        }
      }
    }
    expect(skirts).toBeGreaterThan(100);
    // Along a cell's edge across the ridge, the far mesh's chords between its 16 m vertices stay within the skirt of the ground.
    let worst = 0;
    for (let z = -560; z < 180; z += 16) {
      const a = W.baseGround(-1536, z);
      const b = W.baseGround(-1536, z + 16);
      for (let t = 0; t <= 16; t += 1) worst = Math.max(worst, Math.abs(a + ((b - a) * t) / 16 - W.baseGround(-1536, z + t)));
    }
    for (let x = -1590; x < -1350; x += 16) {
      const a = W.baseGround(x, -256);
      const b = W.baseGround(x + 16, -256);
      for (let t = 0; t <= 16; t += 1) worst = Math.max(worst, Math.abs(a + ((b - a) * t) / 16 - W.baseGround(x + t, -256)));
    }
    expect(worst).toBeGreaterThan(0.05);
    expect(worst).toBeLessThan(1);
  });

  it('stands the parapet and the tower where the sim makes them solid, on the crest', () => {
    const parapet = new THREE.Box3().setFromObject(mesh('lookout-parapet'));
    const solid = W.grid.colliders.find((c) => c.tag === 'wall' && c.minX === LOOKOUT.parapet.minX && c.minZ === LOOKOUT.parapet.minZ)!;
    const drawn = [parapet.min.x, parapet.min.z, parapet.max.x, parapet.max.z, parapet.min.y, parapet.max.y];
    [solid.minX, solid.minZ, solid.maxX, solid.maxZ, solid.y0, solid.y1].forEach((v, i) => expect(drawn[i]).toBeCloseTo(v, 4));
    const tower = new THREE.Box3().setFromObject(mesh('fire-lookout'));
    expect(tower.min.y).toBeCloseTo(24, 6);
    expect(tower.max.y).toBeGreaterThan(24 + LOOKOUT.tower.top);
    const posts = W.grid.colliders.filter((c) => c.tag === 'pillar' && Math.abs(c.cx - LOOKOUT.tower.x) <= LOOKOUT.tower.half && Math.abs(c.cz - LOOKOUT.tower.z) <= LOOKOUT.tower.half);
    expect(posts.length).toBe(4);
    for (const c of posts) expect(tower.containsPoint(new THREE.Vector3(c.cx, c.y1 - 0.5, c.cz))).toBe(true);
    expect(mesh('fire-lookout').castShadow).toBe(true);
  });
});

describe('reflector posts', () => {
  it('stand every 25 m along both edges of the county\'s roads on its land, off the carriageway, clear of the junctions and of Dry Creek', () => {
    const posts = reflectorPosts(W);
    expect(posts.length).toBeGreaterThan(180);
    for (const p of posts) {
      expect(plotAt(country, p.x, p.z)?.kind).not.toBe('town');
      expect(p.x).toBeLessThan(L.bounds.landMinX);
      const off = offRoad(p.x, p.z);
      expect(off, `post at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`).toBeGreaterThan(1);
      expect(off).toBeLessThan(2);
      expect(p.y).toBe(W.groundHeight(p.x, p.z));
      expect(W.roads.isOnRoad(p.x, p.z)).toBe(false);
    }
  });

  it('shine back only at a lit car whose headlights fall on them', () => {
    const view = new CountryView(W, new CityView(W), wind);
    const ls = new LightSprites();
    const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
    // Northbound up the Lomas Highway's west leg: the posts ahead light up, those behind stay dark.
    const car = sim.spawnVehicle('sedan', -1330, 100, Math.PI);
    ls.begin(new THREE.Vector3(-1330, 4, 108), 800);
    view.reflectors.glow(ls, car, 1);
    const lit = ls.counts.glows;
    expect(lit).toBeGreaterThan(3);
    const pos = ls.glows.geometry.getAttribute('position');
    for (let i = 0; i < lit; i++) expect(pos.getZ(i)).toBeLessThan(100);
    ls.begin(new THREE.Vector3(-1330, 4, 108), 800);
    view.reflectors.glow(ls, null, 1);
    expect(ls.counts.glows).toBe(0);
    expect(view.reflectors.count).toBe(reflectorPosts(W).length);
  });
});
