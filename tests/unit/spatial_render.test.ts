import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SoftwareMaterials } from '../../src/render/softwareMaterials';
import { Effects } from '../../src/render/effects';
import { softwarePixelRatioFor } from '../../src/render/quality';
import { CulledStaticMesh, spatialGeometry, spatialKey, StaticVisibility } from '../../src/render/spatial';

describe('spatial city batches', () => {
  it('preserves every indexed triangle and every attribute across negative and positive cells', () => {
    const source = new THREE.BufferGeometry();
    const positions: number[] = [];
    const seeds: number[] = [];
    const indices: number[] = [];
    for (const x of [-260, -10, 10, 270]) {
      const n = seeds.length;
      positions.push(x, 0, 0, x + 3, 0, 0, x, 4, 0, x + 3, 4, 0);
      seeds.push(n, n + 1, n + 2, n + 3);
      indices.push(n, n + 1, n + 2, n + 2, n + 1, n + 3);
    }
    source.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    source.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    source.setIndex(indices);
    const parts = spatialGeometry(source);
    expect(parts.length).toBe(4);
    const triangleSeeds = parts.flatMap((p) => Array.from(p.index!.array).map((v) => p.getAttribute('aSeed').getX(v)));
    expect(triangleSeeds).toEqual(indices);
    for (const part of parts) {
      const p = part.getAttribute('position');
      const s = part.getAttribute('aSeed');
      for (let i = 0; i < p.count; i++) {
        const original = s.getX(i);
        expect([p.getX(i), p.getY(i), p.getZ(i)]).toEqual(positions.slice(original * 3, original * 3 + 3));
        expect(part.boundingBox!.containsPoint(new THREE.Vector3().fromBufferAttribute(p, i))).toBe(true);
      }
    }
    expect(source.index!.count).toBe(24);
    expect(spatialKey(-1, -129)).toBe('-1,-2');
  });

  it('culls with real bounds so a long triangle remains visible across cell borders', () => {
    const visibility = new StaticVisibility();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(600, 10, 20), new THREE.MeshBasicMaterial());
    visibility.add(mesh);
    visibility.update(310, 0, 20);
    expect(mesh.visible).toBe(true);
    visibility.update(350, 0, 20);
    expect(mesh.visible).toBe(false);
    visibility.update(0, 0, Infinity);
    expect(mesh.visible).toBe(true);
  });

  it('compacts only visible cell indices into one draw and restores them when the camera returns', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-200, 0, 0, -190, 0, 0, -200, 10, 0, 200, 0, 0, 210, 0, 0, 200, 10, 0], 3));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute([1, 1, 1, 2, 2, 2], 1));
    geometry.setIndex([0, 1, 2, 3, 4, 5]);
    const mesh = new CulledStaticMesh(geometry, new THREE.MeshBasicMaterial());
    const camera = new THREE.OrthographicCamera(-500, 500, 500, -500, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    mesh.prepare(frustum, -195, 0, 40);
    expect(Array.from(geometry.index!.array).slice(0, geometry.drawRange.count)).toEqual([0, 1, 2]);
    mesh.prepare(frustum, 205, 0, 40);
    expect(Array.from(geometry.index!.array).slice(0, geometry.drawRange.count)).toEqual([3, 4, 5]);
    mesh.prepare(frustum, 0, 0, 40);
    expect(mesh.visible).toBe(false);
    expect(geometry.drawRange.count).toBe(0);
    mesh.prepare(frustum, -195, 0, 40);
    expect(mesh.visible).toBe(true);
    expect(geometry.drawRange.count).toBe(3);
    expect(Array.from(geometry.getAttribute('aSeed').array)).toEqual([1, 1, 1, 2, 2, 2]);
  });
});

describe('software GPU materials', () => {
  it('bounds software pixel cost on large and high-DPI displays while retaining quality choices', () => {
    expect(softwarePixelRatioFor('low', 960, 540, 2)).toBe(0.45);
    expect(softwarePixelRatioFor('medium', 960, 540, 2)).toBe(0.5);
    expect(softwarePixelRatioFor('high', 960, 540, 2)).toBe(0.67);
    const low = softwarePixelRatioFor('low', 3840, 2160, 2);
    expect(3840 * 2160 * low * low).toBeCloseTo(130_000);
    expect(softwarePixelRatioFor('high', 3840, 2160, 2)).toBeGreaterThan(low);
  });

  it('retains animated lamps, direct colour changes, shader hooks and damage material swaps', () => {
    const materials = new SoftwareMaterials();
    const lamp = new THREE.MeshStandardMaterial({ color: 0x112233, emissive: 0xff0000 });
    const hook: typeof lamp.onBeforeCompile = (shader) => { shader.fragmentShader += '\n// occupancy'; };
    lamp.onBeforeCompile = hook;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), lamp);
    materials.apply(mesh);
    const replacement = mesh.material as unknown as THREE.MeshLambertMaterial;
    expect(replacement).toBeInstanceOf(THREE.MeshLambertMaterial);
    const shader = { vertexShader: '', fragmentShader: '', uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    replacement.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('// occupancy');
    lamp.emissiveIntensity = 4;
    lamp.emissive.setHex(0x0000ff);
    replacement.color.setHex(0xffffff);
    materials.sync();
    expect(replacement.emissiveIntensity).toBe(4);
    expect(replacement.emissive.getHex()).toBe(0x0000ff);
    expect(lamp.color.getHex()).toBe(0xffffff);
    const burned = new THREE.MeshStandardMaterial({ color: 0x111111 });
    mesh.material = burned;
    materials.apply(mesh);
    expect(mesh.material).not.toBe(replacement);
    expect(mesh.material.color.getHex()).toBe(0x111111);
    materials.dispose();
  });
});

it('submits only written skid marks, then releases the draw range when they fade or reset', () => {
  const marks = new Effects().skids;
  expect(marks.mesh.visible).toBe(false);
  expect(marks.mesh.geometry.drawRange.count).toBe(0);
  marks.add('left', 0, 0, 0, 1);
  marks.add('left', 0.5, 0, 0, 1.1);
  expect(marks.mesh.visible).toBe(true);
  expect(marks.mesh.geometry.drawRange.count).toBe(6);
  marks.add('left', 1, 0, 0, 1.2);
  expect(marks.mesh.geometry.drawRange.count).toBe(12);
  marks.update(42);
  expect(marks.mesh.visible).toBe(false);
  expect(marks.mesh.geometry.drawRange.count).toBe(0);
  marks.add('right', 0, 0, 0, 43);
  marks.add('right', 0.5, 0, 0, 43.1);
  expect(marks.mesh.geometry.drawRange.count).toBe(6);
  marks.clear();
  expect(marks.mesh.geometry.drawRange.count).toBe(0);
});
