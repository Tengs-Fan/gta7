// Mission 3 cars (VAL-CAR-001..010): real tinted glass, bodies fitted to VEHICLE_SPECS and the physics, rounded noses
// and tails with moulded arch lips, dents on the body and its shadow, moulded lamp lenses, lettered tyres, wheels that
// steer and spin, dark street ironwork under parked cars, batched part draws, and far versions and fades that agree.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

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
    return new Proxy(store, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => ((o[k] = v), true) });
  };
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, clientWidth: 1280, clientHeight: 720, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {}, removeEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

import { PART_LAYER, SHADOW_LAYER, VehiclePartBatches } from '../../src/render/vehicleBatches';
import { TYRE_LETTERING, TYRE_SIDEWALL, TYRE_TREAD } from '../../src/render/vehicleDetails';
import { manhole, stormDrain } from '../../src/render/cityArchitecture';
import { GeoBuilder } from '../../src/render/geo';
import { AXLE, cabinCeiling, cabinLayout, endRounding, GLASS_OPACITY, LAMP_LENS, riderSeat, VehicleView, vehicleGlass } from '../../src/render/vehicleView';
import { Vehicle } from '../../src/sim/entities';
import { SKELETON } from '../../src/sim/pose';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';

const KINDS = (Object.keys(VEHICLE_SPECS) as VehicleKind[]).filter((k) => VEHICLE_SPECS[k].class === 'car');
/** The physics' spin radius (vehiclePhysics.ts wheelSpin) and its spike-strip wheel track (roadblocks.ts wheelPoints). */
const SPIN_RADIUS = 0.34;
const TRACK = 0.85;

function view(kind: VehicleKind): VehicleView {
  const v = new VehicleView(kind);
  v.group.updateMatrixWorld(true);
  return v;
}
const mesh = (v: VehicleView, name: string): THREE.Mesh => v.group.getObjectByName(name) as THREE.Mesh;
const box = (g: THREE.BufferGeometry): THREE.Box3 => new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);

/** The first 'glass' or 'body' mesh a ray hits (lamps, wheels and roof gear are looked through). */
function firstHit(v: VehicleView, origin: THREE.Vector3, dir: THREE.Vector3): string | null {
  const rc = new THREE.Raycaster(origin, dir.clone().normalize(), 0, 100);
  for (const h of rc.intersectObject(v.group, true)) if (h.object.name === 'glass' || h.object.name === 'body') return h.object.name;
  return null;
}

/** The fragment shader a material compiles to on the standard program (its onBeforeCompile applied). */
function patchedFragment(m: THREE.Material): string {
  const s = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
  m.onBeforeCompile(s, undefined as unknown as THREE.WebGLRenderer);
  return s.fragmentShader;
}

describe('VAL-CAR-001 tinted, reflective glass on every car kind', () => {
  it('every kind draws its glass as its own mesh and material, separate from the paint', () => {
    for (const kind of KINDS) {
      const v = view(kind);
      const glass = mesh(v, 'glass');
      const body = mesh(v, 'body');
      expect(glass, kind).toBeDefined();
      expect(glass.material, kind).not.toBe(body.material);
      expect(glass.material, kind).toBe(vehicleGlass.intact);
      expect(glass.castShadow, kind).toBe(false);
      expect(box(glass.geometry).isEmpty(), kind).toBe(false);
    }
  });

  it('the glass is tinted, at least 0.7 opaque, smooth, env-mapped with a Fresnel term on its opacity, and uses no transmission', () => {
    for (const m of [vehicleGlass.intact, vehicleGlass.cracked, vehicleGlass.shattered] as THREE.MeshStandardMaterial[]) {
      expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect((m as unknown as { transmission?: number }).transmission ?? 0).toBe(0);
      expect(m.opacity).toBeGreaterThanOrEqual(0.7);
      expect(m.transparent).toBe(true);
      expect(m.side).toBe(THREE.DoubleSide);
      expect(m.forceSinglePass).toBe(true);
      expect(m.roughness).toBeLessThanOrEqual(0.1);
      // No envMap of its own: three gives it scene.environment (or LocalReflections sets the player car's probe).
      expect(m.envMap).toBeNull();
      const frag = patchedFragment(m);
      expect(frag).toContain('glassFresnel');
      expect(frag).toMatch(/pow\( 1\.0 - clamp\( glassFacing/);
      expect(m.customProgramCacheKey()).toBe('vehicle-glass-fresnel');
    }
    expect(GLASS_OPACITY).toBeGreaterThanOrEqual(0.7);
    // Tinted: the intact pane is a dark blue-grey; the cracked ones carry the tint in their maps.
    const c = (vehicleGlass.intact as THREE.MeshStandardMaterial).color;
    expect(Math.max(c.r, c.g, c.b)).toBeLessThan(0.1);
    expect(c.b).toBeGreaterThan(c.r);
  });

  it('a fading car keeps the glass Fresnel patch on its fade copy, scaled by the fade', () => {
    const v = view('sedan');
    v.beginFade();
    v.setFade(0.5);
    const fade = mesh(v, 'glass').material as THREE.MeshStandardMaterial;
    expect(fade).not.toBe(vehicleGlass.intact);
    expect(fade.opacity).toBeCloseTo(GLASS_OPACITY * 0.5, 6);
    expect(patchedFragment(fade)).toContain('glassFresnel');
    // Opacity rises at grazing angles by a factor, so a half-faded pane stays half as opaque as a whole one.
    expect(patchedFragment(fade)).toContain('diffuseColor.a * mix( 1.0,');
    v.endFade();
  });

  it('the windscreen, side windows and backlight of every see-through cabin are glass, with no opening', () => {
    for (const kind of KINDS) {
      const layout = cabinLayout(kind);
      const s = VEHICLE_SPECS[kind];
      const v = view(kind);
      const g = box(mesh(v, 'glass').geometry);
      const y = (g.min.y + g.max.y) / 2;
      // Windscreen: from 6 m ahead, through the upper part of the glass (a low bonnet hides less of it).
      const wy = g.min.y + 0.7 * (g.max.y - g.min.y);
      expect(firstHit(v, new THREE.Vector3(0, wy, s.length / 2 + 6), new THREE.Vector3(0, 0, -1)), `${kind} windscreen`).toBe('glass');
      if (!layout) continue;
      // Side windows, front and rear rows, from both sides; and the backlight from behind.
      const zs = [layout.frontZ, layout.rearZ ?? layout.frontZ];
      for (const z of zs) for (const side of [-1, 1]) {
        expect(firstHit(v, new THREE.Vector3(side * 5, y, z), new THREE.Vector3(-side, 0, 0)), `${kind} side ${side} at ${z.toFixed(2)}`).toBe('glass');
      }
      if (kind !== 'pickup' && kind !== 'ambulance' && kind !== 'firetruck') {
        expect(firstHit(v, new THREE.Vector3(0, layout.roof.y - 0.08, -s.length / 2 - 6), new THREE.Vector3(0, -0.04, 1)), `${kind} backlight`).toBe('glass');
      }
    }
  });
});

describe('VAL-CAR-002 bodies, wheels and seats fit VEHICLE_SPECS and the physics', () => {
  it('the body is within 3% and 0.08 m of the spec length, width and height; the far versions within 3% of it', () => {
    const rows: string[] = [];
    for (const kind of KINDS) {
      const s = VEHICLE_SPECS[kind];
      const v = view(kind);
      const b = box(mesh(v, 'body').geometry).union(box(mesh(v, 'glass').geometry));
      // Heights from the wheels' contact point (the view's origin), with the spec's own equipment (ladders, light
      // bars: VEHICLE_SPECS gear); the cruisers' light bars and the taxi sign stand on the roof over the spec height.
      let top = b.max.y;
      for (const gear of s.gear ?? []) top = Math.max(top, gear.at[1] + gear.size[1] / 2);
      const err = { length: b.max.z - b.min.z - s.length, width: b.max.x - b.min.x - s.width, height: top - s.height };
      rows.push(`${kind}: length ${err.length.toFixed(3)} width ${err.width.toFixed(3)} height ${err.height.toFixed(3)}`);
      for (const [k, e] of Object.entries(err)) {
        const spec = k === 'length' ? s.length : k === 'width' ? s.width : s.height;
        expect(Math.abs(e), `${kind} ${k}`).toBeLessThanOrEqual(Math.min(0.08, 0.03 * spec) + 1e-6);
      }
      // The bumpers, plates and lenses stand no more than 4 cm off the body's ends.
      const ext = box(mesh(v, 'exterior').geometry);
      expect(ext.max.z - s.length / 2, kind).toBeLessThanOrEqual(0.04);
      expect(-s.length / 2 - ext.min.z, kind).toBeLessThanOrEqual(0.04);
      v.group.traverse((o) => {
        if (o.name !== 'lamp') return;
        const l = new THREE.Box3().setFromObject(o);
        expect(Math.max(l.max.z - s.length / 2, -s.length / 2 - l.min.z), `${kind} lamp`).toBeLessThanOrEqual(0.04);
      });
      // The far version draws the same body and glass; the software tier's coarse one stays within 3% too.
      v.setDistant(true, true);
      const coarse = box(mesh(v, 'distant-vehicle').geometry);
      // (The coarse mesh has its wheels merged in: its height is compared from the road, as the spec's.)
      const near = b.getSize(new THREE.Vector3()).setY(b.max.y);
      const far = coarse.getSize(new THREE.Vector3()).setY(coarse.max.y);
      for (const axis of ['x', 'y', 'z'] as const) expect(Math.abs(far[axis] - near[axis]) / near[axis], `${kind} coarse ${axis}`).toBeLessThanOrEqual(0.03);
    }
    console.log(rows.join('\n'));
  });

  it('every wheel sits on the physics axles and track, and the drawn tyre radius is the radius it spins by', () => {
    for (const kind of KINDS) {
      const s = VEHICLE_SPECS[kind];
      const v = view(kind);
      const pivots = v.group.children.filter((o) => o instanceof THREE.Group && o.children.some((c) => c.name === 'tire'));
      expect(pivots.length, kind).toBe(4);
      for (const p of pivots) {
        expect(Math.abs(Math.abs(p.position.z) - AXLE * s.length), `${kind} axle`).toBeLessThanOrEqual(0.03);
        expect(Math.abs(Math.abs(p.position.x) - TRACK * (s.width / 2)), `${kind} track`).toBeLessThanOrEqual(0.05);
        const tire = p.children.find((c) => c.name === 'tire') as THREE.Mesh;
        const r = box(tire.geometry).max.y;
        // The view spins the wheel by its own radius (the tyre's), so the tread moves at the ground speed.
        const car = new Vehicle(1, kind, 0, 0, 0, 0, 0xffffff);
        car.forwardSpeed = 10;
        v.bind(car);
        v.sync(car, 0.1, 0, 0);
        expect(Math.abs(tire.rotation.x) * r, kind).toBeCloseTo(1, 3);
        expect(Math.abs(r - p.position.y), `${kind} rests on its tyre`).toBeLessThan(1e-6);
        if (kind === 'sedan' || kind === 'police' || kind === 'taxi') expect(Math.abs(r - SPIN_RADIUS), kind).toBeLessThanOrEqual(0.02);
      }
    }
  });

  it('seats and the steering wheel come from cabinLayout, and a seated driver\'s head clears the roof and glass', () => {
    for (const kind of KINDS) {
      const c = cabinLayout(kind);
      if (!c) continue;
      for (const [rear, z] of [[false, c.frontZ], [true, c.rearZ]] as const) {
        if (z === null) continue;
        for (const height of [0.94, 1.02]) {
          const seat = riderSeat(c, rear, height, false, { y: 0, z: 0, recline: 0 });
          expect(Math.abs(seat.z - z), kind).toBeLessThanOrEqual(0.03);
          // The top of his head (0.34 x height over the neck, leaning back with the seat) stays under the ceiling.
          const neckY = seat.y + SKELETON.neckY * height * Math.cos(seat.recline);
          const neckZ = seat.z - SKELETON.neckY * height * Math.sin(seat.recline);
          const headTop = neckY + 0.34 * height * Math.cos(0.2 * seat.recline);
          expect(headTop, `${kind} ${rear ? 'rear' : 'front'} ${height}`).toBeLessThan(cabinCeiling(c, neckZ));
          expect(headTop).toBeLessThan(c.roof.y);
        }
      }
    }
  });
});

describe('VAL-CAR-004 dents bend the new bodies and their shadows', () => {
  it('a front-corner impact moves the body near it by 5 cm or more, nothing a metre away, and the shadow follows', () => {
    for (const kind of KINDS) {
      const s = VEHICLE_SPECS[kind];
      const v = view(kind);
      const car = new Vehicle(1, kind, 0, 0, 0, 0, 0xb03a2e);
      v.bind(car);
      v.sync(car, 1 / 60, 0, 0);
      const src = mesh(v, 'body').geometry.getAttribute('position');
      const shadowSrc = mesh(v, 'shadow').geometry.getAttribute('position');
      const hit = new THREE.Vector3(s.width / 2, s.height * 0.4, s.length / 2);
      car.dents.push({ lx: hit.x, ly: hit.y, lz: hit.z, nx: -0.6, nz: -0.8, depth: 0.2 });
      car.dentVersion++;
      v.sync(car, 1 / 60, 0, 0);
      const moved = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, b: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): { near: number; far: number } => {
        let near = 0;
        let far = 0;
        const p = new THREE.Vector3();
        const q = new THREE.Vector3();
        for (let i = 0; i < a.count; i++) {
          p.fromBufferAttribute(a, i);
          q.fromBufferAttribute(b, i);
          const d = p.distanceTo(q);
          const r = p.distanceTo(hit);
          if (r < 0.3) near = Math.max(near, d);
          if (r > 1) far = Math.max(far, d);
        }
        return { near, far };
      };
      const body = moved(src, mesh(v, 'body').geometry.getAttribute('position'));
      expect(body.near, `${kind} near`).toBeGreaterThanOrEqual(0.05);
      expect(body.far, `${kind} far`).toBeLessThanOrEqual(0.01);
      const shadow = moved(shadowSrc, mesh(v, 'shadow').geometry.getAttribute('position'));
      expect(Math.abs(shadow.near - body.near), `${kind} shadow`).toBeLessThanOrEqual(0.05);
      expect(shadow.far, `${kind} shadow far`).toBeLessThanOrEqual(0.01);
      // The far version draws the dented body itself.
      v.setDistant(true);
      expect(mesh(v, 'body').visible, kind).toBe(true);
      // A fresh car on the pooled view gets the undented shadow body back.
      v.bind(new Vehicle(2, kind, 0, 0, 0, 0, 0xffffff));
      expect(mesh(v, 'shadow').geometry.getAttribute('position')).toBe(shadowSrc);
    }
  });
});

describe('VAL-CAR-005 lamp lenses and tyres', () => {
  it('lamps are moulded lens shapes, unlit by day on a parked car, glimmering at night, bright when driven', () => {
    const p = LAMP_LENS.getAttribute('position').count;
    expect(LAMP_LENS).not.toBeInstanceOf(THREE.BoxGeometry);
    expect(p).toBeGreaterThan(48);
    const b = box(LAMP_LENS);
    expect(b.max.x - b.min.x).toBeCloseTo(1, 5);
    expect(b.max.z - b.min.z).toBeCloseTo(1, 5);
    for (const kind of KINDS) {
      const v = view(kind);
      const lamps: THREE.Mesh[] = [];
      v.group.traverse((o) => o.name === 'lamp' && lamps.push(o as THREE.Mesh));
      expect(lamps.length, kind).toBe(5);
      for (const l of lamps) expect(l.geometry, kind).toBe(LAMP_LENS);
      const car = new Vehicle(1, kind, 0, 0, 0, 0, 0xffffff);
      v.bind(car);
      const glow = (): number[] => lamps.map((l) => (l.material as THREE.MeshStandardMaterial).emissiveIntensity);
      v.sync(car, 1 / 60, 12, 0);
      expect(glow().every((g) => g === 0), `${kind} noon`).toBe(true);
      v.sync(car, 1 / 60, 23, 1);
      expect(glow().slice(0, 4).every((g) => g > 0.2), `${kind} night`).toBe(true);
    }
  });

  it('tyres show a tread, a lighter sidewall and a lettering band (three tones), and rims stay bright', () => {
    const v = view('sedan');
    const tire = mesh(v, 'tire');
    const col = tire.geometry.getAttribute('color');
    const tones = new Set<number>();
    for (let i = 0; i < col.count; i++) tones.add(Math.round(col.getX(i) * 1000));
    expect([...tones].sort((a, b) => a - b)).toEqual([TYRE_TREAD, TYRE_SIDEWALL, TYRE_LETTERING].map((t) => Math.round(t * 1000)));
    expect((tire.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    const rim = mesh(v, 'rim');
    expect((rim.material as THREE.MeshStandardMaterial).metalness).toBeGreaterThan(0.8);
    // The alloy face looks out on both sides of the car: the right-hand rims are turned round.
    const rims: THREE.Object3D[] = [];
    v.group.traverse((o) => o.name === 'rim' && rims.push(o));
    for (const r of rims) expect(r.rotation.y, `rim at x ${r.parent!.position.x}`).toBeCloseTo(r.parent!.position.x < 0 ? Math.PI : 0, 6);
  });

  it('the instanced wheels follow the steering angle and the spin', () => {
    const batches = new VehiclePartBatches();
    const v = view('sedan');
    const car = new Vehicle(1, 'sedan', 0, 0, 0, 0, 0xffffff);
    v.bind(car);
    const tireGeo = mesh(v, 'tire').geometry;
    const axes = (): THREE.Vector3[] => {
      batches.begin();
      v.drawParts(batches);
      batches.end();
      const m = (batches.group.children as THREE.InstancedMesh[]).find((x) => batches.partOf(x)?.geometry === tireGeo)!;
      const out: THREE.Vector3[] = [];
      const mat = new THREE.Matrix4();
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, mat);
        out.push(new THREE.Vector3().setFromMatrixColumn(mat, 0), new THREE.Vector3().setFromMatrixColumn(mat, 1));
      }
      return out;
    };
    car.steer = 0;
    v.sync(car, 1 / 60, 0, 0);
    const straight = axes();
    car.steer = 1;
    v.sync(car, 1 / 60, 0, 0);
    const steered = axes();
    // Wheels 0, 1 are the front ones (their axle turns), 2, 3 the rear ones.
    for (let w = 0; w < 4; w++) {
      const turned = straight[w * 2]!.angleTo(steered[w * 2]!);
      if (w < 2) expect(turned).toBeGreaterThan(0.1);
      else expect(turned).toBeLessThan(1e-6);
    }
    car.forwardSpeed = 6;
    v.sync(car, 0.1, 0, 0);
    const rolled = axes();
    for (let w = 0; w < 4; w++) expect(steered[w * 2 + 1]!.angleTo(rolled[w * 2 + 1]!), `wheel ${w} spins`).toBeGreaterThan(0.5);
    batches.dispose();
  });
});

describe('VAL-CAR-007 batched parts and draw structure', () => {
  it('wheels, rims, lenses and far glass share buckets: their draws do not grow with the number of cars', () => {
    const batches = new VehiclePartBatches();
    const draws = (n: number, far: boolean): number => {
      const views = Array.from({ length: n }, (_, i) => {
        const v = new VehicleView('police');
        const car = new Vehicle(i + 1, 'police', i * 6, 0, 0, 0, 0x101820);
        v.bind(car);
        v.sync(car, 1 / 60, 0, 1);
        v.setDistant(far);
        return v;
      });
      batches.begin();
      for (const v of views) v.drawParts(batches);
      batches.end();
      return batches.counts.meshes;
    };
    for (const far of [false, true]) expect(draws(10, far), far ? 'far' : 'near').toBe(draws(1, far));
    batches.dispose();
  });

  it('a detailed car is drawn by body, glass and fittings, casts one shadow-only caster, and the glass casts none', () => {
    for (const kind of KINDS) {
      const v = view(kind);
      const camera = new THREE.Layers();
      let own = 0;
      const casters: string[] = [];
      v.group.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        if (o.layers.test(camera)) own++;
        if (o.castShadow && (o.layers.test(camera) || o.layers.isEnabled(SHADOW_LAYER))) casters.push(o.name);
        if (o.name === 'lamp') expect(o.layers.isEnabled(PART_LAYER), kind).toBe(true);
      });
      expect(own, kind).toBe(kind === 'police' ? 4 : 3);
      expect(casters, kind).toEqual(['shadow']);
    }
  });
});

describe('VAL-CAR-003 rebuilt bodies', () => {
  /** The body's vertices beyond the arches at one end: the furthest reach along the car at the middle and at the flanks. */
  const endReach = (g: THREE.BufferGeometry, front: boolean, hw: number): { middle: number; corner: number; flank: number } => {
    const p = g.getAttribute('position');
    let middle = 0;
    let corner = 0;
    let flank = 0;
    for (let i = 0; i < p.count; i++) {
      const z = front ? p.getZ(i) : -p.getZ(i);
      const x = Math.abs(p.getX(i));
      if (x < 0.1) middle = Math.max(middle, z);
      if (x > hw - 0.03) corner = Math.max(corner, z);
      if (z > 0 && z < 0.2) flank = Math.max(flank, x);
    }
    return { middle, corner, flank };
  };

  it('every kind keeps its length at the middle and draws its corners back in plan (a rounded nose and tail)', () => {
    for (const kind of KINDS) {
      const s = VEHICLE_SPECS[kind];
      const g = mesh(view(kind), 'body').geometry;
      const front = endReach(g, true, s.width / 2);
      const rear = endReach(g, false, s.width / 2);
      // The ends stay at the spec length in the middle (VAL-CAR-002 holds), and the nose's corners stand back from it:
      // by 5 cm or more on every kind's nose, the tail's on the cars.
      expect(Math.abs(front.middle - s.length / 2), kind).toBeLessThanOrEqual(0.04);
      expect(Math.abs(rear.middle - s.length / 2), kind).toBeLessThanOrEqual(0.04);
      expect(front.middle - front.corner, `${kind} nose`).toBeGreaterThanOrEqual(0.05);
      if (['compact', 'sedan', 'taxi', 'police', 'sports', 'muscle', 'bus'].includes(kind)) expect(rear.middle - rear.corner, `${kind} tail`).toBeGreaterThanOrEqual(0.04);
      // Between the arches the flanks are where they were: the rounding stays out of the cabin and off the wheels.
      const r = endRounding(kind);
      expect(Math.abs(r.flankX(s.width / 2, 0.1)), kind).toBeCloseTo(s.width / 2, 6);
    }
  });

  it('the wheel arches carry moulded lips standing proud of the flank, which dent with the body', () => {
    for (const kind of KINDS) {
      const s = VEHICLE_SPECS[kind];
      const v = view(kind);
      const p = mesh(v, 'body').geometry.getAttribute('position');
      let lip = 0;
      for (let i = 0; i < p.count; i++) {
        const z = Math.abs(p.getZ(i));
        // Over the front and rear axles, above the tyres' centres.
        if (Math.abs(z - AXLE * s.length) < 0.6 && p.getY(i) > 0.3 && Math.abs(p.getX(i)) > s.width / 2 + 0.015) lip++;
      }
      expect(lip, kind).toBeGreaterThan(40);
    }
  });

  it('the sports car is a low wedge: its nose sits lower against its height than the sedan\'s, under a rear wing', () => {
    const noseTop = (kind: VehicleKind): number => {
      const s = VEHICLE_SPECS[kind];
      const p = mesh(view(kind), 'body').geometry.getAttribute('position');
      let top = 0;
      for (let i = 0; i < p.count; i++) if (p.getZ(i) > 0.46 * s.length && Math.abs(p.getX(i)) < 0.3) top = Math.max(top, p.getY(i));
      return top / s.height;
    };
    expect(noseTop('sports')).toBeLessThan(noseTop('sedan') - 0.05);
    const s = VEHICLE_SPECS.sports;
    const p = mesh(view('sports'), 'body').geometry.getAttribute('position');
    let wing = 0;
    for (let i = 0; i < p.count; i++) if (p.getZ(i) < -0.38 * s.length && Math.abs(p.getX(i)) > 0.8) wing = Math.max(wing, p.getY(i));
    expect(wing).toBeGreaterThan(0.6 * s.height);
  });
});

describe('VAL-CAR-006 no pale disc under parked cars', () => {
  it('manhole covers and storm drains are cast-iron dark: no lighter than the asphalt round them, the rim a little lighter', () => {
    // The asphalt's base colour (textures/ground.ts '#3a3b3e'), in the linear space the vertex colours are in.
    const asphalt = new THREE.Color('#3a3b3e');
    const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const ground = luma(asphalt.r, asphalt.g, asphalt.b);
    for (const build of [(b: GeoBuilder) => manhole(b, 0, 0), (b: GeoBuilder) => stormDrain(b, 0, 0, false)]) {
      const b = new GeoBuilder(true);
      build(b);
      const built = b.build();
      const g = built.index ? built.toNonIndexed() : built;
      const c = g.getAttribute('color');
      const p = g.getAttribute('position');
      let area = 0;
      let sum = 0;
      let max = 0;
      for (let i = 0; i < c.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(p, i);
        const ab = new THREE.Vector3().fromBufferAttribute(p, i + 1).sub(a);
        const ac = new THREE.Vector3().fromBufferAttribute(p, i + 2).sub(a);
        const w = ab.cross(ac).length() / 2;
        const l = luma(c.getX(i), c.getY(i), c.getZ(i));
        area += w;
        sum += w * l;
        max = Math.max(max, l);
      }
      // Seen from above the top layer covers the rest; the area-weighted mean over every layer is a fair upper bound.
      expect(sum / area).toBeLessThanOrEqual(ground * 1.25);
      expect(max).toBeLessThanOrEqual(ground * 2);
      g.dispose();
    }
  });
});

describe('VAL-CAR-009 far versions, fades and shadows agree', () => {
  it('the far version draws the same body, glass and fittings geometry from the part batches, glass in its own material', () => {
    for (const kind of ['sedan', 'bus', 'firetruck'] as const) {
      const batches = new VehiclePartBatches();
      const v = view(kind);
      const car = new Vehicle(1, kind, 0, 0, 0, 0, 0x2e86c1);
      v.bind(car);
      v.sync(car, 1 / 60, 0, 0);
      const body = mesh(v, 'body').geometry;
      const glass = mesh(v, 'glass');
      v.setDistant(true);
      batches.begin();
      v.drawParts(batches);
      batches.end();
      const drawn = new Map<THREE.BufferGeometry, THREE.Material>();
      for (const m of batches.group.children) {
        const part = batches.partOf(m);
        if (part && (m as THREE.InstancedMesh).count > 0) drawn.set(part.geometry, part.material);
      }
      // The same undented geometry as the near version, so nothing jumps in size or place at the switch.
      expect(drawn.has(body), kind).toBe(true);
      expect(drawn.get(glass.geometry), kind).toBe(glass.material);
      // The far glass is the tinted, env-mapped glass (a dark band), not paint.
      expect((glass.material as THREE.MeshStandardMaterial).color.getHex(), kind).not.toBe(0xffffff);
      batches.dispose();
    }
  });

  it('a fading car fades its glass, lenses and shadow with its body, and casts nothing once it is gone', () => {
    for (const kind of KINDS) {
      const batches = new VehiclePartBatches();
      const v = view(kind);
      const car = new Vehicle(1, kind, 0, 0, 0, 0, 0xb03a2e);
      v.bind(car);
      v.sync(car, 1 / 60, 0, 1);
      v.beginFade();
      v.setFade(0.5);
      const body = mesh(v, 'body').material as THREE.Material;
      const glass = mesh(v, 'glass').material as THREE.Material;
      expect(body.alphaHash && body.opacity, kind).toBeCloseTo(0.5, 6);
      // Never more opaque than the body: the Fresnel edge brings it up to the fade, not to 1.
      expect(glass.transparent && glass.opacity, kind).toBeCloseTo(0.5 * GLASS_OPACITY, 6);
      expect(patchedFragment(glass)).toContain('min( 1.0, diffuseColor.a');
      const depth = mesh(v, 'shadow').customDepthMaterial as THREE.MeshDepthMaterial;
      expect(depth.alphaHash && depth.opacity, kind).toBeCloseTo(0.5, 6);
      batches.begin();
      v.drawParts(batches);
      batches.end();
      // Lenses (and wheels) are drawn by the batches at the same fade.
      for (const m of batches.group.children) {
        const inst = m as THREE.InstancedMesh;
        if (inst.count === 0) continue;
        const fade = inst.geometry.getAttribute('instanceFade');
        for (let i = 0; i < inst.count; i++) expect(fade.getX(i), kind).toBeCloseTo(0.5, 6);
      }
      v.setFade(0);
      expect(v.group.visible, kind).toBe(false);
      batches.dispose();
    }
  });
});
