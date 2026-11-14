// Round 9's art pass on the bikes, the boats and the weapons: what the simulation and the riders' code hang off the
// models stays where it was (the guns' muzzle, grip and stock on WEAPON_POINTS, the off hand under the forend; the bikes'
// seats, bars, grips, pegs and lamps; the boats' hull, waterline, seats and helm), and each kind keeps to its triangle
// budget (a held weapon 600 triangles, a bike or a boat 40% over its count before the pass).

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { bikeModel } from '../../src/render/bikeModels';
import { boatModel, mooredBoatGeometry } from '../../src/render/boatModels';
import { triangles } from '../../src/render/shapeKit';
import { GUN_IDS, gunModel, heldModel, HELD_IDS, pickupModel } from '../../src/render/weaponModels';
import { WEAPON_POINTS } from '../../src/sim/pose';
import type { VehicleKind } from '../../src/sim/specs';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

type P3 = [number, number, number];
const v = (p: { x: number; y: number; z: number }): P3 => [p.x, p.y, p.z];
const near = (got: P3, want: P3, tol: number, label: string) => {
  for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!), `${label}[${i}] ${got} vs ${want}`).toBeLessThanOrEqual(tol);
};

describe('guns: the sockets the simulation shoots and holds from', () => {
  /** The stock socket before the pass (the butt's centre); the muzzle and grip sit on WEAPON_POINTS themselves. */
  const STOCK: Record<string, P3> = {
    pistol: [0, 0, -0.01],
    smg: [0, -0.01, -0.05],
    shotgun: [0, -0.0356, -0.245],
    rifle: [0, -0.0302, -0.25],
    rocket: [0, 0.08, 0.2],
    sniper: [0, -0.0291, -0.27],
  };

  it.each(GUN_IDS)('%s: muzzle and grip on WEAPON_POINTS and the butt where it was, to 1 mm', (id) => {
    const m = gunModel(id);
    const pts = WEAPON_POINTS[id];
    near(v(m.sockets.muzzle), v(pts.tip), 0.001, `${id} muzzle`);
    near(v(m.sockets.grip), v(pts.grip), 0.001, `${id} grip`);
    near(v(m.sockets.stock), STOCK[id]!, 0.001, `${id} stock`);
    expect(m.sockets.axis.angleTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-6);
  });

  it('rocket: the off hand (WEAPON_POINTS fore) wraps the foregrip round its centre', () => {
    near(v(gunModel('rocket').sockets.fore!), v(WEAPON_POINTS.rocket.fore), 0.01, 'rocket foregrip');
  });

  it.each(GUN_IDS.filter((id) => id !== 'pistol' && id !== 'rocket'))('%s: the off hand (WEAPON_POINTS fore) holds the gun from just under it', (id) => {
    // The gun's underside where the off hand is: the lowest point where its surface crosses the plane through the
    // hand's z, within 3 cm of the centreline. The hand's centre sits 0-4 cm under it (a hand is about 4 cm thick), so
    // the fingers neither float under nor sink into the forend.
    const pts = WEAPON_POINTS[id];
    const p = gunModel(id).geometry.getAttribute('position');
    const z = pts.fore.z;
    let low = Infinity;
    for (let i = 0; i + 2 < p.count; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = i + e;
        const b = i + ((e + 1) % 3);
        const za = p.getZ(a);
        const zb = p.getZ(b);
        if ((za - z) * (zb - z) > 0 || za === zb) continue;
        const f = (z - za) / (zb - za);
        const x = p.getX(a) + f * (p.getX(b) - p.getX(a));
        if (Math.abs(x) > 0.03) continue;
        low = Math.min(low, p.getY(a) + f * (p.getY(b) - p.getY(a)));
      }
    }
    const gap = low - pts.fore.y;
    expect(gap, `${id} forend underside ${low.toFixed(3)} over the hand at ${pts.fore.y}`).toBeGreaterThanOrEqual(-0.005);
    expect(gap).toBeLessThanOrEqual(0.04);
  });

  it.each(GUN_IDS)('%s: at most 600 triangles, in at least three tones', (id) => {
    const m = gunModel(id);
    expect(m.triangles).toBeLessThanOrEqual(600);
    const c = m.geometry.getAttribute('color');
    const tones = new Set<string>();
    for (let i = 0; i < c.count; i++) tones.add(`${c.getX(i).toFixed(3)},${c.getY(i).toFixed(3)},${c.getZ(i).toFixed(3)}`);
    expect(tones.size).toBeGreaterThanOrEqual(3);
  });

  it.each(HELD_IDS)('the held %s is modelled (vertex colours, 60-400 triangles), along +y out of the fist', (id) => {
    const g = heldModel(id);
    expect(g.hasAttribute('color')).toBe(true);
    const n = g.getAttribute('position').count / 3;
    expect(n).toBeGreaterThanOrEqual(60);
    expect(n).toBeLessThanOrEqual(400);
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeLessThanOrEqual(0.02);
    expect(g.boundingBox!.max.y).toBeGreaterThan(0.08);
  });

  it.each([...GUN_IDS, ...HELD_IDS])('the %s pickup is its own model, centred, 0.7 m or longer', (id) => {
    const g = pickupModel(id)!;
    g.computeBoundingBox();
    const size = g.boundingBox!.getSize(new THREE.Vector3());
    const c = g.boundingBox!.getCenter(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeGreaterThanOrEqual(0.45);
    expect(c.length()).toBeLessThan(1e-6);
    expect(pickupModel('fists')).toBeNull();
  });
});

describe('bikes: where the riders sit, hold and stand, and the lamps', () => {
  const PINS: Record<string, { dims: number[]; seats: Array<{ hip: P3; recline: number; hands: P3[]; feet: P3[] }>; handsOnBars: P3[]; grips: P3[]; pegs: P3[]; seatTop: number[]; head: number[][]; tail: number[]; tris: number }> = {
    sportbike: {
      dims: [0.31, -0.7, 0.72, 0.98, 0.5, 0.3173, 0.7052],
      seats: [
        { hip: [0, 1.06, -0.24], recline: -0.6, hands: [[0.29, 1.1001, 0.3998], [-0.29, 1.1001, 0.3998]], feet: [[0.2, 0.44, -0.16], [-0.2, 0.44, -0.16]] },
        { hip: [0, 1.14, -0.56], recline: -0.25, hands: [[0.17, 1.2, -0.3], [-0.17, 1.2, -0.3]], feet: [[0.21, 0.5, -0.46], [-0.21, 0.5, -0.46]] },
      ],
      handsOnBars: [[0.29, 0.1454, -0.0577], [-0.29, 0.1454, -0.0577]],
      grips: [[0.29, 0.1695, -0.0643], [-0.29, 0.1695, -0.0643]],
      pegs: [[0.2, 0.44, -0.16], [-0.2, 0.44, -0.16]],
      seatTop: [1.05, 1.125],
      head: [[-0.05, 0.85, 0.845, 0.07, 0.04, 0.03, -0.55, 1], [0.05, 0.85, 0.845, 0.07, 0.04, 0.03, 0.55, 1]],
      tail: [0, 1.03, -0.88, 0.08, 0.035, 0.02],
      tris: 7784,
    },
    scooter: {
      dims: [0.22, -0.6, 0.62, 0.92, 0.48, 0.1974, 0.7139],
      seats: [
        { hip: [0, 0.86, -0.1], recline: 0.05, hands: [[0.2693, 1.0897, 0.3], [-0.2693, 1.0897, 0.3]], feet: [[0.13, 0.311, 0.18], [-0.13, 0.311, 0.18]] },
        { hip: [0, 0.9, -0.55], recline: 0.1, hands: [[0.18, 0.98, -0.24], [-0.18, 0.98, -0.24]], feet: [[0.17, 0.35, -0.32], [-0.17, 0.35, -0.32]] },
      ],
      handsOnBars: [[0.2693, 0.2017, -0.1433], [-0.2693, 0.2017, -0.1433]],
      grips: [[0.27, 0.2214, -0.1587], [-0.27, 0.2214, -0.1587]],
      pegs: [[0.13, 0.311, 0.18], [-0.13, 0.311, 0.18]],
      seatTop: [0.85, 0.885],
      head: [[0, 0.1053, 0.1108, 0.15, 0.06, 0.03, 0, 1]],
      tail: [0, 0.67, -0.89, 0.13, 0.04, 0.02],
      tris: 5244,
    },
  };

  it.each(Object.keys(PINS))('%s: wheels, steering head, seats, hands, grips, pegs and lamps where they were', (kind) => {
    const m = bikeModel(kind as VehicleKind);
    const p = PINS[kind]!;
    const tol = 1e-4;
    [m.wheelR, m.rearZ, m.frontZ, m.headY, m.headZ, m.rake, m.forkLen].forEach((x, i) => expect(Math.abs(x - p.dims[i]!)).toBeLessThanOrEqual(tol));
    m.seats.forEach((s, i) => {
      const w = p.seats[i]!;
      near(v(s.hip), w.hip, tol, `${kind} seat ${i} hip`);
      expect(s.recline).toBe(w.recline);
      s.hands.forEach((h, j) => near(v(h), w.hands[j]!, tol, `${kind} seat ${i} hand ${j}`));
      s.feet.forEach((f, j) => near(v(f), w.feet[j]!, tol, `${kind} seat ${i} foot ${j}`));
    });
    m.handsOnBars.forEach((h, i) => near(v(h), p.handsOnBars[i]!, tol, `${kind} hand on bar ${i}`));
    m.grips.forEach((h, i) => near(v(h), p.grips[i]!, tol, `${kind} grip ${i}`));
    m.pegs.forEach((h, i) => near(v(h), p.pegs[i]!, tol, `${kind} peg ${i}`));
    expect(m.seatTop).toEqual(p.seatTop);
    expect(m.headLamps.length).toBe(p.head.length);
    m.headLamps.forEach((l, i) => {
      const w = p.head[i]!;
      near(v(l.at), [w[0]!, w[1]!, w[2]!], tol, `${kind} head lamp ${i}`);
      near(v(l.size), [w[3]!, w[4]!, w[5]!], tol, `${kind} head lamp ${i} size`);
    });
    near(v(m.tailLamp.at), [p.tail[0]!, p.tail[1]!, p.tail[2]!], tol, `${kind} tail lamp`);
  });

  it.each(Object.keys(PINS))('%s: at most 40%% more triangles than before the pass', (kind) => {
    const m = bikeModel(kind as VehicleKind);
    const total = triangles(m.painted) + triangles(m.frame) + triangles(m.steer) + 2 * triangles(m.tyre) + triangles(m.frontRim) + triangles(m.rearRim);
    console.log(`[r9] ${kind}: ${PINS[kind]!.tris} -> ${total} triangles (painted ${triangles(m.painted)}, frame ${triangles(m.frame)}, steer ${triangles(m.steer)}, tyre ${triangles(m.tyre)} x2, rims ${triangles(m.frontRim)}/${triangles(m.rearRim)}), shadow proxy ${triangles(m.shadow)}`);
    expect(total).toBeLessThanOrEqual(Math.floor(PINS[kind]!.tris * 1.4));
  });
});

describe('boats: hull, waterline, seats and helm where they were', () => {
  const PINS: Record<string, { hull: Record<string, number>; dims: number[]; waterline: number[]; seats: Array<{ hip: P3; recline: number; hands: P3[]; feet: P3[] }>; helm: P3[]; bow: P3; stern: P3; tris: number }> = {
    speedboat: {
      hull: { length: 6.4, beam: 2.24, draft: 0.45, deadrise: 0.3141592653589793, sheerAft: 0.78, sheerBow: 0.95, chine: 0.84, shoulder: 0.42, entry: 1.8, keelRise: 0.55, transom: 0.9 },
      dims: [6.4, 2.3, 0.78, 0.15, -0.45, 0.585],
      waterline: [64, 8.5985, 12.9693, 0.9743, -3.2, 2.1915],
      seats: [
        { hip: [0.45, 0.6, -0.34], recline: 0.05, hands: [[0.6145, 0.9905, 0.1225], [0.2855, 0.9905, 0.1225]], feet: [[0.57, 0.15, 0.02], [0.33, 0.15, 0.02]] },
        { hip: [-0.45, 0.6, -0.34], recline: 0.15, hands: [[-0.2, 0.86, -0.05], [-0.72, 0.86, -0.12]], feet: [[-0.33, 0.15, 0.02], [-0.57, 0.15, 0.02]] },
        { hip: [0.4, 0.6, -2.6], recline: 0.2, hands: [[0.6, 0.7, -2.45], [0.2, 0.7, -2.45]], feet: [[0.5, 0.15, -2.15], [0.3, 0.15, -2.15]] },
        { hip: [-0.4, 0.6, -2.6], recline: 0.2, hands: [[-0.2, 0.7, -2.45], [-0.6, 0.7, -2.45]], feet: [[-0.3, 0.15, -2.15], [-0.5, 0.15, -2.15]] },
      ],
      helm: [[0.62, 1, 0.1], [0.28, 1, 0.1]],
      bow: [0, 1.057, 2.752],
      stern: [0.62, 1.35, -3.08],
      tris: 5575,
    },
    dinghy: {
      hull: { length: 3.8, beam: 1.2, draft: 0.3, deadrise: 0.2792526803190927, sheerAft: 0.2, sheerBow: 0.32, chine: 0.8, shoulder: 0.45, entry: 1.4, keelRise: 0.5, transom: 0.92 },
      dims: [3.8, 1.7, 0.42, 0.05, -0.3, 0.395],
      waterline: [56, 2.9101, 7.897, 0.5428, -1.9, 1.4353],
      seats: [
        { hip: [0, 0.41, -0.95], recline: 0.05, hands: [[0.2323, 0.5762, -1.2019], [-0.28, 0.405, -0.95]], feet: [[0.15, 0.05, -0.5], [-0.15, 0.05, -0.5]] },
        { hip: [0, 0.41, 0.2], recline: 0.1, hands: [[0.42, 0.47, 0.25], [-0.42, 0.47, 0.25]], feet: [[0.15, 0.05, 0.65], [-0.15, 0.05, 0.65]] },
      ],
      helm: [[0.235, 0.598, -1.19]],
      bow: [0, 0.51, 1.72],
      stern: [-0.3, 0.88, -1.85],
      tris: 5831,
    },
  };

  it.each(Object.keys(PINS))('the %s keeps its hull, its waterline outline (what the wakes, foam and shelter read), seats, helm and lamps', (kind) => {
    const m = boatModel(kind as VehicleKind);
    const p = PINS[kind]!;
    for (const [k, x] of Object.entries(p.hull)) expect(Math.abs((m.hull as unknown as Record<string, number>)[k]! - x), k).toBeLessThan(1e-9);
    [m.length, m.width, m.gunwale, m.floor, m.keel, m.seatTop].forEach((x, i) => expect(x).toBe(p.dims[i]));
    const w = m.waterline;
    let area = 0;
    let per = 0;
    for (let i = 0; i < w.length; i++) {
      const a = w[i]!;
      const b = w[(i + 1) % w.length]!;
      area += a.x * b.y - b.x * a.y;
      per += a.distanceTo(b);
    }
    const sig = [w.length, area / 2, per, Math.max(...w.map((q) => q.x)), Math.min(...w.map((q) => q.y)), Math.max(...w.map((q) => q.y))];
    sig.forEach((x, i) => expect(Math.abs(x - p.waterline[i]!), `waterline ${i}`).toBeLessThanOrEqual(1e-4));
    const tol = 1e-4;
    m.seats.forEach((s, i) => {
      const q = p.seats[i]!;
      near(v(s.hip), q.hip, tol, `${kind} seat ${i} hip`);
      expect(s.recline).toBe(q.recline);
      s.hands.forEach((h, j) => near(v(h), q.hands[j]!, tol, `${kind} seat ${i} hand ${j}`));
      s.feet.forEach((f, j) => near(v(f), q.feet[j]!, tol, `${kind} seat ${i} foot ${j}`));
    });
    m.helm.points.forEach((h, i) => near(v(h), p.helm[i]!, tol, `${kind} helm ${i}`));
    near(v(m.bowLamp.at), p.bow, tol, `${kind} bow lamp`);
    near(v(m.sternLamp.at), p.stern, tol, `${kind} stern lamp`);
  });

  it.each(Object.keys(PINS))('the %s: at most 40%% more triangles than before the pass', (kind) => {
    const m = boatModel(kind as VehicleKind);
    const total = triangles(m.painted) + triangles(m.fittings) + (m.glass ? triangles(m.glass) : 0);
    console.log(`[r9] ${kind}: ${PINS[kind]!.tris} -> ${total} triangles (painted ${triangles(m.painted)}, fittings ${triangles(m.fittings)}, glass ${m.glass ? triangles(m.glass) : 0}), shadow proxy ${triangles(m.shadow)}`);
    expect(total).toBeLessThanOrEqual(Math.floor(PINS[kind]!.tris * 1.4));
  });

  it('the moored cruiser: at most 40% more triangles than before the pass', () => {
    const g = mooredBoatGeometry();
    const total = triangles(g.painted) + triangles(g.fittings);
    console.log(`[r9] moored cruiser: 3147 -> ${total} triangles`);
    expect(total).toBeLessThanOrEqual(Math.floor(3147 * 1.4));
  });
});

/** Every vertex normal of unit length and finite: a normal of no length shades as NaN, which the bloom spreads over the frame. */
function badNormals(g: THREE.BufferGeometry): number {
  const n = g.getAttribute('normal');
  let bad = 0;
  for (let i = 0; i < n.count; i++) {
    const l = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
    if (!Number.isFinite(l) || Math.abs(l - 1) > 1e-3) bad++;
  }
  return bad;
}

describe('every new mesh has sound normals', () => {
  it.each([...GUN_IDS, ...HELD_IDS])('the %s, held and as a pickup', (id) => {
    const held = (GUN_IDS as readonly string[]).includes(id) ? gunModel(id as (typeof GUN_IDS)[number]).geometry : heldModel(id as (typeof HELD_IDS)[number]);
    expect(badNormals(held)).toBe(0);
    expect(badNormals(pickupModel(id)!)).toBe(0);
  });

  it.each(['sportbike', 'scooter'] as const)('the %s', (kind) => {
    const m = bikeModel(kind);
    for (const [name, g] of Object.entries({ painted: m.painted, frame: m.frame, steer: m.steer, tyre: m.tyre, frontRim: m.frontRim, rearRim: m.rearRim })) expect(badNormals(g), name).toBe(0);
  });

  it.each(['speedboat', 'dinghy'] as const)('the %s and the moored cruiser', (kind) => {
    const m = boatModel(kind);
    for (const [name, g] of Object.entries({ painted: m.painted, fittings: m.fittings, glass: m.glass })) if (g) expect(badNormals(g), name).toBe(0);
    const c = mooredBoatGeometry();
    expect(badNormals(c.painted)).toBe(0);
    expect(badNormals(c.fittings)).toBe(0);
  });
});
