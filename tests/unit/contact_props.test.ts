// Contact shadows and the instanced prop batches: a batch is judged by where its instances are (the mesh's own bounding
// sphere), not by the one-prop base geometry at the world origin. Headless (canvas stubs); no WebGL.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CONTACT_RANGE, shadesContact } from '../../src/render/contactShadows';
import { PropsView } from '../../src/render/props';
import { HARDWARE_CHUNK_SIZE } from '../../src/render/spatial';
import type { Prop } from '../../src/world/layout';
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
    return new Proxy(store, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  };
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, clientWidth: 1280, clientHeight: 720, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {}, removeEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

const W = world();

/** What the contact pass would take from the frame's opaque list: a mesh in the camera's frustum that `shadesContact` accepts. */
function pass(view: PropsView, eye: THREE.Vector3, look: THREE.Vector3): { meshes: THREE.InstancedMesh[]; triangles: number } {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 600);
  camera.position.copy(eye);
  camera.lookAt(look);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  view.group.updateMatrixWorld(true);
  const meshes: THREE.InstancedMesh[] = [];
  let triangles = 0;
  view.group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh) || !o.visible || o.layers.mask === 0 || !frustum.intersectsObject(o)) return;
    const material = o.material as THREE.Material;
    if (!shadesContact({ object: o, geometry: o.geometry, material, group: null }, eye, CONTACT_RANGE)) return;
    meshes.push(o);
    const g = o.geometry;
    triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3 * o.count;
  });
  return { meshes, triangles };
}

/** The instanced batches that draw prop `pi`. */
function batchesOf(view: PropsView, pi: number): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  view.group.traverse((o) => {
    if (o instanceof THREE.InstancedMesh && (o.userData.propIndices as number[] | undefined)?.includes(pi)) found.push(o);
  });
  return found;
}

describe('contact shadows take instanced props by where their instances are', () => {
  const view = new PropsView(W, HARDWARE_CHUNK_SIZE);
  const props = W.layout.props;
  // The prop of each kind farthest from the world origin: its batch is a cell nowhere near (0, 0, 0).
  const farthest = (kind: Prop['kind']): number => {
    let best = -1;
    props.forEach((p, i) => {
      if (p.kind === kind && (best < 0 || Math.hypot(p.x, p.z) > Math.hypot(props[best]!.x, props[best]!.z))) best = i;
    });
    return best;
  };

  it.each(['bench', 'bin', 'hydrant', 'lamp'] as const)('a %s far from the origin is drawn into the depth pass from 6 m away', (kind) => {
    const pi = farthest(kind);
    expect(pi).toBeGreaterThanOrEqual(0);
    const p = props[pi]!;
    expect(Math.hypot(p.x, p.z)).toBeGreaterThan(CONTACT_RANGE * 2);
    const eye = new THREE.Vector3(p.x + 6, p.y + 1.7, p.z);
    const batches = batchesOf(view, pi);
    expect(batches.length).toBeGreaterThan(0);
    view.group.updateMatrixWorld(true);
    const solid = batches.filter((m) => !(m.material as THREE.Material).transparent && (m.material as THREE.Material).depthWrite);
    expect(solid.length).toBeGreaterThan(0);
    for (const mesh of batches) {
      const material = mesh.material as THREE.Material;
      // Light pools, glows and proxies drawn only into the shadow map are not meant for the depth pass.
      if (material.userData.contactShadow === false || mesh.userData.contactShadow === false || material.transparent || !material.depthWrite) continue;
      expect(shadesContact({ object: mesh, geometry: mesh.geometry, material, group: null }, eye, CONTACT_RANGE), `${kind} ${mesh.name || mesh.geometry.name}`).toBe(true);
    }
  });

  it('an instanced batch farther than the range from the eye stays out, by its own bounding sphere', () => {
    const pi = farthest('bench');
    const p = props[pi]!;
    const eye = new THREE.Vector3(p.x + 400, p.y + 1.7, p.z);
    for (const mesh of batchesOf(view, pi)) {
      const material = mesh.material as THREE.Material;
      expect(shadesContact({ object: mesh, geometry: mesh.geometry, material, group: null }, eye, CONTACT_RANGE)).toBe(false);
    }
  });

  it('reports what the pass takes at some viewpoints', () => {
    const report: string[] = [];
    for (const kind of ['bench', 'hydrant', 'lamp', 'tree'] as const) {
      const of = props.map((p, i) => ({ p, i })).filter((e) => e.p.kind === kind).sort((a, b) => Math.hypot(a.p.x, a.p.z) - Math.hypot(b.p.x, b.p.z));
      for (const [label, e] of [['nearest the origin', of[0]], ['median', of[of.length >> 1]], ['farthest', of[of.length - 1]]] as const) {
        const p = e!.p;
        const r = pass(view, new THREE.Vector3(p.x + 6, p.y + 2, p.z), new THREE.Vector3(p.x, p.y + 1, p.z));
        report.push(`${kind} ${label} (${Math.round(p.x)}, ${Math.round(p.z)}): ${r.meshes.length} meshes, ${Math.round(r.triangles)} triangles`);
      }
    }
    console.log(['[contact props]', ...report].join('\n'));
  });
});
