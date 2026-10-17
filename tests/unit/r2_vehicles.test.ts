// Round 2 vehicles cluster: dents (sim and render), crash scrapes and effects, class durability and lean, see-through
// glass with a dark interior, night lamps and truthful wheels. The render modules run headless with the stub header
// copied from fix_render.test.ts: a tiny canvas/document stub and a fake WebGLRenderer.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Effects } from '../../src/render/effects';
import { GameRenderer } from '../../src/render/renderer';
import { triangulateCDT, type Pt } from '../../src/render/vehicleGeometry';
import { VehicleView, VehicleViewPool, vehicleGlass } from '../../src/render/vehicleView';
import { MAX_DENTS, type Dent, type Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { rectCX, rectCZ } from '../../src/world/layout';
import type { StaticWorld } from '../../src/world/staticWorld';
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
    // Every other 2D call is a no-op; property writes are kept.
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    compile(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const DT = 1 / 60;

/** A straight wall across a stretch of flat beach (heading 0 drives at it along +Z), and where it is. */
function beachWithWall(sim: Sim, along = false): { x: number; z: number; wall: number } {
  const b = sim.world.layout.bounds;
  const x = b.beachStartX + 30;
  const z = b.landMinZ + 120;
  if (along) {
    // A wall parallel to +Z, its face at x + 1.5.
    sim.world.grid.addBox(x + 1.5, z - 60, x + 3.5, z + 300, -5, 10, 'wall');
    return { x, z, wall: x + 1.5 };
  }
  sim.world.grid.addBox(x - 15, z + 30, x + 15, z + 32, -5, 10, 'wall');
  return { x, z, wall: z + 30 };
}

/** Drives `v` (no driver) straight at the wall at `speed` until the first impact, then lets it settle. */
function hitWall(sim: Sim, v: Vehicle, speed: number): number {
  let strength = 0;
  const off = sim.events.on('impact', (e) => {
    if (e.vehicle === v && strength === 0) strength = e.strength;
  });
  for (let i = 0; i < 240; i++) {
    if (strength === 0) {
      v.vel.x = Math.sin(v.heading) * speed;
      v.vel.z = Math.cos(v.heading) * speed;
      v.angVel = 0;
    }
    sim.update(DT, input());
  }
  off();
  return strength;
}

function meshNamed(view: VehicleView, name: string): THREE.Mesh {
  return view.group.children.find((o) => o.name === name) as THREE.Mesh;
}

function addDent(v: Vehicle, d: Dent): void {
  v.dents.push(d);
  v.dentVersion++;
}

describe('vehicle durability and dents (sim)', () => {
  it('a 15 m/s head-on wall hit costs each class its share of health', () => {
    const loss = (kind: VehicleKind): number => {
      const sim = makeSim({ police: false });
      const w = beachWithWall(sim);
      const v = sim.spawnVehicle(kind, w.x, w.z, 0);
      hitWall(sim, v, 15);
      return 1 - v.health / v.spec.health;
    };
    expect(loss('sports')).toBeGreaterThanOrEqual(0.4);
    expect(loss('sedan')).toBeGreaterThanOrEqual(0.28);
    expect(loss('sedan')).toBeLessThanOrEqual(0.38);
    expect(loss('swat')).toBeLessThanOrEqual(0.15);
    expect(loss('bus')).toBeLessThanOrEqual(0.15);
    // The table is the only difference: the same hit, scaled.
    expect(loss('sports') / loss('sedan')).toBeCloseTo(1.3, 1);
  });

  it('a sedan driven into a wall at 22 m/s gets a deep dent in its nose', () => {
    const sim = makeSim({ police: false });
    const w = beachWithWall(sim);
    const v = sim.spawnVehicle('sedan', w.x, w.z, 0);
    const version = v.dentVersion;
    expect(hitWall(sim, v, 22)).toBeGreaterThan(20);
    expect(v.dents.length).toBe(1);
    const d = v.dents[0]!;
    expect(d.lz).toBeGreaterThan(0.35 * v.spec.length);
    expect(d.depth).toBeGreaterThanOrEqual(0.2);
    expect(d.depth).toBeLessThanOrEqual(0.4);
    expect(d.ly).toBeCloseTo(0.5 * v.spec.height, 6);
    // Pushed in from the front, at the bumper's centre.
    expect(d.nz).toBeCloseTo(-1, 3);
    expect(Math.abs(d.lx)).toBeLessThan(0.3);
    expect(v.dentVersion).toBeGreaterThan(version);
  });

  it('a 15 m/s rear-end collision dents both cars, each where it was hit', () => {
    const sim = makeSim({ police: false });
    const w = beachWithWall(sim);
    const front = sim.spawnVehicle('sedan', w.x, w.z, 0);
    const back = sim.spawnVehicle('sedan', w.x, w.z - 12, 0);
    for (let i = 0; i < 120 && back.dents.length === 0; i++) {
      back.vel.z = 15;
      sim.update(DT, input());
    }
    step(sim, 0.5);
    expect(back.dents.length).toBeGreaterThan(0);
    expect(front.dents.length).toBeGreaterThan(0);
    expect(back.dents[0]!.lz).toBeGreaterThan(0);
    expect(front.dents[0]!.lz).toBeLessThan(0);
    expect(front.dents[0]!.nz).toBeGreaterThan(0.9);
    expect(back.dents[0]!.nz).toBeLessThan(-0.9);
  });

  it('keeps at most 8 dents, merging close ones into the deeper', () => {
    const sim = makeSim({ police: false });
    const w = beachWithWall(sim);
    const v = sim.spawnVehicle('bus', w.x, w.z, 0);
    // Hits all round the body, far enough apart not to merge.
    const host = sim as unknown as { onVehicleImpact: Sim['onVehicleImpact'] };
    for (let i = 0; i < 14; i++) {
      const z = -v.halfL + 0.4 + i * 0.75;
      host.onVehicleImpact(v, null, 12, v.pos.x + v.halfW, v.pos.z + z, false, -1, 0);
      expect(v.dents.length).toBeLessThanOrEqual(MAX_DENTS);
    }
    expect(v.dents.length).toBe(MAX_DENTS);
    // A harder hit right next to a dent deepens that one instead of adding another.
    const before = v.dents.map((d) => d.depth);
    const tz = v.dents[3]!.lz;
    host.onVehicleImpact(v, null, 30, v.pos.x + v.halfW, v.pos.z + tz + 0.2, false, -1, 0);
    expect(v.dents.length).toBe(MAX_DENTS);
    expect(Math.max(...v.dents.map((d) => d.depth))).toBeGreaterThan(Math.max(...before));
    // The nearest dent (0.2 m away) took the hit; its neighbours 0.55 and 0.95 m away are unchanged.
    expect(v.dents[3]!.lz).toBeCloseTo(tz + 0.2, 6);
    expect(v.dents.filter((d) => d.depth > before[0]! + 1e-9).length).toBe(1);
  });

  it('dents stay where they are on the body when the car turns', () => {
    const sim = makeSim({ police: false });
    const w = beachWithWall(sim);
    const v = sim.spawnVehicle('sedan', w.x, w.z, 0);
    hitWall(sim, v, 18);
    const d = { ...v.dents[0]! };
    placeInCar(sim, v);
    sim.cheats.godMode = true;
    step(sim, 3, input({ brake: 1, steer: 1 }));
    step(sim, 2, input({ throttle: 0.6, steer: 1 }));
    expect(Math.abs(v.heading)).toBeGreaterThan(0.5);
    expect(v.dents.length).toBe(1);
    expect(v.dents[0]).toEqual(d);
  });

  it('a landing on the roof crushes it; the player in god mode keeps his car pristine', () => {
    const sim = makeSim({ police: false });
    const w = beachWithWall(sim);
    const v = sim.spawnVehicle('sedan', w.x, w.z - 20, 0);
    v.airborne = true;
    v.pos.y += 2;
    v.vy = -6;
    v.roll = Math.PI;
    step(sim, 1);
    expect(v.flipped).toBe(true);
    const roof = v.dents.find((d) => d.ly === v.spec.height);
    expect(roof).toBeDefined();
    expect(roof!.nx).toBe(0);
    expect(roof!.nz).toBe(0);
    expect(roof!.depth).toBeGreaterThanOrEqual(0.15);

    const mine = sim.spawnVehicle('sports', w.x, w.z, 0);
    placeInCar(sim, mine);
    sim.cheats.godMode = true;
    hitWall(sim, mine, 22);
    expect(mine.health).toBe(mine.spec.health);
    expect(mine.dents.length).toBe(0);
  });

  it('a car that starts above full health keeps its dents (only a repair, health rising to full, takes them away)', () => {
    const sim = makeSim({ police: false });
    const w = beachWithWall(sim);
    // Like a vigilante suspect at level 4, 8 m short of the wall.
    const v = sim.spawnVehicle('sedan', w.x, w.wall - 10, 0);
    v.health = v.spec.health * 1.2;
    hitWall(sim, v, 6);
    expect(v.health).toBeGreaterThanOrEqual(v.spec.health);
    expect(v.dents.length).toBe(1);
    step(sim, 1);
    expect(v.dents.length).toBe(1);
  });

  it('only a landing on the roof that does damage crushes the roof', () => {
    const sim = makeSim({ police: false });
    const w = beachWithWall(sim);
    const v = sim.spawnVehicle('sedan', w.x, w.z - 20, 0);
    // Already burning on its roof: a gentle bounce does nothing more.
    sim.combat.igniteVehicle(v, 30);
    v.flipped = true;
    v.roll = Math.PI;
    v.airborne = true;
    v.pos.y += 0.3;
    v.vy = -4;
    step(sim, 0.5);
    expect(v.airborne).toBe(false);
    expect(v.dents.length).toBe(0);
  });

  it('the Spray Shack repair takes the dents out too', () => {
    const sim = makeSim({ police: false });
    const poi = sim.world.layout.pois.find((p) => p.id === 'spray_hill')!;
    const bay = poi.bay!;
    const car = sim.spawnVehicle('sedan', rectCX(bay) + Math.sin(poi.heading) * 14, rectCZ(bay) + Math.cos(poi.heading) * 14, poi.heading + Math.PI);
    placeInCar(sim, car);
    const host = sim as unknown as { onVehicleImpact: Sim['onVehicleImpact'] };
    host.onVehicleImpact(car, null, 14, car.pos.x + Math.sin(car.heading) * car.halfL, car.pos.z + Math.cos(car.heading) * car.halfL);
    expect(car.dents.length).toBe(1);
    const version = car.dentVersion;
    sim.progress.addMoney(500);
    step(sim, 0.2);
    teleport(sim, rectCX(bay), rectCZ(bay));
    step(sim, 0.5);
    expect(car.health).toBe(car.spec.health);
    expect(car.dents.length).toBe(0);
    expect(car.dentVersion).toBeGreaterThan(version);
  });
});

describe('scrapes', () => {
  it('a car grinding along a wall at 15 m/s scrapes at 5-15 Hz, at the wall; a car standing against it does not', () => {
    const sim = makeSim({ police: false });
    const w = beachWithWall(sim, true);
    const v = sim.spawnVehicle('sedan', w.wall - v0HalfW('sedan') - 0.02, w.z, 0);
    const events: Array<{ t: number; x: number; y: number; speed: number }> = [];
    sim.events.on('scrape', (e) => {
      expect(e.vehicle).toBe(v);
      events.push({ t: sim.time, x: e.x, y: e.y, speed: e.speed });
    });
    for (let i = 0; i < 120; i++) {
      // Sliding along the wall, pressed lightly against it.
      v.vel.z = 15;
      v.vel.x = 1;
      sim.update(DT, input());
    }
    const rate = events.length / 2;
    expect(rate).toBeGreaterThanOrEqual(5);
    expect(rate).toBeLessThanOrEqual(15);
    for (let i = 1; i < events.length; i++) expect(events[i]!.t - events[i - 1]!.t).toBeGreaterThanOrEqual(1 / 15 - 1e-9);
    for (const e of events) {
      expect(Math.abs(e.x - w.wall)).toBeLessThan(0.5);
      expect(e.speed).toBeGreaterThan(10);
      expect(e.y).toBeCloseTo(v.pos.y + 0.4, 1);
    }

    const still = makeSim({ police: false });
    const w2 = beachWithWall(still, true);
    // Touching the wall: its side overlaps the face by 5 cm.
    still.spawnVehicle('sedan', w2.wall - v0HalfW('sedan') + 0.05, w2.z, 0);
    let n = 0;
    still.events.on('scrape', () => n++);
    step(still, 2);
    expect(n).toBe(0);
  });

  it('two cars sideswiping each other scrape', () => {
    const sim = makeSim({ police: false });
    const w = beachWithWall(sim);
    const a = sim.spawnVehicle('sedan', w.x, w.z - 20, 0);
    const b = sim.spawnVehicle('sedan', w.x + 1.85, w.z - 10, 0);
    let n = 0;
    sim.events.on('scrape', (e) => {
      if (e.vehicle === a || e.vehicle === b) n++;
    });
    for (let i = 0; i < 90; i++) {
      a.vel.z = 16;
      a.vel.x = 0.8;
      b.vel.z = 2;
      sim.update(DT, input());
    }
    expect(n).toBeGreaterThan(0);
  });

  it('a car grinding along a parked one gets the scrape, whichever comes first in the list', () => {
    for (const parkedFirst of [true, false]) {
      const sim = makeSim({ police: false });
      const w = beachWithWall(sim);
      const spawnParked = (): Vehicle => sim.spawnVehicle('van', w.x + 2.0, w.z, 0);
      const parked = parkedFirst ? spawnParked() : null;
      const mover = sim.spawnVehicle('sedan', w.x, w.z - 8, 0);
      const other = parked ?? spawnParked();
      const who = new Set<Vehicle>();
      sim.events.on('scrape', (e) => who.add(e.vehicle));
      for (let i = 0; i < 60; i++) {
        mover.vel.z = 15;
        mover.vel.x = 0.6;
        sim.update(DT, input());
      }
      expect(who.has(mover), `parked first: ${parkedFirst}`).toBe(true);
      expect(who.has(other)).toBe(false);
    }
  });

  it('scrape reporting leaves crash results alone: a 30 m/s head-on still impacts once, identically', () => {
    const run = (listen: boolean, offset: number): { strengths: number[]; scrapes: number; state: number[] } => {
      const sim = makeSim({ police: false });
      const w = beachWithWall(sim);
      const a = sim.spawnVehicle('sedan', w.x, w.z - 20, 0);
      const b = sim.spawnVehicle('sedan', w.x + offset, w.z + 10, Math.PI);
      a.vel.z = 30;
      b.vel.z = -30;
      const strengths: number[] = [];
      let scrapes = 0;
      sim.events.on('impact', (e) => {
        if (e.vehicle === a) strengths.push(e.strength);
      });
      if (listen) sim.events.on('scrape', () => scrapes++);
      step(sim, 1.5);
      return { strengths, scrapes, state: [a.vel.x, a.vel.z, a.angVel, a.pos.x, a.pos.z, b.vel.x, b.vel.z, b.angVel, b.pos.x, b.pos.z, a.health, b.health] };
    };
    const square = run(true, 0);
    expect(square.strengths.length).toBe(1);
    expect(square.strengths[0]).toBeGreaterThan(30);
    expect(square.state).toEqual(run(false, 0).state);
    // A glancing hit: the cars mostly slide past each other, so there is something to report; the result is the same.
    const heard = run(true, 1.75);
    const quiet = run(false, 1.75);
    expect(heard.scrapes).toBeGreaterThan(0);
    expect(heard.state).toEqual(quiet.state);
    expect(heard.strengths).toEqual(quiet.strengths);
  });
});

function v0HalfW(kind: VehicleKind): number {
  return VEHICLE_SPECS[kind].width / 2;
}

describe('cap triangulation', () => {
  function area(t: Pt[]): number {
    return ((t[1]![0] - t[0]![0]) * (t[2]![1] - t[0]![1]) - (t[1]![1] - t[0]![1]) * (t[2]![0] - t[0]![0])) / 2;
  }
  function polyArea(p: readonly Pt[]): number {
    let a = 0;
    for (let i = 0; i < p.length; i++) a += p[i]![0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * p[i]![1];
    return Math.abs(a) / 2;
  }

  it('covers a polygon with a hole exactly, keeps every outline vertex and edge, and uses the interior points', () => {
    // A long body with straight runs of collinear points (which earcut alone would drop) and a window hole.
    const outer: Pt[] = [];
    for (let i = 0; i <= 12; i++) outer.push([-3 + i * 0.5, 0]);
    for (let i = 1; i <= 4; i++) outer.push([3, i * 0.4]);
    for (let i = 1; i <= 12; i++) outer.push([3 - i * 0.5, 1.6]);
    for (let i = 1; i <= 3; i++) outer.push([-3, 1.6 - i * 0.4]);
    const hole: Pt[] = [[0.5, 0.8], [2, 0.8], [2, 1.3], [0.5, 1.3]];
    const inner: Pt[] = [[-2.1, 0.6], [-1.3, 0.9], [-0.4, 0.5], [-1.0, 1.2], [1.2, 0.35]];
    const pts = [...outer, ...hole, ...inner];
    const tris = triangulateCDT(outer, [hole], inner);
    let sum = 0;
    const used = new Set<number>();
    const edges = new Set<string>();
    for (const t of tris) {
      const a = area(t.map((i) => pts[i]!));
      expect(a).toBeGreaterThan(0);
      sum += a;
      for (let k = 0; k < 3; k++) {
        used.add(t[k]!);
        const u = t[k]!;
        const v = t[(k + 1) % 3]!;
        edges.add(`${Math.min(u, v)},${Math.max(u, v)}`);
      }
    }
    expect(sum).toBeCloseTo(polyArea(outer) - polyArea(hole), 9);
    expect(used.size).toBe(pts.length);
    for (const ring of [outer.map((_, i) => i), hole.map((_, i) => outer.length + i)]) {
      for (let i = 0; i < ring.length; i++) {
        const u = ring[i]!;
        const v = ring[(i + 1) % ring.length]!;
        expect(edges.has(`${Math.min(u, v)},${Math.max(u, v)}`), `edge ${u}-${v}`).toBe(true);
      }
    }
  });

  it('every vehicle flank is watertight: its boundary is exactly the side walls\' outline, with no T-junctions', () => {
    for (const kind of Object.keys(VEHICLE_SPECS) as VehicleKind[]) {
      for (const mesh of ['body', 'glass'] as const) {
        const g = meshNamed(new VehicleView(kind), mesh).geometry;
        const pos = g.getAttribute('position');
        // The body's flanks are at the spec's half width (the pickup's bed walls stand 2 mm proud); the glass's are outermost.
        let half = 0;
        for (let i = 0; i < pos.count; i++) half = Math.max(half, Math.abs(pos.getX(i)));
        if (mesh === 'body') half = VEHICLE_SPECS[kind].width / 2;
        const key = (i: number): string => `${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
        const edge = (a: number, b: number): string => [key(a), key(b)].sort().join('|');
        for (const side of [-1, 1]) {
          const onCap = (i: number): boolean => Math.abs(pos.getX(i) - side * half) < 1e-6;
          const capCount = new Map<string, number>();
          const wall = new Set<string>();
          let area = 0;
          for (let i = 0; i < pos.count; i += 3) {
            const tri = [i, i + 1, i + 2];
            const flat = tri.filter(onCap);
            if (flat.length === 3) {
              const cr = (pos.getY(i + 1) - pos.getY(i)) * (pos.getZ(i + 2) - pos.getZ(i)) - (pos.getZ(i + 1) - pos.getZ(i)) * (pos.getY(i + 2) - pos.getY(i));
              area += Math.abs(cr) / 2;
              for (let k = 0; k < 3; k++) {
                const e = edge(tri[k]!, tri[(k + 1) % 3]!);
                capCount.set(e, (capCount.get(e) ?? 0) + 1);
              }
            } else if (flat.length === 2) {
              wall.add(edge(flat[0]!, flat[1]!));
            }
          }
          expect(area, `${kind} ${mesh}`).toBeGreaterThan(0.3);
          // Edges used once are the cap's boundary; none is used more than twice (no overlaps).
          const boundary = new Set<string>();
          for (const [e, n] of capCount) {
            expect(n, `${kind} ${mesh} ${e}`).toBeLessThanOrEqual(2);
            if (n === 1) boundary.add(e);
          }
          expect(boundary.size, `${kind} ${mesh}`).toBe(wall.size);
          for (const e of wall) expect(boundary.has(e), `${kind} ${mesh} wall edge ${e}`).toBe(true);
        }
      }
    }
  });
});

describe('vehicle views', () => {
  let W: StaticWorld;

  beforeAll(() => {
    W = world();
  });

  function spot(sim: Sim): { x: number; z: number } {
    const b = sim.world.layout.bounds;
    return { x: b.beachStartX + 30, z: (b.landMinZ + b.landMaxZ) / 2 };
  }

  it('a front dent pushes the nose back, on this view only, and rebinding the pooled view restores the shared body', () => {
    const sim = makeSim({ world: W });
    const p = spot(sim);
    const v = sim.spawnVehicle('sedan', p.x, p.z, 0);
    const other = sim.spawnVehicle('sedan', p.x + 6, p.z, 0);
    const pool = new VehicleViewPool();
    const view = pool.acquire('sedan');
    const view2 = pool.acquire('sedan');
    view.bind(v);
    view2.bind(other);
    view.sync(v, DT, 0, 0);
    view2.sync(other, DT, 0, 0);
    const shared = meshNamed(view, 'body').geometry;
    expect(meshNamed(view2, 'body').geometry).toBe(shared);
    const original = Float32Array.from(shared.getAttribute('position').array);
    const L = v.spec.length;
    const ly = 0.5 * v.spec.height;
    addDent(v, { lx: 0, ly, lz: L / 2, nx: 0, nz: -1, depth: 0.25 });
    view.sync(v, DT, 0, 0);
    view2.sync(other, DT, 0, 0);
    const dented = meshNamed(view, 'body').geometry;
    expect(dented).not.toBe(shared);
    const pos = dented.getAttribute('position');
    // The front face around the point of impact moved back.
    let near = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = original[i * 3]!;
      const y = original[i * 3 + 1]!;
      const z = original[i * 3 + 2]!;
      if (z < L / 2 - 0.05 || Math.abs(x) > 0.15 || Math.abs(y - ly) > 0.2) continue;
      near++;
      expect(z - pos.getZ(i)).toBeGreaterThanOrEqual(0.12);
    }
    expect(near).toBeGreaterThan(3);
    // Far away nothing moves; the other sedan's (shared) geometry is untouched.
    for (let i = 0; i < pos.count; i++) if (original[i * 3 + 2]! < 0) expect(pos.getZ(i)).toBe(original[i * 3 + 2]);
    expect(meshNamed(view2, 'body').geometry).toBe(shared);
    expect(Array.from(shared.getAttribute('position').array)).toEqual(Array.from(original));
    // Rebinding the pooled view to a fresh car frees the clone.
    const glassClone = meshNamed(view, 'glass').geometry;
    const spy = vi.spyOn(dented, 'dispose');
    const glassSpy = vi.spyOn(glassClone, 'dispose');
    const fresh = sim.spawnVehicle('sedan', p.x - 6, p.z, 0);
    view.bind(fresh);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(glassSpy).toHaveBeenCalledTimes(1);
    expect(meshNamed(view, 'body').geometry).toBe(shared);
    view.sync(fresh, DT, 0, 0);
    expect(meshNamed(view, 'body').geometry).toBe(shared);
    // Releasing a dented view to the pool frees its clone as well.
    view.bind(v);
    view.sync(v, DT, 0, 0);
    const again = meshNamed(view, 'body').geometry;
    expect(again).not.toBe(shared);
    const spy2 = vi.spyOn(again, 'dispose');
    pool.release(view);
    expect(spy2).toHaveBeenCalledTimes(1);
    expect(meshNamed(view, 'body').geometry).toBe(shared);
  });

  it('a side dent bends the flank itself, and a roof dent lowers the roof', () => {
    const sim = makeSim({ world: W });
    const p = spot(sim);
    const v = sim.spawnVehicle('sedan', p.x, p.z, 0);
    const view = new VehicleView('sedan');
    view.bind(v);
    view.sync(v, DT, 0, 0);
    const shared = meshNamed(view, 'body').geometry.getAttribute('position');
    const halfW = v.halfW;
    addDent(v, { lx: halfW, ly: 0.5 * v.spec.height, lz: 0, nx: -1, nz: 0, depth: 0.3 });
    view.sync(v, DT, 0, 0);
    const pos = meshNamed(view, 'body').geometry.getAttribute('position');
    // Interior flank vertices (not on its outline) near the hit move in.
    let moved = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(shared.getX(i) - halfW) > 1e-6 || Math.abs(shared.getZ(i)) > 0.3 || Math.abs(shared.getY(i) - 0.5 * v.spec.height) > 0.12) continue;
      expect(shared.getX(i) - pos.getX(i)).toBeGreaterThan(0.12);
      moved++;
    }
    expect(moved).toBeGreaterThan(0);
    // Roof dent: the painted roof panel and the glass under it come down around the hit.
    const roofTop = (name: string): number => {
      const p = meshNamed(view, name).geometry.getAttribute('position');
      let y = -Infinity;
      for (let i = 0; i < p.count; i++) if (Math.hypot(p.getX(i), p.getZ(i) + 0.3) < 0.15) y = Math.max(y, p.getY(i));
      return y;
    };
    const roofBefore = roofTop('body');
    const glassBefore = roofTop('glass');
    expect(roofBefore).toBeGreaterThan(v.spec.height);
    addDent(v, { lx: 0, ly: v.spec.height, lz: -0.3, nx: 0, nz: 0, depth: 0.3 });
    view.sync(v, DT, 0, 0);
    expect(roofBefore - roofTop('body')).toBeGreaterThan(0.15);
    expect(glassBefore - roofTop('glass')).toBeGreaterThan(0.15);
  });

  it('smashes the lamps next to a dent and leaves the others lit', () => {
    const sim = makeSim({ world: W });
    const p = spot(sim);
    const v = sim.spawnVehicle('sedan', p.x, p.z, 0);
    placeInCar(sim, v);
    const view = new VehicleView('sedan');
    view.bind(v);
    // Front left corner (local +X is the left side).
    addDent(v, { lx: v.halfW, ly: 0.5 * v.spec.height, lz: v.halfL, nx: -0.6, nz: -0.8, depth: 0.2 });
    view.sync(v, DT, 0, 1);
    const glow = (o: THREE.Mesh): number => {
      const m = o.material as THREE.MeshStandardMaterial;
      return m.emissiveIntensity * Math.max(m.emissive.r, m.emissive.g, m.emissive.b);
    };
    const heads = view.group.children.filter((o): o is THREE.Mesh => o.name === 'lamp' && o.position.z > 0 && o instanceof THREE.Mesh);
    expect(heads.length).toBe(2);
    const left = heads.find((h) => h.position.x > 0)!;
    const right = heads.find((h) => h.position.x < 0)!;
    expect(glow(left)).toBe(0);
    expect(glow(right)).toBeGreaterThan(3);
    // A fresh car in the same view has both.
    const fresh = sim.spawnVehicle('sedan', p.x + 8, p.z, 0);
    placeInCar(sim, fresh);
    view.bind(fresh);
    view.sync(fresh, DT, 0, 1);
    expect(glow(left)).toBeGreaterThan(3);
  });

  it('lamps, roof gear and the police stripe move with the dented metal under them, and come back on rebind', () => {
    const sim = makeSim({ world: W });
    const p = spot(sim);
    const v = sim.spawnVehicle('police', p.x, p.z, 0);
    const view = new VehicleView('police');
    view.bind(v);
    view.sync(v, DT, 0, 0);
    const lamp = view.group.children.find((o) => o.name === 'lamp' && o.position.z > 0 && o.position.x > 0)!;
    const lampZ = lamp.position.z;
    const stripe = view.group.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh && (o.material as THREE.MeshStandardMaterial).color?.getHex() === 0xf2f2f2)!;
    const flank = (): number => {
      const q = stripe.geometry.getAttribute('position');
      let x = -Infinity;
      for (let i = 0; i < q.count; i++) if (Math.abs(q.getZ(i) - 0.1) < 0.3 && Math.abs(q.getY(i) - 0.5 * v.spec.height) < 0.2) x = Math.max(x, q.getX(i));
      return x;
    };
    const flankX = flank();
    // A crushed front left corner and a dent in the left doors.
    addDent(v, { lx: v.halfW - 0.3, ly: 0.5 * v.spec.height, lz: v.halfL, nx: 0, nz: -1, depth: 0.35 });
    addDent(v, { lx: v.halfW, ly: 0.5 * v.spec.height, lz: 0.1, nx: -1, nz: 0, depth: 0.3 });
    view.sync(v, DT, 0, 0);
    expect(lampZ - lamp.position.z).toBeGreaterThan(0.15);
    expect(flankX - flank()).toBeGreaterThan(0.15);
    // The roof gear stays put (no dent near it).
    const fresh = sim.spawnVehicle('police', p.x + 8, p.z, 0);
    view.bind(fresh);
    view.sync(fresh, DT, 0, 0);
    expect(lamp.position.z).toBe(lampZ);
    expect(flank()).toBeCloseTo(flankX, 6);
  });

  it('wrecks sag and lose their glass; damaged cars get cracked, then shattered glass', () => {
    const sim = makeSim({ world: W });
    const p = spot(sim);
    const intact = sim.spawnVehicle('sedan', p.x, p.z, 0.3);
    const wreck = sim.spawnVehicle('sedan', p.x, p.z, 0.3);
    wreck.pos.y = intact.pos.y;
    wreck.destroyed = true;
    const a = new VehicleView('sedan');
    const b = new VehicleView('sedan');
    a.bind(intact);
    b.bind(wreck);
    a.sync(intact, DT, 0, 0);
    b.sync(wreck, DT, 0, 0);
    expect(a.group.position.y - b.group.position.y).toBeGreaterThanOrEqual(0.1);
    expect(Math.abs(b.group.rotation.z)).toBeCloseTo(0.05, 3);
    expect(meshNamed(b, 'glass').visible).toBe(false);
    expect(meshNamed(a, 'glass').visible).toBe(true);
    const glass = (): THREE.Material => meshNamed(a, 'glass').material as THREE.Material;
    expect(glass()).toBe(vehicleGlass.intact);
    intact.health = intact.spec.health * 0.4;
    a.sync(intact, DT, 0, 0);
    expect(glass()).toBe(vehicleGlass.cracked);
    intact.health = intact.spec.health * 0.2;
    a.sync(intact, DT, 0, 0);
    expect(glass()).toBe(vehicleGlass.shattered);
    // The pooled wreck view comes back whole for the next car.
    b.bind(intact);
    intact.health = intact.spec.health;
    b.sync(intact, DT, 0, 0);
    expect(meshNamed(b, 'glass').visible).toBe(true);
    expect(meshNamed(b, 'glass').material).toBe(vehicleGlass.intact);
    expect(a.group.position.y - b.group.position.y).toBeCloseTo(0, 6);
  });

  it('see-through tinted glass over a dark interior, in the same meshes', () => {
    for (const m of [vehicleGlass.intact, vehicleGlass.cracked, vehicleGlass.shattered]) {
      expect(m.transparent).toBe(true);
      expect(m.opacity).toBeGreaterThanOrEqual(0.4);
      expect(m.opacity).toBeLessThanOrEqual(0.7);
      expect(m.depthWrite).toBe(false);
    }
    expect(vehicleGlass.cracked.map).not.toBe(vehicleGlass.shattered.map);
    for (const kind of ['sedan', 'compact', 'sports', 'pickup', 'police'] as const) {
      const view = new VehicleView(kind);
      const s = VEHICLE_SPECS[kind];
      const body = meshNamed(view, 'body');
      expect((body.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
      const col = body.geometry.getAttribute('color');
      const pos = body.geometry.getAttribute('position');
      const glass = new THREE.Box3().setFromBufferAttribute(meshNamed(view, 'glass').geometry.getAttribute('position') as THREE.BufferAttribute);
      let dark = 0;
      for (let i = 0; i < pos.count; i++) {
        if (col.getX(i) > 0.1) continue;
        const inCabin = Math.abs(pos.getX(i)) < glass.max.x && pos.getY(i) > glass.min.y && pos.getZ(i) > glass.min.z && pos.getZ(i) < glass.max.z;
        if (inCabin) dark++;
      }
      expect(dark, kind).toBeGreaterThan(100);
      // Paint everywhere else: the body is mostly shade 1.
      let paint = 0;
      for (let i = 0; i < col.count; i++) if (col.getX(i) === 1) paint++;
      expect(paint / col.count, kind).toBeGreaterThan(0.5);
      expect(s.width).toBeGreaterThan(0);
    }
  });

  it('a van rolls at least 1.5 times as much as the sports car in the same corner', () => {
    const sim = makeSim({ world: W });
    const p = spot(sim);
    const roll = (kind: VehicleKind): number => {
      const v = sim.spawnVehicle(kind, p.x, p.z, 0);
      const view = new VehicleView(kind);
      view.bind(v);
      v.forwardSpeed = 15;
      v.angVel = -0.5;
      for (let i = 0; i < 120; i++) view.sync(v, DT, 0, 0);
      return Math.abs(view.group.rotation.z);
    };
    expect(roll('van')).toBeGreaterThanOrEqual(1.5 * roll('sports'));
    expect(roll('sports')).toBeGreaterThan(0.01);
  });

  it('front wheels steer like the physics and wheels spin by their own radius', () => {
    const sim = makeSim({ world: W });
    const p = spot(sim);
    for (const kind of Object.keys(VEHICLE_SPECS) as VehicleKind[]) {
      const v = sim.spawnVehicle(kind, p.x, p.z, 0);
      const view = new VehicleView(kind);
      view.bind(v);
      const front = (): number => {
        let yaw = 0;
        view.group.traverse((o) => {
          if (o.name === 'tire' && o.parent && o.parent.position.z > 0) yaw = o.parent.rotation.y;
        });
        return yaw;
      };
      v.steer = 1;
      v.forwardSpeed = 55;
      view.sync(v, DT, 0, 0);
      expect(Math.abs(front()), kind).toBeLessThanOrEqual(THREE.MathUtils.degToRad(10));
      // Steering right (+1) turns the wheels to the right: negative yaw.
      expect(front()).toBeLessThan(0);
      v.forwardSpeed = 0;
      view.sync(v, DT, 0, 0);
      expect(Math.abs(front()), kind).toBeCloseTo(0.85 * v.spec.steer, 6);
    }
    const bus = sim.spawnVehicle('bus', p.x, p.z, 0);
    const view = new VehicleView('bus');
    view.bind(bus);
    bus.forwardSpeed = 9;
    bus.wheelSpin = 123;
    for (let i = 0; i < 120; i++) view.sync(bus, DT, 0, 0);
    const distance = 9 * 2;
    let spins = 0;
    view.group.traverse((o) => {
      if (o.name !== 'rim') return;
      expect(o.rotation.x).toBeCloseTo(distance / 0.5, 4);
      spins++;
    });
    expect(spins).toBe(4);
  });

  it('tail lamps: dim red running lights at night, bright red when braking, faint when off', () => {
    const sim = makeSim({ world: W });
    const p = spot(sim);
    const v = sim.spawnVehicle('sedan', p.x, p.z, 0);
    placeInCar(sim, v);
    const view = new VehicleView('sedan');
    view.bind(v);
    const tail = view.group.children.find((o): o is THREE.Mesh => o.name === 'lamp' && o instanceof THREE.Mesh && o.position.z < 0 && o.position.x > 0)!;
    const mat = (): THREE.MeshStandardMaterial => tail.material as THREE.MeshStandardMaterial;
    view.sync(v, DT, 0, 1);
    expect(mat().emissive.getHex()).toBe(0xff0000);
    expect(mat().color.getHex()).toBe(0x2a0000);
    expect(mat().emissiveIntensity).toBeCloseTo(1.2, 6);
    v.braking = true;
    view.sync(v, DT, 0, 1);
    expect(mat().emissiveIntensity).toBeCloseTo(1.8, 6);
    v.braking = false;
    view.sync(v, DT, 0, 0);
    expect(mat().emissiveIntensity).toBeCloseTo(0.3, 6);
  });
});

describe('crash effects', () => {
  let W: StaticWorld;
  let R: GameRenderer;

  beforeAll(() => {
    W = world();
    R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'low', fov: 68 });
  });

  function settle(): void {
    for (let i = 0; i < 120; i++) R.render(0.1, false);
  }

  it('sparks fly where a car scrapes, glass where it hits hard', () => {
    const fx = new Effects();
    fx.sparks(0, 1, 0, 8);
    fx.update(DT, 0);
    expect(fx.particleCount).toBe(8);
    const sim = makeSim({ world: W });
    R.attach(sim);
    settle();
    expect(R.effects.particleCount).toBe(0);
    const v = sim.vehicles[0] ?? sim.spawnVehicle('sedan', sim.player.pos.x + 5, sim.player.pos.z, 0);
    sim.events.emit('scrape', { x: v.pos.x, y: v.pos.y + 0.4, z: v.pos.z, speed: 15, vehicle: v });
    R.render(DT, false);
    expect(R.effects.particleCount).toBeGreaterThan(0);
    settle();
    sim.events.emit('impact', { x: v.pos.x, y: v.pos.y + 0.6, z: v.pos.z, strength: 16, vehicle: v });
    R.render(DT, false);
    expect(R.effects.particleCount).toBeGreaterThan(10);
    expect(R.effects.partCount).toBe(0);
  });

  it('hard hits knock 1-3 parts off in the car\'s colour; they land on the road and go after a while', () => {
    const sim = makeSim({ world: W });
    R.attach(sim);
    settle();
    const p = sim.player.pos;
    const v = sim.spawnVehicle('sedan', p.x + 5, p.z, 0, 0xc0392b);
    const parts = (R.effects as unknown as { parts: { mesh: THREE.InstancedMesh } }).parts.mesh;
    for (const strength of [21, 30, 60]) {
      sim.events.emit('impact', { x: v.pos.x, y: v.pos.y + 0.6, z: v.pos.z + v.halfL, strength, vehicle: v });
      R.render(DT, false);
      const n = R.effects.partCount;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
      expect(parts.count).toBe(n);
      const c = new THREE.Color();
      parts.getColorAt(0, c);
      expect(c.getHex()).toBe(0xc0392b);
      // Let them fly, land and lie still.
      for (let i = 0; i < 60; i++) R.render(0.05, false);
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        parts.getMatrixAt(i, m);
        pos.setFromMatrixPosition(m);
        const ground = sim.world.groundHeight(pos.x, pos.z);
        expect(pos.y).toBeGreaterThan(ground);
        expect(pos.y).toBeLessThan(ground + 0.5);
      }
      for (let i = 0; i < 40; i++) R.render(0.25, false);
      expect(R.effects.partCount).toBe(0);
      expect(parts.count).toBe(0);
    }
    // Not for a person hit by a car, nor a light bump.
    sim.events.emit('impact', { x: v.pos.x, y: v.pos.y + 0.6, z: v.pos.z, strength: 19, vehicle: v });
    sim.events.emit('impact', { x: v.pos.x, y: v.pos.y + 0.6, z: v.pos.z, strength: 40, vehicle: null });
    R.render(DT, false);
    expect(R.effects.partCount).toBe(0);
  });

  it('god mode keeps the player\'s car whole and a wreck has no glass to shed', () => {
    const sim = makeSim({ world: W });
    R.attach(sim);
    settle();
    const p = sim.player.pos;
    const other = sim.spawnVehicle('sedan', p.x - 10, p.z, 0);
    const hit = (v: Vehicle, strength: number): number => {
      settle();
      sim.events.emit('impact', { x: v.pos.x, y: v.pos.y + 0.6, z: v.pos.z + v.halfL, strength, vehicle: v });
      R.render(DT, false);
      return R.effects.particleCount;
    };
    // Dust from any hard knock (the existing debris), glass on top of it from 15 up.
    const dust = hit(other, 12);
    expect(dust).toBeGreaterThan(0);
    expect(hit(other, 18)).toBeGreaterThan(dust);
    const mine = sim.spawnVehicle('sedan', p.x + 5, p.z, 0);
    placeInCar(sim, mine);
    sim.cheats.godMode = true;
    expect(hit(mine, 40)).toBe(dust);
    expect(R.effects.partCount).toBe(0);
    const wreck = sim.spawnVehicle('sedan', p.x - 5, p.z, 0);
    wreck.destroyed = true;
    expect(hit(wreck, 18)).toBe(dust);
  });

  it('sparks stay on the face being scraped, behind the contact, and parts start at it', () => {
    const fx = new Effects();
    const glow = (fx as unknown as { glow: { max: number; life: Float32Array; px: Float32Array; pz: Float32Array } }).glow;
    const live = (): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      for (let i = 0; i < glow.max; i++) if (glow.life[i]! > 0) out.push([glow.px[i]!, glow.pz[i]!]);
      return out;
    };
    const sim = makeSim({ world: W });
    const v = sim.spawnVehicle('sedan', 0, 0, 0);
    v.pos.x = 0;
    v.pos.z = 0;
    // Sliding sideways into a wall on its left (+X) side: the sparks stay at the contact, not inside the body.
    v.vel.x = 12;
    v.vel.z = 0;
    fx.scrapeSparks(v, v.halfW, 0.5, 0.2, 12);
    for (const [x, z] of live()) {
      expect(x).toBeGreaterThan(v.halfW - 0.2);
      expect(Math.abs(z - 0.2)).toBeLessThan(0.2);
    }
    // Driving forward along it: shed behind the contact along the flank, within its length.
    const fx2 = new Effects();
    const glow2 = (fx2 as unknown as { glow: typeof glow }).glow;
    v.vel.x = 0.5;
    v.vel.z = 15;
    fx2.scrapeSparks(v, v.halfW, 0.5, 0, 15);
    let n = 0;
    for (let i = 0; i < glow2.max; i++) {
      if (glow2.life[i]! <= 0) continue;
      n++;
      expect(glow2.px[i]!).toBeGreaterThan(v.halfW - 0.2);
      expect(glow2.pz[i]!).toBeLessThan(0.2);
      expect(glow2.pz[i]!).toBeGreaterThan(-v.halfL - 0.2);
    }
    expect(n).toBeGreaterThan(5);
    // Parts start at the contact, not inside the nose.
    const fx3 = new Effects();
    v.vel.x = 0;
    v.vel.z = -3;
    fx3.shedParts(v, 0, 0.6, v.halfL, 40, () => 0);
    fx3.update(1e-4, 0);
    const parts = (fx3 as unknown as { parts: { mesh: THREE.InstancedMesh } }).parts.mesh;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    expect(parts.count).toBe(3);
    for (let i = 0; i < parts.count; i++) {
      parts.getMatrixAt(i, m);
      pos.setFromMatrixPosition(m);
      expect(Math.abs(pos.z - v.halfL)).toBeLessThan(0.3);
    }
  });

  it('a siren lights the street without washing it out at night', () => {
    const sim = makeSim({ world: W });
    sim.clock.set(23);
    R.attach(sim);
    const p = sim.player.pos;
    const cop = sim.spawnVehicle('police', p.x + 6, p.z, 0);
    cop.siren = true;
    R.cameraCtl.mode = 'play';
    R.cameraCtl.reset(sim);
    R.render(DT, false);
    const night = R.env.night;
    expect(night).toBeGreaterThan(0.9);
    const siren = (R as unknown as { siren: THREE.PointLight }).siren;
    expect(siren.intensity).toBeCloseTo(30 + 50 * night, 6);
  });
});
