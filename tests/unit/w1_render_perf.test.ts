// Track D (wave 1) render performance: the vehicle draw structure (instanced parts, one shadow caster, the merged far
// version), High's pixel budget and the contact-shadow fade.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CONTACT_FADE_IN, CONTACT_INTENSITY, ContactShadows } from '../../src/render/contactShadows';
import { HIGH_PIXEL_BUDGET, pixelRatioFor, QUALITY, QUALITY_TIERS } from '../../src/render/quality';
import { PART_LAYER, SHADOW_LAYER, VehiclePartBatches } from '../../src/render/vehicleBatches';
import { VehicleView } from '../../src/render/vehicleView';
import { makeSim } from './helpers';
import type { Vehicle } from '../../src/sim/entities';
import type { VehicleKind } from '../../src/sim/specs';

// The procedural textures need a 2D canvas (stub as in vehicle_models.test.ts).
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
});

const CAMERA = new THREE.Layers();

function cars(kind: VehicleKind, n: number): Array<{ v: Vehicle; view: VehicleView }> {
  const sim = makeSim();
  const out: Array<{ v: Vehicle; view: VehicleView }> = [];
  for (let i = 0; i < n; i++) {
    const v = sim.spawnVehicle(kind, i * 8, 0, 0);
    const view = new VehicleView(kind);
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    out.push({ v, view });
  }
  return out;
}

function frame(batches: VehiclePartBatches, list: Array<{ view: VehicleView }>): void {
  batches.begin();
  for (const { view } of list) view.drawParts(batches);
  batches.end();
}

describe('vehicle part batches', () => {
  it('draw every car of a kind with the same few instanced meshes, one slot per live part', () => {
    const batches = new VehiclePartBatches();
    const ten = cars('sedan', 10);
    frame(batches, ten);
    const at10 = batches.counts;
    const thirty = cars('sedan', 30);
    frame(batches, thirty);
    const at30 = batches.counts;
    // Tyres, rims, and every head, tail and reverse lamp in one more draw.
    expect(at30.meshes).toBe(at10.meshes);
    expect(at30.meshes).toBe(3);
    const s = ten[0]!.view.group;
    const tire = s.getObjectByName('tire') as THREE.Mesh;
    const rim = s.getObjectByName('rim') as THREE.Mesh;
    expect(batches.instancesOf(tire.geometry)).toBe(4 * 30);
    expect(batches.instancesOf(rim.geometry)).toBe(4 * 30);
    // Cars removed from the frame hold no slots.
    frame(batches, thirty.slice(0, 3));
    expect(batches.instancesOf(tire.geometry)).toBe(12);
    expect(batches.counts.instances).toBe(3 * 13);
    frame(batches, []);
    expect(batches.counts).toMatchObject({ meshes: 0, instances: 0 });
    for (const m of batches.group.children) expect(m.visible).toBe(false);
    batches.dispose();
    expect(batches.group.children.length).toBe(0);
  });

  it('place each instance where the part itself is: steered and spinning wheels, lamps carried by dents', () => {
    const batches = new VehiclePartBatches();
    const [{ v, view }] = cars('police', 1) as [{ v: Vehicle; view: VehicleView }];
    v.steer = 1;
    v.forwardSpeed = 9;
    v.heading = 0.7;
    v.siren = true;
    v.dents.push({ lx: 0, ly: v.spec.height * 0.9, lz: 0, nx: 0, nz: 0, depth: 0.1 } as never);
    v.dentVersion++;
    view.sync(v, 0.1, 1, 0.8);
    frame(batches, [{ view }]);
    view.group.updateMatrixWorld(true);
    const parts: THREE.Mesh[] = [];
    view.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.layers.isEnabled(PART_LAYER)) parts.push(o);
    });
    expect(parts.length).toBe(16);
    const inst = new THREE.Matrix4();
    for (const p of parts) {
      const want = p.matrixWorld.clone();
      if (p.geometry instanceof THREE.BoxGeometry) {
        const g = p.geometry.parameters;
        want.multiply(new THREE.Matrix4().makeScale(g.width, g.height, g.depth));
      }
      // Find the instance with this transform among the meshes drawing the part's geometry.
      let found = false;
      for (const m of batches.group.children as THREE.InstancedMesh[]) {
        for (let i = 0; i < m.count && !found; i++) {
          m.getMatrixAt(i, inst);
          if (inst.elements.every((e, k) => Math.abs(e - want.elements[k]!) < 1e-4)) found = true;
        }
      }
      expect(found, `${p.name || 'roof gear'} instance`).toBe(true);
    }
    batches.dispose();
  });

  it('draw burnt-out wrecks without tyres, with charred rims, and smashed lamps dark', () => {
    const batches = new VehiclePartBatches();
    const list = cars('sedan', 2);
    const [wreck, dented] = list as [{ v: Vehicle; view: VehicleView }, { v: Vehicle; view: VehicleView }];
    wreck.v.destroyed = true;
    wreck.view.sync(wreck.v, 1 / 60, 0, 0);
    dented.v.dents.push({ lx: 0.6, ly: 0.3, lz: dented.v.spec.length / 2, nx: 0, nz: -1, depth: 0.25 } as never);
    dented.v.dentVersion++;
    dented.view.sync(dented.v, 1 / 60, 0, 0);
    frame(batches, list);
    const tire = wreck.view.group.getObjectByName('tire') as THREE.Mesh;
    expect(batches.instancesOf(tire.geometry)).toBe(4);
    const live = (batches.group.children as THREE.InstancedMesh[]).filter((m) => m.count > 0);
    // Charred rims are drawn with the wreck's burnt material.
    expect(live.some((m) => (m.material as THREE.MeshStandardMaterial).color.getHex() === 0x1d1b19 && batches.partOf(m)?.geometry === (wreck.view.group.getObjectByName('rim') as THREE.Mesh).geometry)).toBe(true);
    // The lamps share one draw; the smashed one is dark and unlit, the charred ones too.
    const lamps = live.find((m) => m.instanceColor)!;
    const colours = new Set<number>();
    const glows: number[] = [];
    const c = new THREE.Color();
    const em = lamps.geometry.getAttribute('partEmissive');
    for (let i = 0; i < lamps.count; i++) {
      lamps.getColorAt(i, c);
      colours.add(c.getHex());
      glows.push(em.getX(i) + em.getY(i) + em.getZ(i));
    }
    expect(lamps.count).toBe(10);
    expect(colours.has(0x161616)).toBe(true);
    expect(colours.has(0x1d1b19)).toBe(true);
    expect(glows.filter((g) => g === 0).length).toBeGreaterThanOrEqual(6);
    batches.dispose();
  });

  it('keep a fixed set of lamp draws as the lights come up through dusk', () => {
    const batches = new VehiclePartBatches();
    const list = cars('sedan', 8);
    const sim = makeSim();
    let most = 0;
    let buckets = 0;
    for (let f = 0; f < 200; f++) {
      const night = f / 200;
      list.forEach(({ v, view }, i) => {
        v.driver = i % 2 ? sim.player : null;
        v.braking = i % 3 === 0;
        view.sync(v, 1 / 60, f / 60, night);
      });
      frame(batches, list);
      most = Math.max(most, batches.counts.meshes);
      buckets = Math.max(buckets, batches.counts.buckets);
    }
    // Tyres, rims and one draw for every lamp, whatever state each is in. Revised (mission 3 cars): the lamps are lens
    // shapes in a batch of their own, so the box parts' bucket stays empty on a sedan (4 buckets, 3 draws).
    expect(most).toBe(3);
    expect(buckets).toBe(4);
    batches.dispose();
  });
});

describe('vehicle draw structure', () => {
  it('a detailed car casts its shadow with one merged body; the meshes the camera draws cast none', () => {
    const [{ view }] = cars('sedan', 1) as [{ v: Vehicle; view: VehicleView }];
    const casters: THREE.Mesh[] = [];
    view.group.traverseVisible((o) => {
      if (o instanceof THREE.Mesh && o.castShadow && (o.layers.test(CAMERA) || o.layers.isEnabled(SHADOW_LAYER))) casters.push(o);
    });
    expect(casters.map((m) => m.name)).toEqual(['shadow']);
    // It covers the body, glass, fittings and tyres.
    const box = new THREE.Box3().setFromObject(casters[0]!);
    const body = new THREE.Box3().setFromObject(view.group.getObjectByName('body')!);
    expect(box.max.y).toBeGreaterThan(body.max.y - 0.01);
    expect(box.min.y).toBeLessThan(0.02);
  });

  it('far cars draw nothing of their own: bodies, glass and fittings join their kind batches with the paint per car', () => {
    const batches = new VehiclePartBatches();
    for (const kind of ['sedan', 'police', 'taxi', 'bus'] as const) {
      const list = cars(kind, 3);
      list.forEach(({ v, view }, i) => {
        v.color = [0xc0392b, 0x2e86c1, 0xf1c40f][i]!;
        view.setDistant(true);
        view.sync(v, 1 / 60, 0, 0);
      });
      const { v, view } = list[0]!;
      const own = (): THREE.Mesh[] => {
        const out: THREE.Mesh[] = [];
        view.group.traverseVisible((o) => {
          if (o instanceof THREE.Mesh && (o.layers.test(CAMERA) || o.layers.isEnabled(SHADOW_LAYER))) out.push(o);
        });
        return out;
      };
      expect(own(), kind).toEqual([]);
      frame(batches, list);
      const body = view.group.getObjectByName('body') as THREE.Mesh;
      const glass = view.group.getObjectByName('glass') as THREE.Mesh;
      const exterior = view.group.getObjectByName('exterior') as THREE.Mesh;
      expect(batches.instancesOf(body.geometry), kind).toBe(3);
      expect(batches.instancesOf(glass.geometry), kind).toBe(3);
      expect(batches.instancesOf(exterior.geometry), kind).toBe(3);
      expect(batches.instancesOf((view.group.getObjectByName('tire') as THREE.Mesh).geometry), kind).toBe(12);
      // One draw for the three bodies, casting their shadows, out of the contact pass, each in its own paint.
      const bodies = (batches.group.children as THREE.InstancedMesh[]).filter((m) => batches.partOf(m)?.geometry === body.geometry && m.count > 0);
      expect(bodies.length).toBe(1);
      expect(bodies[0]!.castShadow).toBe(true);
      expect(bodies[0]!.userData.contactShadow).toBe(false);
      const c = new THREE.Color();
      expect([0, 1, 2].map((i) => bodies[0]!.getColorAt(i, c).getHex())).toEqual(list.map(({ view: w }) => ((w.group.getObjectByName('body') as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex()));
      // A dented one draws its own bent body (and its shadow).
      v.dents.push({ lx: 0, ly: 0.5, lz: v.spec.length / 2, nx: 0, nz: -1, depth: 0.2 } as never);
      v.dentVersion++;
      view.sync(v, 1 / 60, 0, 0);
      expect(own().map((m) => m.name)).toEqual(['body']);
      expect(own()[0]!.castShadow).toBe(true);
      expect(own()[0]!.userData.contactShadow).toBe(false);
      // A burnt-out wreck: charred, no glass.
      v.destroyed = true;
      view.sync(v, 1 / 60, 0, 0);
      expect((body.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x1d1b19);
      frame(batches, [{ view }]);
      expect(batches.instancesOf(glass.geometry), kind).toBe(0);
      // Back near: the merged shadow body casts again.
      view.setDistant(false);
      expect(body.castShadow).toBe(false);
      expect(body.userData.contactShadow).toBeUndefined();
      expect(own().map((m) => m.name).sort()).toEqual(['body', 'exterior', 'shadow', ...(kind === 'police' ? [''] : [])].sort());
    }
    batches.dispose();
  });
});

describe('High pixel budget', () => {
  it('keeps High within the budget on every window size and display density, never above its cap', () => {
    for (const [w, h] of [[1280, 720], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160]] as const) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const r = pixelRatioFor('high', dpr, w, h);
        expect(Math.floor(w * r) * Math.floor(h * r), `${w}x${h} @${dpr}`).toBeLessThanOrEqual(HIGH_PIXEL_BUDGET);
        expect(r).toBeLessThanOrEqual(QUALITY.high.dprCap);
      }
    }
    // A 1080p window on a dpr-1 display draws at full resolution as before; on Retina it is capped.
    expect(pixelRatioFor('high', 1, 1920, 1080)).toBe(1);
    const retina = pixelRatioFor('high', 2, 1920, 1080);
    expect(retina).toBeGreaterThan(1.25);
    expect(retina).toBeLessThan(1.5);
    // Medium and Low keep their own caps.
    for (const q of QUALITY_TIERS.filter((t) => t !== 'high')) expect(pixelRatioFor(q, 2, 1920, 1080)).toBe(pixelRatioFor(q, 2));
  });
});

describe('contact shadows in motion', () => {
  function cam(): THREE.PerspectiveCamera {
    const c = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 600);
    c.position.set(0, 2, 0);
    return c;
  }

  it('fade out while the camera moves fast, are skipped, and come back within half a second without a jump', () => {
    const camera = cam();
    const cs = new ContactShadows(new THREE.Scene(), camera);
    const dt = 1 / 60;
    for (let i = 0; i < 10; i++) cs.track(dt);
    expect(cs.enabled).toBe(true);
    expect(cs.blendIntensity).toBeCloseTo(CONTACT_INTENSITY);
    // Driving at 15 m/s.
    let frames = 0;
    while (cs.enabled && frames < 120) {
      camera.position.z += 15 * dt;
      cs.track(dt);
      frames++;
    }
    expect(cs.enabled).toBe(false);
    expect(frames * dt).toBeLessThan(0.35);
    // Slowing to a walk: back to full strength within 0.5 s, never by more than a frame's share at once.
    let last = cs.blendIntensity;
    let t = 0;
    while (cs.blendIntensity < CONTACT_INTENSITY - 1e-9 && t < 1) {
      camera.position.z += 1.5 * dt;
      cs.track(dt);
      expect(cs.blendIntensity - last).toBeLessThanOrEqual((CONTACT_INTENSITY * dt) / CONTACT_FADE_IN + 1e-9);
      last = cs.blendIntensity;
      t += dt;
    }
    expect(t).toBeLessThanOrEqual(0.5);
    expect(cs.enabled).toBe(true);
    cs.dispose();
  });

  it('draw depth and normals no further than their range, with the drawn camera otherwise unchanged', () => {
    const camera = cam();
    const cs = new ContactShadows(new THREE.Scene(), camera);
    cs.setSize(640, 360);
    const own = cs.camera as THREE.PerspectiveCamera;
    expect(own).not.toBe(camera);
    expect(own.far).toBeLessThan(camera.far);
    expect(own.fov).toBe(camera.fov);
    expect(camera.far).toBe(600);
    cs.dispose();
  });
});
