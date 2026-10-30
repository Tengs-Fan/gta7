// Mission 3 track C: the sculpted motorbikes (render/bikeModels.ts, drawn by BikeView) and the boat hulls
// (render/boatModels.ts, drawn by BoatView) with their waterline foam, riders posed on the new parts, fades that cover
// every part, and the draw budgets. The models are procedural (no assets needed).

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BikeView, bikeKinds } from '../../src/render/bikeView';
import { bikeModel, headFrame, TREAD } from '../../src/render/bikeModels';
import { boatModel, mooredBoat, mooredBoatGeometry } from '../../src/render/boatModels';
import { BoatView, boatKinds, FOAM_LIFT, foamMaterial, seaHeightAt } from '../../src/render/boatView';
import { seaUniforms, updateSea } from '../../src/render/sea';
import { HEAD_OFF, vehicleGlass } from '../../src/render/vehicleView';
import { WATER_Y } from '../../src/world/constants';
import { BOAT_CABIN, BOAT_DECK, BOAT_HULL, BOAT_ROOF } from '../../src/world/staticWorld';
import { CrowdView } from '../../src/render/crowd';
import { riderMount } from '../../src/render/riders';
import { partGeometry, partsOf, triangles } from '../../src/render/shapeKit';
import { PART_LAYER, SHADOW_LAYER, VehiclePartBatches } from '../../src/render/vehicleBatches';
import type { Character, Vehicle } from '../../src/sim/entities';
import { SKELETON } from '../../src/sim/pose';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { segmentJoints } from '../support/crowdJoints';
import { makeSim, world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

const log = (s: string) => console.log(`[m3-bikes-boats] ${s}`);

/** The meshes a camera draws (not batched, not shadow-only) and the ones that cast the sun's shadow. */
function drawCensus(group: THREE.Object3D): { main: THREE.Mesh[]; casters: THREE.Mesh[]; batched: THREE.Mesh[] } {
  const main: THREE.Mesh[] = [];
  const casters: THREE.Mesh[] = [];
  const batched: THREE.Mesh[] = [];
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.userData.batched || o.layers.isEnabled(PART_LAYER)) batched.push(o);
    else if (!o.layers.isEnabled(SHADOW_LAYER)) main.push(o);
    if (o.castShadow && !o.userData.batched) casters.push(o);
  });
  return { main, casters, batched };
}

function positions(g: THREE.BufferGeometry): THREE.Vector3[] {
  const p = g.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i));
}

function bbox(g: THREE.BufferGeometry): THREE.Box3 {
  return new THREE.Box3().setFromPoints(positions(g));
}

/** Distinct face normal directions (rounded): an axis-aligned box has 6. */
function normalDirections(g: THREE.BufferGeometry): number {
  const p = positions(g);
  const set = new Set<string>();
  for (let i = 0; i + 2 < p.length; i += 3) {
    const n = p[i + 1]!.clone().sub(p[i]!).cross(p[i + 2]!.clone().sub(p[i]!));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    set.add(`${n.x.toFixed(1)},${n.y.toFixed(1)},${n.z.toFixed(1)}`);
  }
  return set.size;
}

function riddenBike(kind: VehicleKind, appearance: Partial<Character['appearance']> = {}): { sim: Sim; v: Vehicle; c: Character } {
  const sim = makeSim({ world: world() });
  const b = sim.world.layout.bounds;
  const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0.4);
  const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
  Object.assign(c.appearance, appearance);
  sim.seat(c, v, 0);
  return { sim, v, c };
}

describe('sculpted motorbikes (VAL-BKB-001)', () => {
  it.each(bikeKinds())('the %s has lugged tyres, spoked rims, two fork tubes, a shaped tank or body, a seat, bars and two mirrors', (kind) => {
    const m = bikeModel(kind);
    // Tyres: the crown's radius varies by the tread depth (at least 3 mm) round the circumference, in TREAD.lugs lugs.
    const tyre = positions(m.tyre);
    const crown = tyre.filter((p) => Math.abs(p.x) < 0.01);
    const radii = crown.map((p) => Math.hypot(p.y, p.z));
    const span = Math.max(...radii) - Math.min(...radii);
    const angles = crown.map((p) => Math.atan2(p.z, p.y));
    const grooves = new Set(crown.filter((_, i) => radii[i]! < Math.max(...radii) - 0.003).map((_, i) => angles[i]!.toFixed(3))).size;
    expect(span).toBeGreaterThanOrEqual(0.003);
    expect(TREAD.lugs).toBeGreaterThanOrEqual(24);
    expect(grooves).toBeGreaterThanOrEqual(24);
    // Rims: spokes.
    for (const rim of [m.frontRim, m.rearRim]) expect(partsOf(rim).filter((p) => p.name.startsWith('spoke')).length).toBeGreaterThanOrEqual(5);
    // Fork: two tubes, one each side of the front wheel (in the steering head's frame x is still across the bike).
    const tyreHalf = (m.frontTyreScale * TREAD.halfWidth);
    for (const side of ['L', 'R'] as const) {
      const g = partGeometry(m.steer, `forkTube${side}`)!;
      expect(g, `${kind} fork tube ${side}`).not.toBeNull();
      const b = bbox(g);
      if (side === 'L') expect(b.min.x).toBeGreaterThan(tyreHalf);
      else expect(b.max.x).toBeLessThan(-tyreHalf);
    }
    // The tank (sport) or the body panels (scooter): shaped, not a box.
    const shaped = m.style === 'sport' ? ['tank', 'fairing'] : ['legShield', 'rearBody'];
    for (const name of shaped) {
      const g = partGeometry(m.painted, name)!;
      expect(g, `${kind} ${name}`).not.toBeNull();
      expect(triangles(g)).toBeGreaterThanOrEqual(40);
      expect(normalDirections(g)).toBeGreaterThan(20);
    }
    expect(partGeometry(m.frame, 'seat')).not.toBeNull();
    const bars = partsOf(m.steer).filter((p) => /^(clipOn|bar|grip)[LR]$/.test(p.name)).map((p) => p.name);
    expect(bars).toEqual(expect.arrayContaining(['gripL', 'gripR']));
    expect(bars.some((n) => n.startsWith('clipOn') || n.startsWith('bar'))).toBe(true);
    const mirrorsIn = m.style === 'sport' ? m.frame : m.steer;
    expect(bbox(partGeometry(mirrorsIn, 'mirrorL')!).min.x).toBeGreaterThan(0.1);
    expect(bbox(partGeometry(mirrorsIn, 'mirrorR')!).max.x).toBeLessThan(-0.1);
    // The whole model's triangles (both tyres and rims counted once each).
    const total = triangles(m.painted) + triangles(m.frame) + triangles(m.steer) + 2 * triangles(m.tyre) + triangles(m.frontRim) + triangles(m.rearRim);
    log(`${kind}: painted ${triangles(m.painted)}, frame ${triangles(m.frame)}, steer ${triangles(m.steer)}, tyre ${triangles(m.tyre)} x2, rims ${triangles(m.frontRim)}/${triangles(m.rearRim)}, shadow proxy ${triangles(m.shadow)}; total ${total}; tread ${span.toFixed(4)} m over ${grooves} grooves; spokes ${m.spokes}`);
    expect(total).toBeGreaterThanOrEqual(2000);
    expect(total).toBeLessThanOrEqual(20000);
  });

  it.each(bikeKinds())('the detailed %s draws at most 6 meshes of its own and casts its shadow with at most 2', (kind) => {
    const view = new BikeView(kind);
    const c = drawCensus(view.group);
    log(`${kind}: ${c.main.length} main-pass meshes (${c.main.map((m) => m.name).join(', ')}), ${c.casters.length} shadow caster(s), ${c.batched.length} batched parts`);
    expect(c.main.length).toBeLessThanOrEqual(6);
    expect(c.casters.length).toBeLessThanOrEqual(2);
    expect(c.casters.length).toBeGreaterThanOrEqual(1);
  });
});

describe('riders on the new bikes (VAL-BKB-004)', () => {
  /** The trunk's tilt off the bike's vertical (rad) as drawn: the d98da7b seats leaned it by these reclines. */
  const D98_RECLINE: Record<string, number> = { sportbike: -0.6, scooter: 0.05 };

  it.each(bikeKinds())('on the %s the wrists hold the grips, the soles rest on the pegs and the pelvis sits on the seat, upright and at full lean', (kind) => {
    const m = bikeModel(kind);
    const cap = VEHICLE_SPECS[kind].bike!.leanCap;
    const rows: string[] = [];
    for (const height of [0.9, 1, 1.07]) {
      for (const lean of [0, cap, -cap]) {
        const { v, c } = riddenBike(kind, { height, build: 1.05 });
        v.lean = lean;
        const view = new BikeView(kind);
        view.bind(v);
        view.sync(v, 1 / 60, 0, 0);
        const seg = new CrowdView();
        seg.sync([c], v.pos.x + 6, v.pos.z, 1 / 60);
        const frame = riderMount(v)!.frame;
        const inv = frame.matrixWorld.clone().invert();
        const H = headFrame(m.headY, m.headZ, m.rake);
        const grips = m.grips.map((g) => g.clone().applyMatrix4(H));
        const check = (label: string, joints: Map<string, THREE.Vector3>): void => {
          const j = (n: string) => joints.get(n)!.clone().applyMatrix4(inv);
          const wrist = [j('wristL').distanceTo(grips[0]!), j('wristR').distanceTo(grips[1]!)];
          const up = new THREE.Vector3(0, 1, 0);
          const sole = (n: string) => j(n).addScaledVector(up, -SKELETON.ankleY * height);
          const feet = [sole('ankleL').distanceTo(m.pegs[0]!), sole('ankleR').distanceTo(m.pegs[1]!)];
          const pelvis = j('pelvis');
          const above = pelvis.y - m.seatTop[0];
          const trunk = j('neck').sub(pelvis);
          const tilt = Math.atan2(-trunk.z, trunk.y);
          rows.push(`${label} h${height} lean ${lean.toFixed(2)}: wrists ${wrist.map((d) => (d * 100).toFixed(1)).join('/')} cm, soles ${feet.map((d) => (d * 100).toFixed(1)).join('/')} cm, pelvis ${(above * 100).toFixed(1)} cm over the seat, trunk ${((tilt * 180) / Math.PI).toFixed(1)} deg`);
          for (const d of wrist) expect(d, `${kind} ${label} h${height} lean ${lean} wrist`).toBeLessThanOrEqual(0.04);
          for (const d of feet) expect(d, `${kind} ${label} h${height} lean ${lean} sole`).toBeLessThanOrEqual(0.06);
          expect(above).toBeGreaterThanOrEqual(0);
          expect(above).toBeLessThanOrEqual(0.03);
          expect(Math.abs(tilt - D98_RECLINE[kind]!)).toBeLessThanOrEqual((3 * Math.PI) / 180);
        };
        check('segments', segmentJoints(seg, c));
      }
    }
    log(`${kind}:\n  ${rows.join('\n  ')}`);
  });

  it('the hands follow the grips as the bars turn', () => {
    for (const kind of bikeKinds()) {
      const { v } = riddenBike(kind);
      v.steer = 1;
      const view = new BikeView(kind);
      view.bind(v);
      view.sync(v, 1 / 60, 0, 0);
      const seat = riderMount(v)!.seats[0]!;
      const m = bikeModel(kind);
      const steerAt = view.group.getObjectByName('fork')!.parent!;
      for (let i = 0; i < 2; i++) {
        const hand = new THREE.Vector3(seat.hands[i]!.x, seat.hands[i]!.y, seat.hands[i]!.z).applyMatrix4(riderMount(v)!.frame.matrixWorld);
        const want = m.handsOnBars[i]!.clone().applyMatrix4(steerAt.matrixWorld);
        expect(hand.distanceTo(want)).toBeLessThan(1e-6);
      }
    }
  });
});

describe('parked bike lamps', () => {
  it.each(bikeKinds())('a parked %s has its head lamp unlit by day and glimmering at night, as a parked car does', (kind) => {
    const sim = makeSim({ world: world() });
    const b = sim.world.layout.bounds;
    const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0.4);
    const view = new BikeView(kind);
    view.bind(v);
    const head = (night: number) => {
      view.sync(v, 1 / 60, 0, night);
      return (view as unknown as { headMat: THREE.MeshStandardMaterial }).headMat.emissiveIntensity;
    };
    expect(head(0)).toBe(0);
    expect(head(1)).toBeCloseTo(HEAD_OFF, 6);
    expect(head(0.5)).toBeCloseTo(HEAD_OFF * 0.5, 6);
  });
});

describe('bike draws and fades (VAL-BKB-005)', () => {
  it.each(bikeKinds())('every own mesh of the %s and its shadow follow the fade, and its batched parts carry the same level', (kind) => {
    const { v } = riddenBike(kind);
    const view = new BikeView(kind);
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    const own = drawCensus(view.group);
    view.beginFade();
    for (const f of [0, 0.5, 1]) {
      view.setFade(f);
      for (const mesh of [...own.main, ...own.casters]) {
        const mat = mesh.material as THREE.Material;
        expect(mat.alphaHash || mat.transparent, `${kind} ${mesh.name}`).toBe(true);
        if (!mat.transparent) expect(mat.opacity, `${kind} ${mesh.name} at ${f}`).toBeCloseTo(f, 6);
        if (mesh.castShadow) expect((mesh.customDepthMaterial as THREE.MeshDepthMaterial).opacity).toBe(f);
      }
      expect(view.group.visible).toBe(f > 0);
      const batches = new VehiclePartBatches();
      batches.begin();
      view.drawParts(batches);
      batches.end();
      const fades: number[] = [];
      for (const o of batches.group.children) {
        const mesh = o as THREE.InstancedMesh;
        if (!mesh.visible) continue;
        const a = mesh.geometry.getAttribute('instanceFade');
        for (let i = 0; i < mesh.count; i++) fades.push(a.getX(i));
      }
      expect(fades.length).toBe(4 + (bikeModel(kind).headLamps.length + 1));
      for (const x of fades) expect(x).toBeCloseTo(f, 6);
      batches.dispose();
    }
    const used = view.endFade();
    for (const m of used) m.dispose();
  });
});

// ---------------------------------------------------------------------------
// Boats

/** The x extent where geometry `g` crosses the plane z (from its triangles' edges). */
function sliceX(g: THREE.BufferGeometry, z: number): [number, number] {
  const p = positions(g);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const t = [p[i]!, p[i + 1]!, p[i + 2]!];
    for (let e = 0; e < 3; e++) {
      const a = t[e]!;
      const b = t[(e + 1) % 3]!;
      if ((a.z - z) * (b.z - z) > 0 || a.z === b.z) continue;
      const x = a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  return [lo, hi];
}

function parkedBoat(kind: VehicleKind, seated = true): { sim: Sim; v: Vehicle; c: Character } {
  const sim = makeSim({ world: world() });
  const v = sim.spawnVehicle(kind, 700, -200, 0.3);
  v.pos.y = WATER_Y;
  const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
  if (seated) sim.seat(c, v, 0);
  return { sim, v, c };
}

describe('boat hulls (VAL-BKB-002)', () => {
  it.each(boatKinds())('the %s hull has a vee bottom, a bow drawn to a stem, rails along both gunwales and seats', (kind) => {
    const m = boatModel(kind);
    const L = m.hull.length;
    // Vee: the bottom's section nearest mid-length, keel on the centreline, deadrise keel to chine.
    const bottom = partGeometry(m.fittings, 'bottom')!;
    const zs = [...new Set(positions(bottom).map((p) => +p.z.toFixed(4)))].sort((a, b) => Math.abs(a) - Math.abs(b));
    const zm = zs[0]!;
    const sec = positions(bottom).filter((p) => Math.abs(p.z - zm) < 1e-3);
    const keel = sec.reduce((a, b) => (b.y < a.y ? b : a));
    const chine = sec.reduce((a, b) => (b.x > a.x ? b : a));
    const deadrise = (Math.atan2(chine.y - keel.y, chine.x) * 180) / Math.PI;
    expect(Math.abs(keel.x)).toBeLessThan(1e-6);
    expect(deadrise).toBeGreaterThanOrEqual(8);
    expect(deadrise).toBeLessThanOrEqual(30);
    // Bow: the beam 95% of the way from the transom against the widest, for the hull and for everything drawn.
    const hullParts = [partGeometry(m.painted, 'topsides') ?? partGeometry(m.fittings, 'topsides')!, bottom];
    const beamAt = (gs: THREE.BufferGeometry[], z: number) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const g of gs) {
        const [a, b] = sliceX(g, z);
        lo = Math.min(lo, a);
        hi = Math.max(hi, b);
      }
      return hi - lo;
    };
    const z95 = -L / 2 + 0.95 * L;
    const all = [m.painted, m.fittings];
    const maxHull = Math.max(...[-0.2, 0, 0.2].map((f) => beamAt(hullParts, f * L)));
    const maxAll = Math.max(...[-0.2, 0, 0.2].map((f) => beamAt(all, f * L)));
    const hullRatio = beamAt(hullParts, z95) / maxHull;
    const allRatio = beamAt(all, z95) / maxAll;
    expect(hullRatio).toBeLessThanOrEqual(0.25);
    expect(allRatio).toBeLessThanOrEqual(0.25);
    // Rails or grab lines on both sides, over at least 40% of the length together.
    const rails = partsOf(m.fittings).filter((p) => /^(bowRail|grabRail|grabLine)[LR]$/.test(p.name));
    const cover: Record<string, number> = { L: 0, R: 0 };
    for (const r of rails) {
      const b = bbox(partGeometry(m.fittings, r.name)!);
      cover[r.name.endsWith('L') ? 'L' : 'R'] += b.max.z - b.min.z;
      expect((r.name.endsWith('L') ? 1 : -1) * (b.min.x + b.max.x), r.name).toBeGreaterThan(0);
    }
    expect(cover.L! / L).toBeGreaterThanOrEqual(0.4);
    expect(cover.R! / L).toBeGreaterThanOrEqual(0.4);
    const seatNames = m.style === 'speedboat' ? ['seatHelm', 'seatMate', 'bench'] : ['thwart0', 'thwart1'];
    for (const n of seatNames) expect(partGeometry(m.fittings, n), `${kind} ${n}`).not.toBeNull();
    // The outboard: cowling, leg and propeller, well over a box's triangles.
    const ob = m.outboard.map((n) => partGeometry(m.fittings, n)!);
    const obTris = ob.reduce((s, g) => s + triangles(g), 0);
    expect(m.outboard).toEqual(expect.arrayContaining(['cowling', 'leg', 'propHub', 'propBlade0', 'propBlade1', 'propBlade2']));
    expect(obTris).toBeGreaterThanOrEqual(150);
    const total = triangles(m.painted) + triangles(m.fittings) + (m.glass ? triangles(m.glass) : 0);
    log(`${kind}: deadrise ${deadrise.toFixed(1)} deg at z ${zm.toFixed(2)}; beam at 95% ${(hullRatio * 100).toFixed(0)}% of the hull's (${(allRatio * 100).toFixed(0)}% with everything); rails cover ${((cover.L! / L) * 100).toFixed(0)}%/${((cover.R! / L) * 100).toFixed(0)}% of the length; seats ${seatNames.join(', ')}; outboard ${obTris} triangles (${m.outboard.join(', ')}); model ${total} triangles, shadow proxy ${triangles(m.shadow)}, foam ring ${m.waterline.length * 6} triangles`);
  });

  it('the speedboat windscreen is the cars\' tinted, env-reflecting glass', () => {
    const view = new BoatView('speedboat');
    const glass = view.group.getObjectByName('glass') as THREE.Mesh;
    expect(glass).toBeTruthy();
    expect(glass.material).toBe(vehicleGlass.intact);
    const mat = glass.material as THREE.MeshStandardMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeLessThan(1);
    expect(mat.roughness).toBeLessThan(0.1);
    expect(mat.envMapIntensity).toBeGreaterThan(0);
  });

  it.each(boatKinds())('the detailed %s draws at most 6 meshes of its own and casts its shadow with at most 2', (kind) => {
    const c = drawCensus(new BoatView(kind).group);
    log(`${kind}: ${c.main.length} main-pass meshes (${c.main.map((m) => m.name).join(', ')}), ${c.casters.length} shadow caster(s), ${c.batched.length} batched parts`);
    expect(c.main.length).toBeLessThanOrEqual(6);
    expect(c.casters.length).toBeLessThanOrEqual(2);
  });

  it('the Marina\'s moored cruisers are the new hull inside the sim\'s hull and cabin boxes', () => {
    const g = mooredBoatGeometry();
    const b = bbox(g.painted).union(bbox(g.fittings));
    log(`moored cruiser: ${triangles(g.painted) + triangles(g.fittings)} triangles, x ${b.min.x.toFixed(2)}..${b.max.x.toFixed(2)}, z ${b.min.z.toFixed(2)}..${b.max.z.toFixed(2)}, y ${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)}`);
    expect(b.min.x).toBeGreaterThanOrEqual(BOAT_HULL.x0 - 0.75);
    expect(b.max.x).toBeLessThanOrEqual(BOAT_HULL.x1 + 0.05);
    expect(b.min.z).toBeGreaterThanOrEqual(BOAT_HULL.z0 - 0.05);
    expect(b.max.z).toBeLessThanOrEqual(BOAT_HULL.z1 + 0.05);
    expect(b.max.y).toBeLessThanOrEqual(BOAT_ROOF);
    // The hull itself stays inside the hull box; above the deck only the cabin (and the thin rails) stand.
    const hull = bbox(g.painted);
    expect(hull.min.x).toBeGreaterThanOrEqual(BOAT_HULL.x0 - 1e-3);
    expect(hull.max.x).toBeLessThanOrEqual(BOAT_HULL.x1 + 1e-3);
    expect(hull.max.y).toBeLessThanOrEqual(BOAT_DECK + 1e-3);
    const cabin = bbox(partGeometry(g.fittings, 'cabin')!);
    expect(cabin.min.x).toBeGreaterThanOrEqual(BOAT_CABIN.x0 - 1e-3);
    expect(cabin.max.x).toBeLessThanOrEqual(BOAT_CABIN.x1 + 1e-3);
    expect(Math.max(-cabin.min.z, cabin.max.z)).toBeLessThanOrEqual(BOAT_CABIN.z1 + 1e-3);
    const group = mooredBoat(0x1f4e79, new THREE.MeshStandardMaterial());
    expect(group.children.length).toBe(2);
  });
});

describe('the waterline foam (VAL-BKB-003)', () => {
  it.each(boatKinds())('round the %s at rest the ring lies just outside the waterline, faces up, on the water, in every sector', (kind) => {
    const { v } = parkedBoat(kind, false);
    const view = new BoatView(kind);
    view.bind(v);
    view.sync(v, 1 / 60, 3, 0);
    const foam = view.group.getObjectByName('foam') as THREE.Mesh;
    expect(foam.visible).toBe(true);
    const pts = view.foamWorld();
    for (const p of pts) expect(p.y).toBeCloseTo(WATER_Y + FOAM_LIFT, 5);
    // Every triangle faces up.
    const idx = foam.geometry.index!;
    for (let i = 0; i < idx.count; i += 3) {
      const a = pts[idx.getX(i)]!;
      const n = pts[idx.getX(i + 1)]!.clone().sub(a).cross(pts[idx.getX(i + 2)]!.clone().sub(a));
      expect(n.y).toBeGreaterThan(0);
    }
    // In the boat's frame: no vertex inside the waterline outline; 12 sectors round the centre all have foam within
    // 0.6 m of the outline.
    const inv = new THREE.Matrix4().makeRotationY(v.heading).invert();
    const local = pts.map((p) => new THREE.Vector3(p.x - v.pos.x, 0, p.z - v.pos.z).applyMatrix4(inv));
    const wl = boatModel(kind).waterline;
    const inside = (x: number, z: number) => {
      let c = false;
      for (let i = 0, j = wl.length - 1; i < wl.length; j = i++) {
        const a = wl[i]!;
        const b = wl[j]!;
        if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    };
    expect(local.filter((p) => inside(p.x, p.z)).length).toBe(0);
    const sectors = new Set<number>();
    for (const p of local) {
      const d = Math.min(...wl.map((q) => Math.hypot(q.x - p.x, q.y - p.z)));
      if (d <= 0.6) sectors.add(Math.floor(((Math.atan2(p.z, p.x) + Math.PI) / (Math.PI * 2)) * 12) % 12);
    }
    expect(sectors.size).toBe(12);
  });

  it('on the High wave grid the ring stays on the drawn sea round the bobbing hull, in a storm too', () => {
    const { v } = parkedBoat('speedboat', false);
    const view = new BoatView('speedboat');
    const u = seaUniforms();
    u.uDisplace.value = 1;
    view.bindSea(u);
    view.bind(v);
    let worst = 0;
    let lowest = Infinity;
    let heave = 0;
    for (let k = 0; k < 10; k++) {
      const t = k * 0.5;
      updateSea(u, t, 1, v.pos.x - 10, v.pos.z);
      view.sync(v, 0.5, t, 0);
      const pts = view.foamWorld();
      for (const p of pts) {
        const over = p.y - (WATER_Y + seaHeightAt(u, p.x, p.z));
        worst = Math.max(worst, Math.abs(over));
        lowest = Math.min(lowest, over);
      }
      heave = Math.max(heave, Math.abs(view.group.position.y - WATER_Y));
    }
    log(`foam vs the drawn sea over 5 s at sea state 1: worst ${(worst * 100).toFixed(1)} cm off it, lowest ${(lowest * 100).toFixed(1)} cm over it (lift ${FOAM_LIFT * 100} cm); hull heave up to ${(heave * 100).toFixed(1)} cm`);
    expect(worst).toBeLessThanOrEqual(0.15);
    expect(lowest).toBeGreaterThan(-0.02);
  });

  it('a sinking or destroyed boat has no ring, and the ring follows the fade', () => {
    const { v } = parkedBoat('dinghy', false);
    const view = new BoatView('dinghy');
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    view.beginFade();
    view.setFade(0.4);
    const foam = view.group.getObjectByName('foam') as THREE.Mesh;
    const base = foamMaterial().opacity;
    expect((foam.material as THREE.Material).opacity).toBeCloseTo(base * 0.4, 6);
    for (const m of view.endFade()) m.dispose();
    v.destroyed = true;
    view.sync(v, 1 / 60, 0, 0);
    expect(foam.visible).toBe(false);
  });
});

describe('boat drivers (VAL-BKB-004)', () => {
  it.each(boatKinds())('the %s driver holds the wheel or tiller and sits on his seat', (kind) => {
    const m = boatModel(kind);
    const rows: string[] = [];
    for (const height of [0.9, 1, 1.07]) {
      const { v, c } = parkedBoat(kind);
      Object.assign(c.appearance, { height, build: 1.05 });
      const view = new BoatView(kind);
      view.bind(v);
      view.sync(v, 1 / 60, 3, 0);
      const seg = new CrowdView();
      seg.sync([c], v.pos.x + 6, v.pos.z, 1 / 60);
      const inv = riderMount(v)!.frame.matrixWorld.clone().invert();
      const check = (label: string, joints: Map<string, THREE.Vector3>) => {
        const j = (n: string) => joints.get(n)!.clone().applyMatrix4(inv);
        const wrists = [j('wristL'), j('wristR')];
        const d = m.helm.hands.map((h, i) => wrists[h]!.distanceTo(m.helm.points[i]!));
        const above = j('pelvis').y - m.seatTop;
        rows.push(`${label} h${height}: hands ${d.map((x) => (x * 100).toFixed(1)).join('/')} cm from the ${m.style === 'dinghy' ? 'tiller' : 'wheel'}, pelvis ${(above * 100).toFixed(1)} cm over the seat`);
        for (const x of d) expect(x, `${kind} ${label} h${height}`).toBeLessThanOrEqual(0.05);
        expect(above).toBeGreaterThanOrEqual(0);
        expect(above).toBeLessThanOrEqual(0.03);
      };
      check('segments', segmentJoints(seg, c));
    }
    log(`${kind}:\n  ${rows.join('\n  ')}`);
  });
});

describe('boat fades (VAL-BKB-005)', () => {
  it.each(boatKinds())('every own mesh of the %s, the foam and the glass included, and its shadow follow the fade', (kind) => {
    const { v } = parkedBoat(kind, false);
    const view = new BoatView(kind);
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    const own = drawCensus(view.group);
    const opacities = new Map(own.main.map((m) => [m, (m.material as THREE.Material).opacity]));
    view.beginFade();
    for (const f of [0, 0.5, 1]) {
      view.setFade(f);
      for (const mesh of [...own.main, ...own.casters]) {
        const mat = mesh.material as THREE.Material;
        expect(mat.alphaHash || mat.transparent, `${kind} ${mesh.name}`).toBe(true);
        expect(mat.opacity, `${kind} ${mesh.name} at ${f}`).toBeCloseTo(mat.transparent ? (opacities.get(mesh) ?? 1) * f : f, 6);
        if (mesh.castShadow) expect((mesh.customDepthMaterial as THREE.MeshDepthMaterial).opacity).toBe(f);
      }
      const batches = new VehiclePartBatches();
      batches.begin();
      view.drawParts(batches);
      batches.end();
      let n = 0;
      for (const o of batches.group.children) {
        const mesh = o as THREE.InstancedMesh;
        if (!mesh.visible) continue;
        const a = mesh.geometry.getAttribute('instanceFade');
        for (let i = 0; i < mesh.count; i++, n++) expect(a.getX(i)).toBeCloseTo(f, 6);
      }
      expect(n).toBe(2);
      batches.dispose();
    }
    for (const m of view.endFade()) m.dispose();
  });
});

describe('riders fade with their bike or boat (VAL-BKB-005)', () => {
  it.each([...bikeKinds(), ...boatKinds()])('the %s rider is drawn at the vehicle\'s fade level', (kind) => {
    const boat = boatKinds().includes(kind);
    const { v, c } = boat ? parkedBoat(kind) : riddenBike(kind);
    const view = boat ? new BoatView(kind) : new BikeView(kind);
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    view.beginFade();
    for (const f of [0.25, 0.7]) {
      view.setFade(f);
      const seg = new CrowdView();
      seg.sync([c], v.pos.x + 6, v.pos.z, 1 / 60);
      const head = (seg as unknown as { parts: Record<string, { mesh: THREE.InstancedMesh }> }).parts.head!.mesh;
      expect(head.count).toBe(1);
      expect((head.geometry.getAttribute('instanceFade').array as Float32Array)[0]).toBeCloseTo(f, 6);
    }
    for (const m of view.endFade()) m.dispose();
    expect(riderMount(v)!.level).toBe(1);
  });
});
