// Turbine Row and Smuggler's Key (world/offshore.ts): the turbines stand in the sea and stop what runs into them, the
// world reaches out past them by whole collider cells, and the Key is land with its walls, jetty and stash, appended
// after everything older so the city, its colliders and its pickups stay as they were.

import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { OffshoreView } from '../../src/render/offshore';
import { rotorSpeed, TurbineView } from '../../src/render/turbines';
import type { Vehicle } from '../../src/sim/entities';
import { Sim } from '../../src/sim/sim';
import { CURB_H, PROMENADE_W, WATER_Y } from '../../src/world/constants';
import { headlandAt, rectContains } from '../../src/world/layout';
import { KEY_NAME, TURBINE_BASE } from '../../src/world/offshore';
import { hillSignLetters, terrainCores } from '../../src/world/terrain';
import { StaticWorld } from '../../src/world/staticWorld';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    return new Proxy(store, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  };
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
});

const W = world();
const L = W.layout;
const sha = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
const turbines = L.props.filter((p) => p.kind === 'turbine');
const key = L.headlands.find((h) => h.name === KEY_NAME)!;
const onKey = (x: number, z: number, margin = 0) => key.rects.some((r) => rectContains(r, x, z, margin));

/** A Marlin at (x, z) facing `heading`, the player at its helm. */
function marlin(x: number, z: number, heading: number): { sim: Sim; boat: Vehicle } {
  const sim = makeSim({ seed: 9, police: false });
  const boat = sim.spawnVehicle('speedboat', x, z, heading);
  boat.pos.y = WATER_Y;
  placeInCar(sim, boat);
  return { sim, boat };
}

describe('Turbine Row', () => {
  it('stands ten turbines in two staggered rows, 110 m apart, clear of the Key and 60 m inside the world', () => {
    const b = L.bounds;
    expect(turbines).toHaveLength(10);
    for (const [i, t] of turbines.entries()) {
      expect(W.baseGround(t.x, t.z)).toBeLessThan(WATER_Y - 5);
      expect(Math.min(t.x - b.worldMinX, b.worldMaxX - t.x, t.z - b.worldMinZ, b.worldMaxZ - t.z), `turbine ${i} to the world's edge`).toBeGreaterThanOrEqual(60);
      for (const r of key.rects) expect(Math.hypot(Math.max(r.minX - t.x, t.x - r.maxX, 0), Math.max(r.minZ - t.z, t.z - r.maxZ, 0))).toBeGreaterThanOrEqual(80);
      for (const o of turbines.slice(i + 1)) expect(Math.hypot(o.x - t.x, o.z - t.z)).toBeGreaterThanOrEqual(110);
      // Within 400 m of the north shore: in sight from the promenade through the day's haze.
      expect(b.landMinZ - t.z).toBeLessThan(400);
    }
    expect(new Set(turbines.map((t) => t.z)).size).toBe(2);
  });

  it('reaches the world out to z -1060 by whole grid cells and keeps every older collider as the city builds it without them', () => {
    const b = L.bounds;
    expect(b.worldMinZ).toBe(b.cityMinZ - PROMENADE_W - 544);
    expect(b.worldMinZ).toBe(-1060);
    expect((b.cityMinZ - PROMENADE_W - 160 - b.worldMinZ) % W.grid.cell).toBe(0);
    // Every collider older than the offshore ones (the first turbine's on) is the one the city builds without them:
    // captured at 4323153 as the m3_buildings colliders hash, before Turbine Row, and again on the merged round-2 head
    // as the colliders it builds with buildOffshore left out (the hill's, the attractions' and AzuraLink's among them),
    // and once more when Las Lomas County moved four of them, two lamps, a tree and a bench, out of the links' mouths.
    const first = W.propColliders[L.props.indexOf(turbines[0]!)]!;
    expect(sha(W.grid.colliders.slice(0, first).map((c) => ({ ...c })))).toBe('ca0025d7549e165d0e149354928d618ba0357db72c9b486e0a9918ef5c8d4a19');
    // After them: a pillar per turbine and the Key's palms and jetty lamp, the last props; then the solids the earlier
    // passes append past every prop (the rises' cores, the letters and the lookout's parapet, the attractions'), the
    // battery's walls, AzuraLink's pylons and stations, and last Las Lomas County's (the bridge's parapets and its arch's
    // portal posts, its props).
    const rest = W.grid.colliders.slice(first);
    const county = L.props.slice(L.country.firstProp).map((p) => (p.kind === 'signal' ? 'signal' : 'lamp'));
    expect(rest.map((c) => c.tag)).toEqual([
      ...turbines.map(() => 'pillar'), 'palm', 'palm', 'palm', 'lamp',
      ...terrainCores(L.rises).map(() => 'terrain'),
      ...hillSignLetters(L.rises).flatMap((l) => l.solids).map(() => 'wall'),
      'wall',
      ...L.attractions.flatMap((a) => a.solids.map((s) => s.tag)),
      ...L.offshore.solids.map(() => 'wall'),
      ...L.monorail.pylons.map(() => 'rock'),
      ...L.monorail.stations.flatMap((s) => ['building', ...s.platform.map(() => 'building')]),
      'wall', 'wall', 'pillar', 'pillar', 'pillar', 'pillar', ...county,
    ]);
    for (const [i, t] of turbines.entries()) {
      const c = rest[i]!;
      expect([c.circle, c.cx, c.cz, c.r]).toEqual([true, t.x, t.z, TURBINE_BASE]);
      expect(c.y0).toBeLessThan(WATER_Y - 1);
      expect(c.y1).toBeGreaterThan(WATER_Y + 70);
    }
  });

  it('stops a boat driven at a tower, and stops shots and the line of sight at it', () => {
    const t = turbines[0]!;
    const { sim, boat } = marlin(t.x, t.z + 70, Math.PI);
    let nearest = Infinity;
    step(sim, 6, () => {
      nearest = Math.min(nearest, Math.hypot(boat.pos.x - t.x, boat.pos.z - t.z));
      return input({ throttle: 1 });
    });
    console.log(`[offshore] a Marlin at full throttle at turbine (${t.x}, ${t.z}): nearest ${nearest.toFixed(2)} m, now ${boat.speed.toFixed(1)} m/s at z ${boat.pos.z.toFixed(1)}`);
    expect(boat.pos.z).toBeGreaterThan(t.z);
    expect(nearest).toBeGreaterThan(TURBINE_BASE + boat.halfW - 0.3);
    expect(boat.speed).toBeLessThan(5);
    expect(W.lineOfSight(t.x, 2, t.z + 20, t.x, 2, t.z - 20)).toBe(false);
    expect(W.lineOfSight(t.x + 20, 2, t.z + 20, t.x + 20, 2, t.z - 20)).toBe(true);
  });

  it('turns the rotors with the wind and the nacelles into it, three instanced draws for the row', () => {
    expect(rotorSpeed(0)).toBeGreaterThan(0);
    expect(rotorSpeed(6)).toBeGreaterThan(rotorSpeed(2));
    expect(rotorSpeed(12)).toBe(rotorSpeed(30));
    const view = new TurbineView(W);
    const meshes = ['turbineTowers', 'turbineNacelles', 'turbineRotors'].map((n) => view.group.getObjectByName(n) as THREE.InstancedMesh);
    for (const m of meshes) {
      expect(m).toBeInstanceOf(THREE.InstancedMesh);
      expect(m.count).toBe(10);
      expect(m.castShadow).toBe(true);
    }
    const rotor = () => {
      const m = new THREE.Matrix4();
      meshes[2]!.getMatrixAt(0, m);
      return new THREE.Quaternion().setFromRotationMatrix(m);
    };
    // The air moving east: the rotors face west, into it.
    const light = new THREE.Color(1, 1, 1);
    view.update(1 / 60, 0, 0, { x: 6, z: 0 }, light);
    const nacelle = new THREE.Matrix4();
    meshes[1]!.getMatrixAt(0, nacelle);
    const ahead = new THREE.Vector3(0, 0, 1).transformDirection(nacelle);
    expect(ahead.x).toBeCloseTo(-1, 5);
    const before = rotor();
    view.update(1, 1, 0, { x: 6, z: 0 }, light);
    expect(before.angleTo(rotor())).toBeCloseTo(rotorSpeed(6), 3);
    view.dispose();
  });
});

describe("Smuggler's Key", () => {
  it('is land with its own name, ground cover, a jetty and Fort Contraband', () => {
    for (const r of key.rects) {
      const x = (r.minX + r.maxX) / 2;
      const z = (r.minZ + r.maxZ) / 2;
      expect(W.baseGround(x, z)).toBe(CURB_H);
      expect(W.zoneName(x, z)).toBe(KEY_NAME);
      expect(headlandAt(L, x, z)).toBe(key);
    }
    expect(W.zoneName(250, -560)).toBe('San Azura Bay');
    // Turf or dirt everywhere on it, with no patch laid twice.
    const patches = L.ground.filter((g) => key.rects.some((r) => rectContains(r, (g.rect.minX + g.rect.maxX) / 2, (g.rect.minZ + g.rect.maxZ) / 2)));
    const area = (r: { minX: number; minZ: number; maxX: number; maxZ: number }) => (r.maxX - r.minX) * (r.maxZ - r.minZ);
    expect(new Set(patches.map((g) => g.kind))).toEqual(new Set(['grass', 'dirt']));
    expect(patches.reduce((s, g) => s + area(g.rect), 0)).toBeCloseTo(70 * 50 + 40 * 20, 6);
    for (let x = 215.5; x < 285; x += 3) {
      for (let z = -679.5; z < -610; z += 3) if (onKey(x, z)) expect(patches.some((g) => rectContains(g.rect, x, z)), `ground at ${x}, ${z}`).toBe(true);
    }
    const jetty = L.decks.find((d) => d.name === KEY_NAME)!;
    expect(jetty.bridge).toBe(false);
    expect(W.groundHeight(250, -595)).toBeCloseTo(0.45, 6);
    expect(L.offshore.solids.length).toBeGreaterThan(8);
    for (const s of L.offshore.solids) {
      expect(onKey(s.minX, s.minZ) && onKey(s.maxX, s.maxZ)).toBe(true);
      expect(s.y1 - s.y0).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(s.y1 - s.y0).toBeLessThanOrEqual(2.5);
    }
    expect(L.offshore.signs.map((s) => s.lines.join(' '))).toEqual([
      'FORT CONTRABAND EST. 1887. DECOMMISSIONED 1888. REASONS CLASSIFIED.',
      'PRIVATE ISLAND. TRESPASSERS WILL BE MILDLY JUDGED.',
    ]);
  });

  it('lets a swimmer climb out at its bank', () => {
    const sim = makeSim({ seed: 3, police: false });
    teleport(sim, 236, -598);
    step(sim, 0.5);
    expect(sim.player.state).toBe('swimming');
    step(sim, 8, input({ moveZ: 1, cameraYaw: Math.PI }));
    expect(sim.player.state).toBe('normal');
    expect(onKey(sim.player.pos.x, sim.player.pos.z)).toBe(true);
    expect(sim.player.pos.y).toBeCloseTo(CURB_H, 2);
  });

  it('runs a Marlin aground at its bank and stops one at the jetty, and stops a walker at the battery wall', () => {
    const bank = marlin(270, -575, Math.PI);
    step(bank.sim, 5, input({ throttle: 1 }));
    console.log(`[offshore] Marlin at the Key's south bank: z ${bank.boat.pos.z.toFixed(2)}, ${bank.boat.speed.toFixed(2)} m/s`);
    expect(bank.boat.pos.z).toBeGreaterThan(-610 + bank.boat.halfL - 0.5);
    expect(bank.boat.speed).toBeLessThan(1);
    const jetty = marlin(225, -596, Math.PI / 2);
    step(jetty.sim, 5, input({ throttle: 1 }));
    console.log(`[offshore] Marlin at the jetty: x ${jetty.boat.pos.x.toFixed(2)}, ${jetty.boat.speed.toFixed(2)} m/s`);
    expect(jetty.boat.pos.x).toBeLessThan(248 - jetty.boat.halfL + 0.5);
    expect(jetty.boat.speed).toBeLessThan(1);
    // On foot in the fort's yard, walking north into the seaward wall.
    const sim = makeSim({ seed: 3, police: false });
    teleport(sim, 236, -660);
    step(sim, 4, input({ moveZ: 1, cameraYaw: Math.PI }));
    const wall = L.offshore.solids.find((s) => rectContains(s, 236, s.minZ + 0.1))!;
    expect(sim.player.pos.z).toBeGreaterThan(wall.maxZ);
    expect(sim.player.pos.z).toBeLessThan(wall.maxZ + 1);
  });

  it('keeps a rifle and armor in the ruins, and every older pickup where it was', () => {
    // The pickups' kinds, tags and positions as captured at 4323153, before the Key, without and with the street-crime
    // pickups, and again on the merged round-2 head, where the rises lift two of them (a package on Azura Point's
    // plateau, the molotov on Hillcrest Green's slope) and every kind, tag, x and z is main's.
    const OLDER = { false: '950bedbf0bbd77f09172e1b4e611053571d566f5f78a7dcf7364182a279897ad', true: 'd7ad99631e2572668c116b249f5ef070dde9a21b381c64a0a5492b29bcb5fecb' };
    for (const streetCrime of [false, true]) {
      const sim = new Sim({ world: new StaticWorld(), ambient: false, police: false, streetCrime });
      const older = sim.pickups.filter((p) => !p.tag.startsWith('key:'));
      expect(sha(older.map((p) => [p.kind, p.tag, p.pos.x, p.pos.y, p.pos.z]))).toBe(OLDER[`${streetCrime}`]);
      const stash = sim.pickups.filter((p) => p.tag.startsWith('key:'));
      expect(stash.map((p) => [p.tag, p.kind, p.weapon])).toEqual([['key:rifle', 'weapon', 'rifle'], ['key:armor', 'armor', null]]);
      expect(sim.pickups.slice(-2)).toEqual(stash);
      for (const p of stash) {
        expect(onKey(p.pos.x, p.pos.z)).toBe(true);
        expect(p.pos.y).toBe(CURB_H);
        expect(p.respawn).toBeGreaterThan(0);
        expect(W.isFree(p.pos.x, p.pos.z, 0.6)).toBe(true);
      }
    }
  });

  it('gets no walk node, parking bay, open spot or spawn', () => {
    expect(W.walk.nodes.filter((n) => onKey(n.x, n.z, 20))).toEqual([]);
    expect(L.parking.filter((p) => onKey(p.x, p.z, 20))).toEqual([]);
    expect(L.openSpots.filter((p) => onKey(p.x, p.z, 20))).toEqual([]);
    const sim = makeSim({ seed: 5, ambient: true, police: false });
    teleport(sim, 250, -630);
    let seen = 0;
    step(sim, 30, () => {
      seen += sim.characters.filter((c) => c !== sim.player && onKey(c.pos.x, c.pos.z, 5)).length + sim.vehicles.filter((v) => onKey(v.pos.x, v.pos.z, 5)).length;
      return input();
    });
    expect(seen).toBe(0);
  });

  it('draws the battery as broken walls no taller than its solids, with its guns, wreck and signs', () => {
    const view = new OffshoreView(W);
    const walls = view.group.getObjectByName('keyWalls') as THREE.Mesh;
    walls.geometry.computeBoundingBox();
    expect(walls.geometry.boundingBox!.max.y).toBeLessThanOrEqual(Math.max(...L.offshore.solids.map((s) => s.y1)) + 1e-6);
    for (const n of ['keyCannons', 'keyWreck', 'keySignBoards', 'keySigns']) expect(view.group.getObjectByName(n), n).toBeDefined();
    view.dispose();
  });
});
