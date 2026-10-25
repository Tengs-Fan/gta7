import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepLights, LocalReflections } from '../../src/render/localReflections';

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

  it('recaptures after more than 0.05 game hours, still at most one capture start per half second', () => {
    const t = setup();
    t.complete();
    const renders = () => t.renderer.render.mock.calls.length;
    const base = renders();
    t.probe.update(t.car, new THREE.Vector3(), 12.04, 2, [t.car, t.hidden]);
    expect(renders(), 'a change of 0.04 h does not recapture').toBe(base);
    t.probe.update(t.car, new THREE.Vector3(), 12.06, 2.1, [t.car, t.hidden]);
    expect(renders(), 'a change of 0.06 h starts a capture').toBe(base + 1);
    for (let i = 1; i < 6; i++) t.probe.update(t.car, new THREE.Vector3(), 12.06, 2.1 + i / 60, [t.car, t.hidden]);
    const done = renders();
    t.probe.update(t.car, new THREE.Vector3(), 12.2, 2.3, [t.car, t.hidden]);
    expect(renders(), 'within half a second of the last capture start').toBe(done);
    t.probe.update(t.car, new THREE.Vector3(), 12.2, 2.6, [t.car, t.hidden]);
    expect(renders()).toBe(done + 1);
    t.probe.dispose();
  });

  it.each([
    [12, 12.05], [12.05, 12], [6.3, 6.35], [18.55, 18.6], [23.95, 24], [23.95, 0], [0, 23.95], [0.02, 23.97],
  ])('treats an hour change of exactly 0.05 h (%f -> %f) as no lighting change', (from, to) => {
    const t = setup();
    for (let i = 0; i < 6; i++) t.update(i / 60, new THREE.Vector3(), from);
    const renders = () => t.renderer.render.mock.calls.length;
    const base = renders();
    t.probe.update(t.car, new THREE.Vector3(), to, 2, [t.car, t.hidden]);
    expect(renders(), `${from} -> ${to} does not recapture`).toBe(base);
    const clearlyAbove = (from + 0.06) % 24;
    t.probe.update(t.car, new THREE.Vector3(), clearlyAbove, 2.1, [t.car, t.hidden]);
    expect(renders(), `${from} -> ${clearlyAbove} starts a capture`).toBe(base + 1);
    t.probe.dispose();
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

describe('local reflections build no programs in play', () => {
  it('hides an excluded group with lights child by child, so a cube face sees the frame\'s light set', () => {
    const t = setup();
    const fx = new THREE.Group();
    const smoke = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const flash = new THREE.PointLight(0xffa040, 0, 40);
    const sparks = new THREE.Group();
    sparks.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    fx.add(smoke, flash, sparks);
    t.car.parent!.add(fx);
    expect(keepLights([fx, t.car])).toEqual([smoke, sparks, t.car]);
    const lightsAt: number[] = [];
    t.renderer.render.mockImplementation(() => {
      let n = 0;
      t.car.parent!.traverseVisible((o) => { if ((o as THREE.Light).isLight) n++; });
      lightsAt.push(n);
      expect(smoke.visible).toBe(false);
      expect(sparks.visible).toBe(false);
    });
    t.probe.update(t.car, new THREE.Vector3(), 12, 0, [fx, t.car]);
    expect(lightsAt).toEqual([1]);
    expect(smoke.visible && sparks.visible && fx.visible && flash.visible).toBe(true);
    t.probe.dispose();
  });

  it('a release keeps the filter but neither shows the old map nor reports ready until the next car is captured', () => {
    const t = setup();
    t.complete();
    expect(t.body.material).not.toBe(t.source);
    t.probe.release();
    expect(t.body.material).toBe(t.source);
    expect(t.probe.ready).toBe(false);
    for (let i = 0; i < 5; i++) t.update(10 + i / 60);
    expect(t.body.material, 'no stale map while the next cube is captured').toBe(t.source);
    t.update(10 + 5 / 60);
    expect(t.probe.ready).toBe(true);
    expect(t.body.material.envMap).toBe(t.target.texture);
    t.probe.dispose();
  });

  it('the warm-up puts the finishes on, and hands them back undisposed with the shared materials restored', () => {
    const t = setup();
    t.probe.warm([t.car]);
    expect(t.filter).toHaveBeenCalledOnce();
    const local = t.body.material;
    expect(local).not.toBe(t.source);
    expect(local.envMap).toBe(t.target.texture);
    const release = vi.spyOn(local, 'dispose');
    expect(t.probe.endWarm()).toEqual([local]);
    expect(t.body.material).toBe(t.source);
    expect(release).not.toHaveBeenCalled();
    expect(t.probe.ready).toBe(false);
    t.update(0);
    expect(t.body.material, 'the blank warm-up map is never shown').toBe(t.source);
    t.probe.dispose();
  });
});
