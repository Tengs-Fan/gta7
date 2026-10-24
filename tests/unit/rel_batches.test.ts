// Static draw batching of the city and props on hardware GPUs: thin ground surfaces are one draw per layer, shadow
// casters and props use bigger cells, and nothing is lost to the coarser cells (every triangle and instance stays).

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { PropsView } from '../../src/render/props';
import { HARDWARE_CHUNK_SIZE, STATIC_CHUNK_SIZE } from '../../src/render/spatial';
import { world } from './helpers';

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
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

const meshes = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
};

const triangles = (m: THREE.Mesh): number => (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3;

/** Triangles (instances × triangles for instanced draws) per mesh name. */
function trianglesByName(root: THREE.Object3D): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of meshes(root)) {
    const n = triangles(m) * (m instanceof THREE.InstancedMesh ? m.count : 1);
    out.set(m.name, (out.get(m.name) ?? 0) + n);
  }
  return out;
}

describe('city batches on hardware GPUs', () => {
  let fine: CityView;
  let coarse: CityView;

  beforeAll(() => {
    fine = new CityView(world(), STATIC_CHUNK_SIZE);
    coarse = new CityView(world(), HARDWARE_CHUNK_SIZE);
  });

  const byName = (c: CityView, name: string): THREE.Mesh[] => meshes(c.group).filter((m) => m.name === name);

  it('draws each thin ground surface (casting no shadow) as one mesh, whatever the cell size', () => {
    for (const name of ['roads', 'road-gutters', 'sidewalks', 'curbs', 'markings-white', 'markings-yellow', 'street-ironwork', 'ground-plaza', 'ground-grass']) {
      expect(byName(fine, name).length, name).toBe(1);
      expect(byName(coarse, name).length, name).toBe(1);
    }
  });

  it('batches shadow casters in bigger cells without losing a triangle', () => {
    const casters = meshes(coarse.group).filter((m) => m.castShadow);
    expect(casters.length).toBeGreaterThan(0);
    expect(casters.length).toBeLessThan(meshes(fine.group).filter((m) => m.castShadow).length * 0.6);
    const a = trianglesByName(fine.group);
    const b = trianglesByName(coarse.group);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [name, n] of a) expect(b.get(name), name).toBe(n);
  });

  it('keeps shadow and receive flags per layer', () => {
    for (const m of meshes(coarse.group)) {
      const twin = byName(fine, m.name)[0]!;
      expect(m.castShadow, m.name).toBe(twin.castShadow);
      expect(m.receiveShadow, m.name).toBe(twin.receiveShadow);
    }
  });

  it('is much cheaper to submit: well under half the draw meshes of the fine cells', () => {
    expect(meshes(coarse.group).length).toBeLessThan(meshes(fine.group).length * 0.4);
  });
});

describe('props batches on hardware GPUs', () => {
  it('batches instances in bigger cells and keeps every instance', () => {
    const fine = new PropsView(world());
    const coarse = new PropsView(world(), HARDWARE_CHUNK_SIZE);
    const count = (p: PropsView): { meshes: number; instances: number } => {
      let meshes = 0;
      let instances = 0;
      p.group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) {
          meshes++;
          instances += o.count;
        }
      });
      return { meshes, instances };
    };
    const a = count(fine);
    const b = count(coarse);
    expect(b.instances).toBe(a.instances);
    expect(b.meshes).toBeLessThan(a.meshes * 0.6);
  });

  it('keeps every prop reachable for knock-over (restoreAll)', () => {
    const coarse = new PropsView(world(), HARDWARE_CHUNK_SIZE);
    expect(() => coarse.restoreAll()).not.toThrow();
  });
});
