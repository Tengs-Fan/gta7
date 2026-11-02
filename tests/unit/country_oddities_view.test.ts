// How Las Lomas County's roadside oddities are drawn (render/country/poles.ts, oddities.ts, roadside.ts, fields.ts): the poles
// and wires a layer each, in the county's cells, the statics and the cow in two, their boards in the places' atlas, the
// saucer's beacon blinking after dark, the crop circle a decal and no wheat in it; the mailboxes and signs one instanced
// batch of every make, each instance the shape its prop says, falling when its prop is knocked down.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { CountryView } from '../../src/render/country';
import { cropPlants } from '../../src/render/country/fields';
import { poleGeometry } from '../../src/render/country/poles';
import { roadsideAtlas, roadsideGeometry } from '../../src/render/country/roadside';
import { PropsView } from '../../src/render/props';
import { HARDWARE_CHUNK_SIZE } from '../../src/render/spatial';
import { POLE, ROADSIDE } from '../../src/world/country/oddities';
import { triangles } from '../../src/render/furniture';
import { world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

const W = world();
const L = W.layout;
const odd = L.country.oddities;
const wind = { uWindTime: { value: 0 }, uWindAmp: { value: 0 }, uWindDir: { value: new THREE.Vector2(1, 0) } };
const view = new CountryView(W, new CityView(W), wind);
const meshes = (name: string) => view.group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name === name);

describe('the poles and the wires', () => {
  /** A layer of the county cut into cells: its parts, the triangles and vertices in all. */
  const layer = (name: string) => {
    const parts = meshes(name);
    return { parts, tris: parts.reduce((n, m) => n + triangles(m.geometry), 0), verts: parts.reduce((n, m) => n + m.geometry.getAttribute('position').count, 0) };
  };

  it('are a layer each, cut into the county\'s cells, every pole its model, a pole of a few hundred triangles', () => {
    const poles = layer('telephone-poles');
    const model = poleGeometry();
    expect(triangles(model)).toBeGreaterThan(150);
    expect(triangles(model)).toBeLessThan(900);
    expect(poles.tris).toBe(triangles(model) * odd.poles.length);
    // Cells of 256 m: the roads run through a dozen of them, each part's box within one cell's reach of the poles in it.
    expect(poles.parts.length).toBeGreaterThan(5);
    for (const m of poles.parts) {
      m.geometry.computeBoundingBox();
      expect(m.geometry.boundingBox!.max.x - m.geometry.boundingBox!.min.x).toBeLessThan(300);
      expect(m.castShadow).toBe(true);
    }
    // The model is the pole's size.
    model.computeBoundingBox();
    expect(model.boundingBox!.max.y).toBeGreaterThan(POLE.h);
    expect(model.boundingBox!.max.y).toBeLessThan(POLE.h + 0.4);
    expect(model.boundingBox!.max.x - model.boundingBox!.min.x).toBeCloseTo(POLE.arm, 1);
  });

  it('hang four wires over every span, none casting a shadow', () => {
    const wires = layer('telephone-wires');
    expect(wires.parts.length).toBeGreaterThan(5);
    for (const m of wires.parts) expect(m.castShadow).toBe(false);
    // 6 vertices to each of 4 faces to each piece of the chain: no piece is longer than 5 m.
    let pieces = 0;
    for (const s of odd.spans) {
      const len = Math.hypot(odd.poles[s.a]!.x - odd.poles[s.b]!.x, odd.poles[s.a]!.z - odd.poles[s.b]!.z);
      pieces += POLE.wires.length * Math.max(2, Math.ceil(len / 5));
    }
    expect(wires.verts).toBe(pieces * 24);
    const box = new THREE.Box3();
    for (const m of wires.parts) box.union(new THREE.Box3().setFromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute));
    expect(box.min.y).toBeGreaterThan(4.5);
    expect(box.max.y).toBeLessThan(POLE.wireY + 0.1);
  });
});

describe('the statics', () => {
  it('stand in two meshes, the cow wearing her own hide, the rest vertex-coloured, both casting shadows; the boards (the places\' one), the beacon and its halo three more', () => {
    for (const name of ['oddity-models', 'giant-cow']) {
      expect(meshes(name).length, name).toBe(1);
      expect(meshes(name)[0]!.castShadow, name).toBe(true);
    }
    expect(((meshes('giant-cow')[0]!.material as THREE.MeshStandardMaterial).map as THREE.Texture).image).toBeTruthy();
    for (const name of ['oddities', 'saucer-beacon', 'saucer-halo']) expect(meshes(name).length, name).toBe(1);
    // The beacon is on the saucer, a little over the sign's end.
    const diner = odd.statics.find((p) => p.kind === 'diner')!;
    const b = new THREE.Box3().setFromBufferAttribute(meshes('saucer-beacon')[0]!.geometry.getAttribute('position') as THREE.BufferAttribute);
    const c = b.getCenter(new THREE.Vector3());
    expect(Math.hypot(c.x - diner.x, c.z - diner.z)).toBeLessThan(9);
    expect(c.y).toBeGreaterThan(1);
    expect(c.y).toBeLessThan(4);
  });

  it('blink after dark, red and green by turns, dull glass by day', () => {
    const beacon = (meshes('saucer-beacon')[0]!.material as THREE.MeshBasicMaterial).color;
    const halo = meshes('saucer-halo')[0]!.material as THREE.MeshBasicMaterial;
    const animate = (night: number, time: number) => (view as unknown as { animated: Array<(n: number, t: number, s: null) => void> }).animated.forEach((f) => f(night, time, null));
    animate(0, 0);
    const day = beacon.clone();
    expect(halo.opacity).toBe(0);
    animate(1, 0);
    const a = beacon.clone();
    expect(halo.opacity).toBeGreaterThan(0.9);
    animate(1, 0.8);
    const b = beacon.clone();
    expect(a.r).toBeGreaterThan(a.g);
    expect(b.g).toBeGreaterThan(b.r);
    expect(Math.max(day.r, day.g, day.b)).toBeLessThan(0.3);
  });
});

describe('the crop circle', () => {
  const cc = odd.cropCircle;

  it('lies over the wheat as a decal, and no tuft of wheat stands in its flat parts', () => {
    expect(meshes('crop-circle').length).toBe(1);
    const box = new THREE.Box3().setFromBufferAttribute(meshes('crop-circle')[0]!.geometry.getAttribute('position') as THREE.BufferAttribute);
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(cc.cx, 6);
    expect(box.max.x - box.min.x).toBeGreaterThan(cc.radius * 2);
    const fields = L.country.farms.fields;
    const all = cropPlants(fields, 'wheat', cc.radius + 3, cc.cx, cc.cz);
    const some = cropPlants(fields, 'wheat', cc.radius + 3, cc.cx, cc.cz, cc);
    expect(all.length).toBeGreaterThan(5000);
    expect(some.length).toBeLessThan(all.length * 0.9);
    expect(some.length).toBeGreaterThan(all.length * 0.3);
    // Not one in the disc at its middle, and the plants outside it are every one the unmown field's.
    expect(some.filter((p) => Math.hypot(p.x - cc.cx, p.z - cc.cz) < 9.9).length).toBe(0);
    const kept = new Set(all.map((p) => `${p.x},${p.z}`));
    for (const p of some) expect(kept.has(`${p.x},${p.z}`)).toBe(true);
  });
});

describe('the roadside furniture', () => {
  const props = new PropsView(W, HARDWARE_CHUNK_SIZE);
  const batches: THREE.InstancedMesh[] = [];
  props.group.traverse((o) => {
    if (o instanceof THREE.InstancedMesh && o.geometry.name === 'roadside') batches.push(o);
  });
  const items = L.props.flatMap((p, i) => (p.kind === 'roadside' ? [i] : []));

  it('is one batch of every make, an instance for each of the nine mailboxes and signs', () => {
    expect(batches.length).toBe(1);
    expect(batches[0]!.count).toBe(9);
    expect(items.length).toBe(9);
    const pick = batches[0]!.geometry.getAttribute('aPick') as THREE.InstancedBufferAttribute;
    expect(Array.from(pick.array)).toEqual(items.map((i) => L.props[i]!.color));
    expect(batches[0]!.castShadow).toBe(false);
  });

  it('draws only each instance\'s own shape: a vertex of another is sent off the screen by the material\'s shader', () => {
    const mat = batches[0]!.material as THREE.MeshStandardMaterial;
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute float aShape;');
    expect(shader.vertexShader).toContain('if ( aShape != aPick ) gl_Position');
    // Every shape is in the geometry, on vertices tagged with its index.
    const shape = batches[0]!.geometry.getAttribute('aShape');
    const count = ROADSIDE.map((_, k) => Array.from({ length: shape.count }, (_v, i) => shape.getX(i)).filter((s) => s === k).length);
    for (const [k, n] of count.entries()) expect(n, ROADSIDE[k]!.name).toBeGreaterThan(24);
  });

  it('draws each make as tall as its post and collider: a mailbox about 1.3 to 1.6 m, a sign 1.9 or 2 m', () => {
    const { blank, bands } = roadsideAtlas();
    const geo = roadsideGeometry(blank, bands);
    const pos = geo.getAttribute('position');
    const shape = geo.getAttribute('aShape');
    for (const [k, r] of ROADSIDE.entries()) {
      let top = -Infinity;
      let bottom = Infinity;
      let reach = 0;
      for (let i = 0; i < pos.count; i++) {
        if (shape.getX(i) !== k) continue;
        top = Math.max(top, pos.getY(i));
        bottom = Math.min(bottom, pos.getY(i));
        reach = Math.max(reach, Math.abs(pos.getX(i)), Math.abs(pos.getZ(i)));
      }
      expect(top, r.name).toBeGreaterThan(r.h - 0.3);
      expect(top, r.name).toBeLessThan(r.h + 0.3);
      expect(bottom, r.name).toBeGreaterThan(-0.05);
      expect(bottom, r.name).toBeLessThan(0.05);
      expect(reach, r.name).toBeLessThan(1.0);
    }
  });

  it('falls with its prop when a car knocks it down, and stands again in a new game', () => {
    const batch = batches[0]!;
    const m0 = new THREE.Matrix4();
    batch.getMatrixAt(2, m0);
    props.breakProp(items[2]!, 1, 0);
    const m1 = new THREE.Matrix4();
    batch.getMatrixAt(2, m1);
    expect(m1.equals(m0)).toBe(false);
    // Over on its side: the post's up axis lies along the ground.
    const up = new THREE.Vector3(0, 1, 0).transformDirection(m1);
    expect(Math.abs(up.y)).toBeLessThan(0.2);
    props.restoreAll();
    const m2 = new THREE.Matrix4();
    batch.getMatrixAt(2, m2);
    expect(m2.equals(m0)).toBe(true);
  });
});
