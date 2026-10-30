import { describe, expect, it } from 'vitest';
import { CameraController } from '../../src/render/camera';
import { DressingRules, viewpointViolation, viewpoints } from '../../src/render/dressing';
import { Sim } from '../../src/sim/sim';
import { CURB_H, SWIM_DEPTH, WATER_Y } from '../../src/world/constants';
import { headlandAt, mkRect, rectsOverlap, type Rect } from '../../src/world/layout';
import { bluffRise, CORE_COVER, CORE_INSET, hillRise, hillSignLetters, lookoutRail, riseAt, riseBounds, terrainCores, type Rise } from '../../src/world/terrain';
import type { StaticWorld } from '../../src/world/staticWorld';
import { freshWorld, input, placeInCar, world } from './helpers';

const W = world();
const L = W.layout;
const rises = L.rises;
const hill = hillRise(rises);
const bluff = bluffRise(rises);
const point = L.headlands.find((h) => h.name === 'Azura Point')!;
const [base, tip] = point.rects as [Rect, Rect];
const park = L.blocks.find((b) => b.zone === 'Hillcrest Green')!;
const DT = 1 / 60;

/** Where a rise covers land: a climb's headland rects, a bell's own bounds. */
function land(r: Rise): Rect[] {
  return r.kind === 'climb' ? r.within : [riseBounds(r)];
}

describe('the rises stay off everything that assumes flat ground', () => {
  it('Hillcrest Green rises 7 m on its fountain, 0 a good way inside the park lot', () => {
    expect(rises.map((r) => r.name)).toContain('Hillcrest Green');
    const fountain = L.props.find((p) => p.kind === 'fountain' && Math.hypot(p.x - hill.cx, p.z - hill.cz) < 1)!;
    expect(fountain).toBeTruthy();
    expect(riseAt(rises, hill.cx, hill.cz)).toBe(7);
    expect(fountain.y).toBe(CURB_H + 7);
    const b = riseBounds(hill);
    expect(b.minX - park.lot.minX).toBeGreaterThanOrEqual(3);
    expect(park.lot.maxX - b.maxX).toBeGreaterThanOrEqual(3);
    expect(b.minZ - park.lot.minZ).toBeGreaterThanOrEqual(3);
    expect(park.lot.maxZ - b.maxZ).toBeGreaterThanOrEqual(3);
  });

  it('is 0 on every road, sidewalk ring, walk node and building footprint', () => {
    const roads = [...W.roads.segments, ...W.roads.live.map((n) => mkRect(n.x - n.halfX, n.z - n.halfZ, n.x + n.halfX, n.z + n.halfZ))];
    const rings = L.blocks.flatMap((bl) => {
      const r = bl.rect;
      const l = bl.lot;
      return [mkRect(r.minX, r.minZ, r.maxX, l.minZ), mkRect(r.minX, l.maxZ, r.maxX, r.maxZ), mkRect(r.minX, l.minZ, l.minX, l.maxZ), mkRect(l.maxX, l.minZ, r.maxX, l.maxZ)];
    });
    const footprints = L.buildings.map((b) => b.rect);
    for (const r of rises) {
      for (const [what, rects] of [['road', roads], ['sidewalk', rings], ['building', footprints], ['garage', L.garages.map((g) => g.rect)], ['ramp', L.ramps.map((q) => mkRect(q.x - 6, q.z - 6, q.x + 6, q.z + 6))]] as const) {
        const hit = rects.find((q) => rectsOverlap(q, riseBounds(r)));
        expect(hit, `${r.name} over a ${what}`).toBeUndefined();
      }
    }
    // The path out to the lighthouse is the only walk on a rise: from the promenade's edge to the plateau.
    const path = W.walk.nodes.filter((n) => headlandAt(L, n.x, n.z));
    expect(path.map((n) => riseAt(rises, n.x, n.z))).toEqual([0, 10]);
    for (const n of W.walk.nodes) if (!path.includes(n)) expect(riseAt(rises, n.x, n.z), `walk node ${n.id}`).toBe(0);
  });

  it('is never steeper than 21% on a 1 m lattice', () => {
    let worst = 0;
    for (const r of rises) {
      for (const b of land(r)) {
        for (let x = b.minX; x + 1 <= b.maxX; x += 1) {
          for (let z = b.minZ; z + 1 <= b.maxZ; z += 1) {
            const h = riseAt(rises, x, z);
            worst = Math.max(worst, Math.abs(riseAt(rises, x + 1, z) - h), Math.abs(riseAt(rises, x, z + 1) - h));
          }
        }
      }
    }
    expect(worst).toBeGreaterThan(0.15);
    expect(worst).toBeLessThanOrEqual(0.21);
  });

  it('stands every prop on it at the ground height, and clears the sign lawn of trees', () => {
    let settled = 0;
    for (const p of L.props) {
      if (riseAt(rises, p.x, p.z) <= 0) continue;
      settled++;
      expect(p.y, `${p.kind} at ${p.x}, ${p.z}`).toBeCloseTo(W.groundHeight(p.x, p.z), 9);
    }
    expect(settled).toBeGreaterThan(150);
    const letters = hillSignLetters(rises);
    for (const p of L.props) {
      if (p.kind !== 'tree' && p.kind !== 'bush') continue;
      for (const l of letters) expect(p.x > l.box.minX - 3 && p.x < l.box.maxX + 3 && p.z > l.box.minZ - 3 && p.z < park.lot.maxZ, `${p.kind} at ${p.x}, ${p.z} by ${l.char}`).toBe(false);
    }
  });

  it('keeps the park and its open spots as they were: no densifying, the pickups in place', () => {
    const inPark = L.props.filter((p) => p.x > park.lot.minX && p.x < park.lot.maxX && p.z > park.lot.minZ && p.z < park.lot.maxZ);
    expect(inPark.filter((p) => p.kind === 'tree').length).toBeLessThan(277);
    expect(inPark.filter((p) => p.kind === 'bench').length).toBe(4);
    const spots = L.openSpots.filter((s) => s.x > park.lot.minX && s.x < park.lot.maxX && s.z > park.lot.minZ && s.z < park.lot.maxZ);
    expect(spots.map((s) => [s.x, s.z])).toEqual([[44, -458.5], [122, -458.5], [44, -364.5], [122, -364.5]]);
    for (const s of spots) expect(W.isFree(s.x, s.z, 0.6)).toBe(true);
  });
});

describe('the sight cores', () => {
  const cores = terrainCores(rises);

  it('stand CORE_COVER under the ground over their footprint grown by CORE_INSET', () => {
    expect(cores.length).toBeGreaterThanOrEqual(3);
    for (const c of cores) {
      for (let x = c.minX - CORE_INSET; x <= c.maxX + CORE_INSET + 1e-9; x += 0.5) {
        for (let z = c.minZ - CORE_INSET; z <= c.maxZ + CORE_INSET + 1e-9; z += 0.5) {
          expect(W.groundHeight(x, z) - c.y1, `core to ${c.y1} at ${x}, ${z}`).toBeGreaterThanOrEqual(CORE_COVER - 1e-9);
        }
      }
    }
  });

  it('are solid for sight: the hill blocks a line of sight across it at head height, not over the summit', () => {
    const head = (x: number, z: number) => W.groundHeight(x, z) + 1.6;
    const s = park.lot.maxZ - 4;
    const n = park.lot.minZ + 4;
    // North to south over the crest, and west to east, from the foot of the hill on either side.
    expect(W.lineOfSight(hill.cx + 20, head(hill.cx + 20, s), s, hill.cx + 20, head(hill.cx + 20, n), n)).toBe(false);
    expect(W.lineOfSight(park.lot.minX + 4, head(park.lot.minX + 4, hill.cz + 20), hill.cz + 20, park.lot.maxX - 4, head(park.lot.maxX - 4, hill.cz + 20), hill.cz + 20)).toBe(false);
    // Two people on the summit see each other, and one up there sees down the slope to the street.
    expect(W.lineOfSight(hill.cx - 9, head(hill.cx - 9, hill.cz - 2), hill.cz - 2, hill.cx + 9, head(hill.cx + 9, hill.cz + 2), hill.cz + 2)).toBe(true);
    const street = park.rect.maxZ + 6;
    expect(W.lineOfSight(hill.cx, head(hill.cx, hill.cz + 9), hill.cz + 9, hill.cx, 1.2, street)).toBe(true);
  });

  it('are out of reach of bodies, free-space checks and the camera on the slopes', () => {
    for (const c of cores) {
      for (let x = c.minX - CORE_INSET; x <= c.maxX + CORE_INSET; x += 2) {
        for (let z = c.minZ - CORE_INSET; z <= c.maxZ + CORE_INSET; z += 2) {
          let near = false;
          W.grid.query(x - 0.6, z - 0.6, x + 0.6, z + 0.6, (q) => {
            if (q.tag === 'terrain' && q.y1 >= W.groundHeight(x, z) + 0.2) near = true;
          });
          expect(near, `${x}, ${z}`).toBe(false);
        }
      }
    }
  });
});

describe('on the hill', () => {
  it('a Nightjar crosses the summit up the old path at 30 m/s without leaving the ground or being stopped', () => {
    const w = freshWorld();
    const sim = new Sim({ world: w, ambient: false, police: false });
    // The fountain stands on the path at the top: out of the way, the car runs straight over the summit.
    const fountain = w.layout.props.findIndex((p) => p.kind === 'fountain' && Math.hypot(p.x - hill.cx, p.z - hill.cz) < 1);
    w.grid.colliders[w.propColliders[fountain]!]!.broken = true;
    // From the foot of the path, inside the lot (a street tree stands in the sidewalk where it meets Magnolia Ave).
    const v = sim.spawnVehicle('sports', hill.cx, park.lot.maxZ - 3, Math.PI);
    placeInCar(sim, v);
    let top = -Infinity;
    for (let i = 0; i < Math.round(7 / DT); i++) {
      v.vel.x = 0;
      v.vel.z = -30;
      v.heading = Math.PI;
      v.angVel = 0;
      sim.update(DT, input());
      expect(v.airborne, `airborne at z ${v.pos.z.toFixed(1)}`).toBe(false);
      expect(v.pos.y).toBeCloseTo(w.groundHeight(v.pos.x, v.pos.z), 2);
      top = Math.max(top, v.pos.y);
      if (v.pos.z < park.lot.minZ + 4) break;
    }
    expect(top).toBeCloseTo(CURB_H + 7, 6);
    expect(v.pos.z).toBeLessThan(park.lot.minZ + 4);
    expect(Math.abs(v.pos.x - hill.cx)).toBeLessThan(0.5);
  });

  it('a man walks up the path from the foot of the hill to the fountain', () => {
    const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
    const p = sim.player;
    p.pos.x = hill.cx;
    p.pos.z = park.lot.maxZ - 1;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    for (let i = 0; i < Math.round(40 / DT) && p.pos.z > hill.cz + 6; i++) sim.update(DT, input({ moveZ: 1, cameraYaw: Math.PI }));
    expect(p.pos.z).toBeLessThanOrEqual(hill.cz + 6);
    expect(p.pos.y).toBeCloseTo(CURB_H + 7, 3);
    expect(p.health).toBe(p.maxHealth);
  });

  it('the camera keeps its line to the car above the ground over the crest, and to a man walking down', () => {
    const above = (cam: CameraController, x: number, y: number, z: number) => {
      const c = cam.camera.position;
      let low = Infinity;
      for (let k = 1; k < 40; k++) {
        const t = k / 40;
        const px = c.x + (x - c.x) * t;
        const py = c.y + (y - c.y) * t;
        const pz = c.z + (z - c.z) * t;
        low = Math.min(low, py - W.groundHeight(px, pz));
      }
      return low;
    };
    {
      const w = freshWorld();
      const sim = new Sim({ world: w, ambient: false, police: false });
      const fountain = w.layout.props.findIndex((p) => p.kind === 'fountain' && Math.hypot(p.x - hill.cx, p.z - hill.cz) < 1);
      w.grid.colliders[w.propColliders[fountain]!]!.broken = true;
      const v = sim.spawnVehicle('sports', hill.cx, park.lot.maxZ - 3, Math.PI);
      placeInCar(sim, v);
      const cam = new CameraController(16 / 9);
      cam.mode = 'play';
      cam.reset(sim);
      let worst = Infinity;
      for (let i = 0; i < Math.round(9 / DT) && v.pos.z > park.lot.minZ + 4; i++) {
        v.vel.x = 0;
        v.vel.z = -16;
        v.heading = Math.PI;
        v.angVel = 0;
        const c = cam.camera.position;
        sim.update(DT, input({ aimOrigin: { x: c.x, y: c.y, z: c.z }, aimDir: { x: 0, y: -0.1, z: -1 } }));
        cam.update(DT, sim, false);
        if (i > 30) worst = Math.min(worst, above(cam, v.pos.x, v.pos.y + v.spec.height, v.pos.z));
      }
      expect(worst).toBeGreaterThan(0.05);
    }
    {
      const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
      const p = sim.player;
      p.pos.x = hill.cx;
      p.pos.z = hill.cz + 8;
      p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
      const cam = new CameraController(16 / 9);
      cam.mode = 'play';
      cam.yaw = 0;
      cam.reset(sim);
      let worst = Infinity;
      for (let i = 0; i < Math.round(12 / DT) && p.pos.z < park.lot.maxZ - 2; i++) {
        const c = cam.camera.position;
        sim.update(DT, input({ moveZ: 1, cameraYaw: 0, aimOrigin: { x: c.x, y: c.y, z: c.z }, aimDir: { x: 0, y: -0.1, z: 1 } }));
        cam.update(DT, sim, false);
        if (i > 30) worst = Math.min(worst, above(cam, p.pos.x, p.pos.y + 1.6, p.pos.z));
      }
      expect(p.pos.z).toBeGreaterThan(hill.cz + 40);
      expect(worst).toBeGreaterThan(0.05);
    }
  });

  it('the letters stand on the south slope either side of the path, 6 m out of the ground, and are solid', () => {
    const letters = hillSignLetters(rises);
    expect(letters.map((l) => l.char).join('')).toBe('SANAZURA');
    for (const l of letters) {
      expect(l.z).toBeGreaterThan(hill.cz + 30);
      expect(l.y0 + l.h - W.groundHeight(l.x, l.z)).toBeCloseTo(6, 6);
      // Clear of the north-south path up the slope.
      expect(l.box.maxX <= hill.cx - 2.5 || l.box.minX >= hill.cx + 2.5, l.char).toBe(true);
    }
    expect(letters.at(-1)!.tilt).toBeGreaterThan(0.3);
    const a = letters[1]!;
    const y = W.groundHeight(a.x, a.z + 5) + 1.6;
    expect(W.lineOfSight(a.x, y, a.z + 5, a.x, y, a.z - 5)).toBe(false);
    expect(W.isFree(a.x, a.z, 0.4)).toBe(false);
    // The slumped A's colliders follow its strokes: its foot and legs stop a man and a look through it, while under its
    // overhang (east) a man walks and sees past its foot, and over its low side (west) the air is open.
    const s = letters.at(-1)!;
    const across = (dx: number, up: number) => {
      const g = W.groundHeight(s.x + dx, s.z) + up;
      return W.lineOfSight(s.x + dx, g, s.z + 3, s.x + dx, g, s.z - 3);
    };
    for (const dx of [0, 2]) {
      expect(W.isFree(s.x + dx, s.z, 0.3), `${dx} m east of the A's foot`).toBe(false);
      expect(across(dx, 1), `${dx} m east of the A's foot`).toBe(false);
    }
    for (const dx of [3.5, 4, 4.5]) {
      expect(W.isFree(s.x + dx, s.z, 0.3), `${dx} m east of the A's foot`).toBe(true);
      expect(across(dx, 1), `${dx} m east of the A's foot`).toBe(true);
    }
    for (const dx of [-1, -2]) for (const up of [2, 3, 4]) expect(across(dx, up), `${-dx} m west of the A's foot, ${up} m up`).toBe(true);
  });

  it('places the plaques, the telescopes, the fences and the sign clear of everything the dressing keeps clear of', () => {
    const items = viewpoints(W);
    const rules = new DressingRules(W);
    expect(items.filter((it) => it.kind === 'telescope').length).toBe(4);
    expect(items.filter((it) => it.kind === 'plaque').map((it) => it.text)).toEqual([
      "HILLCREST SUMMIT, ELEV. 7 M. HIGHEST POINT IN SAN AZURA THAT ISN'T A PARKING GARAGE.",
      'AZURA POINT LOOKOUT. ON A CLEAR DAY YOU CAN SEE THE SMOG.',
    ]);
    expect(items.filter((it) => it.kind === 'sign').map((it) => it.text)).toEqual(['DO NOT CLIMB THE LETTERS. THE LETTERS HAVE BEEN THROUGH ENOUGH.']);
    for (const it of items) {
      expect(viewpointViolation(rules, it), `${it.kind} at ${it.x}, ${it.z}`).toBeNull();
      expect(it.y).toBeCloseTo(W.groundHeight(it.x, it.z), 9);
    }
    // Two on the summit, two at the lookout on the plateau.
    expect(items.filter((it) => it.kind === 'telescope').map((t) => Math.round(t.y - CURB_H))).toEqual([7, 7, 10, 10]);
  });
});

/** A z on Azura Point's plateau with nothing standing between the middle of the tip and its west cliff. */
function clearToWestCliff(w: StaticWorld): number {
  for (let z = tip.minZ + 8; z < bluff.cz - bluff.rz - 4; z += 1) {
    let blocked = false;
    w.grid.query(tip.minX, z - 3, tip.minX + 22, z + 3, (c) => {
      if (c.tag !== 'terrain' && c.y1 > CURB_H + 10) blocked = true;
    });
    if (!blocked) return z;
  }
  throw new Error('no clear way to the west cliff');
}

describe("Azura Point's bluff", () => {
  it('climbs from the promenade to a 10 m plateau, the lighthouse and its lookout on top', () => {
    expect(W.groundHeight(base.minX + 30, base.maxZ)).toBe(CURB_H);
    const mid = W.groundHeight((base.minX + base.maxX) / 2, (base.minZ + base.maxZ) / 2);
    expect(mid).toBeGreaterThan(CURB_H + 2);
    expect(mid).toBeLessThan(CURB_H + 8);
    expect(W.groundHeight((tip.minX + tip.maxX) / 2, (tip.minZ + tip.maxZ) / 2)).toBe(CURB_H + 10);
    // No cross-slope: across the base and the tip the ground is level.
    for (const z of [-530, -560, -600]) expect(W.groundHeight(tip.minX + 1, z)).toBe(W.groundHeight(tip.maxX - 1, z));
    const lighthouse = L.props.find((p) => p.kind === 'lighthouse')!;
    expect(lighthouse.y).toBe(CURB_H + 10);
    const rail = lookoutRail(L);
    expect(rail.y).toBe(CURB_H + 10);
    expect(rail.maxX - rail.minX).toBe(24);
    expect(W.isFree((rail.minX + rail.maxX) / 2, (rail.minZ + rail.maxZ) / 2, 0.3)).toBe(false);
    // The sea round it is as deep as ever.
    expect(W.waterDepth(tip.minX - 2, -600)).toBeGreaterThan(SWIM_DEPTH);
  });

  it('a car drives up the path to the lighthouse without leaving the ground', () => {
    const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
    const v = sim.spawnVehicle('sports', bluff.cx, base.maxZ + 10, Math.PI);
    placeInCar(sim, v);
    for (let i = 0; i < Math.round(8 / DT) && v.pos.z > tip.minZ + 30; i++) {
      v.vel.x = 0;
      v.vel.z = -25;
      v.heading = Math.PI;
      v.angVel = 0;
      sim.update(DT, input());
      expect(v.airborne, `airborne at z ${v.pos.z.toFixed(1)}`).toBe(false);
    }
    expect(v.pos.z).toBeLessThanOrEqual(tip.minZ + 30);
    expect(v.pos.y).toBeCloseTo(CURB_H + 10, 6);
  });

  it('a car driven off the cliff flies and sinks', () => {
    const w = freshWorld();
    const sim = new Sim({ world: w, ambient: false, police: false });
    const z = clearToWestCliff(w);
    const v = sim.spawnVehicle('sports', tip.minX + 16, z, -Math.PI / 2);
    placeInCar(sim, v);
    let flew = false;
    for (let i = 0; i < Math.round(8 / DT) && !v.inWater; i++) {
      if (!v.airborne && v.pos.x > tip.minX) {
        v.vel.x = -20;
        v.vel.z = 0;
        v.heading = -Math.PI / 2;
        v.angVel = 0;
      }
      sim.update(DT, input());
      if (v.airborne) flew = true;
    }
    expect(flew).toBe(true);
    expect(v.inWater).toBe(true);
    expect(v.pos.x).toBeLessThan(tip.minX);
  });

  it('a man who steps off comes up swimming, unhurt, and cannot climb the cliff, but climbs out at the promenade end', () => {
    const w = freshWorld();
    const sim = new Sim({ world: w, ambient: false, police: false });
    const p = sim.player;
    const z = clearToWestCliff(w);
    p.pos.x = tip.minX + 3;
    p.pos.z = z;
    p.pos.y = w.groundHeight(p.pos.x, p.pos.z);
    for (let i = 0; i < Math.round(8 / DT) && p.state !== 'swimming'; i++) sim.update(DT, input({ moveZ: 1, cameraYaw: -Math.PI / 2 }));
    expect(p.state).toBe('swimming');
    expect(p.health).toBe(p.maxHealth);
    for (let i = 0; i < Math.round(6 / DT); i++) sim.update(DT, input({ moveZ: 1, cameraYaw: Math.PI / 2 }));
    expect(p.state).toBe('swimming');
    expect(p.pos.x).toBeLessThan(tip.minX + 0.5);
    // Round to the base's foot by the promenade, where the ground is a step over the water.
    p.pos.x = base.minX - 4;
    p.pos.z = base.maxZ - 3;
    for (let i = 0; i < Math.round(8 / DT) && p.state === 'swimming'; i++) sim.update(DT, input({ moveZ: 1, cameraYaw: Math.PI / 2 }));
    expect(p.state).toBe('normal');
    expect(p.pos.x).toBeGreaterThanOrEqual(base.minX);
    expect(p.pos.y).toBeGreaterThan(WATER_Y);
  });

  it('pays a cliff dive once a game day', () => {
    const w = freshWorld();
    const sim = new Sim({ world: w, ambient: false, police: false });
    const p = sim.player;
    const z = clearToWestCliff(w);
    const big: string[] = [];
    sim.events.on('big', (e) => big.push(e.text));
    const swimming = () => p.state === 'swimming';
    const dive = () => {
      p.state = 'normal';
      p.vel.x = p.vel.y = p.vel.z = 0;
      p.pos.x = tip.minX + 2;
      p.pos.z = z;
      p.pos.y = w.groundHeight(p.pos.x, p.pos.z);
      for (let i = 0; i < Math.round(6 / DT) && !swimming(); i++) sim.update(DT, input({ moveZ: 1, cameraYaw: -Math.PI / 2 }));
      expect(p.state).toBe('swimming');
    };
    const money = sim.progress.money;
    dive();
    expect(sim.progress.money - money).toBe(100);
    expect(big).toEqual(['CLIFF DIVE']);
    dive();
    expect(sim.progress.money - money).toBe(100);
    expect(big).toEqual(['CLIFF DIVE']);
    sim.clock.day++;
    dive();
    expect(sim.progress.money - money).toBe(200);
    expect(big).toEqual(['CLIFF DIVE', 'CLIFF DIVE']);
    // Off a quay, or the bluff's low end by the promenade, it is only a splash.
    p.state = 'normal';
    p.pos.x = base.minX + 0.5;
    p.pos.z = base.maxZ - 6;
    p.pos.y = w.groundHeight(p.pos.x, p.pos.z);
    sim.clock.day++;
    for (let i = 0; i < Math.round(4 / DT) && !swimming(); i++) sim.update(DT, input({ moveZ: 1, cameraYaw: -Math.PI / 2 }));
    expect(p.state).toBe('swimming');
    expect(sim.progress.money - money).toBe(200);
  });
});
