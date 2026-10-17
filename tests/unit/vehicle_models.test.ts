// Vehicle model checks (P22): windshields on the box-shaped vehicles, the pickup's open bed, wheels inside the body
// outline and an unchanged mesh count. The render modules run headless: a tiny canvas/document stub (copied from
// fix_render.test.ts) feeds the procedural textures.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { VehicleView } from '../../src/render/vehicleView';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';

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

const KINDS = Object.keys(VEHICLE_SPECS) as VehicleKind[];

function view(kind: VehicleKind): VehicleView {
  const v = new VehicleView(kind);
  v.group.updateMatrixWorld(true);
  return v;
}

/** Name of the first 'glass' or 'body' mesh a ray hits (lamps, wheels and roof gear are looked through). */
function firstHit(v: VehicleView, origin: THREE.Vector3, dir: THREE.Vector3): { name: string; point: THREE.Vector3 } | null {
  const rc = new THREE.Raycaster(origin, dir.clone().normalize(), 0, 100);
  for (const h of rc.intersectObject(v.group, true)) {
    if (h.object.name === 'glass' || h.object.name === 'body') return { name: h.object.name, point: h.point };
  }
  return null;
}

/** Of the rays at 0.6, 0.7, 0.8 and 0.9 x height (x across), those whose first hit is glass. */
function glassHits(v: VehicleView, fromFront: boolean, x = 0): number[] {
  const s = VEHICLE_SPECS[v.kind];
  const out: number[] = [];
  for (const k of [0.6, 0.7, 0.8, 0.9]) {
    const z = (fromFront ? 1 : -1) * (s.length / 2 + 6);
    const hit = firstHit(v, new THREE.Vector3(x, k * s.height, z), new THREE.Vector3(0, 0, fromFront ? -1 : 1));
    if (hit?.name === 'glass') out.push(k);
  }
  return out;
}

describe('vehicle models', () => {
  it('every vehicle shows its windshield to a ray from 6 m in front, box-shaped ones included', () => {
    for (const kind of KINDS) {
      const hits = glassHits(view(kind), true);
      // Low hoods hide the 0.6 ray on some cars; the windshield must show over most of the band and at 0.8.
      expect(hits.length, `${kind} front: ${hits.join(',')}`).toBeGreaterThanOrEqual(3);
      expect(hits, kind).toContain(0.8);
    }
  });

  it('the van and the bus have rear windows', () => {
    // The van's two rear door windows sit either side of the centre pillar.
    for (const [kind, x] of [['van', 0.35], ['van', -0.35], ['bus', 0]] as const) {
      const hits = glassHits(view(kind), false, x);
      expect(hits.length, `${kind} rear: ${hits.join(',')}`).toBeGreaterThanOrEqual(2);
      expect(hits, kind).toContain(0.7);
    }
  });

  it('the pickup has an open bed: a ray down at 30% of the length from the tail hits below 0.45 x height', () => {
    const v = view('pickup');
    const s = VEHICLE_SPECS.pickup;
    for (const x of [-0.4, 0, 0.4]) {
      const hit = firstHit(v, new THREE.Vector3(x, s.height + 2, -s.length / 2 + 0.3 * s.length), new THREE.Vector3(0, -1, 0));
      expect(hit?.name).toBe('body');
      expect(hit!.point.y).toBeLessThan(0.45 * s.height);
      expect(hit!.point.y).toBeGreaterThan(0.35 * s.height);
    }
    // The bed has walls: a ray across the bed from the side hits the body before reaching the middle.
    const wall = firstHit(v, new THREE.Vector3(5, 0.52 * s.height, -s.length / 2 + 0.3 * s.length), new THREE.Vector3(-1, 0, 0));
    expect(wall?.name).toBe('body');
    expect(wall!.point.x).toBeGreaterThan(s.width / 2 - 0.1);
  });

  it('wheels stay inside the body outline, and the arches show them from the side', () => {
    for (const kind of KINDS) {
      const v = view(kind);
      const s = VEHICLE_SPECS[kind];
      let wheels = 0;
      v.group.traverse((o) => {
        if (o.name !== 'tire' && o.name !== 'rim') return;
        wheels++;
        const box = new THREE.Box3().setFromObject(o);
        expect(Math.max(Math.abs(box.min.x), Math.abs(box.max.x)), `${kind} ${o.name}`).toBeLessThanOrEqual(s.width / 2 + 1e-6);
      });
      expect(wheels).toBe(8);
      // A ray from the side at the wheel centre's height reaches a tyre or rim before any body.
      v.group.traverse((o) => {
        if (o.name !== 'tire') return;
        const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
        const side = Math.sign(c.x);
        const rc = new THREE.Raycaster(new THREE.Vector3(side * 6, c.y + 0.05, c.z), new THREE.Vector3(-side, 0, 0), 0, 20);
        const first = rc.intersectObject(v.group, true)[0];
        expect(first?.object.name, `${kind} wheel at z ${c.z.toFixed(2)}`).toMatch(/tire|rim/);
      });
    }
  });

  it('keeps one mesh per part: no new draw calls per vehicle', () => {
    const count = (kind: VehicleKind): number => {
      let n = 0;
      view(kind).group.traverse((o) => {
        if (o instanceof THREE.Mesh) n++;
      });
      return n;
    };
    expect(count('sedan')).toBe(15);
    expect(count('police')).toBe(19);
    expect(count('taxi')).toBe(16);
    expect(count('swat')).toBe(18);
    for (const kind of ['compact', 'sports', 'muscle', 'pickup', 'van', 'bus'] as const) expect(count(kind), kind).toBe(15);
    // Named for tests and tools.
    const names = new Set<string>();
    view('sedan').group.traverse((o) => {
      if (o instanceof THREE.Mesh) names.add(o.name);
    });
    expect([...names].sort()).toEqual(['body', 'glass', 'lamp', 'rim', 'tire']);
  });
});
