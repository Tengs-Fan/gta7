import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalReflections } from '../../src/render/localReflections';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const scene = new THREE.Scene();
  const source = new THREE.MeshPhysicalMaterial({ color: 0xa03020, clearcoat: 1, roughness: 0.3, metalness: 0.48 });
  const car = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(), source);
  body.name = 'body';
  car.add(body);
  const traffic = new THREE.Mesh(body.geometry, source);
  const hidden = new THREE.Group();
  hidden.visible = false;
  scene.add(car, traffic, hidden);
  let renderTarget: THREE.WebGLRenderTarget | null = null;
  let cubeFace = 0;
  let mip = 0;
  const renderer = {
    shadowMap: { autoUpdate: true }, xr: { enabled: true }, autoClear: true, toneMapping: THREE.ACESFilmicToneMapping,
    getRenderTarget: () => renderTarget,
    getActiveCubeFace: () => cubeFace,
    getActiveMipmapLevel: () => mip,
    setRenderTarget: (target: THREE.WebGLRenderTarget | null, face = 0, level = 0) => { renderTarget = target; cubeFace = face; mip = level; },
    render: vi.fn(() => { expect(car.visible).toBe(false); expect(hidden.visible).toBe(false); }),
  };
  const target = new THREE.WebGLRenderTarget(32, 32);
  const filter = vi.spyOn(THREE.PMREMGenerator.prototype, 'fromCubemap').mockReturnValue(target);
  const probe = new LocalReflections(renderer as unknown as THREE.WebGLRenderer, scene);
  const update = (time: number, position = new THREE.Vector3(), hour = 12) => probe.update(car, position, hour, time, [car, hidden]);
  const complete = (start = 0, position = new THREE.Vector3()) => { for (let i = 0; i < 6; i++) update(start + i / 60, position); };
  return { source, body, car, traffic, hidden, renderer, filter, target, probe, update, complete };
}

describe('local reflection lifecycle', () => {
  it('captures one face at a time, isolates player finishes, refreshes after travel, and restores shared materials', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.update(i / 60);
    expect(t.renderer.render).toHaveBeenCalledTimes(5);
    expect(t.filter).not.toHaveBeenCalled();
    expect(t.body.material).toBe(t.source);
    t.update(5 / 60);
    expect(t.probe.ready).toBe(true);
    expect(t.body.material).not.toBe(t.source);
    expect(t.body.material.envMap).toBe(t.target.texture);
    expect(t.traffic.material).toBe(t.source);
    expect(t.source.envMap).toBeNull();
    t.update(2);
    expect(t.renderer.render).toHaveBeenCalledTimes(6);
    t.complete(3, new THREE.Vector3(15, 0, 0));
    expect(t.filter).toHaveBeenCalledTimes(2);
    expect(t.filter.mock.calls[1]![1]).toBe(t.target);
    const release = vi.spyOn(t.body.material, 'dispose');
    t.probe.dispose();
    expect(t.body.material).toBe(t.source);
    expect(release).toHaveBeenCalledOnce();
    expect(t.car.visible).toBe(true);
    expect(t.hidden.visible).toBe(false);
    expect(t.renderer.getRenderTarget()).toBeNull();
    expect(t.renderer.xr.enabled).toBe(true);
    expect(t.renderer.shadowMap.autoUpdate).toBe(true);
  });

  it('honors repaint and burning material changes without altering other vehicles', () => {
    const t = setup();
    t.complete();
    const paint = new THREE.MeshPhysicalMaterial({ color: 0x2040ff, roughness: 0.3, metalness: 0.48 });
    t.body.material = paint;
    t.update(1);
    expect(t.body.material.color.getHex()).toBe(0x2040ff);
    expect(t.body.material.envMap).toBe(t.target.texture);
    const burnt = new THREE.MeshPhysicalMaterial({ roughness: 1, metalness: 0 });
    t.body.material = burnt;
    t.update(2);
    expect(t.body.material).toBe(burnt);
    t.probe.dispose();
    expect(t.body.material).toBe(burnt);
    expect(t.traffic.material).toBe(t.source);
  });

  it.each(['capture', 'filter'])('keeps the main scene usable if %s fails', (stage) => {
    const t = setup();
    if (stage === 'capture') t.renderer.render.mockImplementation(() => { throw new Error('context lost'); });
    else t.filter.mockImplementation(() => {
      t.renderer.setRenderTarget(t.target, 3, 1);
      t.renderer.xr.enabled = false;
      t.renderer.autoClear = false;
      throw new Error('filter unavailable');
    });
    t.complete();
    expect(t.probe.ready).toBe(false);
    expect(t.body.material).toBe(t.source);
    expect(t.car.visible).toBe(true);
    expect(t.hidden.visible).toBe(false);
    expect(t.renderer.getRenderTarget()).toBeNull();
    expect(t.renderer.getActiveCubeFace()).toBe(0);
    expect(t.renderer.getActiveMipmapLevel()).toBe(0);
    expect(t.renderer.xr.enabled).toBe(true);
    expect(t.renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(t.renderer.autoClear).toBe(true);
    expect(t.renderer.shadowMap.autoUpdate).toBe(true);
    t.probe.dispose();
  });
});
