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

const takes = (mesh: THREE.InstancedMesh, eye: THREE.Vector3): boolean => shadesContact({ object: mesh, geometry: mesh.geometry, material: mesh.material as THREE.Material, group: null }, eye, CONTACT_RANGE);
/** A batch the pass never takes: a light pool or glow (transparent or without depth), a dissolving pole or a shadow-map proxy. */
const opted = (mesh: THREE.InstancedMesh): boolean => {
  const m = mesh.material as THREE.Material;
  return m.transparent || !m.depthWrite || m.userData.contactShadow === false || mesh.userData.contactShadow === false;
};

describe('contact shadows take instanced props by where their instances are', () => {
  const view = new PropsView(W, HARDWARE_CHUNK_SIZE);
  const props = W.layout.props;
  view.group.updateMatrixWorld(true);
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
    const solid = batches.filter((m) => !opted(m));
    expect(solid.length).toBeGreaterThan(0);
    for (const mesh of batches) expect(takes(mesh, eye), `${kind} ${mesh.name || mesh.geometry.name}`).toBe(!opted(mesh));
  });

  it('a batch whose instances are all far from the eye stays out even with the eye at the world origin', () => {
    // The old test took the one-prop geometry's sphere at (0, 0, 0): a bench batch 900 m away counted as in range.
    const eye = new THREE.Vector3(0, 2, 0);
    for (const kind of ['bench', 'hydrant', 'lamp'] as const) {
      const pi = farthest(kind);
      const batches = batchesOf(view, pi).filter((m) => !opted(m));
      expect(batches.length, kind).toBeGreaterThan(0);
      for (const mesh of batches) {
        const sphere = mesh.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld);
        expect(sphere.center.distanceTo(eye) - sphere.radius, `${kind} batch is out of range`).toBeGreaterThan(CONTACT_RANGE);
        expect(takes(mesh, eye), `${kind} ${mesh.geometry.name}`).toBe(false);
      }
    }
  });

  it('takes the street furniture near the camera at each kind of viewpoint, for a bounded cost', () => {
    const names: Record<string, string> = { bench: 'bench', hydrant: 'hydrant', lamp: 'lamp-pole' };
    for (const kind of ['bench', 'hydrant', 'lamp', 'tree'] as const) {
      const of = props.map((p, i) => ({ p, i })).filter((e) => e.p.kind === kind).sort((a, b) => Math.hypot(a.p.x, a.p.z) - Math.hypot(b.p.x, b.p.z));
      for (const e of [of[0], of[of.length >> 1], of[of.length - 1]]) {
        const p = e!.p;
        const r = pass(view, new THREE.Vector3(p.x + 6, p.y + 2, p.z), new THREE.Vector3(p.x, p.y + 1, p.z));
        const where = `${kind} at (${Math.round(p.x)}, ${Math.round(p.z)}): ${r.meshes.length} meshes, ${Math.round(r.triangles)} triangles`;
        expect(r.meshes.length, where).toBeGreaterThan(0);
        // Seen at 8 to 45 meshes and 10 K to 410 K triangles; a batch sphere dragged out to the origin would add the whole city's.
        expect(r.meshes.length, where).toBeLessThanOrEqual(60);
        expect(r.triangles, where).toBeLessThanOrEqual(600_000);
        const name = names[kind];
        if (name) expect(r.meshes.map((m) => m.geometry.name), where).toContain(name);
      }
    }
  });
});

describe('a knocked-down prop stays where its batch is', () => {
  // A fresh view: breaking props changes the shared ones the tests above read.
  const props = W.layout.props;
  const farthest = (kind: Prop['kind']): number => {
    let best = -1;
    props.forEach((p, i) => {
      if (p.kind === kind && (best < 0 || Math.hypot(p.x, p.z) > Math.hypot(props[best]!.x, props[best]!.z))) best = i;
    });
    return best;
  };

  it.each(['hydrant', 'lamp'] as const)('hiding a %s far from the origin leaves its batches\' bounding spheres where they were', (kind) => {
    const view = new PropsView(W, HARDWARE_CHUNK_SIZE);
    const pi = farthest(kind);
    const p = props[pi]!;
    expect(Math.hypot(p.x, p.z)).toBeGreaterThan(CONTACT_RANGE * 2);
    const meshes: THREE.InstancedMesh[] = [];
    view.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) meshes.push(o);
    });
    const before = new Map(meshes.map((m) => [m, m.boundingSphere?.clone() ?? null]));
    view.breakProp(pi, 1, 0);
    // The batches that held the prop: its instance is now a point at the prop (scale 0), not at the origin.
    const held = meshes.filter((m) => (m.userData.propIndices as number[] | undefined)?.includes(pi));
    expect(held.length, 'the prop has batches').toBeGreaterThan(0);
    const origin = new THREE.Vector3();
    // A shrunk instance still adds its position (the lamp head's offset above the foot is lost with its scale): a few metres, not the distance to the origin.
    for (const m of meshes) {
      const b = before.get(m);
      if (!b || !m.boundingSphere) continue;
      expect(m.boundingSphere.radius, `${m.name || m.geometry.name} sphere after`).toBeLessThanOrEqual(b.radius + 10);
    }
    for (const m of held) expect(m.boundingSphere!.center.distanceTo(origin) - m.boundingSphere!.radius, `${m.geometry.name} sphere clear of the origin`).toBeGreaterThan(CONTACT_RANGE);
    // The hidden instance sits on the prop.
    const hidden = new THREE.Matrix4();
    const at = new THREE.Vector3();
    for (const m of held) {
      const k = (m.userData.propIndices as number[]).indexOf(pi);
      m.getMatrixAt(k, hidden);
      expect(at.setFromMatrixPosition(hidden).distanceTo(new THREE.Vector3(p.x, p.y, p.z)), m.geometry.name).toBeLessThan(1e-3);
    }
  });
});
