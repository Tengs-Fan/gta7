// Las Lomas Valley's farms (world/country/valley.ts, render/country/valley.ts, vines.ts, ranch.ts, livestock.ts): where
// everything stands (south of the Pass Road and out of the pass's plot, off every lane and junction mouth), the vineyard's
// rows level along the rise's contours with the winery on its crest, the ranch's horses in their paddocks and its
// sheep, which run from a car or a person within reach and walk back together, the string lights that shine only
// after dark, and the valley's oaks and bushes as one batch each.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Rng } from '../../src/core/rng';
import { CityView } from '../../src/render/city';
import { CountryView } from '../../src/render/country';
import { Flock, HORSE_WALK, makeHorse, SCARE_PERSON, SCARE_PER_SPEED, scareRadius, SHEEP_RUN, stepHorse } from '../../src/render/country/livestock';
import { PropsView } from '../../src/render/props';
import { HARDWARE_CHUNK_SIZE } from '../../src/render/spatial';
import type { ViewState } from '../../src/sim/viewState';
import { COUNTY_PLOTS, countryGround, plotAt } from '../../src/world/country';
import { VINE_ROWS, VINE_SEG, VALLEY_FARMS_FROM } from '../../src/world/country/valley';
import { mkRect, rectContains, rectsOverlap, type Rect } from '../../src/world/layout';
import { rectClearance, roadClearance } from './farm_helpers';
import { world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

const W = world();
const L = W.layout;
const v = L.country.valley;
const wind = { uWindTime: { value: 0 }, uWindAmp: { value: 0.05 }, uWindDir: { value: new THREE.Vector2(1, 0) } };
const plot = (id: string): Rect => COUNTY_PLOTS.find((p) => p.id === id)!.rect;
const mine = L.props.slice(v.firstProp);

const asRect = (i: number): Rect => {
  const c = W.grid.colliders[W.propColliders[i]!]!;
  return c.circle ? mkRect(c.cx - c.r, c.cz - c.r, c.cx + c.r, c.cz + c.r) : c;
};

describe('the valley\'s farms: where everything stands', () => {
  it('keeps south of the Pass Road and out of the pass\'s plot, on land, off every lane and junction mouth', () => {
    expect(mine.length).toBeGreaterThan(300);
    for (const p of mine) {
      expect(p.z, p.kind).toBeGreaterThanOrEqual(VALLEY_FARMS_FROM);
      expect(plotAt(L.country, p.x, p.z)?.id ?? '', `${p.kind} at ${p.x}, ${p.z}`).not.toBe('pass');
      expect(countryGround(L.country, p.x, p.z), p.kind).toBeGreaterThanOrEqual(0);
      expect(W.isOnRoad(p.x, p.z), p.kind).toBe(false);
    }
    const solids: Array<[string, Rect]> = [
      ...v.solids.map((s): [string, Rect] => [s.tag, s.rect]),
      ...v.hedges.map((h): [string, Rect] => ['hedge', h]),
      ...v.drives.map((d): [string, Rect] => ['drive', d]),
      ['house', v.ranch.houseRect],
      ['barn', v.ranch.barn],
      ['winery', v.vineyard.winery.hall],
    ];
    const pass = plot('pass');
    for (const [what, r] of solids) {
      expect(r.minZ, what).toBeGreaterThanOrEqual(VALLEY_FARMS_FROM);
      expect(rectsOverlap(r, pass), what).toBe(false);
      // A drive begins at a road's edge; everything else keeps 8 m or more off it.
      if (what !== 'drive') expect(rectClearance(r), what).toBeGreaterThanOrEqual(8);
    }
    // Props with colliders (fences, the windpump, pumpkins, oaks), and the buildings, 8 m and more off the edge; the buildings 12.
    mine.forEach((p, k) => {
      if (p.kind !== 'bush') expect(rectClearance(asRect(v.firstProp + k)), `${p.kind} ${v.firstProp + k}`).toBeGreaterThanOrEqual(8);
    });
    for (const r of [v.ranch.houseRect, v.ranch.barn, v.vineyard.winery.hall]) expect(rectClearance(r)).toBeGreaterThanOrEqual(12);
    // The drives open at the road's edge, and no reflector post stands in them.
    for (const d of v.drives) expect(Math.min(roadClearance(d.minX, (d.minZ + d.maxZ) / 2), roadClearance(d.maxX, (d.minZ + d.maxZ) / 2))).toBeLessThan(0.6);
  });

  it('stands the ranch\'s house and barn in the yard, the barn open on it, and the winery on the rise\'s flat crest', () => {
    const r = v.ranch;
    for (const rect of [r.houseRect, r.barn]) expect(rectContains(r.yard, rect.minX, rect.minZ) && rectContains(r.yard, rect.maxX, rect.maxZ)).toBe(true);
    const barn = L.garages.find((g) => g.poi === 'ranch_barn')!;
    expect([barn.rect, barn.side]).toEqual([r.barn, 'W']);
    expect(rectContains(r.yard, r.barn.minX - 2, (r.barn.minZ + r.barn.maxZ) / 2)).toBe(true);
    expect(W.coverAt((r.barn.minX + r.barn.maxX) / 2, (r.barn.minZ + r.barn.maxZ) / 2)).toBe(true);
    const house = L.buildings.find((b) => b.id === r.house)!;
    expect([house.style, house.district, house.rect]).toEqual(['house', 'country', r.houseRect]);
    const w = v.vineyard.winery;
    const winery = L.buildings.find((b) => b.id === w.building)!;
    expect([winery.district, winery.rect]).toEqual(['country', w.hall]);
    // The crest is flat to a few centimetres across the hall and its porch, which looks east to the loop.
    for (const [x, z] of [[w.hall.minX, w.hall.minZ], [w.hall.maxX, w.hall.maxZ], [w.porch.maxX, w.porch.minZ], [w.porch.maxX, w.porch.maxZ]] as const) expect(Math.abs(countryGround(L.country, x, z) - w.y)).toBeLessThan(0.1);
    expect(w.y).toBeGreaterThan(6.9);
    expect(w.porch.minX).toBe(w.hall.maxX);
    // The winery's tier covers its walls from the ground up past the eaves.
    expect(winery.tiers[0]!.y1).toBeCloseTo(w.y + w.eaves, 6);
  });

  it('keeps oaks and bushes off the yards, fields, pastures, paddocks, vine rows and the ruin, and the county\'s scrub off the ruin', () => {
    const ruin = v.ruin.rect;
    const keepOut: Rect[] = [v.ranch.yard, v.vineyard.winery.yard, v.ranch.pasture, ...v.ranch.paddocks, ...v.fields.map((f) => f.rect), ruin];
    for (const p of mine) {
      if (p.kind !== 'tree' && p.kind !== 'bush') continue;
      for (const r of keepOut) expect(rectContains(r, p.x, p.z), `${p.kind} at ${p.x}, ${p.z}`).toBe(false);
      for (const s of v.vineyard.segments) expect(Math.hypot(p.x - s.x, p.z - s.z), `${p.kind} at ${p.x}, ${p.z} among the vines`).toBeGreaterThan(2.5);
    }
    for (const p of L.props.slice(0, v.firstProp)) if (p.kind === 'bush') expect(rectContains(ruin, p.x, p.z, 1), `scrub at ${p.x}, ${p.z}`).toBe(false);
    expect(mine.filter((p) => p.kind === 'tree').length).toBeGreaterThanOrEqual(50);
    expect(mine.filter((p) => p.kind === 'fence').length).toBeGreaterThan(150);
  });

  it('lays the vine rows level along the rise\'s contours, clear of the winery and the drive, and stands the fences as breakable runs', () => {
    const { segments, rise, winery } = v.vineyard;
    expect(segments.length).toBeGreaterThan(2000);
    const rows = new Map<number, number[]>();
    const seen = new Set<string>();
    for (const s of segments) {
      expect(rectContains(plot('vineyard'), s.x, s.z)).toBe(true);
      expect(Math.hypot(s.x - (winery.hall.minX + winery.hall.maxX) / 2, s.z - (winery.hall.minZ + winery.hall.maxZ) / 2)).toBeGreaterThan(33);
      expect(Math.abs(s.z - (winery.drive[1] as number)) > 4.5 || s.x < winery.yard.maxX - 2, 'a vine in the drive').toBe(true);
      const row = Math.round((Math.hypot((s.x - rise.cx) / rise.rx, (s.z - rise.cz) / rise.rz) - VINE_ROWS.from) / VINE_ROWS.step);
      let heights = rows.get(row);
      if (!heights) rows.set(row, (heights = []));
      // A run's two ends stand at one height: the row follows the contour.
      const dx = Math.cos(s.yaw) * (VINE_SEG / 2);
      const dz = -Math.sin(s.yaw) * (VINE_SEG / 2);
      expect(Math.abs(W.baseGround(s.x + dx, s.z + dz) - W.baseGround(s.x - dx, s.z - dz)), `run at ${s.x}, ${s.z}`).toBeLessThan(0.02);
      heights.push(W.baseGround(s.x, s.z));
      seen.add(`${Math.round(s.x)},${Math.round(s.z)}`);
    }
    expect(rows.size).toBe(v.vineyard.rows);
    // Every row's height is the same at all its runs, and they climb from the foot to the crest.
    const level = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
    for (const h of level) expect(Math.max(...h) - Math.min(...h)).toBeLessThan(0.06);
    expect(level[0]![0]!).toBeGreaterThan(level[level.length - 1]![0]!);
    expect(seen.size).toBeGreaterThan(segments.length * 0.9);
    // A fence run gives way like a bench, and the pasture's and paddocks' are whole runs.
    for (const [k, p] of mine.entries()) {
      if (p.kind !== 'fence') continue;
      const c = W.grid.colliders[W.propColliders[v.firstProp + k]!]!;
      expect([c.tag, c.breakable]).toEqual(['bench', true]);
    }
  });
});

describe('the ranch\'s horses', () => {
  it('start inside their paddocks\' roams, which keep inside the fences, off the shelters', () => {
    const r = v.ranch;
    expect(r.horses.length).toBe(6);
    r.roam.forEach((roam, k) => {
      const pad = r.paddocks[k]!;
      expect(roam.minX).toBeGreaterThan(pad.minX + 2);
      expect(roam.maxX).toBeLessThan(pad.maxX - 2);
      expect(roam.minZ).toBeGreaterThan(pad.minZ + 2);
      expect(roam.maxZ).toBeLessThan(pad.maxZ - (k < 2 ? 7 : 2));
    });
    for (const h of r.horses) expect(rectContains(r.roam[h.paddock]!, h.x, h.z)).toBe(true);
  });

  it('stay in their roams for ten minutes, graze with their heads down, stand and flick their tails, and walk now and then', () => {
    const r = v.ranch;
    const rng = new Rng(11);
    const horses = r.horses.map((h, i) => makeHorse(h.x, h.z, h.coat, r.roam[h.paddock]!, 100 + i));
    const dt = 1 / 30;
    const modes = new Set<string>();
    let flicks = 0;
    let lowest = 0;
    let walked = 0;
    let before = horses.map((h) => h.tail);
    for (let t = 0; t < 600; t += dt) {
      for (const [i, h] of horses.entries()) {
        const x = h.x;
        const z = h.z;
        stepHorse(h, dt, t, rng);
        modes.add(h.mode);
        expect(rectContains(h.roam, h.x, h.z), `horse ${i} at ${t.toFixed(0)} s`).toBe(true);
        expect(h.head).toBeGreaterThanOrEqual(0);
        expect(h.head).toBeLessThanOrEqual(1);
        expect(Math.hypot(h.x - x, h.z - z)).toBeLessThanOrEqual(HORSE_WALK * dt + 1e-6);
        lowest = Math.max(lowest, h.head);
        if (before[i]! === 0 && h.tail !== 0) flicks++;
        walked += Math.hypot(h.x - x, h.z - z);
      }
      before = horses.map((h) => h.tail);
    }
    expect([...modes].sort()).toEqual(['graze', 'idle', 'walk']);
    expect(lowest).toBeCloseTo(1, 1);
    expect(flicks).toBeGreaterThan(horses.length * 20);
    // Each walks a few hundred metres in ten minutes at most: they graze and stand far more than they move.
    expect(walked / horses.length).toBeLessThan(600 * HORSE_WALK * 0.5);
    expect(walked / horses.length).toBeGreaterThan(30);
  });
});

describe('the ranch\'s sheep', () => {
  const pasture = v.ranch.pasture;
  const flock = () => new Flock(pasture, v.ranch.sheep, 77);
  const settle = (f: Flock, seconds: number, threats: Parameters<Flock['update']>[1] = []) => {
    for (let t = 0; t < seconds; t += 1 / 30) f.update(1 / 30, threats);
  };

  it('graze inside the pasture, round a gathering point on its road side, and run from nothing', () => {
    const f = flock();
    expect(f.sheep.length).toBe(v.ranch.sheep);
    settle(f, 300);
    for (const s of f.sheep) {
      expect(rectContains(pasture, s.x, s.z)).toBe(true);
      expect(s.mode).not.toBe('run');
    }
    expect(f.centre.x).toBeLessThan(pasture.minX + 41);
  });

  it('are frightened by a person within 15 m and a car within 15 m plus 0.4 of its speed, and by nobody farther', () => {
    expect(scareRadius(0)).toBe(SCARE_PERSON);
    expect(scareRadius(14)).toBeCloseTo(SCARE_PERSON + SCARE_PER_SPEED * 14, 9);
    // A person 14 m off sends a sheep running; 16 m off, it does not stir.
    for (const [d, runs] of [[14, true], [16, false]] as const) {
      const g = flock();
      settle(g, 5);
      const sheep = g.sheep[0]!;
      g.update(1 / 30, [{ x: sheep.x - d, z: sheep.z, speed: 0 }]);
      expect(sheep.mode === 'run', `${d} m from a person`).toBe(runs);
    }
    // A car at 14 m/s reaches 20.6 m: a sheep 19 m from it runs, 22 m from it does not.
    for (const [d, runs] of [[19, true], [22, false]] as const) {
      const g = flock();
      settle(g, 5);
      const sheep = g.sheep[0]!;
      g.update(1 / 30, [{ x: sheep.x - d, z: sheep.z, speed: 14 }]);
      expect(sheep.mode === 'run', `${d} m from a car`).toBe(runs);
    }
  });

  it('scatter away from a passing car, stay inside the fence, and drift back together to graze once it is gone', () => {
    const f = flock();
    settle(f, 20);
    const start = f.sheep.map((s) => ({ x: s.x, z: s.z }));
    // A car down the near lane (x -1837.5, 10 m off the fence) at 14 m/s, from z 250 to 400.
    let farthest = 0;
    let ran = 0;
    for (let t = 0; t < 12; t += 1 / 30) {
      const car = { x: -1837.5, z: 250 + 14 * t, speed: 14 };
      f.update(1 / 30, t < 11 ? [car] : []);
      for (const s of f.sheep) {
        expect(rectContains(pasture, s.x, s.z)).toBe(true);
        if (s.mode === 'run') ran++;
        farthest = Math.max(farthest, Math.hypot(s.x - car.x, s.z - car.z));
      }
    }
    expect(ran).toBeGreaterThan(30);
    // Every sheep that ran went away from the road, east.
    const moved = f.sheep.map((s, i) => s.x - start[i]!.x);
    expect(Math.max(...moved)).toBeGreaterThan(6);
    expect(farthest).toBeGreaterThan(SCARE_PERSON);
    // Gone, the flock walks back and settles to graze within a minute and a half (the gathering point moves on now and then, which
    // sends them after it again): each at its own place round it, none within half a metre of another.
    let back = 0;
    while (back < 90 && !f.sheep.every((s) => s.mode === 'graze')) {
      settle(f, 1);
      back++;
    }
    expect(back).toBeLessThan(90);
    for (const s of f.sheep) expect(Math.hypot(s.x - f.centre.x, s.z - f.centre.z), 'back with the flock').toBeLessThan(13);
    for (const [i, a] of f.sheep.entries()) for (const b of f.sheep.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.6);
    expect(SHEEP_RUN).toBeGreaterThan(5);
  });
});

describe('the ranch\'s sheep, with someone who stays', () => {
  it('gather out of reach of a person who stands by the fence, and graze there without running', () => {
    const pasture = v.ranch.pasture;
    const f = new Flock(pasture, v.ranch.sheep, 78);
    const person = { x: pasture.minX - 3, z: f.centre.z, speed: 0 };
    let runs = 0;
    for (let t = 0; t < 90; t += 1 / 30) {
      f.update(1 / 30, [person]);
      if (t > 60) runs += f.sheep.filter((s) => s.mode === 'run').length;
    }
    expect(Math.hypot(f.centre.x - person.x, f.centre.z - person.z)).toBeGreaterThan(SCARE_PERSON);
    expect(runs).toBe(0);
    for (const s of f.sheep) expect(rectContains(pasture, s.x, s.z)).toBe(true);
  });
});

describe('the valley\'s farms, drawn', () => {
  const view = new CountryView(W, new CityView(W), wind);
  const fakeSim = (cars: Array<{ x: number; z: number; speed: number; parked?: boolean }>, people: Array<{ x: number; z: number }> = []) =>
    ({
      clock: { hours: 12 },
      vehicles: cars.map((c) => ({ removed: false, owner: c.parked ? 'parked' : 'traffic', pos: { x: c.x, y: 0, z: c.z }, vel: { x: 0, z: c.speed } })),
      players: people.map((p) => ({ pos: () => ({ x: p.x, y: 0, z: p.z }) })),
    }) as unknown as ViewState;
  const named = (name: string) => {
    const out: THREE.Object3D[] = [];
    view.group.traverse((o) => {
      if (o.name === name) out.push(o);
    });
    return out;
  };

  it('instances every vine run, hides the rows past the cull\'s reach, and lights the vines as the crops are lit', () => {
    const rows = named('vineyard-rows') as THREE.InstancedMesh[];
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.reduce((n, m) => n + m.count, 0)).toBe(v.vineyard.segments.length);
    expect(view.fields.crops.map((m) => m.name)).toContain('vineyard-vines');
    view.cull(-1900, 130, 840);
    expect(rows.every((m) => m.visible)).toBe(true);
    view.cull(-700, 0, 300);
    expect(rows.every((m) => !m.visible)).toBe(true);
    view.cull(-1900, 130, 840);
  });

  it('shows the string lights\' glow only after dark', () => {
    const glow = named('winery-string-lights')[0] as THREE.Points;
    expect(glow.geometry.getAttribute('position').count).toBeGreaterThan(60);
    view.update(-1900, 5, 130, 0, 0, 12, { x: 1, z: 0 }, null);
    expect(glow.visible).toBe(false);
    view.update(-1900, 5, 130, 1, 1, 22, { x: 1, z: 0 }, null);
    expect(glow.visible).toBe(true);
    expect((glow.material as THREE.PointsMaterial).opacity).toBeGreaterThan(0.5);
  });

  it('runs the sheep from a car within reach and leaves them be otherwise; hides the animals from far away', () => {
    const flock = view.ranch.flock;
    view.update(-1830, 5, 300, 0, 100, 12, { x: 1, z: 0 }, fakeSim([]));
    const ran = () => flock.sheep.filter((s) => s.mode === 'run').length;
    for (let k = 0; k < 90; k++) view.update(-1830, 5, 300, 0, 100 + k / 30, 12, { x: 1, z: 0 }, fakeSim([]));
    expect(ran()).toBe(0);
    // A parked car by the pasture frightens none; a moving one does.
    const near = { x: flock.sheep[0]!.x - 8, z: flock.sheep[0]!.z, speed: 12 };
    for (let k = 0; k < 10; k++) view.update(-1830, 5, 300, 0, 103 + k / 30, 12, { x: 1, z: 0 }, fakeSim([{ ...near, parked: true }]));
    expect(ran()).toBe(0);
    for (let k = 0; k < 10; k++) view.update(-1830, 5, 300, 0, 104 + k / 30, 12, { x: 1, z: 0 }, fakeSim([near]));
    expect(ran()).toBeGreaterThan(0);
    const horses = named('horse-body')[0] as THREE.InstancedMesh;
    expect(horses.visible).toBe(true);
    view.update(-1300, 5, 0, 0, 105, 12, { x: 1, z: 0 }, null);
    expect(horses.visible).toBe(false);
  });

  it('has the city pass draw each county farmhouse once and leave the valley\'s winery and ranch house to the valley', () => {
    // Vertices of the city's meshes inside a building's footprint: a box's four walls are 16 of the facade's.
    const city = new CityView(W, HARDWARE_CHUNK_SIZE);
    const inside = (id: number, prefix: string) => {
      const r = L.buildings.find((b) => b.id === id)!.rect;
      let n = 0;
      city.group.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !o.name.startsWith(prefix)) return;
        const pos = o.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) if (rectContains(r, pos.getX(i) + o.position.x, pos.getZ(i) + o.position.z, 0.01)) n++;
      });
      return n;
    };
    const houses = L.country.farms.farmsteads.map((f) => f.house);
    expect(houses.length).toBe(4);
    for (const id of houses) expect([inside(id, 'facade-'), inside(id, 'roofs') > 0], `farmhouse ${id}`).toEqual([16, true]);
    for (const id of [v.ranch.house, v.vineyard.winery.building]) expect([inside(id, 'facade-'), inside(id, 'roofs')], `valley building ${id}`).toEqual([0, 0]);
  });

  it('draws the valley\'s oaks and bushes as one batch each, not one per cell', () => {
    const props = new PropsView(W, HARDWARE_CHUNK_SIZE);
    const batches = new Map<string, number>();
    props.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      const idx = o.userData.propIndices as number[] | undefined;
      const kind = idx ? L.props[idx[0]!]?.kind : null;
      if (idx && idx.every((i) => i >= v.firstProp) && (kind === 'tree' || kind === 'bush')) batches.set(o.geometry.name || o.geometry.uuid, (batches.get(o.geometry.name || o.geometry.uuid) ?? 0) + 1);
    });
    expect(mine.filter((p) => p.kind === 'tree' || p.kind === 'bush').length).toBeGreaterThan(150);
    // The trunk, the canopy and the shrubs: three, each in one piece.
    expect([...batches.values()]).toEqual([1, 1, 1]);
  });
});
